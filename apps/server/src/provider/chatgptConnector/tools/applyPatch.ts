// FILE: applyPatch.ts
// Purpose: V4A-style `apply_patch` tool for the ChatGPT connector. Parses the
//          Codex patch envelope and applies add/update/move/delete operations
//          to a Synara thread workspace with a full preflight before any write.
// Layer: Server provider connector / tools
//
// Adapted from Chat On Steroids (MIT) and OpenAI Codex (Apache-2.0) apply_patch.
//
// Semantics:
// - The envelope starts with `*** Begin Patch` and ends with `*** End Patch`.
// - Hunk matching is exact (line equality, trailing whitespace significant) and
//   each hunk searches forward from the end of the previous one. Files are
//   normalized to LF for matching; an existing CRLF file is written back with
//   CRLF endings and newly inserted lines use its ending style.
// - Every operation is preflighted against an in-memory tree, so a parse, path,
//   existence, binary or hunk-match failure leaves the workspace untouched.
// - Files whose first 8 KiB contain NUL bytes are refused as binary.
// - Paths resolve against the realpath of `ctx.workspaceRoot`; absolute paths
//   and paths escaping the root are rejected. Symlinks are not resolved
//   per-target: only the root is realpath'd and writes go through symlinks the
//   way an ordinary editor would.
// - Added and updated files end with a newline (Codex V4A behavior); an added
//   file with no `+` lines is created empty.

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { WorkspaceToolContext } from "../types.ts";

/** Input accepted by the connector's `apply_patch` tool. */
export interface ApplyPatchInput {
  readonly patch: string;
}

/** Result of an `apply_patch` call; failures never throw across the tool boundary. */
export type ApplyPatchOutcome =
  | { readonly ok: true; readonly summary: readonly string[] }
  | { readonly ok: false; readonly error: string };

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_PREFIX = "*** Add File: ";
const DELETE_FILE_PREFIX = "*** Delete File: ";
const UPDATE_FILE_PREFIX = "*** Update File: ";
const MOVE_TO_PREFIX = "*** Move to: ";
const ENVIRONMENT_ID_PREFIX = "*** Environment ID:";
const END_OF_FILE_MARKER = "*** End of File";

/** The whole patch text is bounded so one call cannot pin the process. */
const MAX_PATCH_BYTES = 1024 * 1024;
/** A patch may contain at most this many operations (add/update/delete). */
const MAX_PATCH_OPERATIONS = 50;
/** NUL bytes in this prefix mark a file as binary and unpatchable. */
const BINARY_SNIFF_BYTES = 8 * 1024;

type LineEnding = "\n" | "\r\n";

/** In-memory view of one workspace file between operations of a patch. */
interface FileState {
  readonly lines: readonly string[];
  readonly eol: LineEnding;
  readonly trailingNewline: boolean;
}

type HunkLineKind = "context" | "remove" | "add";

interface HunkLine {
  readonly kind: HunkLineKind;
  readonly text: string;
}

interface UpdateHunk {
  readonly lines: readonly HunkLine[];
  readonly endOfFile: boolean;
}

interface AddFileOperation {
  readonly kind: "add";
  readonly path: string;
  readonly lines: readonly string[];
}

interface DeleteFileOperation {
  readonly kind: "delete";
  readonly path: string;
}

interface UpdateFileOperation {
  readonly kind: "update";
  readonly path: string;
  readonly movePath: string | null;
  readonly hunks: readonly UpdateHunk[];
}

type PatchOperation = AddFileOperation | DeleteFileOperation | UpdateFileOperation;

interface ResolvedPath {
  readonly absolute: string;
  readonly relative: string;
}

type PlannedWrite =
  | { readonly kind: "add"; readonly target: ResolvedPath; readonly content: string }
  | { readonly kind: "update"; readonly target: ResolvedPath; readonly content: string }
  | {
      readonly kind: "move";
      readonly target: ResolvedPath;
      readonly destination: ResolvedPath;
      readonly content: string;
    }
  | { readonly kind: "delete"; readonly target: ResolvedPath };

type SourceLookup = FileState | "removed-earlier" | "missing";

