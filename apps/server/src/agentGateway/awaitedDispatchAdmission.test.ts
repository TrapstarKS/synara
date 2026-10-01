import { it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId, type ThreadTurnStartCommand } from "@synara/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeAwaitRepository } from "./awaitRepository.ts";
import { makeAwaitedDispatchAdmission } from "./awaitedDispatchAdmission.ts";

const now = "2026-10-01T00:00:00.000Z";
const fixture = (prefix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const waits = yield* makeAwaitRepository;
    const admission = yield* makeAwaitedDispatchAdmission;
    const caller = ThreadId.makeUnsafe(`${prefix}:caller`);
    const target = ThreadId.makeUnsafe(`${prefix}:target`);
    const turn = `${caller}:turn`;
    const dispatchId = `${prefix}:dispatch`;
    const messageId = MessageId.makeUnsafe(`${prefix}:message`);
    const command: typeof ThreadTurnStartCommand.Type = {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(`${prefix}:send`),
      awaitedDispatchId: dispatchId,
      threadId: target,
      message: { messageId, role: "user", text: "authorized work", attachments: [] },
      dispatchMode: "queue",
      dispatchOrigin: "agent",
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: now,
    };
    for (const id of [caller, target]) {
      yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        env_mode, created_at, updated_at)
      VALUES (${id}, 'project', ${id}, ${JSON.stringify({ provider: "codex", model: "test" })},
        'approval-required', 'default', 'local', ${now}, ${now})`;
    }
    yield* sql`INSERT INTO projection_turns
    (thread_id, turn_id, state, requested_at, started_at, checkpoint_files_json)
    VALUES (${caller}, ${turn}, 'running', ${now}, ${now}, '[]')`;
    const pins = [{ threadId: target, runId: null, messageId }];
    const wait = yield* waits.registerPinned({
      callerThreadId: caller,
      callerTurnId: turn,
      pins,
      registeredSequence: 0,
      createdAt: now,
    });
    yield* sql`INSERT INTO agent_gateway_awaited_dispatches
    (dispatch_id, kind, caller_thread_id, caller_turn_id, request_id, wait_id,
      fingerprint, command_id, command_json, pins_json, created_at)
    VALUES (${dispatchId}, 'send', ${caller}, ${turn}, ${prefix}, ${wait.waitId}, 'test',
      ${command.commandId}, ${JSON.stringify(command)}, ${JSON.stringify(pins)}, ${now})`;
    return { sql, waits, admission, caller, target, turn, wait, command };
  });

it.layer(SqlitePersistenceMemory)("awaited dispatch admission", (it) => {
  it.effect("accepts exact authorized reservations and does not change ordinary commands", () =>
    Effect.gen(function* () {
      const h = yield* fixture("admit");
      yield* h.admission.check(h.command);
      yield* h.sql`UPDATE projection_turns SET state = 'completed' WHERE thread_id = ${h.caller}`;
      yield* h.admission.check(h.command);
      const { awaitedDispatchId: _id, ...ordinary } = h.command;
      yield* h.waits.settle(h.wait.waitId, "cancelled", now);
      yield* h.admission.check(ordinary);
    }),
  );

  it.effect("rejects changed message, command identity, target, timestamp and runtime", () =>
    Effect.gen(function* () {
      const h = yield* fixture("identity");
      for (const changed of [
        { ...h.command, commandId: CommandId.makeUnsafe("forged-command") },
        { ...h.command, threadId: h.caller },
        {
          ...h.command,
          message: { ...h.command.message, messageId: MessageId.makeUnsafe("forged-message") },
        },
        { ...h.command, message: { ...h.command.message, text: "different task" } },
        { ...h.command, createdAt: "2026-10-01T00:00:01.000Z" },
        { ...h.command, runtimeMode: "full-access" as const },
      ]) {
        const failure = yield* h.admission.check(changed).pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }
    }),
  );

  for (const change of [
    "wait-cancel",
    "source-error",
    "target-runtime",
    "target-interaction",
    "caller-worktree",
    "target-subagent",
    "target-deleted",
  ] as const) {
    it.effect(`rechecks ${change} after preflight and before committing a queued dispatch`, () =>
      Effect.gen(function* () {
        const h = yield* fixture(`interleave-${change}`);
        // The live tool may have completed this preflight before the command
        // reaches the serialized worker. A queued mutation wins before commit.
        yield* h.admission.check(h.command);
        if (change === "wait-cancel") yield* h.waits.settle(h.wait.waitId, "cancelled", now);
        if (change === "source-error")
          yield* h.sql`UPDATE projection_turns SET state = 'error' WHERE thread_id = ${h.caller}`;
        if (change === "target-runtime")
          yield* h.sql`UPDATE projection_threads SET runtime_mode = 'full-access' WHERE thread_id = ${h.target}`;
        if (change === "target-interaction")
          yield* h.sql`UPDATE projection_threads SET interaction_mode = 'plan' WHERE thread_id = ${h.target}`;
        if (change === "caller-worktree")
          yield* h.sql`UPDATE projection_threads SET env_mode = 'worktree' WHERE thread_id = ${h.caller}`;
        if (change === "target-subagent")
          yield* h.sql`UPDATE projection_threads SET parent_thread_id = ${h.caller} WHERE thread_id = ${h.target}`;
        if (change === "target-deleted")
          yield* h.sql`UPDATE projection_threads SET deleted_at = ${now} WHERE thread_id = ${h.target}`;
        const failure = yield* h.sql
          .withTransaction(
            Effect.gen(function* () {
              yield* h.admission.check(h.command);
              yield* h.sql`INSERT INTO orchestration_command_receipts
          (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)
          VALUES (${h.command.commandId}, 'thread', ${h.target}, ${now}, 1, 'accepted', NULL)`;
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
        expect(
          yield* h.sql`SELECT command_id FROM orchestration_command_receipts WHERE command_id = ${h.command.commandId}`,
        ).toEqual([]);
      }),
    );
  }

  it.effect("rejects removal of the exact target even when the reservation still exists", () =>
    Effect.gen(function* () {
      const h = yield* fixture("removed-target");
      yield* h.admission.check(h.command);
      yield* h.sql`UPDATE agent_gateway_waits SET targets_json = '[]' WHERE wait_id = ${h.wait.waitId}`;
      const failure = yield* h.admission.check(h.command).pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );
});
