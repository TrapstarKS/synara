import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@synara/contracts";

import type { ServerConfigShape } from "../config.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import { AgentGatewayOperationRepositoryLive } from "./Layers/AgentGatewayOperationRepository.ts";
import { AgentGatewayOperationRepository } from "./Services/AgentGatewayOperationRepository.ts";
import { makeAwaitRepository } from "./awaitRepository.ts";
import { makeAwaitedDispatch } from "./awaitedDispatch.ts";
import { makeCreateThreadsHandler } from "./creationCoordinator.ts";
import { ToolInputError } from "./toolInput.ts";
import { recoverInterruptedAgentGatewayOperations } from "./startupRecovery.ts";
import { makeAgentCreationIds } from "./creationUtils.ts";

const now = "2026-10-01T00:00:00.000Z";
const persistence = AgentGatewayOperationRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const harness = (prefix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const operations = yield* AgentGatewayOperationRepository;
    const waits = yield* makeAwaitRepository;
    const callerId = ThreadId.makeUnsafe(`${prefix}:caller`);
    const targetId = ThreadId.makeUnsafe(`${prefix}:target`);
    const projectId = ProjectId.makeUnsafe(`${prefix}:project`);
    const scope = {
      callerThreadId: callerId,
      callerTurnId: `${callerId}:turn`,
      registeredSequence: 0,
      createdAt: now,
    };
    const shell = (id: ThreadId): OrchestrationThreadShell =>
      ({
        id,
        projectId,
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "local",
        modelSelection: { provider: "codex", model: "test-model" },
        archivedAt: null,
        parentThreadId: null,
        sidechatSourceThreadId: null,
        latestTurn: {
          turnId: TurnId.makeUnsafe(`${id}:old-run`),
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          assistantMessageId: null,
        },
      }) as unknown as OrchestrationThreadShell;
    const shells = new Map<string, OrchestrationThreadShell>([
      [callerId, shell(callerId)],
      [targetId, shell(targetId)],
    ]);
    yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${callerId}, ${projectId}, 'caller', ${JSON.stringify(shell(callerId).modelSelection)}, 'approval-required', 'default', ${now}, ${now})`;
    yield* sql`INSERT INTO projection_turns
    (thread_id, turn_id, state, requested_at, started_at, checkpoint_files_json)
    VALUES (${callerId}, ${scope.callerTurnId}, 'running', ${now}, ${now}, '[]')`;
    const snapshotQuery = {
      getThreadShellById: (id: ThreadId) => Effect.sync(() => Option.fromNullishOr(shells.get(id))),
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({ id: projectId, workspaceRoot: "/tmp/awaited-tests", scripts: [] }),
        ),
    } as unknown as ProjectionSnapshotQueryShape;
    let behavior: "normal" | "offline" | "lost-ack" = "normal";
    let failCommit = false;
    const calls: OrchestrationCommand[] = [];
    const accepted: OrchestrationCommand[] = [];
    const creationLinks: Array<{ state: string; targetsJson: string }> = [];
    const orchestrationEngine = {
      getEventHighWaterSequence: Effect.succeed(0),
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          calls.push(command);
          if (command.type === "thread.create") {
            const link = (yield* sql<{ state: string; targetsJson: string }>`
          SELECT dispatch.state, wait.targets_json AS "targetsJson"
          FROM agent_gateway_awaited_dispatches AS dispatch
          JOIN agent_gateway_waits AS wait ON wait.wait_id = dispatch.wait_id
          WHERE dispatch.dispatch_id = ${command.gatewayOperationId ?? ""}`)[0];
            if (link) creationLinks.push(link);
            shells.set(command.threadId, {
              ...shell(command.threadId),
              creationSource: "synara_mcp",
              gatewayOperationId: command.gatewayOperationId,
            } as OrchestrationThreadShell);
          }
          if (command.type === "thread.delete") shells.delete(command.threadId);
          if (command.type !== "thread.turn.start") return { sequence: calls.length };
          if (behavior === "offline")
            return yield* Effect.fail(new Error("injected transport unavailable"));
          const inserted = yield* sql`INSERT OR IGNORE INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)
        VALUES (${command.commandId}, 'thread', ${command.threadId}, ${command.createdAt}, 1, 'accepted', NULL)
        RETURNING command_id`;
          if (inserted.length) accepted.push(command);
          if (behavior === "lost-ack") return yield* Effect.fail(new Error("lost acknowledgement"));
          return { sequence: calls.length };
        }),
    } as unknown as OrchestrationEngineShape;
    const dependencies = { snapshotQuery, orchestrationEngine };
    const service = yield* makeAwaitedDispatch(dependencies);
    const git = {} as GitCoreShape;
    const creator = yield* makeCreateThreadsHandler({
      ...dependencies,
      git,
      providerDiscovery: {
        listModels: () =>
          Effect.succeed({ models: [{ slug: "test-model", name: "Test" }], source: "test" }),
      } as unknown as ProviderDiscoveryServiceShape,
      operationRepository: {
        ...operations,
        complete: (input) =>
          operations
            .complete(input)
            .pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  failCommit ? Effect.fail(new Error("injected commit failure")) : Effect.void,
                ),
              ),
            ),
      },
      awaitedDispatch: service,
      serverConfig: { worktreesDir: "/tmp/awaited-tests/worktrees" } as ServerConfigShape,
      loadProviderAvailabilities: Effect.succeed(new Map()),
      requireThreadShell: (id) =>
        Effect.suspend(() => {
          const value = shells.get(id);
          return value ? Effect.succeed(value) : Effect.fail(new ToolInputError("missing shell"));
        }),
    });
    const context = {
      kind: "provider-session" as const,
      callerThreadId: callerId,
      callerTurnId: scope.callerTurnId,
      assertAuthority: () => Effect.void,
      prepareWait: () => Effect.succeed(scope),
    };
    const send = (requestId: string, message = "new delegated work") =>
      service.send({
        requestId,
        scope,
        target: shells.get(targetId)!,
        message,
        assertAuthority: () => Effect.void,
      });
    const spec = {
      prompt: "do delegated work",
      target: { provider: "codex" as const, model: "test-model" },
    };
    return {
      sql,
      operations,
      waits,
      service,
      dependencies,
      creator,
      context,
      scope,
      send,
      spec,
      git,
      calls,
      accepted,
      creationLinks,
      callerId,
      targetId,
      shells,
      setBehavior: (value: typeof behavior) => {
        behavior = value;
      },
      setCommitFailure: () => {
        failCommit = true;
      },
    };
  });

it.layer(persistence)("awaited dispatch reservation and repair", (it) => {
  it.effect("pins the new message and replays a lost acknowledgement without sending again", () =>
    Effect.gen(function* () {
      const h = yield* harness("lost-ack");
      h.setBehavior("lost-ack");
      const first = yield* h.send("same");
      const second = yield* h.send("same");
      expect(second).toEqual(first);
      expect(h.accepted).toHaveLength(1);
      expect(h.calls.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
      const wait = (yield* h.waits.getById(first.waitId))!;
      expect(JSON.parse(wait.targetsJson)).toEqual([
        { pin: { threadId: h.targetId, runId: null, messageId: first.messageId }, result: null },
      ]);
      expect(first.messageId).not.toBe(`${h.targetId}:old-run`);
      expect(
        (yield* h.sql<{
          commandJson: string | null;
        }>`SELECT command_json AS "commandJson" FROM agent_gateway_awaited_dispatches WHERE wait_id = ${first.waitId}`)[0]
          ?.commandJson,
      ).toBeNull();
      const conflict = yield* h.send("same", "different work").pipe(Effect.flip);
      expect(conflict).toMatchObject({ code: "idempotency_conflict" });
    }),
  );

  it.effect(
    "repairs a reserved send with its original command and timestamp after service restart",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("restart-send");
        h.setBehavior("offline");
        yield* h.send("retry").pipe(Effect.flip);
        const before = (yield* h.waits.getByScope(h.scope.callerThreadId, h.scope.callerTurnId))!;
        expect((yield* h.waits.pending()).some((row) => row.waitId === before.waitId)).toBe(false);
        expect(
          (yield* h.waits.prepareDispatch(before.waitId, before.targetsJson, "premature"))?.state,
        ).toBe("waiting");
        const firstCommand = h.calls[0];
        h.setBehavior("normal");
        const restarted = yield* makeAwaitedDispatch(h.dependencies);
        yield* restarted.repairPending();
        expect(h.accepted).toHaveLength(1);
        expect(h.accepted[0]).toEqual(firstCommand);
        expect((yield* h.waits.pending()).some((row) => row.waitId === before.waitId)).toBe(true);
        yield* restarted.repairPending();
        expect(h.accepted).toHaveLength(1);
      }),
  );

  for (const change of ["cancelled", "permissions"] as const) {
    it.effect(`does not dispatch reserved work after ${change} changed`, () =>
      Effect.gen(function* () {
        const h = yield* harness(`revoke-${change}`);
        h.setBehavior("offline");
        yield* h.send("retry").pipe(Effect.flip);
        const wait = (yield* h.waits.getByScope(h.scope.callerThreadId, h.scope.callerTurnId))!;
        if (change === "cancelled") yield* h.waits.settle(wait.waitId, "cancelled", now);
        else h.shells.set(h.targetId, { ...h.shells.get(h.targetId)!, runtimeMode: "full-access" });
        h.setBehavior("normal");
        yield* h.service.repairPending();
        expect(h.accepted).toHaveLength(0);
        const row = (yield* h.sql<{
          state: string;
          commandJson: string | null;
        }>`SELECT state, command_json AS "commandJson" FROM agent_gateway_awaited_dispatches WHERE wait_id = ${wait.waitId}`)[0];
        expect(row).toEqual({ state: "failed", commandJson: null });
      }),
    );
  }

  it.effect("rejects live retries when the saved target runtime or interaction mode changed", () =>
    Effect.gen(function* () {
      const h = yield* harness("live-retry-modes");
      h.setBehavior("offline");
      yield* h.send("retry").pipe(Effect.flip);
      h.shells.set(h.targetId, { ...h.shells.get(h.targetId)!, interactionMode: "plan" });
      h.setBehavior("normal");
      const rejected = yield* h.send("retry").pipe(Effect.flip);
      expect(rejected).toMatchObject({ code: "capability_denied" });
      expect(h.accepted).toHaveLength(0);
    }),
  );

  it.effect("rejects awaited native subagents before reserving a wait or dispatching", () =>
    Effect.gen(function* () {
      const h = yield* harness("native-subagent");
      h.shells.set(h.targetId, { ...h.shells.get(h.targetId)!, parentThreadId: h.callerId });
      const rejected = yield* h.send("child").pipe(Effect.flip);
      expect(rejected).toMatchObject({ code: "operation_failed" });
      expect(h.calls).toHaveLength(0);
      expect(yield* h.waits.getByScope(h.callerId, h.scope.callerTurnId)).toBeNull();
    }),
  );

  it.effect("binds selected creation pins before first dispatch and combines them with sends", () =>
    Effect.gen(function* () {
      const h = yield* harness("creation-link");
      const created = yield* h.creator(
        {
          requestId: "create",
          awaitResult: true,
          threads: [h.spec, { ...h.spec, awaitResult: false }],
        },
        h.context,
      );
      expect(created.isError).not.toBe(true);
      const content = created.content[0];
      const result = JSON.parse(content?.type === "text" ? content.text : "{}");
      expect(result.awaitedThreadIds).toEqual([result.threads[0].threadId]);
      expect(result.threads[1].waitId).toBeUndefined();
      expect(h.creationLinks).toHaveLength(2);
      for (const link of h.creationLinks) {
        expect(link.state).toBe("reserved");
        expect(JSON.parse(link.targetsJson)).toEqual([
          {
            pin: {
              threadId: result.threads[0].threadId,
              runId: null,
              messageId: result.threads[0].messageId,
            },
            result: null,
          },
        ]);
      }
      const sent = yield* h.send("send");
      expect(sent.waitId).toBe(result.waitId);
      const wait = (yield* h.waits.getById(result.waitId))!;
      expect(JSON.parse(wait.targetsJson)).toHaveLength(2);
      expect((yield* h.waits.pending()).filter((row) => row.waitId === result.waitId)).toHaveLength(
        1,
      );
      const replay = yield* h.creator(
        {
          requestId: "create",
          awaitResult: true,
          threads: [h.spec, { ...h.spec, awaitResult: false }],
        },
        h.context,
      );
      expect(replay).toEqual(created);
      expect(h.calls.filter((command) => command.type === "thread.create")).toHaveLength(2);
    }),
  );

  it.effect(
    "rolls back the real operation reservation when the combined wait limit rejects it",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("creation-bound");
        const initial = yield* h.waits.registerPinned({
          ...h.scope,
          pins: Array.from({ length: 20 }, (_, index) => ({
            threadId: `already-${index}`,
            runId: null,
            messageId: `already-message-${index}`,
          })),
        });
        const created = yield* h.creator(
          { requestId: "create", awaitResult: true, threads: [h.spec] },
          h.context,
        );
        expect(created.isError).toBe(true);
        expect(h.calls).toHaveLength(0);
        expect(
          yield* h.operations.getByScope({
            callerThreadId: h.callerId,
            callerTurnId: h.scope.callerTurnId,
            operationKind: "create_threads",
          }),
        ).toBeNull();
        expect(yield* h.waits.getById(initial.waitId)).toEqual(initial);
      }),
  );

  it.effect(
    "rolls back commit activation and exposes failed creation only after compensation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("creation-commit");
        h.setCommitFailure();
        const created = yield* h.creator(
          { requestId: "create", awaitResult: true, threads: [h.spec] },
          h.context,
        );
        expect(created.isError).toBe(true);
        expect(h.calls.filter((command) => command.type === "thread.delete")).toHaveLength(1);
        const operation = (yield* h.operations.getByScope({
          callerThreadId: h.callerId,
          callerTurnId: h.scope.callerTurnId,
          operationKind: "create_threads",
        }))!;
        expect(operation.status).toBe("failed");
        const wait = (yield* h.waits.getByScope(h.callerId, h.scope.callerTurnId))!;
        expect((yield* h.waits.pending()).some((row) => row.waitId === wait.waitId)).toBe(false);
        yield* h.service.repairPending();
        const repaired = (yield* h.waits.getById(wait.waitId))!;
        expect(JSON.parse(repaired.targetsJson)[0].result.state).toBe("error");
        expect((yield* h.waits.pending()).some((row) => row.waitId === wait.waitId)).toBe(true);
      }),
  );

  it.effect("repairs the wait after startup compensates an interrupted creation reservation", () =>
    Effect.gen(function* () {
      const h = yield* harness("creation-restart");
      const operationId = "interrupted-operation";
      const ids = makeAgentCreationIds(operationId, 0);
      yield* h.service.transaction(
        Effect.gen(function* () {
          yield* h.operations.reserve({
            operationId,
            callerThreadId: h.callerId,
            callerTurnId: h.scope.callerTurnId,
            operationKind: "create_threads",
            requestId: "create",
            fingerprint: "fingerprint",
            requestedCount: 1,
            planJson: JSON.stringify([
              {
                ids,
                workspaceRoot: "/tmp/awaited-tests",
                environment: "local",
                newBranch: null,
                plannedWorktreePath: null,
                ownershipPreflightPassed: true,
              },
            ]),
            now,
          });
          yield* h.service.reserveCreation({
            operationId,
            requestId: "create",
            scope: h.scope,
            pins: [{ threadId: ids.threadId, runId: null, messageId: ids.messageId }],
          });
        }),
      );
      yield* recoverInterruptedAgentGatewayOperations({
        ...h.dependencies,
        operationRepository: h.operations,
        git: h.git,
      });
      expect((yield* h.operations.getById(operationId))?.status).toBe("failed");
      const restarted = yield* makeAwaitedDispatch(h.dependencies);
      yield* restarted.repairPending();
      const wait = (yield* h.waits.getByScope(h.callerId, h.scope.callerTurnId))!;
      expect(JSON.parse(wait.targetsJson)[0].result.state).toBe("error");
      expect(h.accepted).toHaveLength(0);
    }),
  );

  it.effect("rejects external awaited creation before reserving or dispatching anything", () =>
    Effect.gen(function* () {
      const h = yield* harness("external");
      const response = yield* h.creator(
        { requestId: "external", awaitResult: true, threads: [h.spec] },
        {
          kind: "external-client",
          integrationId: "external",
          allowedProjectIds: new Set(),
          capabilities: new Set(),
          assertAuthority: () => Effect.void,
        },
      );
      expect(response.isError).toBe(true);
      expect(h.calls).toHaveLength(0);
      expect(yield* h.waits.getByScope(h.callerId, h.scope.callerTurnId)).toBeNull();
    }),
  );
});
