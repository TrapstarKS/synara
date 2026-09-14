// FILE: read.ts
// Purpose: Bounded workspace reads (files, line ranges, one-level directory listings and small
//   globs) for the ChatGPT connector's `read` tool.
// Layer: Server provider connector (ChatGPT connector tools)
//
// Adapted from Chat On Steroids (MIT) — src/main/mcp/tools-core.ts (`read`),
// src/main/codex/read-backend.ts and src/main/fsops.ts (bounds discipline). Every section is
// bounded: a per-file payload budget (256 KiB by default, 512 KiB maximum), an aggregate
// per-call budget (512 KiB), binary sniffing, and capped directory/glob expansion. Failures are
// reported as text sections rather than thrown errors so one stale path cannot discard the other
// reads in the same call.

import type { Dirent, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  isContainedPath,
  resolveRealPathWithinRoot,
} from "../../../workspace/realPathContainment.ts";
import type { McpToolCallResult, WorkspaceToolContext } from "../types.ts";

/** Paths one call may name before the list is cut off with a note. */
const MAX_READ_PATHS = 20;
/** Default per-file payload budget. */
const DEFAULT_READ_BYTES = 256 * 1024;
/** Hard per-file payload cap. */
const MAX_READ_BYTES = 512 * 1024;
/** Aggregate payload budget for one call. */
const AGGREGATE_READ_BYTES = 512 * 1024;
/** Bytes inspected to classify a file as binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
/** Bytes a ranged read may scan before it gives up looking for the requested lines. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** Entries a one-level directory listing shows before it reports what is left. */
const MAX_DIR_ENTRIES = 500;
/** Files one glob pattern may expand to. */
const MAX_GLOB_MATCHES = 20;
/** Entries a `**` walk may inspect before it stops and says so. */
const MAX_GLOB_SCAN_ENTRIES = 5_000;
const MAX_GLOB_DEPTH = 12;

export interface ReadToolInput {
  readonly paths: readonly string[];
  readonly start_line?: number;
  readonly end_line?: number;
  readonly max_bytes?: number;
}

export interface ResolvedWorkspacePath {
  /** Absolute path on disk (lexically inside the workspace root). */
  readonly absolutePath: string;
  /** Path relative to the workspace root, using `/` separators. */
  readonly relativePath: string;
}

/** A path that cannot be resolved inside the workspace root. */
export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

function toPosixRelativePath(relativePath: string): string {
  return path.sep === "/" ? relativePath : relativePath.split(path.sep).join("/");
}

/**
 * Resolves one input path against the workspace root, rejecting escapes.
 *
 * Containment is lexical here so the helper stays synchronous and cheap; the async read paths
 * additionally canonicalize through `resolveRealPathWithinRoot` so a symlink inside the root
 * cannot point the read outside it. An absolute path is accepted only when it already resolves
 * inside the root.
 */
export function resolveWithinRoot(root: string, inputPath: string): ResolvedWorkspacePath {
  if (inputPath.length === 0) {
    throw new WorkspacePathError("path is empty");
  }
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, inputPath);
  if (!isContainedPath(absoluteRoot, absolutePath)) {
    throw new WorkspacePathError(`${inputPath} resolves outside the workspace root`);
  }
  const relative = toPosixRelativePath(path.relative(absoluteRoot, absolutePath));
  return { absolutePath, relativePath: relative === "" ? "." : relative };
}

interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

type LineRangeResult =
  | { readonly kind: "range"; readonly range: LineRange }
  | { readonly kind: "error"; readonly message: string };

function describeValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Validates `start_line`/`end_line`. Garbage is never silently ignored: the caller gets a clear
 * error section instead of a whole-file read that pretends the range was honored.
 */
function parseLineRange(input: ReadToolInput): LineRangeResult {
  const rawStart: unknown = input.start_line;
  const rawEnd: unknown = input.end_line;
  let startLine = 1;
  if (rawStart !== undefined && rawStart !== null) {
    if (typeof rawStart !== "number" || !Number.isInteger(rawStart) || rawStart < 1) {
      return {
        kind: "error",
        message: `start_line must be a positive integer (received ${describeValue(rawStart)})`,
      };
    }
    startLine = rawStart;
  }
  let endLine = Number.POSITIVE_INFINITY;
  if (rawEnd !== undefined && rawEnd !== null) {
    if (typeof rawEnd !== "number" || !Number.isInteger(rawEnd) || rawEnd < 1) {
      return {
        kind: "error",
        message: `end_line must be a positive integer (received ${describeValue(rawEnd)})`,
      };
    }
    if (rawEnd < startLine) {
      return {
        kind: "error",
        message: `end_line must be greater than or equal to start_line (${startLine})`,
      };
    }
    endLine = rawEnd;
  }
  return { kind: "range", range: { startLine, endLine } };
}

function normalizeMaxBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_READ_BYTES;
  }
  return Math.min(Math.floor(value), MAX_READ_BYTES);
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ResolvedForRead =
  | { readonly kind: "ok"; readonly path: ResolvedWorkspacePath }
  | { readonly kind: "error"; readonly message: string };

async function resolveForRead(root: string, inputPath: string): Promise<ResolvedForRead> {
  let lexical: ResolvedWorkspacePath;
  try {
    lexical = resolveWithinRoot(root, inputPath);
  } catch (error) {
    return { kind: "error", message: errorText(error) };
  }
  try {
    const real = await resolveRealPathWithinRoot(root, lexical.absolutePath);
    if (real === null) {
      return { kind: "error", message: `${inputPath} resolves outside the workspace root` };
    }
    return { kind: "ok", path: { absolutePath: real, relativePath: lexical.relativePath } };
  } catch (error) {
    if (isNotFoundError(error)) {
      return { kind: "error", message: "not found" };
    }
    return { kind: "error", message: errorText(error) };
  }
}

type GlobClassification =
  | { readonly kind: "none" }
  | { readonly kind: "segment"; readonly basePath: string; readonly pattern: string }
  | { readonly kind: "recursive"; readonly basePath: string }
  | { readonly kind: "invalid"; readonly message: string };

function classifyGlobPath(inputPath: string): GlobClassification {
  const normalized =
    process.platform === "win32" ? inputPath.replace(/\\/g, "/").replace(/\/+$/, "") : inputPath;
  if (!normalized.includes("*")) return { kind: "none" };
  if (normalized === "**" || normalized.endsWith("/**")) {
    const basePath = normalized.slice(0, normalized.length - 2).replace(/\/+$/, "");
    return { kind: "recursive", basePath: basePath === "" ? "." : basePath };
  }
  const segments = normalized.split("/");
  const wildcardIndex = segments.findIndex((segment) => segment.includes("*"));
  if (wildcardIndex === -1) return { kind: "none" };
  if (wildcardIndex !== segments.length - 1) {
    return {
      kind: "invalid",
      message: "wildcards are only supported in the final path segment or as a trailing /**",
    };
  }
  return {
    kind: "segment",
    basePath: segments.slice(0, -1).join("/") || ".",
    pattern: segments[wildcardIndex] ?? "",
  };
}

function wildcardRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

interface GlobExpansion {
  readonly matches: readonly string[];
  readonly note: string | null;
}

type GlobOutcome =
  | { readonly kind: "ok"; readonly expansion: GlobExpansion }
  | { readonly kind: "error"; readonly message: string };

function sortDirents(entries: readonly Dirent[]): Dirent[] {
  return entries.toSorted((left, right) => {
    const leftDir = left.isDirectory() ? 0 : 1;
    const rightDir = right.isDirectory() ? 0 : 1;
    if (leftDir !== rightDir) return leftDir - rightDir;
    return left.name.localeCompare(right.name);
  });
}

