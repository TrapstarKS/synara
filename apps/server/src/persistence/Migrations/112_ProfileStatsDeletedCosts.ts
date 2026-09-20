import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Profile metrics are lifetime totals. Once a thread is hard-purged its provider
// cost activities disappear, so retain only the aggregate USD amount and how
// many turns that amount covers. No prompt/model text is needed for this metric.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS profile_stats_deleted_costs (
      thread_id TEXT PRIMARY KEY,
      cost_usd REAL NOT NULL CHECK(cost_usd >= 0),
      covered_turn_count INTEGER NOT NULL CHECK(covered_turn_count >= 0)
    )
  `;
});
