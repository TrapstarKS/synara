import type {
  ProviderAddMcpServerInput,
  ProviderMcpAuthStatus,
  ProviderMcpRuntimeStatus,
  ProviderMcpServerStatus,
} from "@synara/contracts";

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MCP_SERVER_PAGE_LIMIT = 100;
export const MAX_MCP_SERVER_STATUS_PAGES = 100;

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (record: UnknownRecord, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const readRecord = (record: UnknownRecord, key: string): UnknownRecord | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

const readArray = (record: UnknownRecord, key: string): ReadonlyArray<unknown> => {
  const value = record[key];
  return Array.isArray(value) ? value : [];
};

const RUNTIME_STATUSES = new Set<ProviderMcpRuntimeStatus>([
  "notStarted",
  "starting",
  "connected",
  "authenticationRequired",
  "failed",
  "cancelled",
  "disabled",
]);

const AUTH_STATUSES = new Set<ProviderMcpAuthStatus>([
  "unknown",
  "unsupported",
  "notLoggedIn",
  "bearerToken",
  "oAuth",
]);

const readRuntimeStatus = (record: UnknownRecord): ProviderMcpRuntimeStatus | null => {
  const value = record.runtimeStatus;
  return typeof value === "string" && RUNTIME_STATUSES.has(value as ProviderMcpRuntimeStatus)
    ? (value as ProviderMcpRuntimeStatus)
    : null;
};

const readAuthStatus = (record: UnknownRecord): ProviderMcpAuthStatus => {
  const value = record.authStatus;
  return typeof value === "string" && AUTH_STATUSES.has(value as ProviderMcpAuthStatus)
    ? (value as ProviderMcpAuthStatus)
    : "unknown";
};

export function parseCodexMcpServerStatus(value: unknown): ProviderMcpServerStatus | null {
  if (!isRecord(value)) return null;
  const name = readString(value, "name")?.trim();
  if (!name) return null;

  const tools = readRecord(value, "tools");
  const pluginId = readString(value, "pluginId")?.trim() || null;
  const toolsError = readString(value, "toolsError") ?? null;

  return {
    name,
    runtimeStatus: readRuntimeStatus(value),
    authStatus: readAuthStatus(value),
    pluginId,
    toolNames: Object.keys(tools ?? {}).sort((left, right) => left.localeCompare(right)),
    resourceCount: readArray(value, "resources").length,
    resourceTemplateCount: readArray(value, "resourceTemplates").length,
    toolsError,
  };
}

export function parseCodexMcpServerListResponse(value: unknown): {
  readonly servers: ReadonlyArray<ProviderMcpServerStatus>;
  readonly nextCursor: string | null;
} {
  if (!isRecord(value)) return { servers: [], nextCursor: null };
  const servers = readArray(value, "data")
    .map(parseCodexMcpServerStatus)
    .filter((server): server is ProviderMcpServerStatus => server !== null);
  const nextCursor = readString(value, "nextCursor")?.trim() || null;
  return { servers, nextCursor };
}

export function validateMcpServerName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("MCP server name must not be empty.");
  if (name === "synara") throw new Error("The built-in Synara MCP server cannot be changed.");
  if (name.length > 128 || !MCP_SERVER_NAME_PATTERN.test(name)) {
    throw new Error("MCP server name must use only letters, numbers, hyphens, or underscores.");
  }
  return name;
}

export function buildCodexMcpServerConfig(input: ProviderAddMcpServerInput): UnknownRecord {
  validateMcpServerName(input.name);

  if (input.transport === "stdio") {
    if (!input.command) throw new Error(`MCP server "${input.name}" needs a command.`);
    return {
      command: input.command,
      args: [...(input.args ?? [])],
      ...(input.env && Object.keys(input.env).length > 0 ? { env: { ...input.env } } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      enabled: true,
    };
  }

  if (!input.url) throw new Error(`MCP server "${input.name}" needs a URL.`);
  return {
    url: input.url,
    ...(input.bearerTokenEnvVar ? { bearer_token_env_var: input.bearerTokenEnvVar } : {}),
    enabled: true,
  };
}

const CLAUDE_RUNTIME_STATUSES: Record<string, ProviderMcpRuntimeStatus> = {
  connected: "connected",
  failed: "failed",
  "needs-auth": "authenticationRequired",
  pending: "starting",
  disabled: "disabled",
};

/** Maps one entry of the Claude Agent SDK's `mcpServerStatus()` to the shared shape. */
export function parseClaudeMcpServerStatus(value: unknown): ProviderMcpServerStatus | null {
  if (!isRecord(value)) return null;
  const name = readString(value, "name")?.trim();
  if (!name) return null;
  const status = readString(value, "status") ?? "";
  return {
    name,
    runtimeStatus: CLAUDE_RUNTIME_STATUSES[status] ?? null,
    authStatus: status === "needs-auth" ? "notLoggedIn" : "unknown",
    pluginId: null,
    toolNames: readArray(value, "tools")
      .map((tool) => (isRecord(tool) ? readString(tool, "name")?.trim() : undefined))
      .filter((toolName): toolName is string => Boolean(toolName))
      .toSorted((left, right) => left.localeCompare(right)),
    resourceCount: 0,
    resourceTemplateCount: 0,
    toolsError: readString(value, "error") ?? null,
  };
}

/** Builds a Claude Agent SDK MCP config; bearer tokens are read from `env` now. */
export function buildClaudeMcpServerConfig(
  input: ProviderAddMcpServerInput,
  env: NodeJS.ProcessEnv = process.env,
): UnknownRecord {
  validateMcpServerName(input.name);

  if (input.transport === "stdio") {
    if (!input.command) throw new Error(`MCP server "${input.name}" needs a command.`);
    if (input.cwd) throw new Error("Claude MCP servers do not support a working directory.");
    return {
      type: "stdio",
      command: input.command,
      args: [...(input.args ?? [])],
      ...(input.env && Object.keys(input.env).length > 0 ? { env: { ...input.env } } : {}),
    };
  }

  if (!input.url) throw new Error(`MCP server "${input.name}" needs a URL.`);
  const token = input.bearerTokenEnvVar ? env[input.bearerTokenEnvVar] : undefined;
  if (input.bearerTokenEnvVar && !token) {
    throw new Error(`Environment variable ${input.bearerTokenEnvVar} is not set.`);
  }
  return {
    type: "http",
    url: input.url,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
}

export const MCP_SERVER_LIST_PAGE_LIMIT = MCP_SERVER_PAGE_LIMIT;
