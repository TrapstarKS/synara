// FILE: runtime.test.ts
// Purpose: Unit tests for the ChatGPT connector runtime registry: fail-closed
//          call attribution, one-turn-at-a-time admission, and lifecycle.
// Layer: Server provider connector tests

import { describe, expect, it } from "vitest";

import {
  ChatGptRuntimeRegistry,
  sessionTagForThread,
  type ChatGptThreadRuntime,
  type ConnectorCallContext,
} from "./runtime.ts";
import type { ConnectorAgentBridge } from "./tools/agents.ts";
import type { ExecSessionManager } from "./tools/execSessions.ts";

const NO_ACTIVE_TURN = "No ChatGPT (Web) turn is active";

function fakeAgents(tag: string): ConnectorAgentBridge {
  return { kind: "agents", tag } as unknown as ConnectorAgentBridge;
}

function fakeExec(tag: string): ExecSessionManager {
  return { kind: "exec", tag } as unknown as ExecSessionManager;
}

function makeRuntime(threadId: string, workspaceRoot = `/tmp/${threadId}`): ChatGptThreadRuntime {
  return {
    threadId,
    workspaceRoot,
    agents: fakeAgents(threadId),
    exec: fakeExec(threadId),
  };
}

function resolveOk(registry: ChatGptRuntimeRegistry, sessionTag?: string): ConnectorCallContext {
  const resolution = registry.resolveCallContext(sessionTag);
  if (!resolution.ok) {
    throw new Error(`Expected an attributed context, got: ${resolution.message}`);
  }
  return resolution.context;
}

function resolveError(registry: ChatGptRuntimeRegistry, sessionTag?: string): string {
  const resolution = registry.resolveCallContext(sessionTag);
  if (resolution.ok) {
    throw new Error("Expected the call to be refused.");
  }
  return resolution.message;
}

