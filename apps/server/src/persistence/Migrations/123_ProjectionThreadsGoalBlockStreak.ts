import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "goal_block_count"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_block_count INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "goal_block_last_turn_id"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_block_last_turn_id TEXT
    `;
  }
});
