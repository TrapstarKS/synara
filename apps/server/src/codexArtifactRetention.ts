import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { collectSubagentProviderThreadIds } from "@synara/shared/subagents";

import { ServerConfig } from "./config";
import { resolveActiveCodexHomeWritePath } from "./codexHomePaths";
import { sameFileIdentity, syncDirectoryEntry, syncRegularFile } from "./privatePathPermissions";
import { isCodexOverlayIdle } from "./platform/codexOverlayActivity";
import type { ProviderServiceShape } from "./provider/Services/ProviderService";

export const DELETED_CODEX_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const ORPHAN_CODEX_ROLLOUT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const MANIFEST_LIMIT_BYTES = 1024 * 1024;
const REFERENCE_LIMIT_BYTES = 64 * 1024;
const ORPHAN_BATCH_SIZE = 25;

interface NativeReferenceRow {
  readonly cursor: string;
  readonly first: string | null;
  readonly second: string | null;
  readonly selection: string | null;
  readonly oversized: number;
}

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

async function unlinkOwnedFile(
  root: string,
  relative: string,
  cutoffMs: number,
  expected?: Stats,
): Promise<boolean> {
  const identities = await inspectOwnedPath(root, relative);
  const leaf = identities?.at(-1);
  if (!leaf) return expected ? false : (await statOrNull(path.join(root, relative))) === null;
  if (!leaf.stat.isFile() || leaf.stat.mtimeMs > cutoffMs) return false;
  if (
    expected &&
    (!sameFileIdentity(expected, leaf.stat) ||
      expected.size !== leaf.stat.size ||
      expected.mtimeMs !== leaf.stat.mtimeMs)
  )
    return false;
  for (const identity of identities ?? []) {
    const current = await statOrNull(identity.file);
    if (!current || current.isSymbolicLink() || !sameFileIdentity(identity.stat, current)) {
      return false;
    }
    if (
      identity.file === leaf.file &&
      (current.mtimeMs !== leaf.stat.mtimeMs || current.size !== leaf.stat.size)
    )
      return false;
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

/** Captured deleted artifacts retain their shorter, teardown-confirmed grace period. */
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

function addNativeReferences(ids: Set<string>, value: string | null, json = false): void {
  if (value === null) return;
  if (typeof value !== "string" || value.length > REFERENCE_LIMIT_BYTES) {
    throw new Error("Codex retention reference is unreadable or oversized");
  }
  let normalized = value;
  if (json) {
    try {
      normalized = JSON.stringify(JSON.parse(value));
    } catch {
      throw new Error("Codex retention reference JSON is invalid");
    }
  }
  for (const match of normalized.matchAll(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/giu)) {
    ids.add(match[0].toLowerCase());
  }
}

const readNativeReferences = (listSessions: ProviderServiceShape["listSessions"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ids = new Set<string>();
    for (const session of yield* listSessions()) {
      if (session.provider !== "codex") continue;
      const cursor = session.resumeCursor as { readonly threadId?: unknown } | undefined;
      if (typeof cursor?.threadId !== "string" || !UUID.test(cursor.threadId)) {
        return yield* Effect.fail(
          new Error("Cannot identify an active Codex session; orphan retention deferred"),
        );
      }
      ids.add(cursor.threadId.toLowerCase());
    }
    // Include dangling and soft-deleted bindings as well as archived threads.
    // Read bounded pages; malformed or unexpectedly large records stop the sweep.
    for (const table of [
      "provider_session_runtime",
      "projection_threads",
      "projection_thread_sessions",
    ] as const) {
      let after: string | null = null;
      while (true) {
        const first =
          table === "provider_session_runtime"
            ? "resume_cursor_json"
            : table === "projection_threads"
              ? "subagent_agent_id"
              : "provider_thread_id";
        const second =
          table === "provider_session_runtime"
            ? "runtime_payload_json"
            : table === "projection_threads"
              ? "handoff_json"
              : "provider_session_id";
        const selection = table === "projection_threads" ? "model_selection_json" : "NULL";
        const page: ReadonlyArray<NativeReferenceRow> = yield* sql<NativeReferenceRow>`
          SELECT thread_id AS cursor,
            CASE WHEN length(${sql.literal(first)}) <= ${REFERENCE_LIMIT_BYTES} THEN ${sql.literal(first)} END AS first,
            CASE WHEN length(${sql.literal(second)}) <= ${REFERENCE_LIMIT_BYTES} THEN ${sql.literal(second)} END AS second,
            CASE WHEN length(${sql.literal(selection)}) <= ${REFERENCE_LIMIT_BYTES} THEN ${sql.literal(selection)} END AS selection,
            COALESCE(length(${sql.literal(first)}) > ${REFERENCE_LIMIT_BYTES}, 0)
              OR COALESCE(length(${sql.literal(second)}) > ${REFERENCE_LIMIT_BYTES}, 0)
              OR COALESCE(length(${sql.literal(selection)}) > ${REFERENCE_LIMIT_BYTES}, 0) AS oversized
          FROM ${sql.literal(table)} WHERE ${after} IS NULL OR thread_id > ${after}
          ORDER BY thread_id LIMIT 100
        `;
        for (const row of page) {
          if (typeof row.cursor !== "string" || row.oversized) {
            return yield* Effect.fail(
              new Error("Codex retention binding set is unreadable or oversized"),
            );
          }
          yield* Effect.try({
            try: () => {
              addNativeReferences(ids, row.cursor);
              addNativeReferences(ids, row.first, table === "provider_session_runtime");
              addNativeReferences(ids, row.second, table !== "projection_thread_sessions");
              addNativeReferences(ids, row.selection, true);
            },
            catch: (cause) => cause,
          });
        }
        const last = page.at(-1);
        if (!last) break;
        after = last.cursor;
        yield* Effect.sleep(5);
      }
    }
    return ids;
  });

function rolloutNativeId(relative: string): string | undefined {
  return /^rollout-.*[-_]([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl(?:\.gz)?$/iu
    .exec(path.basename(relative))?.[1]
    ?.toLowerCase();
}

function addCollaborationReferences(ids: Set<string>, data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const record = data as Record<string, unknown>;
  const item = record.item;
  const source =
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : record;
  for (const id of collectSubagentProviderThreadIds(source)) addNativeReferences(ids, id);
  for (const field of [
    "senderThreadId",
    "sender_thread_id",
    "parentThreadId",
    "parent_thread_id",
  ]) {
    if (typeof source[field] === "string") addNativeReferences(ids, source[field]);
  }
}

const readHistoricalNativeReferences = (
  ids: Set<string>,
  runtimeSequence: number,
  activityCursor: number,
  unchanged: Effect.Effect<boolean, unknown, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let after = 0;
    while (true) {
      if (!(yield* unchanged)) return false;
      // Runtime events are capped at 2 MiB by their schema. Parse one per step,
      // yielding each time; never load a page of large tool output on the main loop.
      const page = yield* sql<{ readonly cursor: number; readonly event: string | null }>`
      SELECT sequence AS cursor, CASE WHEN length(event_json) <= 2097152 THEN event_json END AS event
      FROM provider_runtime_events WHERE sequence > ${after} AND sequence <= ${runtimeSequence}
      ORDER BY sequence LIMIT 1
    `;
      const row = page[0];
      if (!row) break;
      yield* Effect.try({
        try: () => {
          if (typeof row.event !== "string") throw new Error("Oversized native runtime reference");
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(row.event);
          } catch {
            throw new Error("Native runtime reference JSON is invalid");
          }
          if (!event || typeof event !== "object" || Array.isArray(event)) {
            throw new Error("Native runtime reference is unreadable");
          }
          if (event.providerRefs !== undefined) {
            addNativeReferences(ids, JSON.stringify(event.providerRefs), true);
          }
          const payload = event.payload as Record<string, unknown> | undefined;
          addCollaborationReferences(ids, payload?.data);
        },
        catch: (cause) => cause,
      });
      after = row.cursor;
      yield* Effect.sleep(5);
    }
    after = 0;
    while (true) {
      if (!(yield* unchanged)) return false;
      const page: ReadonlyArray<{
        readonly cursor: number;
        readonly kind: string;
        readonly reference: string | null;
        readonly oversized: number;
      }> = yield* sql<{
        readonly cursor: number;
        readonly kind: string;
        readonly reference: string | null;
        readonly oversized: number;
      }>`
      SELECT cursor, kind, CASE WHEN length(reference) <= ${REFERENCE_LIMIT_BYTES} THEN reference END AS reference,
        COALESCE(length(reference) > ${REFERENCE_LIMIT_BYTES}, 0) AS oversized
      FROM (
        SELECT rowid AS cursor, kind, CASE WHEN kind LIKE 'subagent.%'
          OR kind IN ('tool.started', 'tool.updated', 'tool.completed')
          THEN payload_json END AS reference
        FROM projection_thread_activities WHERE rowid > ${after} AND rowid <= ${activityCursor}
        ORDER BY rowid LIMIT 25
      )
    `;
      for (const row of page) {
        if (row.oversized)
          return yield* Effect.fail(new Error("Oversized native collaboration reference"));
        if (row.reference !== null) {
          yield* Effect.try({
            try: () => {
              // Only native collaboration metadata qualifies; accounting usage IDs
              // and arbitrary UUIDs in tool output do not establish native ownership.
              let payload: Record<string, unknown>;
              try {
                payload = JSON.parse(row.reference!);
              } catch {
                throw new Error("Native collaboration reference JSON is invalid");
              }
              if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                throw new Error("Native collaboration reference is unreadable");
              }
              addCollaborationReferences(ids, payload.data ?? payload);
            },
            catch: (cause) => cause,
          });
        }
      }
      const last = page.at(-1);
      if (!last) break;
      after = last.cursor;
      yield* Effect.sleep(5);
    }
    return true;
  });

async function* walkOwnedSessions(
  baseDir: string,
  relative: string,
  depth = 0,
): AsyncGenerator<string> {
  if (depth > 4 || !(await inspectOwnedPath(baseDir, relative))?.at(-1)?.stat.isDirectory()) return;
  const directory = await fs.opendir(path.join(baseDir, relative));
  for await (const entry of directory) {
    const child = path.join(relative, entry.name);
    yield child;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      yield* walkOwnedSessions(baseDir, child, depth + 1);
    }
  }
}