async function expandRecursiveGlob(
  root: string,
  displayPattern: string,
  basePath: string,
): Promise<GlobOutcome> {
  const resolved = await resolveForRead(root, basePath);
  if (resolved.kind === "error") return { kind: "error", message: resolved.message };
  let baseStats: Stats;
  try {
    baseStats = await fs.stat(resolved.path.absolutePath);
  } catch (error) {
    return { kind: "error", message: isNotFoundError(error) ? "not found" : errorText(error) };
  }
  if (!baseStats.isDirectory()) {
    return { kind: "error", message: `${basePath} is not a directory, so it cannot be globbed` };
  }

  const files: string[] = [];
  let capped = false;
  let scanCapped = false;
  let scanned = 0;
  const basePrefix = resolved.path.relativePath === "." ? "" : resolved.path.relativePath;
  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: resolved.path.absolutePath, relativePath: basePrefix, depth: 0 },
  ];

  while (queue.length > 0 && !capped) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current.depth > MAX_GLOB_DEPTH) continue;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
    } catch {
      continue; // Unreadable subdirectory: skip it rather than fail the whole expansion.
    }
    for (const entry of sortDirents(entries)) {
      if (entry.isSymbolicLink()) continue;
      scanned += 1;
      if (scanned > MAX_GLOB_SCAN_ENTRIES) {
        scanCapped = true;
        break;
      }
      const childRelative =
        current.relativePath === "" ? entry.name : `${current.relativePath}/${entry.name}`;
      if (entry.isDirectory()) {
        queue.push({
          absolutePath: path.join(current.absolutePath, entry.name),
          relativePath: childRelative,
          depth: current.depth + 1,
        });
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_GLOB_MATCHES) {
        capped = true;
        break;
      }
      files.push(childRelative);
    }
    if (scanCapped) break;
  }

  const notes: string[] = [];
  if (capped) {
    notes.push(
      `(${displayPattern}: more than ${MAX_GLOB_MATCHES} matches; only the first ${MAX_GLOB_MATCHES} are shown)`,
    );
  }
  if (scanCapped) {
    notes.push(
      `(${displayPattern}: stopped scanning after ${MAX_GLOB_SCAN_ENTRIES} entries; more matches may exist)`,
    );
  }
  return {
    kind: "ok",
    expansion: { matches: files, note: notes.length > 0 ? notes.join(" ") : null },
  };
}

async function expandSegmentGlob(
  root: string,
  displayPattern: string,
  basePath: string,
  pattern: string,
): Promise<GlobOutcome> {
  const resolved = await resolveForRead(root, basePath);
  if (resolved.kind === "error") return { kind: "error", message: resolved.message };
  let baseStats: Stats;
  try {
    baseStats = await fs.stat(resolved.path.absolutePath);
  } catch (error) {
    return { kind: "error", message: isNotFoundError(error) ? "not found" : errorText(error) };
  }
  if (!baseStats.isDirectory()) {
    return { kind: "error", message: `${basePath} is not a directory, so it cannot be globbed` };
  }

  let entries: Dirent[];
  try {
    entries = await fs.readdir(resolved.path.absolutePath, { withFileTypes: true });
  } catch (error) {
    return { kind: "error", message: errorText(error) };
  }

  const matcher = wildcardRegExp(pattern);
  const matches: string[] = [];
  let capped = false;
  for (const entry of sortDirents(entries)) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    if (!matcher.test(entry.name)) continue;
    if (matches.length >= MAX_GLOB_MATCHES) {
      capped = true;
      break;
    }
    const prefix = resolved.path.relativePath === "." ? "" : `${resolved.path.relativePath}/`;
    matches.push(`${prefix}${entry.name}`);
  }

  return {
    kind: "ok",
    expansion: {
      matches,
      note: capped
        ? `(${displayPattern}: more than ${MAX_GLOB_MATCHES} matches; only the first ${MAX_GLOB_MATCHES} are shown)`
        : null,
    },
  };
}

async function expandGlob(
  root: string,
  displayPattern: string,
  classification: Exclude<GlobClassification, { kind: "none" } | { kind: "invalid" }>,
): Promise<GlobOutcome> {
  if (classification.kind === "recursive") {
    return expandRecursiveGlob(root, displayPattern, classification.basePath);
  }
  return expandSegmentGlob(root, displayPattern, classification.basePath, classification.pattern);
}

async function listDirectorySection(absolutePath: string): Promise<string> {
  const entries = sortDirents(await fs.readdir(absolutePath, { withFileTypes: true }));
  const shown = entries.slice(0, MAX_DIR_ENTRIES);
  const remaining = entries.length - shown.length;
  const lines = shown.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  if (remaining > 0) lines.push(`… (${remaining} more)`);
  return lines.join("\n");
}

interface TextSlice {
  readonly text: string;
  /** True when the payload budget or the scan budget cut the read short. */
  readonly truncated: boolean;
  readonly omittedBytes: number;
  readonly linesSelected: number;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, omittedBytes: 0 };
  let end = Math.max(0, Math.min(maxBytes, bytes.length));
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), omittedBytes: bytes.length - end };
}

