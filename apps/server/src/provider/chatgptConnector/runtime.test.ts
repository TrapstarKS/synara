// FILE: runtime.test.ts
// Purpose: Unit tests for the ChatGPT connector runtime registry: fail-closed
//          call attribution, one-turn-at-a-time admission, and lifecycle.
// Layer: Server provider connector tests

import { describe, expect, it } from "vitest";

import {
  ChatGptRuntimeRegistry,
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

function resolveOk(registry: ChatGptRuntimeRegistry): ConnectorCallContext {
  const resolution = registry.resolveCallContext();
  if (!resolution.ok) {
    throw new Error(`Expected an attributed context, got: ${resolution.message}`);
  }
  return resolution.context;
}

function resolveError(registry: ChatGptRuntimeRegistry): string {
  const resolution = registry.resolveCallContext();
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

  it("admits one turn at a time across threads and re-begins on the same thread", () => {
    const registry = new ChatGptRuntimeRegistry();
    registry.register(makeRuntime("thread-a"));
    registry.register(makeRuntime("thread-b"));

    expect(registry.beginTurn("thread-a", "turn-1")).toEqual({ ok: true });

    const conflict = registry.beginTurn("thread-b", "turn-b1");
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("Expected the second thread's turn to be refused.");
    expect(conflict.message).toContain("Only one ChatGPT turn can run at a time");
    expect(registry.snapshot()).toMatchObject({
      activeThreadId: "thread-a",
      activeTurnId: "turn-1",
    });

    expect(registry.beginTurn("thread-a", "turn-2")).toEqual({ ok: true });
    expect(resolveOk(registry).turnId).toBe("turn-2");
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
      registeredThreadIds: [],
    });

    registry.register(makeRuntime("thread-a"));
    registry.register(makeRuntime("thread-b"));
    expect(registry.snapshot()).toEqual({
      activeThreadId: null,
      activeTurnId: null,
      registeredThreadIds: ["thread-a", "thread-b"],
    });

    registry.beginTurn("thread-b", "turn-2");
    expect(registry.snapshot()).toEqual({
      activeThreadId: "thread-b",
      activeTurnId: "turn-2",
      registeredThreadIds: ["thread-a", "thread-b"],
    });

    registry.endTurn("thread-b");
    expect(registry.snapshot()).toEqual({
      activeThreadId: null,
      activeTurnId: null,
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
