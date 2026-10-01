import {
  CommandId,
  EventId,
  MessageId,
  SynaraWaitedThreadResult,
  ThreadId,
  TurnId,
  type CoordinatorQuestion,
  type ThreadCoordinationAnswerQuestionInput,
  type ThreadCoordinationCancelWaitInput,
  type ThreadCoordinationListInput,
  type ThreadCoordinationListResult,
  type ThreadCoordinationTarget,
  type ThreadCoordinationWait,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const MAX_VISIBLE_WAITS = 100;
const decodeTargets = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        pin: Schema.Struct({
          threadId: ThreadId,
          runId: Schema.NullOr(TurnId),
          messageId: Schema.NullOr(Schema.String),
        }),
        result: Schema.NullOr(SynaraWaitedThreadResult),
      }),
    ),
  ),
);

interface WaitViewRow {
  readonly waitId: string;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly state: ThreadCoordinationWait["state"];
  readonly targetsJson: string;
}

interface QuestionsForView {
  readonly list: (input: {
    threadId?: ThreadId;
  }) => Effect.Effect<readonly CoordinatorQuestion[], unknown>;
  readonly answerHuman: (
    input: ThreadCoordinationAnswerQuestionInput,
  ) => Effect.Effect<{ accepted: boolean }, unknown>;
  readonly cancelForWait: (
    input: ThreadCoordinationCancelWaitInput,
  ) => Effect.Effect<void, unknown>;
}

