import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../serverSettings";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationCommand,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { projectProviderRuntimeActivities } from "../orchestration/providerRuntimeActivityProjection.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProviderRuntimeEventRepositoryLive } from "../persistence/Layers/ProviderRuntimeEvents.ts";
import { QueuedTurnPromotionRepositoryLive } from "../persistence/Layers/QueuedTurnPromotions.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import {
  PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../persistence/Services/ProviderRuntimeEvents.ts";
import { QueuedTurnPromotionRepository } from "../persistence/Services/QueuedTurnPromotions.ts";
import { makeCompletionRepository } from "./completionRepository.ts";
import { makePinnedThreadResultReader, makeThreadTargetPinner } from "./pinnedThreadResult.ts";

const now = "2026-09-30T20:00:00.000Z";
const later = "2026-09-30T20:01:00.000Z";
const layer = it.layer(
  Layer.mergeAll(ProjectionTurnRepositoryLive, ProviderRuntimeEventRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const makeHarness = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectionTurns = yield* ProjectionTurnRepository;
    const runtime = yield* ProviderRuntimeEventRepository;
    const repository = yield* makeCompletionRepository;
    const threadId = ThreadId.makeUnsafe(id);
    let exists = true;
    let eventIndex = 0;
    let detail = {
      id: threadId,
      latestTurn: null,
      session: null,
      messages: [],
      archivedAt: null,
    } as unknown as OrchestrationThread;
    const snapshotQuery = {
      getThreadShellById: () => Effect.sync(() => (exists ? Option.some(detail) : Option.none())),
      getThreadDetailById: () => Effect.sync(() => (exists ? Option.some(detail) : Option.none())),
    } satisfies Pick<ProjectionSnapshotQueryShape, "getThreadShellById" | "getThreadDetailById">;
    const dependencies = { snapshotQuery, projectionTurns, repository };
    const read = yield* makePinnedThreadResultReader(dependencies);
    const pin = yield* makeThreadTargetPinner(dependencies);
    const append = (
      type: string,
      payload: object,
      occurredAt = now,
      commandId: string | null = null,
      actor = "system",
    ) =>
      Effect.suspend(() => {
        const eventId = `${id}:event:${eventIndex++}`;
        return sql`
          INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
            event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json)
          VALUES (${eventId}, 'thread', ${id}, ${eventIndex}, ${type}, ${occurredAt},
            ${commandId}, ${actor}, ${JSON.stringify(payload)}, '{}')
        `;
      });
    const setTurn = (
      runId: string,
      state: "running" | "completed" | "error" | "interrupted",
      messageId = `${runId}:message`,
      requestedAt = now,
    ) =>
      Effect.gen(function* () {
        const turnId = TurnId.makeUnsafe(runId);
        const completedAt = state === "running" ? null : later;
        yield* projectionTurns.upsertByTurnId({
          threadId,
          turnId,
          pendingMessageId: MessageId.makeUnsafe(messageId),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state,
          requestedAt,
          startedAt: requestedAt,
          completedAt,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        });
        detail = {
          ...detail,
          latestTurn: {
            turnId,
            state,
            requestedAt,
            startedAt: requestedAt,
            completedAt,
            assistantMessageId: null,
          },
        };
      });
    const setPending = (messageId: string, requestedAt = later) =>
      projectionTurns.replacePendingTurnStart({
        threadId,
        messageId: MessageId.makeUnsafe(messageId),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt,
      });
    const native = (
      runId: string,
      state: "completed" | "failed" = "completed",
      errorMessage?: string,
    ) =>
      runtime.append({
        type: "turn.completed",
        eventId: EventId.makeUnsafe(`${id}:native:${runId}`),
        provider: "codex",
        threadId,
        turnId: TurnId.makeUnsafe(runId),
        createdAt: later,
        payload: { state, ...(errorMessage ? { errorMessage } : {}) },
      });
    const activity = (entry: { event: ProviderRuntimeEvent; sequence: number }, trusted = true) =>
      Effect.gen(function* () {
        const projected = projectProviderRuntimeActivities(entry.event, entry.sequence)[0]!;
        yield* append(
          "thread.activity-appended",
          { threadId, activity: projected },
          later,
          trusted
            ? `provider:${entry.event.eventId}:thread-activity-append:${id}:turn.completed:${entry.event.eventId}`
            : "untrusted-spoof",
          trusted ? "provider" : "client",
        );
      });
    const ack = Effect.gen(function* () {
      const throughSequence = yield* runtime.getHighWaterSequence;
      expect(
        yield* runtime.advanceConsumerCursorThrough({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          throughSequence,
          updatedAt: later,
        }),
      ).toBe(true);
    });
    return {
      sql,
      threadId,
      projectionTurns,
      runtime,
      dependencies,
      read,
      pin,
      append,
      setTurn,
      setPending,
      native,
      activity,
      ack,
      remove: () => {
        exists = false;
      },
      setMessages: (runId: string, text: string, streaming = false) => {
        detail = {
          ...detail,
          messages: [
            ...detail.messages,
            {
              id: MessageId.makeUnsafe(`${id}:assistant:${detail.messages.length}`),
              role: "assistant",
              turnId: TurnId.makeUnsafe(runId),
              text,
              streaming,
              source: "native",
              createdAt: now,
              updatedAt: later,
            },
          ],
        };
      },
      settleMessages: () => {
        detail = {
          ...detail,
          messages: detail.messages.map((message) => ({ ...message, streaming: false })),
        };
      },
      setError: (error: string) => {
        detail = {
          ...detail,
          session: {
            threadId,
            status: "error",
            activeTurnId: null,
            lastError: error,
            providerName: "codex",
            runtimeMode: "approval-required",
            updatedAt: later,
          },
        };
      },
    };
  });

