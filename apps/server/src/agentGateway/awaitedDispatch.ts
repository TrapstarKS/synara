import {
  CommandId,
  MessageId,
  ThreadId,
  ThreadTurnStartCommand,
  TurnId,
  type OrchestrationThreadShell,
  type SynaraWaitedThreadResult,
} from "@synara/contracts";
import { runtimeModeEscalatesPrivilege } from "@synara/shared/runtimeMode";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeThreadAwaitGuard } from "../orchestration/threadAwaitGuard.ts";
import { makeAwaitRepository, type PinnedWaitScope } from "./awaitRepository.ts";
import { canonicalJson, stableGatewayDigest } from "./creationUtils.ts";
import type { PinnedThreadTarget } from "./pinnedThreadResult.ts";
import { errorText } from "./toolInput.ts";
import { GatewayToolError } from "./toolRuntime.ts";

interface AwaitedDispatchRow {
  readonly dispatchId: string;
  readonly kind: "creation" | "send";
  readonly callerThreadId: string;
  readonly callerTurnId: string;
  readonly requestId: string;
  readonly waitId: string;
  readonly fingerprint: string;
  readonly commandId: string | null;
  readonly commandJson: string | null;
  readonly pinsJson: string;
  readonly state: "reserved" | "accepted" | "failed";
  readonly error: string | null;
  readonly createdAt: string;
}

const Pin = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(Schema.String),
});
const decodePins = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Pin)));
const decodeTargets = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        pin: Pin,
        result: Schema.NullOr(Schema.Unknown),
      }),
    ),
  ),
);

