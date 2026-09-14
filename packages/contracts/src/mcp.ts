import { Schema } from "effect";

import { NonNegativeInt, ProcessEnvRecord, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

/** Provider-native MCP server states exposed by the Codex app-server. */
export const ProviderMcpRuntimeStatus = Schema.Literals([
  "notStarted",
  "starting",
  "connected",
  "authenticationRequired",
  "failed",
  "cancelled",
  "disabled",
]);
export type ProviderMcpRuntimeStatus = typeof ProviderMcpRuntimeStatus.Type;

export const ProviderMcpAuthStatus = Schema.Literals([
  "unknown",
  "unsupported",
  "notLoggedIn",
  "bearerToken",
  "oAuth",
]);
export type ProviderMcpAuthStatus = typeof ProviderMcpAuthStatus.Type;

export const ProviderMcpTransport = Schema.Literals(["stdio", "streamable-http"]);
export type ProviderMcpTransport = typeof ProviderMcpTransport.Type;

export const ProviderMcpServerStatus = Schema.Struct({
  name: TrimmedNonEmptyString,
  runtimeStatus: Schema.NullOr(ProviderMcpRuntimeStatus),
  authStatus: ProviderMcpAuthStatus,
  pluginId: Schema.NullOr(TrimmedNonEmptyString),
  toolNames: Schema.Array(TrimmedNonEmptyString),
  resourceCount: NonNegativeInt,
  resourceTemplateCount: NonNegativeInt,
  toolsError: Schema.NullOr(Schema.String),
});
export type ProviderMcpServerStatus = typeof ProviderMcpServerStatus.Type;

export const ProviderListMcpServersInput = Schema.Struct({
  provider: ProviderKind,
  threadId: ThreadId,
});
export type ProviderListMcpServersInput = typeof ProviderListMcpServersInput.Type;

export const ProviderListMcpServersResult = Schema.Struct({
  servers: Schema.Array(ProviderMcpServerStatus),
});
export type ProviderListMcpServersResult = typeof ProviderListMcpServersResult.Type;

export const ProviderMcpServerActionInput = Schema.Struct({
  provider: ProviderKind,
  threadId: ThreadId,
  name: TrimmedNonEmptyString,
});
export type ProviderMcpServerActionInput = typeof ProviderMcpServerActionInput.Type;

export const ProviderMcpServerAction = Schema.Literals(["reloaded", "connected", "disconnected"]);
export type ProviderMcpServerAction = typeof ProviderMcpServerAction.Type;

export const ProviderMcpServerActionResult = Schema.Struct({
  action: ProviderMcpServerAction,
  servers: Schema.Array(ProviderMcpServerStatus),
});
export type ProviderMcpServerActionResult = typeof ProviderMcpServerActionResult.Type;

export const ProviderAddMcpServerInput = Schema.Struct({
  provider: ProviderKind,
  threadId: ThreadId,
  name: TrimmedNonEmptyString,
  transport: ProviderMcpTransport,
  command: Schema.optional(TrimmedNonEmptyString),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(ProcessEnvRecord),
  cwd: Schema.optional(TrimmedNonEmptyString),
  url: Schema.optional(TrimmedNonEmptyString),
  bearerTokenEnvVar: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAddMcpServerInput = typeof ProviderAddMcpServerInput.Type;
