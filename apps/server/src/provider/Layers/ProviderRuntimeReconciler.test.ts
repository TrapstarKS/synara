import {
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type ProviderSession,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { createEmptyReadModel } from "../../orchestration/projector.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../../orchestration/Services/OrchestrationReactor.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeEventRepository,
  type ProviderRuntimeEventRepositoryShape,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ProviderRuntimeReconciler } from "../Services/ProviderRuntimeReconciler.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import { makeProviderRuntimeReconcilerLive } from "./ProviderRuntimeReconciler.ts";

const THREAD_ID = ThreadId.makeUnsafe("subagent:parent-runtime:native-child");
const TURN_ID = TurnId.makeUnsafe("turn-runtime-reconciler");

function staleShellSnapshot(): OrchestrationShellSnapshot {
  const updatedAt = "2026-07-23T19:00:00.000Z";
  return {
    snapshotSequence: 1,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-runtime-reconciler"),
        runtimeMode: "full-access",
        updatedAt,
        latestTurn: {
          turnId: TURN_ID,
          state: "running",
          requestedAt: updatedAt,
          startedAt: updatedAt,
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt,
        },
      },
    ],
    updatedAt,
  } as unknown as OrchestrationShellSnapshot;
}

function readyProviderSession(): ProviderSession {
  return {
    provider: "codex",
    status: "ready",
    runtimeMode: "full-access",
    threadId: THREAD_ID,
    createdAt: "2026-07-23T19:00:00.000Z",
    updatedAt: "2026-07-23T20:00:00.000Z",
  };
}

async function reconcileActiveGoal(input?: {
  readonly beforeRepair?: (thread: OrchestrationThread) => OrchestrationThread;
  readonly afterBindingCleanup?: (thread: OrchestrationThread) => OrchestrationThread;
  readonly runtimeAfterCleanup?: ProviderSession["status"];
  readonly bindingCleared?: boolean;
  readonly observations?: number;
}) {
  const threadId = ThreadId.makeUnsafe("thread-runtime-goal-recovery");
  const source = staleShellSnapshot().threads[0]!;
  const initial: OrchestrationThread = {
    ...source,
    id: threadId,
    title: "Runtime goal recovery",
    modelSelection: { provider: "opencode", model: "test-model" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    createdAt: source.updatedAt,
    archivedAt: null,
    deletedAt: null,
    handoff: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    goal: "Finish every requirement",
    goalStartedAt: source.updatedAt,
    goalPausedAt: null,
    goalBlockCount: 7,
    goalBlockLastTurnId: TURN_ID,
    session: {
      ...source.session!,
      threadId,
      providerName: "opencode",
      providerInstanceId: "opencode",
      status: "running",
      activeTurnId: TURN_ID,
    },
  };
  let current = input?.beforeRepair?.(initial) ?? initial;
  const staleProjection = current;
  let liveSession: ProviderSession = {
    ...readyProviderSession(),
    provider: "opencode",
    threadId,
  };
  const commands: OrchestrationCommand[] = [];
  const engine = {
    getReadModel: () =>
      Effect.succeed({
        ...createEmptyReadModel(current.updatedAt),
        threads: [current],
      } satisfies OrchestrationReadModel),
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        if (command.type === "thread.session.set") {
          current = {
            ...current,
            session: command.session,
            latestTurn: current.latestTurn
              ? {
                  ...current.latestTurn,
                  state: command.session.status === "error" ? "error" : "interrupted",
                  completedAt: current.latestTurn.completedAt ?? command.session.updatedAt,
                }
              : null,
          };
        }
        return { sequence: commands.length };
      }),
  } as unknown as OrchestrationEngineShape;
  const layer = makeProviderRuntimeReconcilerLive({ staleAfterMs: 1 }).pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(
      Layer.succeed(OrchestrationReactor, {
        start: Effect.void,
        reconcileSettledOpenTurns: Effect.void,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        listStaleInFlightThreadIds: () => Effect.succeed([threadId]),
        getThreadShellsByIds: () => Effect.succeed([staleProjection]),
      } as unknown as ProjectionSnapshotQueryShape),
    ),
    Layer.provide(
      Layer.succeed(ProviderSessionDirectory, {
        listBindings: () =>
          Effect.succeed([
            {
              threadId,
              provider: "opencode",
              providerInstanceId: "opencode",
              status: "running",
              lifecycleGeneration: "goal-recovery-generation",
              runtimePayload: { activeTurnId: TURN_ID },
            },
          ]),
        clearActiveTurn: () =>
          Effect.sync(() => {
            current = input?.afterBindingCleanup?.(current) ?? current;
            if (input?.runtimeAfterCleanup) {
              liveSession = {
                ...liveSession,
                status: input.runtimeAfterCleanup,
                ...(input.runtimeAfterCleanup === "running" ? { activeTurnId: TURN_ID } : {}),
              };
            }
            return input?.bindingCleared ?? true;
          }),
      } as unknown as ProviderSessionDirectoryShape),
    ),
    Layer.provide(
      Layer.succeed(ProviderService, {
        listSessions: () => Effect.succeed([liveSession]),
        getRuntimeEventPumpHealth: () => Effect.succeed([]),
      } as unknown as ProviderServiceShape),
    ),
    Layer.provide(
      Layer.succeed(ProviderRuntimeEventRepository, {
        listThreadIdsWithPendingEvents: () => Effect.succeed([]),
      } as unknown as ProviderRuntimeEventRepositoryShape),
    ),
  );
  await Effect.gen(function* () {
    const reconciler = yield* ProviderRuntimeReconciler;
    for (let index = 0; index < (input?.observations ?? 1); index += 1) {
      yield* reconciler.reconcileNow;
    }
  }).pipe(Effect.provide(layer), Effect.runPromise);
  return {
    current,
    continuations: commands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.goal.continue" }> =>
        command.type === "thread.goal.continue",
    ),
  };
}

