import { ProjectionThreadMessageRepositoryLive } from "./persistence/Layers/ProjectionThreadMessages";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { QueuedTurnPromotionRepositoryLive } from "./persistence/Layers/QueuedTurnPromotions";
import { HubWorkRepositoryLive } from "./persistence/Layers/HubWorkRepository";
import { ManagedAttachmentRepositoryLive } from "./persistence/Layers/ManagedAttachments";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { AgentGatewayLive } from "./agentGateway/Layers/AgentGateway";
import { AgentGatewayOperationRepositoryLive } from "./agentGateway/Layers/AgentGatewayOperationRepository";
import { AgentGatewayCredentialsWithSecretsLive } from "./agentGateway/Layers/AgentGatewayCredentials";
import { BrowserAutomationHostLive } from "./browserAutomation/Layers/BrowserAutomationHost";
import { AutomationRunReactorLive } from "./automation/Layers/AutomationRunReactor";
import { AutomationSchedulerLive } from "./automation/Layers/AutomationScheduler";
import { AutomationServiceLive } from "./automation/Layers/AutomationService";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { StudioOutputReactorLive } from "./orchestration/Layers/StudioOutputReactor";
import { ThreadGitMetadataReactorLive } from "./orchestration/Layers/ThreadGitMetadataReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { SidechatExpiryReactorLive } from "./orchestration/Layers/SidechatExpiryReactor";
import { ThreadSnoozeReactorLive } from "./orchestration/Layers/ThreadSnoozeReactor";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor";
import { TurnCheckpointCoordinatorLive } from "./orchestration/Layers/TurnCheckpointCoordinator";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer";

import { DevServerManagerLive } from "./devServerManager";
import { DeviceServiceLive } from "./device/Layers/DeviceService";
import type { DeviceService } from "./device/Services/DeviceService";
import { ComputerServiceLive } from "./computer/Layers/ComputerService";
import { KeybindingsLive } from "./keybindings";
import { MindServiceLive } from "./mind/Layers/MindService";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitLayerLive, TextGenerationLayerLive } from "./git/runtimeLayer";
import { TerminalLayerLive } from "./terminal/runtimeLayer";
import { AuthControlPlaneLive } from "./auth/Layers/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./auth/Layers/BootstrapCredentialService";
import { ServerAuthLive } from "./auth/Layers/ServerAuth";
import { ServerAuthPolicyLive } from "./auth/Layers/ServerAuthPolicy";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "./auth/Layers/SessionCredentialService";
import { ProfileStatsQueryLive } from "./profileStats";
import { RecapStatsQueryLive } from "./recapStats";
import { ProfileStatsArchiveLive } from "./profileStatsArchive";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { ServerRuntimeStartupLive } from "./serverRuntimeStartup";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";
import { WorkspaceLayerLive } from "./workspace/runtimeLayer";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { ExternalMcpRepositoryLive } from "./externalMcp/Layers/ExternalMcpRepository";
import { ExternalMcpServiceLive } from "./externalMcp/Layers/ExternalMcpService";
import { ExternalMcpGatewayLive } from "./externalMcp/Layers/ExternalMcpGateway";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment";
import { AutomationRepositoryLive } from "./persistence/Layers/AutomationRepository";
import { MindRepositoryLive } from "./persistence/Layers/MindRepository";
import { TodoRepositoryLive } from "./persistence/Layers/TodoRepository";
import { TodoServiceLive } from "./todo/Layers/TodoService";
import { ProjectAgentRepositoryLive } from "./persistence/Layers/ProjectAgentRepository";
import { ProjectAgentReactorLive } from "./projectAgent/Layers/ProjectAgentReactor";
import { ProjectAgentServiceLive } from "./projectAgent/Layers/ProjectAgentService";
import { ProjectPullRequestPinsLive } from "./persistence/Layers/ProjectPullRequestPins";
import { ProjectionTurnRepositoryLive } from "./persistence/Layers/ProjectionTurns";
import { OrchestrationEventDeliveryRepositoryLive } from "./persistence/Layers/OrchestrationEventDeliveries";
import { ProviderRuntimeEventRepositoryLive } from "./persistence/Layers/ProviderRuntimeEvents";
import { ThreadDiagnosticsQueryLive } from "./diagnostics/Layers/ThreadDiagnosticsQuery";
import { ManagedAttachmentCleanupLive } from "./managedAttachmentCleanup";
import { PullRequestServiceLive } from "./pullRequests/Layers/PullRequestService";
import { PullRequestAutoFixRepositoryLive } from "./persistence/Layers/PullRequestAutoFixRepository";
import { PullRequestAutoFixServiceLive } from "./pullRequestAutoFix/Layers/PullRequestAutoFixService";
import { GitHubInboxServiceLive } from "./githubInbox/Layers/GitHubInboxService";
import { ProviderHealthLive } from "./provider/Layers/ProviderHealth";
import { makeServerProviderLayer } from "./provider/runtimeLayer";
import {
  ChatGptConnectorLive,
  type ProvidedChatGptConnectorLayer,
} from "./provider/chatgptConnector/Layers/ChatGptConnector";
import {
  ChatGptExternalBrowserLive,
  type ChatGptExternalBrowserLayer,
} from "./provider/chatgptConnector/Layers/ChatGptExternalBrowser";
import { ProviderCredentialsLive } from "./providerCredentials";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderSessionDirectory } from "./provider/Services/ProviderSessionDirectory";

