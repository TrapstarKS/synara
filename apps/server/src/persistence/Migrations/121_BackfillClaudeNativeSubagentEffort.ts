// Restore effort lost when native Claude children inherited their parent's selection.
// Repair the final authoritative selection as well as the projection: command receipts
// prevent runtime replay from repairing it, and projection-only repairs do not survive rebuilds.
import { isDeepStrictEqual } from "node:util";
import {
  decodeSubagentReceiverAgents,
  decodeSubagentReceiverThreadIds,
} from "@synara/shared/subagents";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const MIGRATION_121_PAGE_SIZE = 128;
const NATIVE_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function parseRecord(json: string): JsonObject | undefined {
  try {
    return record(JSON.parse(json));
  } catch {
    return undefined;
  }
}

function claudeSelection(value: unknown): JsonObject | undefined {
  const selection = record(value);
  if (
    selection?.provider !== "claudeAgent" ||
    typeof selection.model !== "string" ||
    selection.model.trim().length === 0 ||
    (selection.options !== undefined && record(selection.options) === undefined)
  ) {
    return undefined;
  }
  const effort = record(selection.options)?.effort;
  return effort === undefined || typeof effort === "string" ? selection : undefined;
}

function isNativeCommand(commandId: string | null, tag: string, childId: string): boolean {
  const suffix = `:${tag}:${childId}`;
  return (
    commandId !== null &&
    commandId.startsWith("provider:") &&
    commandId.endsWith(suffix) &&
    commandId.length > "provider:".length + suffix.length
  );
}

function selectionEffort(selection: JsonObject | undefined): string | undefined {
  const effort = record(selection?.options)?.effort;
  return typeof effort === "string" ? effort : undefined;
}

interface Candidate {
  readonly threadId: string;
  readonly parentId: string;
  readonly sourceTurnId: string | null;
  readonly selectionJson: string;
  readonly createdSequence: number | null;
  readonly initialEffort: string | null;
  readonly selectionSequence: number | null;
  readonly selectionPayloadJson: string | null;
  readonly effort: string | null;
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // Keep candidate state in indexed SQLite rows rather than retaining all history
      // or scanning a parent's complete activity history once for every sibling.
      yield* sql`DROP TABLE IF EXISTS temp_synara_claude_effort_121`;
      yield* sql`
        CREATE TEMP TABLE temp_synara_claude_effort_121 (
          thread_id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL,
          source_turn_id TEXT,
          selection_json TEXT NOT NULL,
          created_sequence INTEGER,
          initial_effort TEXT,
          selection_sequence INTEGER,
          selection_payload_json TEXT,
          effort TEXT,
          blocked INTEGER NOT NULL DEFAULT 0,
          conflicted INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID
      `;
      yield* sql`
        CREATE INDEX temp_synara_claude_effort_parent_121
        ON temp_synara_claude_effort_121(parent_id)
      `;

      let threadCursor = "";
      let candidateCount = 0;
      while (true) {
        const threads = yield* sql<{
          readonly threadId: string;
          readonly parentId: string;
          readonly sourceTurnId: string | null;
          readonly selectionJson: string;
        }>`
          SELECT child.thread_id AS "threadId", child.parent_thread_id AS "parentId",
            child.source_turn_id AS "sourceTurnId", child.model_selection_json AS "selectionJson"
          FROM projection_threads AS child
          JOIN projection_threads AS parent ON parent.thread_id = child.parent_thread_id
          WHERE child.thread_id > ${threadCursor}
            AND child.creation_source = 'provider_native'
            AND child.source_thread_id = child.parent_thread_id
            AND child.project_id = parent.project_id
            AND child.deleted_at IS NULL AND parent.deleted_at IS NULL
            AND child.gateway_operation_id IS NULL
            AND (child.handoff_json IS NULL OR child.handoff_json = 'null')
          ORDER BY child.thread_id ASC
          LIMIT ${MIGRATION_121_PAGE_SIZE}
        `;
        if (threads.length === 0) break;
        for (const thread of threads) {
          if (!claudeSelection(parseRecord(thread.selectionJson))) continue;
          const prefix = `subagent:${thread.parentId}:`;
          if (!thread.threadId.startsWith(prefix) || thread.threadId.length === prefix.length) {
            continue;
          }
          yield* sql`
            INSERT INTO temp_synara_claude_effort_121
              (thread_id, parent_id, source_turn_id, selection_json)
            VALUES (${thread.threadId}, ${thread.parentId}, ${thread.sourceTurnId}, ${thread.selectionJson})
          `;
          candidateCount += 1;
        }
        threadCursor = threads[threads.length - 1]!.threadId;
      }

