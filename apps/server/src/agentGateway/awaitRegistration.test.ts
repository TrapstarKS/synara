import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import { ThreadId } from "@synara/contracts";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  makeAwaitRepository,
  type GatewayWaitTarget,
  type RegisterPinnedWaitInput,
} from "./awaitRepository.ts";

const now = "2026-10-01T00:00:00.000Z";
const pin = (threadId: string, messageId = `${threadId}:message`) => ({
  threadId,
  runId: null,
  messageId,
});
const request = (caller: string, children: string[]): RegisterPinnedWaitInput => ({
  callerThreadId: caller,
  callerTurnId: `${caller}:turn`,
  registeredSequence: 1,
  createdAt: now,
  pins: children.map((id) => pin(id)),
});
const targets = (row: { targetsJson: string }): GatewayWaitTarget[] => JSON.parse(row.targetsJson);

it.layer(SqlitePersistenceMemory)("automatic pinned wait registration", (it) => {
  it.effect(
    "merges concurrent delegates once and preserves pins when the repository is rebuilt",
    () =>
      Effect.gen(function* () {
        const repository = yield* makeAwaitRepository;
        const input = request("append-concurrent", ["child-a"]);
        const first = yield* repository.registerPinned(input);
        yield* Effect.all(
          [
            repository.registerPinned({ ...input, pins: [pin("child-b")] }),
            repository.registerPinned({ ...input, pins: [pin("child-c"), pin("child-a")] }),
            repository.registerPinned(input),
          ],
          { concurrency: "unbounded" },
        );
        const rebuilt = yield* makeAwaitRepository;
        const saved = (yield* rebuilt.getByScope(input.callerThreadId, input.callerTurnId))!;
        expect(saved.waitId).toBe(first.waitId);
        expect(
          targets(saved)
            .map((target) => target.pin.threadId)
            .toSorted(),
        ).toEqual(["child-a", "child-b", "child-c"]);
        expect(saved.registeredSequence).toBe(1);
        expect(
          (yield* rebuilt.pending()).filter((row) => row.waitId === first.waitId),
        ).toHaveLength(1);
      }),
  );
  it.effect("keeps explicit request replay immutable after automatic targets are appended", () =>
    Effect.gen(function* () {
      const repository = yield* makeAwaitRepository;
      const input = request("append-explicit", ["original-child"]);
      const original = {
        ...input,
        waitId: "append-explicit:wait",
        requestJson: JSON.stringify({ threadIds: ["original-child"], runIds: [null] }),
        targetsJson: JSON.stringify(input.pins.map((pin) => ({ pin, result: null }))),
      };
      yield* repository.reserve(original);
      yield* repository.registerPinned({
        ...input,
        pins: [pin("extra-child")],
        registeredSequence: 100,
      });
      const replay = yield* repository.reserve(original);
      expect(replay.requestJson).toBe(original.requestJson);
      expect(replay.registeredSequence).toBe(1);
      expect(targets(replay)).toHaveLength(2);
      const error = yield* repository
        .reserve({ ...original, requestJson: "different" })
        .pipe(Effect.flip);
      expect(error.message).toContain("different wait");
    }),
  );
  it.effect("preserves frozen results and coordination metadata during rearm merges", () =>
    Effect.gen(function* () {
      const repository = yield* makeAwaitRepository;
      const input = request("append-frozen", ["finished-child"]);
      const threadId = ThreadId.makeUnsafe("finished-child");
      const result: GatewayWaitTarget["result"] = {
        threadId,
        runId: null,
        state: "completed",
        terminal: true,
        timedOut: false,
        summary: "The exact saved answer",
        summaryTruncated: false,
        error: null,
        readThread: { tool: "synara_read_thread", arguments: { threadId } },
      };
      const requestJson = JSON.stringify({
        kind: "coordinator-rearm",
        coordinationRootWaitId: "root-wait",
        threadIds: [threadId],
      });
      const first = yield* repository.appendTargets({
        ...input,
        waitId: "custom-rearm-id",
        requestJson,
        targets: [{ pin: input.pins[0]!, result }],
      });
      const merged = yield* repository.registerPinned({
        ...input,
        pins: [...input.pins, pin("new-child")],
        waitId: "ignored-on-merge",
        requestJson: "ignored-on-merge",
        registeredSequence: 999,
      });
      expect(merged.waitId).toBe(first.waitId);
      expect(merged.requestJson).toBe(requestJson);
      expect(merged.registeredSequence).toBe(1);
      expect(targets(merged)[0]?.result).toEqual(result);
      expect(targets(merged)[1]?.result).toBeNull();
    }),
  );
  it.effect(
    "retains distinct queued messages and enforces the aggregate limit before mutation",
    () =>
      Effect.gen(function* () {
        const repository = yield* makeAwaitRepository;
        const input = request("append-bound", []);
        const pins = Array.from({ length: 20 }, (_, index) =>
          pin("same-child", `message-${index}`),
        );
        const first = yield* repository.registerPinned({ ...input, pins });
        expect(targets(first).map((target) => target.pin.messageId)).toEqual(
          pins.map((pin) => pin.messageId),
        );
        expect((yield* repository.registerPinned({ ...input, pins: [pins[0]!] })).waitId).toBe(
          first.waitId,
        );
        const error = yield* repository
          .registerPinned({ ...input, pins: [pin("twenty-first")] })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ code: "creation_limit_exceeded" });
        expect(yield* repository.getById(first.waitId)).toEqual(first);
      }),
  );
  it.effect("rejects appended transitive and self cycles without changing saved targets", () =>
    Effect.gen(function* () {
      const repository = yield* makeAwaitRepository;
      const input = request("append-cycle-a", ["append-cycle-b"]);
      const first = yield* repository.registerPinned(input);
      yield* repository.registerPinned(request("append-cycle-b", ["append-cycle-c"]));
      for (const attempted of [
        request("append-cycle-c", ["append-cycle-a"]),
        request("append-cycle-a", ["append-cycle-a"]),
      ]) {
        const error = yield* repository.registerPinned(attempted).pipe(Effect.flip);
        expect(error.message).toContain("dependency cycle");
      }
      expect(yield* repository.getById(first.waitId)).toEqual(first);
      expect(yield* repository.getByScope("append-cycle-c", "append-cycle-c:turn")).toBeNull();
    }),
  );
  it.effect(
    "blocks stale delivery snapshots and additions after dispatch while allowing exact replay",
    () =>
      Effect.gen(function* () {
        const repository = yield* makeAwaitRepository;
        const input = request("append-delivery", ["first-child"]);
        const first = yield* repository.registerPinned(input);
        const updated = yield* repository.registerPinned({ ...input, pins: [pin("second-child")] });
        expect(
          (yield* repository.prepareDispatch(first.waitId, first.targetsJson, "stale"))?.state,
        ).toBe("waiting");
        yield* repository.saveTargets(first.waitId, first.targetsJson, "[]");
        expect((yield* repository.getById(first.waitId))?.targetsJson).toBe(updated.targetsJson);
        const prepared = yield* repository.prepareDispatch(
          first.waitId,
          updated.targetsJson,
          "saved-command",
        );
        const error = yield* repository
          .registerPinned({ ...input, pins: [pin("third-child")] })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ code: "operation_failed" });
        expect(yield* repository.registerPinned(input)).toEqual(prepared);
        yield* repository.settle(first.waitId, "dispatched", now);
        expect((yield* repository.registerPinned(input)).state).toBe("dispatched");
      }),
  );
  it.effect("rolls back both a new wait and an append when the enclosing reservation fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* makeAwaitRepository;
      yield* sql`CREATE TABLE pinned_registration_test_reservations (id TEXT PRIMARY KEY)`;
      const input = request("append-rollback", ["first-child"]);
      const failAfterRegistration = (id: string, pins: RegisterPinnedWaitInput["pins"]) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO pinned_registration_test_reservations (id) VALUES (${id})`;
            yield* repository.registerPinned({ ...input, pins });
            return yield* Effect.fail(new Error("injected reservation failure"));
          }),
        );
      yield* failAfterRegistration("new", input.pins).pipe(Effect.flip);
      expect(yield* repository.getByScope(input.callerThreadId, input.callerTurnId)).toBeNull();
      const saved = yield* repository.registerPinned(input);
      yield* failAfterRegistration("append", [pin("second-child")]).pipe(Effect.flip);
      expect(yield* repository.getById(saved.waitId)).toEqual(saved);
      expect(yield* sql`SELECT id FROM pinned_registration_test_reservations`).toEqual([]);
    }),
  );
  it.effect("rejects empty automatic pins while allowing a server-owned answer wait", () =>
    Effect.gen(function* () {
      const repository = yield* makeAwaitRepository;
      const input = request("append-answer", []);
      const failure = yield* repository.registerPinned(input).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "operation_failed" });
      const answer = yield* repository.appendTargets({
        ...input,
        waitId: "answer-wait",
        requestJson: JSON.stringify({
          kind: "coordinator-answer",
          questionId: "question-1",
          threadIds: [],
        }),
        targets: [],
      });
      expect(answer.waitId).toBe("answer-wait");
      expect(targets(answer)).toEqual([]);
    }),
  );
});
