import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
/**
 * AgentGatewayLive - Synara app-control MCP tool surface.
 *
 * Implements the `synara_*` tools served over `POST /mcp` (streamable HTTP,
 * stateless JSON responses). Every provider session gets this endpoint plus a
 * thread-bound bearer token injected at session start, so any agent running in
 * a Synara thread can list/read/create/steer threads and manage heartbeat
 * automations - the same host-tool pattern the Codex desktop app uses.
 *
 * All tools delegate to existing services (OrchestrationEngine dispatch,
 * ProjectionSnapshotQuery reads, AutomationService, GitCore); no orchestration
 * state lives here.
 *
 * @module agentGateway/Layers/AgentGateway
 */
import { computerSpaceDesignationForMessages } from "../../computer/computerSpaceDesignation.ts";
import { randomUUID } from "node:crypto";

import {
  COMPUTER_SETUP_REQUIRED_ACTIVITY_KIND,
  COMPUTER_CONTROL_DENIED_ACTIVITY_KIND,
  CommandId,
  EventId,
  SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
  SynaraSendMessageInput,
  MessageId,
  THREAD_GOAL_BLOCK_ATTEMPT_LIMIT,
  ProjectId,
  THREAD_GOAL_MAX_CHARS,
  ThreadId,
  TurnId,
  type ComputerBuildSignature,
  type ComputerPermission,
  type ComputerSetupRequiredPayload,
  type ModelSelection,
  type OrchestrationCommand,
  type ProviderApprovalDecision,
  type ProviderKind,
  type RuntimeMode,
  type TurnDispatchMode,
} from "@synara/contracts";
import { PROVIDER_USAGE_PROVIDERS } from "@synara/shared/providerUsage";
import { runtimeModeEscalatesPrivilege } from "@synara/shared/runtimeMode";
import { Effect, Layer, Option, Schema } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { ServerConfig } from "../../config.ts";
import { MindService } from "../../mind/Services/MindService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { buildAutomationProposalActivity } from "../../automation/proposalActivity.ts";
import { ProjectAgentService } from "../../projectAgent/Services/ProjectAgentService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventDeliveryRepository } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { ProviderRuntimeEventRepository } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ThreadDiagnosticsQuery } from "../../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import { AgentGateway, type AgentGatewayShape } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import { AgentGatewayOperationRepository } from "../Services/AgentGatewayOperationRepository.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { readProviderUsageForAgents } from "../../providerUsage/agentReader.ts";
import { collectProviderUsageSnapshots, listProviderUsage } from "../../providerUsage/index.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
  resolveAgentGatewayTarget,
  listDriverAccounts,
  pickDriverStatus,
  type AgentGatewayProviderAvailability,
} from "../targetResolver.ts";
import { mcpToolResultError, mcpToolResultJson } from "../protocol.ts";
import { gatewayIsoNow as isoNow, stableGatewayDigest } from "../creationUtils.ts";
import {
  MODEL_SELECTION_INPUT_SCHEMA,
  PROVIDER_KINDS,
  ToolInputError,
  buildModelSelection,
  decodeCreateThreadsInput,
  errorText,
  parseProviderKind,
  readBooleanArg,
  readRecordArg,
  readStringArg,
} from "../toolInput.ts";
import {
  GatewayToolError,
  gatewayToolErrorResult,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "../toolRuntime.ts";
import { makeAgentGatewayMcpTransport } from "../mcpTransport.ts";
import { deliverGatewayCompletions } from "../completionDelivery.ts";
import { makeAwaitRegistration, makeAwaitThreads } from "../awaitThreads.ts";
import { makeAwaitedDispatch } from "../awaitedDispatch.ts";
import { makeCoordinatorQuestions } from "../coordinatorQuestions.ts";
import { makeThreadCoordination } from "../threadCoordination.ts";
import { recoverInterruptedAgentGatewayOperations } from "../startupRecovery.ts";
import { makeCreateThreadsHandler } from "../creationCoordinator.ts";
import { makeHubWorkGateway } from "../hubWorkGateway";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts";
import { QueuedTurnPromotionRepository } from "../../persistence/Services/QueuedTurnPromotions";
import { HubWorkRepository } from "../../persistence/Services/HubWorkRepository";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments";
import { resolveHubWorkSource, renderHubWorkPrompt } from "../hubWorkSource";
import { cloneDelegatedAttachments } from "../delegatedAttachments";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "../../managedAttachmentPrincipal";

import { makeAgentGatewayAutomationTools } from "../automationTools.ts";
import { makeAgentGatewayMemoryTools } from "../memoryTools.ts";
import { makeAgentGatewayBrowserTools } from "../browserTools.ts";
import { makeAgentGatewayComputerBrowserTools } from "../computerBrowserTools.ts";
import { computerApprovalDisplayArgs } from "../computerApprovalDisplay.ts";
import { makeAgentGatewayDeviceTools } from "../deviceTools.ts";
import { makeAgentGatewayMcpTools } from "../mcpTools.ts";
import { DeviceService } from "../../device/Services/DeviceService.ts";
import {
  COMPUTER_CONTROL_CAPABILITY,
  makeAgentGatewayComputerTools,
  type AgentGatewayComputerToolsOptions,
} from "../computerTools.ts";
import { isSynaraComputerToolFamilyName } from "../computerToolPermission.ts";
import { ComputerService } from "../../computer/Services/ComputerService.ts";
import { computerApprovalGate } from "../../computer/ComputerApprovalGate.ts";
import { makeComputerForegroundConsent } from "../computerForegroundConsent.ts";
import { BrowserAutomationHost } from "../../browserAutomation/Services/BrowserAutomationHost.ts";
import { makeBrowserAutomationHost } from "../../browserAutomation/Layers/BrowserAutomationHost.ts";
import { makeProjectAgentTools } from "../projectAgentTools.ts";
import { isServerGroupsEnabled } from "../../projectAgent/groupsBetaGate.ts";
import { makeThreadReadTools } from "../threadReadTools.ts";
import { makeThreadDiagnosticTools } from "../threadDiagnosticTools.ts";
import { makeAgentGatewayUsageTools } from "../usageTools.ts";
import { makeAgentGatewayKanbanTools } from "../kanbanTools.ts";
import { pruneProjectedArchivedManagedWorktrees } from "../../managedWorktrees.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";

// Providers already receive the versioned host policy exactly once in their
// private prompt. MCP clients prepend initialize.instructions to every exposed
// tool definition, so repeating the full policy here adds tens of thousands of
// context characters per round without adding authority or safety.
const AGENT_GATEWAY_INSTRUCTIONS =
  "Synara tools are thread-scoped. Use browser_* only for Synara's shared in-app browser runtime; follow the provider-delivered <synara_host_context> for full policy.";

function readThreadGoalArg(args: Record<string, unknown>): string {
  if (!("goal" in args)) {
    throw new ToolInputError(`Missing required argument "goal".`);
  }
  const value = args.goal;
  if (value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ToolInputError(`Argument "goal" must be a string or null.`);
  }
  const goal = value.trim();
  if (goal.length > THREAD_GOAL_MAX_CHARS) {
    throw new ToolInputError(
      `Argument "goal" must be at most ${THREAD_GOAL_MAX_CHARS} characters.`,
    );
  }
  return goal;
}

function agentCommandGuard(context: ToolContext) {
  if (context.callerTurnId === null) {
    throw new ToolInputError("Agent command requires an exact active caller turn.");
  }
  return {
    agentCallerThreadId: ThreadId.makeUnsafe(context.callerThreadId),
    agentCallerTurnId: TurnId.makeUnsafe(context.callerTurnId),
  } as const;
}

export const makeAgentGateway = Effect.gen(function* () {
  const credentials = yield* AgentGatewayCredentials;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const automationService = yield* AutomationService;
  const mindService = yield* MindService;
  const projectAgentService = yield* ProjectAgentService;
  const git = yield* GitCore;
  const gitManager = yield* GitManager;
  const providerDiscovery = yield* ProviderDiscoveryService;
  const providerService = Option.getOrUndefined(yield* Effect.serviceOption(ProviderService));
  const providerHealth = yield* ProviderHealth;
  const serverSettings = yield* ServerSettingsService;
  const operationRepository = yield* AgentGatewayOperationRepository;
  const projectionTurns = yield* ProjectionTurnRepository;
  const eventStore = yield* OrchestrationEventStore;
  const eventDeliveries = yield* OrchestrationEventDeliveryRepository;
  const providerRuntimeEvents = yield* ProviderRuntimeEventRepository;
  const diagnostics = yield* ThreadDiagnosticsQuery;
  const serverConfig = yield* ServerConfig;
  const browserAutomationHost = Option.getOrElse(
    yield* Effect.serviceOption(BrowserAutomationHost),
    () => makeBrowserAutomationHost({}),
  );
  // Optional and platform-gated: off macOS (and in tests that do not provide
  // it) the agent never sees the device_* tools at all, rather than being
  // offered eleven tools that can only report an unsupported platform.
  const deviceService = Option.getOrUndefined(yield* Effect.serviceOption(DeviceService));
  const computerService = Option.getOrUndefined(yield* Effect.serviceOption(ComputerService));
  const loadProviderAvailabilities = Effect.gen(function* () {
    const [settings, statuses] = yield* Effect.all([
      serverSettings.getSettings,
      providerHealth.getStatuses,
    ]);
    const instances = deriveProviderInstances(settings);
    return new Map<ProviderKind, AgentGatewayProviderAvailability>(
      PROVIDER_KINDS.map((provider) => {
        const status = pickDriverStatus(statuses, provider);
        const accounts = listDriverAccounts(instances, statuses, provider);
        return [
          provider,
          {
            enabled: settings.providers[provider].enabled,
            ...(accounts.length > 0 ? { accounts } : {}),
            ...(status
              ? {
                  available: status.available,
                  authStatus: status.authStatus,
                  ...(status.message ? { message: status.message } : {}),
                }
              : {}),
          },
        ];
      }),
    );
  });
  const loadProviderUsage = (provider?: ProviderKind, instanceId?: string) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(Effect.timeout("3 seconds"));
      const enabledProviders = new Set(
        PROVIDER_USAGE_PROVIDERS.filter((kind) => settings.providers[kind].enabled),
      );
      return yield* readProviderUsageForAgents({
        providers: provider ? [provider] : [...enabledProviders],
        enabledProviders,
        loadSnapshot: (kind) =>
          instanceId && instanceId !== kind
            ? listProviderUsage({ provider: kind }).pipe(
                Effect.provideService(ServerConfig, serverConfig),
                Effect.provideService(ServerSettingsService, serverSettings),
                Effect.map(
                  (snapshots) =>
                    snapshots.find((snapshot) => snapshot.instanceId === instanceId) ?? null,
                ),
              )
            : Effect.promise(() =>
                collectProviderUsageSnapshots(
                  {
                    homeDir: serverConfig.homeDir,
                    env: process.env,
                    platform: process.platform,
                    nowMs: Date.now(),
                    claudeBinaryPath: settings.providers.claudeAgent.binaryPath,
                  },
                  { providers: [kind] },
                ),
              ).pipe(Effect.map((snapshots) => snapshots[0] ?? null)),
      });
    });

  yield* recoverInterruptedAgentGatewayOperations({
    operationRepository,
    snapshotQuery,
    orchestrationEngine,
    git,
  });

  const awaitedDispatch = yield* makeAwaitedDispatch({ snapshotQuery, orchestrationEngine });
  const awaitRegistration = yield* makeAwaitRegistration({ snapshotQuery, orchestrationEngine });
  const coordinatorQuestions = yield* makeCoordinatorQuestions({
    snapshotQuery,
    projectionTurns,
    completionRepository: operationRepository.completions,
    orchestrationEngine,
  });
  const awaitThreads = yield* makeAwaitThreads({
    snapshotQuery,
    projectionTurns,
    completionRepository: operationRepository.completions,
    orchestrationEngine,
    coordination: coordinatorQuestions,
  });
  const coordination = yield* makeThreadCoordination({
    snapshotQuery,
    orchestrationEngine,
    questions: coordinatorQuestions,
  });

  yield* Effect.forkScoped(
    Effect.forever(
      deliverGatewayCompletions({
        repository: operationRepository.completions,
        snapshotQuery,
        projectionTurns,
        orchestrationEngine,
      }).pipe(
        Effect.catch((error) => Effect.logWarning("gateway completion scan failed", { error })),
        Effect.andThen(
          awaitedDispatch
            .repairPending()
            .pipe(
              Effect.catch((error) => Effect.logWarning("awaited dispatch scan failed", { error })),
            ),
        ),
        Effect.andThen(
          coordinatorQuestions
            .deliverPending()
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("coordinator question scan failed", { error }),
              ),
            ),
        ),
        Effect.andThen(
          awaitThreads
            .armOrchestratorWaits()
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("orchestrator auto-wait scan failed", { error }),
              ),
              Effect.andThen(awaitThreads.deliverPending()),
            )
            .pipe(
              Effect.catch((error) => Effect.logWarning("gateway wait scan failed", { error })),
            ),
        ),
        Effect.andThen(Effect.sleep(1000)),
      ),
    ),
  );

  const requireThreadShell = (threadId: string) =>
    snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
      Effect.mapError((error) => new ToolInputError(errorText(error))),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`)),
          onSome: (shell) => Effect.succeed(shell),
        }),
      ),
    );

  // Automation targets resolve like thread-creation targets: live provider availability
  // and model discovery, against the workspace of the project the automation belongs to.
  const resolveAutomationTarget = (input: {
    readonly target: ModelSelection;
    readonly projectId: ProjectId;
  }): Effect.Effect<ModelSelection, unknown> =>
    Effect.gen(function* () {
      const project = yield* snapshotQuery.getProjectShellById(input.projectId).pipe(
        Effect.mapError((error) => new ToolInputError(errorText(error))),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new ToolInputError(`Project "${input.projectId}" was not found.`)),
            onSome: Effect.succeed,
          }),
        ),
      );
      const providerAvailabilities = yield* loadProviderAvailabilities;
      const availability = providerAvailabilities.get(input.target.provider);
      return yield* resolveAgentGatewayTarget({
        target: input.target,
        discovery: providerDiscovery,
        ...(availability !== undefined ? { availability } : {}),
        cwd: project.workspaceRoot,
      });
    });

  // Privilege boundary shared by every tool that makes another thread execute
  // work or mutates another thread's state: a caller must not drive a thread
  // that runs with more privileges than the user granted the caller itself —
  // otherwise an approval-required or worktree-isolated agent escalates by proxy.
  const assertCallerMayDriveThread = (
    caller: {
      readonly id: string;
      readonly runtimeMode: RuntimeMode;
      readonly envMode?: string | null | undefined;
    },
    target: {
      readonly id: string;
      readonly runtimeMode: RuntimeMode;
      readonly envMode?: string | null | undefined;
    },
  ) =>
    Effect.gen(function* () {
      if (runtimeModeEscalatesPrivilege(caller.runtimeMode, target.runtimeMode)) {
        return yield* Effect.fail(
          new ToolInputError(
            `Thread "${target.id}" runs in "${target.runtimeMode}" mode but your thread runs in "${caller.runtimeMode}"; you cannot drive higher-privileged threads. Ask the user to do this or to elevate your thread.`,
          ),
        );
      }
      if (caller.envMode === "worktree" && (target.envMode ?? "local") === "local") {
        return yield* Effect.fail(
          new ToolInputError(
            `Thread "${target.id}" runs on the shared local checkout but your thread is isolated in a worktree; you cannot drive local-checkout threads. Ask the user to do this from a local thread.`,
          ),
        );
      }
      yield* projectAgentService
        .assertCallerMayDriveManagedThread({
          callerThreadId: ThreadId.makeUnsafe(caller.id),
          targetThreadId: ThreadId.makeUnsafe(target.id),
        })
        .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
    });

  const readTools = makeThreadReadTools({
    snapshotQuery,
    projectionTurns,
    providerDiscovery,
    loadProviderAvailabilities,
    requireThreadShell,
    workspacePaths: {
      homeDir: serverConfig.homeDir,
      chatWorkspaceRoot: serverConfig.chatWorkspaceRoot,
    },
    loadProviderUsage,
  });
  const diagnosticTools = makeThreadDiagnosticTools({
    snapshotQuery,
    diagnostics,
    eventStore,
    providerRuntimeEvents,
    eventDeliveries,
    requireThreadShell,
  });

  // --- write tools ----------------------------------------------------------

  const runCreateThreads = yield* makeCreateThreadsHandler({
    snapshotQuery,
    orchestrationEngine,
    git,
    providerDiscovery,
    operationRepository,
    serverConfig,
    loadProviderAvailabilities,
    requireThreadShell,
    awaitedDispatch,
    announceWait: awaitRegistration.announceRegistration,
    authorizeManagedGoalCreation: (input) =>
      projectAgentService
        .authorizeManagedGoalCreation(input)
        .pipe(Effect.mapError((error) => new ToolInputError(error.message))),
    recordManagedWorkerThreads: (input) =>
      projectAgentService
        .recordManagedWorkerThreads(input)
        .pipe(Effect.mapError((error) => new ToolInputError(error.message))),
    assertCreateTargetProject: (input) =>
      projectAgentService
        .assertCallerMayCreateThreadInProject({
          callerThreadId: ThreadId.makeUnsafe(input.callerThreadId),
          targetProjectId: input.targetProjectId,
        })
        .pipe(Effect.mapError((error) => new ToolInputError(error.message))),
  });

  const hubRepository = Option.getOrUndefined(yield* Effect.serviceOption(HubWorkRepository));
  const projectRepository = Option.getOrUndefined(
    yield* Effect.serviceOption(ProjectAgentRepository),
  );
  const attachmentRepository = Option.getOrUndefined(
    yield* Effect.serviceOption(ManagedAttachmentRepository),
  );
  const queuedTurnPromotions = Option.getOrUndefined(
    yield* Effect.serviceOption(QueuedTurnPromotionRepository),
  );
  const commandReceipts = Option.getOrUndefined(
    yield* Effect.serviceOption(OrchestrationCommandReceiptRepository),
  );
  const hubMessages = Option.getOrUndefined(
    yield* Effect.serviceOption(ProjectionThreadMessageRepository),
  );
  const hubGateway =
    hubRepository && projectRepository && attachmentRepository
      ? makeHubWorkGateway({
          repository: hubRepository,
          creationOperations: operationRepository,
          ...(hubMessages ? { messages: hubMessages } : {}),
          projectAgentRepository: projectRepository,
          projectAgentService,
          snapshotQuery,
          projectionTurns,
          git,
          ...(commandReceipts ? { commandReceipts } : {}),
          ...(queuedTurnPromotions ? { queuedTurnPromotions } : {}),
          attachments: attachmentRepository,
          serverConfig,
          createThreads: runCreateThreads,
        })
      : null;
  if (hubGateway && isServerGroupsEnabled()) {
    yield* hubGateway.recover;
    yield* Effect.forkScoped(
      Effect.forever(
        hubGateway.tick.pipe(
          Effect.catch((error) => Effect.logWarning("hub work scan failed", { error })),
          Effect.andThen(Effect.sleep(1000)),
        ),
      ),
    );
  }
  const createWithHubQueue = (
    input: Parameters<typeof runCreateThreads>[0],
    context: ToolContext,
  ) =>
    Effect.gen(function* () {
      const hubResult = hubGateway ? yield* hubGateway.submit(input, context) : null;
      if (hubResult) return hubResult;
      return yield* runCreateThreads(input, {
        kind: "provider-session",
        callerThreadId: context.callerThreadId,
        callerTurnId: context.callerTurnId,
        assertAuthority: context.assertCallerTurnActive,
        prepareWait: () => awaitRegistration.prepareRegistration(context),
      });
    });
  const contextMessageIdsSchema = {
    type: "array",
    maxItems: 16,
    items: { type: "string" },
    description:
      "IDs of original human messages in this coordinator conversation. Omit only when delegating the current human turn. Synara forwards their canonical text and attachments.",
  };

  const createThreads: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_threads",
      description:
        "Create an exact batch of 1–20 standalone Synara threads. Hub coordinators instead submit durable workItems to the Hub queue: accepted does not mean started, and workerThreadId is available after admission. Worktree threads start on a Synara-managed temporary branch pinned at baseRef (or the selected checkout's HEAD) and copy local checkout changes plus .worktreeinclude files when the ref is that checkout's HEAD; on the first turn Synara may rename the branch after the prompt and publish it. Validation/preflight failures create nothing and may be corrected with the same requestId; durable retries replay the exact operation. Each created thread's result includes a ready-to-use link (`thread://<threadId>`); when you mention a thread in a message to the user, write it as a markdown link like [title](thread://<threadId>).",
      inputSchema: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            maxLength: 256,
            description: "Stable id for this exact user-requested creation plan.",
          },
          awaitResult: {
            type: "boolean",
            description:
              "Durably wait for this batch's exact initial messages and continue the creator once with all results. Returns immediately; finish your response when independent work is done. Each entry may override this setting.",
          },
          threads: {
            type: "array",
            minItems: 1,
            maxItems: SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: {
              type: "object",
              properties: {
                awaitResult: {
                  type: "boolean",
                  description: "Override the batch awaitResult setting for this entry.",
                },
                notifyCreatorOnComplete: {
                  type: "boolean",
                  description:
                    "Passively return the initial run result to this creating thread. Does not wake the creator; goal runs are unsupported.",
                },
                contextMessageIds: contextMessageIdsSchema,
                prompt: { type: "string" },
                title: { type: "string" },
                target: {
                  ...MODEL_SELECTION_INPUT_SCHEMA,
                },
                projectId: { type: "string" },
                environment: { type: "string", enum: ["local", "worktree"] },
                baseRef: {
                  type: "string",
                  description:
                    "Local Git revision, #PR, or GitHub pull-request URL the worktree is pinned at. Defaults to the selected checkout's HEAD.",
                },
                runtimeMode: {
                  type: "string",
                  enum: ["approval-required", "full-access"],
                },
              },
              required: ["prompt", "target"],
              additionalProperties: false,
            },
          },
        },
        required: ["requestId", "threads"],
        additionalProperties: false,
      },
      annotations: {
        title: "Create Synara threads",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    handler: (args, context) => createWithHubQueue(decodeCreateThreadsInput(args), context),
  };

  const createThread: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_thread",
      description:
        "Create exactly one standalone Synara thread. Hub coordinators receive a durable workItems entry that can remain queued until a worker slot is available. Worktree threads start on a Synara-managed temporary branch pinned at baseRef; on the first turn Synara may rename the branch after the prompt and publish it. For two or more threads use one synara_create_threads call instead. The result includes a ready-to-use link (`thread://<threadId>`); when you mention the thread in a message to the user, write it as a markdown link like [title](thread://<threadId>).",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", maxLength: 256 },
          awaitResult: {
            type: "boolean",
            description:
              "Durably wait for this exact initial message and continue this creator once with the result. Returns immediately; finish this response when independent work is done.",
          },
          notifyCreatorOnComplete: {
            type: "boolean",
            description:
              "Passively return the initial run result to this creating thread. Does not wake the creator; goal runs are unsupported.",
          },
          contextMessageIds: contextMessageIdsSchema,
          prompt: { type: "string" },
          title: { type: "string" },
          target: {
            ...MODEL_SELECTION_INPUT_SCHEMA,
          },
          provider: { type: "string", enum: [...PROVIDER_KINDS] },
          model: { type: "string" },
          options: {
            type: "object",
            description: AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
          },
          projectId: { type: "string" },
          environment: { type: "string", enum: ["local", "worktree"] },
          baseRef: {
            type: "string",
            description:
              "Local Git revision, #PR, or GitHub pull-request URL the worktree is pinned at. Defaults to the selected checkout's HEAD.",
          },
          runtimeMode: {
            type: "string",
            enum: ["approval-required", "full-access"],
          },
        },
        required: ["requestId", "prompt"],
        additionalProperties: false,
      },
      annotations: {
        title: "Create a Synara thread",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    handler: (args, context) =>
      Effect.suspend(() => {
        const explicitTarget = readRecordArg(args, "target");
        let target: Record<string, unknown>;
        if (explicitTarget) {
          target = explicitTarget;
        } else {
          const provider = parseProviderKind(readStringArg(args, "provider", { required: true })!);
          const modelSelection = buildModelSelection(provider, readStringArg(args, "model"));
          const options = readRecordArg(args, "options");
          target = {
            ...modelSelection,
            ...(options ? { options } : {}),
          };
        }
        const spec: Record<string, unknown> = {
          prompt: readStringArg(args, "prompt", { required: true })!,
          target,
        };
        for (const key of [
          "title",
          "contextMessageIds",
          "projectId",
          "environment",
          "baseRef",
          "baseBranch",
          "branchName",
          "runtimeMode",
          "notifyCreatorOnComplete",
          "awaitResult",
        ]) {
          const value = args[key];
          if (value !== undefined) spec[key] = value;
        }
        return createWithHubQueue(
          decodeCreateThreadsInput({
            requestId: readStringArg(args, "requestId", { required: true }),
            threads: [spec],
          }),
          context,
        ).pipe(
          Effect.map((result) => {
            if (result.isError) return result;
            const content = result.content[0];
            const parsed = JSON.parse(content?.type === "text" ? content.text : "{}");
            if (parsed.workItems) return result;
            const batch = parsed as {
              operationId?: string;
              requestId?: string;
              instruction?: string;
              threads?: Array<Record<string, unknown>>;
            };
            return mcpToolResultJson({
              operationId: batch.operationId,
              requestId: batch.requestId,
              ...(batch.threads?.[0] ?? {}),
              ...(batch.instruction ? { instruction: batch.instruction } : {}),
            });
          }),
        );
      }).pipe(Effect.catchDefect((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const sendMessage: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_send_message",
      description:
        'Send a Synara follow-up message to an existing thread. mode "queue" (default) waits for the current turn. "steer" uses native steering when available; otherwise it queues the follow-up first and interrupts the running turn. With no live turn, it starts normally. Use "queue" for ordinary follow-ups.',
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Target thread." },
          message: { type: "string", description: "Message text." },
          contextMessageIds: contextMessageIdsSchema,
          mode: { type: "string", enum: ["queue", "steer"], description: "Dispatch mode." },
          awaitResult: {
            type: "boolean",
            description:
              "With queue mode and a stable requestId, durably await this exact message and continue this caller once with all delegated results. Returns immediately; finish your response when independent work is done. Awaited steering is unsupported.",
          },
          requestId: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            description:
              "Required when awaitResult is true. Reuse this exact id and message for retries; it is only used by awaited sends.",
          },
        },
        required: ["threadId", "message"],
        additionalProperties: false,
      },
      annotations: { title: "Send a Synara message", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const message = readStringArg(args, "message", { required: true })!;
        const modeArg = readStringArg(args, "mode") ?? "queue";
        if (modeArg !== "queue" && modeArg !== "steer") {
          throw new ToolInputError(`Argument "mode" must be "queue" or "steer".`);
        }
        const awaitResult = readBooleanArg(args, "awaitResult") === true;
        const awaited = awaitResult
          ? yield* Schema.decodeUnknownEffect(SynaraSendMessageInput)({
              ...args,
              threadId,
              message,
              mode: modeArg,
            })
          : null;
        const waitScope = awaited ? yield* awaitRegistration.prepareRegistration(context) : null;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        if (awaited && waitScope) {
          return mcpToolResultJson(
            yield* awaitedDispatch.send({
              requestId: awaited.requestId!,
              scope: waitScope,
              target,
              message,
              assertAuthority: context.assertCallerTurnActive,
            }),
          );
        }
        // Pass the requested mode through unchanged: the reactor checks live
        // provider state (authoritative, unlike this projection snapshot) and
        // already downgrades steers whose turn is not actually live.
        const dispatchMode: TurnDispatchMode = modeArg;
        const principal = isServerGroupsEnabled()
          ? yield* projectAgentService.resolvePrincipalForThread(caller.id)
          : null;
        const sourceMessages =
          principal?.kind === "coordinator" && hubGateway
            ? yield* resolveHubWorkSource({
                snapshotQuery,
                projectionTurns,
                callerThreadId: caller.id,
                callerTurnId: context.callerTurnId,
                ...(args.contextMessageIds !== undefined
                  ? {
                      contextMessageIds: yield* Effect.try({
                        try: () => {
                          if (
                            !Array.isArray(args.contextMessageIds) ||
                            args.contextMessageIds.some((id) => typeof id !== "string")
                          )
                            throw new ToolInputError(
                              "contextMessageIds must be an array of message IDs.",
                            );
                          return args.contextMessageIds as string[];
                        },
                        catch: (error) => new ToolInputError(errorText(error)),
                      }),
                    }
                  : {}),
              })
            : [];
        const suffix = sourceMessages.length
          ? stableGatewayDigest(
              { sourceMessages, targetThreadId: target.id, message, dispatchMode },
              40,
            )
          : randomUUID();
        const messageId = MessageId.makeUnsafe(`agent:${suffix}:message`);
        if (sourceMessages.length) {
          const targetDetail = yield* snapshotQuery.getThreadDetailById(target.id);
          if (
            Option.isSome(targetDetail) &&
            targetDetail.value.messages.some((entry) => entry.id === messageId)
          ) {
            return mcpToolResultJson({
              threadId: target.id,
              dispatched: dispatchMode,
              replayed: true,
            });
          }
        }
        const attachments =
          sourceMessages.length && attachmentRepository
            ? yield* cloneDelegatedAttachments({
                sourceMessages,
                targetThreadId: target.id,
                targetMessageId: messageId,
                dispatchKey: suffix,
                attachmentsDir: serverConfig.attachmentsDir,
                repository: attachmentRepository,
                principal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
              })
            : [];
        yield* context.assertCallerTurnActive();
        yield* assertCallerMayDriveThread(
          yield* requireThreadShell(context.callerThreadId),
          yield* requireThreadShell(threadId),
        );
        const followupCommandId = CommandId.makeUnsafe(`agent:${suffix}:send`);
        const admission =
          sourceMessages.length && hubGateway
            ? yield* hubGateway.service.admitFollowup({
                threadId: target.id,
                commandId: followupCommandId,
                messageId,
              })
            : null;
        const command = {
          type: "thread.turn.start",
          commandId: followupCommandId,
          threadId: target.id,
          message: {
            messageId,
            role: "user",
            text: sourceMessages.length
              ? renderHubWorkPrompt({ brief: message, sourceMessages })
              : message,
            attachments,
          },
          dispatchMode,
          dispatchOrigin: "agent",
          runtimeMode: target.runtimeMode,
          interactionMode: target.interactionMode,
          // A durable worker admission pins replay time. Source timestamps describe
          // quoted history, not when this new target turn was requested.
          createdAt: admission?.admittedAt ?? isoNow(),
        } satisfies OrchestrationCommand;
        yield* orchestrationEngine.dispatch(command).pipe(
          Effect.catchTag("OrchestrationCommandIdentityCollisionError", (error) =>
            Effect.gen(function* () {
              if (admission || !sourceMessages.length || !commandReceipts)
                return yield* Effect.fail(error);
              const receipt = yield* commandReceipts.getByCommandId({
                commandId: followupCommandId,
              });
              if (
                Option.isNone(receipt) ||
                receipt.value.status !== "accepted" ||
                receipt.value.aggregateKind !== "thread" ||
                receipt.value.aggregateId !== target.id
              ) {
                return yield* Effect.fail(error);
              }
              // An identical send may have committed after our snapshot read. Reuse
              // its durable time; the engine still validates the full command identity.
              return yield* orchestrationEngine.dispatch({
                ...command,
                createdAt: receipt.value.acceptedAt,
              });
            }),
          ),
          Effect.tapError(() =>
            admission && hubGateway
              ? hubGateway.service.releaseFailedFollowup({
                  workItemId: admission.id,
                  commandId: followupCommandId,
                  admittedAt: admission.admittedAt,
                  expectedRevision: admission.revision,
                })
              : Effect.void,
          ),
          Effect.mapError((error) => new ToolInputError(errorText(error))),
        );
        return mcpToolResultJson({ threadId: target.id, dispatched: dispatchMode });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            error instanceof GatewayToolError
              ? gatewayToolErrorResult(error)
              : mcpToolResultError(errorText(error)),
          ),
        ),
      ),
  };

  const interruptThread: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_interrupt_thread",
      description:
        "Interrupt the running turn of a Synara thread that has no active persistent goal. Agent-originated interrupts cannot stop an active goal; keep working, complete it, or report a genuine blocker through synara_set_thread_goal. A user can still stop the task from the interface.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread whose turn should be interrupted." },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Interrupt a Synara thread", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        // Stopping a higher-privileged thread's work is still driving it.
        yield* assertCallerMayDriveThread(caller, target);
        if ((target.goal ?? "").trim().length > 0 && target.goalPausedAt == null) {
          return yield* Effect.fail(
            new ToolInputError(
              `An agent cannot interrupt a thread while its persistent goal is active. Continue working, complete the goal, or report a genuine blocker with synara_set_thread_goal({ blocked: true }). The user can still stop the task from the interface.`,
            ),
          );
        }
        const activeTurnId = target.session?.activeTurnId ?? null;
        const hadActiveTurn = activeTurnId !== null || target.latestTurn?.state === "running";
        const dispatched = yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:interrupt`),
            threadId: target.id,
            ...agentCommandGuard(context),
            createdAt: isoNow(),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        // The interrupt is only *requested* here: the provider settles the turn
        // asynchronously. Reporting a constant `interrupted: true` told callers
        // the turn had stopped even when there was no turn to stop.
        return mcpToolResultJson({
          threadId: target.id,
          interruptRequested: true,
          hadActiveTurn,
          activeTurnId,
          eventSequence: dispatched.sequence,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const setThreadTitle: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_set_thread_title",
      description: "Rename a Synara thread.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to rename." },
          title: { type: "string", description: "New title." },
        },
        required: ["threadId", "title"],
        additionalProperties: false,
      },
      annotations: { title: "Rename a Synara thread", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const title = readStringArg(args, "title", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:rename`),
            threadId: target.id,
            title,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, title });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const setThreadPullRequest: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_set_thread_pull_request",
      description:
        "Associate a pull request with a Synara thread. Use this after successfully creating the pull request that represents that thread's own deliverable. Do not associate pull requests that the thread only reviews, references, or discusses. Defaults to your own thread when threadId is omitted.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Thread that owns the pull request. Defaults to your own thread.",
          },
          reference: {
            type: "string",
            description: "GitHub pull request URL or number resolvable from the thread repository.",
          },
        },
        required: ["reference"],
        additionalProperties: false,
      },
      annotations: { title: "Associate a pull request", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId") ?? context.callerThreadId;
        const reference = readStringArg(args, "reference", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);

        const project = Option.getOrUndefined(
          yield* snapshotQuery
            .getProjectShellById(target.projectId)
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error)))),
        );
        if (!project) {
          return yield* Effect.fail(
            new ToolInputError(`Project for thread "${threadId}" was not found.`),
          );
        }
        const cwd = resolveThreadWorkspaceCwd({ thread: target, projects: [project] });
        if (!cwd) {
          return yield* Effect.fail(
            new ToolInputError(`Git workspace for thread "${threadId}" is unavailable.`),
          );
        }

        const { pullRequest } = yield* gitManager
          .resolvePullRequest({ cwd, reference })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:pull-request`),
            threadId: target.id,
            lastKnownPr: pullRequest,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, pullRequest });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const setThreadArchived: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_set_thread_archived",
      description:
        "Archive or unarchive a Synara thread. Defaults to your own thread when threadId is omitted. An agent cannot archive a thread while its persistent goal is active; the user can still stop or archive it from the interface.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to archive/unarchive." },
          archived: { type: "boolean", description: "true to archive, false to unarchive." },
        },
        required: ["archived"],
        additionalProperties: false,
      },
      annotations: { title: "Update a Synara thread", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId") ?? context.callerThreadId;
        const archived = readBooleanArg(args, "archived");
        if (archived === undefined) {
          throw new ToolInputError(`Missing required argument "archived".`);
        }
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        if (archived && (target.goal ?? "").trim().length > 0 && target.goalPausedAt == null) {
          return yield* Effect.fail(
            new ToolInputError(
              `An agent cannot archive a thread while its persistent goal is active. Continue working, complete the goal, or report a genuine blocker with synara_set_thread_goal({ blocked: true }). The user can still stop or archive it from the interface.`,
            ),
          );
        }
        yield* orchestrationEngine
          .dispatch({
            type: archived ? "thread.archive" : "thread.unarchive",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:archive`),
            threadId: target.id,
            ...(archived ? agentCommandGuard(context) : {}),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        if (archived) {
          yield* Effect.forkDetach(
            pruneProjectedArchivedManagedWorktrees({
              homeDir: serverConfig.homeDir,
              worktreesDir: serverConfig.worktreesDir,
              snapshotQuery,
              git,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("agent gateway managed worktree retention failed", {
                  cause: String(cause),
                }),
              ),
            ),
          );
        }
        return mcpToolResultJson({ threadId: target.id, archived });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const setThreadGoal: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_set_thread_goal",
      description: `Set a persistent goal for a thread. Only set a goal when the user has explicitly asked for one (for example, 'keep working until X' or 'the goal of this thread is Y') or when dispatching a thread explicitly created to pursue a stated objective. Do NOT infer or invent goals from ordinary tasks or set one as a side effect of normal work. Clearing requires the same explicit user intent. Pursue active goals autonomously: resolve routine and reversible choices from available evidence, state material assumptions, and continue without optional questions or offers to continue. Ask only for indispensable information, consequential user decisions, or missing authorization; finish independent authorized work before waiting. Goals never grant additional permissions or authorize automatic approval. When the active goal's objective has been accomplished and verified, pass achieved: true instead of clearing: Synara records the achievement (with the time it took) and clears the goal. If an external blocker truly prevents meaningful progress, pass blocked: true once in that goal turn. Synara rejects the first ${THREAD_GOAL_BLOCK_ATTEMPT_LIMIT - 1} consecutive blocked-turn requests and keeps the goal active; only the ${THREAD_GOAL_BLOCK_ATTEMPT_LIMIT}th consecutive blocked goal turn pauses it. A goal turn without a block report resets the streak. Do not report blocked merely because the work is difficult, incomplete, or would benefit from clarification.`,
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Thread to update. Defaults to your own thread when omitted.",
          },
          goal: {
            type: ["string", "null"],
            maxLength: THREAD_GOAL_MAX_CHARS,
            description:
              "Persistent objective. Pass null or an empty string to clear it. Ignored when achieved or blocked is true.",
          },
          achieved: {
            type: "boolean",
            description:
              "Pass true when the active goal's objective has been accomplished. Records a goal achievement and clears the goal.",
          },
          blocked: {
            type: "boolean",
            description: `Pass true once in a goal turn only when an external blocker truly prevents meaningful progress. The first ${THREAD_GOAL_BLOCK_ATTEMPT_LIMIT - 1} consecutive requests are rejected; the ${THREAD_GOAL_BLOCK_ATTEMPT_LIMIT}th pauses the active goal.`,
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: { title: "Set a Synara thread goal", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId") ?? context.callerThreadId;
        if ("achieved" in args && typeof args.achieved !== "boolean") {
          return yield* Effect.fail(new ToolInputError(`Argument "achieved" must be a boolean.`));
        }
        if ("blocked" in args && typeof args.blocked !== "boolean") {
          return yield* Effect.fail(new ToolInputError(`Argument "blocked" must be a boolean.`));
        }
        const achieved = args.achieved === true;
        const blocked = args.blocked === true;
        if (achieved && blocked) {
          return yield* Effect.fail(
            new ToolInputError(`Arguments "achieved" and "blocked" are mutually exclusive.`),
          );
        }
        const goal = achieved || blocked ? "" : readThreadGoalArg(args);
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        if (target.id !== caller.id) {
          const settingFreshGoal =
            !achieved && !blocked && goal.length > 0 && (target.goal ?? "").trim().length === 0;
          if (!settingFreshGoal) {
            return yield* Effect.fail(
              new ToolInputError(
                `An agent can only assign a new goal to another thread that does not already own one. Only the goal thread itself can edit, clear, complete, or report a blocker for its persistent goal.`,
              ),
            );
          }
        }
        const blockTurnId = blocked ? context.callerTurnId : null;
        if ((achieved || blocked) && (target.goal ?? "").trim().length === 0) {
          return yield* Effect.fail(
            new ToolInputError(
              `Thread has no active goal to mark ${achieved ? "achieved" : "blocked"}.`,
            ),
          );
        }
        if (blocked && target.goalPausedAt != null) {
          return yield* Effect.fail(new ToolInputError(`Thread's active goal is already paused.`));
        }
        if (blocked && blockTurnId === null) {
          return yield* Effect.fail(
            new ToolInputError(
              `A blocked goal report requires an exact active provider turn on the goal's thread.`,
            ),
          );
        }
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:goal`),
            threadId: target.id,
            ...agentCommandGuard(context),
            ...(achieved
              ? { goalAchieved: true }
              : blocked
                ? {
                    goalBlockAttempt: true,
                    goalBlockTurnId: TurnId.makeUnsafe(blockTurnId!),
                  }
                : { goal }),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        if (blocked) {
          const updatedThread = (yield* orchestrationEngine.getReadModel()).threads.find(
            (candidate) => candidate.id === target.id,
          );
          const blockCount = updatedThread?.goalBlockCount ?? target.goalBlockCount ?? 0;
          const paused = updatedThread?.goalPausedAt != null;
          const details = {
            threadId: target.id,
            goal: target.goal,
            blocked: true,
            paused,
            blockCount,
            blockLimit: THREAD_GOAL_BLOCK_ATTEMPT_LIMIT,
            remainingBlockedTurns: Math.max(0, THREAD_GOAL_BLOCK_ATTEMPT_LIMIT - blockCount),
          };
          if (!paused) {
            return gatewayToolErrorResult(
              new GatewayToolError(
                "goal_block_refused",
                `Blocked goal report ${blockCount}/${THREAD_GOAL_BLOCK_ATTEMPT_LIMIT} recorded. Synara kept the goal active. Continue working or finish this turn; the next goal turn will start automatically. Report the blocker again only on a later goal turn if it still prevents meaningful progress.`,
                details,
              ),
            );
          }
          return mcpToolResultJson(details);
        }
        return mcpToolResultJson(
          achieved
            ? { threadId: target.id, goal: null, achieved: true }
            : { threadId: target.id, goal: goal || null },
        );
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const usageTools = makeAgentGatewayUsageTools({ loadProviderUsage });
  const automationTools = makeAgentGatewayAutomationTools({
    automationService,
    requireThreadShell,
    assertCallerMayDriveThread,
    resolveAutomationTarget,
    surfaceAutomationProposal: ({ callerThreadId, definition }) => {
      const createdAt = isoNow();
      return orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:automation-proposal`),
          threadId: callerThreadId,
          activity: buildAutomationProposalActivity({
            definition,
            proposalState: "pending",
          }),
          createdAt,
        })
        .pipe(Effect.asVoid);
    },
  });
  const memoryTools = makeAgentGatewayMemoryTools({ mindService, requireThreadShell });
  /**
   * The caller thread's canonical workspace root. Shared by the integrated
   * browser surface and the driver-backed `computer_browser_*` file-transfer
   * tools — both bound model-supplied paths to it.
   */
  const resolveWorkspaceRoot = (context: ToolContext) =>
    Effect.gen(function* () {
      const thread = yield* requireThreadShell(context.callerThreadId);
      const project = yield* snapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(Effect.map(Option.getOrNull));
      if (!project) return null;
      return (
        resolveThreadWorkspaceCwd({
          thread,
          projects: [project],
        }) ?? null
      );
    }).pipe(Effect.orElseSucceed(() => null));
  const browserTools = makeAgentGatewayBrowserTools(browserAutomationHost, {
    resolveWorkspaceRoot,
  });
  const mcpTools = providerService ? makeAgentGatewayMcpTools({ providerService }) : [];
  const projectAgentTools = makeProjectAgentTools({
    projectAgent: projectAgentService,
  });

  // One denial activity per (thread, turn, tool): agents typically retry the denied
  // tool several times in a row, and repeated cards would bury the chat — but a
  // second, different tool denied in the same turn is a different fact and earns
  // its own card. The decider appends activities verbatim, so the dedupe lives here.
  const surfacedComputerControlDenials = new Set<string>();
  const SURFACED_DENIALS_MAX = 512;
  const surfaceCapabilityDenial: NonNullable<
    Parameters<typeof makeAgentGatewayMcpTransport>[0]["onCapabilityDenied"]
  > = (denial) => {
    // Only computer control has a user-facing switch to point at; other
    // capability denials stay plain tool errors.
    if (denial.requiredCapability !== COMPUTER_CONTROL_CAPABILITY) return Effect.void;
    const dedupeKey = `${denial.callerThreadId}:${denial.callerTurnId ?? "no-turn"}:${denial.toolName}`;
    if (surfacedComputerControlDenials.has(dedupeKey)) return Effect.void;
    // FIFO eviction, not a wholesale clear: clearing forgets every live turn's
    // dedupe key at once and would let each of them surface a duplicate card.
    while (surfacedComputerControlDenials.size >= SURFACED_DENIALS_MAX) {
      surfacedComputerControlDenials.delete(surfacedComputerControlDenials.keys().next().value!);
    }
    surfacedComputerControlDenials.add(dedupeKey);
    const marker = stableGatewayDigest({
      kind: "computer-control-denied",
      threadId: denial.callerThreadId,
      turnId: denial.callerTurnId,
      // Part of the identity for the same reason it is part of the dedupe key:
      // two cards naming different tools are two different cards, and sharing
      // one command id would make the second a replay of the first.
      toolName: denial.toolName,
    });
    const createdAt = isoNow();
    return orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`agent:${marker}:computer-control-denied`),
        threadId: ThreadId.makeUnsafe(denial.callerThreadId),
        activity: {
          id: EventId.makeUnsafe(`gateway:${marker}:computer-control-denied`),
          tone: "error",
          kind: COMPUTER_CONTROL_DENIED_ACTIVITY_KIND,
          summary: "Computer control is off for this chat",
          payload: { toolName: denial.toolName },
          turnId: denial.callerTurnId === null ? null : TurnId.makeUnsafe(denial.callerTurnId),
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("agent gateway could not surface computer-control denial", {
            callerThreadId: denial.callerThreadId,
            toolName: denial.toolName,
            error: errorText(error),
          }),
        ),
        Effect.asVoid,
      );
  };

  // First mutation of a turn prepends a transcript line naming the switch.
  // The disclosure rides as its own activity so the chat says Computer
  // control is ON from the first input, once per turn.
  const COMPUTER_CONTROL_ON_DISCLOSURE =
    "Computer control ON for this turn: the agent is driving the desktop and the user can switch it off in Settings.";
  const surfacedComputerControlDisclosures = new Set<string>();
  const SURFACED_CONTROL_DISCLOSURES_MAX = 512;
  const surfaceComputerControlDisclosure = (
    threadId: string,
    turnId: string | null,
  ): Effect.Effect<void> => {
    const dedupeKey = `${threadId}:${turnId ?? "no-turn"}`;
    if (surfacedComputerControlDisclosures.has(dedupeKey)) return Effect.void;
    while (surfacedComputerControlDisclosures.size >= SURFACED_CONTROL_DISCLOSURES_MAX) {
      surfacedComputerControlDisclosures.delete(
        surfacedComputerControlDisclosures.keys().next().value!,
      );
    }
    surfacedComputerControlDisclosures.add(dedupeKey);
    const marker = stableGatewayDigest({
      kind: "computer-control-disclosure",
      threadId,
      turnId,
    });
    const createdAt = isoNow();
    return orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`agent:${marker}:computer-control-on`),
        threadId: ThreadId.makeUnsafe(threadId),
        activity: {
          id: EventId.makeUnsafe(`gateway:${marker}:computer-control-on`),
          tone: "info",
          kind: "computer.control-disclosure",
          summary: COMPUTER_CONTROL_ON_DISCLOSURE,
          payload: { disclosure: COMPUTER_CONTROL_ON_DISCLOSURE },
          turnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("agent gateway could not surface computer-control disclosure", {
            callerThreadId: threadId,
            error: errorText(error),
          }),
        ),
        Effect.asVoid,
      );
  };

  // One setup card per (thread, turn): an agent that hits a missing grant
  // typically retries the same tool several times in a row, and repeated cards
  // would bury the chat. The decider appends activities verbatim, so the dedupe
  // lives here.
  const surfacedComputerSetupPrompts = new Set<string>();
  const SURFACED_SETUP_PROMPTS_MAX = 512;
  const surfaceComputerSetupRequired = (input: {
    readonly toolName: string;
    readonly missing: readonly ComputerPermission[];
    readonly buildSignature?: ComputerBuildSignature;
    /** The app macOS holds responsible for the grants, when the desktop shell reported one. */
    readonly bundleId?: string;
    readonly context: ToolContext;
  }): Effect.Effect<void> => {
    const callerThreadId = input.context.callerThreadId;
    const callerTurnId = input.context.callerTurnId;
    // Keyed by which grants are missing as well as by the turn. One card per
    // turn is right for the same gap reported by ten calls; it was wrong for a
    // second, different gap discovered in the same turn — a run that lost
    // Accessibility after already reporting Screen Recording showed the user
    // one card naming the wrong permission and nothing about the other.
    const missingKey = [...input.missing].sort().join(",");
    const dedupeKey = `${callerThreadId}:${callerTurnId ?? "no-turn"}:${missingKey}`;
    if (surfacedComputerSetupPrompts.has(dedupeKey)) return Effect.void;
    // FIFO eviction, not a wholesale clear: clearing forgets every live turn's
    // dedupe key at once and would let each of them surface a duplicate card.
    while (surfacedComputerSetupPrompts.size >= SURFACED_SETUP_PROMPTS_MAX) {
      surfacedComputerSetupPrompts.delete(surfacedComputerSetupPrompts.keys().next().value!);
    }
    surfacedComputerSetupPrompts.add(dedupeKey);
    const marker = stableGatewayDigest({
      kind: "computer-setup-required",
      threadId: callerThreadId,
      turnId: callerTurnId,
      // Part of the identity for the same reason it is part of the dedupe key:
      // two cards naming different grants are two different cards, and sharing
      // one command id would make the second a replay of the first.
      missing: missingKey,
    });
    const createdAt = isoNow();
    return orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`agent:${marker}:computer-setup-required`),
        threadId: ThreadId.makeUnsafe(callerThreadId),
        activity: {
          id: EventId.makeUnsafe(`gateway:${marker}:computer-setup-required`),
          tone: "error",
          kind: COMPUTER_SETUP_REQUIRED_ACTIVITY_KIND,
          summary: "Computer control needs setup",
          // The grant names ride along so the card can say which permission is
          // missing rather than "a permission Synara needs"; an empty list is a
          // backend that refused without naming one, and the card falls back.
          // The build signature rides with them because on a locally built copy
          // the switch in System Settings can already be on — its grant pinned
          // to a binary a rebuild replaced — and the card has to say so.
          payload: {
            toolName: input.toolName,
            missing: [...input.missing],
            ...(input.buildSignature === undefined ? {} : { buildSignature: input.buildSignature }),
            ...(input.bundleId === undefined ? {} : { bundleId: input.bundleId }),
          } satisfies ComputerSetupRequiredPayload,
          turnId: callerTurnId === null ? null : TurnId.makeUnsafe(callerTurnId),
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("agent gateway could not surface a computer setup prompt", {
            callerThreadId,
            toolName: input.toolName,
            error: errorText(error),
          }),
        ),
        Effect.asVoid,
      );
  };

  /**
   * The approval card for one Computer or Device consent prompt: routine task
   * consent, visible-use consent, or a single-call approval (clipboard reads).
   * Device names share this path because provider-native permission bridges
   * cannot see MCP calls and would otherwise let a mutating device action run
   * unasked.
   */
  const publishComputerApproval =
    (
      name: string,
      args: Record<string, unknown>,
      context: Parameters<NonNullable<AgentGatewayComputerToolsOptions["authorizeAction"]>>[2],
      approvalScope: "computer-task" | "computer-foreground" | "device-task" | undefined,
    ) =>
    async (requestId: string, decision?: ProviderApprovalDecision): Promise<void> => {
      const deviceTool = name.startsWith("device_");
      const createdAt = isoNow();
      const eventKey = `${requestId}:${decision === undefined ? "open" : "resolved"}`;
      await Effect.runPromise(
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(eventKey),
          threadId: ThreadId.makeUnsafe(context.callerThreadId),
          activity: {
            id: EventId.makeUnsafe(eventKey),
            tone: "info",
            kind: decision === undefined ? "approval.requested" : "approval.resolved",
            summary:
              decision !== undefined
                ? `${deviceTool ? "Device" : "Computer"} approval resolved`
                : approvalScope === "computer-foreground"
                  ? "Show Computer on screen for this task"
                  : approvalScope === "device-task"
                    ? "Allow Device for this task"
                    : approvalScope === "computer-task"
                      ? "Allow Computer for this task"
                      : `${deviceTool ? "Device" : "Computer"} action needs approval`,
            payload: {
              requestId,
              requestKind: "tool",
              requestType: "tool",
              toolName: name,
              toolParamsDisplay: computerApprovalDisplayArgs(args),
              sessionApprovalAvailable: false,
              ...(approvalScope !== undefined ? { approvalScope } : {}),
              ...(decision === undefined ? {} : { decision }),
            },
            turnId: context.callerTurnId ? TurnId.makeUnsafe(context.callerTurnId) : null,
            createdAt,
          },
          createdAt,
        }),
      );
    };

  /**
   * The Computer approval path, shared by the desktop tools, the
   * driver-backed `computer_browser_*` family, and the device family — same
   * capability, same task-scoped consent, same disclosure. Browser and device
   * names take task consent like every other mutating computer tool.
   */
  const authorizeComputerAction: NonNullable<
    AgentGatewayComputerToolsOptions["authorizeAction"]
  > = async (name, args, context, signal) => {
    await Effect.runPromise(context.assertCallerTurnActive(), { signal });
    const caller = await Effect.runPromise(
      snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(context.callerThreadId)),
      { signal },
    );
    if (Option.isNone(caller)) return false;
    const deviceTool = name.startsWith("device_");
    // Computer capability is issued only after task activation. Full
    // access already consents to routine desktop actions, including
    // foreground delivery; focus is not a second approval boundary.
    if (caller.value.runtimeMode === "full-access") {
      if (!deviceTool) {
        await Effect.runPromise(
          surfaceComputerControlDisclosure(context.callerThreadId, context.callerTurnId),
          { signal },
        ).catch(() => undefined);
      }
      return true;
    }
    const taskConsent = name !== "computer_read_clipboard" && context.callerTurnId !== null;
    const requestApproval = taskConsent
      ? computerApprovalGate.requestTask.bind(computerApprovalGate)
      : computerApprovalGate.request.bind(computerApprovalGate);
    const approved = await requestApproval({
      threadId: context.callerThreadId,
      turnId: context.callerTurnId ?? "",
      signal,
      publish: publishComputerApproval(
        name,
        args,
        context,
        taskConsent ? (deviceTool ? "device-task" : "computer-task") : undefined,
      ),
    });
    if (approved && !deviceTool) {
      await Effect.runPromise(
        surfaceComputerControlDisclosure(context.callerThreadId, context.callerTurnId),
        { signal },
      ).catch(() => undefined);
    }
    return approved;
  };

  const {
    resolveForegroundAuthorization: resolveComputerForegroundAuthorization,
    requestForegroundConsent: requestComputerForegroundConsent,
  } = makeComputerForegroundConsent({
    gate: computerApprovalGate,
    loadMessages: async (threadId) => {
      const detail = await Effect.runPromise(
        snapshotQuery.getThreadDetailById(ThreadId.makeUnsafe(threadId)),
      );
      return Option.isNone(detail) ? undefined : detail.value.messages;
    },
    knownAppNames: () => computerService?.manager.observedAppNames() ?? [],
    publish: (name, args, context) =>
      publishComputerApproval(name, args, context, "computer-foreground"),
  });

  const resolveComputerSpaceDesignation: NonNullable<
    AgentGatewayComputerToolsOptions["resolveSpaceDesignation"]
  > = async (context) => {
    const detail = await Effect.runPromise(
      snapshotQuery.getThreadDetailById(ThreadId.makeUnsafe(context.callerThreadId)),
    );
    return Option.isNone(detail) ? [] : computerSpaceDesignationForMessages(detail.value.messages);
  };

  // Construct the browser family once so help reads the same conditional
  // catalog the gateway exposes; a desktop-only backend has no browser entries.
  const computerBrowserTools =
    computerService?.supported === true && computerService.manager.supportsBrowser
      ? makeAgentGatewayComputerBrowserTools({
          manager: computerService.manager,
          authorizeAction: authorizeComputerAction,
          resolveForegroundAuthorization: resolveComputerForegroundAuthorization,
          requestForegroundConsent: requestComputerForegroundConsent,
          resolveWorkspaceRoot,
        })
      : [];

  const kanbanTools = makeAgentGatewayKanbanTools({
    snapshotQuery,
    workspacePaths: {
      homeDir: serverConfig.homeDir,
      chatWorkspaceRoot: serverConfig.chatWorkspaceRoot,
    },
    helpers: {
      // Move-card re-reads and live-checks the target shell itself, so the
      // plain loader is correct for every column.
      requireThreadShell,
      assertCallerMayDriveThread,
      runCreateThreads,
      startTurn: ({ threadId, message, dispatchMode, runtimeMode, interactionMode }) => {
        const suffix = randomUUID();
        return orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`agent:${suffix}:kanban-move`),
            threadId: ThreadId.makeUnsafe(threadId),
            message: {
              messageId: MessageId.makeUnsafe(`agent:${suffix}:message`),
              role: "user",
              text: message,
              attachments: [],
            },
            dispatchMode,
            dispatchOrigin: "agent",
            runtimeMode,
            interactionMode,
            createdAt: isoNow(),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      },
      interruptTurn: ({ threadId }) => {
        const suffix = randomUUID();
        return orchestrationEngine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe(`agent:${suffix}:kanban-interrupt`),
            threadId: ThreadId.makeUnsafe(threadId),
            createdAt: isoNow(),
          })
          .pipe(
            Effect.map((eventSequence) => ({ sequence: eventSequence.sequence })),
            Effect.mapError((error) => new ToolInputError(errorText(error))),
          );
      },
      // Draft creation mirrors the creation saga's thread.create dispatch but
      // starts no turn, so the thread lands in the Draft column. No worktree
      // setup runs: drafts are local threads until a move dispatches them.
      createDraftThread: ({
        title,
        projectId,
        modelSelection,
        runtimeMode,
        interactionMode,
        sourceThreadId,
        sourceTurnId,
      }) => {
        const threadId = ThreadId.makeUnsafe(randomUUID());
        return orchestrationEngine
          .dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:kanban-draft`),
            threadId,
            projectId: ProjectId.makeUnsafe(projectId),
            title,
            modelSelection,
            runtimeMode,
            interactionMode,
            envMode: "local",
            branch: null,
            worktreePath: null,
            creationSource: "synara_mcp",
            sourceThreadId: ThreadId.makeUnsafe(sourceThreadId),
            ...(sourceTurnId !== null ? { sourceTurnId: TurnId.makeUnsafe(sourceTurnId) } : {}),
            createdAt: isoNow(),
          })
          .pipe(
            Effect.map(() => ({ threadId: String(threadId) })),
            Effect.mapError((error) => new ToolInputError(errorText(error))),
          );
      },
      // Card metadata patch for the update/goal tools — mirrors setThreadTitle.
      updateThreadMeta: ({ threadId, title, notes, goal }) =>
        orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:kanban-update`),
            threadId: ThreadId.makeUnsafe(threadId),
            ...(title !== undefined ? { title } : {}),
            ...(notes !== undefined ? { notes } : {}),
            ...(goal !== undefined ? { goal } : {}),
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError((error) => new ToolInputError(errorText(error))),
          ),
      deleteThread: ({ threadId }) =>
        orchestrationEngine
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:kanban-delete`),
            threadId: ThreadId.makeUnsafe(threadId),
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError((error) => new ToolInputError(errorText(error))),
          ),
    },
  });

  const tools: ReadonlyArray<ToolEntry> = [
    ...readTools,
    ...diagnosticTools,
    ...usageTools,
    createThreads,
    createThread,
    awaitThreads.tool,
    ...coordinatorQuestions.tools,
    sendMessage,
    interruptThread,
    setThreadTitle,
    setThreadPullRequest,
    setThreadArchived,
    setThreadGoal,
    ...automationTools,
    ...memoryTools,
    ...browserTools,
    ...mcpTools,
    ...kanbanTools,
    ...(deviceService?.supported === true
      ? makeAgentGatewayDeviceTools({
          manager: deviceService.manager,
          authorizeAction: authorizeComputerAction,
        })
      : []),
    ...(computerService?.supported === true
      ? makeAgentGatewayComputerTools({
          manager: computerService.manager,
          onSetupRequired: surfaceComputerSetupRequired,
          authorizeAction: authorizeComputerAction,
          resolveForegroundAuthorization: resolveComputerForegroundAuthorization,
          requestForegroundConsent: requestComputerForegroundConsent,
          resolveSpaceDesignation: resolveComputerSpaceDesignation,
          relatedTools: computerBrowserTools,
        })
      : []),
    ...computerBrowserTools,
    // Group tools are Beta-only: Stable does not offer them to agents at all.
    ...(isServerGroupsEnabled() ? [...projectAgentTools, ...(hubGateway?.tools ?? [])] : []),
  ];

  // The computer family by name, read off the unfiltered catalog above: a
  // caller whose session was never granted computer control still gets a
  // capability_denied (and the denial card) when it calls one of these by
  // name, even though tools/list never advertised them to it.
  const computerToolNames = new Set(
    tools
      .filter((tool) => tool.requiredCapability === COMPUTER_CONTROL_CAPABILITY)
      .map((tool) => tool.definition.name),
  );

  return {
    coordination,
    handleMcpPost: makeAgentGatewayMcpTransport({
      credentials,
      snapshotQuery,
      tools,
      onCapabilityDenied: surfaceCapabilityDenial,
      // Namespace-insensitive: a session that never saw the catalog reaches
      // for prefixed spellings (synara_computer_click,
      // mcp__synara__computer_click). Those must deny with the card, never die
      // as Unknown-tool. The exact set stays as a backstop for any catalog
      // computer name outside the static family list.
      isComputerToolName: (toolName) =>
        computerToolNames.has(toolName) || isSynaraComputerToolFamilyName(toolName),
      computerControlCapability: COMPUTER_CONTROL_CAPABILITY,
      instructions: AGENT_GATEWAY_INSTRUCTIONS,
      requireThreadShell,
    }),
  } satisfies AgentGatewayShape;
});

export const AgentGatewayLive = Layer.effect(AgentGateway, makeAgentGateway);