type ServerProviderServices =
  | ProviderAdapterRegistry
  | ProviderDiscoveryService
  | ProviderService
  | ProviderSessionDirectory
  | ServerSettingsService;

export { makeServerProviderLayer } from "./provider/runtimeLayer";

export function provideThreadDeletionReactorDeviceService<
  ReactorServices,
  ReactorError,
  ReactorRequirements,
  DeviceError,
  DeviceRequirements,
>(
  reactorLayer: Layer.Layer<ReactorServices, ReactorError, ReactorRequirements>,
  deviceServiceLayer: Layer.Layer<DeviceService, DeviceError, DeviceRequirements>,
) {
  return reactorLayer.pipe(Layer.provideMerge(deviceServiceLayer));
}

export function makeServerRuntimeServicesLayer(
  options: {
    readonly agentGatewayCredentialsLayer?: typeof AgentGatewayCredentialsWithSecretsLive;
    /** Provide the live provider service so provider-native gateway tools are registered. */
    readonly providerLayer?: Layer.Layer<ServerProviderServices, unknown, unknown>;
    /** Shared ChatGPT connector layer (built once in makeServerApplicationLayers). */
    readonly chatGptConnectorLayer?: ProvidedChatGptConnectorLayer;
    /** Shared default-browser bridge (built once in makeServerApplicationLayers). */
    readonly chatGptExternalBrowserLayer?: ChatGptExternalBrowserLayer;
  } = {},
) {
  const agentGatewayCredentialsLayer =
    options.agentGatewayCredentialsLayer ?? AgentGatewayCredentialsWithSecretsLive;
  const serverSettingsLayer = ServerSettingsLive;
  const fallbackChatGptConnectorLayer: ProvidedChatGptConnectorLayer = ChatGptConnectorLive.pipe(
    Layer.provide(Layer.orDie(ProviderCredentialsLive)),
  );
  const chatGptConnectorLayer: ProvidedChatGptConnectorLayer =
    options.chatGptConnectorLayer ?? fallbackChatGptConnectorLayer;
  const chatGptExternalBrowserLayer: ChatGptExternalBrowserLayer =
    options.chatGptExternalBrowserLayer ??
    ChatGptExternalBrowserLive.pipe(Layer.provide(agentGatewayCredentialsLayer));
  const providerHealthLayer = ProviderHealthLive.pipe(
    Layer.provideMerge(serverSettingsLayer),
    Layer.provideMerge(chatGptConnectorLayer),
  );
  const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(GitCoreLive));

  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(checkpointStoreLayer),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    OrchestrationLayerLive,
    checkpointStoreLayer,
    checkpointDiffQueryLayer,
    RuntimeReceiptBusLive,
    TurnCheckpointCoordinatorLive,
  );
  const managedAttachmentCleanupLayer = ManagedAttachmentCleanupLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(ComputerServiceLive),
  );
  const studioOutputReactorLayer = StudioOutputReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const threadGitMetadataReactorLayer = ThreadGitMetadataReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(GitLayerLive),
  );
  const automationServiceLayer = AutomationServiceLive.pipe(
    Layer.provideMerge(AutomationRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(TextGenerationLayerLive),
    Layer.provideMerge(serverSettingsLayer),
    Layer.provideMerge(runtimeServicesLayer),
  );
  const projectAgentServiceLayer = ProjectAgentServiceLive.pipe(
    Layer.provideMerge(HubWorkRepositoryLive),
    Layer.provideMerge(ProjectAgentRepositoryLive),
    Layer.provideMerge(automationServiceLayer),
    Layer.provideMerge(TextGenerationLayerLive),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(serverSettingsLayer),
    Layer.provideMerge(providerHealthLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(providerHealthLayer),
    Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
    Layer.provideMerge(studioOutputReactorLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(TextGenerationLayerLive),
    Layer.provideMerge(serverSettingsLayer),
    Layer.provideMerge(AgentGatewayOperationRepositoryLive),
    Layer.provideMerge(projectAgentServiceLayer),
    // Persistence-level only: the reactor must recognize coordinator threads to
    // pre-approve Synara group tools — the same first lookup the project agent
    // service's principal resolver performs, without going through the service.
    Layer.provideMerge(ProjectAgentRepositoryLive),
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const sidechatExpiryReactorLayer = SidechatExpiryReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const threadSnoozeReactorLayer = ThreadSnoozeReactorLive.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
  );
  const profileStatsArchiveLayer = ProfileStatsArchiveLive.pipe(
    Layer.provideMerge(checkpointStoreLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
    Layer.provideMerge(studioOutputReactorLayer),
    Layer.provideMerge(threadGitMetadataReactorLayer),
    Layer.provideMerge(sidechatExpiryReactorLayer),
  );
  const threadDeletionReactorLayer = provideThreadDeletionReactorDeviceService(
    ThreadDeletionReactorLive.pipe(
      Layer.provideMerge(profileStatsArchiveLayer),
      Layer.provideMerge(OrchestrationLayerLive),
      Layer.provideMerge(TerminalLayerLive),
      Layer.provideMerge(GitCoreLive),
    ),
    DeviceServiceLive,
  );
  // Shares the single memoized TerminalManager with the top-level TerminalLayerLive.
  const devServerManagerLayer = DevServerManagerLive.pipe(Layer.provide(TerminalLayerLive));
  const sessionCredentialLayer = SessionCredentialServiceLive.pipe(
    Layer.provide(ServerSecretStoreLive),
  );
  const authControlPlaneLayer = AuthControlPlaneLive.pipe(
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionCredentialLayer),
  );
  const serverAuthLayer = ServerAuthLive.pipe(
    Layer.provide(ServerAuthPolicyLive),
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionCredentialLayer),
    Layer.provide(authControlPlaneLayer),
  );
  const authServicesLayer = Layer.mergeAll(
    ServerAuthPolicyLive,
    ServerSecretStoreLive,
    BootstrapCredentialServiceLive,
    sessionCredentialLayer,
    authControlPlaneLayer,
    serverAuthLayer,
  );
  // Mind domain service over its repository; the SQL client is provided upstream.
  const mindServiceLayer = MindServiceLive.pipe(Layer.provideMerge(MindRepositoryLive));
  const todoServiceLayer = TodoServiceLive.pipe(Layer.provideMerge(TodoRepositoryLive));
  const automationSchedulerLayer = AutomationSchedulerLive.pipe(
    Layer.provideMerge(automationServiceLayer),
    Layer.provideMerge(AutomationRepositoryLive),
  );
  const automationRunReactorLayer = AutomationRunReactorLive.pipe(
    Layer.provideMerge(automationServiceLayer),
  );
  const projectAgentReactorLayer = ProjectAgentReactorLive.pipe(
    Layer.provideMerge(projectAgentServiceLayer),
    Layer.provideMerge(runtimeServicesLayer),
  );
  const externalMcpServiceLayer = ExternalMcpServiceLive.pipe(
    Layer.provideMerge(ExternalMcpRepositoryLive),
    Layer.provideMerge(runtimeServicesLayer),
  );
  const externalMcpGatewayLayer = ExternalMcpGatewayLive.pipe(
    Layer.provideMerge(externalMcpServiceLayer),
    Layer.provideMerge(ExternalMcpRepositoryLive),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(AgentGatewayOperationRepositoryLive),
    Layer.provideMerge(serverSettingsLayer),
    Layer.provideMerge(providerHealthLayer),
  );
  const agentGatewayBaseLayer = AgentGatewayLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectionThreadMessageRepositoryLive,
        OrchestrationCommandReceiptRepositoryLive,
      ),
    ),
    Layer.provideMerge(QueuedTurnPromotionRepositoryLive),
    Layer.provideMerge(HubWorkRepositoryLive),
    Layer.provideMerge(ProjectAgentRepositoryLive),
    Layer.provideMerge(ManagedAttachmentRepositoryLive),
    Layer.provideMerge(agentGatewayCredentialsLayer),
    Layer.provideMerge(automationServiceLayer),
    Layer.provideMerge(projectAgentServiceLayer),
    // The gateway serves the synara_* memory tools over the shared Mind service.
    Layer.provideMerge(mindServiceLayer),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(GitLayerLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(AgentGatewayOperationRepositoryLive),
    Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
    Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
    Layer.provideMerge(ThreadDiagnosticsQueryLive),
  ).pipe(
    Layer.provideMerge(serverSettingsLayer),
    Layer.provideMerge(providerHealthLayer),
    Layer.provideMerge(BrowserAutomationHostLive),
    // The gateway exposes device_* tools only where a backend can exist, but it
    // resolves the service on every platform to make that decision.
    Layer.provideMerge(DeviceServiceLive),
    Layer.provideMerge(ComputerServiceLive),
  );
  // The optional provider layer is loosely typed; keep the gateway graph's own
  // types so callers without it still see their exact requirements.
  const agentGatewayLayer = options.providerLayer
    ? (agentGatewayBaseLayer.pipe(
        Layer.provideMerge(options.providerLayer),
      ) as unknown as typeof agentGatewayBaseLayer)
    : agentGatewayBaseLayer;
  // The inbox owns the repository inventory, GitHub read queue, and snapshots; the pull request
  // service shares them so detail reads and mutations stay consistent with the list.
  const githubInboxServiceLayer = GitHubInboxServiceLive.pipe(
    Layer.provideMerge(GitLayerLive),
    Layer.provideMerge(ProjectPullRequestPinsLive),
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(ServerSettingsLive),
  );
  const pullRequestServiceLayer = PullRequestServiceLive.pipe(
    Layer.provideMerge(githubInboxServiceLayer),
  );
  const pullRequestAutoFixLayer = PullRequestAutoFixServiceLive.pipe(
    Layer.provideMerge(PullRequestAutoFixRepositoryLive),
    Layer.provideMerge(GitLayerLive),
    Layer.provideMerge(runtimeServicesLayer),
  );

  return Layer.mergeAll(
    agentGatewayCredentialsLayer,
    agentGatewayLayer,
    chatGptExternalBrowserLayer,
    BrowserAutomationHostLive,
    automationServiceLayer,
    automationSchedulerLayer,
    automationRunReactorLayer,
    mindServiceLayer,
    todoServiceLayer,
    ProjectAgentRepositoryLive,
    projectAgentServiceLayer,
    projectAgentReactorLayer,
    managedAttachmentCleanupLayer,
    AutomationRepositoryLive,
    AgentGatewayOperationRepositoryLive,
    ExternalMcpRepositoryLive,
    externalMcpServiceLayer,
    externalMcpGatewayLayer,
    providerHealthLayer,
    ProjectPullRequestPinsLive,
    pullRequestServiceLayer,
    pullRequestAutoFixLayer,
    orchestrationReactorLayer,
    providerCommandReactorLayer,
    sidechatExpiryReactorLayer,
    threadSnoozeReactorLayer,
    threadGitMetadataReactorLayer,
    threadDeletionReactorLayer,
    devServerManagerLayer,
    DeviceServiceLive,
    ComputerServiceLive,
    GitLayerLive,
    TextGenerationLayerLive,
    TerminalLayerLive,
    KeybindingsLive,
    ServerEnvironmentLive,
    ProfileStatsQueryLive,
    RecapStatsQueryLive,
    authServicesLayer,
    ServerLifecycleEventsLive,
    ServerRuntimeStartupLive,
    WorkspaceLayerLive,
    ProjectFaviconResolverLive,
  ).pipe(Layer.provideMerge(serverSettingsLayer), Layer.provideMerge(NodeServices.layer));
}

