import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "./config";
import { resolveActiveCodexHomeWritePath } from "./codexHomePaths";
import { sameFileIdentity, syncDirectoryEntry, syncRegularFile } from "./privatePathPermissions";

export const DELETED_CODEX_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const MANIFEST_LIMIT_BYTES = 1024 * 1024;

interface DeletionManifest {
  readonly threadId: string;
  readonly nativeThreadId: string;
  readonly deletedAt: string;
  readonly stopped: boolean;
  readonly home: string;
  readonly files: readonly string[];
}

function manifestDirectory(stateDir: string): string {
  return path.join(stateDir, "deleted-codex-artifacts");
}

function manifestName(threadId: string): string {
  return `${createHash("sha256").update(threadId).digest("hex")}.json`;
}

async function statOrNull(file: string) {
  return fs.lstat(file).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
}

// Reject links at every component, including session roots linked to ~/.codex.
async function inspectOwnedPath(root: string, relative: string) {
  const parts = relative.split(path.sep);
  if (parts.some((part) => !part || part === "." || part === "..") || path.isAbsolute(relative)) {
    return null;
  }
  const identities = [];
  let current = root;
  for (const part of ["", ...parts]) {
    if (part) current = path.join(current, part);
    const stat = await statOrNull(current);
    if (!stat || stat.isSymbolicLink()) return null;
    if (current !== path.join(root, relative) && !stat.isDirectory()) return null;
    identities.push({ file: current, stat });
  }
  return identities;
}

async function unlinkOwnedFile(root: string, relative: string, cutoffMs: number): Promise<boolean> {
  const identities = await inspectOwnedPath(root, relative);
  const leaf = identities?.at(-1);
  if (!leaf) return (await statOrNull(path.join(root, relative))) === null;
  if (!leaf.stat.isFile() || leaf.stat.mtimeMs > cutoffMs) return false;
  for (const identity of identities ?? []) {
    const current = await statOrNull(identity.file);
    if (!current || current.isSymbolicLink() || !sameFileIdentity(identity.stat, current)) {
      return false;
    }
  }
  await fs.unlink(leaf.file);
  return true;
}

function isOwnedOverlayHome(relative: string): boolean {
  const parts = relative.split(path.sep);
  return (
    (parts.length === 2 && parts[0] === "codex-home-overlays" && UUID.test(parts[1] ?? "")) ||
    relative === "codex-home-overlay" ||
    (parts.length === 3 &&
      parts[0] === "codex-home-overlay" &&
      parts[1] === "accounts" &&
      /^[\w-]+$/u.test(parts[2] ?? ""))
  );
}

async function collectFiles(baseDir: string, relative: string, depth = 0): Promise<string[]> {
  if (depth > 4 || !(await inspectOwnedPath(baseDir, relative))?.at(-1)?.stat.isDirectory()) {
    return [];
  }
  const result: string[] = [];
  for (const entry of await fs.readdir(path.join(baseDir, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isFile()) result.push(child);
    else if (entry.isDirectory() && !entry.isSymbolicLink()) {
      result.push(...(await collectFiles(baseDir, child, depth + 1)));
    }
  }
  return result;
}

function isOwnedArtifact(relative: string, nativeThreadId: string): boolean {
  const parts = relative.split(path.sep);
  let artifact: number;
  if (parts[0] === "codex-home-overlays" && UUID.test(parts[1] ?? "")) artifact = 2;
  else if (parts[0] === "codex-home-overlay") {
    artifact = parts[1] === "accounts" && /^[\w-]+$/u.test(parts[2] ?? "") ? 3 : 1;
  } else return false;
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  if (parts[artifact] === "generated_images") {
    return parts[artifact + 1] === nativeThreadId && parts.length > artifact + 2;
  }
  return (
    ["sessions", "archived_sessions"].includes(parts[artifact] ?? "") &&
    new RegExp(`[-_]${nativeThreadId}\\.jsonl(?:\\.gz)?$`, "iu").test(parts.at(-1) ?? "")
  );
}

async function collectArtifacts(
  baseDir: string,
  home: string,
  nativeThreadId: string,
): Promise<string[]> {
  const files: string[] = [];
  for (const directory of [
    "sessions",
    "archived_sessions",
    path.join("generated_images", nativeThreadId),
  ]) {
    files.push(
      ...(await collectFiles(baseDir, path.join(home, directory))).filter((file) =>
        isOwnedArtifact(file, nativeThreadId),
      ),
    );
  }
  return files;
}

async function readManifest(stateDir: string, name: string): Promise<DeletionManifest | null> {
  const directory = manifestDirectory(stateDir);
  const identity = await inspectOwnedPath(stateDir, path.join("deleted-codex-artifacts", name));
  if (!identity?.at(-1)?.stat.isFile() || identity.at(-1)!.stat.size > MANIFEST_LIMIT_BYTES) {
    return null;
  }
  let record: unknown;
  try {
    record = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
  } catch {
    return null;
  }
  if (!record || typeof record !== "object") return null;
  const value = record as DeletionManifest;
  if (
    typeof value.threadId !== "string" ||
    manifestName(value.threadId) !== name ||
    typeof value.nativeThreadId !== "string" ||
    !UUID.test(value.nativeThreadId) ||
    typeof value.deletedAt !== "string" ||
    !Number.isFinite(Date.parse(value.deletedAt)) ||
    typeof value.stopped !== "boolean" ||
    typeof value.home !== "string" ||
    !isOwnedOverlayHome(value.home) ||
    !Array.isArray(value.files) ||
    !value.files.every(
      (file) =>
        typeof file === "string" &&
        file.startsWith(`${value.home}${path.sep}`) &&
        isOwnedArtifact(file, value.nativeThreadId),
    )
  )
    return null;
  return value;
}

async function writeManifest(stateDir: string, record: DeletionManifest): Promise<void> {
  const directory = manifestDirectory(stateDir);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await inspectOwnedPath(stateDir, "deleted-codex-artifacts"))?.at(-1)?.stat.isDirectory()) {
    throw new Error("Refusing a linked Codex artifact retention directory");
  }
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > MANIFEST_LIMIT_BYTES)
    throw new Error("Codex retention manifest is too large");
  const file = path.join(directory, manifestName(record.threadId));
  const temporary = `${file}.${randomUUID()}.partial`;
  await fs.writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
  await syncRegularFile(temporary);
  await fs.rename(temporary, file);
  await syncDirectoryEntry(directory);
}