layer("pinned thread results", (it) => {
  it.effect("pins pending startup before an older run, while explicit run selection wins", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("pin-startup");
      yield* h.setTurn("old", "completed");
      yield* h.setPending("new-message");
      const pending = yield* h.pin({ threadId: h.threadId });
      expect(pending).toEqual({ threadId: h.threadId, runId: null, messageId: "new-message" });
      expect(yield* h.read(pending)).toBeNull();
      expect(yield* h.pin({ threadId: h.threadId, runId: "old" })).toMatchObject({ runId: "old" });
      expect((yield* Effect.exit(h.pin({ threadId: h.threadId, runId: "foreign-run" })))._tag).toBe(
        "Failure",
      );
      yield* h.projectionTurns.deletePendingTurnStartByThreadId({ threadId: h.threadId });
      yield* h.setTurn("new-run", "completed", "new-message", later);
      yield* h.native("new-run");
      yield* h.ack;
      h.setMessages("new-run", "new result");
      yield* h.setTurn("later-run", "completed");
      h.setMessages("later-run", "unrelated result");
      expect(yield* h.read(pending)).toMatchObject({ runId: "new-run", summary: "new result" });
      expect(yield* h.read({ ...pending, runId: "old" })).toBeNull();
    }),
  );

  it.effect(
    "recovers a dispatched message from durable request or creation plan before projection",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness("pin-durable-request");
        yield* h.setTurn("old-request-run", "completed");
        yield* h.append("thread.turn-start-requested", { messageId: "not-projected" }, later);
        expect(yield* h.pin({ threadId: h.threadId })).toMatchObject({
          runId: null,
          messageId: "not-projected",
        });
        const planned = yield* makeHarness("pin-durable-plan");
        yield* planned.sql`
        INSERT INTO agent_gateway_operations (operation_id, caller_thread_id, caller_turn_id,
          operation_kind, request_id, fingerprint, requested_count, plan_json, status, created_at, updated_at)
        VALUES ('pin-plan', 'creator', 'creator-run', 'create_threads', 'pin-plan', 'fingerprint', 1,
          ${JSON.stringify([{ ids: { threadId: planned.threadId, messageId: "planned-message" } }])},
          'completed', ${now}, ${now})
      `;
        expect(yield* planned.pin({ threadId: planned.threadId })).toMatchObject({
          runId: null,
          messageId: "planned-message",
        });
        expect(
          yield* planned.read({
            threadId: planned.threadId,
            runId: null,
            messageId: "planned-message",
          }),
        ).toBeNull();
      }),
  );

  it.effect("rejects empty tasks and reused pending message identities", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("pin-empty");
      expect((yield* Effect.exit(h.pin({ threadId: h.threadId })))._tag).toBe("Failure");
      yield* h.setTurn("old-reused", "completed", "reused-message");
      yield* h.setPending("reused-message");
      expect((yield* Effect.exit(h.pin({ threadId: h.threadId })))._tag).toBe("Failure");
    }),
  );

  it.effect("requires real completion, ingestion acknowledgement and finalized messages", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("result-flush");
      yield* h.setTurn("flush-run", "completed");
      const pin = yield* h.pin({ threadId: h.threadId });
      expect(yield* h.read(pin)).toBeNull();
      const completed = yield* h.native("flush-run");
      yield* h.activity(completed);
      h.setMessages("flush-run", "final output", true);
      expect(yield* h.read(pin)).toBeNull();
      yield* h.ack;
      expect(yield* h.read(pin)).toBeNull();
      h.settleMessages();
      expect(yield* h.read(pin)).toMatchObject({ state: "completed", summary: "final output" });
      yield* h.setTurn("still-running", "running");
      expect(yield* h.read(yield* h.pin({ threadId: h.threadId }))).toBeNull();
    }),
  );

  it.effect(
    "reads historical native completion after real journal retention and reader restart",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness("result-retention");
        yield* h.setTurn("retained-run", "completed");
        const pin = yield* h.pin({ threadId: h.threadId });
        const completed = yield* h.native("retained-run");
        yield* h.activity(completed);
        h.setMessages("retained-run", "original output");
        yield* h.ack;
        yield* Effect.forEach(
          Array.from({ length: PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED + 1 }, (_, index) => index),
          (index) =>
            h.runtime.append({
              type: "content.delta",
              eventId: EventId.makeUnsafe(`retention-tail:${index}`),
              provider: "codex",
              threadId: ThreadId.makeUnsafe("retention-tail"),
              turnId: TurnId.makeUnsafe("retention-tail-run"),
              createdAt: later,
              payload: { streamKind: "assistant_text", delta: "." },
            }),
          { concurrency: 1 },
        );
        yield* h.ack;
        expect(yield* h.dependencies.repository.hasCompletedRun(h.threadId, "retained-run")).toBe(
          false,
        );
        yield* h.setTurn("subsequent-run", "completed");
        yield* h.native("subsequent-run");
        h.setMessages("subsequent-run", "wrong result");
        const restarted = yield* makePinnedThreadResultReader(h.dependencies);
        expect(yield* restarted(pin)).toMatchObject({
          state: "completed",
          runId: "retained-run",
          summary: "original output",
        });
      }),
  );

  it.effect("does not accept forged completion activity as native evidence", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("result-spoof");
      yield* h.setTurn("spoof-run", "completed");
      const pin = yield* h.pin({ threadId: h.threadId });
      const completed = yield* h.native("spoof-run");
      yield* h.ack;
      yield* h.sql`DELETE FROM provider_runtime_events WHERE thread_id = ${h.threadId}`;
      yield* h.activity(completed, false);
      expect(yield* h.read(pin)).toBeNull();
      yield* h.activity(completed);
      expect(yield* h.read(pin)).toMatchObject({ state: "completed" });
    }),
  );

  for (const hasAssistantMessageId of [true, false]) {
    it.effect(
      `reads persisted output outside the snapshot window with an assistant message ID: ${hasAssistantMessageId}`,
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness(`result-old-window:${hasAssistantMessageId}`);
          yield* h.setTurn("old-window-run", "completed");
          const pin = yield* h.pin({ threadId: h.threadId });
          if (hasAssistantMessageId) {
            yield* h.sql`
              UPDATE projection_turns SET assistant_message_id = 'old-window-answer'
              WHERE thread_id = ${h.threadId} AND turn_id = 'old-window-run'
            `;
          }
          const completed = yield* h.native("old-window-run");
          yield* h.activity(completed);
          yield* h.ack;
          yield* h.sql`
            INSERT INTO projection_thread_messages (
              thread_id, message_id, turn_id, role, text, text_json,
              is_streaming, source, sequence, created_at, updated_at
            ) VALUES
              (${h.threadId}, 'old-window-answer', 'old-window-run', 'assistant',
                '', ${JSON.stringify("persisted \u0000")}, 0, 'native', 2, ${now}, ${later}),
              (${h.threadId}, 'other-old-message', 'old-window-run', 'assistant',
                'intermediate text', NULL, 1, 'native', ${hasAssistantMessageId ? 3 : 1}, ${now}, ${later}),
              (${h.threadId}, 'later-window-answer', 'later-window-run', 'assistant',
                'unrelated later output', NULL, 0, 'native', 100, ${later}, ${later}),
              ('foreign-window-thread', 'old-window-answer', 'old-window-run', 'assistant',
                'unrelated foreign output', NULL, 0, 'native', 200, ${later}, ${later})
          `;
          const chunks = ["old ", "\uD83D", "\uDE80 answer"];
          for (const [index, text] of chunks.entries()) {
            yield* h.sql`
              INSERT INTO message_text_chunks (
                thread_id, message_id, event_sequence, segment_sequence, text_json, updated_at
              ) VALUES (${h.threadId}, 'old-window-answer', ${index}, NULL, ${JSON.stringify(text)}, ${later})
            `;
          }
          yield* h.setTurn("later-window-run", "completed");
          h.setMessages("later-window-run", "unrelated later output");
          const restarted = yield* makePinnedThreadResultReader(h.dependencies);
          expect(yield* restarted(pin)).toBeNull();
          yield* h.sql`
            UPDATE projection_thread_messages SET is_streaming = 0
            WHERE thread_id = ${h.threadId} AND message_id = 'other-old-message'
          `;
          expect(yield* restarted(pin)).toMatchObject({
            runId: "old-window-run",
            state: "completed",
            summary: `persisted \u0000${chunks.join("")}`,
            summaryTruncated: false,
          });
          yield* h.sql`DELETE FROM message_text_chunks WHERE thread_id = ${h.threadId}`;
          yield* h.sql`DELETE FROM projection_thread_messages WHERE thread_id = 'foreign-window-thread'`;
        }),
    );
  }

  it.effect("keeps errors and summaries attached to the pinned run and bounds their size", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("result-error");
      yield* h.setTurn("failed-run", "error");
      const pin = yield* h.pin({ threadId: h.threadId });
      const completed = yield* h.native("failed-run", "failed", "original failure".repeat(500));
      yield* h.activity(completed);
      yield* h.ack;
      h.setMessages("failed-run", "original output".repeat(500));
      yield* h.setTurn("unrelated-error-run", "error");
      h.setError("unrelated error");
      h.setMessages("unrelated-error-run", "unrelated output");
      const result = yield* h.read(pin);
      expect(result).toMatchObject({ state: "error", runId: "failed-run", summaryTruncated: true });
      expect(result?.summary?.length).toBeLessThanOrEqual(2000);
      expect(result?.error?.length).toBeLessThanOrEqual(2000);
      expect(JSON.stringify(result)).not.toContain("unrelated");
      expect(result?.error).toContain("original failure");
    }),
  );

  it.effect(
    "pins startup failure before later requests and stops deleted tasks despite pending output",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness("result-startup-error");
        yield* h.append("thread.turn-start-requested", { messageId: "failed-start" });
        yield* h.append("thread.session-set", {
          session: { status: "error", lastError: "startup failure" },
        });
        yield* h.append("thread.turn-start-requested", { messageId: "later-start" }, later);
        yield* h.append(
          "thread.session-set",
          { session: { status: "error", lastError: "later failure" } },
          later,
        );
        const pin = { threadId: h.threadId, runId: null, messageId: "failed-start" };
        expect(yield* h.read(pin)).toMatchObject({
          state: "error",
          error: "startup failure",
          runId: null,
        });
        yield* h.native("unacknowledged-run");
        h.remove();
        expect(yield* h.read(pin)).toMatchObject({
          state: "interrupted",
          error: "Awaited task was deleted.",
        });
      }),
  );

  it.effect("honors native failure when a settled projection still says completed", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("result-native-failure");
      yield* h.setTurn("native-failure-run", "completed");
      const completed = yield* h.native("native-failure-run", "failed", "native failure");
      yield* h.activity(completed);
      yield* h.ack;
      expect(yield* h.read(yield* h.pin({ threadId: h.threadId }))).toMatchObject({
        state: "error",
        error: "native failure",
      });
    }),
  );

  it.effect(
    "terminates an unavailable pinned run after rollback without following a later run",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness("result-rollback");
        yield* h.setTurn("rollback-run", "running");
        const pin = yield* h.pin({ threadId: h.threadId });
        yield* h.projectionTurns.deleteByThreadId({ threadId: h.threadId });
        yield* h.setTurn("replacement-run", "completed");
        expect(yield* h.read(pin)).toMatchObject({
          state: "interrupted",
          runId: "rollback-run",
          error: "Awaited run is no longer available.",
        });
      }),
  );

  it.effect("does not freeze startup failure before queued provider output is acknowledged", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("startup-output");
      yield* h.append("thread.turn-start-requested", { messageId: "startup-output-message" });
      yield* h.append("thread.session-set", {
        session: { status: "error", lastError: "startup error" },
      });
      yield* h.native("startup-output-run", "failed");
      const pin = { threadId: h.threadId, runId: null, messageId: "startup-output-message" };
      expect(yield* h.read(pin)).toBeNull();
      yield* h.ack;
      expect(yield* h.read(pin)).toMatchObject({ state: "error", error: "startup error" });
    }),
  );

  for (const type of [
    "thread.session-stop-requested",
    "thread.archived",
    "thread.turn-interrupt-requested",
  ]) {
    it.effect(`settles startup cancelled by ${type}`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(`cancel:${type}`);
        yield* h.append("thread.turn-start-requested", { messageId: "cancelled-start" });
        yield* h.append(type, { threadId: h.threadId });
        expect(
          yield* h.read({ threadId: h.threadId, runId: null, messageId: "cancelled-start" }),
        ).toMatchObject({ state: "interrupted", terminal: true });
      }),
    );
  }

  for (const goalDuringRun of [false, true]) {
    it.effect(
      `distinguishes old cleared goals from goals within the pinned task: ${goalDuringRun}`,
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness(`result-goal:${goalDuringRun}`);
          yield* h.append("thread.meta-updated", { goal: "previous goal" });
          yield* h.append("thread.meta-updated", { goal: null });
          yield* h.append("thread.turn-start-requested", { messageId: "goal-message" });
          if (goalDuringRun) yield* h.append("thread.meta-updated", { goal: "active goal" });
          yield* h.setTurn("goal-run", "completed", "goal-message");
          const completed = yield* h.native("goal-run");
          yield* h.activity(completed);
          yield* h.ack;
          yield* h.append("thread.meta-updated", { goal: "later goal" }, later);
          const result = yield* h.read(yield* h.pin({ threadId: h.threadId, runId: "goal-run" }));
          expect(result?.state).toBe(goalDuringRun ? "error" : "completed");
        }),
    );
  }
});

