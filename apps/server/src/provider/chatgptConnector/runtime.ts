// FILE: runtime.ts
// Purpose: Holds the live ChatGPT web runtimes (one per Synara thread) and
//          attributes incoming connector calls to the right thread.
// Layer: Server provider connector
//
// ChatGPT's MCP connector sends no conversation identity on the wire, so
// attribution is runtime-based: a thread registers exactly one runtime while
// its session is alive, and at most one runtime anywhere may hold an active
// turn. A call that cannot be attributed to exactly one thread is refused
// instead of guessed, matching the reference implementation's fail-closed
// identity discipline.

import type { ConnectorAgentBridge } from "./tools/agents.ts";
import type { ExecSessionManager } from "./tools/execSessions.ts";
import type { WorkspaceToolContext } from "./types.ts";

export interface ConnectorCallContext extends WorkspaceToolContext {
  readonly threadId: string;
  readonly turnId: string;
  readonly agents: ConnectorAgentBridge;
  readonly exec: ExecSessionManager;
}

export type ConnectorCallResolution =
  | { readonly ok: true; readonly context: ConnectorCallContext }
  | { readonly ok: false; readonly message: string };

export interface ChatGptThreadRuntime {
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly agents: ConnectorAgentBridge;
  readonly exec: ExecSessionManager;
}

export interface ChatGptRuntimeSnapshot {
  readonly activeThreadId: string | null;
  readonly activeTurnId: string | null;
  readonly registeredThreadIds: ReadonlyArray<string>;
}

const NO_ACTIVE_TURN_MESSAGE =
  "No ChatGPT (Web) turn is active in Synara, so this tool call cannot be attributed to a workspace. Start or continue the turn in Synara and retry.";

export class ChatGptRuntimeRegistry {
  private readonly runtimes = new Map<string, ChatGptThreadRuntime>();
  private activeThreadId: string | null = null;
  private activeTurnId: string | null = null;

  register(runtime: ChatGptThreadRuntime): void {
    this.runtimes.set(runtime.threadId, runtime);
  }

  unregister(threadId: string): void {
    this.runtimes.delete(threadId);
    if (this.activeThreadId === threadId) {
      this.activeThreadId = null;
      this.activeTurnId = null;
    }
  }

  get(threadId: string): ChatGptThreadRuntime | undefined {
    return this.runtimes.get(threadId);
  }

  /**
   * Marks a turn active. A second thread cannot start a turn while another is
   * active because its tool calls would be indistinguishable from this one's.
   */
  beginTurn(threadId: string, turnId: string): { ok: true } | { ok: false; message: string } {
    if (!this.runtimes.has(threadId)) {
      return {
        ok: false,
        message:
          "This Synara thread has no live ChatGPT (Web) session, so no turn can be attributed to it.",
      };
    }
    if (this.activeThreadId !== null && this.activeThreadId !== threadId) {
      return {
        ok: false,
        message:
          "Another Synara thread is currently running a ChatGPT (Web) turn. Only one ChatGPT turn can run at a time; wait for it to finish and retry.",
      };
    }
    this.activeThreadId = threadId;
    this.activeTurnId = turnId;
    return { ok: true };
  }

  endTurn(threadId: string): void {
    if (this.activeThreadId === threadId) {
      this.activeThreadId = null;
      this.activeTurnId = null;
    }
  }

  isTurnActive(threadId: string): boolean {
    return this.activeThreadId === threadId;
  }

  resolveCallContext(): ConnectorCallResolution {
    const threadId = this.activeThreadId;
    const turnId = this.activeTurnId;
    if (threadId === null || turnId === null) {
      return { ok: false, message: NO_ACTIVE_TURN_MESSAGE };
    }
    const runtime = this.runtimes.get(threadId);
    if (!runtime) {
      return { ok: false, message: NO_ACTIVE_TURN_MESSAGE };
    }
    return {
      ok: true,
      context: {
        threadId,
        turnId,
        workspaceRoot: runtime.workspaceRoot,
        agents: runtime.agents,
        exec: runtime.exec,
      },
    };
  }

  snapshot(): ChatGptRuntimeSnapshot {
    return {
      activeThreadId: this.activeThreadId,
      activeTurnId: this.activeTurnId,
      registeredThreadIds: [...this.runtimes.keys()],
    };
  }
}
