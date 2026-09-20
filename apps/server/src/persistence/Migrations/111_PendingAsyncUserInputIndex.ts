import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Shell badges need to find unanswered questions without scanning message bodies.
// The partial index also covers questions predating the retained transcript tail.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_messages_pending_async_input
    ON projection_thread_messages (thread_id)
    WHERE role = 'assistant' AND async_user_input_json IS NOT NULL
      AND json_extract(async_user_input_json, '$.response') IS NULL`;
});