const queuedLayer = it.layer(
  Layer.mergeAll(
    OrchestrationEngineLive,
    QueuedTurnPromotionRepositoryLive,
    ProviderRuntimeEventRepositoryLive,
  ).pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "synara-pinned-queue-test-" }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const makeQueuedHarness = (id: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const projectionTurns = yield* ProjectionTurnRepository;
    const queue = yield* QueuedTurnPromotionRepository;
    const events = yield* OrchestrationEventStore;
    const runtime = yield* ProviderRuntimeEventRepository;
    const repository = yield* makeCompletionRepository;
    const threadId = ThreadId.makeUnsafe(id);
    const projectId = ProjectId.makeUnsafe(`${id}:project`);
    let commandIndex = 0;
    const dispatch = (command: Record<string, unknown>) =>
      engine.dispatch(
        Schema.decodeUnknownSync(OrchestrationCommand)({
          threadId,
          createdAt: now,
          commandId: CommandId.makeUnsafe(`${id}:command:${commandIndex++}`),
          ...command,
        }),
      );
    yield* dispatch({
      type: "project.create",
      projectId,
      title: id,
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: null,
    });
    yield* dispatch({
      type: "thread.create",
      projectId,
      title: id,
      modelSelection: { provider: "codex", model: "test-model" },
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
    });
    const send = (messageId: string, createdAt = now) =>
      Effect.gen(function* () {
        const receipt = yield* dispatch({
          type: "thread.turn.start",
          message: { messageId, role: "user", text: messageId, attachments: [] },
          dispatchMode: "queue",
          runtimeMode: "approval-required",
          createdAt,
        });
        const [event] = yield* events.readThreadEvents({
          threadId,
          throughSequenceInclusive: receipt.sequence,
          limit: 1,
          eventTypes: ["thread.turn-queued", "thread.turn-start-requested"],
        });
        if (
          !event ||
          (event.type !== "thread.turn-queued" && event.type !== "thread.turn-start-requested")
        ) {
          throw new Error("Missing dispatched request.");
        }
        return event;
      });
    const session = (runId: string | null) =>
      dispatch({
        type: "thread.session.set",
        session: {
          threadId,
          status: runId === null ? "ready" : "running",
          activeTurnId: runId,
          providerName: "codex",
          runtimeMode: "approval-required",
          lastError: null,
          updatedAt: later,
        },
        createdAt: later,
      });
    const firstMessage = `${id}:initial`;
    const firstRun = `${id}:old-run`;
    yield* send(firstMessage);
    yield* session(firstRun);
    const pin = yield* makeThreadTargetPinner({ snapshotQuery, projectionTurns });
    const read = yield* makePinnedThreadResultReader({
      snapshotQuery,
      projectionTurns,
      repository,
    });
    const enqueue = (event: Effect.Success<ReturnType<typeof send>>) =>
      queue.enqueue({
        queuedEventSequence: event.sequence,
        threadId,
        messageId: event.payload.messageId,
        dispatchMode: event.payload.dispatchMode,
        createdAt: event.payload.createdAt,
      });
    const claim = () =>
      queue.claimNext({
        threadId,
        claimOwner: id,
        claimedAt: later,
        claimExpiresAt: "2099-01-01T00:00:00.000Z",
      });
    const promote = (event: Effect.Success<ReturnType<typeof send>>) =>
      dispatch({
        type: "thread.turn.dispatch-queued",
        commandId: `server:dispatch-queued-turn:${event.sequence}`,
        ...event.payload,
      });
    const complete = (runId: string, text: string) =>
      Effect.gen(function* () {
        const messageId = `${id}:answer:${runId}`;
        yield* dispatch({
          type: "thread.message.assistant.delta",
          messageId,
          turnId: runId,
          delta: text,
        });
        yield* dispatch({ type: "thread.message.assistant.complete", messageId, turnId: runId });
        const completion = yield* runtime.append({
          type: "turn.completed",
          eventId: EventId.makeUnsafe(`${id}:terminal:${runId}`),
          provider: "codex",
          threadId,
          turnId: TurnId.makeUnsafe(runId),
          createdAt: later,
          payload: { state: "completed" },
        });
        yield* session(null);
        const activity = projectProviderRuntimeActivities(
          completion.event,
          completion.sequence,
        )[0]!;
        yield* dispatch({
          type: "thread.activity.append",
          activity,
          commandId: `provider:${completion.event.eventId}:thread-activity-append:${id}:turn.completed:${completion.event.eventId}`,
        });
        yield* runtime.advanceConsumerCursorThrough({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          throughSequence: completion.sequence,
          updatedAt: later,
        });
      });
    return {
      threadId,
      firstRun,
      firstMessage,
      dispatch,
      send,
      session,
      pin,
      read,
      queue,
      projectionTurns,
      enqueue,
      claim,
      promote,
      complete,
      snapshotQuery,
      runtime,
    };
  });

