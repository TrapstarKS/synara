// FILE: Layers/ChatGptAdapter.ts
// Purpose: Provider adapter that runs Synara turns on a ChatGPT (Web)
//          conversation driven through the user's default browser.
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
import { ChatGptExternalBrowser } from "../chatgptConnector/Services/ChatGptExternalBrowser.ts";
import { ChatGptWorkerBroker, type ChatGptWorkerEvent } from "../chatgptConnector/workers.ts";
import { sessionTagForThread } from "../chatgptConnector/runtime.ts";
import { ExecSessionManager } from "../chatgptConnector/tools/execSessions.ts";
import { ChatGptWebDriver, ChatGptDriverFailure } from "../chatgptWeb/driver.ts";
import {
  rateLimitCooldownUntil,
  rateLimitRetryHintMessage,
  rateLimitedTurnMessage,
  remainingRateLimitCooldownMs,
} from "../chatgptWeb/rateLimit.ts";
import {
  buildConversationPreamble,
  buildSessionTagReminder,
} from "../chatgptConnector/instructions.ts";
import { ChatGptWorkerRateLimitedError } from "../chatgptConnector/workers.ts";
import type { ChatGptBrowserRpc, ChatGptConversationRef } from "../chatgptWeb/types.ts";
import { prependChatGptPromptContext } from "../chatgptWeb/userPrompt.ts";

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

const excerpt = (value: string, max = 400): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;

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