/**
 * Reads the requested line range from an open file, bounded twice over: the caller's byte
 * budget stops the payload, and MAX_SCAN_BYTES stops a pathological range from walking a huge
 * file. The range is applied before size truncation, so a range always wins over the budget.
 */
async function readTextSlice(
  handle: FileHandle,
  range: LineRange,
  byteLimit: number,
): Promise<TextSlice> {
  const decoder = new TextDecoder("utf-8");
  let carry = "";
  let lineNumber = 0;
  const selected: string[] = [];
  let selectedBytes = 0;
  let rangeComplete = false;
  let truncatedByBudget = false;
  let offset = 0;
  let scannedBytes = 0;

  const consumeLine = (rawLine: string): boolean => {
    lineNumber += 1;
    if (lineNumber < range.startLine) return true;
    if (lineNumber > range.endLine) {
      rangeComplete = true;
      return false;
    }
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    selected.push(line);
    selectedBytes += Buffer.byteLength(line, "utf8") + 1;
    if (selectedBytes >= byteLimit) {
      truncatedByBudget = true;
      return false;
    }
    return true;
  };

  const feed = (text: string): void => {
    carry += text;
    let newlineIndex = carry.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = carry.slice(0, newlineIndex);
      carry = carry.slice(newlineIndex + 1);
      if (!consumeLine(line)) return;
      newlineIndex = carry.indexOf("\n");
    }
    if (carry.length > byteLimit) {
      // A single line alone exceeds the budget; keep its prefix and stop reading.
      lineNumber += 1;
      if (lineNumber >= range.startLine && lineNumber <= range.endLine) {
        selected.push(carry.endsWith("\r") ? carry.slice(0, -1) : carry);
      }
      truncatedByBudget = true;
    }
  };

  for (;;) {
    if (scannedBytes >= MAX_SCAN_BYTES) {
      truncatedByBudget = true;
      break;
    }
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    scannedBytes += bytesRead;
    feed(decoder.decode(chunk.subarray(0, bytesRead), { stream: true }));
    if (rangeComplete || truncatedByBudget) break;
  }
  if (!rangeComplete && !truncatedByBudget) {
    carry += decoder.decode();
    if (carry.length > 0) consumeLine(carry);
  }

  const joined = selected.join("\n");
  const truncated = truncateUtf8(joined, byteLimit);
  const omittedBytes =
    Buffer.byteLength(joined, "utf8") - Buffer.byteLength(truncated.text, "utf8");
  return {
    text: truncated.text,
    truncated: truncatedByBudget || omittedBytes > 0,
    omittedBytes,
    linesSelected: selected.length,
  };
}

async function readFileSection(
  header: string,
  absolutePath: string,
  fileBytes: number,
  range: LineRange,
  byteLimit: number,
): Promise<ReadSection> {
  let handle: FileHandle;
  try {
    handle = await fs.open(absolutePath, "r");
  } catch (error) {
    return {
      ok: false,
      text: `${header}\nError: ${isNotFoundError(error) ? "not found" : errorText(error)}`,
    };
  }
  try {
    const headLength = Math.min(BINARY_SNIFF_BYTES, fileBytes);
    if (headLength > 0) {
      const head = Buffer.alloc(headLength);
      const { bytesRead } = await handle.read(head, 0, headLength, 0);
      if (head.subarray(0, bytesRead).includes(0)) {
        return { ok: true, text: `${header}\n(binary file, ${fileBytes} bytes)` };
      }
    }
    const slice = await readTextSlice(handle, range, byteLimit);
    const lines = [header];
    if (slice.text.length > 0) lines.push(slice.text);
    if (slice.omittedBytes > 0) {
      lines.push(
        `… (truncated ${slice.omittedBytes} bytes; continue with start_line/end_line or raise max_bytes)`,
      );
    } else if (slice.truncated) {
      lines.push(
        `… (output capped at ${byteLimit} bytes; continue with start_line/end_line or raise max_bytes)`,
      );
    }
    if (slice.linesSelected === 0 && isRangeRequested(range)) {
      lines.push("(no lines in that range)");
    }
    return { ok: true, text: lines.join("\n") };
  } finally {
    await handle.close();
  }
}