describe("ChatGptRuntimeRegistry", () => {
  it("refuses to resolve when no runtime is registered", () => {
    const registry = new ChatGptRuntimeRegistry();

    const message = resolveError(registry);
    expect(message).toContain(NO_ACTIVE_TURN);
    expect(message).toContain("cannot be attributed to a workspace");
  });

  it("resolves the active turn with the registered runtime references", () => {
    const registry = new ChatGptRuntimeRegistry();
    const runtime = makeRuntime("thread-a", "/tmp/workspace-a");
    registry.register(runtime);

    expect(registry.beginTurn("thread-a", "turn-1")).toEqual({ ok: true });

    const context = resolveOk(registry);
    expect(context.threadId).toBe("thread-a");
    expect(context.turnId).toBe("turn-1");
    expect(context.workspaceRoot).toBe("/tmp/workspace-a");
    expect(context.agents).toBe(runtime.agents);
    expect(context.exec).toBe(runtime.exec);
  });

  it("refuses after registration but before a turn begins", () => {
    const registry = new ChatGptRuntimeRegistry();
    registry.register(makeRuntime("thread-a"));

    expect(resolveError(registry)).toContain(NO_ACTIVE_TURN);
  });

  it("refuses to begin a turn for a thread without a registered runtime", () => {
    const registry = new ChatGptRuntimeRegistry();
    const result = registry.beginTurn("thread-missing", "turn-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("no live ChatGPT (Web) session");
    }
    expect(resolveError(registry)).toContain(NO_ACTIVE_TURN);
  });

  it("admits concurrent turns and resolves tagged calls per conversation", () => {
    const registry = new ChatGptRuntimeRegistry();
    registry.register(makeRuntime("thread-a"));
    registry.register(makeRuntime("thread-b"));

    expect(registry.beginTurn("thread-a", "turn-a1")).toEqual({ ok: true });
    expect(registry.beginTurn("thread-b", "turn-b1")).toEqual({ ok: true });

    // Two live turns without a tag are ambiguous: refuse instead of guessing.
    expect(resolveError(registry)).toContain("Several ChatGPT (Web) turns are active");

    // The session tag names the conversation, so tool calls stay attributable.
    const tagA = sessionTagForThread("thread-a");
    expect(registry.resolveCallContext(tagA)).toMatchObject({
      ok: true,
      context: { threadId: "thread-a", turnId: "turn-a1" },
    });
    expect(registry.resolveCallContext(sessionTagForThread("thread-b"))).toMatchObject({
      ok: true,
      context: { threadId: "thread-b", turnId: "turn-b1" },
    });

    // A known tag with no turn in flight, and unknown tags, fail closed.
    registry.endTurn("thread-a");
    expect(resolveError(registry, tagA)).toContain("no ChatGPT (Web) turn in flight");
    expect(resolveError(registry, "deadbeef")).toContain("Unknown synara_session tag");

    // With a single turn left, an untagged call resolves again.
    expect(resolveOk(registry).turnId).toBe("turn-b1");

    // Re-begins on the same thread keep their own turn.
    expect(registry.beginTurn("thread-a", "turn-a2")).toEqual({ ok: true });
    expect(registry.resolveCallContext(tagA)).toMatchObject({
      ok: true,
      context: { threadId: "thread-a", turnId: "turn-a2" },
    });
  });

  it("clears only the matching thread's turn", () => {
    const registry = new ChatGptRuntimeRegistry();
    registry.register(makeRuntime("thread-a"));
    registry.register(makeRuntime("thread-b"));
    registry.beginTurn("thread-a", "turn-1");

    registry.endTurn("thread-b");
    expect(registry.isTurnActive("thread-a")).toBe(true);
    expect(resolveOk(registry).turnId).toBe("turn-1");

    registry.endTurn("thread-a");
    expect(registry.isTurnActive("thread-a")).toBe(false);
    expect(resolveError(registry)).toContain(NO_ACTIVE_TURN);
  });

  it("clears active state when the active thread unregisters", () => {
    const registry = new ChatGptRuntimeRegistry();
    registry.register(makeRuntime("thread-a"));
    registry.register(makeRuntime("thread-b"));
    registry.beginTurn("thread-a", "turn-1");

    registry.unregister("thread-b");
    expect(registry.get("thread-b")).toBeUndefined();
    expect(registry.isTurnActive("thread-a")).toBe(true);

    registry.unregister("thread-a");
    expect(registry.get("thread-a")).toBeUndefined();
    expect(resolveError(registry)).toContain(NO_ACTIVE_TURN);
  });

  it("snapshots active and registered threads", () => {
    const registry = new ChatGptRuntimeRegistry();
    expect(registry.snapshot()).toEqual({
      activeThreadId: null,
      activeTurnId: null,
      activeThreadIds: [],
      registeredThreadIds: [],
    });

    registry.register(makeRuntime("thread-a"));
    registry.register(makeRuntime("thread-b"));
    expect(registry.snapshot()).toEqual({
      activeThreadId: null,
      activeTurnId: null,
      activeThreadIds: [],
      registeredThreadIds: ["thread-a", "thread-b"],
    });

    registry.beginTurn("thread-a", "turn-a1");
    registry.beginTurn("thread-b", "turn-2");
    expect(registry.snapshot()).toEqual({
      activeThreadId: "thread-b",
      activeTurnId: "turn-2",
      activeThreadIds: ["thread-a", "thread-b"],
      registeredThreadIds: ["thread-a", "thread-b"],
    });

    registry.endTurn("thread-b");
    expect(registry.snapshot()).toEqual({
      activeThreadId: "thread-a",
      activeTurnId: "turn-a1",
      activeThreadIds: ["thread-a"],
      registeredThreadIds: ["thread-a", "thread-b"],
    });
  });

  it("replaces the runtime when the same thread registers again", () => {
    const registry = new ChatGptRuntimeRegistry();
    const first = makeRuntime("thread-a", "/tmp/first");
    const second = makeRuntime("thread-a", "/tmp/second");

    registry.register(first);
    registry.register(second);
    registry.beginTurn("thread-a", "turn-1");

    expect(registry.get("thread-a")).toBe(second);
    expect(resolveOk(registry).workspaceRoot).toBe("/tmp/second");
  });
});
