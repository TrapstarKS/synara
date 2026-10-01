import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SynaraWaitedThreadResult, type CoordinatorQuestion } from "@synara/contracts";
import { GatewayToolError } from "./toolRuntime.ts";

export interface CoordinatorQuestionRow extends CoordinatorQuestion {
  readonly rootWaitId: string;
  readonly executorMessageId: string | null;
  readonly registeredSequence: number;
  readonly requestId: string;
  readonly answerSource: "coordinator" | "human" | null;
  readonly notificationWaitId: string | null;
  readonly answerWaitId: string;
  readonly rearmedWaitId: string | null;
  readonly coordinatorTurnId: string | null;
  readonly coordinatorRegisteredSequence: number | null;
  readonly escalatedAt: string | null;
  readonly answeredAt: string | null;
}

export const QuestionWaitTargets = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      pin: Schema.Struct({
        threadId: Schema.String,
        runId: Schema.NullOr(Schema.String),
        messageId: Schema.NullOr(Schema.String),
      }),
      result: Schema.NullOr(SynaraWaitedThreadResult),
    }),
  ),
);
export const decodeQuestionWaitTargets = Schema.decodeUnknownEffect(QuestionWaitTargets);

export const questionAnswerMessageId = (questionId: string) => `${questionId}:answer-message`;

export function readQuestionWaitMetadata(requestJson: string): {
  readonly kind?: string;
  readonly questionId?: string;
  readonly coordinationRootWaitId?: string;
  readonly coordinationParentWaitId?: string;
} {
  const request: unknown = JSON.parse(requestJson);
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new GatewayToolError("operation_failed", "Saved wait metadata is invalid.");
  }
  const fields = [
    "kind",
    "questionId",
    "coordinationRootWaitId",
    "coordinationParentWaitId",
  ] as const;
  const result: Record<string, string> = {};
  for (const field of fields) {
    if (field in request) {
      const value = (request as Record<string, unknown>)[field];
      if (typeof value !== "string") {
        throw new GatewayToolError("operation_failed", "Saved wait metadata is invalid.");
      }
      result[field] = value;
    }
  }
  return result;
}

export const makeCoordinatorQuestionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(`question_id AS "questionId", root_wait_id AS "rootWaitId",
    wait_id AS "waitId", coordinator_thread_id AS "coordinatorThreadId",
    executor_thread_id AS "executorThreadId", executor_turn_id AS "executorTurnId",
    executor_message_id AS "executorMessageId", registered_sequence AS "registeredSequence",
    request_id AS "requestId", question, state, answer, answer_source AS "answerSource",
    escalation_reason AS "escalationReason", notification_wait_id AS "notificationWaitId",
    answer_wait_id AS "answerWaitId", rearmed_wait_id AS "rearmedWaitId",
    coordinator_turn_id AS "coordinatorTurnId", coordinator_registered_sequence AS "coordinatorRegisteredSequence",
    created_at AS "createdAt", updated_at AS "updatedAt", escalated_at AS "escalatedAt", answered_at AS "answeredAt"`);
  const get = (questionId: string) =>
    sql<CoordinatorQuestionRow>`SELECT ${columns}
    FROM agent_gateway_coordinator_questions WHERE question_id = ${questionId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );
  const forWait = (waitId: string) => sql<CoordinatorQuestionRow>`SELECT ${columns}
    FROM agent_gateway_coordinator_questions WHERE wait_id = ${waitId}
    ORDER BY created_at, question_id LIMIT 401`;
  const pending = () => sql<CoordinatorQuestionRow>`SELECT ${columns}
    FROM agent_gateway_coordinator_questions WHERE state NOT IN ('answered', 'cancelled')
    ORDER BY created_at, question_id LIMIT 200`;
  const list = (input: { readonly threadId?: string }) =>
    sql<CoordinatorQuestionRow>`SELECT ${columns}
    FROM agent_gateway_coordinator_questions WHERE state NOT IN ('answered', 'cancelled')
      AND ${input.threadId === undefined ? sql`1 = 1` : sql`coordinator_thread_id = ${input.threadId}`}
    ORDER BY created_at, question_id LIMIT 200`.pipe(
      Effect.map((rows) =>
        rows.map(
          (row): CoordinatorQuestion => ({
            questionId: row.questionId,
            waitId: row.waitId,
            coordinatorThreadId: row.coordinatorThreadId,
            executorThreadId: row.executorThreadId,
            executorTurnId: row.executorTurnId,
            question: row.question,
            state: row.state,
            answer: row.answer,
            escalationReason: row.escalationReason,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }),
        ),
      ),
    );
  return { get, forWait, pending, list };
});
