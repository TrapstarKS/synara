// FILE: Layers/ChatGptConnector.ts
// Purpose: Builds the ChatGPT connector service: persisted path secret,
//          settings-driven tunnel supervision, and the attributed MCP handler.
// Layer: Server provider connector
//
// The tunnel helper runs with a scrubbed environment: Synara control-plane
// variables and un-granted provider credentials never reach it, and the
// OpenAI tunnel key travels only as an environment variable, never argv.

import { spawn } from "node:child_process";

import { Cause, Effect, Exit, FileSystem, Layer, Path, Ref, Scope, Stream } from "effect";

import { ServerConfig } from "../../../config.ts";
import { buildProviderChildEnvironment } from "../../../providerChildEnvironment.ts";
import { ProviderCredentials } from "../../../providerCredentials.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import {
  connectorLocalUrl,
  connectorTokensMatch,
  loadOrCreateConnectorSecret,
  rotateConnectorSecret,
  type ChatGptConnectorSecret,
} from "../credentials.ts";
import { CONNECTOR_INSTRUCTIONS } from "../instructions.ts";
import { handleChatGptMcpPost } from "../mcpProtocol.ts";
import { ChatGptRuntimeRegistry } from "../runtime.ts";
import { createChatGptConnectorTools } from "../tools/index.ts";
import { ChatGptTunnelSupervisor, type ChatGptTunnelDependencies } from "../tunnel.ts";
import {
  ChatGptConnector,
  ChatGptConnectorError,
  type ChatGptConnectorInfo,
  type ChatGptConnectorShape,
} from "../Services/ChatGptConnector.ts";

export const CHATGPT_CONNECTOR_SERVER_VERSION = "1.0.0";

const toConnectorError = (detail: string, cause?: unknown): ChatGptConnectorError =>
  new ChatGptConnectorError({ detail, ...(cause === undefined ? {} : { cause }) });

/**
 * Spawns the tunnel child with the provider child environment rules applied:
 * Synara control-plane keys and un-granted provider credentials are stripped;
 * the tunnel's own variables pass through untouched.
 */
