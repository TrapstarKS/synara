import { ThreadId, TurnId, type SynaraWaitedThreadResult } from "@synara/contracts";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  joinMessageTextChunks,
  selectMessageTextChunks,
} from "../persistence/messageTextChunks.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import { PROVIDER_RUNTIME_INGESTION_CONSUMER } from "../persistence/Services/ProviderRuntimeEvents.ts";
import type { CompletionRepository } from "./completionRepository.ts";
import { summarizeWaitThreadText } from "./threadSummary.ts";
import { ToolInputError } from "./toolInput.ts";
import { GatewayToolError } from "./toolRuntime.ts";

export interface PinnedThreadTarget {
  readonly threadId: string;
  readonly runId: string | null;
  readonly messageId: string | null;
}

export interface NativeTurnCompletion {
  readonly sequence: number;
  readonly runtimeSequence: number;
  readonly state: "completed" | "failed" | "interrupted" | "cancelled";
  readonly error: string | null;
}

export const makeNativeTurnCompletionReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (threadId: string, runId: string) =>
    sql<NativeTurnCompletion>`
      SELECT sequence, json_extract(payload_json, '$.activity.sequence') AS "runtimeSequence",
        json_extract(payload_json, '$.activity.payload.state') AS state,
        json_extract(payload_json, '$.activity.payload.errorMessage') AS error
      FROM orchestration_events
      WHERE stream_id = ${threadId} AND event_type = 'thread.activity-appended'
        AND actor_kind = 'provider'
        AND json_extract(payload_json, '$.activity.kind') = 'turn.completed'
        AND json_extract(payload_json, '$.activity.turnId') = ${runId}
        AND json_extract(payload_json, '$.activity.payload.state') IN ('completed', 'failed', 'interrupted', 'cancelled')
        AND command_id = 'provider:' || json_extract(payload_json, '$.activity.id')
          || ':thread-activity-append:' || ${threadId} || ':turn.completed:'
          || json_extract(payload_json, '$.activity.id')
        AND json_type(payload_json, '$.activity.sequence') = 'integer'
        AND json_extract(payload_json, '$.activity.sequence') <= COALESCE((
          SELECT last_acked_sequence FROM provider_runtime_event_consumers
          WHERE consumer_name = ${PROVIDER_RUNTIME_INGESTION_CONSUMER}), -1)
      ORDER BY sequence LIMIT 1
    `.pipe(Effect.map((rows) => rows[0] ?? null));
});

interface ThreadTargetDependencies {
  readonly snapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getThreadDetailById"
  >;
  readonly projectionTurns: Pick<
    ProjectionTurnRepositoryShape,
    "getByTurnId" | "listByThreadId" | "getPendingTurnStartByThreadId"
  >;
}

const PersistedAssistantResult = Schema.Struct({
  text: Schema.String,
  encodedText: Schema.NullOr(Schema.fromJsonString(Schema.String)),
  textChunks: Schema.fromJsonString(Schema.Array(Schema.String)),
  hasStreaming: Schema.Number,
});