/** Capture ownership before stopSession removes the durable Codex cursor. */
export const rememberDeletedCodexArtifacts = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { baseDir, stateDir } = yield* ServerConfig;
    const rows = yield* sql<{
      readonly nativeThreadId: string | null;
      readonly deletedAt: string;
      readonly homePath: string | null;
      readonly shadowHomePath: string | null;
      readonly accountId: string | null;
      readonly continuationIdentity: string | null;
      readonly environment: string | null;
    }>`
    SELECT json_extract(r.resume_cursor_json, '$.threadId') AS nativeThreadId, t.deleted_at AS deletedAt,
      json_extract(r.runtime_payload_json, '$.providerOptions.codex.homePath') AS homePath,
      json_extract(r.runtime_payload_json, '$.providerOptions.codex.shadowHomePath') AS shadowHomePath,
      json_extract(r.runtime_payload_json, '$.providerOptions.codex.accountId') AS accountId,
      json_extract(r.runtime_payload_json, '$.continuationIdentity') AS continuationIdentity,
      json_type(r.runtime_payload_json, '$.providerOptions.codex.environment') AS environment
    FROM provider_session_runtime r JOIN projection_threads t ON t.thread_id = r.thread_id
    WHERE r.thread_id = ${threadId} AND r.provider_name = 'codex' AND t.deleted_at IS NOT NULL
  `;
    const row = rows[0];
    if (typeof row?.nativeThreadId !== "string" || !UUID.test(row.nativeThreadId)) return false;
    // Environment overrides are redacted at persistence. Without an explicit
    // home they cannot prove which account overlay was used; keep those files.
    if (row.environment !== null && !row.homePath && !row.shadowHomePath) return false;
    const source =
      row.homePath ??
      (row.continuationIdentity?.startsWith("codex:native-v1:")
        ? row.continuationIdentity.slice("codex:native-v1:".length)
        : undefined);
    if (!source && !row.shadowHomePath) return false;
    const home = path.relative(
      baseDir,
      resolveActiveCodexHomeWritePath({
        env: { ...process.env, SYNARA_HOME: baseDir },
        ...(source ? { homePath: source } : {}),
        ...(row.shadowHomePath ? { shadowHomePath: row.shadowHomePath } : {}),
        ...(row.accountId ? { accountId: row.accountId } : {}),
      }),
    );
    if (!isOwnedOverlayHome(home)) return false;
    yield* Effect.tryPromise(async () => {
      if (await readManifest(stateDir, manifestName(threadId))) return;
      const files = await collectArtifacts(baseDir, home, row.nativeThreadId!);
      if (files.length === 0) return;
      await writeManifest(stateDir, {
        threadId,
        nativeThreadId: row.nativeThreadId!,
        home,
        deletedAt: row.deletedAt,
        stopped: false,
        files,
      });
    });
    return true;
  });

export const confirmDeletedCodexRuntimeStopped = (threadId: string) =>
  Effect.gen(function* () {
    const { baseDir, stateDir } = yield* ServerConfig;
    yield* Effect.tryPromise(async () => {
      const record = await readManifest(stateDir, manifestName(threadId));
      if (record && !record.stopped) {
        const files = [
          ...new Set([
            ...record.files,
            ...(await collectArtifacts(baseDir, record.home, record.nativeThreadId)),
          ]),
        ];
        await writeManifest(stateDir, { ...record, files, stopped: true });
      }
    });
  });

