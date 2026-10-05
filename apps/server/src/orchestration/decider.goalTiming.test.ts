// FILE: decider.goalTiming.test.ts
// Purpose: Covers goal pursuit timing: the decider stamps goalStartedAt when a
//          goal first becomes active, freezes/rebases it across pause/resume,
//          and clears both timestamps when the goal is cleared.

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  THREAD_GOAL_BLOCK_ATTEMPT_LIMIT,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

async function createThreadReadModel(now: string) {
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: EventId.makeUnsafe("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: EventId.makeUnsafe("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-thread-create"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-thread-create"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        envMode: "local",
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        handoff: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

function withRunningTurn(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
  turnId: TurnId,
): OrchestrationReadModel {
  return {
    ...readModel,
    threads: readModel.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            latestTurn: {
              turnId,
              state: "running" as const,
              requestedAt: readModel.updatedAt,
              startedAt: readModel.updatedAt,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId,
              status: "running" as const,
              providerName: "codex" as const,
              runtimeMode: thread.runtimeMode,
              activeTurnId: turnId,
              lastError: null,
              updatedAt: readModel.updatedAt,
            },
          }
        : thread,
    ),
  };
}

async function decideGoalUpdate(
  readModel: OrchestrationReadModel,
  input: {
    commandId: string;
    goal?: string;
    goalPaused?: boolean;
    goalAchieved?: boolean;
    goalBlockAttempt?: boolean;
    goalBlockTurnId?: string;
    goalBlockReset?: boolean;
  },
) {
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      command: {
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(input.commandId),
        threadId: THREAD_ID,
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.goalPaused !== undefined ? { goalPaused: input.goalPaused } : {}),
        ...(input.goalAchieved !== undefined ? { goalAchieved: input.goalAchieved } : {}),
        ...(input.goalBlockAttempt !== undefined
          ? { goalBlockAttempt: input.goalBlockAttempt }
          : {}),
        ...(input.goalBlockTurnId !== undefined
          ? { goalBlockTurnId: TurnId.makeUnsafe(input.goalBlockTurnId) }
          : {}),
        ...(input.goalBlockReset !== undefined ? { goalBlockReset: input.goalBlockReset } : {}),
      },
      readModel,
    }),
  );
  const event = Array.isArray(result) ? result[0] : result;
  expect(event?.type).toBe("thread.meta-updated");
  if (!event || event.type !== "thread.meta-updated") {
    throw new Error("Expected a thread.meta-updated event.");
  }
  return event;
}

async function applyEvent(
  readModel: OrchestrationReadModel,
  event: OrchestrationEvent,
  sequence: number,
) {
  return Effect.runPromise(projectEvent(readModel, { ...event, sequence } as OrchestrationEvent));
}