/** Only abandoned plural overlays qualify; a live/reference ambiguity preserves the whole home. */
export const pruneOrphanedCodexRollouts = (
  listSessions: ProviderServiceShape["listSessions"],
  now = new Date(),
) =>
  Effect.suspend(() => {
    const counts = { scanned: 0, reclaimedFiles: 0, reclaimedBytes: 0, preservedOverlays: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { baseDir } = yield* ServerConfig;
      const cutoff = now.getTime() - ORPHAN_CODEX_ROLLOUT_RETENTION_MS;
      const revisions = yield* sql<{
        readonly sequence: number;
        readonly runtimeSequence: number;
        readonly activityCursor: number;
      }>`
      SELECT COALESCE(MAX(sequence), 0) AS sequence,
        (SELECT COALESCE(MAX(sequence), 0) FROM provider_runtime_events) AS runtimeSequence,
        (SELECT COALESCE(MAX(rowid), 0) FROM projection_thread_activities) AS activityCursor
      FROM orchestration_events
    `;
      const sequence = revisions[0]?.sequence;
      if (!Number.isSafeInteger(sequence))
        return yield* Effect.fail(new Error("Unreadable retention journal revision"));
      const runtimeSequence = revisions[0]?.runtimeSequence;
      if (!Number.isSafeInteger(runtimeSequence))
        return yield* Effect.fail(new Error("Unreadable native runtime journal revision"));
      const activityCursor = revisions[0]?.activityCursor;
      if (!Number.isSafeInteger(activityCursor))
        return yield* Effect.fail(new Error("Unreadable collaboration activity horizon"));
      const unchanged = Effect.gen(function* () {
        const changed = yield* sql`
        SELECT 1 WHERE (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events) <> ${sequence}
          OR EXISTS (SELECT 1 FROM projection_state WHERE last_applied_sequence < ${sequence})
          OR (SELECT COALESCE(MAX(sequence), 0) FROM provider_runtime_events) <> ${runtimeSequence}
          OR EXISTS (SELECT 1 FROM provider_runtime_event_consumers WHERE last_acked_sequence < ${runtimeSequence})
          OR (${runtimeSequence} > 0 AND NOT EXISTS (SELECT 1 FROM provider_runtime_event_consumers))
      `;
        return changed.length === 0;
      });
      const ids = yield* readNativeReferences(listSessions);
      if (!(yield* unchanged)) return counts;
      const root = "codex-home-overlays";
      let historicalReferencesRead = false;
      const entries = yield* Effect.tryPromise(async () => {
        if (!(await inspectOwnedPath(baseDir, root))?.at(-1)?.stat.isDirectory()) return [];
        return fs.readdir(path.join(baseDir, root), { withFileTypes: true });
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(entry.name)) continue;
        const home = path.join(root, entry.name);
        const sessions = path.join(home, "sessions");
        // Native children can be absent from projections. Preserve their whole
        // overlay whenever any parent/child rollout still has a surviving reference.
        let protectedHome = false;
        let hasOldRollout = false;
        const walk = (
          directory: string,
          consume: (file: string) => Effect.Effect<void, unknown, SqlClient.SqlClient>,
        ) =>
          Effect.acquireUseRelease(
            Effect.sync(() => walkOwnedSessions(baseDir, directory)),
            (iterator) =>
              Effect.gen(function* () {
                let visited = 0;
                while (true) {
                  const next = yield* Effect.tryPromise(() => iterator.next());
                  if (next.done) break;
                  yield* consume(next.value);
                  if (++visited % ORPHAN_BATCH_SIZE === 0) yield* Effect.sleep(10);
                }
              }),
            (iterator) => Effect.promise(() => iterator.return(undefined)),
          );
        const inspectReferences = (file: string) =>
          Effect.sync(() => {
            const id = rolloutNativeId(file);
            if (id && ids.has(id)) protectedHome = true;
          });
        for (const directory of [sessions, path.join(home, "archived_sessions")]) {
          yield* walk(directory, (file) =>
            Effect.gen(function* () {
              yield* inspectReferences(file);
              if (directory !== sessions || !/\.jsonl$/iu.test(file) || !rolloutNativeId(file))
                return;
              const leaf = (yield* Effect.tryPromise(() => inspectOwnedPath(baseDir, file)))?.at(
                -1,
              );
              if (leaf?.stat.isFile()) {
                counts.scanned++;
                if (leaf.stat.mtimeMs < cutoff) hasOldRollout = true;
              }
            }),
          );
        }
        if (!protectedHome && hasOldRollout && !historicalReferencesRead) {
          if (
            !(yield* readHistoricalNativeReferences(
              ids,
              runtimeSequence!,
              activityCursor!,
              unchanged,
            ))
          )
            return counts;
          historicalReferencesRead = true;
          if (!(yield* unchanged)) return counts;
          for (const directory of [sessions, path.join(home, "archived_sessions")]) {
            yield* walk(directory, inspectReferences);
          }
        }
        if (protectedHome) {
          counts.preservedOverlays++;
          continue;
        }
        if (!hasOldRollout) continue;
        let deferred = false;
        yield* walk(sessions, (file) =>
          Effect.gen(function* () {
            if (deferred) return;
            const id = rolloutNativeId(file);
            if (!id || !/\.jsonl$/iu.test(file)) return;
            const leaf = (yield* Effect.tryPromise(() => inspectOwnedPath(baseDir, file)))?.at(-1);
            if (!leaf?.stat.isFile()) return;
            if (leaf.stat.mtimeMs >= cutoff || ids.has(id)) return;
            if (!(yield* unchanged)) {
              deferred = true;
              return;
            }
            // Re-read the small complete binding set after each asynchronous activity
            // probe, rather than trusting a snapshot taken before a provider restart.
            const idle = yield* Effect.tryPromise((signal) =>
              isCodexOverlayIdle(path.join(baseDir, home), signal),
            );
            if (!idle) {
              deferred = true;
              counts.preservedOverlays++;
              return;
            }
            const currentIds = yield* readNativeReferences(listSessions);
            if ([...currentIds].some((current) => !ids.has(current)) || !(yield* unchanged)) {
              deferred = true;
              return;
            }
            if (currentIds.has(id)) return;
            if (yield* Effect.tryPromise(() => unlinkOwnedFile(baseDir, file, cutoff, leaf.stat))) {
              counts.reclaimedFiles++;
              counts.reclaimedBytes += leaf.stat.size;
            }
          }),
        );
        if (deferred && !(yield* unchanged)) break;
      }
      return counts;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => Effect.logInfo("Codex orphan rollout retention", counts)),
      ),
    );
  });