const hasSurvivingImageReferences = (nativeThreadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Messages and activities have rowids; chunks are WITHOUT ROWID. Bound every
    // read and yield between pages instead of scanning multi-GB history inline.
    for (const table of ["projection_thread_messages", "projection_thread_activities"] as const) {
      let after = 0;
      while (true) {
        const text =
          table === "projection_thread_messages"
            ? "COALESCE(text, '') || COALESCE(text_json, '') || COALESCE(attachments_json, '')"
            : "payload_json";
        const page = yield* sql<{ readonly cursor: number; readonly referenced: number }>`
        SELECT rowid AS cursor, instr(${sql.literal(text)}, ${nativeThreadId}) > 0 AS referenced
        FROM ${sql.literal(table)} WHERE rowid > ${after} ORDER BY rowid LIMIT 100
      `;
        if (page.some((row) => row.referenced)) return true;
        const last = page.at(-1);
        if (!last) break;
        after = last.cursor;
        yield* Effect.sleep(5);
      }
    }
    let thread = "";
    let message = "";
    let sequence = 0;
    while (true) {
      const page = yield* sql<{
        readonly thread: string;
        readonly message: string;
        readonly sequence: number;
        readonly referenced: number;
      }>`
      SELECT thread_id AS thread, message_id AS message, event_sequence AS sequence,
        instr(text_json, ${nativeThreadId}) > 0 AS referenced
      FROM message_text_chunks
      WHERE (thread_id, message_id, event_sequence) > (${thread}, ${message}, ${sequence})
      ORDER BY thread_id, message_id, event_sequence LIMIT 100
    `;
      if (page.some((row) => row.referenced)) return true;
      const last = page.at(-1);
      if (!last) return false;
      ({ thread, message, sequence } = last);
      yield* Effect.sleep(5);
    }
  });

/** Unknown rollouts and archived threads are deliberately never inferred to be deleted. */
export const pruneDeletedCodexArtifacts = (now = new Date()) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { baseDir, stateDir } = yield* ServerConfig;
    const cutoffMs = now.getTime() - DELETED_CODEX_ARTIFACT_RETENTION_MS;
    const names = yield* Effect.tryPromise(async () => {
      if (
        !(await inspectOwnedPath(stateDir, "deleted-codex-artifacts"))?.at(-1)?.stat.isDirectory()
      )
        return [];
      return fs.readdir(manifestDirectory(stateDir));
    });
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      // Read only bounded regular manifests; their contents never choose an external path.
      const record = yield* Effect.tryPromise(() => readManifest(stateDir, name));
      if (!record?.stopped || Date.parse(record.deletedAt) > cutoffMs) continue;
      const protectedRows = yield* sql`
      SELECT 1 FROM projection_threads WHERE thread_id = ${record.threadId} OR subagent_agent_id = ${record.nativeThreadId}
      UNION ALL
      SELECT 1 FROM provider_session_runtime
      WHERE provider_name = 'codex' AND json_extract(resume_cursor_json, '$.threadId') = ${record.nativeThreadId}
      LIMIT 1
    `;
      if (protectedRows.length > 0) continue;
      const revision = yield* sql<{
        readonly sequence: number;
      }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`;
      const sequence = revision[0]?.sequence ?? 0;
      const preserveImages =
        record.files.some((file) => file.split(path.sep).includes("generated_images")) &&
        (yield* hasSurvivingImageReferences(record.nativeThreadId));
      let complete = true;
      for (const file of record.files) {
        const changed = yield* sql`
        SELECT 1 WHERE (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events) <> ${sequence}
          OR EXISTS (SELECT 1 FROM projection_state WHERE last_applied_sequence < ${sequence})
          OR EXISTS (SELECT 1 FROM provider_session_runtime
            WHERE provider_name = 'codex' AND json_extract(resume_cursor_json, '$.threadId') = ${record.nativeThreadId})
          OR EXISTS (SELECT 1 FROM projection_threads
            WHERE thread_id = ${record.threadId} OR subagent_agent_id = ${record.nativeThreadId})
      `;
        if (changed.length > 0) {
          complete = false;
          break;
        }
        if (preserveImages && file.split(path.sep).includes("generated_images")) {
          complete = false;
          continue;
        }
        const removed = yield* Effect.tryPromise(() => unlinkOwnedFile(baseDir, file, cutoffMs));
        if (!removed) complete = false;
        yield* Effect.sleep(5);
      }
      if (complete)
        yield* Effect.tryPromise(() =>
          unlinkOwnedFile(stateDir, path.join("deleted-codex-artifacts", name), now.getTime()),
        );
    }
  });