/** Internal control-flow failure; mapped to `{ ok: false, error }` at the tool boundary. */
class PatchFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchFailure";
  }
}

/**
 * Runs the V4A patch tool against `ctx.workspaceRoot`.
 *
 * The patch is parsed and fully preflighted in memory first; only when every
 * operation is valid and every hunk matches is anything written to disk.
 */
export async function runApplyPatchTool(
  ctx: WorkspaceToolContext,
  input: ApplyPatchInput,
): Promise<ApplyPatchOutcome> {
  try {
    if (ctx.signal?.aborted === true)
      throw new PatchFailure("Apply patch aborted before it started");
    const patchBytes = Buffer.byteLength(input.patch, "utf8");
    if (patchBytes > MAX_PATCH_BYTES) {
      throw new PatchFailure(
        `Patch is too large: ${patchBytes} bytes exceeds the 1 MiB (${MAX_PATCH_BYTES} byte) limit`,
      );
    }

    const operations = parsePatch(input.patch);
    if (operations.length > MAX_PATCH_OPERATIONS) {
      throw new PatchFailure(
        `Patch touches too many files: ${operations.length} operations exceeds the limit of ${MAX_PATCH_OPERATIONS}`,
      );
    }

    const workspaceRoot = await resolveWorkspaceRoot(ctx.workspaceRoot);
    const { writes, summary } = await preflightPatch(workspaceRoot, operations);
    await commitWrites(writes, ctx.signal);
    return { ok: true, summary };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function resolveWorkspaceRoot(workspaceRoot: string): Promise<string> {
  try {
    return await fs.realpath(workspaceRoot);
  } catch (error) {
    throw new PatchFailure(`Failed to resolve the workspace root: ${errorMessage(error)}`);
  }
}

/** Splits patch text into lines, tolerating a CRLF patch and a missing final newline. */
function toPatchLines(patchText: string): string[] {
  const lines = patchText.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function lineNumber(firstLineNumber: number, bodyIndex: number): number {
  return firstLineNumber + bodyIndex;
}

function firstNonBlankIndex(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() !== "") return index;
  }
  return -1;
}

function lastNonBlankIndex(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").trim() !== "") return index;
  }
  return -1;
}

function nextNonBlankIndex(lines: readonly string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() !== "") return index;
  }
  return -1;
}

/** Parses the envelope and every operation; throws `PatchFailure` with the offending line. */
function parsePatch(patchText: string): readonly PatchOperation[] {
  const lines = toPatchLines(patchText);

  const first = firstNonBlankIndex(lines);
  if (first === -1) throw new PatchFailure(`Invalid patch: missing "${BEGIN_PATCH_MARKER}"`);
  const firstLine = (lines[first] ?? "").trim();
  if (firstLine !== BEGIN_PATCH_MARKER) {
    const found = lines[first] ?? "";
    throw new PatchFailure(
      `Invalid patch: first non-blank line must be "${BEGIN_PATCH_MARKER}" (line ${first + 1}: "${found}")`,
    );
  }

  const last = lastNonBlankIndex(lines);
  if (last <= first) {
    throw new PatchFailure(
      `Invalid patch: missing "${END_PATCH_MARKER}" (patch ends on line ${first + 1})`,
    );
  }
  const lastLine = (lines[last] ?? "").trim();
  if (lastLine !== END_PATCH_MARKER) {
    const found = lines[last] ?? "";
    throw new PatchFailure(
      `Invalid patch: last non-blank line must be "${END_PATCH_MARKER}" (line ${last + 1}: "${found}")`,
    );
  }

  return parseOperations(lines.slice(first + 1, last), first + 2);
}

