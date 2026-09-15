import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Early Codex-profile builds kept the account in the provider runtime but a
// later turn could erase it from the thread projection. Restore the binding
// from the runtime that actually handled the thread.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = json_set(
      model_selection_json,
      '$.profileId',
      (
        SELECT json_extract(runtime_payload_json, '$.providerOptions.codex.profileId')
        FROM provider_session_runtime
        WHERE provider_session_runtime.thread_id = projection_threads.thread_id
      )
    )
    WHERE json_extract(model_selection_json, '$.provider') = 'codex'
      AND json_type(model_selection_json, '$.profileId') IS NULL
      AND EXISTS (
        SELECT 1
        FROM provider_session_runtime
        WHERE provider_session_runtime.thread_id = projection_threads.thread_id
          AND json_type(runtime_payload_json, '$.providerOptions.codex.profileId') = 'text'
      )
  `;
});
