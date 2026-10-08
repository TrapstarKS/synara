import { ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { makeThread } from "../storeTestFixtures";
import { collectCompletedThreadCandidates } from "./taskCompletion.logic";

describe("completion notification work during concurrent streaming", () => {
  it("does not read unchanged completed histories while 20 other threads stream", () => {
    let historyReads = 0;
    const completed = Array.from({ length: 200 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`completed-${index}`),
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-08T00:01:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe(`completed-turn-${index}`),
          state: "completed",
          requestedAt: "2026-10-08T00:00:00.000Z",
          startedAt: "2026-10-08T00:00:00.000Z",
          completedAt: "2026-10-08T00:01:00.000Z",
          assistantMessageId: null,
        },
      }),
    );
    for (const thread of completed) {
      Object.defineProperty(thread, "activities", {
        get: () => {
          historyReads += 1;
          return [];
        },
      });
    }
    const streaming = Array.from({ length: 20 }, (_, index) =>
      makeThread({ id: ThreadId.makeUnsafe(`streaming-${index}`) }),
    );
    historyReads = 0;
    let previous = [...completed, ...streaming];
    for (let flush = 0; flush < 100; flush += 1) {
      const next = [...completed];
      for (const thread of streaming) {
        next.push({ ...thread, updatedAt: String(flush) });
      }
      expect(collectCompletedThreadCandidates(previous, next, { waitForSubagents: true })).toEqual(
        [],
      );
      previous = next;
    }
    expect(historyReads).toBe(0);
  });
});
