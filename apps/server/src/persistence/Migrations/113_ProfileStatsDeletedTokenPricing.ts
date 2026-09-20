import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS profile_stats_deleted_token_pricing (
      thread_id TEXT NOT NULL,
      row_index INTEGER NOT NULL CHECK(row_index >= 0),
      provider TEXT,
      model TEXT,
      input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
      cached_input_tokens INTEGER NOT NULL CHECK(cached_input_tokens >= 0),
      cache_write_input_tokens INTEGER NOT NULL CHECK(cache_write_input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
      fast_mode INTEGER CHECK(fast_mode IN (0, 1) OR fast_mode IS NULL),
      last_input_tokens INTEGER CHECK(last_input_tokens >= 0 OR last_input_tokens IS NULL),
      PRIMARY KEY (thread_id, row_index)
    )
  `;
});
