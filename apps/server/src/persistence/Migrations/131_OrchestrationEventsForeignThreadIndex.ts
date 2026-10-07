import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Additive: thread purges also delete thread events whose payload names the
// thread under another stream. Without an index that predicate scanned every
// event, so deleting one thread froze a large database for over a minute. The
// partial index holds only those rare rows.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_foreign_payload_thread
    ON orchestration_events (json_extract(payload_json, '$.threadId'))
    WHERE aggregate_kind = 'thread'
      AND json_extract(payload_json, '$.threadId') <> stream_id
  `;
});
