import { describe, expect, it } from "vitest";
import { ThreadId, type ThreadCoordinationWait, type CoordinatorQuestion } from "@synara/contracts";

import {
  coordinationBadges,
  coordinationFinishedCount,
  coordinationWaitLabel,
} from "./threadCoordination";

const threadId = ThreadId.makeUnsafe("parent");
const wait: ThreadCoordinationWait = {
  waitId: "wait",
  threadId,
  createdAt: "2026-10-01T10:00:00.000Z",
  state: "waiting",
  cancellable: true,
  targets: [
    {
      threadId: ThreadId.makeUnsafe("child"),
      title: "Review",
      provider: "codex",
      runId: null,
      messageId: null,
      state: "running",
    },
    {
      threadId: ThreadId.makeUnsafe("other"),
      title: "Tests",
      provider: "claudeAgent",
      runId: null,
      messageId: null,
      state: "error",
    },
  ],
};

describe("coordination presentation", () => {
  it("counts terminal outcomes without calling failures completed", () => {
    expect(coordinationFinishedCount(wait)).toBe(1);
    expect(coordinationWaitLabel(wait)).toContain("Waiting for");
    expect(
      coordinationBadges({ waits: [wait], questions: [], hasMore: false }).get(threadId)?.label,
    ).toBe("Waiting · 1/2");
    expect(coordinationBadges(undefined).size).toBe(0);
  });

  it("gives human escalation priority over waits and late executor questions", () => {
    const question = {
      questionId: "q",
      coordinatorThreadId: threadId,
      executorThreadId: ThreadId.makeUnsafe("child"),
      state: "human",
    } as CoordinatorQuestion;
    const badges = coordinationBadges({
      waits: [wait],
      questions: [question, { ...question, questionId: "q2", state: "asked" }],
      hasMore: false,
    });
    expect(badges.get(threadId)).toEqual({ label: "Needs your answer", needsInput: true });
    expect(badges.get("child")?.label).toBe("Waiting for coordinator");
  });
});
