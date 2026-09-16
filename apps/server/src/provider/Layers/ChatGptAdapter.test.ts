// FILE: ChatGptAdapter.test.ts
// Purpose: Regression coverage for the ChatGPT (Web) adapter's turn fiber
//          lifetime. The provider command reactor dispatches `sendTurn` from
//          a fiber that completes as soon as the call returns; the streaming
//          turn must keep running after that parent completes.
// Layer: Provider adapter tests

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  ChatGptConnector,
  type ChatGptConnectorShape,
} from "../chatgptConnector/Services/ChatGptConnector.ts";
import { ChatGptRuntimeRegistry } from "../chatgptConnector/runtime.ts";
import {
  ChatGptExternalBrowser,
  type ChatGptExternalBrowserShape,
} from "../chatgptConnector/Services/ChatGptExternalBrowser.ts";
import type {
  ChatGptCompletion,
  ChatGptSendResult,
  ChatGptWebDriver,
} from "../chatgptWeb/driver.ts";
import type { ChatGptConversationRef, ChatGptObservation } from "../chatgptWeb/types.ts";
import { makeChatGptAdapter } from "./ChatGptAdapter.ts";

const CONVERSATION: ChatGptConversationRef = {
  tabId: "t1",
  url: "https://chatgpt.com/c/regression",
  conversationPath: "/c/regression",
};

const observation = (overrides: Partial<ChatGptObservation> = {}): ChatGptObservation => ({
  url: CONVERSATION.url,
  conversationPath: CONVERSATION.conversationPath,
  loginRequired: false,
  composerPresent: true,
  composerText: "",
  generating: true,
  sendEnabled: false,
  turns: [],
  latestAssistantCompleted: false,
  latestAssistantInProgress: false,
  assistantActivity: "",
  terminalAssistantText: null,
  assistantModelText: null,
  toolRowCount: 0,
  errorText: null,
  rateLimitText: null,
  rateLimitDismissible: false,
  ...overrides,
});

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForValue = async <A>(read: () => A | null, timeoutMs = 2_000): Promise<A | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await sleep(10);
  }
  return read();
};

/**
 * Scriptable ChatGPT page stand-in: `waitForCompletion` parks until the test
 * tells it to stream text and then finish, exactly like a live page would.
 */
const makeFakeDriver = () => {
  let onText: ((text: string) => void) | null = null;
  let resolveCompletion: ((completion: ChatGptCompletion) => void) | null = null;
  let interrupts = 0;

  const driver = {
    ensureConversation: async (): Promise<ChatGptConversationRef> => CONVERSATION,
    // A fresh conversation starts on the ChatGPT root and only navigates to
    // its /c/<id> URL once the first message is sent.
    openFreshConversation: async (): Promise<ChatGptConversationRef> => ({
      tabId: "t1",
      url: "https://chatgpt.com/",
      conversationPath: null,
    }),
    sendPrompt: async (): Promise<ChatGptSendResult> => ({
      accepted: true,
      observation: observation(),
    }),
    waitForCompletion: async (
      _ref: ChatGptConversationRef,
      _submittedText: string,
      hooks?: { readonly onText?: (text: string) => void },
    ): Promise<ChatGptCompletion> => {
      onText = (text) => hooks?.onText?.(text);
      return await new Promise<ChatGptCompletion>((resolve) => {
        resolveCompletion = resolve;
      });
    },
    interrupt: async (): Promise<void> => {
      interrupts += 1;
    },
    closeConversation: async (): Promise<void> => {},
  } as unknown as ChatGptWebDriver;

  return {
    driver,
    isWaiting: () => resolveCompletion !== null,
    emitText: (text: string) => onText?.(text),
    finish: (text: string) =>
      resolveCompletion?.({
        outcome: "completed",
        text,
        observation: observation({ terminalAssistantText: text, latestAssistantCompleted: true }),
      }),
    interrupts: () => interrupts,
  };
};