export const makeThreadTargetPinner = (dependencies: ThreadTargetDependencies) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (input: { readonly threadId: string; readonly runId?: string | null }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe(input.threadId);
        const child = Option.getOrUndefined(
          yield* dependencies.snapshotQuery.getThreadShellById(threadId),
        );
        if (!child) {
          return yield* Effect.fail(
            new GatewayToolError("thread_not_found", `Thread '${threadId}' does not exist.`),
          );
        }
        if (input.runId != null) {
          const turn = Option.getOrUndefined(
            yield* dependencies.projectionTurns.getByTurnId({
              threadId,
              turnId: TurnId.makeUnsafe(input.runId),
            }),
          );
          if (!turn) {
            return yield* Effect.fail(
              new ToolInputError(`Run '${input.runId}' does not exist in thread '${threadId}'.`),
            );
          }
          return { threadId, runId: turn.turnId, messageId: turn.pendingMessageId };
        }
        const latestRequest = (yield* sql<{
          messageId: string;
          queued: number;
        }>`
          SELECT json_extract(request.payload_json, '$.messageId') AS "messageId",
            EXISTS (SELECT 1 FROM queued_turn_promotions AS queued
              WHERE queued.thread_id = request.stream_id
                AND queued.message_id = json_extract(request.payload_json, '$.messageId')
                AND queued.state IN ('queued', 'promoting')) AS queued
          FROM orchestration_events AS request
          WHERE request.stream_id = ${threadId}
            AND request.event_type IN ('thread.turn-queued', 'thread.turn-start-requested')
            AND json_type(request.payload_json, '$.messageId') = 'text'
            AND COALESCE(request.command_id, '') NOT GLOB 'server:dispatch-queued-turn:*'
          ORDER BY request.sequence DESC LIMIT 1
        `)[0];
        const pending = Option.getOrUndefined(
          yield* dependencies.projectionTurns.getPendingTurnStartByThreadId({ threadId }),
        );
        if (latestRequest) {
          const matchingTurns = (yield* dependencies.projectionTurns.listByThreadId({
            threadId,
          })).filter(
            (turn) => turn.turnId !== null && turn.pendingMessageId === latestRequest.messageId,
          );
          if (
            matchingTurns.length > 0 &&
            (matchingTurns.length > 1 ||
              latestRequest.queued === 1 ||
              pending?.messageId === latestRequest.messageId)
          ) {
            return yield* Effect.fail(
              new ToolInputError(
                `Pending message '${latestRequest.messageId}' was reused. Wait for its new run ID and select that run explicitly.`,
              ),
            );
          }
          if (matchingTurns.length === 0) {
            return { threadId, runId: null, messageId: latestRequest.messageId };
          }
          return { threadId, runId: matchingTurns[0]!.turnId, messageId: latestRequest.messageId };
        }
        if (pending) {
          const previous = (yield* dependencies.projectionTurns.listByThreadId({ threadId })).some(
            (turn) => turn.turnId !== null && turn.pendingMessageId === pending.messageId,
          );
          if (previous) {
            return yield* Effect.fail(
              new ToolInputError(
                `Pending message '${pending.messageId}' was reused. Wait for its new run ID and select that run explicitly.`,
              ),
            );
          }
          return { threadId, runId: null, messageId: pending.messageId };
        }
        const latestTurn = child.latestTurn
          ? Option.getOrUndefined(
              yield* dependencies.projectionTurns.getByTurnId({
                threadId,
                turnId: child.latestTurn.turnId,
              }),
            )
          : undefined;
        if (latestTurn) {
          return { threadId, runId: latestTurn.turnId, messageId: latestTurn.pendingMessageId };
        }
        const planned = (yield* sql<{ messageId: string }>`
          SELECT json_extract(entry.value, '$.ids.messageId') AS "messageId"
          FROM agent_gateway_operations AS operation, json_each(operation.plan_json) AS entry
          WHERE operation.status = 'completed'
            AND json_extract(entry.value, '$.ids.threadId') = ${threadId}
            AND json_type(entry.value, '$.ids.messageId') = 'text'
          ORDER BY operation.created_at DESC LIMIT 1
        `)[0];
        if (planned) return { threadId, runId: null, messageId: planned.messageId };
        return yield* Effect.fail(
          new ToolInputError(`Thread '${threadId}' has no dispatched task to await.`),
        );
      });
  });

