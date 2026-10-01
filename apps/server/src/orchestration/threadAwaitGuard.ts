import type { ThreadAwaitPrecondition, ThreadId, TurnId } from "@synara/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeCompletionRepository } from "../agentGateway/completionRepository.ts";
import { makeNativeTurnCompletionReader } from "../agentGateway/pinnedThreadResult.ts";
import { makeCoordinatorAnswerAuthority } from "../agentGateway/coordinatorAnswerAuthority.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { PROVIDER_COMMAND_REACTOR_CONSUMER } from "../persistence/Services/OrchestrationEventDeliveries.ts";

export const THREAD_AWAIT_DEFERRED = "Await continuation deferred:";

export type ThreadAwaitGuardResult =
  | { readonly status: "ready" }
  | { readonly status: "defer" | "cancelled"; readonly reason: string };

export interface ThreadAwaitGuardInput {
  readonly threadId: ThreadId;
  readonly precondition: ThreadAwaitPrecondition;
  readonly stage?: "admission" | "delivery" | "accepted";
  readonly messageId?: string;
  readonly commandId?: string;
  readonly eventSequence?: number;
  readonly acceptedTurnId?: TurnId;
}

export const makeThreadAwaitGuard = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const completions = yield* makeCompletionRepository;
  const readNativeCompletion = yield* makeNativeTurnCompletionReader;
  const mayAnswerExecutor = yield* makeCoordinatorAnswerAuthority;

  const check = (
    input: ThreadAwaitGuardInput,
    linkDepth = 0,
  ): Effect.Effect<ThreadAwaitGuardResult, PersistenceSqlError> =>
    Effect.gen(function* (): Effect.fn.Return<ThreadAwaitGuardResult, unknown> {
      const { threadId, precondition } = input;
      const stage = input.stage ?? "admission";
      const rows = yield* sql<{
        state: string;
        requestJson: string;
        messageId: string | null;
        commandId: string | null;
      }>`SELECT state, request_json AS "requestJson", json_extract(dispatch_json, '$.message.messageId') AS "messageId",
        json_extract(dispatch_json, '$.commandId') AS "commandId"
        FROM agent_gateway_waits
        WHERE wait_id = ${precondition.waitId} AND caller_thread_id = ${threadId}
          AND caller_turn_id = ${precondition.sourceTurnId}
          AND registered_sequence = ${precondition.registeredSequence}`;
      const wait = rows[0];
      if (
        !wait ||
        wait.state === "cancelled" ||
        (stage === "admission" && wait.state === "dispatched") ||
        (input.messageId !== undefined && wait.messageId !== input.messageId) ||
        (input.commandId !== undefined && wait.commandId !== input.commandId)
      ) {
        return { status: "cancelled", reason: "The saved wait no longer owns this continuation." };
      }
      const messageId = wait.messageId;
      const metadata = yield* sql<{
        kind: string | null;
        questionId: string | null;
        rootWaitId: string | null;
      }>`SELECT json_extract(${wait.requestJson}, '$.kind') AS kind,
        json_extract(${wait.requestJson}, '$.questionId') AS "questionId",
        json_extract(${wait.requestJson}, '$.coordinationRootWaitId') AS "rootWaitId"`;
      const coordination = metadata[0];
      if (coordination?.rootWaitId) {
        const roots = yield* sql<{ state: string }>`SELECT state FROM agent_gateway_waits
          WHERE wait_id = ${coordination.rootWaitId}`;
        if (!roots[0] || roots[0].state === "cancelled") {
          return {
            status: "cancelled",
            reason: "The delegation that owned this wait was cancelled.",
          };
        }
      }
      const cancelledRoots = yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM agent_gateway_coordinator_questions AS question
        LEFT JOIN agent_gateway_waits AS root ON root.wait_id = question.root_wait_id
        WHERE question.rearmed_wait_id = ${precondition.waitId}
          AND (root.wait_id IS NULL OR root.state = 'cancelled')`;
      if ((cancelledRoots[0]?.count ?? 0) > 0) {
        return {
          status: "cancelled",
          reason: "An owning delegation was cancelled before this continuation.",
        };
      }
      if (coordination?.kind === "coordinator-answer") {
        const links = yield* sql<{
          state: string;
          answerSource: string | null;
          threadId: ThreadId;
          waitId: string;
          sourceTurnId: TurnId;
          registeredSequence: number;
        }>`SELECT question.state, question.answer_source AS "answerSource", parent.caller_thread_id AS "threadId", parent.wait_id AS "waitId",
            parent.caller_turn_id AS "sourceTurnId", parent.registered_sequence AS "registeredSequence"
          FROM agent_gateway_coordinator_questions AS question
          JOIN agent_gateway_waits AS parent ON parent.wait_id = COALESCE(question.rearmed_wait_id, question.wait_id)
          WHERE question.question_id = ${coordination.questionId}
            AND question.answer_wait_id = ${precondition.waitId}
            AND question.executor_thread_id = ${threadId}
            AND question.executor_turn_id = ${precondition.sourceTurnId}`;
        const link = links[0];
        if (!link || link.state === "cancelled" || linkDepth >= 4) {
          return {
            status: "cancelled",
            reason: "The coordinator question no longer owns this answer.",
          };
        }
        if (
          link.answerSource === "coordinator" &&
          !(yield* mayAnswerExecutor(link.threadId, threadId))
        ) {
          return {
            status: "cancelled",
            reason: "The coordinator can no longer drive this executor's execution permissions.",
          };
        }
        const parent = yield* check(
          {
            threadId: link.threadId,
            precondition: {
              waitId: link.waitId,
              sourceTurnId: link.sourceTurnId,
              registeredSequence: link.registeredSequence,
            },
            stage: "accepted",
          },
          linkDepth + 1,
        );
        if (parent.status !== "ready") return parent;
        if (
          stage !== "accepted" &&
          (input.messageId !== undefined || input.commandId !== undefined) &&
          link.state !== "answering" &&
          link.state !== "answered"
        ) {
          return {
            status: "defer",
            reason: "The executor is waiting for the coordinator's answer.",
          };
        }
      } else if (
        stage !== "accepted" &&
        (input.messageId !== undefined || input.commandId !== undefined)
      ) {
        const questions = yield* sql<{ count: number }>`SELECT count(*) AS count
          FROM agent_gateway_coordinator_questions WHERE wait_id = ${precondition.waitId}
            AND state IN ('asked', 'notified', 'human')
            AND NOT EXISTS (SELECT 1 FROM agent_gateway_coordinator_questions AS notification
              WHERE notification.notification_wait_id = ${precondition.waitId})`;
        if ((questions[0]?.count ?? 0) > 0) {
          return {
            status: "defer",
            reason: "An executor question must be resolved before final results.",
          };
        }
      }
      const threads = yield* sql<{
        archivedAt: string | null;
        deletedAt: string | null;
        expiredAt: string | null;
        parentThreadId: string | null;
        latestTurnId: string | null;
        sessionStatus: string | null;
        activeTurnId: string | null;
        reviewMessageId: string | null;
        reviewStatus: string | null;
        compactionTurnId: string | null;
      }>`SELECT thread.archived_at AS "archivedAt", thread.deleted_at AS "deletedAt",
          thread.sidechat_expired_at AS "expiredAt", thread.parent_thread_id AS "parentThreadId",
          (SELECT turn_id FROM projection_turns AS latest
            WHERE latest.thread_id = thread.thread_id AND turn_id IS NOT NULL
            ORDER BY requested_at DESC, turn_id DESC LIMIT 1) AS "latestTurnId",
          session.status AS "sessionStatus",
          session.active_turn_id AS "activeTurnId",
          json_extract(thread.claude_cache_review_json, '$.messageId') AS "reviewMessageId",
          json_extract(thread.claude_cache_review_json, '$.status') AS "reviewStatus",
          json_extract(thread.claude_cache_review_json, '$.compactionTurnId') AS "compactionTurnId"
        FROM projection_threads AS thread
        LEFT JOIN projection_thread_sessions AS session ON session.thread_id = thread.thread_id
        WHERE thread.thread_id = ${threadId}`;
      const thread = threads[0];
      if (
        !thread ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        thread.expiredAt !== null ||
        thread.parentThreadId !== null
      ) {
        return { status: "cancelled", reason: "The waiting thread is unavailable." };
      }
      const ownTurns = messageId
        ? yield* sql<{ turnId: string }>`SELECT turn_id AS "turnId" FROM projection_turns
            WHERE thread_id = ${threadId} AND pending_message_id = ${messageId}
              AND turn_id IS NOT NULL`
        : [];
      const ownTurnId = input.acceptedTurnId ?? ownTurns[0]?.turnId ?? null;
      const compactionTurnId =
        messageId !== null && thread.reviewMessageId === messageId ? thread.compactionTurnId : null;
      const revoked = yield* sql<{ eventType: string }>`
        SELECT event_type AS "eventType" FROM orchestration_events
        WHERE stream_id = ${threadId} AND sequence > ${precondition.registeredSequence}
          AND (
            event_type IN ('thread.turn-interrupt-requested', 'thread.session-stop-requested',
              'thread.archived', 'thread.deleted', 'thread.sidechat-expired',
              'thread.conversation-rollback-requested', 'thread.conversation-rolled-back',
              'thread.message-edit-resend-requested', 'thread.provider-handoff-requested',
              'thread.revert-requested')
            OR (event_type = 'thread.message-sent' AND json_extract(payload_json, '$.role') = 'user'
              AND (${messageId} IS NULL OR json_extract(payload_json, '$.messageId') <> ${messageId}))
            OR (event_type IN ('thread.turn-start-requested', 'thread.turn-queued')
              AND (${messageId} IS NULL OR json_extract(payload_json, '$.messageId') <> ${messageId}))
            OR (event_type = 'thread.session-set'
              AND json_extract(payload_json, '$.session.status') IN ('interrupted', 'error'))
            OR (event_type = 'thread.activity-appended'
              AND json_extract(payload_json, '$.activity.kind') = 'checkpoint.revert.started')
          )
        ORDER BY sequence LIMIT 1`;
      if (revoked.length > 0) {
        return {
          status: "cancelled",
          reason: `The wait was superseded by ${revoked[0]!.eventType}.`,
        };
      }
      if (stage === "accepted") return { status: "ready" };

      const sourceTurns = yield* sql<{ state: string }>`SELECT state FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${precondition.sourceTurnId}`;
      const source = sourceTurns[0];
      if (!source) {
        return { status: "cancelled", reason: "The requesting turn is no longer available." };
      }
      if (source.state === "pending" || source.state === "running") {
        return { status: "defer", reason: "The requesting turn has not finished." };
      }
      if (source.state !== "completed") {
        return {
          status: "cancelled",
          reason: "The requesting turn did not complete successfully.",
        };
      }
      if (
        thread.latestTurnId !== precondition.sourceTurnId &&
        !(
          stage === "delivery" &&
          ((ownTurnId !== null && thread.latestTurnId === ownTurnId) ||
            (compactionTurnId !== null && thread.latestTurnId === compactionTurnId))
        )
      ) {
        return { status: "cancelled", reason: "Another turn superseded the requesting turn." };
      }
      const terminal = yield* readNativeCompletion(threadId, precondition.sourceTurnId);
      if (terminal && terminal.state !== "completed") {
        return {
          status: "cancelled",
          reason: "The requesting provider turn did not complete successfully.",
        };
      }
      if (
        terminal?.state !== "completed" &&
        !(yield* completions.hasCompletedRun(threadId, precondition.sourceTurnId))
      ) {
        return {
          status: "defer",
          reason: "The requesting provider turn has not confirmed completion.",
        };
      }
      if (stage === "admission" && !(yield* completions.isOutputSettled(threadId))) {
        return { status: "defer", reason: "The requesting turn's output is still being recorded." };
      }
      const queued = yield* sql<{ count: number }>`SELECT count(*) AS count FROM (
          SELECT pending_message_id AS message_id FROM projection_turns
          WHERE thread_id = ${threadId} AND state = 'pending' AND turn_id IS NULL
          UNION ALL
          SELECT message_id FROM queued_turn_promotions
          WHERE thread_id = ${threadId} AND state IN ('queued', 'promoting')
        ) WHERE ${messageId} IS NULL OR message_id <> ${messageId}`;
      if ((queued[0]?.count ?? 0) > 0) {
        return {
          status: "cancelled",
          reason: "Queued work takes precedence over this continuation.",
        };
      }
      const pendingQueues = yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM orchestration_events WHERE stream_id = ${threadId} AND event_type = 'thread.turn-queued'
          AND sequence > COALESCE((SELECT last_acked_sequence FROM orchestration_consumer_state
            WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}), 0)
          AND (${messageId} IS NULL OR json_extract(payload_json, '$.messageId') <> ${messageId})`;
      if ((pendingQueues[0]?.count ?? 0) > 0) {
        return { status: "defer", reason: "Queued work is still being recorded." };
      }
      if (
        (stage === "admission" &&
          (thread.sessionStatus === "starting" || thread.sessionStatus === "running")) ||
        (thread.activeTurnId !== null && thread.activeTurnId !== ownTurnId)
      ) {
        return { status: "defer", reason: "The provider session still has work in flight." };
      }
      const interactions = yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM projection_pending_interactions WHERE thread_id = ${threadId}
          AND (status IN ('pending', 'retryable', 'responding')
            OR (interaction_kind = 'userInput' AND status = 'uncertain'))`;
      if ((interactions[0]?.count ?? 0) > 0) {
        return { status: "defer", reason: "A pending approval or question needs attention." };
      }
      const questions = yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM projection_thread_messages WHERE thread_id = ${threadId} AND role = 'assistant'
          AND async_user_input_json IS NOT NULL
          AND json_extract(async_user_input_json, '$.response') IS NULL`;
      if ((questions[0]?.count ?? 0) > 0) {
        return { status: "defer", reason: "An asynchronous question needs attention." };
      }
      if (
        thread.reviewStatus !== null &&
        !(
          stage === "delivery" &&
          thread.reviewMessageId === messageId &&
          thread.reviewStatus === "responding"
        )
      ) {
        return { status: "defer", reason: "Claude cache review is pending." };
      }
      const blockers = yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM orchestration_event_deliveries WHERE thread_id = ${threadId}
          AND consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
          AND state IN ('inflight', 'retry', 'uncertain', 'dead')
          AND event_sequence <> ${input.eventSequence ?? -1}`;
      if ((blockers[0]?.count ?? 0) > 0) {
        return { status: "defer", reason: "A previous provider delivery has not been settled." };
      }
      return { status: "ready" };
    }).pipe(Effect.mapError(toPersistenceSqlError("ThreadAwaitGuard.check")));

  const hasPending = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        waitId: string;
        sourceTurnId: TurnId;
        registeredSequence: number;
      }>`SELECT wait_id AS "waitId", caller_turn_id AS "sourceTurnId",
          registered_sequence AS "registeredSequence"
        FROM agent_gateway_waits AS wait WHERE caller_thread_id = ${threadId}
          AND (state IN ('waiting', 'dispatching') OR (state = 'dispatched' AND (NOT EXISTS (
            SELECT 1 FROM projection_turns AS turn WHERE turn.thread_id = wait.caller_thread_id
              AND turn.pending_message_id = json_extract(wait.dispatch_json, '$.message.messageId')
              AND turn.turn_id IS NOT NULL) OR EXISTS (
            SELECT 1 FROM agent_gateway_coordinator_questions AS question
            WHERE question.wait_id = wait.wait_id AND question.coordinator_thread_id = wait.caller_thread_id
              AND question.state IN ('asked', 'notified', 'human', 'answering')))))`;
      for (const precondition of rows) {
        if ((yield* check({ threadId, precondition, stage: "accepted" })).status === "ready") {
          return true;
        }
      }
      return false;
    }).pipe(Effect.mapError(toPersistenceSqlError("ThreadAwaitGuard.hasPending")));

  const cancel = (input: Pick<ThreadAwaitGuardInput, "threadId" | "precondition">) =>
    sql`UPDATE agent_gateway_waits SET state = 'cancelled', settled_at = ${new Date().toISOString()}
      WHERE wait_id = ${input.precondition.waitId} AND caller_thread_id = ${input.threadId}
        AND caller_turn_id = ${input.precondition.sourceTurnId}
        AND registered_sequence = ${input.precondition.registeredSequence}
        AND state <> 'cancelled'`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ThreadAwaitGuard.cancel")),
    );

  return { check, hasPending, cancel };
});
