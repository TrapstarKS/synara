import { ThreadId, type ProviderAddMcpServerInput } from "@synara/contracts";
import { Effect } from "effect";

import type { ProviderServiceError } from "../provider/Errors.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import {
  ToolInputError,
  errorText,
  readRecordArg,
  readStringArg,
  readStringArrayArg,
} from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

const MCP_PROVIDER = "codex" as const;

function currentSessionInput(context: ToolContext): {
  readonly provider: typeof MCP_PROVIDER;
  readonly threadId: ThreadId;
} {
  return {
    provider: MCP_PROVIDER,
    threadId: ThreadId.makeUnsafe(context.callerThreadId) as ThreadId,
  };
}

function assertCodexSession(context: ToolContext): void {
  if (context.callerProvider !== MCP_PROVIDER) {
    throw new ToolInputError("MCP runtime management is currently available for Codex sessions only.");
  }
}

function readEnvironment(args: Record<string, unknown>): Record<string, string> | undefined {
  const raw = readRecordArg(args, "env");
  if (!raw) return undefined;
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => {
      if (typeof value !== "string") {
        throw new ToolInputError(`Environment value "${key}" must be a string.`);
      }
      return [key, value];
    }),
  );
}

function serviceErrorResult(error: unknown) {
  return Effect.succeed(mcpToolResultError(errorText(error)));
}

function withMcpErrorHandling<A>(effect: Effect.Effect<A, ProviderServiceError | ToolInputError>) {
  return effect.pipe(Effect.catch((error) => serviceErrorResult(error)));
}

export function makeAgentGatewayMcpTools(input: {
  readonly providerService: ProviderServiceShape;
}): ReadonlyArray<ToolEntry> {
  const listMcpServers: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_mcp_list",
      description:
        "List the MCP servers configured for the current Codex session, including runtime/auth status, loaded tools, and resource counts.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List MCP servers", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (_args, context) =>
      withMcpErrorHandling(
        Effect.gen(function* () {
          assertCodexSession(context);
          const result = yield* input.providerService.listMcpServers(currentSessionInput(context));
          return mcpToolResultJson(result);
        }),
      ),
  };

  const reloadMcpServers: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_mcp_reload",
      description:
        "Reload every configured MCP server in the current Codex session and return fresh statuses. A newly added server becomes available to later turns after the reload.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Reload MCP servers", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (_args, context) =>
      withMcpErrorHandling(
        Effect.gen(function* () {
          assertCodexSession(context);
          const result = yield* input.providerService.reloadMcpServers(currentSessionInput(context));
          return mcpToolResultJson(result);
        }),
      ),
  };

  const connectMcpServer: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_mcp_connect",
      description:
        "Enable one configured MCP server in the current Codex session, reload the MCP runtime, and return fresh statuses.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { title: "Connect MCP server", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      withMcpErrorHandling(
        Effect.gen(function* () {
          assertCodexSession(context);
          const name = readStringArg(args, "name", { required: true })!;
          const result = yield* input.providerService.connectMcpServer({
            ...currentSessionInput(context),
            name,
          });
          return mcpToolResultJson(result);
        }),
      ),
  };

  const disconnectMcpServer: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_mcp_disconnect",
      description:
        "Disable one configured MCP server in the current Codex session, reload the MCP runtime, and return fresh statuses. Configuration is preserved for reconnecting later.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { title: "Disconnect MCP server", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      withMcpErrorHandling(
        Effect.gen(function* () {
          assertCodexSession(context);
          const name = readStringArg(args, "name", { required: true })!;
          const result = yield* input.providerService.disconnectMcpServer({
            ...currentSessionInput(context),
            name,
          });
          return mcpToolResultJson(result);
        }),
      ),
  };

  const addMcpServer: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_mcp_add",
      description:
        "Add or update a Codex MCP server and reload the runtime. Use transport 'stdio' with command/args/env/cwd, or 'streamable-http' with url and an optional bearer token environment variable. Secrets are accepted only as env values and are never returned.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          transport: { type: "string", enum: ["stdio", "streamable-http"] },
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          env: { type: "object", additionalProperties: { type: "string" } },
          cwd: { type: "string" },
          url: { type: "string" },
          bearerTokenEnvVar: { type: "string" },
        },
        required: ["name", "transport"],
        additionalProperties: false,
      },
      annotations: { title: "Add MCP server", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      withMcpErrorHandling(
        Effect.gen(function* () {
          assertCodexSession(context);
          const name = readStringArg(args, "name", { required: true })!;
          const transport = readStringArg(args, "transport", { required: true });
          if (transport !== "stdio" && transport !== "streamable-http") {
            throw new ToolInputError(`Argument "transport" must be "stdio" or "streamable-http".`);
          }
          const command = readStringArg(args, "command");
          const serverArgs = readStringArrayArg(args, "args");
          const env = readEnvironment(args);
          const cwd = readStringArg(args, "cwd");
          const url = readStringArg(args, "url");
          const bearerTokenEnvVar = readStringArg(args, "bearerTokenEnvVar");
          const addInput: ProviderAddMcpServerInput = {
            ...currentSessionInput(context),
            name,
            transport,
            ...(command ? { command } : {}),
            ...(serverArgs ? { args: serverArgs } : {}),
            ...(env ? { env } : {}),
            ...(cwd ? { cwd } : {}),
            ...(url ? { url } : {}),
            ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
          };
          const result = yield* input.providerService.addMcpServer(addInput);
          return mcpToolResultJson(result);
        }),
      ),
  };

  return [listMcpServers, reloadMcpServers, connectMcpServer, disconnectMcpServer, addMcpServer];
}
