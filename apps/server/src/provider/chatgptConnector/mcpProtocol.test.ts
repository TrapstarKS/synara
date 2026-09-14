// FILE: mcpProtocol.test.ts
// Purpose: Unit tests for stateless MCP request handling in the ChatGPT
//          connector: initialization, tool discovery/calls, augmentation,
//          batch and invalid-message behavior.
// Layer: Server provider connector tests

import { describe, expect, it, vi } from "vitest";

import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  MCP_DEFAULT_PROTOCOL_VERSION,
  type McpToolCallResult,
} from "../../agentGateway/protocol.ts";
import {
  CHATGPT_CONNECTOR_INSTRUCTIONS_MAX_BYTES,
  handleChatGptMcpPost,
  type ChatGptMcpHandleInput,
  type ChatGptMcpHandleOutput,
} from "./mcpProtocol.ts";
import type { ConnectorCallContext, ConnectorCallResolution } from "./runtime.ts";
import { createChatGptConnectorTools, type ChatGptConnectorTool } from "./tools/index.ts";

interface JsonRpcReply {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const SERVER_VERSION = "9.9.9-test";
const INSTRUCTIONS = "Use the Synara workspace tools deliberately.";

const CALL_CONTEXT = {
  threadId: "thread-1",
  turnId: "turn-1",
  workspaceRoot: "/tmp/synara-workspace",
} as unknown as ConnectorCallContext;

const echoTool: ChatGptConnectorTool = {
  definition: {
    name: "echo",
    description: "Echo the received arguments.",
    inputSchema: { type: "object", additionalProperties: true },
  },
  handler: async (_context, args) => ({
    content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }],
  }),
};

const boomTool: ChatGptConnectorTool = {
  definition: {
    name: "boom",
    description: "Always throws.",
    inputSchema: { type: "object" },
  },
  handler: async () => {
    throw new Error("kaboom");
  },
};

const failTool: ChatGptConnectorTool = {
  definition: {
    name: "fail",
    description: "Returns a tool-level error result.",
    inputSchema: { type: "object" },
  },
  handler: async () => ({ content: [{ type: "text", text: "tool-level failure" }], isError: true }),
};

const TOOLS: ReadonlyArray<ChatGptConnectorTool> = [echoTool, boomTool, failTool];

function makeInput(
  body: unknown,
  overrides: Partial<Omit<ChatGptMcpHandleInput, "body">> = {},
): ChatGptMcpHandleInput {
  return {
    body,
    tools: overrides.tools ?? TOOLS,
    resolveContext:
      overrides.resolveContext ??
      ((): ConnectorCallResolution => ({ ok: true, context: CALL_CONTEXT })),
    serverVersion: overrides.serverVersion ?? SERVER_VERSION,
    instructions: overrides.instructions ?? INSTRUCTIONS,
    ...(overrides.onToolCall ? { onToolCall: overrides.onToolCall } : {}),
    ...(overrides.augmentToolResult ? { augmentToolResult: overrides.augmentToolResult } : {}),
  };
}

async function post(
  body: unknown,
  overrides: Partial<Omit<ChatGptMcpHandleInput, "body">> = {},
): Promise<ChatGptMcpHandleOutput> {
  return handleChatGptMcpPost(makeInput(body, overrides));
}

function replyAt(value: unknown, index = 0): JsonRpcReply {
  const replies = Array.isArray(value) ? value : [value];
  return replies[index] as JsonRpcReply;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  return value as Record<string, unknown>;
}

function toolResult(reply: JsonRpcReply): McpToolCallResult {
  return record(reply.result) as unknown as McpToolCallResult;
}

function textOf(result: McpToolCallResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function initializeBody(protocolVersion?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: protocolVersion === undefined ? {} : { protocolVersion },
  };
}

function callBody(name: unknown, args?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, ...(args === undefined ? {} : { arguments: args }) },
  };
}

