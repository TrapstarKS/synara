import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { makeAgentGatewayMcpTools } from "./mcpTools.ts";
import type { ToolContext } from "./toolRuntime.ts";

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "gateway-session:test",
    threadId: "thread-a",
    provider: "claudeAgent",
    turnId: "turn-a",
  },
  callerThreadId: "thread-a",
  callerThreadLabel: null,
  callerSessionKey: "gateway-session:test",
  callerProvider: "claudeAgent",
  callerCapabilities: new Set(["thread:read", "thread:write"]),
  callerTurnId: "turn-a",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};

describe("agent gateway MCP tools", () => {
  it.each(["claudeAgent", "codex"] as const)(
    "routes MCP management to the caller's %s session",
    async (callerProvider) => {
      const servers = { action: "connected" as const, servers: [] };
      const addMcpServer = vi.fn(() => Effect.succeed(servers));
      const tool = makeAgentGatewayMcpTools({
        providerService: { addMcpServer } as unknown as ProviderServiceShape,
      }).find((entry) => entry.definition.name === "synara_mcp_add")!;

      const result = await Effect.runPromise(
        tool.handler(
          { name: "docs", transport: "streamable-http", url: "https://example.test/mcp" },
          { ...context, callerProvider },
        ),
      );

      expect(result.isError).toBeFalsy();
      expect(addMcpServer).toHaveBeenCalledWith({
        provider: callerProvider,
        threadId: "thread-a",
        name: "docs",
        transport: "streamable-http",
        url: "https://example.test/mcp",
      });
    },
  );
});
