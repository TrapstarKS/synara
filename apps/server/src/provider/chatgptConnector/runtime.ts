// FILE: runtime.ts
// Purpose: Holds the live ChatGPT web runtimes (one per Synara thread) and
//          attributes incoming connector calls to the right thread.
// Layer: Server provider connector
//
// ChatGPT's MCP connector sends no conversation identity on the wire, so
// attribution is runtime-based: a thread registers exactly one durable
// session route while its session is alive. A call is attributed to its
// temporary turn watcher when possible;
// with exactly one live runtime, calls remain attributable between turns too.
// Several threads may run turns at the same time; a call then has to name its
// conversation's `synara_session` tag (named in the conversation preamble and
// restated on later turns) or it is refused instead of guessed, matching the
// reference implementation's fail-closed identity discipline. A tag that
// names a live session stays attributable after its turn settles, so long or
// resumed conversations can keep working between turns. When only one runtime
// is registered, the same recovery is also safe for an untagged call.

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
  "No ChatGPT (Web) turn is active in Synara, so this tool call cannot be attributed to a workspace. Include the synara_session tag from the most recent Synara message, or start or continue the turn in Synara and retry.";

const MULTIPLE_ACTIVE_TURNS_MESSAGE =
  "Several ChatGPT (Web) turns are active at once, so this call cannot be attributed to one conversation. Repeat the call including the synara_session tag from the most recent Synara message in this conversation.";

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
  /** Temporary watchers with a turn in flight, in the order they began. */
  private readonly activeTurns = new Map<string, string>();
  /** The most recent watcher/turn id, kept on the durable session route. */
  private readonly lastTurns = new Map<string, string>();

  register(runtime: ChatGptThreadRuntime): void {
    this.runtimes.set(runtime.threadId, runtime);
  }

  unregister(threadId: string): void {
    this.runtimes.delete(threadId);
    this.activeTurns.delete(threadId);
    this.lastTurns.delete(threadId);
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
    this.lastTurns.set(threadId, turnId);
    return { ok: true };
  }

  endTurn(threadId: string): void {
    // Retire only the temporary watcher. Do not remove the session route: a
    // delayed tool call may arrive after the watcher failed, and its durable
    // synara_session tag still identifies the same conversation.
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
        // A live session keeps its thread attributable after its turn settles:
        // long or resumed conversations keep working between turns, and the
        // thread's most recent turn is the truthful owner of new tool calls.
        const turnId =
          this.activeTurns.get(runtime.threadId) ??
          this.lastTurns.get(runtime.threadId) ??
          "connector";
        return { ok: true, context: this.contextFor(runtime, turnId) };
      }
      return {
        ok: false,
        message: `Unknown synara_session tag "${tag}". Use the tag named in the most recent Synara message in this conversation.`,
      };
    }
    if (this.activeTurns.size === 0) {
      // ChatGPT's connector transport does not carry conversation identity.
      // Do not reject a delayed/untagged call when there is only one possible
      // live Synara session: this is the common case after the provider has
      // already settled its turn but ChatGPT is still finishing connector
      // work. Multiple runtimes remain fail-closed to avoid cross-workspace
      // tool execution.
      if (this.runtimes.size === 1) {
        const runtime = this.runtimes.values().next().value;
        if (runtime !== undefined) {
          const turnId = this.lastTurns.get(runtime.threadId) ?? "connector";
          return { ok: true, context: this.contextFor(runtime, turnId) };
        }
      }
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
