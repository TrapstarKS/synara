import { ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { buildThreadTitleHighWaterSequenceQuery } from "../Layers/OrchestrationEventStore.ts";
import createEvents from "./001_OrchestrationEvents.ts";
import createTitleIndex from "./132_OrchestrationThreadTitleIndex.ts";

it.layer(NodeSqliteClient.layerMemory())("thread title fences", (it) => {
  it.effect("keeps title and lifecycle fences on the sparse index without changing history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createEvents;
      const threadId = ThreadId.makeUnsafe("title-index-thread");
      const events = [
        ["thread.created", "{}", true],
        ["thread.message-sent", '{"text":"delta"}', false],
        ["thread.meta-updated", '{"title":"Renamed"}', true],
        ["thread.meta-updated", '{"title":null}', false],
        ["thread.meta-updated", '{"title":12}', false],
        ["thread.meta-updated", '{"goal":"Goal"}', false],
        ["thread.archived", "{}", true],
        ["thread.unarchived", "{}", false],
        ["thread.deleted", "{}", true],
        ["thread.message-sent", '{"text":"later delta"}', false],
      ] as const;
      yield* createTitleIndex;
      // Re-running the additive migration must preserve rows and the existing index.
      yield* createTitleIndex;
      let expected = 0;
      const query = buildThreadTitleHighWaterSequenceQuery(sql, threadId);
      assert.strictEqual((yield* query)[0]?.highWaterSequence, 0);
      for (const [index, [type, payload, affectsTitle]] of events.entries()) {
        const sequence = index + 1;
        yield* sql`INSERT INTO orchestration_events
          (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${sequence}, ${`title-${sequence}`}, 'thread', ${threadId}, ${index}, ${type},
            '2026-10-08T00:00:00.000Z', 'system', ${payload}, '{}')`;
        if (affectsTitle) expected = sequence;
        assert.strictEqual((yield* query)[0]?.highWaterSequence, expected);
      }
      assert.strictEqual(
        (yield* buildThreadTitleHighWaterSequenceQuery(sql, ThreadId.makeUnsafe("missing")))[0]
          ?.highWaterSequence,
        0,
      );
      const [statement, parameters] = query.compile();
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
        parameters,
      );
      assert.isTrue(
        plan.some((row) => row.detail.includes("idx_orch_events_thread_title_sequence")),
      );
      assert.isFalse(plan.some((row) => row.detail.includes("idx_orch_events_stream_sequence")));
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM orchestration_events`)[0]
          ?.count,
        events.length,
      );
    }),
  );
});
