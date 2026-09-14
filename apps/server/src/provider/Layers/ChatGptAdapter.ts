// FILE: Layers/ChatGptAdapter.ts
// Purpose: Provider adapter that runs Synara turns on a ChatGPT (Web)
//          conversation driven through the desktop-owned Synara browser.
// Layer: Server provider runtime
//
// The adapter owns three cooperating pieces already built around it:
// - ChatGptWebDriver (chatgptWeb/driver.ts): page actions and turn lifecycle.
// - ChatGptConnector (chatgptConnector): the MCP endpoint ChatGPT calls, and
//   the runtime registry that attributes those calls back to this thread.
// - ChatGptWorkerBroker (chatgptConnector/workers.ts): prime/worker chats.
//
// Turns are dispatched into a forked fiber: `sendTurn` returns as soon as the
// prompt is accepted onto the page, and the fiber streams item/content events
// and settles the turn with exactly one terminal `turn.completed`.

import * as crypto from "node:crypto";
import * as path from "node:path";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  RuntimeItemId,
  TurnId,
  type ProviderComposerCapabilities,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@synara/contracts";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";

import { BrowserAutomationHost } from "../../browserAutomation/Services/BrowserAutomationHost.ts";
import { ServerConfig } from "../../config.ts";
import { makeBoundedCallbackIngress } from "../boundedCallbackIngress.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderAdapterShape,
} from "../Services/ProviderAdapter.ts";
import {
  PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
  PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
  compactProviderRuntimeEventForIngress,
  type SizedProviderRuntimeEvent,
} from "../providerRuntimeEventIngress.ts";
import { ChatGptAdapter, type ChatGptAdapterShape } from "../Services/ChatGptAdapter.ts";
import {
  ChatGptConnector,
  type ChatGptConnectorShape,
} from "../chatgptConnector/Services/ChatGptConnector.ts";
import { ChatGptWorkerBroker } from "../chatgptConnector/workers.ts";
import { ExecSessionManager } from "../chatgptConnector/tools/execSessions.ts";
import { ChatGptWebDriver, ChatGptDriverFailure } from "../chatgptWeb/driver.ts";
import {
  rateLimitCooldownUntil,
  rateLimitRetryHintMessage,
  rateLimitedTurnMessage,
  remainingRateLimitCooldownMs,
} from "../chatgptWeb/rateLimit.ts";
import { buildConversationPreamble } from "../chatgptConnector/instructions.ts";
import { ChatGptWorkerRateLimitedError } from "../chatgptConnector/workers.ts";
import type { ChatGptBrowserRpc, ChatGptConversationRef } from "../chatgptWeb/types.ts";

const PROVIDER = "chatgpt" as const;
const DEFAULT_MAX_WORKERS = 2;

export function makeChatGptRuntimeEventBase(input: {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  readonly eventId?: EventId;
  readonly createdAt?: string;
}) {
  return {
    eventId: input.eventId ?? EventId.makeUnsafe(crypto.randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.lifecycleGeneration !== undefined
      ? { lifecycleGeneration: input.lifecycleGeneration }
      : {}),
  };
}

function settleSession(context: ChatGptSessionContext): void {
  context.session = {
    ...context.session,
    status: context.activeTurn ? "running" : "ready",
    activeTurnId: context.activeTurn?.turnId,
    updatedAt: new Date().toISOString(),
  };
}

function computeDelta(
  previous: string,
  next: string,
): { readonly kind: "none" | "append" | "replace"; readonly text: string } {
  if (next === previous) return { kind: "none", text: "" };
  if (next.startsWith(previous)) return { kind: "append", text: next.slice(previous.length) };
  return { kind: "replace", text: next };
}

export interface ChatGptAdapterDependencies {
  readonly createDriver?: (input: { readonly threadId: ThreadId }) => ChatGptWebDriver;
  readonly resolveMaxWorkers?: () => Effect.Effect<number>;
}

interface ChatGptTurnState {
  readonly turnId: TurnId;
  readonly submittedText: string;
  fiber: Fiber.Fiber<unknown, unknown> | null;
  terminalEmitted: boolean;
}