/** `firstLineNumber` is the 1-based patch line of `body[0]`. */
function parseOperations(
  body: readonly string[],
  firstLineNumber: number,
): readonly PatchOperation[] {
  const operations: PatchOperation[] = [];
  let index = 0;

  while (index < body.length) {
    const raw = body[index] ?? "";
    const number = lineNumber(firstLineNumber, index);
    const trimmed = raw.trim();

    if (trimmed === "") {
      index += 1;
      continue;
    }

    if (trimmed.startsWith(ADD_FILE_PREFIX)) {
      const parsed = parseAddOperation(body, index, firstLineNumber);
      operations.push(parsed.operation);
      index = parsed.nextIndex;
      continue;
    }

    if (trimmed.startsWith(DELETE_FILE_PREFIX)) {
      const path = requirePath(trimmed.slice(DELETE_FILE_PREFIX.length), number, "Delete File");
      operations.push({ kind: "delete", path });
      index += 1;
      continue;
    }

    if (trimmed.startsWith(UPDATE_FILE_PREFIX)) {
      const parsed = parseUpdateOperation(body, index, firstLineNumber);
      operations.push(parsed.operation);
      index = parsed.nextIndex;
      continue;
    }

    if (trimmed.startsWith(ENVIRONMENT_ID_PREFIX)) {
      throw new PatchFailure(
        `Unsupported directive on line ${number}: environment ids are not accepted (found "${trimmed}")`,
      );
    }
    if (trimmed === BEGIN_PATCH_MARKER || trimmed === END_PATCH_MARKER) {
      throw new PatchFailure(
        `Unexpected "${trimmed}" on line ${number}: a patch has exactly one "${BEGIN_PATCH_MARKER}" at the start and one "${END_PATCH_MARKER}" at the end`,
      );
    }
    if (trimmed.startsWith(MOVE_TO_PREFIX)) {
      throw new PatchFailure(
        `Invalid directive on line ${number}: "${MOVE_TO_PREFIX.trim()}" is only allowed directly after an "${UPDATE_FILE_PREFIX.trim()}" line`,
      );
    }
    if (trimmed === END_OF_FILE_MARKER) {
      throw new PatchFailure(
        `Invalid directive on line ${number}: "${END_OF_FILE_MARKER}" is only allowed at the end of an update hunk`,
      );
    }
    if (trimmed.startsWith("***")) {
      throw new PatchFailure(`Unknown patch directive on line ${number}: "${trimmed}"`);
    }
    throw new PatchFailure(
      `Invalid patch line ${number}: expected an operation directive such as "${UPDATE_FILE_PREFIX.trim()}" (found "${raw}")`,
    );
  }

  if (operations.length === 0) {
    throw new PatchFailure(
      "Invalid patch: no file operations found between the begin and end markers",
    );
  }

  return operations;
}

function requirePath(value: string, number: number, directive: string): string {
  const path = value.trim();
  if (path === "") {
    throw new PatchFailure(`Invalid patch: ${directive} on line ${number} is missing a file path`);
  }
  return path;
}

function parseAddOperation(
  body: readonly string[],
  startIndex: number,
  firstLineNumber: number,
): { readonly operation: AddFileOperation; readonly nextIndex: number } {
  const directive = (body[startIndex] ?? "").trim();
  const path = requirePath(
    directive.slice(ADD_FILE_PREFIX.length),
    lineNumber(firstLineNumber, startIndex),
    "Add File",
  );

  const lines: string[] = [];
  let index = startIndex + 1;
  while (index < body.length) {
    const raw = body[index] ?? "";
    if (raw.startsWith("***")) break;
    if (!raw.startsWith("+")) {
      const number = lineNumber(firstLineNumber, index);
      throw new PatchFailure(
        `Invalid Add File content on line ${number}: every line must start with "+" (found "${raw}")`,
      );
    }
    lines.push(raw.slice(1));
    index += 1;
  }

  return { operation: { kind: "add", path, lines }, nextIndex: index };
}

