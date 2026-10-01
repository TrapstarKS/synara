import {
  CommandId,
  EventId,
  MessageId,
  SynaraAskCoordinatorInput,
  SynaraAnswerQuestionInput,
  ThreadCoordinationAnswerQuestionInput,
  ThreadId,
  ThreadTurnStartCommand,
  TurnId,
  type SynaraWaitedThreadResult,
} from "@synara/contracts";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeThreadAwaitGuard, THREAD_AWAIT_DEFERRED } from "../orchestration/threadAwaitGuard.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import { makeAwaitRepository, type GatewayWaitRow } from "./awaitRepository.ts";
import type { CompletionRepository } from "./completionRepository.ts";
import { makeCoordinatorAnswerAuthority } from "./coordinatorAnswerAuthority.ts";
import {
  decodeQuestionWaitTargets,
  makeCoordinatorQuestionRepository,
  questionAnswerMessageId,
  readQuestionWaitMetadata,
  type CoordinatorQuestionRow,
} from "./coordinatorQuestionRepository.ts";
import { canonicalJson, gatewayIsoNow, stableGatewayDigest } from "./creationUtils.ts";
import { mcpToolResultJson } from "./protocol.ts";
import { makeNativeTurnCompletionReader } from "./pinnedThreadResult.ts";
import { errorText } from "./toolInput.ts";
import {
  GatewayToolError,
  gatewayToolErrorResult,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

const MAX_QUESTIONS_PER_DELEGATION = 20;
const MAX_QUESTION_HISTORY_PER_WAIT = 400;
const MAX_PENDING_QUESTIONS = 200;
const MAX_QUESTION_BATCH_CHARS = 40_000;
const waitPrecondition = (row: GatewayWaitRow) => ({
  waitId: row.waitId,
  sourceTurnId: TurnId.makeUnsafe(row.callerTurnId),
  registeredSequence: row.registeredSequence,
});
const questionError = (message: string) => new GatewayToolError("operation_failed", message);
const permanentDispatchFailure = (error: unknown) => {
  if (error === null || typeof error !== "object" || !("_tag" in error)) return false;
  return (
    error._tag === "OrchestrationCommandPreviouslyRejectedError" ||
    error._tag === "OrchestrationCommandIdentityCollisionError" ||
    (error._tag === "OrchestrationCommandInvariantError" &&
      !(
        "detail" in error &&
        typeof error.detail === "string" &&
        error.detail.startsWith(THREAD_AWAIT_DEFERRED)
      ))
  );
};

const interruptedResult = (question: CoordinatorQuestionRow): SynaraWaitedThreadResult => ({
  threadId: question.executorThreadId,
  runId: question.executorTurnId,
  state: "interrupted",
  terminal: true,
  timedOut: false,
  summary: null,
  summaryTruncated: false,
  error:
    "The executor question or its answer continuation was cancelled. The question turn is not a completed task result.",
  readThread: {
    tool: "synara_read_thread",
    arguments: { threadId: question.executorThreadId },
  },
});

export interface CoordinatorQuestionsDependencies {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly projectionTurns: ProjectionTurnRepositoryShape;
  readonly completionRepository: CompletionRepository;
}

export const makeCoordinatorQuestions = (input: CoordinatorQuestionsDependencies) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* makeCoordinatorQuestionRepository;
    const waits = yield* makeAwaitRepository;
    const guard = yield* makeThreadAwaitGuard;
    const mayAnswerExecutor = yield* makeCoordinatorAnswerAuthority;
    const readNativeCompletion = yield* makeNativeTurnCompletionReader;

    const requireWait = (waitId: string) =>
      waits
        .getById(waitId)
        .pipe(
          Effect.flatMap((wait) =>
            wait
              ? Effect.succeed(wait)
              : Effect.fail(questionError("The question's saved wait is unavailable.")),
          ),
        );
    const requireQuestion = (questionId: string) =>
      repository
        .get(questionId)
        .pipe(
          Effect.flatMap((question) =>
            question
              ? Effect.succeed(question)
              : Effect.fail(questionError("This coordinator question is unavailable.")),
          ),
        );
    const checkWait = (wait: GatewayWaitRow, stage: "admission" | "accepted" = "admission") =>
      guard.check({
        threadId: ThreadId.makeUnsafe(wait.callerThreadId),
        precondition: waitPrecondition(wait),
        stage,
      });

    const appendActivity = (
      question: CoordinatorQuestionRow,
      kind: "asked" | "human" | "answered" | "cancelled",
    ) => {
      const createdAt =
        kind === "human"
          ? (question.escalatedAt ?? question.updatedAt)
          : kind === "answered"
            ? (question.answeredAt ?? question.updatedAt)
            : question.createdAt;
      return input.orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`${question.questionId}:${kind}`),
          threadId: question.coordinatorThreadId,
          requireUnarchived: true,
          activity: {
            id: EventId.makeUnsafe(`${question.questionId}:${kind}`),
            kind: `synara.coordinator.question.${kind}`,
            tone: "info",
            summary:
              kind === "human"
                ? "An executor needs your answer"
                : kind === "answered"
                  ? "Answer queued for executor"
                  : kind === "cancelled"
                    ? "Executor question cancelled"
                    : "Executor asked the coordinator",
            payload: {
              questionId: question.questionId,
              executorThreadId: question.executorThreadId,
              executorTurnId: question.executorTurnId,
              question: question.question,
              ...(kind === "human" ? { reason: question.escalationReason } : {}),
              ...(kind === "answered"
                ? { answer: question.answer, answerSource: question.answerSource }
                : {}),
            },
            turnId: null,
            createdAt,
          },
          createdAt,
        })
        .pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logWarning("Could not display coordinator question activity", {
              questionId: question.questionId,
              kind,
              error,
            }),
          ),
        );
    };

    const cancelQuestion = (question: CoordinatorQuestionRow) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE agent_gateway_coordinator_questions SET state = 'cancelled', updated_at = ${gatewayIsoNow()}
      WHERE question_id = ${question.questionId} AND state <> 'cancelled'`;
          yield* sql`UPDATE agent_gateway_waits SET state = 'cancelled', settled_at = ${gatewayIsoNow()}
      WHERE wait_id = ${question.answerWaitId} AND state <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM projection_turns WHERE thread_id = caller_thread_id
          AND pending_message_id = json_extract(dispatch_json, '$.message.messageId') AND turn_id IS NOT NULL)`;
        }),
      );

    const cancelForWait = (request: { readonly threadId: ThreadId; readonly waitId: string }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const wait = yield* waits.getById(request.waitId);
          if (!wait || wait.callerThreadId !== request.threadId) return;
          const metadataRoot = readQuestionWaitMetadata(wait.requestJson).coordinationRootWaitId;
          const linkedRoots = yield* sql<{
            rootWaitId: string;
          }>`SELECT DISTINCT root_wait_id AS "rootWaitId"
          FROM agent_gateway_coordinator_questions WHERE coordinator_thread_id = ${request.threadId}
            AND (wait_id = ${wait.waitId} OR rearmed_wait_id = ${wait.waitId}
              OR notification_wait_id = ${wait.waitId} OR root_wait_id = ${wait.waitId})`;
          const roots = [
            ...new Set([metadataRoot ?? wait.waitId, ...linkedRoots.map((row) => row.rootWaitId)]),
          ];
          const affected = yield* sql<{
            answerWaitId: string;
            waitId: string;
            rearmedWaitId: string | null;
          }>`
        SELECT answer_wait_id AS "answerWaitId", wait_id AS "waitId", rearmed_wait_id AS "rearmedWaitId"
        FROM agent_gateway_coordinator_questions WHERE root_wait_id IN ${sql.in(roots)}
          AND coordinator_thread_id = ${request.threadId}`;
          const ids = [
            ...new Set(
              affected.flatMap((row) =>
                row.rearmedWaitId
                  ? [row.answerWaitId, row.waitId, row.rearmedWaitId]
                  : [row.answerWaitId, row.waitId],
              ),
            ),
          ];
          if (ids.length)
            yield* sql`UPDATE agent_gateway_waits SET state = 'cancelled', settled_at = ${gatewayIsoNow()}
        WHERE wait_id IN ${sql.in(ids)} AND state <> 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM projection_turns WHERE thread_id = caller_thread_id
            AND pending_message_id = json_extract(dispatch_json, '$.message.messageId') AND turn_id IS NOT NULL)`;
          yield* sql`UPDATE agent_gateway_coordinator_questions SET state = 'cancelled', updated_at = ${gatewayIsoNow()}
        WHERE root_wait_id IN ${sql.in(roots)} AND coordinator_thread_id = ${request.threadId}
          AND state NOT IN ('answered', 'cancelled')`;
        }),
      );

    const assertActiveExecutor = (context: ToolContext) =>
      Effect.gen(function* () {
        yield* context.assertCallerTurnActive();
        if (
          !context.callerTurnId ||
          context.principal.kind !== "provider-session" ||
          context.principal.threadId !== context.callerThreadId ||
          context.principal.turnId !== context.callerTurnId ||
          !context.callerCapabilities.has("thread:read") ||
          !context.callerCapabilities.has("thread:write")
        ) {
          return yield* Effect.fail(
            new GatewayToolError(
              "capability_denied",
              "An authenticated active thread with read/write capability is required.",
            ),
          );
        }
        const turn = Option.getOrNull(
          yield* input.projectionTurns.getByTurnId({
            threadId: ThreadId.makeUnsafe(context.callerThreadId),
            turnId: TurnId.makeUnsafe(context.callerTurnId),
          }),
        );
        if (!turn || turn.state !== "running")
          return yield* Effect.fail(
            questionError("The requesting executor turn is no longer active."),
          );
        return turn;
      });

    const ask = (args: Record<string, unknown>, context: ToolContext) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(SynaraAskCoordinatorInput)(args, {
          onExcessProperty: "error",
        });
        const registeredSequence = yield* input.orchestrationEngine.getEventHighWaterSequence;
        const turn = yield* assertActiveExecutor(context);
        const question = yield* sql.withTransaction(
          Effect.gen(function* () {
            const duplicate = (yield* sql<{
              id: string;
            }>`SELECT question_id AS id FROM agent_gateway_coordinator_questions
        WHERE executor_thread_id = ${turn.threadId} AND executor_turn_id = ${turn.turnId}`)[0];
            if (duplicate) {
              const existing = yield* requireQuestion(duplicate.id);
              if (
                existing.requestId !== request.requestId ||
                existing.question !== request.question
              ) {
                return yield* Effect.fail(
                  new GatewayToolError(
                    "idempotency_conflict",
                    "This executor turn already asked a different question.",
                  ),
                );
              }
              return existing;
            }
            yield* assertActiveExecutor(context);
            const candidates = yield* sql<{
              waitId: string;
            }>`SELECT DISTINCT wait.wait_id AS "waitId"
        FROM agent_gateway_waits AS wait, json_each(wait.targets_json) AS target
        WHERE COALESCE(json_extract(wait.request_json, '$.kind'), '') <> 'coordinator-answer'
          AND (wait.state = 'waiting' OR (wait.state IN ('dispatching', 'dispatched') AND EXISTS (
            SELECT 1 FROM agent_gateway_coordinator_questions AS pending
            WHERE pending.notification_wait_id = wait.wait_id AND pending.rearmed_wait_id IS NULL)))
          AND json_extract(target.value, '$.pin.threadId') = ${turn.threadId}
          AND json_extract(target.value, '$.result') IS NULL
          AND (json_extract(target.value, '$.pin.runId') = ${turn.turnId} OR (
            json_extract(target.value, '$.pin.runId') IS NULL
            AND json_extract(target.value, '$.pin.messageId') = ${turn.pendingMessageId}
            AND (SELECT count(*) FROM projection_turns WHERE thread_id = ${turn.threadId}
              AND pending_message_id = ${turn.pendingMessageId} AND turn_id IS NOT NULL) = 1))
        ORDER BY wait.created_at DESC, wait.wait_id DESC LIMIT 21`;
            const owners: GatewayWaitRow[] = [];
            for (const candidate of candidates) {
              const owner = yield* requireWait(candidate.waitId);
              if ((yield* checkWait(owner, "accepted")).status === "ready") owners.push(owner);
            }
            if (owners.length !== 1 || candidates.length > 20)
              return yield* Effect.fail(
                questionError(
                  owners.length
                    ? "More than one coordinator owns a wait for this run; an automatic recipient cannot be selected safely."
                    : "No coordinator is waiting for this exact executor run.",
                ),
              );
            const parent = owners[0]!;
            const authorization = yield* checkWait(parent, "accepted");
            if (authorization.status !== "ready")
              return yield* Effect.fail(questionError(authorization.reason));
            const rootWaitId =
              readQuestionWaitMetadata(parent.requestJson).coordinationRootWaitId ??
              (yield* sql<{ rootWaitId: string }>`SELECT root_wait_id AS "rootWaitId"
                FROM agent_gateway_coordinator_questions WHERE rearmed_wait_id = ${parent.waitId}
                  AND executor_thread_id = ${turn.threadId} ORDER BY created_at DESC, question_id DESC LIMIT 1`)[0]
                ?.rootWaitId ??
              parent.waitId;
            const count =
              (yield* sql<{
                count: number;
              }>`SELECT count(*) AS count FROM agent_gateway_coordinator_questions
        WHERE root_wait_id = ${rootWaitId}`)[0]?.count ?? 0;
            if (count >= MAX_QUESTIONS_PER_DELEGATION)
              return yield* Effect.fail(
                questionError(
                  "This delegation reached its question limit. Report the remaining blocker in the result.",
                ),
              );
            const pendingCount =
              (yield* sql<{ count: number }>`SELECT count(*) AS count
              FROM agent_gateway_coordinator_questions WHERE state NOT IN ('answered', 'cancelled')`)[0]
                ?.count ?? 0;
            if (pendingCount >= MAX_PENDING_QUESTIONS) {
              return yield* Effect.fail(
                questionError(
                  "The workspace has too many unanswered coordinator questions. Resolve existing questions first.",
                ),
              );
            }
            if (yield* waits.getByScope(turn.threadId, turn.turnId))
              return yield* Effect.fail(
                questionError("Finish the executor's existing wait before asking its coordinator."),
              );
            const questionId = `coordinator-question:${stableGatewayDigest({ threadId: turn.threadId, turnId: turn.turnId })}`;
            const answerWaitId = `${questionId}:answer-wait`;
            const createdAt = gatewayIsoNow();
            yield* sql`INSERT INTO agent_gateway_coordinator_questions
        (question_id, root_wait_id, wait_id, coordinator_thread_id, executor_thread_id, executor_turn_id,
          executor_message_id, registered_sequence, request_id, question, answer_wait_id, created_at, updated_at)
        VALUES (${questionId}, ${rootWaitId}, ${parent.waitId}, ${parent.callerThreadId}, ${turn.threadId}, ${turn.turnId},
          ${turn.pendingMessageId}, ${registeredSequence}, ${request.requestId}, ${request.question}, ${answerWaitId}, ${createdAt}, ${createdAt})`;
            yield* waits.reserve({
              waitId: answerWaitId,
              callerThreadId: turn.threadId,
              callerTurnId: turn.turnId,
              requestJson: canonicalJson({
                kind: "coordinator-answer",
                questionId,
                coordinationRootWaitId: rootWaitId,
                threadIds: [],
                runIds: [],
              }),
              targetsJson: "[]",
              registeredSequence,
              createdAt,
            });
            return yield* requireQuestion(questionId);
          }),
        );
        yield* appendActivity(question, "asked");
        return mcpToolResultJson({
          questionId: question.questionId,
          coordinatorThreadId: question.coordinatorThreadId,
          state: question.state,
          instruction:
            "Question saved. Finish this response when independent work is done. The coordinator will answer or ask the user in the main conversation; your exact task will then continue once. This question does not approve a native permission request.",
        });
      });

    const ensureRearm = (
      question: CoordinatorQuestionRow,
      coordinatorTurnId: string,
      registeredSequence: number,
    ) =>
      Effect.gen(function* () {
        if (!question.notificationWaitId)
          return yield* Effect.fail(
            questionError("The coordinator has not received this question yet."),
          );
        const parent = yield* requireWait(question.notificationWaitId);
        const notification = parent.dispatchJson
          ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadTurnStartCommand))(
              parent.dispatchJson,
            )
          : null;
        const source = Option.getOrNull(
          yield* input.projectionTurns.getByTurnId({
            threadId: question.coordinatorThreadId,
            turnId: TurnId.makeUnsafe(coordinatorTurnId),
          }),
        );
        if (
          !notification ||
          !source ||
          source.pendingMessageId !== notification.message.messageId
        ) {
          return yield* Effect.fail(
            questionError(
              "Only the exact coordinator turn that received this question can answer or escalate it.",
            ),
          );
        }
        const authorization = yield* checkWait(parent, "accepted");
        if (authorization.status !== "ready")
          return yield* Effect.fail(questionError(authorization.reason));
        const related = yield* repository.forWait(question.waitId);
        const previous = yield* requireWait(question.waitId);
        const targets = yield* decodeQuestionWaitTargets(previous.targetsJson);
        const replacement = targets.map((target) => {
          const pending = related.findLast(
            (entry) =>
              entry.executorThreadId === target.pin.threadId &&
              entry.state !== "cancelled" &&
              (target.pin.runId === entry.executorTurnId ||
                (target.pin.runId === null && target.pin.messageId === entry.executorMessageId) ||
                target.pin.messageId === questionAnswerMessageId(entry.questionId)),
          );
          return pending && target.pin.messageId !== questionAnswerMessageId(pending.questionId)
            ? {
                pin: {
                  threadId: pending.executorThreadId,
                  runId: null,
                  messageId: questionAnswerMessageId(pending.questionId),
                },
                result: null,
              }
            : target;
        });
        const existing = yield* waits.getByScope(question.coordinatorThreadId, coordinatorTurnId);
        let successor: GatewayWaitRow;
        if (existing) {
          if (existing.state !== "waiting")
            return yield* Effect.fail(
              questionError("The coordinator already dispatched or cancelled its next wait."),
            );
          const current = yield* decodeQuestionWaitTargets(existing.targetsJson);
          const merged = [...current];
          for (const [index, target] of replacement.entries()) {
            if (merged.some((entry) => canonicalJson(entry.pin) === canonicalJson(target.pin)))
              continue;
            const originalIndex = merged.findIndex(
              (entry) => canonicalJson(entry.pin) === canonicalJson(targets[index]!.pin),
            );
            if (originalIndex >= 0) merged[originalIndex] = target;
            else merged.push(target);
          }
          if (merged.length > 20)
            return yield* Effect.fail(
              questionError("The combined coordinator wait exceeds 20 targets."),
            );
          yield* sql`UPDATE agent_gateway_waits SET targets_json = ${JSON.stringify(merged)}
        WHERE wait_id = ${existing.waitId} AND state = 'waiting' AND targets_json = ${existing.targetsJson}`;
          successor = yield* requireWait(existing.waitId);
        } else {
          successor = yield* waits.reserve({
            waitId: `gateway-await:${stableGatewayDigest({ threadId: question.coordinatorThreadId, callerTurnId: coordinatorTurnId })}`,
            callerThreadId: question.coordinatorThreadId,
            callerTurnId: coordinatorTurnId,
            registeredSequence,
            requestJson: canonicalJson({
              kind: "coordinator-rearm",
              coordinationRootWaitId: question.rootWaitId,
              coordinationParentWaitId: parent.waitId,
              threadIds: replacement.map((entry) => entry.pin.threadId),
              runIds: replacement.map((entry) => entry.pin.runId),
            }),
            targetsJson: JSON.stringify(replacement),
            createdAt: gatewayIsoNow(),
          });
        }
        yield* sql`UPDATE agent_gateway_coordinator_questions
      SET wait_id = ${successor.waitId}, rearmed_wait_id = ${successor.waitId}, coordinator_turn_id = ${coordinatorTurnId},
        coordinator_registered_sequence = ${successor.registeredSequence}
      WHERE wait_id = ${previous.waitId} AND state <> 'cancelled'`;
        return successor;
      });

    const answer = (args: Record<string, unknown>, context: ToolContext) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(SynaraAnswerQuestionInput)(args, {
          onExcessProperty: "error",
        });
        if (
          (request.answer !== undefined) === (request.needsUser === true) ||
          (request.reason !== undefined && request.needsUser !== true)
        ) {
          return yield* Effect.fail(
            questionError("Provide either an answer or needsUser: true with an optional reason."),
          );
        }
        const registeredSequence = yield* input.orchestrationEngine.getEventHighWaterSequence;
        yield* assertActiveExecutor(context);
        const question = yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* requireQuestion(request.questionId);
            if (current.coordinatorThreadId !== context.callerThreadId)
              return yield* Effect.fail(
                new GatewayToolError(
                  "capability_denied",
                  "This question belongs to another coordinator.",
                ),
              );
            if (current.state === "cancelled")
              return yield* Effect.fail(questionError("This question was cancelled."));
            if (current.answer !== null) {
              if (current.answer !== request.answer)
                return yield* Effect.fail(
                  new GatewayToolError(
                    "idempotency_conflict",
                    "This question already has a different answer.",
                  ),
                );
              return current;
            }
            if (current.state === "human") {
              if (
                request.needsUser === true &&
                (request.reason ?? null) === current.escalationReason
              )
                return current;
              return yield* Effect.fail(
                questionError(
                  "This question has been escalated to the user in the main conversation.",
                ),
              );
            }
            if (current.state !== "notified")
              return yield* Effect.fail(
                questionError("This question has not reached its coordinator turn."),
              );
            if (
              request.answer !== undefined &&
              !(yield* mayAnswerExecutor(current.coordinatorThreadId, current.executorThreadId))
            ) {
              return yield* Effect.fail(
                new GatewayToolError(
                  "capability_denied",
                  "The executor has higher privileges or a less isolated workspace. Ask the user in the main conversation with needsUser: true.",
                ),
              );
            }
            const executorAuthorization = yield* checkWait(
              yield* requireWait(current.answerWaitId),
              "accepted",
            );
            if (executorAuthorization.status !== "ready")
              return yield* Effect.fail(questionError(executorAuthorization.reason));
            yield* assertActiveExecutor(context);
            yield* ensureRearm(current, context.callerTurnId!, registeredSequence);
            const now = gatewayIsoNow();
            yield* sql`UPDATE agent_gateway_coordinator_questions
        SET state = ${request.needsUser ? "human" : "answering"}, answer = ${request.answer ?? null},
          answer_source = ${request.answer === undefined ? null : "coordinator"}, escalation_reason = ${request.reason ?? null},
          escalated_at = ${request.needsUser ? now : null}, answered_at = ${request.answer === undefined ? null : now}, updated_at = ${now}
        WHERE question_id = ${current.questionId} AND state = 'notified' AND answer IS NULL`;
            return yield* requireQuestion(current.questionId);
          }),
        );
        if (question.state === "human") yield* appendActivity(question, "human");
        return mcpToolResultJson({
          questionId: question.questionId,
          state: question.state,
          waitId: question.waitId,
          instruction:
            question.state === "human"
              ? "The question is visible to the user here. Finish your response; the saved wait will continue after their answer and the executor's final result."
              : "Answer saved for the exact executor task. Your wait is re-armed for the final result. Finish this response when independent work is done.",
        });
      });

    const answerHuman = (raw: ThreadCoordinationAnswerQuestionInput) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(ThreadCoordinationAnswerQuestionInput)(
          raw,
          { onExcessProperty: "error" },
        );
        const changed = yield* sql.withTransaction(
          Effect.gen(function* () {
            const question = yield* repository.get(request.questionId);
            if (!question || question.coordinatorThreadId !== request.threadId) return false;
            if (question.answer !== null)
              return (
                question.answerSource === "human" &&
                question.answer === request.answer &&
                question.state !== "cancelled"
              );
            if (question.state !== "human" || !question.rearmedWaitId) return false;
            const parent = yield* requireWait(question.rearmedWaitId);
            const authorization = yield* checkWait(parent, "accepted");
            if (authorization.status !== "ready") return false;
            if (
              (yield* checkWait(yield* requireWait(question.answerWaitId), "accepted")).status !==
              "ready"
            )
              return false;
            const now = gatewayIsoNow();
            const updated = yield* sql`UPDATE agent_gateway_coordinator_questions
        SET state = 'answering', answer = ${request.answer}, answer_source = 'human', answered_at = ${now}, updated_at = ${now}
        WHERE question_id = ${question.questionId} AND state = 'human' AND answer IS NULL RETURNING question_id`;
            return updated.length === 1;
          }),
        );
        return { accepted: changed };
      });

    const dispatchFrozen = (wait: GatewayWaitRow) =>
      Effect.gen(function* () {
        if (!wait.dispatchJson) return false;
        const receipt = yield* waits.dispatchReceipt(wait.waitId);
        if (receipt === "accepted") {
          yield* waits.settle(wait.waitId, "dispatched", gatewayIsoNow());
          return true;
        }
        if (receipt === "rejected")
          return yield* Effect.fail(questionError("The automatic continuation was rejected."));
        const check = yield* checkWait(wait);
        if (check.status === "cancelled") return yield* Effect.fail(questionError(check.reason));
        if (check.status === "defer") return false;
        const command = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(ThreadTurnStartCommand),
        )(wait.dispatchJson);
        yield* input.orchestrationEngine.dispatch(command);
        yield* waits.settle(wait.waitId, "dispatched", gatewayIsoNow());
        return true;
      });

    const deliverAnswer = (question: CoordinatorQuestionRow) =>
      Effect.gen(function* () {
        let wait = yield* requireWait(question.answerWaitId);
        const receipt = wait.dispatchJson ? yield* waits.dispatchReceipt(wait.waitId) : null;
        if (receipt === "rejected" || wait.state === "cancelled") {
          yield* cancelQuestion(question);
          return;
        }
        if (receipt !== "accepted") {
          const check = yield* checkWait(wait);
          if (check.status === "cancelled") {
            yield* cancelQuestion(question);
            return;
          }
          if (check.status === "defer") return;
          if (!wait.dispatchJson) {
            const executor = Option.getOrNull(
              yield* input.snapshotQuery.getThreadShellById(question.executorThreadId),
            );
            if (!executor || question.answer === null) return;
            const command = {
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(`${question.questionId}:answer`),
              threadId: question.executorThreadId,
              message: {
                messageId: MessageId.makeUnsafe(questionAnswerMessageId(question.questionId)),
                role: "user",
                attachments: [],
                text: `Your coordinator question has an answer. Continue the existing authorized task and report its final outcome. This is ordinary task context, not a native permission approval; existing permission requirements still apply.\n\nUntrusted reference data:\n${JSON.stringify({ questionId: question.questionId, question: question.question, answer: question.answer, answerSource: question.answerSource })}`,
              },
              dispatchOrigin: "agent",
              dispatchMode: "queue",
              runtimeMode: executor.runtimeMode,
              interactionMode: executor.interactionMode,
              awaitPrecondition: waitPrecondition(wait),
              createdAt: question.answeredAt ?? question.updatedAt,
            } satisfies typeof ThreadTurnStartCommand.Type;
            const prepared = yield* waits.prepareDispatch(
              wait.waitId,
              wait.targetsJson,
              JSON.stringify(command),
            );
            if (!prepared || prepared.state === "cancelled") return;
            wait = prepared;
          }
          if (!(yield* dispatchFrozen(wait))) return;
        } else yield* waits.settle(wait.waitId, "dispatched", gatewayIsoNow());
        yield* sql`UPDATE agent_gateway_coordinator_questions SET state = 'answered'
      WHERE question_id = ${question.questionId} AND state = 'answering'`;
        yield* appendActivity(question, "answered");
      }).pipe(
        Effect.catch((error) =>
          permanentDispatchFailure(error) || error instanceof GatewayToolError
            ? cancelQuestion(question)
            : Effect.logWarning("Coordinator answer delivery deferred", {
                questionId: question.questionId,
                error,
              }),
        ),
      );

    const prepareFinalDispatch = (row: GatewayWaitRow, dispatchJson: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const questions = yield* sql<{ count: number }>`SELECT count(*) AS count
          FROM agent_gateway_coordinator_questions WHERE wait_id = ${row.waitId}
            AND state IN ('asked', 'notified', 'human')`;
          if ((questions[0]?.count ?? 0) > 0) return null;
          return yield* waits.prepareDispatch(row.waitId, row.targetsJson, dispatchJson);
        }),
      );

    const handleWaitDelivery = (initial: GatewayWaitRow): Effect.Effect<boolean, unknown> =>
      Effect.gen(function* () {
        if (readQuestionWaitMetadata(initial.requestJson).kind === "coordinator-answer")
          return true;
        let wait = yield* requireWait(initial.waitId);
        let questions = yield* repository.forWait(wait.waitId);
        if (!questions.length) return false;
        if (questions.length > MAX_QUESTION_HISTORY_PER_WAIT)
          return yield* Effect.fail(questionError("The saved question batch exceeds its limit."));
        const ownNotification =
          (yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM agent_gateway_coordinator_questions
      WHERE notification_wait_id = ${wait.waitId}`)[0]?.count ?? 0;
        if (ownNotification && wait.dispatchJson) {
          yield* dispatchFrozen(wait).pipe(
            Effect.catch((error) =>
              permanentDispatchFailure(error) || error instanceof GatewayToolError
                ? cancelForWait({
                    threadId: ThreadId.makeUnsafe(wait.callerThreadId),
                    waitId: wait.waitId,
                  })
                : Effect.logWarning("Coordinator question delivery deferred", {
                    waitId: wait.waitId,
                    error,
                  }),
            ),
          );
          return true;
        }
        for (const question of questions) {
          if (question.state === "asked") {
            const executorWait = yield* requireWait(question.answerWaitId);
            if ((yield* checkWait(executorWait)).status === "cancelled")
              yield* cancelQuestion(question);
          }
        }
        questions = yield* repository.forWait(wait.waitId);
        const cancelled = questions.filter((question) => question.state === "cancelled");
        if (cancelled.length && wait.state === "waiting") {
          const targets = yield* decodeQuestionWaitTargets(wait.targetsJson);
          const updated = targets.map((target) => {
            const question = cancelled.find(
              (entry) =>
                entry.executorThreadId === target.pin.threadId &&
                (target.pin.runId === entry.executorTurnId ||
                  target.pin.messageId === entry.executorMessageId ||
                  target.pin.messageId === questionAnswerMessageId(entry.questionId)),
            );
            return question ? { pin: target.pin, result: interruptedResult(question) } : target;
          });
          yield* waits.saveTargets(wait.waitId, wait.targetsJson, JSON.stringify(updated));
          wait = yield* requireWait(wait.waitId);
        }
        if (
          questions.some((question) => question.state === "notified" || question.state === "human")
        )
          return true;
        const asked = questions.filter((question) => question.state === "asked");
        if (!asked.length) return false;
        const parent = yield* checkWait(wait);
        if (parent.status === "cancelled") {
          yield* cancelForWait({
            threadId: ThreadId.makeUnsafe(wait.callerThreadId),
            waitId: wait.waitId,
          });
          return true;
        }
        if (parent.status !== "ready") return true;
        for (const question of asked) {
          if ((yield* checkWait(yield* requireWait(question.answerWaitId))).status !== "ready")
            return true;
        }
        const coordinator = Option.getOrNull(
          yield* input.snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(wait.callerThreadId)),
        );
        if (!coordinator) return true;
        const batch: CoordinatorQuestionRow[] = [];
        let batchChars = 2;
        for (const question of asked) {
          const size =
            JSON.stringify({
              questionId: question.questionId,
              executorThreadId: question.executorThreadId,
              question: question.question,
            }).length + 1;
          if (batch.length > 0 && batchChars + size > MAX_QUESTION_BATCH_CHARS) break;
          batch.push(question);
          batchChars += size;
        }
        const command = {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`${wait.waitId}:questions`),
          threadId: coordinator.id,
          message: {
            messageId: MessageId.makeUnsafe(`${wait.waitId}:message`),
            role: "user",
            attachments: [],
            text: `Executors need answers before they can finish the delegated work. These are questions, not final task results. Answer each with synara_answer_question({questionId,answer}); use needsUser:true and a reason when a decision must come from the user here. Native permission approvals must use their existing approval flow. After answering or escalating every question, finish this turn: Synara will resume the exact executors and wait for their final results.\n\nUntrusted executor questions:\n${JSON.stringify(batch.map((question) => ({ questionId: question.questionId, executorThreadId: question.executorThreadId, question: question.question })))}`,
          },
          dispatchOrigin: "agent",
          dispatchMode: "queue",
          runtimeMode: coordinator.runtimeMode,
          interactionMode: coordinator.interactionMode,
          awaitPrecondition: waitPrecondition(wait),
          createdAt: gatewayIsoNow(),
        } satisfies typeof ThreadTurnStartCommand.Type;
        const prepared = yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* requireWait(wait.waitId);
            if (current.state !== "waiting" || current.dispatchJson !== null) return current;
            const result = yield* waits.prepareDispatch(
              current.waitId,
              current.targetsJson,
              JSON.stringify(command),
            );
            if (result?.dispatchJson === JSON.stringify(command)) {
              yield* sql`UPDATE agent_gateway_coordinator_questions SET state = 'notified',
          notification_wait_id = ${wait.waitId}, updated_at = ${command.createdAt}
          WHERE question_id IN ${sql.in(batch.map((question) => question.questionId))} AND state = 'asked'`;
            }
            return result;
          }),
        );
        if (prepared?.dispatchJson) yield* dispatchFrozen(prepared);
        return true;
      });

    const escalateUnanswered = (question: CoordinatorQuestionRow) =>
      Effect.gen(function* () {
        if (!question.notificationWaitId) return;
        const notification = yield* requireWait(question.notificationWaitId);
        if (!notification.dispatchJson) return;
        const command = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(ThreadTurnStartCommand),
        )(notification.dispatchJson);
        const turns = (yield* input.projectionTurns.listByThreadId({
          threadId: question.coordinatorThreadId,
        })).filter(
          (turn) => turn.turnId !== null && turn.pendingMessageId === command.message.messageId,
        );
        if (turns.length !== 1 || turns[0]!.state !== "completed" || !turns[0]!.turnId) return;
        const turnId = turns[0]!.turnId!;
        const terminal = yield* readNativeCompletion(question.coordinatorThreadId, turnId);
        if (
          terminal?.state !== "completed" &&
          !(yield* input.completionRepository.hasCompletedRun(question.coordinatorThreadId, turnId))
        )
          return;
        if (!(yield* input.completionRepository.isOutputSettled(question.coordinatorThreadId)))
          return;
        const registeredSequence = yield* input.orchestrationEngine.getEventHighWaterSequence;
        const updated = yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* requireQuestion(question.questionId);
            if (current.state !== "notified") return null;
            yield* ensureRearm(current, turnId, registeredSequence);
            const now = gatewayIsoNow();
            yield* sql`UPDATE agent_gateway_coordinator_questions SET state = 'human',
          escalation_reason = 'The coordinator finished without resolving this question. Your answer is needed.',
          escalated_at = ${now}, updated_at = ${now}
          WHERE question_id = ${current.questionId} AND state = 'notified'`;
            return yield* requireQuestion(current.questionId);
          }),
        );
        if (updated) yield* appendActivity(updated, "human");
      });

    const deliverPending = () =>
      Effect.gen(function* () {
        for (const question of yield* repository.pending()) {
          yield* Effect.gen(function* () {
            const parent = yield* waits.getById(question.rearmedWaitId ?? question.waitId);
            if (!parent || (yield* checkWait(parent, "accepted")).status === "cancelled") {
              yield* cancelQuestion(question);
              return;
            }
            if (question.state === "answering") {
              yield* deliverAnswer(question);
              return;
            }
            yield* appendActivity(question, "asked");
            if (question.state === "human") yield* appendActivity(question, "human");
            else if (question.state === "notified") yield* escalateUnanswered(question);
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Coordinator question reconciliation deferred", {
                questionId: question.questionId,
                error,
              }),
            ),
          );
        }
      });

    const wrap =
      (handler: typeof ask): ToolEntry["handler"] =>
      (args, context) =>
        handler(args, context).pipe(
          Effect.catch((error) =>
            Effect.succeed(
              gatewayToolErrorResult(
                error instanceof GatewayToolError ? error : questionError(errorText(error)),
              ),
            ),
          ),
        );
    const tools: readonly ToolEntry[] = [
      {
        requiredCapability: "thread:write",
        requiresActiveTurn: true,
        definition: {
          name: "synara_ask_coordinator",
          description:
            "Ask the coordinator waiting for this exact delegated run a bounded task question. Returns immediately; finish your turn to receive a guarded answer continuation. No recipient override. This never answers native permission approvals.",
          inputSchema: {
            type: "object",
            properties: {
              requestId: { type: "string", minLength: 1, maxLength: 160 },
              question: { type: "string", minLength: 1, maxLength: 4000 },
            },
            required: ["requestId", "question"],
            additionalProperties: false,
          },
          annotations: {
            ...WRITE_TOOL_ANNOTATIONS,
            title: "Ask coordinator",
            idempotentHint: true,
          },
        },
        handler: wrap(ask),
      },
      {
        requiredCapability: "thread:write",
        requiresActiveTurn: true,
        definition: {
          name: "synara_answer_question",
          description:
            "Answer an executor question received by this exact coordinator turn, or escalate it to the user in this main conversation with needsUser:true. Provide answer or needsUser, never both. Preserves permissions, resumes the exact executor, and re-arms the wait for final results.",
          inputSchema: {
            type: "object",
            properties: {
              questionId: { type: "string" },
              answer: { type: "string", minLength: 1, maxLength: 8000 },
              needsUser: { type: "boolean" },
              reason: { type: "string", maxLength: 2000 },
            },
            required: ["questionId"],
            additionalProperties: false,
          },
          annotations: {
            ...WRITE_TOOL_ANNOTATIONS,
            title: "Answer executor question",
            idempotentHint: true,
          },
        },
        handler: wrap(answer),
      },
    ];
    return {
      tools,
      deliverPending,
      handleWaitDelivery,
      prepareFinalDispatch,
      list: repository.list,
      answerHuman,
      cancelForWait,
    };
  });
