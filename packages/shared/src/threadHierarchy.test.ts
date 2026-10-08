import { describe, expect, it } from "vitest";

import { collectSubagentDescendants } from "./threadHierarchy";

function thread(id: string, parentThreadId?: string | null) {
  return { id, parentThreadId: parentThreadId ?? null };
}

describe("collectSubagentDescendants", () => {
  it("collects nested descendants breadth-first and excludes the root", () => {
    const threads = [
      thread("root"),
      thread("child-a", "root"),
      thread("grandchild", "child-a"),
      thread("child-b", "root"),
      thread("unrelated"),
      thread("unrelated-child", "unrelated"),
    ];

    expect(collectSubagentDescendants(threads, "root").map((entry) => entry.id)).toEqual([
      "child-a",
      "child-b",
      "grandchild",
    ]);
  });

  it("survives cyclic and self-referential linkage", () => {
    const threads = [
      thread("root"),
      thread("child", "root"),
      // Corrupted rows: the root claims the child as its parent, and a thread points at itself.
      { id: "root", parentThreadId: "child" },
      thread("self", "self"),
    ];

    expect(collectSubagentDescendants(threads, "root").map((entry) => entry.id)).toEqual(["child"]);
  });
});

describe("orchestrator children", () => {
  it("treats synara_mcp threads as children of the orchestrator that created them", () => {
    const threads = [
      thread("orchestrator"),
      { id: "worker", creationSource: "synara_mcp", sourceThreadId: "orchestrator" },
      thread("worker-subagent", "worker"),
      // A fork/handoff keeps its source link but is not owned by the source thread.
      { id: "fork", creationSource: null, sourceThreadId: "orchestrator" },
    ];

    expect(collectSubagentDescendants(threads, "orchestrator").map((entry) => entry.id)).toEqual([
      "worker",
      "worker-subagent",
    ]);
  });
});
