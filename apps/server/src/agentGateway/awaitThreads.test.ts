import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@synara/contracts";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { THREAD_AWAIT_DEFERRED } from "../orchestration/threadAwaitGuard.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProviderRuntimeEventRepositoryLive } from "../persistence/Layers/ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import {
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../persistence/Services/ProviderRuntimeEvents.ts";
import { makeAwaitRepository } from "./awaitRepository.ts";
import { makeAwaitThreads } from "./awaitThreads.ts";
import { makeCompletionRepository } from "./completionRepository.ts";
import type { ToolContext } from "./toolRuntime.ts";

const now = "2026-09-30T22:00:00.000Z";
const layer = it.layer(
  Layer.mergeAll(ProjectionTurnRepositoryLive, ProviderRuntimeEventRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const harness = (prefix: string, childCount = 1) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectionTurns = yield* ProjectionTurnRepository;
    const runtime = yield* ProviderRuntimeEventRepository;
    const repository = yield* makeAwaitRepository;
    const completionRepository = yield* makeCompletionRepository;
    const caller = ThreadId.makeUnsafe(`${prefix}:caller`);
    const children = Array.from({ length: childCount }, (_, index) =>
      ThreadId.makeUnsafe(`${prefix}:child:${index}`),
    );
    const threads = new Map<string, OrchestrationThread>();
    const run = (id: string) => TurnId.makeUnsafe(`${id}:run`);
    for (const id of [caller, ...children]) {
      yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, latest_turn_id, created_at, updated_at)
      VALUES (${id}, 'project', ${id}, ${JSON.stringify({ provider: "codex", model: "test-model" })}, 'approval-required', 'default', ${run(id)}, ${now}, ${now})`;
      yield* sql`INSERT INTO projection_thread_sessions
      (thread_id, status, provider_name, runtime_mode, active_turn_id, updated_at)
      VALUES (${id}, 'running', 'codex', 'approval-required', ${run(id)}, ${now})`;
      yield* projectionTurns.upsertByTurnId({
        threadId: id,
        turnId: run(id),
        pendingMessageId: MessageId.makeUnsafe(`${id}:request`),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
      threads.set(id, {
        id,
        modelSelection: { provider: "codex", model: "test-model" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        parentThreadId: null,
        sidechatSourceThreadId: null,
        archivedAt: null,
        session: null,
        messages: [],
        latestTurn: {
          turnId: run(id),
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        },
      } as unknown as OrchestrationThread);
    }
    const dispatched: OrchestrationCommand[] = [];
    let behavior: "normal" | "transient" | "lost-ack" = "normal";
    const engine = {
      getReadModel: () => Effect.sync(() => ({ threads: [...threads.values()] })),
      getEventHighWaterSequence: sql<{
        sequence: number;
      }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`.pipe(
        Effect.map((rows) => rows[0]!.sequence),
      ),
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          dispatched.push(command);
          if (command.type !== "thread.turn.start") return { sequence: 0 };
          if (behavior === "transient") {
            behavior = "normal";
            return yield* Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: `${THREAD_AWAIT_DEFERRED} An approval arrived before admission.`,
              }),
            );
          }
          yield* sql`INSERT OR IGNORE INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)
        VALUES (${command.commandId}, 'thread', ${command.threadId}, ${command.createdAt}, 1, 'accepted', NULL)`;
          if (behavior === "lost-ack") {
            behavior = "normal";
            return yield* Effect.fail(new Error("lost acknowledgement"));
          }
          return { sequence: 1 };
        }),
    } as unknown as OrchestrationEngineShape;
    const snapshotQuery = {
      getThreadShellById: (id: ThreadId) =>
        Effect.sync(() => Option.fromNullishOr(threads.get(id))),
      getThreadDetailById: (id: ThreadId) =>
        Effect.sync(() => Option.fromNullishOr(threads.get(id))),
    } as unknown as ProjectionSnapshotQueryShape;
    const dependencies = {
      snapshotQuery,
      projectionTurns,
      completionRepository,
      orchestrationEngine: engine,
    };
    const service = yield* makeAwaitThreads(dependencies);
    const context: ToolContext = {
      principal: {
        kind: "provider-session",
        threadId: caller,
        turnId: run(caller),
        provider: "codex",
        sessionKey: prefix,
      },
      callerThreadId: caller,
      callerThreadLabel: null,
      callerSessionKey: prefix,
      callerProvider: "codex",
      callerCapabilities: new Set(["thread:read", "thread:write"]),
      callerTurnId: run(caller),
      assertCallerTurnActive: () => Effect.void,
      jsonRpcRequestId: 1,
    };
    const register = () => service.tool.handler({ threadIds: children }, context);
    const finish = (
      id: ThreadId,
      text: string,
      state: "completed" | "error" = "completed",
      acknowledge = true,
    ) =>
      Effect.gen(function* () {
        const turn = Option.getOrThrow(
          yield* projectionTurns.getByTurnId({ threadId: id, turnId: run(id) }),
        );
        yield* projectionTurns.upsertByTurnId({ ...turn, state, completedAt: now });
        yield* sql`UPDATE projection_thread_sessions SET status = 'ready', active_turn_id = NULL WHERE thread_id = ${id}`;
        const thread = threads.get(id)!;
        threads.set(id, {
          ...thread,
          latestTurn: { ...thread.latestTurn!, state, completedAt: now },
          messages: [
            {
              id: MessageId.makeUnsafe(`${id}:answer`),
              role: "assistant",
              text,
              turnId: run(id),
              streaming: false,
              source: "native",
              createdAt: now,
              updatedAt: now,
            },
          ],
        });
        yield* runtime.append({
          type: "turn.completed",
          eventId: EventId.makeUnsafe(`${id}:finished`),
          provider: "codex",
          threadId: id,
          turnId: run(id),
          createdAt: now,
          payload: { state: state === "error" ? "failed" : "completed" },
        });
        if (acknowledge)
          yield* runtime.advanceConsumerCursorThrough({
            consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
            throughSequence: yield* runtime.getHighWaterSequence,
            updatedAt: now,
          });
      });
    const starts = () => dispatched.filter((command) => command.type === "thread.turn.start");
    return {
      sql,
      runtime,
      service,
      dependencies,
      repository,
      caller,
      children,
      threads,
      context,
      register,
      finish,
      starts,
      setBehavior: (value: typeof behavior) => {
        behavior = value;
      },
    };
  });

