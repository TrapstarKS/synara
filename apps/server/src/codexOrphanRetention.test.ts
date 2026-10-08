import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import {
  EventId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@synara/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORPHAN_CODEX_ROLLOUT_RETENTION_MS,
  pruneOrphanedCodexRollouts,
} from "./codexArtifactRetention";
import { ServerConfig, type ServerConfigShape } from "./config";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { PROVIDER_RUNTIME_INGESTION_CONSUMER } from "./persistence/Services/ProviderRuntimeEvents";
import { isCodexOverlayIdle } from "./platform/codexOverlayActivity";
import type { ProviderServiceShape } from "./provider/Services/ProviderService";

vi.mock("./platform/codexOverlayActivity", () => ({ isCodexOverlayIdle: vi.fn() }));

const nativeId = "01a09c5e-7435-7253-9234-186ac7f3d5e4";
const childId = "5ae646ed-62ad-4e45-965a-d11cd459a853";
const profileId = "8de6c075-eab9-4a10-aa8b-d31004113c0b";
const now = new Date("2026-10-08T12:00:00.000Z");
const cutoff = new Date(now.getTime() - ORPHAN_CODEX_ROLLOUT_RETENTION_MS);
const old = new Date(cutoff.getTime() - 60_000);
const temporaryHomes: string[] = [];
const idle = vi.mocked(isCodexOverlayIdle);
const noSessions: ProviderServiceShape["listSessions"] = () => Effect.succeed([]);

beforeEach(() => {
  idle.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const home of temporaryHomes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});

async function writeFile(
  file: string,
  content: string | Uint8Array = "retained data",
  modified = old,
): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  await fs.utimes(file, modified, modified);
  return file;
}

function rolloutPath(home: string, id: string, directory = "sessions"): string {
  return path.join(home, directory, "2026", "08", "01", `rollout-2026-08-01T10-00-00-${id}.jsonl`);
}

async function fixture() {
  const userHome = await fs.mkdtemp(path.join(os.tmpdir(), "synara-codex-orphan-retention-"));
  temporaryHomes.push(userHome);
  const baseDir = path.join(userHome, ".synara");
  const stateDir = path.join(baseDir, "userdata");
  await fs.mkdir(stateDir, { recursive: true });
  const overlay = path.join(baseDir, "codex-home-overlays", profileId);
  const rollout = await writeFile(rolloutPath(overlay, nativeId));
  const addAbandoned = async () => {
    const home = path.join(baseDir, "codex-home-overlays", randomUUID());
    const file = await writeFile(rolloutPath(home, randomUUID()));
    return { home, file };
  };
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | ServerConfig>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(ServerConfig, { baseDir, stateDir } as ServerConfigShape),
        Effect.provide(SqlitePersistenceMemory),
      ),
    );
  return { userHome, baseDir, stateDir, overlay, rollout, addAbandoned, run };
}

const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return false;
      throw cause;
    },
  );

function activeSession(cursor: unknown): ProviderSession {
  return {
    provider: "codex",
    threadId: ThreadId.makeUnsafe("active"),
    status: "ready",
    runtimeMode: "full-access",
    createdAt: old.toISOString(),
    updatedAt: old.toISOString(),
    resumeCursor: cursor,
  };
}

const insertRuntime = (
  thread: string,
  cursor: string | null = JSON.stringify({ threadId: nativeId }),
  payload: string | null = null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, runtime_mode,
        status, lifecycle_generation, last_seen_at, resume_cursor_json, runtime_payload_json)
      VALUES (${thread}, 'codex', 'codex', 'full-access', 'stopped', 'g', ${old.toISOString()}, ${cursor}, ${payload})
    `;
  });

const insertThread = (thread: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, env_mode, created_at, updated_at)
      VALUES (${thread}, 'project', 'Retained', '{"provider":"codex","model":"gpt-6.1-sol"}',
        'full-access', 'default', 'local', ${old.toISOString()}, ${old.toISOString()})
    `;
  });