interface ChatGptSessionContext {
  session: ProviderSession;
  readonly lifecycleGeneration: string | undefined;
  readonly workspaceRoot: string;
  readonly driver: ChatGptWebDriver;
  readonly broker: ChatGptWorkerBroker;
  readonly exec: ExecSessionManager;
  conversation: ChatGptConversationRef | null;
  model: string;
  reasoningEffort: string | undefined;
  preambleSent: boolean;
  activeTurn: ChatGptTurnState | null;
  stopped: boolean;
  /** Wall-clock deadline before a new turn is attempted after an access limit. */
  rateLimitedUntilMs: number | null;
}

const messageFromCause = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim() ? cause.message : fallback;

const toAdapterError = (
  operation: string,
  threadId: ThreadId,
  error: unknown,
): ProviderAdapterError => {
  if (error instanceof ChatGptDriverFailure) {
    if (error.code === "busy" || error.code === "send-failed") {
      return new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation,
        issue: error.message,
        cause: error,
      });
    }
    return new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: operation,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: operation,
    detail: messageFromCause(error, `ChatGPT ${operation} failed.`),
    cause: error,
  });
};

export const makeChatGptAdapter = (dependencies: ChatGptAdapterDependencies = {}) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const browserHost = yield* BrowserAutomationHost;
    const connector: ChatGptConnectorShape = yield* ChatGptConnector;
    const resolveMaxWorkers =
      dependencies.resolveMaxWorkers ?? (() => Effect.succeed(DEFAULT_MAX_WORKERS));

    const eventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    const sessions = new Map<ThreadId, ChatGptSessionContext>();

    const eventIngress = yield* makeBoundedCallbackIngress<SizedProviderRuntimeEvent, never, never>(
      (item) => Queue.offer(eventQueue, item.event).pipe(Effect.asVoid),
      {
        capacity: PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
        maxBufferedBytes: PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
        terminalReserve: PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
        isTerminal: (item) =>
          item.event.type === "turn.completed" || item.event.type === "session.exited",
        sizeOf: (item) => item.bytes,
      },
    );

    const offer = (event: ProviderRuntimeEvent) => {
      eventIngress.offer(compactProviderRuntimeEventForIngress(event));
    };

    const base = (
      context: ChatGptSessionContext,
      options?: { readonly includeTurn?: boolean; readonly itemId?: RuntimeItemId },
    ) => ({
      ...makeChatGptRuntimeEventBase({
        threadId: context.session.threadId,
        ...(context.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: context.lifecycleGeneration }
          : {}),
      }),
      ...(options?.includeTurn !== false && context.activeTurn
        ? { turnId: context.activeTurn.turnId }
        : {}),
      ...(options?.itemId ? { itemId: options.itemId } : {}),
      ...(context.conversation?.url
        ? { providerRefs: { providerThreadId: context.conversation.url } }
        : {}),
    });

    const hostRpcFor = (threadId: ThreadId, workspaceRoot: string): ChatGptBrowserRpc => ({
      call: ({ name, args, timeoutMs }) =>
        Effect.runPromise(
          browserHost.execute({
            sessionKey: `chatgpt-web:${threadId}`,
            provider: PROVIDER,
            threadId,
            name,
            arguments: args,
            workspaceRoot,
            timeoutMs: Math.max(100, Math.min(30_000, timeoutMs ?? 20_000)),
          }),
        ),
    });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<ChatGptSessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const emitTurnCompleted = (
      context: ChatGptSessionContext,
      turn: ChatGptTurnState,
      payload: {
        readonly state: "completed" | "failed" | "interrupted" | "cancelled";
        readonly stopReason?: string;
        readonly errorMessage?: string;
      },
    ) => {
      if (turn.terminalEmitted) return;
      turn.terminalEmitted = true;
      offer({
        ...makeChatGptRuntimeEventBase({
          threadId: context.session.threadId,
          ...(context.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: context.lifecycleGeneration }
            : {}),
        }),
        turnId: turn.turnId,
        type: "turn.completed",
        payload: {
          state: payload.state,
          stopReason: payload.stopReason ?? null,
          ...(payload.errorMessage ? { errorMessage: payload.errorMessage } : {}),
        },
      } satisfies ProviderRuntimeEvent);
      context.session = {
        ...context.session,
        status: payload.state === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        resumeCursor: context.conversation?.url ?? context.session.resumeCursor,
        updatedAt: new Date().toISOString(),
        ...(payload.errorMessage ? { lastError: payload.errorMessage } : {}),
      };
      context.activeTurn = null;
      connector.registry.endTurn(String(context.session.threadId));
    };

    const noteRateLimit = (context: ChatGptSessionContext): void => {
      context.rateLimitedUntilMs = rateLimitCooldownUntil(Date.now());
    };

    const emitRuntimeWarning = (context: ChatGptSessionContext | null, detail: string) => {
      if (!context) return;
      offer({
        ...base(context, { includeTurn: true }),
        type: "runtime.warning",
        payload: { message: detail },
      } satisfies ProviderRuntimeEvent);
    };

    const runTurn = (
      context: ChatGptSessionContext,
      turn: ChatGptTurnState,
      promptText: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const conversation = context.conversation;
        if (!conversation) {
          emitTurnCompleted(context, turn, {
            state: "failed",
            stopReason: "error",
            errorMessage: "No ChatGPT conversation is attached to this session.",
          });
          return;
        }

        const sent = yield* Effect.tryPromise({
          try: () => context.driver.sendPrompt(conversation, promptText),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) => {
            if (error instanceof ChatGptDriverFailure && error.code === "rate-limited") {
              noteRateLimit(context);
            }
            emitTurnCompleted(context, turn, {
              state: "failed",
              stopReason:
                error instanceof ChatGptDriverFailure && error.code === "rate-limited"
                  ? "rate_limit"
                  : "error",
              errorMessage: messageFromCause(error, "The prompt could not be sent."),
            });
            return Effect.succeed(null);
          }),
        );
        if (sent === null) return;
        if (!sent.accepted) {
          emitTurnCompleted(context, turn, {
            state: "failed",
            stopReason: "error",
            errorMessage:
              "ChatGPT did not accept the prompt (no user message appeared). Check the conversation tab in Synara.",
          });
          return;
        }

        let itemId = RuntimeItemId.makeUnsafe(`chatgpt-${turn.turnId}-assistant`);
        let itemOpen = false;
        let streamed = "";

        const openItem = () => {
          if (itemOpen) return;
          itemOpen = true;
          offer({
            ...base(context, { itemId }),
            type: "item.started",
            payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
          } satisfies ProviderRuntimeEvent);
        };

        const completion = yield* Effect.tryPromise({
          try: () =>
            context.driver.waitForCompletion(conversation, promptText, {
              onText: (text) => {
                const delta = computeDelta(streamed, text);
                if (delta.kind === "none") return;
                if (delta.kind === "replace" && itemOpen) {
                  offer({
                    ...base(context, { itemId }),
                    type: "item.completed",
                    payload: {
                      itemType: "assistant_message",
                      status: "completed",
                      title: "Assistant",
                    },
                  } satisfies ProviderRuntimeEvent);
                  itemId = RuntimeItemId.makeUnsafe(`chatgpt-${turn.turnId}-assistant-2`);
                  itemOpen = false;
                }
                openItem();
                offer({
                  ...base(context, { itemId }),
                  type: "content.delta",
                  payload: { streamKind: "assistant_text", delta: delta.text },
                } satisfies ProviderRuntimeEvent);
                streamed = text;
              },
            }),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) => {
            emitTurnCompleted(context, turn, {
              state: "failed",
              stopReason: "error",
              errorMessage: messageFromCause(error, "The ChatGPT turn failed."),
            });
            return Effect.succeed(null);
          }),
        );
        if (completion === null) return;

        const finalText = completion.text.trim().length > 0 ? completion.text : streamed;
        const remaining = computeDelta(streamed, finalText);
        if (remaining.kind !== "none") {
          if (remaining.kind === "replace" && itemOpen) {
            offer({
              ...base(context, { itemId }),
              type: "item.completed",
              payload: { itemType: "assistant_message", status: "completed", title: "Assistant" },
            } satisfies ProviderRuntimeEvent);
            itemId = RuntimeItemId.makeUnsafe(`chatgpt-${turn.turnId}-assistant-final`);
            itemOpen = false;
          }
          openItem();
          offer({
            ...base(context, { itemId }),
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: remaining.text },
          } satisfies ProviderRuntimeEvent);
          streamed = finalText;
        }
        if (itemOpen) {
          offer({
            ...base(context, { itemId }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant",
              data: { text: streamed },
            },
          } satisfies ProviderRuntimeEvent);
        }

        switch (completion.outcome) {
          case "rate_limited":
            noteRateLimit(context);
            emitTurnCompleted(context, turn, {
              state: "failed",
              stopReason: "rate_limit",
              errorMessage: rateLimitedTurnMessage(completion.observation.rateLimitText),
            });
            break;
          case "completed":
            emitTurnCompleted(context, turn, { state: "completed", stopReason: "model_stop" });
            break;
          case "interrupted":
            emitTurnCompleted(context, turn, { state: "interrupted", stopReason: "interrupted" });
            break;
          case "stalled":
            emitTurnCompleted(context, turn, {
              state: "completed",
              stopReason: "stalled",
            });
            break;
          case "failed":
            emitTurnCompleted(context, turn, {
              state: "failed",
              stopReason: "error",
              errorMessage: completion.observation.errorText ?? "ChatGPT reported an error.",
            });
            break;
          case "timeout":
            emitTurnCompleted(context, turn, {
              state: "failed",
              stopReason: "error",
              errorMessage: "The ChatGPT turn did not settle before the completion timeout.",
            });
            break;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            emitTurnCompleted(context, turn, {
              state: "failed",
              stopReason: "error",
              errorMessage: messageFromCause(cause, "The ChatGPT turn crashed."),
            });
          }),
        ),
      );

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopSession(existing.session.threadId);
        }

        const workspaceRoot = path.resolve(input.cwd ?? serverConfig.cwd);
        const modelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = modelSelection?.model ?? DEFAULT_MODEL_BY_PROVIDER.chatgpt;
        const reasoningEffort = modelSelection?.options?.reasoningEffort;
        const resumeUrl = typeof input.resumeCursor === "string" ? input.resumeCursor : undefined;
        const startOptions = input.providerOptions?.chatgpt;
        const maxWorkers = yield* resolveMaxWorkers();

        let contextRef: ChatGptSessionContext | null = null;
        const driver =
          dependencies.createDriver?.({ threadId: input.threadId }) ??
          new ChatGptWebDriver({
            rpc: hostRpcFor(input.threadId, workspaceRoot),
            onLoginRequired: () =>
              emitRuntimeWarning(
                contextRef,
                "ChatGPT is showing its sign-in page. Sign in to chatgpt.com in the Synara browser; Synara is waiting and continues automatically once you are signed in.",
              ),
          });
        const broker = new ChatGptWorkerBroker({
          workspaceRoot,
          maxWorkers,
          openWorkerConversation: (opts) => driver.openFreshConversation(opts),
          sendPrompt: async (ref, text) => {
            try {
              const result = await driver.sendPrompt(ref, text);
              if (!result.accepted) {
                throw new Error("A worker prompt was not accepted by the ChatGPT page.");
              }
            } catch (error) {
              if (error instanceof ChatGptDriverFailure && error.code === "rate-limited") {
                if (contextRef) noteRateLimit(contextRef);
                throw new ChatGptWorkerRateLimitedError(error.message);
              }
              throw error;
            }
          },
          waitForWorkerTurn: async (ref, submitted, onGenerating) => {
            const completion = await driver.waitForCompletion(ref, submitted, {
              onText: (_text, observation) => onGenerating(observation.generating),
            });
            onGenerating(false);
            if (completion.outcome === "rate_limited") {
              if (contextRef) noteRateLimit(contextRef);
              throw new ChatGptWorkerRateLimitedError(
                completion.observation.rateLimitText ?? "ChatGPT is temporarily limiting access.",
              );
            }
            return completion.text;
          },
          onNotice: (notice) => emitRuntimeWarning(contextRef, notice),
        });
        const exec = new ExecSessionManager();

        const conversation = yield* Effect.tryPromise({
          try: () =>
            driver.ensureConversation({
              ...(resumeUrl ? { existingUrl: resumeUrl } : {}),
              ...(startOptions?.browserUrl ? { openUrl: startOptions.browserUrl } : {}),
            }),
          catch: (error) => toAdapterError("session/start", input.threadId, error),
        });

        const now = new Date().toISOString();
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: workspaceRoot,
          model,
          threadId: input.threadId,
          resumeCursor: conversation.url,
          createdAt: now,
          updatedAt: now,
        };
        const context: ChatGptSessionContext = {
          session,
          lifecycleGeneration: input.lifecycleGeneration,
          workspaceRoot,
          driver,
          broker,
          exec,
          conversation,
          model,
          reasoningEffort,
          preambleSent: false,
          activeTurn: null,
          stopped: false,
          rateLimitedUntilMs: null,
        };
        contextRef = context;
        sessions.set(input.threadId, context);
        connector.registry.register({
          threadId: String(input.threadId),
          workspaceRoot,
          agents: broker,
          exec,
        });

        offer({
          ...makeChatGptRuntimeEventBase({
            threadId: input.threadId,
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
          }),
          type: "session.started",
          payload: {
            message: "ChatGPT (Web) session attached to the Synara browser.",
            ...(conversation.url ? { resume: conversation.url } : {}),
          },
        } satisfies ProviderRuntimeEvent);
        offer({
          ...makeChatGptRuntimeEventBase({
            threadId: input.threadId,
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
          }),
          type: "thread.started",
          payload: {
            ...(conversation.url ? { providerThreadId: conversation.url } : {}),
            model,
            ...(reasoningEffort ? { reasoningEffort } : {}),
          },
        } satisfies ProviderRuntimeEvent);

        return session;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      requireSession(input.threadId).pipe(
        Effect.flatMap((context) =>
          Effect.gen(function* () {
            if (context.stopped) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "turn/start",
                issue: "The ChatGPT session is closed.",
              });
            }
            const cooldownRemaining = remainingRateLimitCooldownMs(
              context.rateLimitedUntilMs,
              Date.now(),
            );
            if (cooldownRemaining > 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "turn/start",
                issue: rateLimitRetryHintMessage(cooldownRemaining),
              });
            }
            if (context.activeTurn) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "turn/start",
                issue: "A ChatGPT turn is already active for this thread.",
              });
            }
            if ((input.attachments?.length ?? 0) > 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "turn/start",
                issue: "Attachments are not supported by the ChatGPT (Web) provider yet.",
              });
            }
            const text = input.input?.trim() ?? "";
            if (text.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "turn/start",
                issue: "A non-empty prompt is required.",
              });
            }

            const modelSelection =
              input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
            if (modelSelection?.model && modelSelection.model !== context.model) {
              const next = yield* Effect.tryPromise({
                try: () =>
                  context.driver.openFreshConversation({
                    model: modelSelection.model,
                    ...(modelSelection.options?.reasoningEffort
                      ? { reasoningEffort: modelSelection.options.reasoningEffort }
                      : {}),
                  }),
                catch: (error) => toAdapterError("turn/start", input.threadId, error),
              });
              context.conversation = next;
              context.model = modelSelection.model;
              context.reasoningEffort = modelSelection.options?.reasoningEffort;
              context.preambleSent = false;
              context.session = {
                ...context.session,
                model: modelSelection.model,
                resumeCursor: next.url,
                updatedAt: new Date().toISOString(),
              };
            } else if (
              modelSelection?.options?.reasoningEffort &&
              modelSelection.options.reasoningEffort !== context.reasoningEffort
            ) {
              // Reasoning changes apply to the next fresh conversation; ChatGPT
              // does not expose a live switch in an existing chat.
              context.reasoningEffort = modelSelection.options.reasoningEffort;
            }

            const turnId = TurnId.makeUnsafe(crypto.randomUUID());
            const begin = connector.registry.beginTurn(String(input.threadId), String(turnId));
            if (!begin.ok) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "turn/start",
                issue: begin.message,
              });
            }

            const inbox = context.broker.drainInbox(String(input.threadId));
            const preamble = context.preambleSent
              ? ""
              : `${buildConversationPreamble(context.workspaceRoot)}\n\n`;
            const notes = inbox.length > 0 ? `Updates from your workers:\n${inbox}\n\n` : "";
            const promptText = `${preamble}${notes}${text}`;
            context.preambleSent = true;

            const turn: ChatGptTurnState = {
              turnId,
              submittedText: text,
              fiber: null,
              terminalEmitted: false,
            };
            context.activeTurn = turn;
            settleSession(context);

            offer({
              ...base(context, { includeTurn: false }),
              turnId,
              type: "turn.started",
              payload: {
                model: context.model,
                ...(context.reasoningEffort ? { effort: context.reasoningEffort } : {}),
              },
            } satisfies ProviderRuntimeEvent);

            const fiber = yield* runTurn(context, turn, promptText).pipe(
              Effect.forkChild({ startImmediately: true }),
            );
            turn.fiber = fiber;

            return {
              threadId: input.threadId,
              turnId,
              ...(context.conversation?.url ? { resumeCursor: context.conversation.url } : {}),
            };
          }),
        ),
      );

    const interruptTurn: ChatGptAdapterShape["interruptTurn"] = (threadId, turnId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.gen(function* () {
            const turn = context.activeTurn;
            if (!turn) return;
            if (turnId !== undefined && String(turn.turnId) !== String(turnId)) return;
            emitTurnCompleted(context, turn, { state: "interrupted", stopReason: "interrupted" });
            if (context.conversation) {
              yield* Effect.promise(() => context.driver.interrupt(context.conversation!)).pipe(
                Effect.catchCause(() => Effect.void),
              );
            }
            if (turn.fiber) {
              yield* Fiber.interrupt(turn.fiber).pipe(Effect.catchCause(() => Effect.void));
            }
            settleSession(context);
          }),
        ),
      );

    const stopSessionInternal = (context: ChatGptSessionContext) =>
      Effect.gen(function* () {
        context.stopped = true;
        const turn = context.activeTurn;
        if (turn) {
          emitTurnCompleted(context, turn, { state: "cancelled", stopReason: "session_stop" });
          if (turn.fiber) {
            yield* Fiber.interrupt(turn.fiber).pipe(Effect.catchCause(() => Effect.void));
          }
        }
        context.exec.killAll();
        context.broker.forgetThread(String(context.session.threadId));
        connector.registry.endTurn(String(context.session.threadId));
        connector.registry.unregister(String(context.session.threadId));
      });

    const stopSession: ChatGptAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        yield* stopSessionInternal(context);
        sessions.delete(threadId);
        offer({
          ...makeChatGptRuntimeEventBase({ threadId }),
          type: "session.exited",
          payload: { reason: "Session stopped." },
        } satisfies ProviderRuntimeEvent);
      });

    const stopAll: ChatGptAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        // Deleting the current entry while iterating Map keys is safe.
        for (const threadId of sessions.keys()) {
          yield* stopSession(threadId);
        }
      });

    const snapshot = (context: ChatGptSessionContext) => ({
      threadId: context.session.threadId,
      cwd: context.workspaceRoot,
      turns: context.activeTurn
        ? [{ id: context.activeTurn.turnId, items: [] as ReadonlyArray<unknown> }]
        : ([] as ReadonlyArray<{ id: TurnId; items: ReadonlyArray<unknown> }>),
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const context of sessions.values()) {
          context.exec.killAll();
          connector.registry.endTurn(String(context.session.threadId));
          connector.registry.unregister(String(context.session.threadId));
          void context.activeTurn?.fiber;
        }
      }),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
        conversationRollback: "restart-session",
        supportsRuntimeModelList: false,
        supportsTurnSteering: false,
        supportsLiveTurnDiffPatch: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (threadId) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "request/respond",
            detail: `ChatGPT (Web) does not expose interactive approval requests for ${threadId}.`,
          }),
        ),
      respondToUserInput: (threadId) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input/respond",
            detail: `ChatGPT (Web) does not expose user-input requests for ${threadId}.`,
          }),
        ),
      stopSession,
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) => requireSession(threadId).pipe(Effect.map(snapshot)),
      rollbackThread: (threadId) =>
        requireSession(threadId).pipe(
          Effect.map((context) => {
            context.conversation = null;
            context.preambleSent = false;
            context.session = {
              ...context.session,
              resumeCursor: undefined,
              updatedAt: new Date().toISOString(),
            };
            return snapshot(context);
          }),
        ),
      stopAll,
      getComposerCapabilities: () =>
        Effect.succeed({
          provider: PROVIDER,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: false,
          supportsThreadCompaction: false,
          supportsThreadImport: false,
        } satisfies ProviderComposerCapabilities),
      get streamEvents() {
        return Stream.fromQueue(eventQueue);
      },
    } satisfies ChatGptAdapterShape;
  });

export function makeChatGptAdapterLive(dependencies: ChatGptAdapterDependencies = {}) {
  return Layer.effect(ChatGptAdapter, makeChatGptAdapter(dependencies));
}