function parseUpdateOperation(
  body: readonly string[],
  startIndex: number,
  firstLineNumber: number,
): { readonly operation: UpdateFileOperation; readonly nextIndex: number } {
  const directive = (body[startIndex] ?? "").trim();
  const path = requirePath(
    directive.slice(UPDATE_FILE_PREFIX.length),
    lineNumber(firstLineNumber, startIndex),
    "Update File",
  );

  let index = startIndex + 1;
  let movePath: string | null = null;
  const moveIndex = nextNonBlankIndex(body, index);
  if (moveIndex !== -1 && (body[moveIndex] ?? "").trim().startsWith(MOVE_TO_PREFIX)) {
    const moveLine = (body[moveIndex] ?? "").trim();
    movePath = requirePath(
      moveLine.slice(MOVE_TO_PREFIX.length),
      lineNumber(firstLineNumber, moveIndex),
      "Move to",
    );
    index = moveIndex + 1;
  }

  const hunks: UpdateHunk[] = [];
  let currentLines: HunkLine[] | null = null;
  let currentHeaderNumber = 0;
  let currentEndOfFile = false;

  while (index < body.length) {
    const raw = body[index] ?? "";
    const number = lineNumber(firstLineNumber, index);
    const trimmed = raw.trim();

    if (trimmed === "" && currentLines === null) {
      index += 1;
      continue;
    }

    if (trimmed === END_OF_FILE_MARKER) {
      if (currentLines === null || currentLines.length === 0) {
        throw new PatchFailure(
          `Invalid hunk on line ${number}: "${END_OF_FILE_MARKER}" must follow the hunk's lines`,
        );
      }
      if (currentEndOfFile) {
        throw new PatchFailure(`Invalid hunk on line ${number}: duplicate "${END_OF_FILE_MARKER}"`);
      }
      currentEndOfFile = true;
      index += 1;
      continue;
    }

    if (raw.startsWith("***")) break;

    if (trimmed.startsWith("@@")) {
      if (trimmed !== "@@" && !trimmed.startsWith("@@ ")) {
        throw new PatchFailure(
          `Invalid hunk header on line ${number}: expected "@@" or "@@ <context>" (found "${raw}")`,
        );
      }
      if (currentLines !== null) {
        if (currentLines.length === 0) {
          throw new PatchFailure(
            `Invalid hunk on line ${currentHeaderNumber}: a hunk must contain at least one line`,
          );
        }
        hunks.push({ lines: currentLines, endOfFile: currentEndOfFile });
      }
      currentLines = [];
      currentHeaderNumber = number;
      currentEndOfFile = false;
      index += 1;
      continue;
    }

    if (currentLines === null) {
      throw new PatchFailure(
        `Invalid Update File on line ${number}: expected a hunk header starting with "@@" (found "${raw}")`,
      );
    }
    if (currentEndOfFile) {
      throw new PatchFailure(
        `Invalid hunk on line ${number}: "${END_OF_FILE_MARKER}" must be the last line of its hunk`,
      );
    }

    const prefix = raw.slice(0, 1);
    if (prefix === " " || prefix === "-" || prefix === "+") {
      const kind: HunkLineKind = prefix === " " ? "context" : prefix === "-" ? "remove" : "add";
      currentLines.push({ kind, text: raw.slice(1) });
      index += 1;
      continue;
    }

    throw new PatchFailure(
      `Invalid hunk line ${number}: lines must start with " ", "-" or "+" (found "${raw}")`,
    );
  }

  if (currentLines !== null) {
    if (currentLines.length === 0) {
      throw new PatchFailure(
        `Invalid hunk on line ${currentHeaderNumber}: a hunk must contain at least one line`,
      );
    }
    hunks.push({ lines: currentLines, endOfFile: currentEndOfFile });
  }

  if (hunks.length === 0 && movePath === null) {
    throw new PatchFailure(
      `Invalid Update File on line ${lineNumber(firstLineNumber, startIndex)}: an update needs at least one hunk or a "${MOVE_TO_PREFIX.trim()}" destination`,
    );
  }

  return { operation: { kind: "update", path, movePath, hunks }, nextIndex: index };
}

/**
 * Resolves every operation against the workspace root, applies hunks to in-memory file states and
 * validates existence/binary constraints. Nothing is written here.
 */
