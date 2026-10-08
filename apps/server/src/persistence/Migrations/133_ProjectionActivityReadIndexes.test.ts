import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import createProjections from "./005_Projections.ts";
import addActivitySequence from "./008_ProjectionThreadActivitySequence.ts";
import migration from "./133_ProjectionActivityReadIndexes.ts";

it.effect("covers activity ranks and task evidence without changing rows on replay", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createProjections;
    yield* addActivitySequence;
    const activities = [
      ["start", "task.started", 1, { taskId: "task", toolUseId: "tool" }],
      ["patch", "task.updated", 2, { taskId: "task", status: "running", isBackgrounded: false }],
      ["terminal", "task.completed", 3, { taskId: "task", status: null }],
      ["boundary", "provider.session.boundary", 4, {}],
      [
        "tool-start",
        "tool.started",
        4,
        { data: { toolCallId: "preferred", toolUseId: "fallback" } },
      ],
      ["tool-update", "tool.updated", null, { data: { toolUseId: "tool" } }],
      ["tool-end", "tool.completed", null, { data: { toolCallId: "tool" } }],
      ["noise", "provider.heartbeat", 0, {}],
    ] as const;
    for (const [activityId, kind, sequence, payload] of activities) {
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES (${activityId}, 'activity-index-thread', 'turn', 'info', ${kind}, 'Keep this',
          ${JSON.stringify(payload)}, ${sequence},
          ${activityId === "tool-update" ? "2026-10-08T01:00:00.000Z" : "2026-10-08T00:00:00.000Z"})`;
    }
    yield* sql`INSERT INTO projection_thread_activities
      (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
      VALUES ('other-thread', 'other', NULL, 'info', 'task.started', 'Keep this too',
        '{"taskId":"other"}', 100, '2026-10-08T00:00:00.000Z')`;
    const readRows = sql`SELECT * FROM projection_thread_activities ORDER BY activity_id`;
    const before = yield* readRows;
    yield* migration;
    yield* migration;
    assert.deepStrictEqual(yield* readRows, before);
    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_index_list('projection_thread_activities')
    `;
    assert.includeMembers(
      indexes.map((row) => row.name),
      [
        "idx_projection_activities_detail_rank_covering",
        "idx_projection_activities_task_evidence",
        "idx_projection_activities_interaction_resolution",
      ],
    );

    const ranks = sql<{ readonly activity_id: string; readonly activity_rank: number }>`
      SELECT thread_id, activity_id, turn_id, kind,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id
          ORDER BY CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
            sequence DESC, created_at DESC, activity_id DESC
        ) AS activity_rank
      FROM projection_thread_activities INDEXED BY idx_projection_activities_detail_rank_covering
      WHERE thread_id = 'activity-index-thread'
    `;
    assert.deepStrictEqual(
      (yield* ranks).map((row) => [row.activity_id, row.activity_rank]),
      [
        ["tool-start", 1],
        ["boundary", 2],
        ["terminal", 3],
        ["patch", 4],
        ["start", 5],
        ["noise", 6],
        ["tool-update", 7],
        ["tool-end", 8],
      ],
    );
    const evidence = sql<{
      readonly activity_id: string;
      readonly task_id: string | null;
      readonly tool_use_id: string | null;
      readonly status: string | null;
      readonly status_type: string | null;
      readonly backgrounded_type: string | null;
      readonly tool_id: string | null;
    }>`
      SELECT thread_id, activity_id, kind,
        json_extract(payload_json, '$.taskId') AS task_id,
        json_extract(payload_json, '$.toolUseId') AS tool_use_id,
        json_extract(payload_json, '$.status') AS status,
        json_type(payload_json, '$.status') AS status_type,
        json_type(payload_json, '$.isBackgrounded') AS backgrounded_type,
        COALESCE(json_extract(payload_json, '$.data.toolCallId'),
          json_extract(payload_json, '$.data.toolUseId')) AS tool_id
      FROM projection_thread_activities INDEXED BY idx_projection_activities_task_evidence
      WHERE thread_id = 'activity-index-thread'
        AND kind IN (
          'task.started', 'task.updated', 'task.completed', 'provider.session.boundary',
          'tool.started', 'tool.updated', 'tool.completed'
        )
      ORDER BY activity_id
    `;
    const evidenceRows = yield* evidence;
    assert.deepStrictEqual(
      evidenceRows.map((row) => row.activity_id),
      ["boundary", "patch", "start", "terminal", "tool-end", "tool-start", "tool-update"],
    );
    assert.deepStrictEqual(
      evidenceRows.map((row) => [
        row.task_id,
        row.tool_use_id,
        row.status,
        row.status_type,
        row.backgrounded_type,
        row.tool_id,
      ]),
      [
        [null, null, null, null, null, null],
        ["task", null, "running", "text", "false", null],
        ["task", "tool", null, null, null, null],
        ["task", null, null, "null", null, null],
        [null, null, null, null, null, "tool"],
        [null, null, null, null, null, "preferred"],
        [null, null, null, null, null, "tool"],
      ],
    );
    const table = yield* sql<{ readonly rootpage: number }>`
      SELECT rootpage FROM sqlite_schema WHERE name = 'projection_thread_activities'
    `;
    for (const [indexName, query] of [
      ["idx_projection_activities_detail_rank_covering", ranks],
      ["idx_projection_activities_task_evidence", evidence],
    ] as const) {
      const [statement, parameters] = query.compile();
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
        parameters,
      );
      assert.isTrue(plan.some((row) => row.detail.includes(indexName)));
      const opcodes = yield* sql.unsafe<{
        readonly opcode: string;
        readonly p1: number;
        readonly p2: number;
        readonly p3: number;
      }>(`EXPLAIN ${statement}`, parameters);
      const tableCursors = new Set(
        opcodes
          .filter(
            (row) => row.opcode === "OpenRead" && row.p2 === table[0]?.rootpage && row.p3 === 0,
          )
          .map((row) => row.p1),
      );
      // Expression indexes may retain an unused table cursor and DeferredSeek.
      assert.isFalse(opcodes.some((row) => row.opcode === "Column" && tableCursors.has(row.p1)));
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "seeks interaction resolutions by thread and typed request ID without changing history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createProjections;
      yield* addActivitySequence;
      const activities = [
        ["approval", "approval.resolved", { requestId: "wanted" }],
        ["approval-failed", "provider.approval.respond.failed", { requestId: "wanted" }],
        ["input", "user-input.resolved", { requestId: "wanted" }],
        ["input-failed", "provider.user-input.respond.failed", { requestId: "wanted" }],
        ["ignored", "approval.requested", { requestId: "wanted" }],
        ["numeric", "approval.resolved", { requestId: 7 }],
        ["text", "approval.resolved", { requestId: "7" }],
        ["null", "approval.resolved", { requestId: null }],
        ["missing", "approval.resolved", {}],
      ] as const;
      for (const [activityId, kind, payload] of activities) {
        yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES (${activityId}, 'interaction-index-thread', 'turn', 'info', ${kind}, 'Keep this',
          ${JSON.stringify(payload)}, 1, '2026-10-08T00:00:00.000Z')`;
      }
      yield* sql`INSERT INTO projection_thread_activities
      (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
      VALUES ('other-thread', 'other', NULL, 'info', 'approval.resolved', 'Keep this too',
        '{"requestId":"wanted"}', 100, '2026-10-08T00:00:00.000Z')`;
      const readRows = sql`SELECT * FROM projection_thread_activities ORDER BY activity_id`;
      const before = yield* readRows;
      yield* migration;
      yield* migration;
      assert.deepStrictEqual(yield* readRows, before);

      const resolutions = (requestId: string | number) => sql<{ readonly activity_id: string }>`
      SELECT activity_id
      FROM projection_thread_activities INDEXED BY idx_projection_activities_interaction_resolution
      WHERE thread_id = 'interaction-index-thread'
        AND json_extract(payload_json, '$.requestId') = ${requestId}
        AND kind IN (
          'approval.resolved', 'provider.approval.respond.failed',
          'user-input.resolved', 'provider.user-input.respond.failed'
        )
      ORDER BY activity_id
    `;
      const query = resolutions("wanted");
      assert.deepStrictEqual(
        (yield* query).map((row) => row.activity_id),
        ["approval", "approval-failed", "input", "input-failed"],
      );
      assert.deepStrictEqual(yield* resolutions(7), [{ activity_id: "numeric" }]);
      assert.deepStrictEqual(yield* resolutions("7"), [{ activity_id: "text" }]);
      assert.deepStrictEqual(yield* resolutions("absent"), []);

      const [statement, parameters] = query.compile();
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
        parameters,
      );
      assert.isTrue(
        plan.some(
          (row) =>
            row.detail.includes("SEARCH projection_thread_activities") &&
            row.detail.includes("idx_projection_activities_interaction_resolution") &&
            row.detail.includes("thread_id=?") &&
            row.detail.includes("<expr>=?"),
        ),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