describe("ProviderRuntimeReconcilerLive", () => {
  it("continues the active goal after its orphaned running turn is reconciled", async () => {
    const result = await reconcileActiveGoal();
    expect(result.continuations).toHaveLength(1);
    expect(result.continuations[0]).toMatchObject({
      threadId: "thread-runtime-goal-recovery",
      trigger: "runtime-recovery",
      sourceTurnId: TURN_ID,
      goalStartedAt: "2026-07-23T19:00:00.000Z",
      createdAt: result.current.latestTurn?.completedAt,
    });
    expect(result.current.goalPausedAt).toBeNull();
    expect(result.current.goalBlockCount).toBe(7);
    expect(result.current.goalBlockLastTurnId).toBe(TURN_ID);
  });

  it("uses the same recovery command and timestamp if projection lag repeats the repair", async () => {
    const result = await reconcileActiveGoal({ observations: 2 });
    expect(result.continuations).toHaveLength(2);
    expect(result.continuations[1]).toEqual(result.continuations[0]);
  });

  it("continues runtime recovery when the settled session becomes ready before enqueue", async () => {
    const result = await reconcileActiveGoal({
      afterBindingCleanup: (thread) => ({
        ...thread,
        session: {
          ...thread.session!,
          status: "ready",
          updatedAt: new Date(Date.parse(thread.session!.updatedAt) + 1).toISOString(),
        },
      }),
    });
    expect(result.current.session?.status).toBe("ready");
    expect(result.continuations).toHaveLength(1);
    expect(result.continuations[0]).toMatchObject({
      sourceTurnId: TURN_ID,
      goalStartedAt: result.current.goalStartedAt,
    });
  });

  it.each([
    ["pause", (thread) => ({ ...thread, goalPausedAt: "2026-07-23T20:00:00.000Z" })],
    ["clear", (thread) => ({ ...thread, goal: undefined })],
    ["new goal", (thread) => ({ ...thread, goalStartedAt: "2026-07-23T20:00:00.000Z" })],
    ["archive", (thread) => ({ ...thread, archivedAt: "2026-07-23T20:00:00.000Z" })],
    ["delete", (thread) => ({ ...thread, deletedAt: "2026-07-23T20:00:00.000Z" })],
    ["Plan mode", (thread) => ({ ...thread, interactionMode: "plan" })],
    ["child thread", (thread) => ({ ...thread, parentThreadId: ThreadId.makeUnsafe("parent") })],
    [
      "session stop",
      (thread) => ({ ...thread, session: { ...thread.session!, status: "stopped" } }),
    ],
    [
      "provider error",
      (thread) => ({ ...thread, session: { ...thread.session!, status: "error" } }),
    ],
    [
      "newer turn",
      (thread) => ({
        ...thread,
        latestTurn: { ...thread.latestTurn!, turnId: TurnId.makeUnsafe("newer-turn") },
      }),
    ],
  ] satisfies ReadonlyArray<
    readonly [string, (thread: OrchestrationThread) => OrchestrationThread]
  >)(
    "does not recover after a racing %s during binding cleanup",
    async (_, afterBindingCleanup) => {
      const result = await reconcileActiveGoal({ afterBindingCleanup });
      expect(result.continuations).toEqual([]);
    },
  );

  it.each(["running", "connecting", "error"] as const)(
    "does not recover when the runtime becomes %s before continuation",
    async (runtimeAfterCleanup) => {
      const result = await reconcileActiveGoal({ runtimeAfterCleanup });
      expect(result.continuations).toEqual([]);
    },
  );

  it("does not recover a goal without a concrete started source turn", async () => {
    const result = await reconcileActiveGoal({
      beforeRepair: (thread) => ({
        ...thread,
        latestTurn: null,
        session: { ...thread.session!, activeTurnId: null },
      }),
    });
    expect(result.continuations).toEqual([]);
  });

  it("does not recover after the binding ownership check rejects stale cleanup", async () => {
    const result = await reconcileActiveGoal({ bindingCleared: false });
    expect(result.continuations).toEqual([]);
  });

  it("does not recover a terminal projection left by an explicit stop", async () => {
    const result = await reconcileActiveGoal({
      beforeRepair: (thread) => ({
        ...thread,
        session: { ...thread.session!, status: "stopped", activeTurnId: null },
      }),
    });
    expect(result.continuations).toEqual([]);
  });

  it("keeps one activity identity while a stale-turn repair is retried and refined", async () => {
    const commands: OrchestrationCommand[] = [];
    const reconcileSettledOpenTurns = vi.fn();
    let bindingStatus: "stopped" | "error" = "stopped";
    let providerSession = readyProviderSession();
    let projectedThread = staleShellSnapshot().threads[0]!;
    const hasLiveRuntimeTasks = vi.fn(() => Effect.succeed(true));

    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineShape;
    const reactor = {
      start: Effect.void,
      reconcileSettledOpenTurns: Effect.sync(reconcileSettledOpenTurns),
    } satisfies OrchestrationReactorShape;
    const snapshotQuery = {
      listStaleInFlightThreadIds: () => Effect.succeed([THREAD_ID]),
      getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
      getThreadShellById: () => Effect.succeed(Option.some(projectedThread)),
      getThreadShellsByIds: () => Effect.succeed([projectedThread]),
      getShellSnapshot: () => Effect.die("full shell snapshot should not be loaded"),
    } as unknown as ProjectionSnapshotQueryShape;
    const directory = {
      listBindings: () =>
        Effect.succeed([
          {
            threadId: THREAD_ID,
            provider: "codex" as const,
            providerInstanceId: "codex" as const,
            status: bindingStatus,
            runtimePayload: { activeTurnId: null },
          },
        ]),
    } as unknown as ProviderSessionDirectoryShape;
    const provider = {
      hasLiveRuntimeTasks,
      listSessions: () => Effect.succeed([providerSession]),
      getRuntimeEventPumpHealth: () =>
        Effect.succeed([
          {
            provider: "codex" as const,
            status: "healthy" as const,
            consecutiveFailures: 0,
            updatedAt: "2026-07-23T20:00:00.000Z",
          },
        ]),
    } as unknown as ProviderServiceShape;

    const runtimeEvents = {
      listThreadIdsWithPendingEvents: (input: { readonly threadIds: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          expect(input.threadIds).toEqual([THREAD_ID]);
          return [];
        }),
    } as unknown as ProviderRuntimeEventRepositoryShape;

    const layer = makeProviderRuntimeReconcilerLive({ staleAfterMs: 1 }).pipe(
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(OrchestrationReactor, reactor)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
      Layer.provide(Layer.succeed(ProviderService, provider)),
      Layer.provide(Layer.succeed(ProviderRuntimeEventRepository, runtimeEvents)),
    );

    await Effect.gen(function* () {
      const reconciler = yield* ProviderRuntimeReconciler;
      projectedThread = {
        ...projectedThread,
        parentThreadId: ThreadId.makeUnsafe("parent-runtime"),
        subagentAgentId: null,
      };
      yield* reconciler.reconcileNow;
      expect(commands).toEqual([]);
      expect(hasLiveRuntimeTasks).toHaveBeenCalledWith({
        threadId: "parent-runtime",
        providerThreadId: "native-child",
        turnId: TURN_ID,
      });
      // Once the native runtime no longer owns the child, ordinary recovery applies.
      hasLiveRuntimeTasks.mockImplementation(() => Effect.succeed(false));
      yield* reconciler.reconcileNow;
      // The projection can remain stale for another observation cycle.
      yield* reconciler.reconcileNow;
      bindingStatus = "error";
      providerSession = {
        ...providerSession,
        status: "error",
        activeTurnId: TURN_ID,
        lastError: "Provider stream failed.",
      };
      yield* reconciler.reconcileNow;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    // Session repair dispatches first so a partial failure still unsticks the
    // thread, and `updatedAt` is the dispatch time rather than the terminal
    // session's original timestamp (which would freeze the staleness clock).
    expect(commands.map((command) => command.type)).toEqual([
      "thread.session.set",
      "thread.activity.append",
      "thread.session.set",
      "thread.activity.append",
      "thread.session.set",
      "thread.activity.append",
    ]);
    const activityCommand = commands[1];
    expect(activityCommand?.type).toBe("thread.activity.append");
    if (activityCommand?.type === "thread.activity.append") {
      expect(activityCommand.activity.kind).toBe("provider.runtime.reconciled");
      expect(activityCommand.activity.summary).toContain("recovered");
      expect(activityCommand.activity.payload).toMatchObject({
        action: "settle-terminal-projection",
      });
    }
    const sessionCommand = commands[0];
    expect(sessionCommand?.type).toBe("thread.session.set");
    if (sessionCommand?.type === "thread.session.set") {
      expect(sessionCommand.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: null,
      });
      expect(sessionCommand.session.updatedAt).not.toBe("2026-07-23T19:00:00.000Z");
    }
    const errorActivityCommand = commands[5];
    expect(errorActivityCommand?.type).toBe("thread.activity.append");
    if (errorActivityCommand?.type === "thread.activity.append") {
      expect(errorActivityCommand.activity.payload).toMatchObject({
        action: "settle-error",
      });
    }
    const errorSessionCommand = commands[4];
    expect(errorSessionCommand?.type).toBe("thread.session.set");
    if (errorSessionCommand?.type === "thread.session.set") {
      expect(errorSessionCommand.session).toMatchObject({
        status: "error",
        activeTurnId: TURN_ID,
        lastError: "Provider stream failed.",
      });
    }
    const activityCommands = commands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
        command.type === "thread.activity.append",
    );
    const sessionCommands = commands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.session.set" }> =>
        command.type === "thread.session.set",
    );
    expect(activityCommands[0]?.activity.id).toBe(activityCommands[1]?.activity.id);
    expect(activityCommands[0]?.activity.id).toBe(activityCommands[2]?.activity.id);
    expect(activityCommands[0]?.commandId).not.toBe(activityCommands[1]?.commandId);
    expect(activityCommands[1]?.commandId).not.toBe(activityCommands[2]?.commandId);
    expect(sessionCommands[0]?.commandId).not.toBe(sessionCommands[1]?.commandId);
    expect(sessionCommands[1]?.commandId).not.toBe(sessionCommands[2]?.commandId);
    expect(reconcileSettledOpenTurns).toHaveBeenCalledTimes(3);
  });
});