describe("initialize", () => {
  it("negotiates supported protocol versions and falls back for unknown ones", async () => {
    const supported = await post(initializeBody("2025-03-26"));
    const supportedResult = record(replyAt(supported.body).result);
    expect(supportedResult.protocolVersion).toBe("2025-03-26");

    const unknown = await post(initializeBody("1999-01-01"));
    const unknownResult = record(replyAt(unknown.body).result);
    expect(unknownResult.protocolVersion).toBe(MCP_DEFAULT_PROTOCOL_VERSION);

    const missing = await post(initializeBody());
    const missingResult = record(replyAt(missing.body).result);
    expect(missingResult.protocolVersion).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
  });

  it("reports the connector identity, capabilities and instructions", async () => {
    const output = await post(initializeBody("2025-06-18"));
    expect(output.status).toBe(200);
    const result = record(replyAt(output.body).result);

    expect(result.serverInfo).toEqual({
      name: "synara-chatgpt-workspace",
      title: "Synara Workspace",
      version: SERVER_VERSION,
    });
    expect(result.instructions).toBe(INSTRUCTIONS);
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it("caps instructions at the connector maximum", async () => {
    const long = "x".repeat(CHATGPT_CONNECTOR_INSTRUCTIONS_MAX_BYTES + 100);
    const output = await post(initializeBody("2025-06-18"), { instructions: long });
    const result = record(replyAt(output.body).result);

    expect(result.instructions).toHaveLength(CHATGPT_CONNECTOR_INSTRUCTIONS_MAX_BYTES);
  });
});

describe("tools/list", () => {
  it("returns the provided tool definitions", async () => {
    const output = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(output.status).toBe(200);
    const result = record(replyAt(output.body).result);

    expect(result.tools).toEqual([echoTool.definition, boomTool.definition, failTool.definition]);
  });
});

describe("tools/call", () => {
  it("runs a tool and reports the handler result as ok", async () => {
    const onToolCall = vi.fn();
    const output = await post(callBody("echo", { hello: "world" }), { onToolCall });
    expect(output.status).toBe(200);
    const result = toolResult(replyAt(output.body));

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('"hello":"world"');
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith("echo", "ok");
  });

  it("answers an unknown tool as an isError result, not a JSON-RPC error", async () => {
    const onToolCall = vi.fn();
    const output = await post(callBody("nope"), { onToolCall });
    const reply = replyAt(output.body);

    expect(reply.error).toBeUndefined();
    expect(reply.result).toBeDefined();
    const result = toolResult(reply);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown tool "nope"');
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith("nope", "error");
  });

  it("refuses a call whose context cannot be attributed", async () => {
    const handler = vi.fn(
      async (): Promise<McpToolCallResult> => ({ content: [{ type: "text", text: "ran" }] }),
    );
    const tool: ChatGptConnectorTool = { definition: echoTool.definition, handler };
    const onToolCall = vi.fn();
    const output = await post(callBody("echo", {}), {
      tools: [tool],
      resolveContext: () => ({ ok: false, message: "No active ChatGPT turn." }),
      onToolCall,
    });
    const result = toolResult(replyAt(output.body));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No active ChatGPT turn.");
    expect(handler).not.toHaveBeenCalled();
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith("echo", "error");
  });

  it("maps a thrown handler failure to an isError result", async () => {
    const onToolCall = vi.fn();
    const output = await post(callBody("boom"), { onToolCall });
    const result = toolResult(replyAt(output.body));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Tool "boom" failed: kaboom');
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith("boom", "error");
  });

  it("applies augmentToolResult only to successful results", async () => {
    const augmentToolResult = vi.fn(
      (_context: ConnectorCallContext, result: McpToolCallResult): McpToolCallResult => ({
        ...result,
        content: [...result.content, { type: "text", text: "[inbox] worker report" }],
      }),
    );

    const success = await post(callBody("echo", { a: 1 }), { augmentToolResult });
    const successResult = toolResult(replyAt(success.body));
    expect(successResult.content).toHaveLength(2);
    expect(textOf(successResult)).toContain("[inbox] worker report");
    expect(augmentToolResult).toHaveBeenCalledTimes(1);

    const failure = await post(callBody("fail"), { augmentToolResult });
    expect(toolResult(replyAt(failure.body)).isError).toBe(true);
    expect(augmentToolResult).toHaveBeenCalledTimes(1);

    const thrown = await post(callBody("boom"), { augmentToolResult });
    expect(toolResult(replyAt(thrown.body)).isError).toBe(true);
    expect(augmentToolResult).toHaveBeenCalledTimes(1);
  });

  it("rejects tools/call without a tool name", async () => {
    const output = await post({ jsonrpc: "2.0", id: 12, method: "tools/call", params: {} });
    const reply = replyAt(output.body);

    expect(reply.error).toEqual({
      code: JSON_RPC_INVALID_PARAMS,
      message: "tools/call requires a tool name.",
    });
  });
});

describe("batch and invalid messages", () => {
  it("answers a one-request one-notification batch with a single-element array", async () => {
    const onToolCall = vi.fn();
    const output = await post(
      [{ jsonrpc: "2.0", method: "notifications/initialized" }, callBody("echo", { batch: true })],
      { onToolCall },
    );

    expect(output.status).toBe(200);
    expect(Array.isArray(output.body)).toBe(true);
    const replies = output.body as ReadonlyArray<JsonRpcReply>;
    expect(replies).toHaveLength(1);
    expect(replies[0]?.id).toBe(7);
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith("echo", "ok");
  });

  it("acknowledges a batch of only notifications with 202 and no body", async () => {
    const output = await post([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    ]);

    expect(output).toEqual({ status: 202 });
  });

  it("acknowledges a full notification body with 202", async () => {
    const output = await post({ jsonrpc: "2.0", method: "notifications/initialized" });

    expect(output).toEqual({ status: 202 });
  });

  it("answers an unknown method with a JSON-RPC method-not-found error", async () => {
    const output = await post({ jsonrpc: "2.0", id: 11, method: "resources/list" });
    const reply = replyAt(output.body);

    expect(reply.id).toBe(11);
    expect(reply.result).toBeUndefined();
    expect(reply.error).toEqual({
      code: JSON_RPC_METHOD_NOT_FOUND,
      message: 'Unknown method "resources/list".',
    });
  });

  it("answers malformed entries with invalid-params errors", async () => {
    const single = await post("nope");
    const singleReply = replyAt(single.body);
    expect(singleReply.error).toEqual({
      code: JSON_RPC_INVALID_PARAMS,
      message: "Invalid JSON-RPC request.",
    });
    expect(singleReply.id).toBeNull();

    const batch = await post([
      { jsonrpc: "1.0", id: 4, method: "ping" },
      { jsonrpc: "2.0", id: 5, method: "ping" },
    ]);
    const replies = batch.body as ReadonlyArray<JsonRpcReply>;
    expect(replies).toHaveLength(2);
    expect(replies[0]?.id).toBe(4);
    expect(replies[0]?.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
    expect(replies[1]?.result).toEqual({});
  });
});

describe("createChatGptConnectorTools", () => {
  it("exposes the five connector tools in stable order", () => {
    const names = createChatGptConnectorTools().map((tool) => tool.definition.name);

    expect(names).toEqual(["read", "apply_patch", "exec_command", "write_stdin", "agents"]);
  });
});