interface ReadSection {
  readonly text: string;
  readonly ok: boolean;
}

function isRangeRequested(range: LineRange): boolean {
  return range.startLine > 1 || Number.isFinite(range.endLine);
}

async function readTarget(
  root: string,
  inputPath: string,
  range: LineRange,
  byteLimit: number,
): Promise<ReadSection> {
  const resolved = await resolveForRead(root, inputPath);
  if (resolved.kind === "error") {
    return { ok: false, text: `--- ${inputPath} ---\nError: ${resolved.message}` };
  }
  const header = `--- ${resolved.path.relativePath} ---`;
  let stats: Stats;
  try {
    stats = await fs.stat(resolved.path.absolutePath);
  } catch (error) {
    return {
      ok: false,
      text: `${header}\nError: ${isNotFoundError(error) ? "not found" : errorText(error)}`,
    };
  }
  if (stats.isDirectory()) {
    try {
      const listing = await listDirectorySection(resolved.path.absolutePath);
      return {
        ok: true,
        text: listing.length > 0 ? `${header}\n${listing}` : `${header}\n(empty directory)`,
      };
    } catch (error) {
      return { ok: false, text: `${header}\nError: ${errorText(error)}` };
    }
  }
  if (!stats.isFile()) {
    return { ok: false, text: `${header}\nError: not a regular file` };
  }
  return readFileSection(header, resolved.path.absolutePath, stats.size, range, byteLimit);
}

function errorResult(text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Runs the connector `read` tool. Failures are per-section text results; only a call where no
 * target produced a usable section is marked as an error overall.
 */
export async function runReadTool(
  ctx: WorkspaceToolContext,
  input: ReadToolInput,
): Promise<McpToolCallResult> {
  const rawPaths: unknown = input?.paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    return errorResult("Error: paths must be a non-empty array of strings.");
  }

  const range = parseLineRange(input);
  const perFileLimit = normalizeMaxBytes(input?.max_bytes);
  const requested = (rawPaths as readonly unknown[]).slice(0, MAX_READ_PATHS);
  const parts: string[] = [];
  if (rawPaths.length > MAX_READ_PATHS) {
    parts.push(`(only the first ${MAX_READ_PATHS} paths were read)`);
  }

  let remaining = AGGREGATE_READ_BYTES;
  let successes = 0;
  let stopped = false;

  for (const raw of requested) {
    if (stopped) break;
    if (remaining <= 0) {
      parts.push("(aggregate output cap reached; the remaining paths were not read)");
      break;
    }
    if (typeof raw !== "string" || raw.length === 0) {
      parts.push("--- (invalid path) ---\nError: each path must be a non-empty string");
      continue;
    }
    if (range.kind === "error") {
      parts.push(`--- ${raw} ---\nError: ${range.message}`);
      continue;
    }

    const classification = classifyGlobPath(raw);
    if (classification.kind === "invalid") {
      parts.push(`--- ${raw} ---\nError: ${classification.message}`);
      continue;
    }

    const targets: string[] = [];
    let globNote: string | null = null;
    if (classification.kind === "none") {
      targets.push(raw);
    } else {
      const outcome = await expandGlob(ctx.workspaceRoot, raw, classification);
      if (outcome.kind === "error") {
        parts.push(`--- ${raw} ---\nError: ${outcome.message}`);
        continue;
      }
      if (outcome.expansion.matches.length === 0) {
        parts.push(`--- ${raw} ---\nError: no matches`);
        continue;
      }
      targets.push(...outcome.expansion.matches);
      globNote = outcome.expansion.note;
    }

    for (const target of targets) {
      if (remaining <= 0) {
        parts.push("(aggregate output cap reached; the remaining paths were not read)");
        stopped = true;
        break;
      }
      const section = await readTarget(
        ctx.workspaceRoot,
        target,
        range.range,
        Math.min(perFileLimit, remaining),
      );
      remaining -= Buffer.byteLength(section.text, "utf8");
      if (section.ok) successes += 1;
      parts.push(section.text);
    }
    if (globNote !== null) parts.push(globNote);
  }

  if (parts.length === 0) parts.push("Nothing to read.");
  const text = parts.join("\n\n");
  if (successes === 0) return errorResult(text);
  return { content: [{ type: "text", text }] };
}