export const makeAwaitedDispatch = (input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const waits = yield* makeAwaitRepository;
    const guard = yield* makeThreadAwaitGuard;
    const columns = sql.literal(`dispatch_id AS "dispatchId", kind,
    caller_thread_id AS "callerThreadId", caller_turn_id AS "callerTurnId", request_id AS "requestId",
    wait_id AS "waitId", fingerprint, command_id AS "commandId", command_json AS "commandJson",
    pins_json AS "pinsJson", state, error, created_at AS "createdAt"`);
    const get = (dispatchId: string) =>
      sql<AwaitedDispatchRow>`SELECT ${columns} FROM agent_gateway_awaited_dispatches
      WHERE dispatch_id = ${dispatchId}`.pipe(Effect.map((rows) => rows[0] ?? null));
    const requireWait = (waitId: string) =>
      waits
        .getById(waitId)
        .pipe(
          Effect.flatMap((row) =>
            row
              ? Effect.succeed(row)
              : Effect.fail(
                  new GatewayToolError("operation_failed", "The saved caller wait is unavailable."),
                ),
          ),
        );
    const accept = (dispatchId: string) =>
      sql`UPDATE agent_gateway_awaited_dispatches
    SET state = 'accepted', command_json = NULL WHERE dispatch_id = ${dispatchId} AND state = 'reserved'`.pipe(
        Effect.asVoid,
      );
    const fail = (row: AwaitedDispatchRow, reason: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const saved = yield* get(row.dispatchId);
          if (!saved || saved.state !== "reserved") return;
          const wait = yield* waits.getById(row.waitId);
          if (wait?.state === "waiting") {
            const pins = yield* decodePins(row.pinsJson);
            const keys = new Set(pins.map(canonicalJson));
            const current = yield* decodeTargets(wait.targetsJson);
            const targets = current.map((target) => {
              if (!keys.has(canonicalJson(target.pin))) return target;
              const threadId = ThreadId.makeUnsafe(target.pin.threadId);
              const result: SynaraWaitedThreadResult = {
                threadId,
                runId: null,
                state: "error",
                terminal: true,
                timedOut: false,
                summary: null,
                summaryTruncated: false,
                error: reason.slice(0, 4000),
                readThread: { tool: "synara_read_thread", arguments: { threadId } },
              };
              return { pin: target.pin, result };
            });
            yield* waits.saveTargets(wait.waitId, wait.targetsJson, JSON.stringify(targets));
          }
          yield* sql`UPDATE agent_gateway_awaited_dispatches SET state = 'failed',
      error = ${reason.slice(0, 4000)}, command_json = NULL
      WHERE dispatch_id = ${row.dispatchId} AND state = 'reserved'`;
        }),
      );

    const reserve = (request: {
      readonly dispatchId: string;
      readonly kind: AwaitedDispatchRow["kind"];
      readonly requestId: string;
      readonly fingerprint: string;
      readonly scope: PinnedWaitScope;
      readonly pins: ReadonlyArray<PinnedThreadTarget>;
      readonly command?: typeof ThreadTurnStartCommand.Type;
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* get(request.dispatchId);
          if (existing) {
            if (
              existing.fingerprint !== request.fingerprint ||
              existing.callerThreadId !== request.scope.callerThreadId ||
              existing.callerTurnId !== request.scope.callerTurnId
            ) {
              return yield* Effect.fail(
                new GatewayToolError(
                  "idempotency_conflict",
                  "This requestId already belongs to a different awaited dispatch.",
                ),
              );
            }
            return { dispatch: existing, wait: yield* requireWait(existing.waitId) };
          }
          const wait = yield* waits.registerPinned({ ...request.scope, pins: request.pins });
          if (wait.state !== "waiting")
            return yield* Effect.fail(
              new GatewayToolError("operation_failed", "This caller wait cannot accept new work."),
            );
          yield* sql`INSERT INTO agent_gateway_awaited_dispatches
      (dispatch_id, kind, caller_thread_id, caller_turn_id, request_id, wait_id,
        fingerprint, command_id, command_json, pins_json, created_at)
      VALUES (${request.dispatchId}, ${request.kind}, ${request.scope.callerThreadId},
        ${request.scope.callerTurnId}, ${request.requestId}, ${wait.waitId}, ${request.fingerprint},
        ${request.command?.commandId ?? null}, ${request.command ? JSON.stringify(request.command) : null},
        ${JSON.stringify(request.pins)}, ${request.scope.createdAt})`;
          return { dispatch: (yield* get(request.dispatchId))!, wait };
        }),
      );

    const reserveCreation = (request: {
      readonly operationId: string;
      readonly requestId: string;
      readonly scope: PinnedWaitScope;
      readonly pins: ReadonlyArray<PinnedThreadTarget>;
    }) =>
      reserve({
        ...request,
        dispatchId: request.operationId,
        kind: "creation",
        fingerprint: stableGatewayDigest(request.pins, 64),
      }).pipe(Effect.map((value) => value.wait));

    const receipt = (row: AwaitedDispatchRow) =>
      sql<{ status: string }>`
    SELECT status FROM orchestration_command_receipts WHERE command_id = ${row.commandId}`.pipe(
        Effect.map((rows) => rows[0]?.status ?? null),
      );

    // Recovery rechecks the durable caller authorization and current execution
    // boundaries. It never recreates a command with a new message or timestamp.
    const validateRecovery = (
      row: AwaitedDispatchRow,
      command: typeof ThreadTurnStartCommand.Type,
    ) =>
      Effect.gen(function* () {
        const wait = yield* requireWait(row.waitId);
        const check = yield* guard.check({
          threadId: ThreadId.makeUnsafe(row.callerThreadId),
          precondition: {
            waitId: wait.waitId,
            sourceTurnId: TurnId.makeUnsafe(wait.callerTurnId),
            registeredSequence: wait.registeredSequence,
          },
          stage: "accepted",
        });
        if (check.status !== "ready")
          return yield* Effect.fail(new GatewayToolError("caller_turn_inactive", check.reason));
        const caller = Option.getOrNull(
          yield* input.snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(row.callerThreadId)),
        );
        const target = Option.getOrNull(
          yield* input.snapshotQuery.getThreadShellById(command.threadId),
        );
        if (
          !caller ||
          !target ||
          target.archivedAt ||
          caller.archivedAt ||
          target.parentThreadId ||
          target.sidechatSourceThreadId ||
          target.runtimeMode !== command.runtimeMode ||
          target.interactionMode !== command.interactionMode ||
          runtimeModeEscalatesPrivilege(caller.runtimeMode, target.runtimeMode) ||
          (caller.envMode === "worktree" && (target.envMode ?? "local") === "local")
        ) {
          return yield* Effect.fail(
            new GatewayToolError(
              "capability_denied",
              "The saved dispatch no longer matches the caller or target execution permissions.",
            ),
          );
        }
      });

    const deliverSend = (
      row: AwaitedDispatchRow,
      assertAuthority?: () => Effect.Effect<void, GatewayToolError>,
    ) =>
      Effect.gen(function* () {
        if (row.state === "accepted") return;
        if (row.state === "failed")
          return yield* Effect.fail(
            new GatewayToolError(
              "operation_failed",
              row.error ?? "The awaited message dispatch failed.",
            ),
          );
        const status = yield* receipt(row);
        if (status === "accepted") {
          yield* accept(row.dispatchId);
          return;
        }
        if (status === "rejected") {
          yield* fail(row, "The saved message command was rejected.");
          return yield* Effect.fail(
            new GatewayToolError("operation_failed", "The saved message command was rejected."),
          );
        }
        if (!row.commandJson)
          return yield* Effect.fail(
            new GatewayToolError("operation_failed", "The saved dispatch command is unavailable."),
          );
        const command = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(ThreadTurnStartCommand),
        )(row.commandJson);
        if (assertAuthority) yield* assertAuthority();
        yield* validateRecovery(row, command);
        yield* input.orchestrationEngine.dispatch(command);
        yield* accept(row.dispatchId);
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // A transport failure after acceptance must not fail or resend the work.
            if ((yield* receipt(row)) === "accepted") {
              yield* accept(row.dispatchId);
              return;
            }
            if (error instanceof GatewayToolError || (yield* receipt(row)) === "rejected") {
              yield* fail(row, errorText(error));
            }
            return yield* Effect.fail(error);
          }),
        ),
      );

    const send = (request: {
      readonly requestId: string;
      readonly scope: PinnedWaitScope;
      readonly target: OrchestrationThreadShell;
      readonly message: string;
      readonly assertAuthority: () => Effect.Effect<void, GatewayToolError>;
    }) =>
      Effect.gen(function* () {
        if (request.target.parentThreadId || request.target.sidechatSourceThreadId) {
          return yield* Effect.fail(
            new GatewayToolError(
              "operation_failed",
              "Awaited messages require a standalone target thread; native subagent steering does not create an exact message-bound run.",
            ),
          );
        }
        const dispatchId = `gateway-send:${stableGatewayDigest({
          callerThreadId: request.scope.callerThreadId,
          callerTurnId: request.scope.callerTurnId,
          requestId: request.requestId,
        })}`;
        const messageId = MessageId.makeUnsafe(`${dispatchId}:message`);
        const reserved = yield* reserve({
          dispatchId,
          kind: "send",
          requestId: request.requestId,
          scope: request.scope,
          fingerprint: stableGatewayDigest(
            { threadId: request.target.id, message: request.message },
            64,
          ),
          pins: [{ threadId: request.target.id, runId: null, messageId }],
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`${dispatchId}:send`),
            awaitedDispatchId: dispatchId,
            threadId: request.target.id,
            message: { messageId, role: "user", text: request.message, attachments: [] },
            dispatchMode: "queue",
            dispatchOrigin: "agent",
            runtimeMode: request.target.runtimeMode,
            interactionMode: request.target.interactionMode,
            createdAt: request.scope.createdAt,
          },
        });
        yield* deliverSend(reserved.dispatch, request.assertAuthority);
        return {
          threadId: request.target.id,
          messageId,
          requestId: request.requestId,
          dispatched: "queue" as const,
          waitId: reserved.wait.waitId,
          instruction:
            "Wait registered for this exact message. Finish your current response when independent work is done; Synara will continue once with the results.",
        };
      });

    const repairPending = () =>
      Effect.gen(function* () {
        const pending = yield* sql<AwaitedDispatchRow>`SELECT ${columns}
      FROM agent_gateway_awaited_dispatches WHERE state = 'reserved' ORDER BY created_at LIMIT 200`;
        for (const row of pending) {
          yield* Effect.gen(function* () {
            if (row.kind === "send") {
              yield* deliverSend(row);
              return;
            }
            const operation = (yield* sql<{
              status: string;
            }>`SELECT status FROM agent_gateway_operations
          WHERE operation_id = ${row.dispatchId}`)[0];
            if (operation?.status === "completed") yield* accept(row.dispatchId);
            else if (!operation || operation.status === "failed")
              yield* fail(
                row,
                "The awaited creation operation failed or was compensated during recovery.",
              );
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Awaited dispatch reconciliation deferred", {
                dispatchId: row.dispatchId,
                error,
              }),
            ),
          );
        }
      });
    return { transaction: sql.withTransaction, reserveCreation, accept, send, repairPending };
  });

export type AwaitedDispatch = Effect.Success<ReturnType<typeof makeAwaitedDispatch>>;