async function preflightPatch(
  workspaceRoot: string,
  operations: readonly PatchOperation[],
): Promise<{ readonly writes: readonly PlannedWrite[]; readonly summary: readonly string[] }> {
  const state = new Map<string, FileState | null>();
  const writes: PlannedWrite[] = [];
  const summary: string[] = [];

  for (const operation of operations) {
    if (operation.kind === "add") {
      const target = resolveTarget(workspaceRoot, operation.path);
      const known = state.get(target.absolute);
      const exists = known === undefined ? await pathExists(target.absolute) : known !== null;
      if (exists) {
        throw new PatchFailure(`Cannot add ${target.relative}: the file already exists`);
      }
      const fileState: FileState = {
        lines: operation.lines,
        eol: "\n",
        trailingNewline: operation.lines.length > 0,
      };
      state.set(target.absolute, fileState);
      writes.push({ kind: "add", target, content: serializeFileState(fileState) });
      summary.push(`A ${target.relative}`);
      continue;
    }

    if (operation.kind === "delete") {
      const target = resolveTarget(workspaceRoot, operation.path);
      const lookup = await loadSourceFile(state, target);
      if (lookup === "missing" || lookup === "removed-earlier") {
        throw new PatchFailure(missingSourceMessage("delete", target.relative, lookup));
      }
      state.set(target.absolute, null);
      writes.push({ kind: "delete", target });
      summary.push(`D ${target.relative}`);
      continue;
    }

    const target = resolveTarget(workspaceRoot, operation.path);
    const lookup = await loadSourceFile(state, target);
    if (lookup === "missing" || lookup === "removed-earlier") {
      throw new PatchFailure(missingSourceMessage("update", target.relative, lookup));
    }

    const lines = applyHunks(lookup.lines, operation.hunks, target.relative);
    const updated: FileState = { lines, eol: lookup.eol, trailingNewline: true };

    if (operation.movePath === null) {
      state.set(target.absolute, updated);
      writes.push({ kind: "update", target, content: serializeFileState(updated) });
      summary.push(`M ${target.relative}`);
      continue;
    }

    const destination = resolveTarget(workspaceRoot, operation.movePath);
    if (sameTargetPath(target.absolute, destination.absolute)) {
      throw new PatchFailure(
        `Cannot move ${target.relative}: the source and destination are the same file`,
      );
    }
    if (!state.has(destination.absolute)) {
      await assertMoveDestinationUsable(destination);
    }
    state.set(target.absolute, null);
    state.set(destination.absolute, updated);
    writes.push({ kind: "move", target, destination, content: serializeFileState(updated) });
    summary.push(`M ${target.relative} -> ${destination.relative}`);
  }

  return { writes, summary };
}

/** Applies every hunk in order; the cursor only moves forward so overlapping matches are rejected. */
function applyHunks(
  lines: readonly string[],
  hunks: readonly UpdateHunk[],
  relativePath: string,
): string[] {
  const result = [...lines];
  let cursor = 0;

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const hunk = hunks[hunkIndex];
    if (hunk === undefined) continue;

    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.kind !== "add") oldLines.push(line.text);
      if (line.kind !== "remove") newLines.push(line.text);
    }

    const found = findSequence(result, oldLines, cursor, hunk.endOfFile);
    if (found === -1) {
      throw new PatchFailure(`Failed to find hunk ${hunkIndex + 1} in ${relativePath}`);
    }
    result.splice(found, oldLines.length, ...newLines);
    cursor = found + newLines.length;
  }

  return result;
}

/**
 * Exact line-sequence search. `endOfFile` anchors the pattern to the final lines; an empty pattern
 * appends at the end of the file (the Codex behavior for hunks without context).
 */
function findSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): number {
  if (pattern.length === 0) return lines.length;
  if (pattern.length > lines.length) return -1;

  if (endOfFile) {
    const anchored = lines.length - pattern.length;
    if (anchored < start) return -1;
    return sequenceMatches(lines, pattern, anchored) ? anchored : -1;
  }

  const lastStart = lines.length - pattern.length;
  for (let index = Math.max(0, start); index <= lastStart; index += 1) {
    if (sequenceMatches(lines, pattern, index)) return index;
  }
  return -1;
}

function sequenceMatches(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
): boolean {
  for (let offset = 0; offset < pattern.length; offset += 1) {
    if (lines[start + offset] !== pattern[offset]) return false;
  }
  return true;
}

async function loadSourceFile(
  state: ReadonlyMap<string, FileState | null>,
  target: ResolvedPath,
): Promise<SourceLookup> {
  const known = state.get(target.absolute);
  if (known === undefined) return await readFileState(target);
  return known === null ? "removed-earlier" : known;
}

