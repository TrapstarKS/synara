import {
  ThreadId,
  ThreadTurnStartCommand,
  TurnId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@synara/contracts";
import { runtimeModeEscalatesPrivilege } from "@synara/shared/runtimeMode";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { makeThreadAwaitGuard } from "../orchestration/threadAwaitGuard.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { canonicalJson } from "./creationUtils.ts";

interface DispatchAdmissionRow {
  readonly callerThreadId: string;
  readonly callerTurnId: string;
  readonly waitId: string;
  readonly registeredSequence: number;
  readonly commandJson: string;
}

interface ThreadExecutionRow {
  readonly threadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly envMode: string | null;
  readonly parentThreadId: string | null;
  readonly sidechatSourceThreadId: string | null;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
}

/** Run inside the orchestration command's commit transaction. This is the
 * final authority check after a saved dispatch has waited in the engine queue;
 * receipt replay happens before it, so cancelling a wait cannot undo work that
 * was already accepted. No provider or orchestration calls run from here. */
export const makeAwaitedDispatchAdmission = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const waits = yield* makeThreadAwaitGuard;
  const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadTurnStartCommand));
  const check = (command: typeof ThreadTurnStartCommand.Type) =>
    Effect.gen(function* () {
      if (!command.awaitedDispatchId) return;
      const reject = (detail: string) =>
        Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Awaited dispatch refused: ${detail}`,
          }),
        );
      const saved = (yield* sql<DispatchAdmissionRow>`
      SELECT dispatch.caller_thread_id AS "callerThreadId", dispatch.caller_turn_id AS "callerTurnId",
        wait.wait_id AS "waitId", wait.registered_sequence AS "registeredSequence",
        dispatch.command_json AS "commandJson"
      FROM agent_gateway_awaited_dispatches AS dispatch
      JOIN agent_gateway_waits AS wait ON wait.wait_id = dispatch.wait_id
        AND wait.caller_thread_id = dispatch.caller_thread_id
        AND wait.caller_turn_id = dispatch.caller_turn_id
      WHERE dispatch.dispatch_id = ${command.awaitedDispatchId} AND dispatch.kind = 'send'
        AND dispatch.state = 'reserved' AND wait.state = 'waiting' AND wait.dispatch_json IS NULL
        AND dispatch.command_id = ${command.commandId} AND dispatch.command_json IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(dispatch.pins_json) AS pin
          WHERE json_extract(pin.value, '$.threadId') = ${command.threadId}
            AND json_extract(pin.value, '$.messageId') = ${command.message.messageId}
            AND json_extract(pin.value, '$.runId') IS NULL)
        AND EXISTS (SELECT 1 FROM json_each(wait.targets_json) AS target
          WHERE json_extract(target.value, '$.pin.threadId') = ${command.threadId}
            AND json_extract(target.value, '$.pin.messageId') = ${command.message.messageId}
            AND json_extract(target.value, '$.pin.runId') IS NULL
            AND json_extract(target.value, '$.result') IS NULL)
    `)[0];
      if (!saved)
        return yield* reject("The durable reservation or its exact waiting target is unavailable.");
      const frozen = yield* decodeCommand(saved.commandJson);
      if (canonicalJson(frozen) !== canonicalJson(command)) {
        return yield* reject("The command differs from the immutable reserved message.");
      }
      const permission = yield* waits.check({
        threadId: ThreadId.makeUnsafe(saved.callerThreadId),
        precondition: {
          waitId: saved.waitId,
          sourceTurnId: TurnId.makeUnsafe(saved.callerTurnId),
          registeredSequence: saved.registeredSequence,
        },
        stage: "accepted",
      });
      if (permission.status !== "ready") return yield* reject(permission.reason);
      const source = (yield* sql<{ state: string }>`SELECT state FROM projection_turns
      WHERE thread_id = ${saved.callerThreadId} AND turn_id = ${saved.callerTurnId}`)[0];
      if (!source || (source.state !== "running" && source.state !== "completed")) {
        return yield* reject("The requesting turn is unavailable or failed before dispatch.");
      }
      const threads = yield* sql<ThreadExecutionRow>`
      SELECT thread_id AS "threadId", runtime_mode AS "runtimeMode", interaction_mode AS "interactionMode",
        env_mode AS "envMode", parent_thread_id AS "parentThreadId",
        sidechat_source_thread_id AS "sidechatSourceThreadId", archived_at AS "archivedAt", deleted_at AS "deletedAt"
      FROM projection_threads WHERE thread_id IN (${saved.callerThreadId}, ${command.threadId})`;
      const caller = threads.find((row) => row.threadId === saved.callerThreadId);
      const target = threads.find((row) => row.threadId === command.threadId);
      if (
        !caller ||
        !target ||
        caller.archivedAt ||
        caller.deletedAt ||
        target.archivedAt ||
        target.deletedAt ||
        target.parentThreadId ||
        target.sidechatSourceThreadId ||
        target.runtimeMode !== command.runtimeMode ||
        target.interactionMode !== command.interactionMode ||
        runtimeModeEscalatesPrivilege(caller.runtimeMode, target.runtimeMode) ||
        (caller.envMode === "worktree" && (target.envMode ?? "local") === "local")
      ) {
        return yield* reject(
          "The caller or target no longer satisfies the reserved execution permissions.",
        );
      }
    }).pipe(
      Effect.mapError((error) =>
        error instanceof OrchestrationCommandInvariantError
          ? error
          : toPersistenceSqlError("AwaitedDispatchAdmission.check")(error),
      ),
    );
  return { check };
});