      if (candidateCount > 0) {
        const [fence] = yield* sql<{ readonly sequence: number }>`
          SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
        `;
        let eventCursor = 0;
        while (true) {
          const events = yield* sql<{
            readonly sequence: number;
            readonly threadId: string;
            readonly eventType: string;
            readonly commandId: string | null;
            readonly actorKind: string;
            readonly payloadJson: string;
          }>`
            SELECT sequence, stream_id AS "threadId", event_type AS "eventType",
              command_id AS "commandId", actor_kind AS "actorKind", payload_json AS "payloadJson"
            FROM orchestration_events
            WHERE sequence > ${eventCursor} AND sequence <= ${fence!.sequence}
              AND +aggregate_kind = 'thread'
              AND +event_type IN (
                'thread.created', 'thread.meta-updated', 'thread.turn-start-requested',
                'thread.activity-appended', 'thread.reverted',
                'thread.conversation-rolled-back', 'thread.deleted'
              )
              AND (
                EXISTS (SELECT 1 FROM temp_synara_claude_effort_121 WHERE thread_id = stream_id)
                OR EXISTS (SELECT 1 FROM temp_synara_claude_effort_121 WHERE parent_id = stream_id)
              )
            ORDER BY sequence ASC
            LIMIT ${MIGRATION_121_PAGE_SIZE}
          `;
          if (events.length === 0) break;
          for (const event of events) {
            const payload = parseRecord(event.payloadJson);
            if (event.eventType === "thread.activity-appended") {
              const activity = record(payload?.activity);
              const activityPayload = record(activity?.payload);
              if (
                payload?.threadId !== event.threadId ||
                typeof activity?.id !== "string" ||
                !["tool.started", "tool.updated", "tool.completed"].includes(
                  String(activity.kind),
                ) ||
                activityPayload?.itemType !== "collab_agent_tool_call" ||
                event.actorKind !== "provider" ||
                !isNativeCommand(
                  event.commandId,
                  "thread-activity-append",
                  `${event.threadId}:${activity.kind}:${activity.id}`,
                )
              ) {
                continue;
              }
              const [retained] = yield* sql<{
                readonly payloadJson: string;
                readonly kind: string;
                readonly turnId: string | null;
              }>`
                SELECT payload_json AS "payloadJson", kind, turn_id AS "turnId"
                FROM projection_thread_activities
                WHERE activity_id = ${activity.id} AND thread_id = ${event.threadId}
              `;
              // A historical activity removed by rollback is not current evidence.
              if (
                !retained ||
                retained.kind !== activity.kind ||
                retained.turnId !== (activity.turnId ?? null) ||
                !isDeepStrictEqual(parseRecord(retained.payloadJson), activityPayload)
              ) {
                continue;
              }
              const data = record(activityPayload.data);
              const item = record(data?.item) ?? data;
              if (!item) continue;
              const receiverIds = decodeSubagentReceiverThreadIds(item);
              const receiverArray = item.receiverAgents ?? item.receiver_agents ?? item.agents;
              // Shared decoding handles aliases; recovery declines ambiguous positional joins.
              const fallbackIds =
                receiverIds.length === 1 &&
                (!Array.isArray(receiverArray) || receiverArray.length <= 1)
                  ? receiverIds
                  : [];
              for (const receiver of decodeSubagentReceiverAgents(item, fallbackIds)) {
                if (receiver.effort === undefined) continue;
                const childId = `subagent:${event.threadId}:${receiver.providerThreadId}`;
                const validEffort = NATIVE_EFFORTS.has(receiver.effort);
                yield* sql`
                  UPDATE temp_synara_claude_effort_121
                  SET conflicted = CASE
                      WHEN ${validEffort ? 1 : 0} = 0 OR (effort IS NOT NULL AND effort <> ${receiver.effort})
                      THEN 1 ELSE conflicted END,
                    effort = COALESCE(effort, ${validEffort ? receiver.effort : null})
                  WHERE thread_id = ${childId} AND parent_id = ${event.threadId}
                    AND (source_turn_id IS NULL OR source_turn_id = ${retained.turnId})
                `;
              }
              continue;
            }

            const [candidate] = yield* sql<Candidate>`
              SELECT thread_id AS "threadId", parent_id AS "parentId",
                source_turn_id AS "sourceTurnId", selection_json AS "selectionJson",
                created_sequence AS "createdSequence", initial_effort AS "initialEffort",
                selection_sequence AS "selectionSequence", selection_payload_json AS "selectionPayloadJson",
                effort
              FROM temp_synara_claude_effort_121
              WHERE thread_id = ${event.threadId} AND blocked = 0
            `;
            if (!candidate) continue;
            const selection = claudeSelection(payload?.modelSelection);
            const creating = event.eventType === "thread.created";
            const nativeSelection =
              selection !== undefined &&
              event.actorKind === "provider" &&
              isNativeCommand(
                event.commandId,
                creating ? "subagent-thread-create" : "subagent-thread-meta-update",
                candidate.threadId,
              );
            const invalidCreate =
              creating &&
              (candidate.createdSequence !== null ||
                !nativeSelection ||
                payload?.creationSource !== "provider_native" ||
                payload.parentThreadId !== candidate.parentId ||
                payload.sourceThreadId !== candidate.parentId ||
                (payload.sourceTurnId ?? null) !== candidate.sourceTurnId ||
                payload.gatewayOperationId != null ||
                payload.handoff != null);
            const invalidMeta =
              event.eventType === "thread.meta-updated" &&
              (candidate.createdSequence === null ||
                (payload?.modelSelection !== undefined && !nativeSelection) ||
                (payload?.parentThreadId !== undefined &&
                  payload.parentThreadId !== candidate.parentId) ||
                payload?.handoff !== undefined);
            if (
              payload?.threadId !== candidate.threadId ||
              invalidCreate ||
              invalidMeta ||
              (!creating && event.eventType !== "thread.meta-updated")
            ) {
              // Even a manual selection equal to the inherited value is an explicit choice.
              yield* sql`UPDATE temp_synara_claude_effort_121 SET blocked = 1 WHERE thread_id = ${candidate.threadId}`;
              continue;
            }
            if (creating) {
              yield* sql`
                UPDATE temp_synara_claude_effort_121
                SET created_sequence = ${event.sequence}, initial_effort = ${selectionEffort(selection) ?? null}
                WHERE thread_id = ${candidate.threadId}
              `;
            }
            if (selection) {
              yield* sql`
                UPDATE temp_synara_claude_effort_121
                SET selection_sequence = ${event.sequence}, selection_payload_json = ${event.payloadJson}
                WHERE thread_id = ${candidate.threadId}
              `;
            }
          }
          eventCursor = events[events.length - 1]!.sequence;
        }

        let repairCursor = "";
        while (true) {
          const candidates = yield* sql<Candidate>`
            SELECT thread_id AS "threadId", parent_id AS "parentId",
              source_turn_id AS "sourceTurnId", selection_json AS "selectionJson",
              created_sequence AS "createdSequence", initial_effort AS "initialEffort",
              selection_sequence AS "selectionSequence", selection_payload_json AS "selectionPayloadJson",
              effort
            FROM temp_synara_claude_effort_121
            WHERE thread_id > ${repairCursor} AND blocked = 0 AND conflicted = 0
              AND effort IS NOT NULL AND created_sequence IS NOT NULL
              AND selection_sequence IS NOT NULL AND selection_payload_json IS NOT NULL
            ORDER BY thread_id ASC LIMIT ${MIGRATION_121_PAGE_SIZE}
          `;
          if (candidates.length === 0) break;
          for (const candidate of candidates) {
            const current = claudeSelection(parseRecord(candidate.selectionJson));
            const authoritative = claudeSelection(
              parseRecord(candidate.selectionPayloadJson!)?.modelSelection,
            );
            const previousEffort = selectionEffort(current);
            if (
              !current ||
              !authoritative ||
              !isDeepStrictEqual(current, authoritative) ||
              previousEffort === candidate.effort ||
              (previousEffort !== undefined && previousEffort !== candidate.initialEffort)
            ) {
              continue;
            }
            // A native meta event may have concretized the model since creation. Keep it,
            // and all other options, exactly as stored; tool model aliases are only hints.
            const changedEvent = yield* sql<{ readonly sequence: number }>`
              UPDATE orchestration_events
              SET payload_json = json_set(payload_json, '$.modelSelection.options.effort', ${candidate.effort})
              WHERE sequence = ${candidate.selectionSequence} AND stream_id = ${candidate.threadId}
                AND payload_json = ${candidate.selectionPayloadJson}
              RETURNING sequence
            `;
            const changedThread = yield* sql<{ readonly threadId: string }>`
              UPDATE projection_threads
              SET model_selection_json = json_set(model_selection_json, '$.options.effort', ${candidate.effort})
              WHERE thread_id = ${candidate.threadId} AND model_selection_json = ${candidate.selectionJson}
              RETURNING thread_id AS "threadId"
            `;
            if (changedEvent.length !== 1 || changedThread.length !== 1) {
              return yield* Effect.die(
                new Error("Native Claude effort repair lost its selected row."),
              );
            }
          }
          repairCursor = candidates[candidates.length - 1]!.threadId;
        }
      }
      yield* sql`DROP TABLE temp_synara_claude_effort_121`;
    }),
  );
});