async function readFileState(target: ResolvedPath): Promise<FileState | "missing"> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(target.absolute);
  } catch (error) {
    if (isNotFoundError(error)) return "missing";
    throw new PatchFailure(`Failed to read ${target.relative}: ${errorMessage(error)}`);
  }

  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new PatchFailure(
      `Refusing to patch binary file ${target.relative}: NUL bytes in the first ${BINARY_SNIFF_BYTES} bytes`,
    );
  }

  return decodeFileState(buffer.toString("utf8"));
}

function decodeFileState(contents: string): FileState {
  if (contents === "") return { lines: [], eol: "\n", trailingNewline: false };
  const eol: LineEnding = contents.includes("\r\n") ? "\r\n" : "\n";
  const normalized = eol === "\r\n" ? contents.split("\r\n").join("\n") : contents;
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, eol, trailingNewline };
}

function serializeFileState(state: FileState): string {
  const body = state.lines.join(state.eol);
  return state.trailingNewline ? `${body}${state.eol}` : body;
}

function missingSourceMessage(
  action: string,
  relative: string,
  lookup: "missing" | "removed-earlier",
): string {
  if (lookup === "missing") return `Cannot ${action} ${relative}: the file does not exist`;
  return `Cannot ${action} ${relative}: an earlier operation in this patch removed it`;
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.lstat(absolutePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw new PatchFailure(
      `Failed to inspect patch target ${absolutePath}: ${errorMessage(error)}`,
    );
  }
}

async function assertMoveDestinationUsable(destination: ResolvedPath): Promise<void> {
  try {
    const metadata = await fs.lstat(destination.absolute);
    if (metadata.isDirectory()) {
      throw new PatchFailure(
        `Cannot move to ${destination.relative}: the destination is a directory`,
      );
    }
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

/**
 * Resolves a patch path against the workspace root.
 *
 * Absolute paths, empty paths and any resolution that leaves the root (including a path that
 * resolves to the root itself) are rejected before any filesystem access.
 */
function resolveTarget(workspaceRoot: string, spelledPath: string): ResolvedPath {
  const raw = spelledPath.trim();
  if (raw === "") throw new PatchFailure("Invalid patch: a file path is empty");
  if (raw.includes("\u0000")) {
    throw new PatchFailure(`Invalid patch path: ${JSON.stringify(raw)} contains a NUL byte`);
  }
  if (nodePath.isAbsolute(raw) || /^[A-Za-z]:[\\/]/u.test(raw)) {
    throw new PatchFailure(`Absolute paths are not allowed in patches: "${raw}"`);
  }

  const absolute = nodePath.resolve(workspaceRoot, raw);
  const relative = nodePath.relative(workspaceRoot, absolute);
  if (relative === "") {
    throw new PatchFailure(`Invalid patch path: "${raw}" resolves to the workspace root`);
  }
  if (
    relative === ".." ||
    relative.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(relative)
  ) {
    throw new PatchFailure(`Patch path escapes the workspace root: "${raw}"`);
  }
  return { absolute, relative: relative.split(nodePath.sep).join("/") };
}

/**
 * macOS and Windows filesystems are normally case-insensitive, so a case-only rename would write
 * the destination and then unlink the one file it shares an inode with.
 */
function sameTargetPath(left: string, right: string): boolean {
  if (process.platform === "win32" || process.platform === "darwin") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

async function commitWrites(
  writes: readonly PlannedWrite[],
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const write of writes) {
    if (signal?.aborted === true) throw new PatchFailure("Apply patch aborted before writing");
    try {
      if (write.kind === "add") {
        await fs.mkdir(nodePath.dirname(write.target.absolute), { recursive: true });
        await fs.writeFile(write.target.absolute, write.content, { flag: "wx" });
        continue;
      }
      if (write.kind === "update") {
        await fs.writeFile(write.target.absolute, write.content);
        continue;
      }
      if (write.kind === "move") {
        await fs.mkdir(nodePath.dirname(write.destination.absolute), { recursive: true });
        await fs.writeFile(write.destination.absolute, write.content);
        await fs.unlink(write.target.absolute);
        continue;
      }
      await fs.unlink(write.target.absolute);
    } catch (error) {
      throw new PatchFailure(
        `Failed to ${write.kind} ${write.target.relative}: ${errorMessage(error)}`,
      );
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
