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
import { ChatGptRuntimeRegistry, sessionTagForThread } from "../chatgptConnector/runtime.ts";
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
  const waiters = new Map<
    string,
    {
      readonly onText: (text: string) => void;
      readonly resolve: (completion: ChatGptCompletion) => void;
    }
  >();
  let interrupts = 0;
  let freshConversationCount = 0;
  const prompts: string[] = [];

  const driver = {
    ensureConversation: async (): Promise<ChatGptConversationRef> => CONVERSATION,
    // A fresh conversation starts on the ChatGPT root and only navigates to
    // its /c/<id> URL once the first message is sent.
    openFreshConversation: async (): Promise<ChatGptConversationRef> => {
      const tabId = freshConversationCount === 0 ? "t1" : `worker-${freshConversationCount}`;
      freshConversationCount += 1;
      return { tabId, url: "https://chatgpt.com/", conversationPath: null };
    },
    sendPrompt: async (_ref: ChatGptConversationRef, text: string): Promise<ChatGptSendResult> => {
      prompts.push(text);
      return { accepted: true, observation: observation() };
    },
    waitForCompletion: async (
      _ref: ChatGptConversationRef,
      _submittedText: string,
      hooks?: { readonly onText?: (text: string, observation: ChatGptObservation) => void },
    ): Promise<ChatGptCompletion> => {
      return await new Promise<ChatGptCompletion>((resolve) => {
        waiters.set(_ref.tabId ?? "unknown", {
          onText: (text) => hooks?.onText?.(text, observation()),
          resolve,
        });
      });
    },
    interrupt: async (): Promise<void> => {
      interrupts += 1;
    },
    closeConversation: async (): Promise<void> => {},
  } as unknown as ChatGptWebDriver;

  return {
    driver,
    isWaiting: (tabId = "t1") => waiters.has(tabId),
    emitText: (text: string, tabId = "t1") => waiters.get(tabId)?.onText(text),
    prompts: () => prompts,
    finish: (text: string, tabId = "t1") => {
      const waiter = waiters.get(tabId);
      if (!waiter) return;
      waiters.delete(tabId);
      waiter.resolve({
        outcome: "completed",
        text,
        observation: observation({ terminalAssistantText: text, latestAssistantCompleted: true }),
      });
    },
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

  it("projects ChatGPT workers as visible child subagent threads", async () => {
    const fake = makeFakeDriver();
    const fakes = makeFakes();
    const threadId = ThreadId.makeUnsafe("chatgpt-adapter-worker-thread");
    const tag = sessionTagForThread(String(threadId));

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeChatGptAdapter({
          createDriver: () => fake.driver,
          resolveMaxWorkers: () => Effect.succeed(1),
        });
        const collected: Array<ProviderRuntimeEvent> = [];
        const collector = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => collected.push(event))),
          Stream.takeUntil(
            (event) =>
              event.type === "turn.completed" &&
              event.providerRefs?.providerThreadId === "worker-1",
          ),
          Stream.runDrain,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "chatgpt",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        yield* adapter.sendTurn({ threadId, input: "delegate this" });
        yield* Effect.promise(() => waitForValue(() => (fake.isWaiting() ? true : null)));

        const resolution = fakes.connector.registry.resolveCallContext(tag);
        if (!resolution.ok) throw new Error(resolution.message);
        yield* Effect.promise(() =>
          resolution.context.agents.spawn(resolution.context, {
            workers: [{ label: "researcher", task: "inspect the repository" }],
          }),
        );
        yield* Effect.promise(() => waitForValue(() => (fake.isWaiting("worker-1") ? true : null)));
        fake.emitText("partial worker output", "worker-1");
        fake.finish("final worker output", "worker-1");

        const outcome = yield* Effect.raceFirst(
          Fiber.join(collector).pipe(Effect.as("terminal" as const)),
          Effect.sleep("3 seconds").pipe(Effect.as("timeout" as const)),
        );
        yield* adapter.stopSession(threadId).pipe(Effect.catchCause(() => Effect.void));
        return { collected, outcome };
      }).pipe(Effect.scoped, Effect.provide(layerFor(fakes))),
    );

    expect(events.outcome).toBe("terminal");
    const workerEvents = events.collected.filter(
      (event) => event.providerRefs?.providerThreadId === "worker-1",
    );
    expect(workerEvents.map((event) => event.type)).toEqual([
      "thread.started",
      "turn.started",
      "item.started",
      "content.delta",
      "item.completed",
      "item.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(workerEvents.every((event) => event.providerRefs?.providerParentThreadId)).toBe(true);
    const parentCollab = events.collected.find(
      (event) =>
        event.type === "item.started" && event.payload.itemType === "collab_agent_tool_call",
    );
    if (!parentCollab || parentCollab.type !== "item.started") {
      throw new Error("worker parent collab item was not emitted");
    }
    expect(parentCollab.payload.data).toMatchObject({
      receiverThreadId: "worker-1",
      receiverAgents: [{ threadId: "worker-1", agentNickname: "researcher" }],
    });
  });

  it("restates the session tag on turns after the first", async () => {
    const fake = makeFakeDriver();
    const fakes = makeFakes();
    const threadId = ThreadId.makeUnsafe("chatgpt-adapter-tag-thread");
    const tag = sessionTagForThread(String(threadId));
    const registry = fakes.connector.registry;

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeChatGptAdapter({
          createDriver: () => fake.driver,
          resolveMaxWorkers: () => Effect.succeed(0),
        });
        yield* adapter.startSession({
          provider: "chatgpt",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });

        // Turn 1 carries the full preamble, including the session tag.
        yield* adapter.sendTurn({ threadId, input: "first" });
        yield* Effect.promise(() =>
          waitForValue(() => (fake.prompts().length === 1 ? true : null)),
        );
        yield* Effect.sync(() => fake.finish("one"));
        yield* Effect.promise(() =>
          waitForValue(() => (registry.isTurnActive(String(threadId)) ? null : true)),
        );

        // Turn 2 must restate the tag next to the newest request: long or
        // resumed conversations otherwise send untagged calls that fail closed
        // while several turns run.
        yield* adapter.sendTurn({ threadId, input: "second" });
        yield* Effect.promise(() =>
          waitForValue(() => (fake.prompts().length === 2 ? true : null)),
        );
        yield* Effect.sync(() => fake.finish("two"));
        yield* adapter.stopSession(threadId).pipe(Effect.catchCause(() => Effect.void));
      }).pipe(Effect.scoped, Effect.provide(layerFor(fakes))),
    );

    const prompts = fake.prompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(`Synara session tag: ${tag}`);
    expect(prompts[0]).toContain("Workspace root:");
    expect(prompts[1]).toContain(`Synara bridge: this conversation is Synara session ${tag}`);
    expect(prompts[1]).toContain(`"synara_session": "${tag}"`);
    expect(prompts[1]).not.toContain("Workspace root:");
  });
});