queuedLayer("queued target pinning with orchestration projections", (it) => {
  it.effect(
    "pins a newly accepted queue before consumption despite delayed createdAt and an older completed run",
    () =>
      Effect.gen(function* () {
        const h = yield* makeQueuedHarness("queued-before-consumer");
        const queued = yield* h.send("queued-newest", "2026-09-29T01:00:00.000Z");
        expect(queued.type).toBe("thread.turn-queued");
        expect(Option.isNone(yield* h.queue.getBySequence(queued.sequence))).toBe(true);
        expect(
          Option.isNone(
            yield* h.projectionTurns.getPendingTurnStartByThreadId({ threadId: h.threadId }),
          ),
        ).toBe(true);
        const pin = yield* h.pin({ threadId: h.threadId });
        expect(pin).toEqual({ threadId: h.threadId, runId: null, messageId: "queued-newest" });
        expect(yield* h.pin({ threadId: h.threadId, runId: h.firstRun })).toMatchObject({
          runId: h.firstRun,
        });
        yield* h.complete(h.firstRun, "old answer");
        expect(yield* h.pin({ threadId: h.threadId })).toEqual(pin);
        expect(yield* h.read(pin)).toBeNull();
      }),
  );

  it.effect(
    "follows one exact queued message through claim, promotion and the projected provider run",
    () =>
      Effect.gen(function* () {
        const h = yield* makeQueuedHarness("queued-promotion");
        const event = yield* h.send("promoted-message");
        const pin = yield* h.pin({ threadId: h.threadId });
        yield* h.enqueue(event);
        expect(yield* h.pin({ threadId: h.threadId })).toEqual(pin);
        expect(yield* h.read(pin)).toBeNull();
        expect(Option.getOrThrow(yield* h.claim()).state).toBe("promoting");
        expect(yield* h.pin({ threadId: h.threadId })).toEqual(pin);
        yield* h.complete(h.firstRun, "old answer");
        yield* h.promote(event);
        expect(
          Option.getOrThrow(
            yield* h.projectionTurns.getPendingTurnStartByThreadId({ threadId: h.threadId }),
          ).messageId,
        ).toBe("promoted-message");
        expect(yield* h.read(pin)).toBeNull();
        expect(
          yield* h.queue.markPromoted({
            queuedEventSequence: event.sequence,
            claimOwner: h.threadId,
            promotedAt: later,
          }),
        ).toBe(true);
        yield* h.session("promoted-run");
        expect(
          Option.getOrThrow(
            yield* h.projectionTurns.getByTurnId({
              threadId: h.threadId,
              turnId: TurnId.makeUnsafe("promoted-run"),
            }),
          ).pendingMessageId,
        ).toBe("promoted-message");
        expect(yield* h.read(pin)).toBeNull();
        yield* h.complete("promoted-run", "requested answer");
        expect(yield* h.read(pin)).toMatchObject({
          state: "completed",
          runId: "promoted-run",
          summary: "requested answer",
        });
      }),
  );

  it.effect(
    "keeps the newest accepted message when an older queued message is promoted later",
    () =>
      Effect.gen(function* () {
        const h = yield* makeQueuedHarness("queued-source-order");
        const older = yield* h.send("older-queued");
        yield* h.enqueue(older);
        yield* h.send("newer-queued", "2026-09-29T01:00:00.000Z");
        yield* h.claim();
        yield* h.promote(older);
        expect(
          Option.getOrThrow(
            yield* h.projectionTurns.getPendingTurnStartByThreadId({ threadId: h.threadId }),
          ).messageId,
        ).toBe("older-queued");
        expect(yield* h.pin({ threadId: h.threadId })).toEqual({
          threadId: h.threadId,
          runId: null,
          messageId: "newer-queued",
        });
        yield* h.send("latest-queued", "2026-09-28T01:00:00.000Z");
        expect(yield* h.pin({ threadId: h.threadId })).toMatchObject({
          messageId: "latest-queued",
        });
      }),
  );

  it.effect("keeps a newer request's completed run when an older queued request is promoted", () =>
    Effect.gen(function* () {
      const h = yield* makeQueuedHarness("queued-bound-source-order");
      const older = yield* h.send("older-pending");
      yield* h.enqueue(older);
      yield* h.complete(h.firstRun, "initial answer");
      const newer = yield* h.send("newer-direct-request");
      expect(newer.type).toBe("thread.turn-start-requested");
      yield* h.session("newer-completed-run");
      yield* h.complete("newer-completed-run", "latest requested answer");
      yield* h.claim();
      yield* h.promote(older);
      const pin = yield* h.pin({ threadId: h.threadId });
      expect(pin).toEqual({
        threadId: h.threadId,
        runId: "newer-completed-run",
        messageId: "newer-direct-request",
      });
      expect(yield* h.read(pin)).toMatchObject({
        runId: "newer-completed-run",
        summary: "latest requested answer",
      });
    }),
  );

  for (const promoting of [false, true]) {
    it.effect(
      `returns interrupted when a durable ${promoting ? "promoting" : "queued"} request is cancelled before starting`,
      () =>
        Effect.gen(function* () {
          const h = yield* makeQueuedHarness(`queued-cancel-${promoting}`);
          const event = yield* h.send("cancelled-queued");
          yield* h.enqueue(event);
          if (promoting) yield* h.claim();
          const pin = yield* h.pin({ threadId: h.threadId });
          yield* h.dispatch({ type: "thread.turn.interrupt" });
          expect(yield* h.read(pin)).toBeNull();
          if (promoting) yield* h.queue.cancelThread({ threadId: h.threadId, updatedAt: later });
          else
            expect(
              yield* h.queue.cancelMessage({
                threadId: h.threadId,
                messageId: "cancelled-queued",
                updatedAt: later,
              }),
            ).toBe(true);
          expect(yield* h.read(pin)).toMatchObject({
            state: "interrupted",
            runId: null,
            terminal: true,
          });
        }),
    );
  }

  it.effect(
    "returns interrupted for an archived queue before the consumer has stored its row",
    () =>
      Effect.gen(function* () {
        const h = yield* makeQueuedHarness("queued-archive");
        yield* h.send("archived-queued");
        const pin = yield* h.pin({ threadId: h.threadId });
        yield* h.dispatch({ type: "thread.archive" });
        expect(yield* h.read(pin)).toMatchObject({ state: "interrupted", runId: null });
      }),
  );

  it.effect(
    "returns interrupted when rollback removes a queued message from the real projection",
    () =>
      Effect.gen(function* () {
        const h = yield* makeQueuedHarness("queued-removed");
        const queued = yield* h.send("removed-queued");
        yield* h.enqueue(queued);
        const pin = yield* h.pin({ threadId: h.threadId });
        yield* h.dispatch({
          type: "thread.conversation.rollback.complete",
          messageId: h.firstMessage,
          numTurns: 1,
          removedTurnIds: [h.firstRun],
          createdAt: later,
        });
        const detail = Option.getOrThrow(yield* h.snapshotQuery.getThreadDetailById(h.threadId));
        expect(detail.messages.some((message) => message.id === "removed-queued")).toBe(false);
        expect(yield* h.read(pin)).toMatchObject({
          state: "interrupted",
          runId: null,
          terminal: true,
        });
      }),
  );
});
