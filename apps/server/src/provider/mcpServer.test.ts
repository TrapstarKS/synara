import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildCodexMcpServerConfig,
  parseCodexMcpServerListResponse,
  parseCodexMcpServerStatus,
  validateMcpServerName,
} from "./mcpServer.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread");

describe("Codex MCP server normalization", () => {
  it("normalizes runtime status, tools, and resource counts", () => {
    expect(
      parseCodexMcpServerStatus({
        name: " Roblox ",
        runtimeStatus: "connected",
        authStatus: "oAuth",
        pluginId: null,
        tools: { zeta: {}, alpha: {} },
        resources: [{}],
        resourceTemplates: [{}, {}],
        toolsError: null,
      }),
    ).toEqual({
      name: "Roblox",
      runtimeStatus: "connected",
      authStatus: "oAuth",
      pluginId: null,
      toolNames: ["alpha", "zeta"],
      resourceCount: 1,
      resourceTemplateCount: 2,
      toolsError: null,
    });
  });

  it("skips malformed entries and follows the native cursor", () => {
    expect(
      parseCodexMcpServerListResponse({
        data: [{ name: "one", runtimeStatus: "failed" }, { noName: true }],
        nextCursor: " next ",
      }),
    ).toEqual({
      servers: [
        {
          name: "one",
          runtimeStatus: "failed",
          authStatus: "unknown",
          pluginId: null,
          toolNames: [],
          resourceCount: 0,
          resourceTemplateCount: 0,
          toolsError: null,
        },
      ],
      nextCursor: "next",
    });
  });

  it("builds safe stdio and HTTP Codex config shapes", () => {
    expect(
      buildCodexMcpServerConfig({
        provider: "codex",
        threadId: THREAD_ID,
        name: "local-tools",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { API_KEY: "secret" },
        cwd: "/tmp/project",
      }),
    ).toEqual({
      command: "node",
      args: ["server.js"],
      env: { API_KEY: "secret" },
      cwd: "/tmp/project",
      enabled: true,
    });

    expect(
      buildCodexMcpServerConfig({
        provider: "codex",
        threadId: THREAD_ID,
        name: "remote-tools",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        bearerTokenEnvVar: "MCP_TOKEN",
      }),
    ).toEqual({
      url: "https://example.test/mcp",
      bearer_token_env_var: "MCP_TOKEN",
      enabled: true,
    });
  });

  it("rejects unsafe names and incomplete configs", () => {
    expect(() => validateMcpServerName("foo.bar")).toThrow(/letters/);
    expect(() => validateMcpServerName("synara")).toThrow(/built-in/);
    expect(() =>
      buildCodexMcpServerConfig({
        provider: "codex",
        threadId: THREAD_ID,
        name: "local",
        transport: "stdio",
      }),
    ).toThrow(/command/);
  });
});
