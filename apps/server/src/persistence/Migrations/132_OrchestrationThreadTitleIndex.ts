import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Title fences must not walk a thread's entire streaming history on every send.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_thread_title_sequence
    ON orchestration_events (stream_id, sequence)
    WHERE aggregate_kind = 'thread'
      AND (
        event_type IN ('thread.created', 'thread.archived', 'thread.deleted')
        OR (event_type = 'thread.meta-updated' AND json_type(payload_json, '$.title') = 'text')
      )
  `;
});
