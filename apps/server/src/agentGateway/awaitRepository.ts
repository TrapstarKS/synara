import {
  SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
  SynaraWaitedThreadResult,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { canonicalJson, stableGatewayDigest } from "./creationUtils.ts";
import type { PinnedThreadTarget } from "./pinnedThreadResult.ts";
import { GatewayToolError } from "./toolRuntime.ts";

export interface GatewayWaitRow {
  readonly waitId: string;
  readonly callerThreadId: string;
  readonly callerTurnId: string;
  readonly requestJson: string;
  readonly targetsJson: string;
  readonly registeredSequence: number;
  readonly createdAt: string;
  readonly state: "waiting" | "dispatching" | "dispatched" | "cancelled";
  readonly dispatchJson: string | null;
}

export interface GatewayWaitTarget {
  readonly pin: PinnedThreadTarget;
  readonly result: SynaraWaitedThreadResult | null;
}

export interface PinnedWaitScope {
  readonly callerThreadId: string;
  readonly callerTurnId: string;
  readonly registeredSequence: number;
  readonly createdAt: string;
  // Identity and metadata are used only for new rows. Always use the returned
  // row when appending to an existing wait for this caller turn.
  readonly waitId?: string;
  readonly requestJson?: string;
}

export interface RegisterPinnedWaitInput extends PinnedWaitScope {
  readonly pins: ReadonlyArray<PinnedThreadTarget>;
}

export interface AppendWaitTargetsInput extends PinnedWaitScope {
  readonly targets: ReadonlyArray<GatewayWaitTarget>;
}

const PinnedWaitTarget = Schema.Struct({
  pin: Schema.Struct({
    threadId: Schema.String.check(Schema.isNonEmpty()),
    runId: Schema.NullOr(Schema.String.check(Schema.isNonEmpty())),
    messageId: Schema.NullOr(Schema.String.check(Schema.isNonEmpty())),
  }).check(Schema.makeFilter((pin) => pin.runId !== null || pin.messageId !== null)),
  result: Schema.NullOr(SynaraWaitedThreadResult),
});
const PinnedWaitTargets = Schema.Array(PinnedWaitTarget).check(
  Schema.isMaxLength(SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION),
);
const decodePinnedTargets = Schema.decodeUnknownEffect(PinnedWaitTargets);
const decodeStoredTargets = Schema.decodeUnknownEffect(Schema.fromJsonString(PinnedWaitTargets));
const pinKey = (pin: PinnedThreadTarget) => canonicalJson([pin.threadId, pin.runId, pin.messageId]);

export const makeAwaitRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(`wait_id AS "waitId", caller_thread_id AS "callerThreadId",
    caller_turn_id AS "callerTurnId", request_json AS "requestJson", targets_json AS "targetsJson",
    registered_sequence AS "registeredSequence", created_at AS "createdAt", state,
    dispatch_json AS "dispatchJson"`);
  const getById = (waitId: string) =>
    sql<GatewayWaitRow>`SELECT ${columns} FROM agent_gateway_waits WHERE wait_id = ${waitId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );
  const getByScope = (callerThreadId: string, callerTurnId: string) =>
    sql<GatewayWaitRow>`SELECT ${columns} FROM agent_gateway_waits
      WHERE caller_thread_id = ${callerThreadId} AND caller_turn_id = ${callerTurnId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );
  const pending = () =>
    sql<GatewayWaitRow>`SELECT ${columns} FROM agent_gateway_waits
      WHERE state IN ('waiting', 'dispatching')
        AND NOT EXISTS (SELECT 1 FROM agent_gateway_awaited_dispatches AS dispatch
          WHERE dispatch.wait_id = agent_gateway_waits.wait_id AND dispatch.state = 'reserved')
      ORDER BY created_at, wait_id`;
  const dispatchReceipt = (waitId: string) =>
    sql<{ status: string }>`SELECT receipt.status FROM agent_gateway_waits AS wait
      JOIN orchestration_command_receipts AS receipt
        ON receipt.command_id = json_extract(wait.dispatch_json, '$.commandId')
      WHERE wait.wait_id = ${waitId}`.pipe(Effect.map((rows) => rows[0]?.status ?? null));
  const assertAcyclic = (callerThreadId: string, targetsJson: string) =>
    Effect.gen(function* () {
      const cycles = yield* sql<{ count: number }>`WITH RECURSIVE dependencies(thread_id) AS (
        SELECT json_extract(value, '$.pin.threadId') FROM json_each(${targetsJson})
        UNION
        SELECT json_extract(target.value, '$.pin.threadId')
        FROM dependencies AS dependency
        JOIN agent_gateway_waits AS wait ON wait.caller_thread_id = dependency.thread_id
        JOIN json_each(wait.targets_json) AS target
        WHERE wait.state IN ('waiting', 'dispatching')
      ) SELECT count(*) AS count FROM dependencies WHERE thread_id = ${callerThreadId}`;
      if ((cycles[0]?.count ?? 0) > 0) {
        return yield* Effect.fail(
          new GatewayToolError("operation_failed", "This wait would create a dependency cycle."),
        );
      }
    });
  const reserve = (input: Omit<GatewayWaitRow, "state" | "dispatchJson">) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* getByScope(input.callerThreadId, input.callerTurnId);
        if (existing) {
          if (existing.requestJson !== input.requestJson) {
            return yield* Effect.fail(
              new GatewayToolError(
                "idempotency_conflict",
                "This turn already registered a different wait. Reuse the original threadIds and runIds.",
              ),
            );
          }
          return existing;
        }
        yield* assertAcyclic(input.callerThreadId, input.targetsJson);
        yield* sql`INSERT INTO agent_gateway_waits
          (wait_id, caller_thread_id, caller_turn_id, request_json, targets_json, registered_sequence, created_at)
          VALUES (${input.waitId}, ${input.callerThreadId}, ${input.callerTurnId}, ${input.requestJson},
            ${input.targetsJson}, ${input.registeredSequence}, ${input.createdAt})`;
        return { ...input, state: "waiting" as const, dispatchJson: null };
      }),
    );
  /** Persistence only; callers establish authority and may compose this with
   * their operation reservation inside sql.withTransaction. Empty targets are
   * reserved for internal answer waits; registerPinned requires at least one. */
  const appendTargets = (input: AppendWaitTargetsInput) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const incoming = yield* decodePinnedTargets(input.targets);
        const existing = yield* getByScope(input.callerThreadId, input.callerTurnId);
        const targets: GatewayWaitTarget[] = existing
          ? [...(yield* decodeStoredTargets(existing.targetsJson))]
          : [];
        const originalCount = targets.length;
        const keys = new Set(targets.map((target) => pinKey(target.pin)));
        for (const target of incoming) {
          const key = pinKey(target.pin);
          if (keys.has(key)) continue;
          keys.add(key);
          targets.push(target);
        }
        if (targets.length > SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION) {
          return yield* Effect.fail(
            new GatewayToolError(
              "creation_limit_exceeded",
              "This caller turn can await at most 20 exact targets.",
            ),
          );
        }
        // Exact replays never reopen settled rows or refresh frozen results,
        // metadata, or the watermark used to detect revocation.
        if (existing && targets.length === originalCount) return existing;
        if (existing && existing.state !== "waiting") {
          return yield* Effect.fail(
            new GatewayToolError(
              "operation_failed",
              "The caller's saved wait is already settled or dispatching; new targets cannot be appended.",
            ),
          );
        }
        const targetsJson = JSON.stringify(targets);
        if (!existing) {
          return yield* reserve({
            waitId:
              input.waitId ??
              `gateway-await:${stableGatewayDigest({
                threadId: input.callerThreadId,
                callerTurnId: input.callerTurnId,
              })}`,
            callerThreadId: input.callerThreadId,
            callerTurnId: input.callerTurnId,
            registeredSequence: input.registeredSequence,
            createdAt: input.createdAt,
            requestJson:
              input.requestJson ??
              canonicalJson({
                threadIds: targets.map((target) => target.pin.threadId),
                runIds: targets.map((target) => target.pin.runId),
              }),
            targetsJson,
          });
        }
        yield* assertAcyclic(input.callerThreadId, targetsJson);
        // Preserve explicit request bytes so its exact replay remains valid
        // after automatic delegations join the same eventual continuation.
        yield* sql`UPDATE agent_gateway_waits SET targets_json = ${targetsJson}
          WHERE wait_id = ${existing.waitId} AND state = 'waiting'
            AND targets_json = ${existing.targetsJson}`;
        return (yield* getById(existing.waitId))!;
      }),
    );
  const registerPinned = (input: RegisterPinnedWaitInput) =>
    input.pins.length === 0
      ? Effect.fail(new GatewayToolError("operation_failed", "Provide at least one exact target."))
      : appendTargets({
          ...input,
          targets: input.pins.map((pin) => ({ pin, result: null })),
        });
  const saveTargets = (waitId: string, previousJson: string, targetsJson: string) =>
    sql`UPDATE agent_gateway_waits SET targets_json = ${targetsJson}
      WHERE wait_id = ${waitId} AND state = 'waiting' AND targets_json = ${previousJson}`.pipe(
      Effect.asVoid,
    );
  const prepareDispatch = (waitId: string, targetsJson: string, dispatchJson: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE agent_gateway_waits SET state = 'dispatching', dispatch_json = ${dispatchJson}
          WHERE wait_id = ${waitId} AND state = 'waiting' AND dispatch_json IS NULL
            AND targets_json = ${targetsJson}
            AND NOT EXISTS (SELECT 1 FROM agent_gateway_awaited_dispatches AS dispatch
              WHERE dispatch.wait_id = agent_gateway_waits.wait_id AND dispatch.state = 'reserved')`;
        return yield* getById(waitId);
      }),
    );
  const settle = (waitId: string, state: "dispatched" | "cancelled", now: string) =>
    sql`UPDATE agent_gateway_waits SET state = ${state}, settled_at = ${now}
      WHERE wait_id = ${waitId} AND state IN ('waiting', 'dispatching')`.pipe(Effect.asVoid);
  return {
    getById,
    getByScope,
    pending,
    dispatchReceipt,
    reserve,
    registerPinned,
    appendTargets,
    saveTargets,
    prepareDispatch,
    settle,
  };
});

export type AwaitRepository = Effect.Success<typeof makeAwaitRepository>;