export const spawnChatGptTunnelChild: ChatGptTunnelDependencies["spawn"] = (
  command,
  args,
  options,
) =>
  spawn(command, [...args], {
    env: buildProviderChildEnvironment({ provider: "chatgpt", overrides: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ReturnType<ChatGptTunnelDependencies["spawn"]>;

export const makeChatGptConnector = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const providerCredentials = yield* ProviderCredentials;

  const registry = new ChatGptRuntimeRegistry();
  const tools = createChatGptConnectorTools();
  const supervisor = new ChatGptTunnelSupervisor({ spawn: spawnChatGptTunnelChild });

  const secretRef = yield* Ref.make<ChatGptConnectorSecret | null>(null);
  const statsRef = yield* Ref.make({ toolCallCount: 0, lastToolCallAt: null as string | null });

  const loadSecret = Effect.gen(function* () {
    const existing = yield* Ref.get(secretRef);
    if (existing) return existing;
    const loaded = yield* Effect.tryPromise({
      try: () => loadOrCreateConnectorSecret(config.stateDir),
      catch: (cause) => toConnectorError("Failed to load the ChatGPT connector secret.", cause),
    });
    yield* Ref.set(secretRef, loaded);
    return loaded;
  });

  const localUrlFor = (secret: ChatGptConnectorSecret) =>
    connectorLocalUrl({ host: config.host ?? "", port: config.port, token: secret.token });

  const runTunnel = Effect.gen(function* () {
    const secret = yield* loadSecret;
    const settings = yield* serverSettings.getSettings;
    const chatgpt = settings.providers.chatgpt;
    const localUrl = localUrlFor(secret);
    let apiKey: string | undefined;
    if (chatgpt.tunnelMode === "openai") {
      apiKey = (yield* providerCredentials.getServerPassword("chatgpt")) ?? undefined;
    }
    const nextStatus = yield* Effect.tryPromise({
      try: () =>
        supervisor.start({
          mode: chatgpt.tunnelMode,
          localUrl,
          ...(chatgpt.tunnelBinaryPath.trim().length > 0
            ? { binaryPath: chatgpt.tunnelBinaryPath.trim() }
            : {}),
          ...(chatgpt.openAiTunnelId.trim().length > 0
            ? { openAiTunnelId: chatgpt.openAiTunnelId.trim() }
            : {}),
          ...(apiKey === undefined ? {} : { openAiTunnelApiKey: apiKey }),
        }),
      catch: (cause) => toConnectorError("Failed to apply the ChatGPT tunnel settings.", cause),
    });
    return nextStatus;
  });

  const buildInfo = Effect.gen(function* () {
    const secret = yield* loadSecret;
    const localUrl = localUrlFor(secret);
    const tunnelStatus = supervisor.status();
    const stats = yield* Ref.get(statsRef);
    const snapshot = registry.snapshot();
    const publicUrl = tunnelStatus.publicUrl;
    const info: ChatGptConnectorInfo = {
      localUrl,
      publicUrl,
      connectorUrl: publicUrl ?? localUrl,
      tunnelState: tunnelStatus.state,
      tunnelMessage: tunnelStatus.message,
      secretCreatedAt: secret.createdAt,
      activeThreadId: snapshot.activeThreadId,
      registeredThreadIds: snapshot.registeredThreadIds,
      toolCallCount: stats.toolCallCount,
      lastToolCallAt: stats.lastToolCallAt,
    };
    return info;
  });

  const refreshTunnel = runTunnel.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("ChatGPT tunnel configuration failed", { cause: Cause.pretty(cause) }),
    ),
  );

  // Layer construction must not block on settings: `ServerSettings.start` runs
  // later in the server lifecycle, so awaiting `ready` here would deadlock the
  // whole graph. A background fiber waits for the first snapshot, applies the
  // tunnel, then re-applies on every settings change.
  const subscriptionScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionScope, Exit.void));
  yield* Effect.gen(function* () {
    yield* serverSettings.ready.pipe(Effect.catch(() => Effect.void));
    yield* refreshTunnel;
    yield* serverSettings.streamChanges.pipe(Stream.runForEach(() => refreshTunnel));
  }).pipe(Effect.forkIn(subscriptionScope));

  return {
    getInfo: buildInfo,
    rotateSecret: Effect.gen(function* () {
      const rotated = yield* Effect.tryPromise({
        try: () => rotateConnectorSecret(config.stateDir),
        catch: (cause) => toConnectorError("Failed to rotate the ChatGPT connector secret.", cause),
      });
      yield* Ref.set(secretRef, rotated);
      yield* refreshTunnel;
      return yield* buildInfo;
    }),
    restartTunnel: Effect.gen(function* () {
      yield* refreshTunnel;
      return yield* buildInfo;
    }),
    handlePost: (input) =>
      Effect.gen(function* () {
        const secret = yield* loadSecret;
        if (
          input.token.length !== secret.token.length ||
          !connectorTokensMatch(secret.token, input.token)
        ) {
          // 404 keeps the endpoint from confirming which secrets exist.
          return { status: 404 } as const;
        }
        const output = yield* Effect.tryPromise({
          try: () =>
            handleChatGptMcpPost({
              body: input.body,
              tools,
              instructions: CONNECTOR_INSTRUCTIONS,
              serverVersion: CHATGPT_CONNECTOR_SERVER_VERSION,
              resolveContext: () => registry.resolveCallContext(),
              augmentToolResult: (context, result) => {
                const note = context.agents.takeInbox?.(context) ?? "";
                if (note.length === 0) return result;
                return {
                  ...result,
                  content: [
                    ...result.content,
                    {
                      type: "text",
                      text: `--- reports from your workers ---\n${note}`,
                    },
                  ],
                };
              },
            }),
          catch: (cause) => toConnectorError("ChatGPT connector dispatch failed.", cause),
        });
        const calledTools = countToolCalls(Array.isArray(input.body) ? input.body : [input.body]);
        if (calledTools > 0) {
          yield* Ref.update(statsRef, (stats) => ({
            toolCallCount: stats.toolCallCount + calledTools,
            lastToolCallAt: new Date().toISOString(),
          }));
        }
        return output;
      }),
    registry,
  } satisfies ChatGptConnectorShape;
}).pipe(Effect.orDie);

function countToolCalls(messages: ReadonlyArray<unknown>): number {
  let count = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    if (record.method === "tools/call" && record.id !== undefined && record.id !== null) count += 1;
  }
  return count;
}

export type ChatGptConnectorLayer = Layer.Layer<
  ChatGptConnector,
  never,
  // FileSystem/Path satisfy the secret-store layer a caller may provide when
  // composing a standalone connector; the live application graph already
  // supplies them through NodeServices.
  FileSystem.FileSystem | Path.Path | ServerConfig | ServerSettingsService | ProviderCredentials
>;

export const ChatGptConnectorLive: ChatGptConnectorLayer = Layer.effect(
  ChatGptConnector,
  makeChatGptConnector,
);
