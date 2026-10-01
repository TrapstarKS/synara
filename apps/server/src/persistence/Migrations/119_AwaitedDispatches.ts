import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS agent_gateway_awaited_dispatches (
    dispatch_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('creation', 'send')),
    caller_thread_id TEXT NOT NULL,
    caller_turn_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    wait_id TEXT NOT NULL REFERENCES agent_gateway_waits(wait_id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    command_id TEXT,
    command_json TEXT,
    pins_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'accepted', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (caller_thread_id, caller_turn_id, kind, request_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_awaited_dispatches_wait
    ON agent_gateway_awaited_dispatches(wait_id, state)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_awaited_dispatches_pending
    ON agent_gateway_awaited_dispatches(state, created_at)`;
});
