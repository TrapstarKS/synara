// Opt-in native smoke: CI supplies a pinned official CLI; no model turn or login is performed.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { spawnProcess } from "@synara/shared/processRuntime";
import { resolveCodexExecutable } from "@synara/shared/codexExecutable";
import {
  JsonRpcStdioFramer,
  JsonRpcStdioRequestRegistry,
  JsonRpcStdioWriter,
  type JsonRpcResponse,
} from "@synara/shared/jsonrpc-stdio";
import { buildCodexProcessEnv } from "./codexProcessEnv";
import { buildCodexRuntimeConfig } from "./codexRuntimeConfig";
import { teardownChildProcessTree } from "./platform/supervisedProcessTeardown";

const binary = process.env.SYNARA_CODEX_SMOKE_BINARY;

it.skipIf(!binary)(
  "starts the official Codex CLI with a native home and process-local MCP configuration",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synara-official-codex-"));
    const configPath = path.join(root, "config.toml");
    const sourceConfig = [
      'cli_auth_credentials_store = "file"',
      "[mcp_servers.synara]",
      'command = "existing-user-bridge"',
      "enabled = false",
      "[shell_environment_policy]",
      'exclude = ["PRIVATE_*"]',
      "[shell_environment_policy.set]",
      'KEEP_USER_VALUE = "kept"',
      '[plugins."browser@openai-bundled"]',
      "enabled = true",
      "",
    ].join("\n");
    await writeFile(configPath, sourceConfig);
    const token = "synara-native-smoke-fixture-token";
    const mcpMethods: string[] = [];
    const server = http.createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const message = JSON.parse(body) as {
        id?: number | string;
        method: string;
        params?: { protocolVersion?: string };
      };
      mcpMethods.push(message.method);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "synara-smoke", version: "1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "smoke_read",
                    description: "Read-only smoke fixture",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : {};
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing smoke MCP address");
    const endpointUrl = `http://127.0.0.1:${address.port}/mcp`;
    let child: ChildProcessWithoutNullStreams | undefined;
    const requests = new JsonRpcStdioRequestRegistry({ requestTimeoutMs: 20_000 });
    let writer: JsonRpcStdioWriter | undefined;
    const framer = new JsonRpcStdioFramer();
    let stderr = "";
    try {
      const env = await buildCodexProcessEnv({
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          TEMP: root,
          TMP: root,
        },
        homePath: root,
      });
      expect(env.CODEX_HOME).toBe(root);
      expect(env.CODEX_SQLITE_HOME).toBe(root);
      const runtime = await buildCodexRuntimeConfig({ homePath: root, endpointUrl });
      const executable = resolveCodexExecutable(binary!, { env, cwd: root });
      expect(executable).not.toBeNull();
      child = spawnProcess(
        executable!,
        ["app-server", ...runtime.configOverrides.flatMap((value) => ["-c", value])],
        {
          requireExecutable: true,
          cwd: root,
          env: { ...env, SYNARA_AGENT_GATEWAY_TOKEN: token },
          stdio: ["pipe", "pipe", "pipe"],
        },
      ) as ChildProcessWithoutNullStreams;
      writer = new JsonRpcStdioWriter(child.stdin);
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-8_000);
      });
      child.on("error", (error) => requests.rejectAll(error));
      child.on("exit", () => requests.rejectAll(new Error(`Codex smoke exited: ${stderr}`)));
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          for (const line of framer.push(chunk)) {
            if (line) requests.handleResponse(JSON.parse(line) as JsonRpcResponse);
          }
        } catch (error) {
          requests.rejectAll(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const call = (method: string, params: unknown) =>
        requests.request(method, params, (message) => writer!.write(message));
      await call("initialize", {
        clientInfo: { name: "synara_runtime_smoke", version: "1" },
        capabilities: { experimentalApi: true },
      });
      await writer.write({ method: "initialized" });
      const result = (await call("config/read", { includeLayers: false })) as {
        config: Record<string, unknown>;
      };
      expect(result.config.mcp_servers).toMatchObject({
        synara: { command: "existing-user-bridge", enabled: false },
        [runtime.gatewayMcpServerName!]: {
          url: endpointUrl,
          bearer_token_env_var: "SYNARA_AGENT_GATEWAY_TOKEN",
        },
      });
      expect(
        (result.config.mcp_servers as Record<string, object>)[runtime.gatewayMcpServerName!],
      ).not.toHaveProperty("command");
      expect(result.config.plugins).toHaveProperty(["browser@openai-bundled", "enabled"], false);
      expect(result.config.shell_environment_policy).toMatchObject({
        exclude: ["PRIVATE_*"],
        set: { KEEP_USER_VALUE: "kept", SYNARA_AGENT_GATEWAY_TOKEN: "" },
      });
      await call("mcpServerStatus/list", { detail: "full", limit: 100 });
      expect(mcpMethods).toContain("initialize");
      expect(mcpMethods).toContain("tools/list");
      expect(await readFile(configPath, "utf8")).toBe(sourceConfig);
    } finally {
      requests.rejectAll(new Error("Codex smoke complete"));
      writer?.close();
      framer.close();
      try {
        if (child) await teardownChildProcessTree(child);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
