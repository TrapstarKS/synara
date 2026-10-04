import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("Queued steer replacement migration", (it) => {
  it.effect("adds the exact replaced turn and backfills causal queued steers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-04T20:00:00.000Z";
      yield* runMigrations({ toMigrationInclusive: 121 });

      const queued = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-122-queued', 'thread', 'thread-122', 0,
          'thread.turn-queued', ${now}, 'command-122-steer',
          NULL, NULL, 'user',
          '{"threadId":"thread-122","messageId":"message-122","dispatchMode":"steer"}', '{}'
        )
        RETURNING sequence
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-122-interrupt', 'thread', 'thread-122', 1,
          'thread.turn-interrupt-requested', ${now}, 'command-122-steer',
          'event-122-queued', NULL, 'user',
          '{"threadId":"thread-122","turnId":"turn-122-replaced"}', '{}'
        )
      `;
      yield* sql`
        INSERT INTO queued_turn_promotions (
          queued_event_sequence, thread_id, message_id, dispatch_mode, state,
          claim_owner, claimed_at, claim_expires_at, attempt_count,
          created_at, updated_at, promoted_at
        ) VALUES (
          ${queued[0]!.sequence}, 'thread-122', 'message-122', 'steer', 'promoted',
          NULL, NULL, NULL, 1, ${now}, ${now}, ${now}
        )
      `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 122 }), [
        [122, "QueuedSteerReplacementTurns"],
      ]);
      const rows = yield* sql<{
        readonly replacedTurnId: string | null;
      }>`
        SELECT replaced_turn_id AS "replacedTurnId"
        FROM queued_turn_promotions
        WHERE queued_event_sequence = ${queued[0]!.sequence}
      `;
      assert.deepStrictEqual(rows, [{ replacedTurnId: "turn-122-replaced" }]);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_queued_turn_promotions_replaced_turn'
      `;
      assert.deepStrictEqual(indexes, [{ name: "idx_queued_turn_promotions_replaced_turn" }]);
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 122 }), []);
    }),
  );
});
