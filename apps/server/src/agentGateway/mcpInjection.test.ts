import { assert, describe, it } from "@effect/vitest";

import {
  buildAntigravityMcpPluginConfig,
  buildAcpSynaraMcpServers,
  buildClaudeMcpServers,
  buildCodexMcpConfigOverrides,
  buildOpenCodeMcpServer,
  callAgentGatewayMcpTool,
  listAgentGatewayMcpTools,
  SYNARA_AGENT_GATEWAY_TOKEN_ENV,
} from "./mcpInjection.ts";

const connection = {
  url: "http://127.0.0.1:3773/mcp",
  bearerToken: "sagw_abc.def",
};

const stdioProxy = {
  command: "/usr/local/bin/node",
  args: ["/state/agent-gateway-mcp-proxy.mjs"],
};

describe("agent gateway MCP injection", () => {
  it("builds a secret-free Antigravity stdio plugin config", () => {
    assert.deepEqual(buildAntigravityMcpPluginConfig(stdioProxy), {
      mcpServers: {
        synara: {
          command: stdioProxy.command,
          args: stdioProxy.args,
          env: {
            SYNARA_AGENT_GATEWAY_URL: "$SYNARA_AGENT_GATEWAY_URL",
            SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "$SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN",
            ELECTRON_RUN_AS_NODE: "1",
          },
          disabled: false,
          disabledTools: [],
        },
      },
    });
  });

  it("passes the gateway by environment reference and masks it in shell children", () => {
    const overrides = buildCodexMcpConfigOverrides(connection.url, "synara_test");
    assert.include(overrides[0]!, "mcp_servers.synara_test=");
    assert.include(overrides[0]!, `url="${connection.url}"`);
    assert.include(overrides[0]!, `bearer_token_env_var="${SYNARA_AGENT_GATEWAY_TOKEN_ENV}"`);
    assert.notInclude(overrides.join("\n"), connection.bearerToken);
    assert.equal(overrides[1], `shell_environment_policy.set.${SYNARA_AGENT_GATEWAY_TOKEN_ENV}=""`);
    assert.throws(() => buildCodexMcpConfigOverrides(connection.url, "unsafe.name"));
  });

  it("builds a claude http server entry with the bearer header", () => {
    const servers = buildClaudeMcpServers(connection);
    assert.deepEqual(servers, {
      synara: {
        type: "http",
        url: connection.url,
        headers: { Authorization: `Bearer ${connection.bearerToken}` },
      },
    });
  });

  it("builds an authenticated OpenCode remote MCP config with OAuth disabled", () => {
    assert.deepEqual(buildOpenCodeMcpServer(connection), {
      type: "remote",
      url: connection.url,
      enabled: true,
      headers: { Authorization: `Bearer ${connection.bearerToken}` },
      oauth: false,
    });
  });

  it("loads and invokes the canonical gateway catalog for native-tool providers", async () => {
    const requests: Array<{ readonly authorization: string | null; readonly body: unknown }> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body));
      requests.push({
        authorization: new Headers(init?.headers).get("Authorization"),
        body,
      });
      const request = body as { readonly id: string; readonly method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "synara_list_threads",
                    description: "List Synara threads.",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : { content: [{ type: "text", text: "ok" }] },
      });
    };

    assert.deepEqual(await listAgentGatewayMcpTools({ connection, fetch }), [
      {
        name: "synara_list_threads",
        description: "List Synara threads.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    assert.deepEqual(
      await callAgentGatewayMcpTool({
        connection,
        name: "synara_list_threads",
        arguments: { limit: 2 },
        fetch,
      }),
      { content: [{ type: "text", text: "ok" }] },
    );
    assert.deepEqual(
      requests.map((request) => request.authorization),
      [`Bearer ${connection.bearerToken}`, `Bearer ${connection.bearerToken}`],
    );
    assert.deepEqual((requests[1]?.body as { readonly params: unknown }).params, {
      name: "synara_list_threads",
      arguments: { limit: 2 },
    });
  });

  it("uses the ACP http transport when the agent advertises support", () => {
    const servers = buildAcpSynaraMcpServers({
      connection,
      initializeResult: { agentCapabilities: { mcpCapabilities: { http: true } } },
      stdioProxy,
    });
    assert.deepEqual(servers, [
      {
        type: "http",
        name: "synara",
        url: connection.url,
        headers: [{ name: "Authorization", value: `Bearer ${connection.bearerToken}` }],
      },
    ]);
  });

  it("falls back to the stdio proxy when http is not advertised", () => {
    const servers = buildAcpSynaraMcpServers({
      connection,
      initializeResult: {},
      stdioProxy,
    });
    assert.deepEqual(servers, [
      {
        name: "synara",
        command: stdioProxy.command,
        args: stdioProxy.args,
        env: [
          { name: "SYNARA_AGENT_GATEWAY_URL", value: connection.url },
          { name: SYNARA_AGENT_GATEWAY_TOKEN_ENV, value: connection.bearerToken },
        ],
      },
    ]);
  });
});
