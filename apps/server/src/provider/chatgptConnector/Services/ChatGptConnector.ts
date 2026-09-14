// FILE: Services/ChatGptConnector.ts
// Purpose: Service contract for the ChatGPT connector: the authenticated MCP
//          endpoint ChatGPT talks to, its secret, and its tunnel.
// Layer: Server provider connector

import { Data, ServiceMap, type Effect } from "effect";

import type { ChatGptMcpHandleOutput } from "../mcpProtocol.ts";
import type { ChatGptRuntimeRegistry } from "../runtime.ts";
import type { ChatGptTunnelStatus } from "../tunnel.ts";

export class ChatGptConnectorError extends Data.TaggedError("ChatGptConnectorError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface ChatGptConnectorInfo {
  /** Loopback connector URL including the secret path. */
  readonly localUrl: string;
  /** Public tunnel URL including the secret path, when a tunnel is connected. */
  readonly publicUrl: string | null;
  /** The URL the user should configure in ChatGPT (public when available). */
  readonly connectorUrl: string;
  readonly tunnelState: ChatGptTunnelStatus["state"];
  readonly tunnelMessage: string | null;
  readonly secretCreatedAt: string;
  readonly activeThreadId: string | null;
  readonly registeredThreadIds: ReadonlyArray<string>;
  readonly toolCallCount: number;
  readonly lastToolCallAt: string | null;
}

export interface ChatGptConnectorShape {
  readonly getInfo: Effect.Effect<ChatGptConnectorInfo, ChatGptConnectorError>;
  /** Rotates the path secret and rebinds the tunnel; old URLs stop working. */
  readonly rotateSecret: Effect.Effect<ChatGptConnectorInfo, ChatGptConnectorError>;
  /** Re-runs the tunnel with the current settings. */
  readonly restartTunnel: Effect.Effect<ChatGptConnectorInfo, ChatGptConnectorError>;
  /**
   * Handles one POST from ChatGPT. `token` comes from the URL path; a mismatch
   * answers 404 so the endpoint does not confirm which secrets exist.
   */
  readonly handlePost: (input: {
    readonly token: string;
    readonly body: unknown;
  }) => Effect.Effect<ChatGptMcpHandleOutput, ChatGptConnectorError>;
  /** Live runtimes keyed by thread; the provider adapter registers here. */
  readonly registry: ChatGptRuntimeRegistry;
}

export class ChatGptConnector extends ServiceMap.Service<ChatGptConnector, ChatGptConnectorShape>()(
  "synara/provider/chatgptConnector/Services/ChatGptConnector",
) {}
