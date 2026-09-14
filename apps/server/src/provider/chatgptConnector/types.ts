// FILE: types.ts
// Purpose: Shared vocabulary for the ChatGPT (web) connector tool surface.
// Layer: Server provider connector
//
// The ChatGPT connector exposes local workspace tools to a ChatGPT web
// conversation through an MCP endpoint. Tool implementations stay plain
// Node/TypeScript so they can be unit tested without the Effect runtime; the
// MCP endpoint layer wraps them with `Effect.tryPromise` and maps results to
// `McpToolCallResult`.

import type { McpToolCallResult } from "../../agentGateway/protocol.ts";

/** Execution context every connector tool call receives. */
export interface WorkspaceToolContext {
  /**
   * Absolute, canonicalized workspace root for the Synara thread that owns the
   * call. Tool inputs resolve against this path; escapes are rejected. The
   * connector never executes against a workspace it was not attributed to.
   */
  readonly workspaceRoot: string;
  /** Aborted when the owning turn is interrupted or the server shuts down. */
  readonly signal?: AbortSignal;
}

export type { McpToolCallResult };
