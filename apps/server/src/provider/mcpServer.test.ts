import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildClaudeMcpServerConfig,
  buildCodexMcpServerConfig,
  parseClaudeMcpServerStatus,
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

describe("Claude MCP server normalization", () => {
  it("maps SDK status, auth, tools, and errors", () => {
    expect(
      parseClaudeMcpServerStatus({
        name: "github",
        status: "needs-auth",
        error: "login required",
        tools: [{ name: "search" }, { name: "add" }, {}],
      }),
    ).toEqual({
      name: "github",
      runtimeStatus: "authenticationRequired",
      authStatus: "notLoggedIn",
      pluginId: null,
      toolNames: ["add", "search"],
      resourceCount: 0,
      resourceTemplateCount: 0,
      toolsError: "login required",
    });
    expect(parseClaudeMcpServerStatus({ name: " " })).toBeNull();
  });

  it("builds stdio and bearer HTTP configs without accepting unsupported fields", () => {
    const base = { provider: "claudeAgent" as const, threadId: THREAD_ID, name: "tool" };
    expect(
      buildClaudeMcpServerConfig({ ...base, transport: "stdio", command: "npx", args: ["x"] }),
    ).toEqual({ type: "stdio", command: "npx", args: ["x"] });
    expect(() =>
      buildClaudeMcpServerConfig({ ...base, transport: "stdio", command: "npx", cwd: "/tmp" }),
    ).toThrow("working directory");
    expect(
      buildClaudeMcpServerConfig(
        { ...base, transport: "streamable-http", url: "https://x", bearerTokenEnvVar: "TOKEN" },
        { TOKEN: "secret" },
      ),
    ).toEqual({ type: "http", url: "https://x", headers: { Authorization: "Bearer secret" } });
    expect(() =>
      buildClaudeMcpServerConfig(
        { ...base, transport: "streamable-http", url: "https://x", bearerTokenEnvVar: "MISSING" },
        {},
      ),
    ).toThrow("MISSING");
  });
});
