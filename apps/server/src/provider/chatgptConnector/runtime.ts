// FILE: runtime.ts
// Purpose: Holds the live ChatGPT web runtimes (one per Synara thread) and
//          attributes incoming connector calls to the right thread.
// Layer: Server provider connector
//
// ChatGPT's MCP connector sends no conversation identity on the wire, so
// attribution is runtime-based: a thread registers exactly one runtime while
// its session is alive, and a call is attributed to that thread's active turn.
// Several threads may run turns at the same time; a call then has to name its
// conversation's `synara_session` tag (named in the conversation preamble) or
// it is refused instead of guessed, matching the reference implementation's
// fail-closed identity discipline.

import { createHash } from "node:crypto";

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
  /** Every thread with a turn in flight, in begin order. */
  readonly activeThreadIds: ReadonlyArray<string>;
  readonly registeredThreadIds: ReadonlyArray<string>;
}

const NO_ACTIVE_TURN_MESSAGE =
  "No ChatGPT (Web) turn is active in Synara, so this tool call cannot be attributed to a workspace. Start or continue the turn in Synara and retry.";

const MULTIPLE_ACTIVE_TURNS_MESSAGE =
  "Several ChatGPT (Web) turns are active at once, so this call cannot be attributed to one conversation. Repeat the call including the synara_session tag named in this conversation's Synara preamble.";

/**
 * Short stable tag that names one Synara thread inside its ChatGPT
 * conversation. The conversation preamble asks the model to echo it back as
 * `synara_session` with every workspace tool call.
 */
export function sessionTagForThread(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex").slice(0, 8);
}

export class ChatGptRuntimeRegistry {
  private readonly runtimes = new Map<string, ChatGptThreadRuntime>();
  /** Threads with a turn in flight, in the order their turns began. */
  private readonly activeTurns = new Map<string, string>();

  register(runtime: ChatGptThreadRuntime): void {
    this.runtimes.set(runtime.threadId, runtime);
  }

  unregister(threadId: string): void {
    this.runtimes.delete(threadId);
    this.activeTurns.delete(threadId);
  }

  get(threadId: string): ChatGptThreadRuntime | undefined {
    return this.runtimes.get(threadId);
  }

  /**
   * Marks a turn active for one thread. Concurrent threads keep their own
   * turns; without a session tag a call only resolves while exactly one turn
   * is in flight, so attribution is never guessed.
   */
  beginTurn(threadId: string, turnId: string): { ok: true } | { ok: false; message: string } {
    if (!this.runtimes.has(threadId)) {
      return {
        ok: false,
        message:
          "This Synara thread has no live ChatGPT (Web) session, so no turn can be attributed to it.",
      };
    }
    // Re-inserting on re-begin keeps map order aligned with recency.
    this.activeTurns.delete(threadId);
    this.activeTurns.set(threadId, turnId);
    return { ok: true };
  }

  endTurn(threadId: string): void {
    this.activeTurns.delete(threadId);
  }

  isTurnActive(threadId: string): boolean {
    return this.activeTurns.has(threadId);
  }

  resolveCallContext(sessionTag?: string): ConnectorCallResolution {
    const tag = sessionTag?.trim();
    if (tag !== undefined && tag.length > 0) {
      for (const runtime of this.runtimes.values()) {
        if (sessionTagForThread(runtime.threadId) !== tag) continue;
        const turnId = this.activeTurns.get(runtime.threadId);
        return turnId === undefined
          ? {
              ok: false,
              message: `This Synara session (${tag}) has no ChatGPT (Web) turn in flight right now.`,
            }
          : { ok: true, context: this.contextFor(runtime, turnId) };
      }
      return {
        ok: false,
        message: `Unknown synara_session tag "${tag}". Use the tag named in this conversation's Synara preamble.`,
      };
    }
    if (this.activeTurns.size === 0) {
      return { ok: false, message: NO_ACTIVE_TURN_MESSAGE };
    }
    if (this.activeTurns.size > 1) {
      return { ok: false, message: MULTIPLE_ACTIVE_TURNS_MESSAGE };
    }
    const [threadId, turnId] = [...this.activeTurns.entries()][0]!;
    const runtime = this.runtimes.get(threadId);
    if (!runtime) {
      return { ok: false, message: NO_ACTIVE_TURN_MESSAGE };
    }
    return { ok: true, context: this.contextFor(runtime, turnId) };
  }

  private contextFor(runtime: ChatGptThreadRuntime, turnId: string): ConnectorCallContext {
    return {
      threadId: runtime.threadId,
      turnId,
      workspaceRoot: runtime.workspaceRoot,
      agents: runtime.agents,
      exec: runtime.exec,
    };
  }

  snapshot(): ChatGptRuntimeSnapshot {
    const active = [...this.activeTurns.entries()];
    const newest = active.length > 0 ? active[active.length - 1]! : null;
    return {
      activeThreadId: newest?.[0] ?? null,
      activeTurnId: newest?.[1] ?? null,
      activeThreadIds: active.map(([threadId]) => threadId),
      registeredThreadIds: [...this.runtimes.keys()],
    };
  }
}