interface ChatGptWorkerRuntimeTurn {
  readonly workerId: string;
  readonly turnId: TurnId;
  readonly parentTurnId: TurnId;
  readonly parentItemId: RuntimeItemId;
  childItemId: RuntimeItemId;
  streamed: string;
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
  readonly workerTurns: Map<string, ChatGptWorkerRuntimeTurn>;
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
    const externalBrowser = yield* ChatGptExternalBrowser;
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
      options?: {
        readonly includeTurn?: boolean;
        readonly itemId?: RuntimeItemId;
        readonly turnId?: TurnId;
        readonly parentTurnId?: TurnId;
        readonly providerRefs?: NonNullable<ProviderRuntimeEvent["providerRefs"]>;
      },
    ) => ({
      ...makeChatGptRuntimeEventBase({
        threadId: context.session.threadId,
        ...(context.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: context.lifecycleGeneration }
          : {}),
      }),
      ...(options?.turnId
        ? { turnId: options.turnId }
        : options?.includeTurn !== false && context.activeTurn
          ? { turnId: context.activeTurn.turnId }
          : {}),
      ...(options?.parentTurnId ? { parentTurnId: options.parentTurnId } : {}),
      ...(options?.itemId ? { itemId: options.itemId } : {}),
      ...(options?.providerRefs
        ? { providerRefs: options.providerRefs }
        : context.conversation?.url
          ? { providerRefs: { providerThreadId: context.conversation.url } }
          : {}),
    });

    const externalRpcFor = (threadId: ThreadId): ChatGptBrowserRpc => ({
      call: ({ name, args, timeoutMs }) =>
        externalBrowser.execute({
          threadId,
          name,
          args,
          timeoutMs: Math.max(100, Math.min(30_000, timeoutMs ?? 20_000)),
        }),
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

    const emitWorkerEvent = (context: ChatGptSessionContext, event: ChatGptWorkerEvent): void => {
      const parentProviderThreadId =
        context.conversation?.url ?? `chatgpt:${String(context.session.threadId)}`;
      const parentTurnId = TurnId.makeUnsafe(event.parentTurnId);
      const childTurnId = TurnId.makeUnsafe(event.turnId);
      const parentItemId = RuntimeItemId.makeUnsafe(
        `chatgpt-${event.parentTurnId}-worker-${event.workerId}-${event.turnId}`,
      );
      const childRefs = {
        providerThreadId: event.workerId,
        providerParentThreadId: parentProviderThreadId,
        providerTurnId: event.turnId,
        parentProviderTurnId: event.parentTurnId,
      };
      const parentRefs = {
        providerThreadId: parentProviderThreadId,
        providerTurnId: event.parentTurnId,
      };
      const key = `${event.workerId}:${event.turnId}`;
      const identity = {
        threadId: event.workerId,
        agentId: event.workerId,
        agentNickname: event.label,
        prompt: event.task,
        ...(event.model ? { model: event.model } : {}),
        ...(event.reasoningEffort ? { effort: event.reasoningEffort } : {}),
      };
      const workerData = (
        status: "running" | "completed" | "failed",
        extra?: Record<string, unknown>,
      ): Record<string, unknown> => ({
        toolCallId: String(parentItemId),
        callId: String(parentItemId),
        toolName: "agents",
        input: {
          action: "spawn",
          workers: [
            {
              label: event.label,
              task: event.task,
              ...(event.model ? { model: event.model } : {}),
              ...(event.reasoningEffort ? { reasoning_effort: event.reasoningEffort } : {}),
            },
          ],
        },
        receiverThreadId: event.workerId,
        receiverThreadIds: [event.workerId],
        receiverAgents: [identity],
        agentStates: {
          [event.workerId]: {
            threadId: event.workerId,
            agentId: event.workerId,
            nickname: event.label,
            prompt: event.task,
            status,
            ...(event.type === "text" && event.text.length > 0
              ? { latestUpdate: excerpt(event.text, 400) }
              : {}),
            ...(event.type === "turn.completed" && event.text.length > 0
              ? { message: excerpt(event.text, 400) }
              : {}),
            ...(event.type === "turn.completed" && event.errorMessage
              ? { message: excerpt(event.errorMessage, 400) }
              : {}),
          },
        },
        ...extra,
      });

      if (event.type === "turn.started") {
        const state: ChatGptWorkerRuntimeTurn = {
          workerId: event.workerId,
          turnId: childTurnId,
          parentTurnId,
          parentItemId,
          childItemId: RuntimeItemId.makeUnsafe(
            `chatgpt-${event.workerId}-${event.turnId}-assistant`,
          ),
          streamed: "",
        };
        context.workerTurns.set(key, state);

        // Materialize the collab item before routing any child event. Ingestion
        // uses this payload to create the visible subagent thread and strip row.
        offer({
          ...base(context, {
            includeTurn: false,
            turnId: parentTurnId,
            itemId: parentItemId,
            providerRefs: parentRefs,
          }),
          type: "item.started",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "inProgress",
            title: event.label,
            detail: event.task,
            data: workerData("running"),
          },
        } satisfies ProviderRuntimeEvent);
        offer({
          ...base(context, {
            includeTurn: false,
            parentTurnId,
            providerRefs: childRefs,
          }),
          type: "thread.started",
          payload: {
            providerThreadId: event.workerId,
            name: event.label,
            ...(event.model ? { model: event.model } : {}),
            ...(event.reasoningEffort ? { reasoningEffort: event.reasoningEffort } : {}),
          },
        } satisfies ProviderRuntimeEvent);
        offer({
          ...base(context, {
            includeTurn: false,
            turnId: childTurnId,
            parentTurnId,
            providerRefs: childRefs,
          }),
          type: "turn.started",
          payload: {
            ...(event.model ? { model: event.model } : {}),
            ...(event.reasoningEffort ? { effort: event.reasoningEffort } : {}),
          },
        } satisfies ProviderRuntimeEvent);
        offer({
          ...base(context, {
            includeTurn: false,
            turnId: childTurnId,
            parentTurnId,
            itemId: state.childItemId,
            providerRefs: childRefs,
          }),
          type: "item.started",
          payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
        } satisfies ProviderRuntimeEvent);
        return;
      }

      const state = context.workerTurns.get(key);
      if (!state) return;

      const emitChildText = (nextText: string): void => {
        const delta = computeDelta(state.streamed, nextText);
        if (delta.kind === "none") return;
        if (delta.kind === "replace") {
          offer({
            ...base(context, {
              includeTurn: false,
              turnId: state.turnId,
              parentTurnId: state.parentTurnId,
              itemId: state.childItemId,
              providerRefs: childRefs,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant",
              data: { text: state.streamed },
            },
          } satisfies ProviderRuntimeEvent);
          state.childItemId = RuntimeItemId.makeUnsafe(
            `chatgpt-${event.workerId}-${event.turnId}-assistant-${crypto.randomUUID()}`,
          );
          offer({
            ...base(context, {
              includeTurn: false,
              turnId: state.turnId,
              parentTurnId: state.parentTurnId,
              itemId: state.childItemId,
              providerRefs: childRefs,
            }),
            type: "item.started",
            payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
          } satisfies ProviderRuntimeEvent);
        }
        offer({
          ...base(context, {
            includeTurn: false,
            turnId: state.turnId,
            parentTurnId: state.parentTurnId,
            itemId: state.childItemId,
            providerRefs: childRefs,
          }),
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: delta.text },
        } satisfies ProviderRuntimeEvent);
        state.streamed = nextText;
      };

      if (event.type === "text") {
        emitChildText(event.text);
        offer({
          ...base(context, {
            includeTurn: false,
            turnId: state.parentTurnId,
            itemId: state.parentItemId,
            providerRefs: parentRefs,
          }),
          type: "item.updated",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "inProgress",
            title: event.label,
            detail: excerpt(event.text, 400),
            data: workerData("running"),
          },
        } satisfies ProviderRuntimeEvent);
        return;
      }

      emitChildText(event.text);
      offer({
        ...base(context, {
          includeTurn: false,
          turnId: state.turnId,
          parentTurnId: state.parentTurnId,
          itemId: state.childItemId,
          providerRefs: childRefs,
        }),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: event.status === "completed" ? "completed" : "failed",
          title: "Assistant",
          data: { text: state.streamed },
        },
      } satisfies ProviderRuntimeEvent);
      offer({
        ...base(context, {
          includeTurn: false,
          turnId: state.turnId,
          parentTurnId: state.parentTurnId,
          providerRefs: childRefs,
        }),
        type: "turn.completed",
        payload: {
          state: event.status,
          stopReason: event.status === "completed" ? "model_stop" : "error",
          ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
        },
      } satisfies ProviderRuntimeEvent);
      offer({
        ...base(context, {
          includeTurn: false,
          turnId: state.parentTurnId,
          itemId: state.parentItemId,
          providerRefs: parentRefs,
        }),
        type: "item.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          status: event.status === "completed" ? "completed" : "failed",
          title: event.label,
          detail:
            event.status === "completed"
              ? excerpt(state.streamed || event.text, 400)
              : excerpt(event.errorMessage ?? event.text, 400),
          data: workerData(event.status, {
            result: event.text,
            ...(event.errorMessage ? { error: event.errorMessage } : {}),
          }),
        },
      } satisfies ProviderRuntimeEvent);
      context.workerTurns.delete(key);
    };

    const runTurn = (
      context: ChatGptSessionContext,
      turn: ChatGptTurnState,
      promptText: string,
      includesConversationPreamble: boolean,
      undeliveredInbox: string,
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
          try: () =>
            context.driver.sendPrompt(conversation, promptText, {
              submittedText: turn.submittedText,
            }),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) => {
            context.broker.restoreInbox(String(context.session.threadId), undeliveredInbox);
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
          context.broker.restoreInbox(String(context.session.threadId), undeliveredInbox);
          emitTurnCompleted(context, turn, {
            state: "failed",
            stopReason: "error",
            errorMessage:
              "ChatGPT did not accept the prompt (no user message appeared). Check the conversation tab in Synara.",
          });
          return;
        }
        // A failed first send must retry with the preamble. Mark it delivered
        // only after ChatGPT has visibly accepted that user turn.
        if (includesConversationPreamble) context.preambleSent = true;

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
            context.driver.waitForCompletion(conversation, turn.submittedText, {
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

        // The page navigates a fresh conversation to its /c/<id> URL on the
        // first send. Keep the session and its cursor on the real conversation
        // so a later resume reattaches to it instead of the root page.
        if (
          completion.observation.conversationPath !== null &&
          completion.observation.url !== conversation.url
        ) {
          context.conversation = {
            ...conversation,
            url: completion.observation.url,
            conversationPath: completion.observation.conversationPath,
          };
          context.session = { ...context.session, resumeCursor: completion.observation.url };
        }

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

        if (completion.outcome === "stalled" || completion.outcome === "timeout") {
          // Do not release the Synara session while ChatGPT still owns a live
          // generation: the next turn would immediately fail as busy. This is
          // best-effort because the terminal failure below must still be
          // emitted if the page or bridge is already gone.
          yield* Effect.promise(() => context.driver.interrupt(conversation)).pipe(
            Effect.catchCause(() => Effect.void),
          );
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
              state: "failed",
              stopReason: "stalled",
              errorMessage: "The ChatGPT turn stopped making progress before it completed.",
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
            rpc: externalRpcFor(input.threadId),
            onLoginRequired: () =>
              emitRuntimeWarning(
                contextRef,
                "ChatGPT is showing its sign-in page. Sign in to chatgpt.com in your default browser; Synara is waiting and continues automatically once you are signed in.",
              ),
          });
        const broker = new ChatGptWorkerBroker({
          workspaceRoot,
          maxWorkers,
          openWorkerConversation: (opts) => driver.openFreshConversation(opts),
          sendPrompt: async (ref, text, submittedText) => {
            try {
              const result = await driver.sendPrompt(ref, text, {
                submittedText: submittedText ?? text,
              });
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
          waitForWorkerTurn: async (ref, submitted, onGenerating, onText, signal) => {
            const completion = await driver.waitForCompletion(ref, submitted, {
              // The Stop control is only a UI hint and can disappear between React
              // commits. Keep worker ownership alive while the page model still marks
              // its newest public assistant message in progress as well.
              onText: (text, observation) => {
                onGenerating(observation.generating || observation.latestAssistantInProgress);
                onText?.(text);
              },
              ...(signal ? { signal } : {}),
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
          onWorkerEvent: (event) => {
            if (contextRef) emitWorkerEvent(contextRef, event);
          },
          sessionTag: sessionTagForThread(String(input.threadId)),
        });
        const exec = new ExecSessionManager();

        const conversation = yield* Effect.tryPromise({
          try: () =>
            resumeUrl !== undefined || startOptions?.browserUrl !== undefined
              ? driver.ensureConversation({
                  ...(resumeUrl ? { existingUrl: resumeUrl } : {}),
                  ...(startOptions?.browserUrl ? { openUrl: startOptions.browserUrl } : {}),
                })
              : // A fresh thread owns a fresh conversation: sessions must never
                // share a tab, because several ChatGPT threads can run at once.
                driver.openFreshConversation(),
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
          workerTurns: new Map(),
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
            message: "ChatGPT (Web) session attached to your default browser.",
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
            const includesConversationPreamble = !context.preambleSent;
            const sessionTag = sessionTagForThread(String(context.session.threadId));
            const contextParts: string[] = [];
            if (includesConversationPreamble) {
              contextParts.push(buildConversationPreamble(context.workspaceRoot, sessionTag));
            } else {
              // Re-state the attribution tag every turn: long or resumed
              // conversations otherwise rely on a stale preamble and send
              // untagged calls that fail closed while several turns run.
              contextParts.push(buildSessionTagReminder(sessionTag));
            }
            if (inbox.length > 0) {
              contextParts.push(`Updates from your workers:\n${inbox}`);
            }
            const promptText =
              contextParts.length > 0
                ? prependChatGptPromptContext(text, contextParts.join("\n\n"))
                : text;

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

            // The turn must outlive the fiber that dispatched it: the provider
            // command reactor completes its provider call as soon as
            // `sendTurn` returns, and this Effect build interrupts a fiber's
            // children when that parent completes. A detached fiber is owned
            // by the session context instead; interruptTurn and stopSession
            // still stop it explicitly.
            const fiber = yield* runTurn(
              context,
              turn,
              promptText,
              includesConversationPreamble,
              inbox,
            ).pipe(Effect.forkDetach({ startImmediately: true }));
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
        context.workerTurns.clear();
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
      Effect.gen(function* () {
        for (const context of sessions.values()) {
          context.exec.killAll();
          context.workerTurns.clear();
          connector.registry.endTurn(String(context.session.threadId));
          connector.registry.unregister(String(context.session.threadId));
          const fiber = context.activeTurn?.fiber;
          if (fiber) {
            // Turn fibers are detached, so adapter teardown has to stop them
            // explicitly; otherwise a turn would keep polling the browser
            // after its dispatcher and session are gone.
            yield* Fiber.interrupt(fiber).pipe(Effect.catchCause(() => Effect.void));
          }
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