export const makeThreadCoordination = (input: {
  readonly snapshotQuery: Pick<ProjectionSnapshotQueryShape, "getThreadShellsByIds">;
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly questions: QuestionsForView;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const list = (
      request: ThreadCoordinationListInput,
    ): Effect.Effect<ThreadCoordinationListResult, unknown> =>
      Effect.gen(function* () {
        const rows = yield* sql<WaitViewRow>`
        SELECT wait.wait_id AS "waitId", wait.caller_thread_id AS "threadId",
          wait.created_at AS "createdAt", wait.state, wait.targets_json AS "targetsJson"
        FROM agent_gateway_waits AS wait
        JOIN projection_threads AS caller ON caller.thread_id = wait.caller_thread_id
        WHERE caller.deleted_at IS NULL AND caller.archived_at IS NULL
          AND (${request.threadId ?? null} IS NULL OR caller.thread_id = ${request.threadId ?? null})
          AND COALESCE(json_extract(wait.request_json, '$.kind'), '') <> 'coordinator-answer'
          AND (wait.state IN ('waiting', 'dispatching') OR (wait.state = 'dispatched' AND NOT EXISTS (
            SELECT 1 FROM projection_turns AS own WHERE own.thread_id = wait.caller_thread_id
              AND own.turn_id IS NOT NULL
              AND own.pending_message_id = json_extract(wait.dispatch_json, '$.message.messageId')
          )))
        ORDER BY wait.created_at DESC, wait.wait_id DESC LIMIT ${MAX_VISIBLE_WAITS + 1}
      `;
        const questions = yield* input.questions.list(
          request.threadId ? { threadId: request.threadId } : {},
        );
        const waits = yield* Effect.forEach(rows.slice(0, MAX_VISIBLE_WAITS), (row) =>
          decodeTargets(row.targetsJson).pipe(Effect.map((targets) => ({ row, targets }))),
        );
        const pins = waits.flatMap((wait) => wait.targets.map((target) => target.pin));
        const ids = [...new Set(pins.map((pin) => pin.threadId))];
        const shells = ids.length ? yield* input.snapshotQuery.getThreadShellsByIds(ids) : [];
        const shellById = new Map(shells.map((shell) => [shell.id, shell]));
        const turns = pins.length
          ? yield* sql<{
              threadId: string;
              runId: string | null;
              messageId: string | null;
              state: string;
            }>`
        SELECT turn.thread_id AS "threadId", turn.turn_id AS "runId",
          turn.pending_message_id AS "messageId", turn.state
        FROM json_each(${JSON.stringify(pins)}) AS pin
        JOIN projection_turns AS turn ON json_extract(pin.value, '$.threadId') = turn.thread_id
            AND ((json_extract(pin.value, '$.runId') IS NOT NULL
              AND json_extract(pin.value, '$.runId') = turn.turn_id)
            OR (json_extract(pin.value, '$.runId') IS NULL
              AND json_extract(pin.value, '$.messageId') = turn.pending_message_id))
        ORDER BY turn.requested_at, turn.row_id
      `
          : [];
        const turnByRun = new Map(
          turns
            .filter((turn) => turn.runId !== null)
            .map((turn) => [`${turn.threadId}\u0000${turn.runId}`, turn]),
        );
        const turnByMessage = new Map(
          turns.map((turn) => [`${turn.threadId}\u0000${turn.messageId}`, turn]),
        );
        return {
          waits: waits.map(({ row, targets }) => ({
            waitId: row.waitId,
            threadId: row.threadId,
            createdAt: row.createdAt,
            state: row.state,
            cancellable: true,
            targets: targets.map(({ pin, result }): ThreadCoordinationTarget => {
              const shell = shellById.get(pin.threadId);
              const turn =
                pin.runId !== null
                  ? turnByRun.get(`${pin.threadId}\u0000${pin.runId}`)
                  : turnByMessage.get(`${pin.threadId}\u0000${pin.messageId}`);
              const runId = result?.runId ?? turn?.runId ?? pin.runId;
              const currentRun = runId !== null && runId === shell?.latestTurn?.turnId;
              const question = questions.some(
                (entry) =>
                  entry.coordinatorThreadId === row.threadId &&
                  entry.executorThreadId === pin.threadId &&
                  entry.state !== "answered" &&
                  entry.state !== "cancelled",
              );
              const state: ThreadCoordinationTarget["state"] = question
                ? "question"
                : result?.terminal
                  ? result.state === "completed"
                    ? "completed"
                    : result.state === "error"
                      ? "error"
                      : "interrupted"
                  : !shell
                    ? "unavailable"
                    : currentRun && shell.hasPendingApprovals
                      ? "approval"
                      : currentRun && (shell.hasPendingUserInput || shell.hasPendingAsyncUserInput)
                        ? "input"
                        : turn?.state === "running"
                          ? "running"
                          : turn?.state === "error"
                            ? "error"
                            : turn?.state === "interrupted"
                              ? "interrupted"
                              : runId === null && shell.session?.activeTurnId
                                ? "queued"
                                : "pending";
              return {
                threadId: pin.threadId,
                title: shell?.title ?? "Unavailable thread",
                provider: shell?.modelSelection.provider ?? null,
                runId: runId === null ? null : TurnId.makeUnsafe(runId),
                messageId: pin.messageId === null ? null : MessageId.makeUnsafe(pin.messageId),
                state,
              };
            }),
          })),
          questions: [...questions],
          hasMore: rows.length > MAX_VISIBLE_WAITS || questions.length >= 200,
        };
      });

    const cancelWait = (request: ThreadCoordinationCancelWaitInput) =>
      Effect.gen(function* () {
        const changed = yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ waitId: string }>`
        UPDATE agent_gateway_waits SET state = 'cancelled', settled_at = ${new Date().toISOString()}
        WHERE wait_id = ${request.waitId} AND caller_thread_id = ${request.threadId}
          AND state IN ('waiting', 'dispatching', 'dispatched')
          AND COALESCE(json_extract(request_json, '$.kind'), '') <> 'coordinator-answer'
          AND NOT EXISTS (SELECT 1 FROM projection_turns AS own
            WHERE own.thread_id = caller_thread_id AND own.turn_id IS NOT NULL
              AND own.pending_message_id = json_extract(dispatch_json, '$.message.messageId'))
        RETURNING wait_id AS "waitId"
      `;
            if (rows.length === 0) return false;
            yield* input.questions.cancelForWait(request);
            return true;
          }),
        );
        if (changed) {
          const createdAt = new Date().toISOString();
          yield* input.orchestrationEngine
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe(`${request.waitId}:user-cancel`),
              threadId: request.threadId,
              activity: {
                id: EventId.makeUnsafe(`${request.waitId}:user-cancel`),
                kind: "synara.thread.wait.cancelled",
                tone: "info",
                summary: "Thread wait cancelled",
                payload: {
                  waitId: request.waitId,
                  detail:
                    "The user cancelled the automatic continuation. Delegated threads can continue working.",
                },
                turnId: null,
                createdAt,
              },
              createdAt,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not display cancelled thread wait", { error }),
              ),
            );
        }
        return { accepted: changed };
      });
    return { list, cancelWait, answerQuestion: input.questions.answerHuman };
  });
