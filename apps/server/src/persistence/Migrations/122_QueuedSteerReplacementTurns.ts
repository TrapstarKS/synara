import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('queued_turn_promotions')
  `;
  if (!columns.some((column) => column.name === "replaced_turn_id")) {
    yield* sql`
      ALTER TABLE queued_turn_promotions ADD COLUMN replaced_turn_id TEXT
    `;
  }

  // Older rows created through the decider already retain the exact queued
  // event -> interrupt intent link. Backfill those so an update that lands while
  // a steer is in flight preserves the goal across the interrupted old turn.
  yield* sql`
    UPDATE queued_turn_promotions AS promotion
    SET replaced_turn_id = (
      SELECT json_extract(interrupt.payload_json, '$.turnId')
      FROM orchestration_events AS queued
      JOIN orchestration_events AS interrupt
        ON interrupt.causation_event_id = queued.event_id
       AND interrupt.event_type = 'thread.turn-interrupt-requested'
      WHERE queued.sequence = promotion.queued_event_sequence
        AND queued.stream_id = promotion.thread_id
        AND json_extract(interrupt.payload_json, '$.turnId') IS NOT NULL
      ORDER BY interrupt.sequence DESC
      LIMIT 1
    )
    WHERE promotion.dispatch_mode = 'steer'
      AND promotion.replaced_turn_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS queued
        JOIN orchestration_events AS interrupt
          ON interrupt.causation_event_id = queued.event_id
         AND interrupt.event_type = 'thread.turn-interrupt-requested'
        WHERE queued.sequence = promotion.queued_event_sequence
          AND queued.stream_id = promotion.thread_id
          AND json_extract(interrupt.payload_json, '$.turnId') IS NOT NULL
      )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_queued_turn_promotions_replaced_turn
    ON queued_turn_promotions(thread_id, replaced_turn_id, state)
    WHERE dispatch_mode = 'steer' AND replaced_turn_id IS NOT NULL
  `;
});
