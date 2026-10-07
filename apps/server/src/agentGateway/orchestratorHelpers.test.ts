import { describe, expect, it } from "vitest";

import {
  awaitIsAuto,
  awaitTargetsReady,
  awaitUntilAny,
  selectOrchestratorChildrenToArm,
} from "./awaitThreads.ts";
import {
  compactSummary,
  ORCHESTRATOR_SUMMARY_MAX_CHARS,
  orchestratorChildren,
} from "./threadReadTools.ts";

describe("orchestrator await/status helpers", () => {
  it("resumes until=any waits on the first finished target and all waits on the last", () => {
    const done = { result: {} as never };
    const pending = { result: null };
    expect(awaitUntilAny(JSON.stringify({ threadIds: ["a"], until: "any" }))).toBe(true);
    expect(awaitUntilAny(JSON.stringify({ threadIds: ["a"] }))).toBe(false);
    expect(awaitUntilAny("not json")).toBe(false);
    expect(awaitTargetsReady(true, [pending, done])).toBe(true);
    expect(awaitTargetsReady(true, [pending, pending])).toBe(false);
    expect(awaitTargetsReady(false, [pending, done])).toBe(false);
    expect(awaitTargetsReady(false, [done, done])).toBe(true);
  });

  it("lists only the caller's children oldest first with capped summaries", () => {
    const threads = [
      { id: "b", sourceThreadId: "orch", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "x", sourceThreadId: "other", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a", sourceThreadId: "orch", createdAt: "2026-01-01T00:00:00.000Z" },
    ] as never[];
    expect(orchestratorChildren(threads, "orch").map((t: { id: string }) => t.id)).toEqual([
      "a",
      "b",
    ]);
    expect(compactSummary(null)).toBeNull();
    expect(compactSummary("  short  ")).toBe("short");
    expect(compactSummary("x".repeat(1000))).toHaveLength(ORCHESTRATOR_SUMMARY_MAX_CHARS + 1);
  });

  it("arms running, tracked, and same-turn finished children but never stale history", () => {
    const turnRequestedAt = "2026-01-02T00:00:00.000Z";
    const child = (id: string, createdAt: string, active: boolean, completedAt: string | null) => ({
      id,
      createdAt,
      active,
      completedAt,
    });
    expect(
      selectOrchestratorChildrenToArm({
        turnRequestedAt,
        trackedThreadIds: new Set(["tracked"]),
        children: [
          child("running", "2026-01-01T00:00:00.000Z", true, null),
          child("tracked", "2026-01-01T00:00:00.000Z", false, "2026-01-01T12:00:00.000Z"),
          child("fast", "2026-01-02T00:00:01.000Z", false, "2026-01-02T00:00:02.000Z"),
          child("stale", "2026-01-01T00:00:00.000Z", false, "2026-01-02T00:00:05.000Z"),
        ],
      }),
    ).toEqual(["running", "tracked", "fast"]);
    expect(awaitIsAuto(JSON.stringify({ auto: true, until: "any" }))).toBe(true);
    expect(awaitIsAuto(JSON.stringify({ until: "any" }))).toBe(false);
  });
});