function historyEvent(eventId: string, item?: Record<string, unknown>): ProviderRuntimeEvent {
  const base = {
    eventId: EventId.makeUnsafe(eventId),
    provider: "codex" as const,
    threadId: ThreadId.makeUnsafe("logical-parent"),
    createdAt: old.toISOString(),
  };
  return item
    ? {
        ...base,
        type: "item.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          data: { item },
        },
      }
    : {
        ...base,
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "Accepted native history" },
      };
}

const acknowledgeRuntimeHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE provider_runtime_event_consumers
    SET last_acked_sequence = (SELECT COALESCE(MAX(sequence), 0) FROM provider_runtime_events)
    WHERE consumer_name = ${PROVIDER_RUNTIME_INGESTION_CONSUMER}
  `;
});

const insertHistoryEvent = (event: ProviderRuntimeEvent, accepted = true) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO provider_runtime_events (event_id, thread_id, event_type, event_json, persisted_at)
      VALUES (${event.eventId}, ${event.threadId}, ${event.type}, ${JSON.stringify(event)}, ${old.toISOString()})
    `;
    if (accepted) yield* acknowledgeRuntimeHistory;
  });

const insertActivity = (activityId: string, payload: string, kind = "tool.completed") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES (${activityId}, 'logical-parent', 'info', ${kind}, 'Native collaboration',
        ${payload}, ${old.toISOString()})
    `;
  });

const insertCollabActivity = (activityId: string, item: Record<string, unknown>) =>
  insertActivity(
    activityId,
    JSON.stringify({ itemType: "collab_agent_tool_call", status: "completed", data: { item } }),
  );

describe("orphaned Codex rollout retention", () => {
  it("reclaims old regular rollouts, reports bytes, and keeps recent and exact-cutoff files", async () => {
    const f = await fixture();
    const content = "orphan transcript ∎";
    await fs.writeFile(f.rollout, content);
    await fs.utimes(f.rollout, old, old);
    const second = await writeFile(rolloutPath(f.overlay, childId), "second");
    const recent = await writeFile(rolloutPath(f.overlay, randomUUID()), "recent", now);
    const boundary = await writeFile(rolloutPath(f.overlay, randomUUID()), "boundary", cutoff);
    const unknown = await writeFile(
      path.join(path.dirname(f.rollout), `notes-${randomUUID()}.jsonl`),
    );
    const metadata = [
      await writeFile(path.join(f.overlay, "session_index.jsonl"), "session metadata"),
      await writeFile(path.join(f.overlay, "thread_history_1.sqlite"), "history database"),
    ];

    const result = await f.run(pruneOrphanedCodexRollouts(noSessions, now));

    expect(result).toEqual({
      scanned: 4,
      reclaimedFiles: 2,
      reclaimedBytes: Buffer.byteLength(content) + Buffer.byteLength("second"),
      preservedOverlays: 0,
    });
    expect(await exists(f.rollout)).toBe(false);
    expect(await exists(second)).toBe(false);
    for (const file of [recent, boundary, unknown, ...metadata])
      expect(await exists(file)).toBe(true);
    expect(await fs.readFile(metadata[0]!, "utf8")).toBe("session metadata");
    expect(await fs.readFile(metadata[1]!, "utf8")).toBe("history database");
    expect(idle.mock.calls.every(([home]) => home === f.overlay)).toBe(true);
  });

  it.each([
    "runtime",
    "archived",
    "soft-deleted",
    "subagent",
    "logical-subagent",
    "legacy",
    "runtime-payload",
    "handoff",
    "model-selection",
    "active-cursor",
  ])("preserves parent and orphan child rollouts with a %s reference", async (kind) => {
    const f = await fixture();
    const child = await writeFile(rolloutPath(f.overlay, childId));
    const abandoned = await f.addAbandoned();
    const sessions: ProviderServiceShape["listSessions"] = () =>
      Effect.succeed(kind === "active-cursor" ? [activeSession({ threadId: nativeId })] : []);
    const result = await f.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (kind === "runtime") yield* insertRuntime("dangling-runtime");
        else if (kind === "runtime-payload") {
          yield* insertRuntime("payload", null, JSON.stringify({ nativeThreadId: nativeId }));
        } else if (kind === "legacy") {
          yield* sql`
            INSERT INTO projection_thread_sessions (thread_id, status, provider_name, provider_thread_id, updated_at)
            VALUES ('legacy', 'closed', 'codex', ${nativeId}, ${old.toISOString()})
          `;
        } else if (kind === "logical-subagent") {
          yield* insertThread(`subagent:parent:${nativeId}`);
        } else if (kind !== "active-cursor") {
          yield* insertThread(kind);
          if (kind === "subagent") {
            yield* sql`UPDATE projection_threads SET subagent_agent_id = ${nativeId}`;
          } else if (kind === "model-selection") {
            yield* sql`UPDATE projection_threads SET model_selection_json = ${JSON.stringify({ provider: "codex", resumeCursor: { threadId: nativeId } })}`;
          } else {
            yield* sql`UPDATE projection_threads SET handoff_json = ${JSON.stringify({ sourceThreadId: nativeId })}`;
            if (kind === "archived")
              yield* sql`UPDATE projection_threads SET archived_at = ${old.toISOString()}`;
            if (kind === "soft-deleted")
              yield* sql`UPDATE projection_threads SET deleted_at = ${old.toISOString()}`;
          }
        }
        return yield* pruneOrphanedCodexRollouts(sessions, now);
      }),
    );

    expect(result).toMatchObject({ reclaimedFiles: 1, preservedOverlays: 1 });
    expect(await exists(f.rollout)).toBe(true);
    expect(await exists(child)).toBe(true);
    expect(await exists(abandoned.file)).toBe(false);
    expect(idle.mock.calls.every(([home]) => home === abandoned.home)).toBe(true);
  });

  it.each(["plain", "gzip"])(
    "preserves an orphan child when its %s parent is in archived_sessions",
    async (format) => {
      const f = await fixture();
      const archived = `${rolloutPath(f.overlay, nativeId, "archived_sessions")}${format === "gzip" ? ".gz" : ""}`;
      if (format === "gzip") {
        await writeFile(archived, gzipSync("compressed parent rollout"));
        await fs.unlink(f.rollout);
      } else {
        await fs.mkdir(path.dirname(archived), { recursive: true });
        await fs.rename(f.rollout, archived);
      }
      const child = await writeFile(rolloutPath(f.overlay, childId));
      const abandoned = await f.addAbandoned();
      const result = await f.run(
        insertRuntime("archived-parent").pipe(
          Effect.andThen(pruneOrphanedCodexRollouts(noSessions, now)),
        ),
      );

      expect(result).toMatchObject({ reclaimedFiles: 1, preservedOverlays: 1 });
      expect(await exists(archived)).toBe(true);
      expect(await exists(child)).toBe(true);
      expect(await exists(abandoned.file)).toBe(false);
    },
  );

  it.each([
    "provider-thread",
    "provider-parent",
    "collab-receivers",
    "collab-agents",
    "collab-sender",
    "collab-parent",
  ])("protects an overlay referenced only by accepted native history: %s", async (reference) => {
    const f = await fixture();
    const child = await writeFile(rolloutPath(f.overlay, childId));
    const abandoned = await f.addAbandoned();
    const event =
      reference === "collab-receivers"
        ? historyEvent("history", { receiverThreadIds: [nativeId] })
        : reference === "collab-agents"
          ? historyEvent("history", { agents: [{ threadId: nativeId }] })
          : reference === "collab-sender"
            ? historyEvent("history", { senderThreadId: nativeId })
            : reference === "collab-parent"
              ? historyEvent("history", { parentThreadId: nativeId })
              : {
                  ...historyEvent("history"),
                  providerRefs:
                    reference === "provider-thread"
                      ? { providerThreadId: nativeId }
                      : { providerParentThreadId: nativeId },
                };
    const result = await f.run(
      insertHistoryEvent(event).pipe(Effect.andThen(pruneOrphanedCodexRollouts(noSessions, now))),
    );

    expect(result).toMatchObject({ reclaimedFiles: 1, preservedOverlays: 1 });
    expect(await exists(f.rollout)).toBe(true);
    expect(await exists(child)).toBe(true);
    expect(await exists(abandoned.file)).toBe(false);
    expect(idle.mock.calls.every(([home]) => home === abandoned.home)).toBe(true);
  });

  it.each(["canonical", "reordered", "escaped", "camel"])(
    "protects a native child in %s projected collaboration JSON",
    async (format) => {
      const f = await fixture();
      const abandoned = await f.addAbandoned();
      const payload = JSON.stringify({
        ...(format === "reordered" ? { title: "x".repeat(300) } : {}),
        itemType: format === "camel" ? "collabAgentToolCall" : "collab_agent_tool_call",
        status: "completed",
        data: { item: { receiverThreadIds: [nativeId] } },
      });
      const serialized = format === "escaped" ? payload.replaceAll("_", "\\u005f") : payload;
      const result = await f.run(
        insertActivity("native-child", serialized).pipe(
          Effect.andThen(pruneOrphanedCodexRollouts(noSessions, now)),
        ),
      );

      expect(result).toMatchObject({ reclaimedFiles: 1, preservedOverlays: 1 });
      expect(await exists(f.rollout)).toBe(true);
      expect(await exists(abandoned.file)).toBe(false);
    },
  );

  it.each(["invalid", "oversized"])(
    "fails closed across overlays for %s projected tool activity",
    async (kind) => {
      const f = await fixture();
      const abandoned = await f.addAbandoned();
      const payload =
        kind === "invalid"
          ? "{"
          : JSON.stringify({
              itemType: "collab_agent_tool_call",
              data: { item: { receiverThreadIds: [nativeId], output: "x".repeat(64 * 1024) } },
            });

      await expect(
        f.run(
          // Migration 133's JSON expression index rejects invalid tool.* payloads,
          // so seed the invalid case on an unindexed kind the sweep also reads.
          insertActivity(
            "unreadable-native-tool",
            payload,
            kind === "invalid" ? "subagent.updated" : "tool.completed",
          ).pipe(Effect.andThen(pruneOrphanedCodexRollouts(noSessions, now))),
        ),
      ).rejects.toThrow(/native collaboration reference/iu);

      expect(await exists(f.rollout)).toBe(true);
      expect(await exists(abandoned.file)).toBe(true);
      expect(idle).not.toHaveBeenCalled();
    },
  );

  it("reads the final native collaboration reference after a full activity page", async () => {
    const f = await fixture();
    const abandoned = await f.addAbandoned();
    const result = await f.run(
      Effect.gen(function* () {
        for (let index = 0; index <= 100; index++) {
          yield* insertCollabActivity(`activity-${`${index}`.padStart(3, "0")}`, {
            receiverThreadIds: index === 100 ? [nativeId] : [],
          });
        }
        return yield* pruneOrphanedCodexRollouts(noSessions, now);
      }),
    );

    expect(result).toMatchObject({ reclaimedFiles: 1, preservedOverlays: 1 });
    expect(await exists(f.rollout)).toBe(true);
    expect(await exists(abandoned.file)).toBe(false);
  });

  it.each(["old", "recent"])(
    "reads malformed native history only when %s rollout candidates require it",
    async (age) => {
      const f = await fixture();
      const abandoned = await f.addAbandoned();
      if (age === "recent") {
        await fs.utimes(f.rollout, now, now);
        await fs.utimes(abandoned.file, now, now);
      }
      const sweep = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        INSERT INTO provider_runtime_events (event_id, thread_id, event_type, event_json, persisted_at)
        VALUES ('malformed', 'logical-parent', 'item.completed', '{', ${old.toISOString()})
      `;
        yield* acknowledgeRuntimeHistory;
        return yield* pruneOrphanedCodexRollouts(noSessions, now);
      });

      if (age === "old") await expect(f.run(sweep)).rejects.toThrow();
      else expect(await f.run(sweep)).toMatchObject({ reclaimedFiles: 0, reclaimedBytes: 0 });

      expect(await exists(f.rollout)).toBe(true);
      expect(await exists(abandoned.file)).toBe(true);
      expect(idle).not.toHaveBeenCalled();
    },
  );

  it("defers deletion until the runtime ingestion consumer catches up", async () => {
    const f = await fixture();
    const result = await f.run(
      insertHistoryEvent(historyEvent("pending"), false).pipe(
        Effect.andThen(pruneOrphanedCodexRollouts(noSessions, now)),
      ),
    );

    expect(result).toMatchObject({ scanned: 0, reclaimedFiles: 0, reclaimedBytes: 0 });
    expect(await exists(f.rollout)).toBe(true);
    expect(idle).not.toHaveBeenCalled();
  });

  it("does not unlink when accepted runtime history advances during the activity probe", async () => {
    const f = await fixture();
    const result = await f.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        idle.mockImplementationOnce(async () => {
          await Effect.runPromise(
            insertHistoryEvent(historyEvent("new-history")).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          );
          return true;
        });
        return yield* pruneOrphanedCodexRollouts(noSessions, now);
      }),
    );

    expect(result).toMatchObject({ reclaimedFiles: 0, reclaimedBytes: 0 });
    expect(await exists(f.rollout)).toBe(true);
  });

  it("protects native references encoded with JSON unicode escapes", async () => {
    const f = await fixture();
    const abandoned = await f.addAbandoned();
    const cursor = `{"threadId":"${nativeId.replaceAll("-", "\\u002d")}"}`;
    const result = await f.run(
      insertRuntime("escaped-cursor", cursor).pipe(
        Effect.andThen(pruneOrphanedCodexRollouts(noSessions, now)),
      ),
    );

    expect(result).toMatchObject({ reclaimedFiles: 1, preservedOverlays: 1 });
    expect(await exists(f.rollout)).toBe(true);
    expect(await exists(abandoned.file)).toBe(false);
  });

  it("defers deletion while a projection is behind the journal revision", async () => {
    const f = await fixture();
    const result = await f.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
            event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES ('unprojected', 'thread', 'unprojected', 1, 'thread.updated', ${now.toISOString()}, 'system', '{}', '{}')
        `;
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES ('lagging', 0, ${old.toISOString()})
        `;
        return yield* pruneOrphanedCodexRollouts(noSessions, now);
      }),
    );

    expect(result).toMatchObject({ scanned: 0, reclaimedFiles: 0, reclaimedBytes: 0 });
    expect(await exists(f.rollout)).toBe(true);
    expect(idle).not.toHaveBeenCalled();
  });

  it("does not treat credential profile selection as a reference to an unrelated rollout", async () => {
    const f = await fixture();
    const result = await f.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertThread("credential-preference");
        yield* sql`UPDATE projection_threads SET model_selection_json = ${JSON.stringify({ provider: "codex", profileId })}`;
        return yield* pruneOrphanedCodexRollouts(noSessions, now);
      }),
    );

    expect(result.reclaimedFiles).toBe(1);
    expect(await exists(f.rollout)).toBe(false);
  });

  it.each([undefined, {}, { threadId: 123 }, { threadId: "unreadable" }])(
    "defers the entire sweep for an unidentified active Codex cursor: %j",
    async (cursor) => {
      const f = await fixture();
      const abandoned = await f.addAbandoned();
      const sessions: ProviderServiceShape["listSessions"] = () =>
        Effect.succeed([activeSession(cursor)]);

      await expect(f.run(pruneOrphanedCodexRollouts(sessions, now))).rejects.toThrow(
        "active Codex session",
      );

      expect(await exists(f.rollout)).toBe(true);
      expect(await exists(abandoned.file)).toBe(true);
      expect(idle).not.toHaveBeenCalled();
    },
  );

  it.each(["cursor", "payload", "handoff", "selection", "oversized"])(
    "fails closed before deleting any overlay for an invalid %s record",
    async (kind) => {
      const f = await fixture();
      const abandoned = await f.addAbandoned();
      const sweep = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (kind === "cursor") yield* insertRuntime("broken", "{");
        else if (kind === "payload") yield* insertRuntime("broken", null, "{");
        else if (kind === "oversized") {
          yield* insertRuntime("broken", JSON.stringify({ padding: "x".repeat(64 * 1024) }));
        } else {
          yield* insertThread("broken");
          if (kind === "handoff") yield* sql`UPDATE projection_threads SET handoff_json = '{'`;
          else yield* sql`UPDATE projection_threads SET model_selection_json = '{'`;
        }
        return yield* pruneOrphanedCodexRollouts(noSessions, now);
      });

      await expect(f.run(sweep)).rejects.toThrow();

      expect(await exists(f.rollout)).toBe(true);
      expect(await exists(abandoned.file)).toBe(true);
      expect(idle).not.toHaveBeenCalled();
    },
  );

  it("fails closed when querying the complete reference set fails", async () => {
    const f = await fixture();
    const abandoned = await f.addAbandoned();
    await expect(
      f.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TABLE projection_thread_sessions`;
          return yield* pruneOrphanedCodexRollouts(noSessions, now);
        }),
      ),
    ).rejects.toThrow();

    expect(await exists(f.rollout)).toBe(true);
    expect(await exists(abandoned.file)).toBe(true);
    expect(idle).not.toHaveBeenCalled();
  });

  it("keeps the entire overlay when its activity probe cannot prove idle", async () => {
    const f = await fixture();
    const child = await writeFile(rolloutPath(f.overlay, childId));
    idle.mockResolvedValue(false);

    const result = await f.run(pruneOrphanedCodexRollouts(noSessions, now));

    expect(result).toMatchObject({ reclaimedFiles: 0, reclaimedBytes: 0, preservedOverlays: 1 });
    expect(await exists(f.rollout)).toBe(true);
    expect(await exists(child)).toBe(true);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it.each(["binding", "active-cursor", "revision"])(
    "does not unlink after a new %s appears during the activity probe",
    async (kind) => {
      const f = await fixture();
      let currentSessions: ReadonlyArray<ProviderSession> = [];
      const sessions: ProviderServiceShape["listSessions"] = () => Effect.succeed(currentSessions);
      const result = await f.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          idle.mockImplementationOnce(async () => {
            if (kind === "active-cursor") currentSessions = [activeSession({ threadId: childId })];
            else if (kind === "binding") {
              await Effect.runPromise(
                insertRuntime("new-binding", JSON.stringify({ threadId: childId })).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                ),
              );
            } else {
              await Effect.runPromise(sql`
                INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
                  event_type, occurred_at, actor_kind, payload_json, metadata_json)
                VALUES ('new', 'thread', 'new', 1, 'thread.updated', ${now.toISOString()}, 'system', '{}', '{}')
              `);
            }
            return true;
          });
          return yield* pruneOrphanedCodexRollouts(sessions, now);
        }),
      );

      expect(result).toMatchObject({ reclaimedFiles: 0, reclaimedBytes: 0 });
      expect(await exists(f.rollout)).toBe(true);
    },
  );

  it.each(["recent-write", "old-replacement", "old-append"])(
    "does not unlink a rollout changed during the activity probe: %s",
    async (kind) => {
      const f = await fixture();
      idle.mockImplementationOnce(async () => {
        if (kind === "old-replacement") {
          const replacement = await writeFile(`${f.rollout}.replacement`, "new replacement");
          await fs.rename(replacement, f.rollout);
        } else {
          await fs.appendFile(f.rollout, "\nnew data");
          await fs.utimes(
            f.rollout,
            kind === "old-append" ? old : now,
            kind === "old-append" ? old : now,
          );
        }
        return true;
      });

      const result = await f.run(pruneOrphanedCodexRollouts(noSessions, now));

      expect(result).toMatchObject({ reclaimedFiles: 0, reclaimedBytes: 0 });
      expect(await exists(f.rollout)).toBe(true);
      expect(await fs.readFile(f.rollout, "utf8")).toContain("new");
    },
  );

  it("reads beyond a full 100-row page before deciding an overlay is unreferenced", async () => {
    const f = await fixture();
    const abandoned = await f.addAbandoned();
    const result = await f.run(
      Effect.gen(function* () {
        for (let index = 0; index <= 100; index++) {
          yield* insertRuntime(
            `reference-${`${index}`.padStart(3, "0")}`,
            JSON.stringify({ threadId: index === 100 ? nativeId : randomUUID() }),
          );
        }
        return yield* pruneOrphanedCodexRollouts(noSessions, now);
      }),
    );

    expect(result).toMatchObject({ reclaimedFiles: 1, preservedOverlays: 1 });
    expect(await exists(f.rollout)).toBe(true);
    expect(await exists(abandoned.file)).toBe(false);
  });

  it
    .skipIf(process.platform === "win32")
    .each(["root", "overlay", "sessions", "year", "month", "file"])(
    "never follows a %s symlink into a CLI or another channel home",
    async (component) => {
      const f = await fixture();
      const cliHome = path.join(f.userHome, ".codex");
      const betaHome = path.join(f.userHome, ".synara-beta", "codex-home-overlays", profileId);
      const cliRollout = await writeFile(rolloutPath(cliHome, nativeId), "CLI data");
      const betaRollout = await writeFile(rolloutPath(betaHome, nativeId), "Beta data");
      const locations = {
        root: [path.join(f.baseDir, "codex-home-overlays"), path.dirname(betaHome)],
        overlay: [f.overlay, betaHome],
        sessions: [path.join(f.overlay, "sessions"), path.join(cliHome, "sessions")],
        year: [path.join(f.overlay, "sessions", "2026"), path.join(cliHome, "sessions", "2026")],
        month: [
          path.join(f.overlay, "sessions", "2026", "08"),
          path.join(cliHome, "sessions", "2026", "08"),
        ],
        file: [f.rollout, cliRollout],
      } as const;
      const [link, target] = locations[component as keyof typeof locations];
      await fs.rm(link, { recursive: true });
      await fs.symlink(target, link, component === "file" ? "file" : "dir");

      const result = await f.run(pruneOrphanedCodexRollouts(noSessions, now));

      expect(result.reclaimedFiles).toBe(0);
      expect(await fs.readFile(cliRollout, "utf8")).toBe("CLI data");
      expect(await fs.readFile(betaRollout, "utf8")).toBe("Beta data");
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    },
  );

  it("does not scan CLI, Beta, singular legacy, account, or non-UUID overlay roots", async () => {
    const f = await fixture();
    const otherHomes = [
      path.join(f.userHome, ".codex"),
      path.join(f.userHome, ".synara-beta", "codex-home-overlays", profileId),
      path.join(f.baseDir, "codex-home-overlay"),
      path.join(f.baseDir, "codex-home-overlay", "accounts", "legacy-account"),
      path.join(f.baseDir, "codex-home-overlays", "unknown-profile"),
    ];
    const preserved = await Promise.all(
      otherHomes.map((home) => writeFile(rolloutPath(home, nativeId), "outside scope")),
    );

    const result = await f.run(pruneOrphanedCodexRollouts(noSessions, now));

    expect(result.reclaimedFiles).toBe(1);
    expect(await exists(f.rollout)).toBe(false);
    for (const file of preserved) expect(await fs.readFile(file, "utf8")).toBe("outside scope");
  });
});