layer("await and continue", (it) => {
  it.effect(
    "polls twenty running pinned targets with one batch and no shell or transcript reads",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("running-batch", 20);
        yield* h.register();
        const reads = { shells: 0, details: 0, turns: 0, batches: 0 };
        const service = yield* makeAwaitThreads({
          ...h.dependencies,
          snapshotQuery: {
            ...h.dependencies.snapshotQuery,
            getThreadShellById: (threadId) => {
              reads.shells += 1;
              return h.dependencies.snapshotQuery.getThreadShellById(threadId);
            },
            getThreadDetailById: (threadId) => {
              reads.details += 1;
              return h.dependencies.snapshotQuery.getThreadDetailById(threadId);
            },
          },
          projectionTurns: {
            ...h.dependencies.projectionTurns,
            getByTurnId: (input) => {
              reads.turns += 1;
              return h.dependencies.projectionTurns.getByTurnId(input);
            },
            getManyWaitSnapshot: (input) => {
              reads.batches += 1;
              return h.dependencies.projectionTurns.getManyWaitSnapshot(input);
            },
          },
        });
        yield* service.deliverPending();
        expect(reads).toEqual({ shells: 0, details: 0, turns: 0, batches: 1 });
        expect(h.starts()).toHaveLength(0);
        yield* h.finish(h.caller, "waiting");
        for (const child of h.children) yield* h.finish(child, "done");
        yield* service.deliverPending();
        expect(h.starts()).toHaveLength(1);
        expect(h.starts()[0]!.message.text).toContain("done");
        expect(reads.details).toBe(20);
        yield* service.deliverPending();
        expect(h.starts()).toHaveLength(1);
      }),
  );

  it.effect("keeps deleted, missing-run, and message-only targets on the full result path", () =>
    Effect.gen(function* () {
      const h = yield* harness("batch-fallbacks", 3);
      yield* h.register();
      const row = (yield* h.repository.getByScope(h.caller, h.context.callerTurnId!))!;
      const targets = JSON.parse(row.targetsJson) as Array<{ pin: { runId: string | null } }>;
      targets[2]!.pin.runId = null;
      yield* h.repository.saveTargets(row.waitId, row.targetsJson, JSON.stringify(targets));
      h.threads.delete(h.children[0]!);
      yield* h.sql`UPDATE projection_threads SET deleted_at = ${now} WHERE thread_id = ${h.children[0]!}`;
      yield* h.sql`DELETE FROM projection_turns WHERE thread_id = ${h.children[1]!}`;
      yield* h.service.deliverPending();
      const saved = JSON.parse((yield* h.repository.getById(row.waitId))!.targetsJson);
      expect(saved[0].result.error).toContain("deleted");
      expect(saved[1].result.error).toContain("no longer available");
      expect(saved[2].result).toBeNull();
      expect(h.starts()).toHaveLength(0);
      yield* h.finish(h.caller, "waiting");
      yield* h.finish(h.children[2]!, "message-pinned result");
      yield* h.service.deliverPending();
      expect(h.starts()).toHaveLength(1);
      expect(h.starts()[0]!.message.text).toContain("message-pinned result");
    }),
  );

  it.effect("auto-notifies an orchestrator once per finished batch and joins explicit waits", () =>
    Effect.gen(function* () {
      const h = yield* harness("orchestrator", 2);
      for (const id of h.children) {
        h.threads.set(id, {
          ...h.threads.get(id)!,
          title: `Child ${id}`,
          createdAt: now,
          deletedAt: null,
          creationSource: "synara_mcp",
          sourceThreadId: h.caller,
        } as OrchestrationThread);
      }
      yield* h.service.armOrchestratorWaits();
      // An explicit wait in the same turn joins the implicit one instead of conflicting.
      expect((yield* h.register()).isError).not.toBe(true);
      yield* h.service.armOrchestratorWaits();
      yield* h.finish(h.children[0]!, "child zero done");
      yield* h.service.deliverPending();
      expect(h.starts()).toHaveLength(0); // orchestrator still busy: queued until its turn ends
      yield* h.finish(h.caller, "orchestrating");
      yield* h.service.deliverPending();
      expect(h.starts()).toHaveLength(1);
      const text = h.starts()[0]!.message.text;
      expect(text).toContain("Synara child thread update");
      expect(text).toContain(`Child ${h.children[0]}`);
      expect(text).toContain("child zero done");
      expect(text).toContain('"state":"pending"');
      yield* h.service.deliverPending();
      expect(h.starts()).toHaveLength(1);
    }),
  );

  it.effect(
    "does not resume while the caller is still working or its final output is unacknowledged",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("caller-finishing");
        yield* h.register();
        yield* h.finish(h.children[0]!, "ready before caller");
        yield* h.service.deliverPending();
        expect(h.starts()).toHaveLength(0);
        yield* h.finish(h.caller, "now waiting", "completed", false);
        yield* h.service.deliverPending();
        expect(h.starts()).toHaveLength(0);
        yield* h.runtime.advanceConsumerCursorThrough({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          throughSequence: yield* h.runtime.getHighWaterSequence,
          updatedAt: now,
        });
        yield* h.service.deliverPending();
        expect(h.starts()).toHaveLength(1);
      }),
  );

  it.effect(
    "waits for the caller and every result, freezes early results, and dispatches once",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("all-results", 2);
        const response = yield* h.register();
        expect(response.isError).not.toBe(true);
        expect(yield* h.register()).toEqual(response);
        yield* h.finish(h.children[0]!, "original result");
        yield* h.service.deliverPending();
        expect(h.starts()).toHaveLength(0);
        yield* h.finish(h.caller, "waiting");
        yield* h.service.deliverPending();
        expect(h.starts()).toHaveLength(0);
        const child = h.threads.get(h.children[0]!)!;
        h.threads.set(child.id, {
          ...child,
          messages: [{ ...child.messages[0]!, text: "later edited output" }],
        });
        yield* h.finish(h.children[1]!, "failed work", "error");
        yield* h.service.deliverPending();
        const command = h.starts()[0]!;
        expect(h.starts()).toHaveLength(1);
        expect(command.message.text).toContain("original result");
        expect(command.message.text).not.toContain("later edited output");
        expect(command.message.text).toContain('"state":"error"');
        expect(command.message.text).toContain("untrusted output");
        expect(command.threadId).toBe(h.caller);
        expect(command.dispatchOrigin).toBe("agent");
        expect(command.runtimeMode).toBe("approval-required");
        expect(command.modelSelection).toBeUndefined();
        yield* (yield* makeAwaitThreads(h.dependencies)).deliverPending();
        expect(h.starts()).toHaveLength(1);
      }),
  );

  it.effect("recovers a committed dispatch after losing its acknowledgement", () =>
    Effect.gen(function* () {
      const h = yield* harness("lost-ack");
      yield* h.register();
      yield* h.finish(h.caller, "waiting");
      yield* h.finish(h.children[0]!, "done");
      h.setBehavior("lost-ack");
      yield* h.service.deliverPending();
      expect(
        (yield* h.repository.pending()).find((row) => row.callerThreadId === h.caller)?.state,
      ).toBe("dispatching");
      yield* (yield* makeAwaitThreads(h.dependencies)).deliverPending();
      expect(h.starts()).toHaveLength(1);
      expect((yield* h.repository.getByScope(h.caller, `${h.caller}:run`))?.state).toBe(
        "dispatched",
      );
    }),
  );

  it.effect("retries a transient admission deferral with the identical frozen command", () =>
    Effect.gen(function* () {
      const h = yield* harness("defer");
      yield* h.register();
      yield* h.finish(h.caller, "waiting");
      yield* h.finish(h.children[0]!, "done");
      h.setBehavior("transient");
      yield* h.service.deliverPending();
      yield* (yield* makeAwaitThreads(h.dependencies)).deliverPending();
      expect(h.starts()).toHaveLength(2);
      expect(h.starts()[1]).toEqual(h.starts()[0]);
      expect((yield* h.repository.getByScope(h.caller, `${h.caller}:run`))?.state).toBe(
        "dispatched",
      );
    }),
  );

  for (const type of [
    "thread.turn-interrupt-requested",
    "thread.message-sent",
    "thread.archived",
  ]) {
    it.effect(`cancels the wait after ${type}`, () =>
      Effect.gen(function* () {
        const h = yield* harness(type);
        yield* h.register();
        yield* h.finish(h.caller, "waiting");
        yield* h.finish(h.children[0]!, "late result");
        yield* h.sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json)
        VALUES (${type}, 'thread', ${h.caller}, 1, ${type}, ${now}, 'human-command', 'client',
          ${JSON.stringify({ threadId: h.caller, role: "user", messageId: "new-human-message" })}, '{}')`;
        yield* h.service.deliverPending();
        expect(h.starts()).toHaveLength(0);
        expect((yield* h.repository.getByScope(h.caller, `${h.caller}:run`))?.state).toBe(
          "cancelled",
        );
      }),
    );
  }

  it.effect("rejects a recipient override, self wait, and a run from another thread", () =>
    Effect.gen(function* () {
      const h = yield* harness("invalid");
      for (const args of [
        { threadIds: h.children, callerThreadId: "other" },
        { threadIds: [h.caller] },
        { threadIds: h.children, runIds: ["foreign-run"] },
      ]) {
        expect((yield* h.service.tool.handler(args, h.context)).isError).toBe(true);
      }
      expect(yield* h.repository.getByScope(h.caller, `${h.caller}:run`)).toBeNull();
      expect(h.starts()).toHaveLength(0);
    }),
  );

  it.effect("does not expose target results to a caller without read capability", () =>
    Effect.gen(function* () {
      const h = yield* harness("write-only");
      const response = yield* h.service.tool.handler(
        { threadIds: h.children },
        {
          ...h.context,
          callerCapabilities: new Set(["thread:write"]),
        },
      );
      expect(response.isError).toBe(true);
      expect(yield* h.repository.getByScope(h.caller, `${h.caller}:run`)).toBeNull();
      expect(h.starts()).toHaveLength(0);
    }),
  );
});
