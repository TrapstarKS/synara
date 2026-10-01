import { it } from "@effect/vitest";
import {
  ThreadId,
  ThreadCoordinationListResult,
  type CoordinatorQuestion,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadCoordination } from "./threadCoordination.ts";

const now = "2026-10-01T10:00:00.000Z";
const layer = it.layer(SqlitePersistenceMemory);

const harness = (prefix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const caller = ThreadId.makeUnsafe(`${prefix}:caller`);
    const child = ThreadId.makeUnsafe(`${prefix}:child`);
    const waitId = `${prefix}:wait`;
    const scopes: { threadId: string; waitId: string }[] = [];
    let shellReads = 0;
    let questions: readonly CoordinatorQuestion[] = [];
    const childShell = {
      id: child,
      title: "Executor review",
      modelSelection: { provider: "codex", model: "fixture" },
      session: { activeTurnId: `${prefix}:other-run`, providerName: "codex" },
      latestTurn: { turnId: `${prefix}:other-run` },
      hasPendingApprovals: true,
    } as unknown as OrchestrationThreadShell;
    yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${caller}, 'project', 'Coordinator', '{"provider":"codex","model":"fixture"}', 'approval-required', 'default', ${now}, ${now})`;
    yield* sql`INSERT INTO agent_gateway_waits
    (wait_id, caller_thread_id, caller_turn_id, request_json, targets_json, registered_sequence, created_at)
    VALUES (${waitId}, ${caller}, ${`${prefix}:source`}, ${JSON.stringify({ threadIds: [child] })},
      ${JSON.stringify([{ pin: { threadId: child, runId: null, messageId: `${prefix}:request` }, result: null }])}, 0, ${now})`;
    const service = yield* makeThreadCoordination({
      snapshotQuery: {
        getThreadShellsByIds: () =>
          Effect.sync(() => {
            shellReads++;
            return [childShell];
          }),
      },
      orchestrationEngine: { dispatch: () => Effect.succeed({ sequence: 0 }) },
      questions: {
        list: () => Effect.sync(() => questions),
        answerHuman: () => Effect.succeed({ accepted: true }),
        cancelForWait: (scope) =>
          Effect.sync(() => {
            scopes.push(scope);
          }),
      },
    });
    return {
      sql,
      caller,
      child,
      waitId,
      service,
      scopes,
      childShell,
      shellReads: () => shellReads,
      setQuestions: (value: readonly CoordinatorQuestion[]) => {
        questions = value;
      },
    };
  });

layer("thread coordination views", (it) => {
  it.effect("reads exact pending targets without borrowing a later run's approval or success", () =>
    Effect.gen(function* () {
      const h = yield* harness("exact-view");
      let view = yield* h.service.list({ threadId: h.caller });
      expect(view.waits[0]?.targets[0]?.state).toBe("queued");
      yield* h.sql`INSERT INTO projection_turns
      (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
      VALUES (${h.child}, 'expected-run', 'exact-view:request', 'completed', ${now}, '[]')`;
      view = yield* h.service.list({ threadId: h.caller });
      expect(view.waits[0]?.targets[0]).toMatchObject({ runId: "expected-run", state: "pending" });
      expect(h.shellReads()).toBe(2);
      expect(Schema.decodeUnknownSync(ThreadCoordinationListResult)(view)).toEqual(view);
    }),
  );

  it.effect("keeps internal answer waits private and allows only the exact caller to cancel", () =>
    Effect.gen(function* () {
      const h = yield* harness("scoped-view");
      yield* h.sql`INSERT INTO agent_gateway_waits
      (wait_id, caller_thread_id, caller_turn_id, request_json, targets_json, registered_sequence, created_at)
      VALUES ('internal-answer-view', ${h.caller}, 'internal-turn', '{"kind":"coordinator-answer"}', '[]', 0, ${now})`;
      expect((yield* h.service.list({})).waits.map((wait) => wait.waitId)).toContain(h.waitId);
      expect((yield* h.service.list({ threadId: h.caller })).waits).toHaveLength(1);
      expect(yield* h.service.cancelWait({ threadId: h.child, waitId: h.waitId })).toEqual({
        accepted: false,
      });
      expect(h.scopes).toHaveLength(0);
      expect(yield* h.service.cancelWait({ threadId: h.caller, waitId: h.waitId })).toEqual({
        accepted: true,
      });
      expect(h.scopes).toEqual([{ threadId: h.caller, waitId: h.waitId }]);
      expect(yield* h.service.cancelWait({ threadId: h.caller, waitId: h.waitId })).toEqual({
        accepted: false,
      });
      expect((yield* h.service.list({ threadId: h.caller })).waits).toHaveLength(0);
    }),
  );

  it.effect(
    "removes the wait card once its exact continuation starts and refuses stale cancellation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("started-view");
        yield* h.sql`UPDATE agent_gateway_waits SET state = 'dispatched',
      dispatch_json = '{"message":{"messageId":"started-wake"}}' WHERE wait_id = ${h.waitId}`;
        expect((yield* h.service.list({ threadId: h.caller })).waits).toHaveLength(1);
        yield* h.sql`INSERT INTO projection_turns
      (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
      VALUES (${h.caller}, 'started-native-run', 'started-wake', 'running', ${now}, '[]')`;
        expect((yield* h.service.list({ threadId: h.caller })).waits).toHaveLength(0);
        expect(yield* h.service.cancelWait({ threadId: h.caller, waitId: h.waitId })).toEqual({
          accepted: false,
        });
        expect(h.scopes).toHaveLength(0);
      }),
  );
});