describe("decider thread goal timing", () => {
  it("stamps goalStartedAt when a goal first becomes active and keeps it on edits", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);

    const setEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-set",
      goal: "Ship the feature",
    });
    expect(setEvent.payload.goalStartedAt).toBe(setEvent.occurredAt);
    expect(setEvent.payload.goalPausedAt).toBeNull();

    readModel = await applyEvent(readModel, setEvent, 3);
    expect(readModel.threads[0]?.goalStartedAt).toBe(setEvent.occurredAt);

    const editEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-edit",
      goal: "Ship the feature and tests",
    });
    expect("goalStartedAt" in editEvent.payload).toBe(false);
    expect("goalPausedAt" in editEvent.payload).toBe(false);

    readModel = await applyEvent(readModel, editEvent, 4);
    expect(readModel.threads[0]?.goal).toBe("Ship the feature and tests");
    expect(readModel.threads[0]?.goalStartedAt).toBe(setEvent.occurredAt);
  });

  it("clears both timestamps when the goal is cleared", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    readModel = await applyEvent(
      readModel,
      await decideGoalUpdate(readModel, { commandId: "cmd-goal-set", goal: "Objective" }),
      3,
    );

    const clearEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-clear",
      goal: "",
    });
    expect(clearEvent.payload.goalStartedAt).toBeNull();
    expect(clearEvent.payload.goalPausedAt).toBeNull();

    readModel = await applyEvent(readModel, clearEvent, 4);
    expect(readModel.threads[0]?.goalStartedAt).toBeNull();
    expect(readModel.threads[0]?.goalPausedAt).toBeNull();
  });

  it("pauses once and rebases goalStartedAt on resume so paused time never counts", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    const setEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-set",
      goal: "Objective",
    });
    readModel = await applyEvent(readModel, setEvent, 3);

    readModel = await applyEvent(
      readModel,
      await decideGoalUpdate(readModel, {
        commandId: "cmd-goal-block-before-pause",
        goalBlockAttempt: true,
        goalBlockTurnId: "turn-goal-block-before-pause",
      }),
      4,
    );
    expect(readModel.threads[0]?.goalBlockCount).toBe(1);

    const pauseEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-pause",
      goalPaused: true,
    });
    expect(pauseEvent.payload.goalPausedAt).toBe(pauseEvent.occurredAt);
    expect("goalStartedAt" in pauseEvent.payload).toBe(false);
    readModel = await applyEvent(readModel, pauseEvent, 5);

    const repauseEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-repause",
      goalPaused: true,
    });
    expect("goalPausedAt" in repauseEvent.payload).toBe(false);

    const resumeEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-resume",
      goalPaused: false,
    });
    expect(resumeEvent.payload.goalPausedAt).toBeNull();
    expect(resumeEvent.payload.goalBlockCount).toBe(0);
    expect(resumeEvent.payload.goalBlockLastTurnId).toBeNull();
    const rebasedStartedAt = resumeEvent.payload.goalStartedAt;
    expect(typeof rebasedStartedAt).toBe("string");
    if (typeof rebasedStartedAt !== "string") return;
    // Elapsed-at-pause must equal elapsed-at-resume: resume shifts the start
    // forward by exactly the paused span.
    const elapsedAtPause = Date.parse(pauseEvent.occurredAt) - Date.parse(setEvent.occurredAt);
    const elapsedAtResume = Date.parse(resumeEvent.occurredAt) - Date.parse(rebasedStartedAt);
    expect(elapsedAtResume).toBe(elapsedAtPause);

    readModel = await applyEvent(readModel, resumeEvent, 6);
    expect(readModel.threads[0]?.goalPausedAt).toBeNull();
    expect(readModel.threads[0]?.goalStartedAt).toBe(rebasedStartedAt);
  });

  it("ignores pause intents when the thread has no active goal", async () => {
    const now = new Date().toISOString();
    const readModel = await createThreadReadModel(now);

    const event = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-pause-empty",
      goalPaused: true,
    });
    expect("goalPausedAt" in event.payload).toBe(false);
    expect("goalStartedAt" in event.payload).toBe(false);
  });

  it("resumes with a valid clock even when a legacy goal has no recorded start", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    // Legacy shape: goal set before timing existed — paused but with no start stamp.
    readModel = await applyEvent(
      readModel,
      {
        eventId: EventId.makeUnsafe("evt-legacy-goal"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.meta-updated",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-legacy-goal"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-legacy-goal"),
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          goal: "Legacy objective",
          goalPausedAt: now,
          updatedAt: now,
        },
        sequence: 3,
      } as OrchestrationEvent,
      3,
    );

    const resumeEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-legacy-resume",
      goalPaused: false,
    });
    expect(resumeEvent.payload.goalPausedAt).toBeNull();
    expect(resumeEvent.payload.goalStartedAt).toBe(resumeEvent.occurredAt);
  });

  it("refuses seven distinct blocker stops and pauses on the eighth goal turn", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    readModel = await applyEvent(
      readModel,
      await decideGoalUpdate(readModel, {
        commandId: "cmd-goal-block-limit-set",
        goal: "Finish despite temporary blockers",
      }),
      3,
    );

    let sequence = 4;
    for (let attempt = 1; attempt < THREAD_GOAL_BLOCK_ATTEMPT_LIMIT; attempt += 1) {
      const turnId = `turn-goal-block-${attempt}`;
      const event = await decideGoalUpdate(readModel, {
        commandId: `cmd-goal-block-${attempt}`,
        goalBlockAttempt: true,
        goalBlockTurnId: turnId,
      });
      expect(event.payload.goalBlockCount).toBe(attempt);
      expect(event.payload.goalBlockLastTurnId).toBe(turnId);
      expect("goalPausedAt" in event.payload).toBe(false);
      readModel = await applyEvent(readModel, event, sequence++);
      expect(readModel.threads[0]?.goalPausedAt).toBeNull();
    }

    const repeatedSameTurn = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-block-duplicate",
      goalBlockAttempt: true,
      goalBlockTurnId: `turn-goal-block-${THREAD_GOAL_BLOCK_ATTEMPT_LIMIT - 1}`,
    });
    expect("goalBlockCount" in repeatedSameTurn.payload).toBe(false);
    readModel = await applyEvent(readModel, repeatedSameTurn, sequence++);
    expect(readModel.threads[0]?.goalBlockCount).toBe(THREAD_GOAL_BLOCK_ATTEMPT_LIMIT - 1);

    const pauseEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-block-limit",
      goalBlockAttempt: true,
      goalBlockTurnId: `turn-goal-block-${THREAD_GOAL_BLOCK_ATTEMPT_LIMIT}`,
    });
    expect(pauseEvent.payload.goalBlockCount).toBe(THREAD_GOAL_BLOCK_ATTEMPT_LIMIT);
    expect(pauseEvent.payload.goalPausedAt).toBe(pauseEvent.occurredAt);
    readModel = await applyEvent(readModel, pauseEvent, sequence);
    expect(readModel.threads[0]?.goalPausedAt).toBe(pauseEvent.occurredAt);
  });

  it("resets the blocker streak after progress and when the goal changes", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    readModel = await applyEvent(
      readModel,
      await decideGoalUpdate(readModel, {
        commandId: "cmd-goal-block-reset-set",
        goal: "Finish the original objective",
      }),
      3,
    );
    readModel = await applyEvent(
      readModel,
      await decideGoalUpdate(readModel, {
        commandId: "cmd-goal-block-reset-attempt",
        goalBlockAttempt: true,
        goalBlockTurnId: "turn-goal-block-reset",
      }),
      4,
    );
    expect(readModel.threads[0]?.goalBlockCount).toBe(1);

    const resetEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-block-reset-progress",
      goalBlockReset: true,
    });
    expect(resetEvent.payload.goalBlockCount).toBe(0);
    expect(resetEvent.payload.goalBlockLastTurnId).toBeNull();
    readModel = await applyEvent(readModel, resetEvent, 5);

    readModel = await applyEvent(
      readModel,
      await decideGoalUpdate(readModel, {
        commandId: "cmd-goal-block-reset-second-attempt",
        goalBlockAttempt: true,
        goalBlockTurnId: "turn-goal-block-reset-second",
      }),
      6,
    );
    const editEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-block-reset-edit",
      goal: "Finish the revised objective",
    });
    expect(editEvent.payload.goalBlockCount).toBe(0);
    expect(editEvent.payload.goalBlockLastTurnId).toBeNull();
  });

  it("records an achievement with the running elapsed time and clears the goal", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    const setEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-set",
      goal: "Ship the feature",
    });
    readModel = await applyEvent(readModel, setEvent, 3);

    const achieveEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-achieve",
      goalAchieved: true,
    });
    expect(achieveEvent.payload.goal).toBe("");
    expect(achieveEvent.payload.goalStartedAt).toBeNull();
    expect(achieveEvent.payload.goalPausedAt).toBeNull();
    const achievements = achieveEvent.payload.goalAchievements;
    expect(achievements).toHaveLength(1);
    expect(achievements?.[0]).toEqual({
      goal: "Ship the feature",
      achievedAt: achieveEvent.occurredAt,
      elapsedMs: Date.parse(achieveEvent.occurredAt) - Date.parse(setEvent.occurredAt),
      turnId: null,
    });

    readModel = await applyEvent(readModel, achieveEvent, 4);
    expect(readModel.threads[0]?.goal).toBe("");
    expect(readModel.threads[0]?.goalAchievements).toHaveLength(1);
  });

  it("freezes the achievement's elapsed time at the pause stamp for paused goals", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    const setEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-set",
      goal: "Objective",
    });
    readModel = await applyEvent(readModel, setEvent, 3);
    const pauseEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-pause",
      goalPaused: true,
    });
    readModel = await applyEvent(readModel, pauseEvent, 4);

    const achieveEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-achieve",
      goalAchieved: true,
    });
    expect(achieveEvent.payload.goalAchievements?.[0]?.elapsedMs).toBe(
      Date.parse(pauseEvent.occurredAt) - Date.parse(setEvent.occurredAt),
    );
  });

  it("records a null elapsed time for legacy goals without a start stamp", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    readModel = await applyEvent(
      readModel,
      {
        eventId: EventId.makeUnsafe("evt-legacy-goal"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.meta-updated",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-legacy-goal"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-legacy-goal"),
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          goal: "Legacy objective",
          updatedAt: now,
        },
        sequence: 3,
      } as OrchestrationEvent,
      3,
    );

    const achieveEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-legacy-achieve",
      goalAchieved: true,
    });
    expect(achieveEvent.payload.goalAchievements?.[0]?.elapsedMs).toBeNull();
    expect(achieveEvent.payload.goalAchievements?.[0]?.goal).toBe("Legacy objective");
  });

  it("ignores achieved intents when the thread has no active goal", async () => {
    const now = new Date().toISOString();
    const readModel = await createThreadReadModel(now);

    const event = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-achieve-empty",
      goalAchieved: true,
    });
    expect("goal" in event.payload).toBe(false);
    expect("goalAchievements" in event.payload).toBe(false);
  });

  it("caps the achievement history at the newest 20 entries", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    const priorAchievements = Array.from({ length: 20 }, (_, index) => ({
      goal: `Objective ${index}`,
      achievedAt: now,
      elapsedMs: null,
      turnId: null,
    }));
    readModel = await applyEvent(
      readModel,
      {
        eventId: EventId.makeUnsafe("evt-goal-history"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.meta-updated",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-goal-history"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-goal-history"),
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          goal: "Objective 20",
          goalStartedAt: now,
          goalAchievements: priorAchievements,
          updatedAt: now,
        },
        sequence: 3,
      } as OrchestrationEvent,
      3,
    );

    const achieveEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-achieve-cap",
      goalAchieved: true,
    });
    const achievements = achieveEvent.payload.goalAchievements;
    expect(achievements).toHaveLength(20);
    expect(achievements?.[0]?.goal).toBe("Objective 1");
    expect(achievements?.[19]?.goal).toBe("Objective 20");
  });

  it("pauses an active goal atomically before interrupting its turn", async () => {
    const now = new Date().toISOString();
    let readModel = await createThreadReadModel(now);
    const setEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-set-before-interrupt",
      goal: "Finish the implementation",
    });
    readModel = await applyEvent(readModel, setEvent, 3);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-interrupt-active-goal"),
          threadId: THREAD_ID,
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result.map((event) => event.type)).toEqual([
      "thread.meta-updated",
      "thread.turn-interrupt-requested",
    ]);
    const pauseEvent = result[0];
    expect(pauseEvent?.type).toBe("thread.meta-updated");
    if (pauseEvent?.type !== "thread.meta-updated") return;
    expect(pauseEvent.payload.goalPausedAt).toBe(pauseEvent.occurredAt);
  });

  it("rejects an agent interrupt against the authoritative active-goal state", async () => {
    const now = new Date().toISOString();
    const callerTurnId = TurnId.makeUnsafe("turn-agent-interrupt-guard");
    let readModel = await createThreadReadModel(now);
    const setEvent = await decideGoalUpdate(readModel, {
      commandId: "cmd-goal-set-before-agent-interrupt",
      goal: "Finish the implementation",
    });
    readModel = withRunningTurn(await applyEvent(readModel, setEvent, 3), THREAD_ID, callerTurnId);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe("cmd-agent-interrupt-active-goal"),
            threadId: THREAD_ID,
            agentCallerThreadId: THREAD_ID,
            agentCallerTurnId: callerTurnId,
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("cannot interrupt");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe("cmd-stale-agent-interrupt"),
            threadId: THREAD_ID,
            agentCallerThreadId: THREAD_ID,
            agentCallerTurnId: TurnId.makeUnsafe("turn-stale-agent-interrupt"),
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("no longer the active turn");
  });

  it("keeps existing goal ownership on its thread while permitting a fresh delegated goal", async () => {
    const now = new Date().toISOString();
    const callerTurnId = TurnId.makeUnsafe("turn-goal-owner-caller");
    const targetThreadId = ThreadId.makeUnsafe("thread-goal-owner-target");
    let readModel = withRunningTurn(await createThreadReadModel(now), THREAD_ID, callerTurnId);
    const template = readModel.threads[0]!;
    readModel = {
      ...readModel,
      threads: [
        template,
        {
          ...template,
          id: targetThreadId,
          title: "Delegated target",
          goal: "Target-owned objective",
          goalStartedAt: now,
          goalPausedAt: null,
          latestTurn: null,
          session: null,
        },
      ],
    };

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-cross-agent-achieve-goal"),
            threadId: targetThreadId,
            agentCallerThreadId: THREAD_ID,
            agentCallerTurnId: callerTurnId,
            goalAchieved: true,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("cannot mutate the persistent goal");

    const emptyTargetReadModel: OrchestrationReadModel = {
      ...readModel,
      threads: readModel.threads.map((thread) =>
        thread.id === targetThreadId
          ? {
              ...thread,
              goal: "",
              goalStartedAt: null,
              goalPausedAt: null,
            }
          : thread,
      ),
    };
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-cross-agent-set-fresh-goal"),
          threadId: targetThreadId,
          agentCallerThreadId: THREAD_ID,
          agentCallerTurnId: callerTurnId,
          goal: "Fresh delegated objective",
        },
        readModel: emptyTargetReadModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;
    expect(event?.type).toBe("thread.meta-updated");
    if (event?.type === "thread.meta-updated") {
      expect(event.payload.goal).toBe("Fresh delegated objective");
    }
  });
});
