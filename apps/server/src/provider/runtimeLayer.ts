import { Effect, Layer } from "effect";

import { AgentGatewayCredentialsWithSecretsLive } from "../agentGateway/Layers/AgentGatewayCredentials";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { ServerConfig } from "../config";
import {
  makeProviderServerPasswordResolver,
  ProviderCredentials,
  ProviderCredentialsLive,
} from "../providerCredentials";
import { ServerSettingsService } from "../serverSettings";
import { makeChatGptAdapterLive } from "./Layers/ChatGptAdapter";
import { makeClaudeAdapterLive } from "./Layers/ClaudeAdapter";
import { makeCodexAdapterLive } from "./Layers/CodexAdapter";
import { makeCursorAdapterLive } from "./Layers/CursorAdapter";
import { makeDevinAdapterLive } from "./Layers/DevinAdapter";
import { makeEventNdjsonLogger } from "./Layers/EventNdjsonLogger";
import { makeAntigravityAdapterLive } from "./Layers/AntigravityAdapter";
import { makeDroidAdapterLive } from "./Layers/DroidAdapter";
import { makeGrokAdapterLive } from "./Layers/GrokAdapter";
import { makeOpenCodeAdapterLive } from "./Layers/OpenCodeAdapter";
import { makePiAdapterLive } from "./Layers/PiAdapter";
import { makeOmpAdapterLive } from "./Layers/OmpAdapter";
import { ProviderAdapterRegistryLive } from "./Layers/ProviderAdapterRegistry";
import { ProviderDiscoveryServiceLive } from "./Layers/ProviderDiscoveryService";
import { ProviderHealthLive } from "./Layers/ProviderHealth";
import { makeDurableProviderServiceLive } from "./Layers/ProviderService";
import {
  ChatGptConnectorLive,
  type ProvidedChatGptConnectorLayer,
} from "./chatgptConnector/Layers/ChatGptConnector";
import {
  ChatGptExternalBrowserLive,
  type ChatGptExternalBrowserLayer,
} from "./chatgptConnector/Layers/ChatGptExternalBrowser";
import { CHATGPT_MAX_WORKERS_DEFAULT } from "@synara/contracts";
import { ProviderSessionDirectoryLive } from "./Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime";
import { ProviderRuntimeEventRepositoryLive } from "../persistence/Layers/ProviderRuntimeEvents";

export function makeServerProviderLayer(
  options: {
    readonly agentGatewayCredentialsLayer?: typeof AgentGatewayCredentialsWithSecretsLive;
    /**
     * Shared ChatGPT connector layer. `makeServerApplicationLayers` builds it
     * once so the provider adapter and provider health observe one instance
     * (one decrypted secret, one tunnel process).
     */
    readonly chatGptConnectorLayer?: ProvidedChatGptConnectorLayer;
    /** Shared default-browser bridge used by the ChatGPT adapter and login RPC. */
    readonly chatGptExternalBrowserLayer?: ChatGptExternalBrowserLayer;
  } = {},
) {
  return Effect.gen(function* () {
    const credentials = yield* ProviderCredentials;
    const serverSettings = yield* ServerSettingsService;
    const resolveProviderServerPassword = makeProviderServerPasswordResolver(credentials);
    const { logProviderEvents, providerEventLogPath } = yield* ServerConfig;
    const nativeEventLogger = logProviderEvents
      ? yield* makeEventNdjsonLogger(providerEventLogPath, {
          stream: "native",
        })
      : undefined;
    const canonicalEventLogger = logProviderEvents
      ? yield* makeEventNdjsonLogger(providerEventLogPath, {
          stream: "canonical",
        })
      : undefined;
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    // Gives gateway-capable sessions their thread-scoped synara_* credentials.
    // OpenCode isolates managed servers before installing MCP; Pi projects
    // the same MCP catalog/dispatcher through its native custom-tool API.
    const agentGatewayCredentialsLayer =
      options.agentGatewayCredentialsLayer ?? AgentGatewayCredentialsWithSecretsLive;
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const openCodeAdapterLayer = makeOpenCodeAdapterLive({
      ...(nativeEventLogger ? { nativeEventLogger } : {}),
      resolveServerPassword: resolveProviderServerPassword,
    }).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const antigravityAdapterLayer = makeAntigravityAdapterLive().pipe(
      Layer.provide(agentGatewayCredentialsLayer),
    );
    const grokAdapterLayer = makeGrokAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const droidAdapterLayer = makeDroidAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const cursorAdapterLayer = makeCursorAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const devinAdapterLayer = makeDevinAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const piAdapterLayer = makePiAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const fallbackChatGptConnectorLayer: ProvidedChatGptConnectorLayer = ChatGptConnectorLive.pipe(
      Layer.provide(Layer.orDie(ProviderCredentialsLive)),
    );
    const chatGptConnectorLayer: ProvidedChatGptConnectorLayer =
      options.chatGptConnectorLayer ?? fallbackChatGptConnectorLayer;
    const chatGptExternalBrowserLayer: ChatGptExternalBrowserLayer =
      options.chatGptExternalBrowserLayer ??
      ChatGptExternalBrowserLive.pipe(Layer.provide(agentGatewayCredentialsLayer));
    const chatGptAdapterLayer = makeChatGptAdapterLive({
      resolveMaxWorkers: () =>
        serverSettings.getSettings.pipe(
          Effect.map((settings) =>
            settings.providers.chatgpt.maxWorkers > 0
              ? Math.min(8, settings.providers.chatgpt.maxWorkers)
              : CHATGPT_MAX_WORKERS_DEFAULT,
          ),
          Effect.orDie,
        ),
    }).pipe(Layer.provide(chatGptConnectorLayer), Layer.provide(chatGptExternalBrowserLayer));
    const ompAdapterLayer = makeOmpAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provide(cursorAdapterLayer),
      Layer.provide(devinAdapterLayer),
      Layer.provide(antigravityAdapterLayer),
      Layer.provide(grokAdapterLayer),
      Layer.provide(droidAdapterLayer),
      Layer.provide(openCodeAdapterLayer),
      Layer.provide(piAdapterLayer),
      Layer.provide(chatGptAdapterLayer),
      Layer.provide(ompAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provide(Layer.succeed(ServerSettingsService, serverSettings)),
    );
    const providerServiceLayer = makeDurableProviderServiceLive({
      ...(canonicalEventLogger ? { canonicalEventLogger } : {}),
    }).pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(providerSessionDirectoryLayer),
      Layer.provide(ProviderRuntimeEventRepositoryLive),
      // Provider sessions resolve persisted provider-instance settings before launch.
      Layer.provide(Layer.succeed(ServerSettingsService, serverSettings)),
      Layer.provide(ServerSecretStoreLive),
    );
    const providerDiscoveryLayer = ProviderDiscoveryServiceLive.pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(ProviderHealthLive),
      Layer.provide(Layer.succeed(ServerSettingsService, serverSettings)),
    );
    return Layer.mergeAll(
      providerServiceLayer,
      providerDiscoveryLayer,
      adapterRegistryLayer,
      providerSessionDirectoryLayer,
    );
  }).pipe(Effect.provide(ProviderCredentialsLive.pipe(Layer.orDie)), Layer.unwrap);
}