const makeFakes = (): {
  readonly connector: ChatGptConnectorShape;
  readonly external: ChatGptExternalBrowserShape;
} => {
  const registry = new ChatGptRuntimeRegistry();
  const connector = {
    registry,
    getInfo: Effect.succeed({
      localUrl: "",
      publicUrl: null,
      connectorUrl: "",
      tunnelState: "disabled",
      tunnelMessage: null,
      secretCreatedAt: new Date().toISOString(),
      activeThreadId: null,
      registeredThreadIds: [],
      toolCallCount: 0,
      lastToolCallAt: null,
    }),
    rotateSecret: Effect.succeed({}),
    restartTunnel: Effect.succeed({}),
    handlePost: () => Effect.succeed({ status: 404 } as const),
  } as unknown as ChatGptConnectorShape;
  const external = {
    available: true,
    createPairing: () => ({ pairingUrl: "", chatgptUrl: "", expiresAt: new Date().toISOString() }),
    hasPairing: () => false,
    renderPairingPage: () => null,
    attachClient: () => null,
    handleClientMessage: () => undefined,
    detachClient: () => undefined,
    waitForClient: async () => false,
    execute: async () => undefined,
  } as unknown as ChatGptExternalBrowserShape;
  return { connector, external };
};

const layerFor = (input: {
  readonly connector: ChatGptConnectorShape;
  readonly external: ChatGptExternalBrowserShape;
}) =>
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "chatgpt-adapter-test-" }),
    Layer.succeed(ChatGptConnector, input.connector),
    Layer.succeed(ChatGptExternalBrowser, input.external),
  ).pipe(Layer.provide(NodeServices.layer));

describe("ChatGptAdapter turn fiber lifetime", () => {
  it("keeps streaming after the dispatching fiber completes", async () => {
    const fake = makeFakeDriver();
    const fakes = makeFakes();
    const threadId = ThreadId.makeUnsafe("chatgpt-adapter-test-thread");

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeChatGptAdapter({
          createDriver: () => fake.driver,
          resolveMaxWorkers: () => Effect.succeed(0),
        });
        const collected: Array<ProviderRuntimeEvent> = [];
        const collector = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => collected.push(event))),
          Stream.takeUntil(
            (event) => event.type === "turn.completed" && event.threadId === threadId,
          ),
          Stream.runDrain,
          Effect.forkChild,
        );

        // The reactor shape: dispatch completes as soon as sendTurn returns.
        const dispatch = yield* Effect.gen(function* () {
          yield* adapter.startSession({
            provider: "chatgpt",
            threadId,
            runtimeMode: "full-access",
            cwd: process.cwd(),
          });
          yield* adapter.sendTurn({ threadId, input: "hello" });
        }).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.join(dispatch);

        // Only once the dispatcher is gone does the page start streaming.
        const waiting = yield* Effect.promise(() =>
          waitForValue(() => (fake.isWaiting() ? true : null)),
        );
        expect(waiting).toBe(true);
        yield* Effect.sync(() => {
          fake.emitText("hel");
          fake.emitText("hello");
          fake.finish("hello");
        });

        const outcome = yield* Effect.raceFirst(
          Fiber.join(collector).pipe(Effect.as("terminal" as const)),
          Effect.sleep("3 seconds").pipe(Effect.as("timeout" as const)),
        );
        // The session adopts the conversation's real /c/<id> URL from the
        // terminal observation, so a later resume reattaches to the
        // conversation itself instead of the root page.
        const sessions = yield* adapter.listSessions();
        const session = sessions.find((entry) => String(entry.threadId) === String(threadId));
        yield* adapter.stopSession(threadId).pipe(Effect.catchCause(() => Effect.void));
        return { collected, outcome, resumeCursor: session?.resumeCursor };
      }).pipe(Effect.scoped, Effect.provide(layerFor(fakes))),
    );

    expect(events.outcome).toBe("terminal");
    expect(events.collected.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.started",
      "content.delta",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    const deltas = events.collected.filter((event) => event.type === "content.delta");
    expect(deltas.map((event) => (event.payload as { delta: string }).delta)).toEqual([
      "hel",
      "lo",
    ]);
    const terminal = events.collected.at(-1);
    expect(terminal?.payload).toMatchObject({ state: "completed" });
    expect(events.resumeCursor).toBe(CONVERSATION.url);
  });
});
