// FILE: mcpProtocol.ts
// Purpose: Stateless MCP (streamable HTTP) handling for the ChatGPT connector:
//          initialize, ping, tools/list and tools/call with per-call identity.
// Layer: Server provider connector
//
// ChatGPT's connector POSTs JSON-RPC (single or batch) and accepts one JSON
// response per request; no session state is kept server-side. Identity is not
// carried by the transport, so every tools/call asks the runtime registry to
// attribute the call before a handler runs and fails closed otherwise.

import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  MCP_DEFAULT_PROTOCOL_VERSION,
  jsonRpcError,
  jsonRpcResult,
  mcpToolResultError,
  negotiateMcpProtocolVersion,
  parseMcpMessage,
} from "../../agentGateway/protocol.ts";
import type { ConnectorCallResolution } from "./runtime.ts";
import type { ChatGptConnectorTool } from "./tools/index.ts";

export const CHATGPT_CONNECTOR_SERVER_NAME = "synara-chatgpt-workspace";
export const CHATGPT_CONNECTOR_SERVER_TITLE = "Synara Workspace";
export const CHATGPT_CONNECTOR_INSTRUCTIONS_MAX_BYTES = 8 * 1024;

export interface ChatGptMcpHandleInput {
  readonly body: unknown;
  readonly tools: ReadonlyArray<ChatGptConnectorTool>;
  /** Attributes the call to exactly one Synara thread, or refuses. */
  readonly resolveContext: (sessionTag?: string) => ConnectorCallResolution;
  readonly serverVersion: string;
  readonly instructions: string;
  readonly onToolCall?: (toolName: string, outcome: "ok" | "error") => void;
  /**
   * Appends pending prime messages (worker reports) to a successful tool
   * result, mirroring the reference implementation's inbox handoff.
   */
  readonly augmentToolResult?: (
    context: NonNullable<Extract<ConnectorCallResolution, { ok: true }>["context"]>,
    result: import("../../agentGateway/protocol.ts").McpToolCallResult,
  ) => import("../../agentGateway/protocol.ts").McpToolCallResult;
}

export interface ChatGptMcpHandleOutput {
  readonly status: number;
  readonly body?: unknown;
}

function buildInitializeResult(input: {
  readonly requestedProtocolVersion: unknown;
  readonly serverVersion: string;
  readonly instructions: string;
}): Record<string, unknown> {
  return {
    protocolVersion: negotiateMcpProtocolVersion(input.requestedProtocolVersion),
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: CHATGPT_CONNECTOR_SERVER_NAME,
      title: CHATGPT_CONNECTOR_SERVER_TITLE,
      version: input.serverVersion,
    },
    instructions: input.instructions.slice(0, CHATGPT_CONNECTOR_INSTRUCTIONS_MAX_BYTES),
  };
}

function toolListResult(tools: ReadonlyArray<ChatGptConnectorTool>): Record<string, unknown> {
  return {
    tools: tools.map((tool) => ({ ...tool.definition })),
  };
}

function asArgumentsRecord(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/** The conversations's attribution tag, when the model echoed it back. */
function sessionTagFrom(args: unknown): string | undefined {
  const value = asArgumentsRecord(args)["synara_session"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Tool arguments without the attribution tag: it is transport plumbing. */
function toolArguments(args: unknown): Record<string, unknown> {
  const record = { ...asArgumentsRecord(args) };
  delete record["synara_session"];
  return record;
}

async function handleSingleMessage(
  raw: unknown,
  input: ChatGptMcpHandleInput,
): Promise<{ readonly reply: Record<string, unknown> | null }> {
  const parsed = parseMcpMessage(raw);
  switch (parsed.kind) {
    case "response":
      return { reply: null };
    case "invalid":
      return {
        reply: jsonRpcError(
          parsed.id ?? null,
          JSON_RPC_INVALID_PARAMS,
          "Invalid JSON-RPC request.",
        ),
      };
    case "notification":
      // notifications/initialized, notifications/cancelled: nothing to answer.
      return { reply: null };
    case "request": {
      const { id, method, params } = parsed.request;
      if (method === "initialize") {
        return {
          reply: jsonRpcResult(
            id,
            buildInitializeResult({
              requestedProtocolVersion: params.protocolVersion ?? MCP_DEFAULT_PROTOCOL_VERSION,
              serverVersion: input.serverVersion,
              instructions: input.instructions,
            }),
          ),
        };
      }
      if (method === "ping") {
        return { reply: jsonRpcResult(id, {}) };
      }
      if (method === "tools/list") {
        return { reply: jsonRpcResult(id, toolListResult(input.tools)) };
      }
      if (method === "tools/call") {
        const name = typeof params.name === "string" ? params.name : null;
        if (name === null) {
          return {
            reply: jsonRpcError(id, JSON_RPC_INVALID_PARAMS, "tools/call requires a tool name."),
          };
        }
        const tool = input.tools.find((candidate) => candidate.definition.name === name);
        if (!tool) {
          input.onToolCall?.(name, "error");
          return { reply: jsonRpcResult(id, mcpToolResultError(`Unknown tool "${name}".`)) };
        }
        const resolution = input.resolveContext(sessionTagFrom(params.arguments));
        if (!resolution.ok) {
          input.onToolCall?.(name, "error");
          return { reply: jsonRpcResult(id, mcpToolResultError(resolution.message)) };
        }
        try {
          const result = await tool.handler(resolution.context, toolArguments(params.arguments));
          input.onToolCall?.(name, result.isError === true ? "error" : "ok");
          const augmented =
            result.isError === true
              ? result
              : (input.augmentToolResult?.(resolution.context, result) ?? result);
          return { reply: jsonRpcResult(id, augmented) };
        } catch (error) {
          input.onToolCall?.(name, "error");
          const message = error instanceof Error ? error.message : String(error);
          return {
            reply: jsonRpcResult(id, mcpToolResultError(`Tool "${name}" failed: ${message}`)),
          };
        }
      }
      return {
        reply: jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown method "${method}".`),
      };
    }
  }
}

/**
 * Handles one connector POST. Batches are processed sequentially and answered
 * with an array only when any entry produced a reply; a full batch of
 * notifications is acknowledged with 202 and no body.
 */
export async function handleChatGptMcpPost(
  input: ChatGptMcpHandleInput,
): Promise<ChatGptMcpHandleOutput> {
  const messages = Array.isArray(input.body) ? input.body : [input.body];
  const replies: Array<Record<string, unknown> | null> = [];
  for (const message of messages) {
    const { reply } = await handleSingleMessage(message, input);
    replies.push(reply);
  }
  const nonNull = replies.filter((reply): reply is Record<string, unknown> => reply !== null);
  if (nonNull.length === 0) {
    return { status: 202 };
  }
  if (!Array.isArray(input.body) && nonNull.length === 1) {
    return { status: 200, body: nonNull[0] };
  }
  return { status: 200, body: nonNull };
}
