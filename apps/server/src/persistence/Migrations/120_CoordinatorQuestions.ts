import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS agent_gateway_coordinator_questions (
    question_id TEXT PRIMARY KEY,
    root_wait_id TEXT NOT NULL,
    wait_id TEXT NOT NULL,
    coordinator_thread_id TEXT NOT NULL,
    executor_thread_id TEXT NOT NULL,
    executor_turn_id TEXT NOT NULL,
    executor_message_id TEXT,
    registered_sequence INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 4000),
    state TEXT NOT NULL DEFAULT 'asked'
      CHECK (state IN ('asked', 'notified', 'human', 'answering', 'answered', 'cancelled')),
    answer TEXT CHECK (answer IS NULL OR length(answer) BETWEEN 1 AND 8000),
    answer_source TEXT CHECK (answer_source IS NULL OR answer_source IN ('coordinator', 'human')),
    escalation_reason TEXT CHECK (escalation_reason IS NULL OR length(escalation_reason) <= 2000),
    notification_wait_id TEXT,
    answer_wait_id TEXT NOT NULL,
    rearmed_wait_id TEXT,
    coordinator_turn_id TEXT,
    coordinator_registered_sequence INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    escalated_at TEXT,
    answered_at TEXT,
    UNIQUE (executor_thread_id, executor_turn_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_coordinator_questions_wait
    ON agent_gateway_coordinator_questions(wait_id, state)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_coordinator_questions_root
    ON agent_gateway_coordinator_questions(root_wait_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_coordinator_questions_coordinator
    ON agent_gateway_coordinator_questions(coordinator_thread_id, state, created_at)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_questions_answer_wait
    ON agent_gateway_coordinator_questions(answer_wait_id)`;
});
