import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ClaudeModelSelection,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import backfill, { MIGRATION_121_PAGE_SIZE } from "./121_BackfillClaudeNativeSubagentEffort.ts";

const testLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "121-claude-native-effort" })),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(NodeServices.layer),
);

const low: ClaudeModelSelection = {
  provider: "claudeAgent",
  model: "claude-opus-4-6",
  supportsAutoMode: true,
  options: { effort: "low", fastMode: true, thinking: true, autoCompactWindow: "200k" },
};
const at = "2026-09-30T10:00:00.000Z";
type CreatedPayload = Extract<OrchestrationEvent, { type: "thread.created" }>["payload"];
type MetaPayload = Extract<OrchestrationEvent, { type: "thread.meta-updated" }>["payload"];

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* OrchestrationEventStore;
  const pipeline = yield* OrchestrationProjectionPipeline;
  yield* runMigrations({ toMigrationInclusive: 120 });
  let counter = 0;
  const projectId = ProjectId.makeUnsafe("project-121");
  const base = (threadId: ThreadId, command: string) => ({
    eventId: EventId.makeUnsafe(`event-121-${++counter}`),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: at,
    commandId: CommandId.makeUnsafe(command),
    causationEventId: null,
    correlationId: null,
    metadata: {},
  });
  const append = (event: Omit<OrchestrationEvent, "sequence">) =>
    store.append(event).pipe(Effect.tap((saved) => pipeline.projectEvent(saved)));

  yield* append({
    ...base(ThreadId.makeUnsafe("unused"), "server:project-121"),
    type: "project.created",
    aggregateKind: "project",
    aggregateId: projectId,
    payload: {
      projectId,
      title: "Project 121",
      workspaceRoot: "/tmp/project-121",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });

  const create = (
    threadId: ThreadId,
    parentId: ThreadId | null = null,
    selection: ModelSelection = low,
    overrides: Partial<CreatedPayload> = {},
  ) =>
    append({
      ...base(
        threadId,
        parentId
          ? `provider:spawn-${counter}:subagent-thread-create:${threadId}`
          : `server:create-${threadId}`,
      ),
      type: "thread.created",
      payload: {
        threadId,
        projectId,
        title: "Same display name",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
        branch: null,
        worktreePath: null,
        workingDirectory: null,
        associatedWorktreePath: null,
        associatedWorktreeBranch: null,
        associatedWorktreeRef: null,
        createBranchFlowCompleted: false,
        isPinned: false,
        parentThreadId: parentId,
        creationSource: parentId ? "provider_native" : null,
        sourceThreadId: parentId,
        sourceTurnId: null,
        gatewayOperationId: null,
        gatewayOperationIndex: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        sidechatLastActivityAt: null,
        sidechatExpiredAt: null,
        lastKnownPr: null,
        handoff: null,
        createdAt: at,
        updatedAt: at,
        ...overrides,
      },
    });

  const meta = (threadId: ThreadId, patch: Partial<MetaPayload>, native = true) =>
    append({
      ...base(
        threadId,
        native
          ? `provider:meta-${counter}:subagent-thread-meta-update:${threadId}`
          : `user:selection-${counter}`,
      ),
      type: "thread.meta-updated",
      payload: { threadId, ...patch, updatedAt: at },
    });

  const activity = (
    parentId: ThreadId,
    data: OrchestrationThreadActivity["payload"],
    options: { turnId?: TurnId; native?: boolean } = {},
  ) => {
    const activityId = EventId.makeUnsafe(`runtime-activity-${counter}`);
    return append({
      ...base(
        parentId,
        options.native === false
          ? `user:activity-${counter}`
          : `provider:${activityId}:thread-activity-append:${parentId}:tool.completed:${activityId}`,
      ),
      type: "thread.activity-appended",
      payload: {
        threadId: parentId,
        activity: {
          id: activityId,
          kind: "tool.completed",
          tone: "tool",
          summary: "Subagent task",
          payload: { itemType: "collab_agent_tool_call", data },
          turnId: options.turnId ?? null,
          // Deliberately incomparable with orchestration sequence and timestamps.
          sequence: 900_000 - counter,
          createdAt: at,
        },
      },
    });
  };

  const selection = (threadId: ThreadId) =>
    sql<{ readonly selectionJson: string }>`
      SELECT model_selection_json AS "selectionJson" FROM projection_threads WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => JSON.parse(rows[0]!.selectionJson) as ModelSelection));
  const child = (parent: ThreadId, receiver: string) =>
    ThreadId.makeUnsafe(`subagent:${parent}:${receiver}`);
  const replay = Effect.gen(function* () {
    yield* sql`DELETE FROM projection_state WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}`;
    yield* pipeline.bootstrap;
  });
  return { sql, append, base, create, meta, activity, selection, child, replay };
});

it.effect(
  "repairs the last native selection, preserves a concrete model, and survives replay twice",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const parent = ThreadId.makeUnsafe("parent:one");
      const child = f.child(parent, "tool:one");
      yield* f.create(parent);
      const created = yield* f.create(child, parent);
      yield* f.activity(parent, { receiverThreadId: "tool:one", effort: "high", model: "opus" });
      const concrete = { ...low, model: "claude-opus-4-7" };
      const nativeMeta = yield* f.meta(child, { modelSelection: concrete });
      yield* f.meta(child, { title: "User renamed this child" }, false);
      yield* f.append({
        ...f.base(child, "provider:child-session:thread-session-set"),
        type: "thread.session-set",
        payload: {
          threadId: child,
          session: {
            threadId: child,
            providerName: "claudeAgent",
            status: "ready",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: at,
          },
        },
      });
      const beforeThread =
        yield* f.sql`SELECT * FROM projection_threads WHERE thread_id = ${child}`;
      const beforeSessions = yield* f.sql`SELECT * FROM projection_thread_sessions`;
      const beforeCursor = yield* f.sql`SELECT * FROM provider_runtime_event_consumers`;
      const beforeEvents = yield* f.sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 121 }), [
        [121, "BackfillClaudeNativeSubagentEffort"],
      ]);
      const expected: ClaudeModelSelection = {
        ...concrete,
        options: { ...concrete.options, effort: "high" },
      };
      assert.deepStrictEqual(yield* f.selection(child), expected);
      assert.deepStrictEqual(yield* f.selection(parent), low);
      const afterEvents = yield* f.sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      assert.deepStrictEqual(
        afterEvents,
        beforeEvents.map((row) =>
          row.sequence === nativeMeta.sequence
            ? {
                ...row,
                payload_json: JSON.stringify({
                  ...JSON.parse(String(row.payload_json)),
                  modelSelection: expected,
                }),
              }
            : row,
        ),
      );
      const afterThread = yield* f.sql`SELECT * FROM projection_threads WHERE thread_id = ${child}`;
      const storedSelection = JSON.parse(
        String(beforeThread[0]!.model_selection_json),
      ) as ClaudeModelSelection;
      assert.deepStrictEqual(afterThread, [
        {
          ...beforeThread[0],
          model_selection_json: JSON.stringify({
            ...storedSelection,
            options: { ...storedSelection.options, effort: "high" },
          }),
        },
      ]);
      assert.deepStrictEqual(
        yield* f.sql`SELECT * FROM projection_thread_sessions`,
        beforeSessions,
      );
      assert.deepStrictEqual(
        yield* f.sql`SELECT * FROM provider_runtime_event_consumers`,
        beforeCursor,
      );
      yield* backfill;
      assert.deepStrictEqual(
        yield* f.sql`SELECT * FROM orchestration_events ORDER BY sequence`,
        afterEvents,
      );
      yield* f.replay;
      assert.deepStrictEqual(yield* f.selection(child), expected);
      yield* backfill;
      yield* f.replay;
      assert.deepStrictEqual(yield* f.selection(child), expected);
      const [original] = yield* f.sql<{ readonly payload: string }>`
      SELECT payload_json AS payload FROM orchestration_events WHERE sequence = ${created.sequence}
    `;
      assert.deepStrictEqual(JSON.parse(original!.payload).modelSelection, low);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "joins exact parent/receiver ids and repairs missing effort without adopting requested model hints",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = ThreadId.makeUnsafe("parent:a");
      const second = ThreadId.makeUnsafe("parent:b");
      const a = f.child(first, "same:receiver");
      const b = f.child(second, "same:receiver");
      const other = f.child(first, "other");
      const noEvidence = f.child(first, "unmentioned");
      yield* f.create(first);
      yield* f.create(second);
      yield* f.create(a, first);
      yield* f.create(b, second, { provider: "claudeAgent", model: low.model });
      yield* f.create(other, first);
      yield* f.create(noEvidence, first);
      yield* f.activity(first, {
        item: {
          receiverAgents: [
            { threadId: "same:receiver", effort: "high", model: "sonnet" },
            { threadId: "other", reasoning_effort: "medium" },
          ],
        },
      });
      yield* f.activity(second, { receiver_thread_id: "same:receiver", reasoningEffort: "xhigh" });
      yield* runMigrations({ toMigrationInclusive: 121 });
      assert.deepStrictEqual(yield* f.selection(a), {
        ...low,
        options: { ...low.options, effort: "high" },
      });
      assert.deepStrictEqual(yield* f.selection(b), {
        provider: "claudeAgent",
        model: low.model,
        options: { effort: "xhigh" },
      });
      assert.deepStrictEqual(yield* f.selection(other), {
        ...low,
        options: { ...low.options, effort: "medium" },
      });
      assert.deepStrictEqual(yield* f.selection(noEvidence), low);
      yield* f.replay;
      assert.deepStrictEqual(yield* f.selection(b), {
        provider: "claudeAgent",
        model: low.model,
        options: { effort: "xhigh" },
      });
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "preserves explicit user selections including equal values and later native metadata",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const parent = ThreadId.makeUnsafe("manual-parent");
      yield* f.create(parent);
      for (const mode of ["same-value", "other-value", "user-turn"]) {
        const child = f.child(parent, mode);
        yield* f.create(child, parent);
        yield* f.activity(parent, { receiverThreadId: mode, effort: "high" });
        const chosen: ClaudeModelSelection =
          mode === "other-value" ? { ...low, options: { effort: "medium" } } : low;
        if (mode === "user-turn") {
          yield* f.append({
            ...f.base(child, "user:own-turn"),
            type: "thread.turn-start-requested",
            payload: {
              threadId: child,
              messageId: MessageId.makeUnsafe("manual-message"),
              modelSelection: chosen,
              runtimeMode: "full-access",
              interactionMode: "default",
              dispatchMode: "queue",
              dispatchOrigin: "user",
              createdAt: at,
            },
          });
        } else {
          yield* f.meta(child, { modelSelection: chosen }, false);
        }
        yield* f.meta(child, { title: "Native rename after choice" });
      }
      const before = yield* f.sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      yield* backfill;
      assert.deepStrictEqual(
        yield* f.sql`SELECT * FROM orchestration_events ORDER BY sequence`,
        before,
      );
      assert.deepStrictEqual(yield* f.selection(f.child(parent, "same-value")), low);
      assert.deepStrictEqual(yield* f.selection(f.child(parent, "other-value")), {
        ...low,
        options: { effort: "medium" },
      });
      assert.deepStrictEqual(yield* f.selection(f.child(parent, "user-turn")), low);
      yield* f.replay;
      assert.deepStrictEqual(yield* f.selection(f.child(parent, "same-value")), low);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("leaves absent, ambiguous, removed, conflicting and non-native evidence untouched", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const parent = ThreadId.makeUnsafe("evidence-parent");
    yield* f.create(parent);
    const names = [
      "absent",
      "invalid",
      "removed",
      "conflict",
      "manual-source",
      "ambiguous",
      "truncated",
      "wrong-turn",
    ];
    for (const name of names) {
      yield* f.create(
        f.child(parent, name),
        parent,
        low,
        name === "wrong-turn" ? { sourceTurnId: TurnId.makeUnsafe("original-turn") } : {},
      );
    }
    yield* f.activity(parent, { receiverThreadId: "absent", agentType: "worker-high" });
    yield* f.activity(parent, { receiverThreadId: "invalid", effort: "not-an-effort" });
    const removed = yield* f.activity(parent, { receiverThreadId: "removed", effort: "high" });
    if (removed.type !== "thread.activity-appended") throw new Error("Expected activity event");
    yield* f.sql`DELETE FROM projection_thread_activities WHERE activity_id = ${removed.payload.activity.id}`;
    yield* f.activity(parent, { receiverThreadId: "conflict", effort: "high" });
    yield* f.activity(parent, { receiverThreadId: "conflict", effort: "medium" });
    yield* f.activity(
      parent,
      { receiverThreadId: "manual-source", effort: "high" },
      { native: false },
    );
    yield* f.activity(parent, {
      receiverThreadIds: ["ambiguous", "another"],
      receiverAgents: [{ effort: "high" }, { effort: "medium" }],
    });
    yield* f.activity(parent, {
      __synaraTruncated: true,
      preview: '{"receiverThreadId":"truncated","effort":"high"}',
    });
    yield* f.activity(
      parent,
      { receiverThreadId: "wrong-turn", effort: "high" },
      { turnId: TurnId.makeUnsafe("different-turn") },
    );
    const before = yield* f.sql`SELECT * FROM orchestration_events ORDER BY sequence`;
    yield* backfill;
    assert.deepStrictEqual(
      yield* f.sql`SELECT * FROM orchestration_events ORDER BY sequence`,
      before,
    );
    for (const name of names)
      assert.deepStrictEqual(yield* f.selection(f.child(parent, name)), low);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "excludes other providers, gateway children, tombstones and inconsistent selections",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const parent = ThreadId.makeUnsafe("excluded-parent");
      yield* f.create(parent);
      const codex: ModelSelection = {
        provider: "codex",
        model: "gpt-5-codex",
        options: { reasoningEffort: "low" },
      };
      for (const name of ["codex", "gateway", "deleted", "inconsistent", "handoff"]) {
        const child = f.child(parent, name);
        yield* f.create(
          child,
          parent,
          name === "codex" ? codex : low,
          name === "gateway"
            ? { creationSource: "synara_mcp", gatewayOperationId: "operation-121" }
            : {},
        );
        yield* f.activity(parent, { receiverThreadId: name, effort: "high" });
        if (name === "deleted") {
          yield* f.sql`UPDATE projection_threads SET deleted_at = ${at} WHERE thread_id = ${child}`;
        } else if (name === "inconsistent") {
          yield* f.sql`UPDATE projection_threads SET model_selection_json = json_set(model_selection_json, '$.model', 'different-model') WHERE thread_id = ${child}`;
        } else if (name === "handoff") {
          yield* f.meta(child, {
            handoff: {
              sourceThreadId: parent,
              sourceProvider: "claudeAgent",
              importedAt: at,
              bootstrapStatus: "completed",
            },
          });
        }
      }
      const before = yield* f.sql`SELECT * FROM projection_threads ORDER BY thread_id`;
      const events = yield* f.sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      yield* backfill;
      assert.deepStrictEqual(
        yield* f.sql`SELECT * FROM projection_threads ORDER BY thread_id`,
        before,
      );
      assert.deepStrictEqual(
        yield* f.sql`SELECT * FROM orchestration_events ORDER BY sequence`,
        events,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("repairs every eligible child across candidate and event page boundaries", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const parent = ThreadId.makeUnsafe("paged-parent");
    yield* f.create(parent);
    for (let index = 0; index < MIGRATION_121_PAGE_SIZE + 3; index += 1) {
      const receiver = `receiver-${index}`;
      yield* f.create(f.child(parent, receiver), parent);
      yield* f.activity(parent, { receiverThreadId: receiver, effort: "high" });
    }
    yield* runMigrations({ toMigrationInclusive: 121 });
    const [repaired] = yield* f.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM projection_threads
      WHERE parent_thread_id = ${parent} AND json_extract(model_selection_json, '$.options.effort') = 'high'
    `;
    assert.equal(repaired!.count, MIGRATION_121_PAGE_SIZE + 3);
    yield* f.replay;
    const [replayed] = yield* f.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM projection_threads
      WHERE parent_thread_id = ${parent} AND json_extract(model_selection_json, '$.options.effort') = 'high'
    `;
    assert.equal(replayed!.count, MIGRATION_121_PAGE_SIZE + 3);
  }).pipe(Effect.provide(testLayer)),
);
