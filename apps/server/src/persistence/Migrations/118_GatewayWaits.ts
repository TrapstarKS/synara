import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS agent_gateway_waits (
    wait_id TEXT PRIMARY KEY,
    caller_thread_id TEXT NOT NULL,
    caller_turn_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    targets_json TEXT NOT NULL,
    registered_sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting'
      CHECK (state IN ('waiting', 'dispatching', 'dispatched', 'cancelled')),
    dispatch_json TEXT,
    settled_at TEXT,
    UNIQUE (caller_thread_id, caller_turn_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_gateway_waits_pending
    ON agent_gateway_waits(state, created_at)`;
});