export const makePinnedThreadResultReader = (
  dependencies: ThreadTargetDependencies & {
    readonly repository: Pick<
      CompletionRepository,
      "hasCompletedRun" | "isOutputSettled" | "initialFailure"
    >;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const readNativeCompletion = yield* makeNativeTurnCompletionReader;
    return (pin: PinnedThreadTarget): Effect.Effect<SynaraWaitedThreadResult | null, unknown> =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe(pin.threadId);
        const result = (
          state: "completed" | "error" | "interrupted",
          runId: string | null,
          error: string | null,
          text?: string,
        ): SynaraWaitedThreadResult => {
          const summary = summarizeWaitThreadText(text);
          return {
            threadId,
            runId: runId === null ? null : TurnId.makeUnsafe(runId),
            state,
            terminal: true,
            timedOut: false,
            summary: summary.summary,
            summaryTruncated: summary.truncated,
            error: summarizeWaitThreadText(error).summary,
            readThread: { tool: "synara_read_thread", arguments: { threadId } },
          };
        };
        const child = Option.getOrUndefined(
          yield* dependencies.snapshotQuery.getThreadShellById(threadId),
        );
        if (!child) return result("interrupted", pin.runId, "Awaited task was deleted.");
        if (pin.runId === null && pin.messageId === null) {
          return yield* Effect.fail(
            new ToolInputError("An awaited task needs a run or message ID."),
          );
        }
        const turn =
          pin.runId !== null
            ? Option.getOrUndefined(
                yield* dependencies.projectionTurns.getByTurnId({
                  threadId,
                  turnId: TurnId.makeUnsafe(pin.runId),
                }),
              )
            : (yield* dependencies.projectionTurns.listByThreadId({ threadId }))
                .filter(
                  (entry) => entry.turnId !== null && entry.pendingMessageId === pin.messageId,
                )
                .toSorted(
                  (left, right) =>
                    left.requestedAt.localeCompare(right.requestedAt) ||
                    (left.turnId ?? "").localeCompare(right.turnId ?? ""),
                )[0];
        if (!turn || turn.turnId === null) {
          if (pin.runId !== null) {
            return result("interrupted", pin.runId, "Awaited run is no longer available.");
          }
          const queued = (yield* sql<{ cancelled: number; removed: number; stopped: number }>`
            SELECT
              COALESCE((SELECT state = 'cancelled' FROM queued_turn_promotions
                WHERE thread_id = ${threadId} AND message_id = ${pin.messageId}
                ORDER BY queued_event_sequence DESC LIMIT 1), 0) AS cancelled,
              EXISTS (SELECT 1 FROM orchestration_events AS sent
                WHERE sent.stream_id = ${threadId} AND sent.event_type = 'thread.message-sent'
                  AND json_extract(sent.payload_json, '$.messageId') = ${pin.messageId}
                  AND json_extract(sent.payload_json, '$.role') = 'user'
                  AND EXISTS (SELECT 1 FROM projection_state
                    WHERE projector IN ('projection.hot', 'projection.thread-messages')
                      AND last_applied_sequence >= sent.sequence)
                  AND NOT EXISTS (SELECT 1 FROM projection_thread_messages
                    WHERE thread_id = ${threadId} AND message_id = ${pin.messageId})) AS removed,
              EXISTS (SELECT 1 FROM orchestration_events AS request
                JOIN orchestration_events AS stopped ON stopped.stream_id = request.stream_id
                  AND stopped.sequence > request.sequence
                WHERE request.stream_id = ${threadId} AND request.event_type = 'thread.turn-queued'
                  AND json_extract(request.payload_json, '$.messageId') = ${pin.messageId}
                  AND stopped.event_type IN ('thread.session-stop-requested', 'thread.archived')) AS stopped
            WHERE EXISTS (SELECT 1 FROM orchestration_events
              WHERE stream_id = ${threadId} AND event_type = 'thread.turn-queued'
                AND json_extract(payload_json, '$.messageId') = ${pin.messageId})
              OR EXISTS (SELECT 1 FROM queued_turn_promotions
                WHERE thread_id = ${threadId} AND message_id = ${pin.messageId})
          `)[0];
          if (queued && (queued.cancelled === 1 || queued.removed === 1 || queued.stopped === 1)) {
            return result(
              "interrupted",
              null,
              "Awaited queued task was cancelled or removed before provider start.",
            );
          }
          if (!(yield* dependencies.repository.isOutputSettled(threadId))) return null;
          const failure =
            pin.messageId !== null
              ? yield* dependencies.repository.initialFailure(threadId, pin.messageId)
              : null;
          if (failure) {
            return result(
              failure.status === "error" ? "error" : "interrupted",
              pin.runId,
              failure.error ?? "Awaited task stopped before its provider run started.",
            );
          }
          const cancelled = (yield* sql<{ eventType: string }>`
            SELECT terminal.event_type AS "eventType"
            FROM orchestration_events AS initial
            JOIN orchestration_events AS terminal ON terminal.stream_id = initial.stream_id
              AND terminal.sequence > initial.sequence
            WHERE initial.stream_id = ${threadId}
              AND initial.event_type = 'thread.turn-start-requested'
              AND json_extract(initial.payload_json, '$.messageId') = ${pin.messageId}
              AND (terminal.event_type IN ('thread.session-stop-requested', 'thread.archived',
                'thread.turn-interrupt-requested') OR (terminal.event_type = 'thread.claude-cache-response-requested'
                AND json_extract(terminal.payload_json, '$.decision') = 'cancel'))
              AND NOT EXISTS (SELECT 1 FROM orchestration_events AS later
                WHERE later.stream_id = initial.stream_id AND later.sequence > initial.sequence
                  AND later.sequence < terminal.sequence AND later.event_type = 'thread.turn-start-requested')
            ORDER BY terminal.sequence LIMIT 1
          `)[0];
          if (cancelled) {
            return result(
              "interrupted",
              pin.runId,
              "Awaited task was cancelled before provider start.",
            );
          }
          return null;
        }
        if (turn.state !== "completed" && turn.state !== "error" && turn.state !== "interrupted") {
          return null;
        }
        const terminal = yield* readNativeCompletion(threadId, turn.turnId);
        if (terminal) {
          const pendingOutput = (yield* sql<{ count: number }>`
            SELECT count(*) AS count FROM provider_runtime_events
            WHERE thread_id = ${threadId} AND turn_id = ${turn.turnId}
              AND sequence > COALESCE((SELECT last_acked_sequence
                FROM provider_runtime_event_consumers
                WHERE consumer_name = ${PROVIDER_RUNTIME_INGESTION_CONSUMER}), 0)
          `)[0]?.count;
          if (pendingOutput !== 0) return null;
        } else if (!(yield* dependencies.repository.isOutputSettled(threadId))) {
          return null;
        }
        const state =
          terminal?.state === "failed"
            ? "error"
            : terminal?.state === "interrupted" || terminal?.state === "cancelled"
              ? "interrupted"
              : turn.state;
        if (
          state === "completed" &&
          terminal?.state !== "completed" &&
          !(yield* dependencies.repository.hasCompletedRun(threadId, turn.turnId))
        ) {
          return null;
        }
        const goal = (yield* sql<{ count: number }>`
          WITH anchor AS (
            SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
            WHERE stream_id = ${threadId} AND event_type = 'thread.turn-start-requested'
              AND json_extract(payload_json, '$.messageId') = ${turn.pendingMessageId ?? pin.messageId}
              AND occurred_at <= ${turn.requestedAt}
          ), goals AS (
            SELECT sequence, json_extract(payload_json, '$.goal') AS goal
            FROM orchestration_events
            WHERE stream_id = ${threadId} AND event_type IN ('thread.created', 'thread.meta-updated')
              AND json_type(payload_json, '$.goal') IS NOT NULL
              AND (${terminal?.sequence ?? null} IS NULL OR sequence <= ${terminal?.sequence ?? null})
              AND occurred_at <= ${turn.completedAt ?? turn.requestedAt}
          )
          SELECT count(*) AS count FROM goals
          WHERE length(trim(COALESCE(goal, ''))) > 0
            AND (sequence >= (SELECT sequence FROM anchor)
              OR sequence = (SELECT MAX(sequence) FROM goals WHERE sequence < (SELECT sequence FROM anchor)))
        `)[0]?.count;
        if (goal) {
          return result(
            "error",
            turn.turnId,
            "Awaiting a run does not establish goal completion. Read the thread for goal progress.",
          );
        }
        const detail = Option.getOrUndefined(
          yield* dependencies.snapshotQuery.getThreadDetailById(threadId),
        );
        if (!detail) return result("interrupted", turn.turnId, "Awaited task was deleted.");
        const messages = detail.messages.filter(
          (message) => message.role === "assistant" && message.turnId === turn.turnId,
        );
        if (messages.some((message) => message.streaming)) return null;
        const storedRow = (yield* sql`
          SELECT message.text, message.text_json AS "encodedText",
            ${selectMessageTextChunks(sql, "message")},
            EXISTS (SELECT 1 FROM projection_thread_messages AS pending
              WHERE pending.thread_id = message.thread_id AND pending.turn_id = message.turn_id
                AND pending.role = 'assistant' AND pending.is_streaming = 1) AS "hasStreaming"
          FROM projection_thread_messages AS message
          WHERE message.thread_id = ${threadId} AND message.turn_id = ${turn.turnId}
            AND message.role = 'assistant'
          ORDER BY CASE WHEN message.message_id = ${turn.assistantMessageId} THEN 1 ELSE 0 END DESC,
            CASE WHEN message.sequence IS NULL THEN 0 ELSE 1 END DESC,
            message.sequence DESC, message.created_at DESC, message.message_id DESC
          LIMIT 1
        `)[0];
        const stored = storedRow
          ? yield* Schema.decodeUnknownEffect(PersistedAssistantResult)(storedRow)
          : null;
        if (stored?.hasStreaming === 1) return null;
        const error =
          state === "error"
            ? (terminal?.error ??
              (child.latestTurn?.turnId === turn.turnId ? child.session?.lastError : null) ??
              "Awaited run failed.")
            : null;
        return result(
          state,
          turn.turnId,
          error,
          stored ? joinMessageTextChunks(stored) : messages.at(-1)?.text,
        );
      });
  });