/**
 * Compose the two top-level server graphs around one credential layer. Provider
 * adapters issue tokens from this registry and the HTTP gateway verifies those
 * same tokens, so constructing them independently would break scoped MCP.
 */
export function makeServerApplicationLayers() {
  const agentGatewayCredentialsLayer = AgentGatewayCredentialsWithSecretsLive;
  // One connector instance owns the ChatGPT path secret and tunnel; provider
  // health and the provider adapter must observe the same instance, so the
  // layer is built here and threaded into both graphs (Effect memoizes it).
  // ProviderCredentials is provided here because the application graph never
  // exports it (ServerSettings consumes its own instance internally).
  const chatGptConnectorLayer: ProvidedChatGptConnectorLayer = ChatGptConnectorLive.pipe(
    Layer.provide(Layer.orDie(ProviderCredentialsLive)),
  );
  const chatGptExternalBrowserLayer: ChatGptExternalBrowserLayer = ChatGptExternalBrowserLive.pipe(
    Layer.provide(agentGatewayCredentialsLayer),
  );
  // Provider start/discovery gates must observe the same settings instance as
  // the RPC layer. Reusing this layer in the final graph lets Effect memoize a
  // single ServerSettings service instead of capturing private defaults.
  const providerLayer = makeServerProviderLayer({
    agentGatewayCredentialsLayer,
    chatGptConnectorLayer,
    chatGptExternalBrowserLayer,
  }).pipe(Layer.provideMerge(ServerSettingsLive));
  const runtimeServicesLayer = makeServerRuntimeServicesLayer({
    agentGatewayCredentialsLayer,
    providerLayer,
    chatGptConnectorLayer,
    chatGptExternalBrowserLayer,
  });
  return {
    runtimeServicesLayer,
    providerLayer,
  } as const;
}
