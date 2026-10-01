import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import migration from "../persistence/Migrations/118_GatewayWaits.ts";
import { makeAwaitRepository } from "./awaitRepository.ts";

const now = "2026-09-30T22:00:00.000Z";
const wait = (caller: string, targets: string[], turn = `${caller}-turn`) => ({
  waitId: `${caller}:${turn}`,
  callerThreadId: caller,
  callerTurnId: turn,
  requestJson: JSON.stringify({ threadIds: targets, runIds: targets.map(() => null) }),
  targetsJson: JSON.stringify(
    targets.map((threadId) => ({
      pin: { threadId, runId: `${threadId}-run`, messageId: null },
      result: null,
    })),
  ),
  registeredSequence: 1,
  createdAt: now,
});

it.layer(SqlitePersistenceMemory)("durable thread waits", (it) => {
  it.effect("replays concurrent registration and preserves the original pins after restart", () =>
    Effect.gen(function* () {
      const repository = yield* makeAwaitRepository;
      const request = wait("owner-replay", ["child-replay"]);
      const rows = yield* Effect.all(
        [
          repository.reserve(request),
          repository.reserve({ ...request, targetsJson: "[]", registeredSequence: 50 }),
        ],
        { concurrency: "unbounded" },
      );
      expect(rows[0]).toEqual(rows[1]);
      const restarted = yield* makeAwaitRepository;
      expect(yield* restarted.getByScope(request.callerThreadId, request.callerTurnId)).toEqual(
        rows[0],
      );
      const conflict = yield* restarted
        .reserve({ ...request, requestJson: "different" })
        .pipe(Effect.flip);
      expect(conflict.message).toContain("different wait");
      yield* migration;
      expect(yield* restarted.getById(request.waitId)).toEqual(rows[0]);
    }),
  );

  it.effect("rejects direct and transitive cycles atomically", () =>
    Effect.gen(function* () {
      const repository = yield* makeAwaitRepository;
      yield* repository.reserve(wait("cycle-a", ["cycle-b"]));
      yield* repository.reserve(wait("cycle-b", ["cycle-c"]));
      for (const request of [wait("cycle-c", ["cycle-a"]), wait("self", ["self"])]) {
        const failure = yield* repository.reserve(request).pipe(Effect.flip);
        expect(failure.message).toContain("dependency cycle");
        expect(yield* repository.getById(request.waitId)).toBeNull();
      }
      yield* repository.settle("cycle-a:cycle-a-turn", "cancelled", now);
      expect((yield* repository.reserve(wait("cycle-c", ["cycle-a"]))).state).toBe("waiting");
    }),
  );

  it.effect(
    "freezes results and the dispatch across competing scans and lost acknowledgements",
    () =>
      Effect.gen(function* () {
        const repository = yield* makeAwaitRepository;
        const request = wait("freeze", ["freeze-child"]);
        yield* repository.reserve(request);
        const first = JSON.stringify([
          { pin: { threadId: "freeze-child" }, result: { summary: "first" } },
        ]);
        const late = JSON.stringify([
          { pin: { threadId: "freeze-child" }, result: { summary: "late" } },
        ]);
        yield* repository.saveTargets(request.waitId, request.targetsJson, first);
        yield* repository.saveTargets(request.waitId, request.targetsJson, late);
        expect((yield* repository.getById(request.waitId))?.targetsJson).toBe(first);
        expect(
          (yield* repository.prepareDispatch(request.waitId, request.targetsJson, "stale"))?.state,
        ).toBe("waiting");
        const command = JSON.stringify({
          commandId: "fixed",
          createdAt: now,
          message: { text: "first" },
        });
        const prepared = yield* repository.prepareDispatch(request.waitId, first, command);
        const restarted = yield* makeAwaitRepository;
        expect(
          (yield* restarted.prepareDispatch(request.waitId, first, "changed"))?.dispatchJson,
        ).toBe(command);
        yield* restarted.saveTargets(request.waitId, first, late);
        expect((yield* restarted.getById(request.waitId))?.targetsJson).toBe(first);
        expect(prepared?.state).toBe("dispatching");
        yield* restarted.settle(request.waitId, "dispatched", now);
        yield* restarted.settle(request.waitId, "cancelled", now);
        expect((yield* restarted.getById(request.waitId))?.state).toBe("dispatched");
        expect((yield* restarted.pending()).some((row) => row.waitId === request.waitId)).toBe(
          false,
        );
      }),
  );
});
