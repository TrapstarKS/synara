// FILE: driver.test.ts
// Purpose: Unit tests for the ChatGPT web driver: conversation readiness,
//          login and busy failures, prompt acceptance, completion settle
//          rules, interruption, and browser-unavailable mapping.
// Layer: Server provider / ChatGPT web driver tests
//
// Every browser RPC answer is scripted and poll/settle/timeout windows are
// reduced to a few milliseconds, so no test waits on real page timing.

import { describe, expect, it, vi } from "vitest";

import { BrowserHostRpcError } from "../../browserAutomation/browserHostRpcClient.ts";
import { ChatGptDriverFailure, ChatGptWebDriver, type ChatGptDriverFailureCode } from "./driver.ts";
import { prependChatGptPromptContext } from "./userPrompt.ts";
import type {
  ChatGptBrowserCallInput,
  ChatGptBrowserRpc,
  ChatGptBrowserToolName,
  ChatGptConversationRef,
  ChatGptObservation,
  ChatGptTurnObservation,
} from "./types.ts";

const CONVERSATION_PATH = "/c/68f0a1b2-3c4d";
const CONVERSATION_URL = `https://chatgpt.com${CONVERSATION_PATH}`;

const REF: ChatGptConversationRef = {
  tabId: "t1",
  url: CONVERSATION_URL,
  conversationPath: CONVERSATION_PATH,
};

/** Caps sleeps so driver loops advance quickly without busy-spinning. */
const fastSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.min(milliseconds, 2));
  });

interface RpcStep {
  readonly name: ChatGptBrowserToolName;
  readonly result: unknown;
  /** How many calls this step answers; defaults to one, Infinity keeps answering. */
  readonly times?: number;
}

const createFakeRpc = (steps: ReadonlyArray<RpcStep>) => {
  const queue = steps.map((step) => ({ ...step, remaining: step.times ?? 1 }));
  const calls: ChatGptBrowserCallInput[] = [];
  const call = vi.fn(async (input: ChatGptBrowserCallInput): Promise<unknown> => {
    calls.push(input);
    const step = queue.find((entry) => entry.name === input.name && entry.remaining > 0);
    if (!step) throw new Error(`unexpected browser RPC call: ${input.name}`);
    if (step.remaining !== Number.POSITIVE_INFINITY) step.remaining -= 1;
    return step.result;
  });
  const rpc: ChatGptBrowserRpc = { call };
  return { call, calls, rpc };
};

const turn = (
  role: "user" | "assistant",
  text: string,
  interrupted = false,
): ChatGptTurnObservation => ({ role, text, messageId: null, interrupted });

/** Builds a complete observation so partial fixtures stay readable. */
const observation = (overrides: Partial<ChatGptObservation> = {}): ChatGptObservation => {
  const base: ChatGptObservation = {
    url: CONVERSATION_URL,
    conversationPath: CONVERSATION_PATH,
    loginRequired: false,
    composerPresent: true,
    composerText: "",
    generating: false,
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
  };
  return Object.assign(base, overrides);
};

/** A `browser_evaluate` result carrying one observation. */
const observed = (overrides: Partial<ChatGptObservation> = {}): { value: ChatGptObservation } => ({
  value: observation(overrides),
});

const clickSelectors = (calls: ReadonlyArray<ChatGptBrowserCallInput>): string[] =>
  calls
    .filter((input) => input.name === "browser_click")
    .map((input) => {
      const target = input.args["target"];
      if (typeof target !== "object" || target === null) return "";
      const selector = (target as Record<string, unknown>)["selector"];
      return typeof selector === "string" ? selector : "";
    });

const expectFailure = async (
  run: () => Promise<unknown>,
  code: ChatGptDriverFailureCode,
): Promise<ChatGptDriverFailure> => {
  let thrown: unknown = null;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof ChatGptDriverFailure)) {
    throw new Error(`expected a ChatGptDriverFailure, received ${String(thrown)}`);
  }
  expect(thrown.code).toBe(code);
  return thrown;
};

describe("ChatGptWebDriver", () => {
  it("opens a tab and waits for the composer when no ChatGPT tab exists", async () => {
    const fake = createFakeRpc([
      { name: "browser_tabs", result: { tabs: [], activeTabId: null, assignedTabId: null } },
      { name: "browser_open", result: { tabId: "t1", finalUrl: "https://chatgpt.com/" } },
      { name: "browser_evaluate", result: observed({ composerPresent: false }) },
      {
        name: "browser_evaluate",
        result: observed({ composerPresent: true }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 5,
      readyTimeoutMs: 500,
    });

    const conversation = await driver.ensureConversation();

    expect(conversation).toEqual({
      tabId: "t1",
      url: CONVERSATION_URL,
      conversationPath: CONVERSATION_PATH,
    });
    expect(fake.call).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "browser_open",
        args: expect.objectContaining({ url: "https://chatgpt.com/" }),
      }),
    );
  });

  it("reuses the active ChatGPT tab before an older background tab", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_tabs",
        result: {
          tabs: [
            { tabId: "old", url: CONVERSATION_URL, active: false },
            { tabId: "active", url: CONVERSATION_URL, active: true },
          ],
          activeTabId: "active",
          assignedTabId: null,
        },
      },
      { name: "browser_evaluate", result: observed(), times: Number.POSITIVE_INFINITY },
    ]);
    const driver = new ChatGptWebDriver({ rpc: fake.rpc, sleep: fastSleep });

    const conversation = await driver.ensureConversation();

    expect(conversation.tabId).toBe("active");
  });

  it("opens a fresh tab when a reusable tab navigates away before evaluation", async () => {
    let evaluated = 0;
    const call = vi.fn(async (input: ChatGptBrowserCallInput): Promise<unknown> => {
      if (input.name === "browser_tabs") {
        return {
          tabs: [{ tabId: "stale", url: CONVERSATION_URL, active: true }],
        };
      }
      if (input.name === "browser_evaluate") {
        evaluated++;
        if (evaluated === 1) {
          throw new Error("The bridge can only control ChatGPT and its sign-in tabs.");
        }
        return observed({ composerPresent: true });
      }
      if (input.name === "browser_open") {
        return { tabId: "fresh", finalUrl: "https://chatgpt.com/" };
      }
      throw new Error(`unexpected browser RPC call: ${input.name}`);
    });
    const driver = new ChatGptWebDriver({ rpc: { call }, sleep: fastSleep });

    const conversation = await driver.ensureConversation();

    expect(conversation.tabId).toBe("fresh");
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ name: "browser_open" }));
  });

  it("rejects with login-required when the page shows a signed-out surface", async () => {
    const fake = createFakeRpc([
      { name: "browser_tabs", result: { tabs: [], activeTabId: null, assignedTabId: null } },
      { name: "browser_open", result: { tabId: "t1", finalUrl: "https://chatgpt.com/" } },
      {
        name: "browser_evaluate",
        result: observed({ composerPresent: false, loginRequired: true }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 5,
      readyTimeoutMs: 500,
      loginWaitMs: 60,
    });

    const failure = await expectFailure(() => driver.ensureConversation(), "login-required");
    expect(failure.message).toContain("Finish signing in");
  });

  it("waits for sign-in and continues automatically once the composer appears", async () => {
    const fake = createFakeRpc([
      { name: "browser_tabs", result: { tabs: [], activeTabId: null, assignedTabId: null } },
      { name: "browser_open", result: { tabId: "t1", finalUrl: "https://chatgpt.com/" } },
      {
        name: "browser_evaluate",
        result: observed({ composerPresent: false, loginRequired: true }),
        times: 3,
      },
      {
        name: "browser_evaluate",
        result: observed({ composerPresent: true }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const onLoginRequired = vi.fn();
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 5,
      loginWaitMs: 2_000,
      onLoginRequired,
    });

    const conversation = await driver.ensureConversation();

    expect(conversation.tabId).toBe("t1");
    expect(onLoginRequired).toHaveBeenCalledTimes(1);
  });

  it("maps a human-control interruption to a retryable, explicit failure", async () => {
    const call = vi.fn(async (): Promise<unknown> => {
      throw new BrowserHostRpcError(
        "remote",
        "The browser operation was interrupted by human control.",
        {
          type: "synara_browser_error",
          version: 1,
          error: { code: "BrowserInterruptedByHuman", message: "interrupted" },
        },
      );
    });
    const driver = new ChatGptWebDriver({
      rpc: { call },
      sleep: fastSleep,
      pollMs: 5,
      readyTimeoutMs: 200,
    });

    const failure = await expectFailure(() => driver.ensureConversation(), "interrupted-by-human");
    expect(failure.message).toContain("leave the tab alone");
  });

  it("sends a prompt once the composer holds it and the page proves acceptance", async () => {
    const fake = createFakeRpc([
      { name: "browser_evaluate", result: observed() },
      { name: "browser_type", result: {} },
      {
        name: "browser_evaluate",
        result: observed({ composerText: "hello world", sendEnabled: true }),
      },
      {
        name: "browser_evaluate",
        result: observed({ composerText: "hello world", sendEnabled: true }),
      },
      { name: "browser_click", result: {} },
      {
        name: "browser_evaluate",
        result: observed({ generating: true, turns: [turn("user", "hello world")] }),
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 5,
      sendAcceptTimeoutMs: 200,
    });

    const result = await driver.sendPrompt(REF, "hello world");

    expect(result.accepted).toBe(true);
    expect(clickSelectors(fake.calls)).toEqual(['button[data-testid="send-button"]']);
    expect(fake.call).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "browser_type",
        args: expect.objectContaining({ text: "hello world", append: false }),
      }),
    );
  });

  it("allows the next prompt when only a stale Stop control remains", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({ generating: true, latestAssistantCompleted: true }),
      },
      { name: "browser_type", result: {} },
      {
        name: "browser_evaluate",
        result: observed({ composerText: "next prompt", sendEnabled: true }),
        times: 2,
      },
      { name: "browser_click", result: {} },
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          latestAssistantCompleted: false,
          turns: [turn("user", "next prompt")],
        }),
      },
    ]);
    const driver = new ChatGptWebDriver({ rpc: fake.rpc, sleep: fastSleep });

    const result = await driver.sendPrompt(REF, "next prompt");

    expect(result.accepted).toBe(true);
    expect(fake.calls.some((call) => call.name === "browser_type")).toBe(true);
  });

  it("accepts a visible user message when the browser prompt has an internal preamble", async () => {
    const fake = createFakeRpc([
      { name: "browser_evaluate", result: observed() },
      { name: "browser_type", result: {} },
      {
        name: "browser_evaluate",
        result: observed({ composerText: "internal context hello", sendEnabled: true }),
      },
      {
        name: "browser_evaluate",
        result: observed({ composerText: "internal context hello", sendEnabled: true }),
      },
      { name: "browser_click", result: {} },
      {
        name: "browser_evaluate",
        result: observed({
          composerText: "still visible",
          sendEnabled: true,
          turns: [turn("user", "hello")],
        }),
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      sendAcceptTimeoutMs: 200,
    });

    const result = await driver.sendPrompt(REF, "internal context\n\nhello", {
      submittedText: "hello",
    });

    expect(result.accepted).toBe(true);
  });

  it("confirms insertion when the editor renders prompt newlines as paragraph breaks", async () => {
    // Native input lets the editor re-render the inserted prompt into separate
    // paragraphs, so the composer's textContent loses newlines and the frame
    // header directly abuts the context ("]]\ncontext" becomes "]]context").
    // The insert confirmation must ignore that whitespace difference.
    const prompt = prependChatGptPromptContext("hello", "internal context");
    const renderedComposerText = prompt.replace(/\n/gu, "");
    const fake = createFakeRpc([
      { name: "browser_evaluate", result: observed() },
      { name: "browser_type", result: {} },
      {
        name: "browser_evaluate",
        result: observed({ composerText: renderedComposerText, sendEnabled: true }),
        times: 2,
      },
      { name: "browser_click", result: {} },
      {
        name: "browser_evaluate",
        result: observed({
          composerText: "",
          sendEnabled: false,
          turns: [turn("user", "hello")],
        }),
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      sendAcceptTimeoutMs: 200,
    });

    const result = await driver.sendPrompt(REF, prompt, { submittedText: "hello" });

    expect(result.accepted).toBe(true);
    expect(fake.calls.some((call) => call.name === "browser_click")).toBe(true);
  });

  it("rejects with busy when ChatGPT is already generating", async () => {
    const fake = createFakeRpc([
      { name: "browser_evaluate", result: observed({ generating: true }) },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 5,
      sendAcceptTimeoutMs: 50,
    });

    await expectFailure(() => driver.sendPrompt(REF, "hello"), "busy");
    expect(fake.calls.filter((input) => input.name === "browser_type")).toHaveLength(0);
  });

  it("returns accepted false when the page never proves the prompt was sent", async () => {
    const fake = createFakeRpc([
      { name: "browser_evaluate", result: observed() },
      { name: "browser_type", result: {} },
      {
        name: "browser_evaluate",
        result: observed({ composerText: "never sent", sendEnabled: true }),
      },
      {
        name: "browser_evaluate",
        result: observed({ composerText: "never sent", sendEnabled: true }),
      },
      { name: "browser_click", result: {} },
      {
        name: "browser_evaluate",
        result: observed({ composerText: "never sent", sendEnabled: true }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 5,
      sendAcceptTimeoutMs: 60,
    });

    const result = await driver.sendPrompt(REF, "never sent");

    expect(result.accepted).toBe(false);
    expect(fake.calls.filter((input) => input.name === "browser_click").length).toBeGreaterThan(0);
  });

  it("settles a growing answer into completed and streams text deltas", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({ generating: true, turns: [turn("user", "say hello")] }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          turns: [turn("user", "say hello"), turn("assistant", "Hel")],
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          turns: [turn("user", "say hello"), turn("assistant", "Hello")],
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          turns: [turn("user", "say hello"), turn("assistant", "Hello there")],
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          turns: [turn("user", "say hello"), turn("assistant", "Hello there")],
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      settleMs: 30,
      stallMs: 5_000,
      completionTimeoutMs: 5_000,
    });
    const onText = vi.fn();

    const completion = await driver.waitForCompletion(REF, "say hello", { onText });

    expect(completion.outcome).toBe("completed");
    expect(completion.text).toBe("Hello there");
    expect(onText.mock.calls.map((call) => call[0])).toEqual(["Hel", "Hello", "Hello there"]);
  });

  it("streams model text while the visible DOM lags behind a background turn", async () => {
    // A background tab's on-screen reveal is animation-frame gated and can
    // stay frozen while the model text keeps growing, so deltas must not
    // depend on the rendered assistant turn.
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({ generating: true, turns: [turn("user", "say hello")] }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          turns: [turn("user", "say hello")],
          assistantModelText: "Hel",
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          turns: [turn("user", "say hello")],
          assistantModelText: "Hello",
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          turns: [turn("user", "say hello")],
          assistantModelText: "Hello there",
          latestAssistantCompleted: true,
          terminalAssistantText: "Hello there",
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      settleMs: 30,
      stallMs: 5_000,
      completionTimeoutMs: 5_000,
    });
    const onText = vi.fn();

    const completion = await driver.waitForCompletion(REF, "say hello", { onText });

    expect(completion.outcome).toBe("completed");
    expect(completion.text).toBe("Hello there");
    expect(onText.mock.calls.map((call) => call[0])).toEqual(["Hel", "Hello", "Hello there"]);
  });

  it("does not settle while the model reports the answer still in progress", async () => {
    // ChatGPT can drop the Stop control for a moment (or an entire phase)
    // while it keeps working. Without the model-state gate, the quiet path
    // would complete the turn with the partial text the moment the control
    // disappears.
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({ generating: true, turns: [turn("user", "say hello")] }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          turns: [turn("user", "say hello")],
          latestAssistantInProgress: true,
          assistantModelText: "Hel",
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          turns: [turn("user", "say hello")],
          latestAssistantInProgress: true,
          assistantModelText: "Hello",
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          turns: [turn("user", "say hello")],
          latestAssistantCompleted: true,
          terminalAssistantText: "Hello there",
          assistantModelText: "Hello there",
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      settleMs: 20,
      stallMs: 5_000,
      completionTimeoutMs: 5_000,
    });
    const onText = vi.fn();

    const completion = await driver.waitForCompletion(REF, "say hello", { onText });

    expect(completion.outcome).toBe("completed");
    expect(completion.text).toBe("Hello there");
    expect(onText.mock.calls.map((call) => call[0])).toEqual(["Hel", "Hello", "Hello there"]);
  });

  it("keeps a working turn alive when only tool activity changes", async () => {
    // A long tool phase grows tool output but not the answer text. The stall
    // watchdog must count that rendered activity as progress instead of
    // killing the turn while ChatGPT is still working.
    const steps = Array.from({ length: 12 }, (_, index) => ({
      name: "browser_evaluate" as const,
      result: observed({
        generating: true,
        turns: [turn("user", "run the suite")],
        assistantActivity: `${(index + 1) * 100}:tool output ${index + 1}`,
      }),
    }));
    const fake = createFakeRpc([
      ...steps,
      {
        name: "browser_evaluate",
        result: observed({
          turns: [turn("user", "run the suite"), turn("assistant", "Done")],
          latestAssistantCompleted: true,
          terminalAssistantText: "Done",
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      stallMs: 25,
      completionTimeoutMs: 5_000,
    });

    const completion = await driver.waitForCompletion(REF, "run the suite");

    expect(completion.outcome).toBe("completed");
    expect(completion.text).toBe("Done");
  });

  it("never replaces a streamed answer with a transient empty observation", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({ generating: true, turns: [turn("user", "say hello")] }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          turns: [turn("user", "say hello")],
          latestAssistantInProgress: true,
          assistantModelText: "Hello",
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          turns: [turn("user", "say hello")],
          latestAssistantInProgress: true,
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          turns: [turn("user", "say hello"), turn("assistant", "Hello there")],
          latestAssistantCompleted: true,
          terminalAssistantText: "Hello there",
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      settleMs: 20,
      stallMs: 5_000,
      completionTimeoutMs: 5_000,
    });
    const onText = vi.fn();

    const completion = await driver.waitForCompletion(REF, "say hello", { onText });

    expect(completion.outcome).toBe("completed");
    expect(completion.text).toBe("Hello there");
    expect(onText.mock.calls.map((call) => call[0])).toEqual(["Hello", "Hello there"]);
  });

  it("completes from ChatGPT end_turn evidence while a stale Stop control remains", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          turns: [turn("user", "say hello")],
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          turns: [turn("user", "say hello"), turn("assistant", "rendered fallback")],
          latestAssistantCompleted: true,
          terminalAssistantText: "Hello from the terminal message",
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      stallMs: 5_000,
      completionTimeoutMs: 5_000,
    });
    const onText = vi.fn();

    const completion = await driver.waitForCompletion(REF, "say hello", { onText });

    expect(completion.outcome).toBe("completed");
    expect(completion.text).toBe("Hello from the terminal message");
    expect(onText).toHaveBeenCalledWith(
      "Hello from the terminal message",
      expect.objectContaining({ latestAssistantCompleted: true }),
    );
  });

  it("returns failed for a quiet transport error even when the card has text", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({
          turns: [turn("user", "say hello")],
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          turns: [
            turn("user", "say hello"),
            turn("assistant", "Message delivery timed out. Please try again."),
          ],
          errorText: "Message delivery timed out. Please try again.",
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 5,
      settleMs: 5,
      completionTimeoutMs: 1_000,
    });

    const completion = await driver.waitForCompletion(REF, "say hello");

    expect(completion.outcome).toBe("failed");
    expect(completion.observation.errorText).toContain("delivery timed out");
  });

  it("settles as completed when the assistant turn carries progress markers", async () => {
    // ChatGPT's renderer decorates commentary/progress blocks with
    // `data-interrupted`; that marks "not the final answer", not a stopped
    // answer. Reading it as an interrupt ended working turns early while
    // ChatGPT kept going, so progress markers must still settle as completed.
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({ generating: true, turns: [turn("user", "say hello")] }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          turns: [turn("user", "say hello"), turn("assistant", "partial")],
        }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          turns: [turn("user", "say hello"), turn("assistant", "partial", true)],
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      settleMs: 30,
      stallMs: 5_000,
      completionTimeoutMs: 5_000,
    });

    const completion = await driver.waitForCompletion(REF, "say hello");

    expect(completion.outcome).toBe("completed");
    expect(completion.text).toBe("partial");
  });

  it("keeps waiting while commentary or tool activity keeps changing", async () => {
    // The answer text can be stable between tool rounds while commentary and
    // tool rows still render. The quiet settle must require the whole turn to
    // stop moving, not just the answer text.
    const activitySteps = Array.from({ length: 8 }, (_, index) => ({
      name: "browser_evaluate" as const,
      result: observed({
        turns: [turn("user", "say hello"), turn("assistant", "Hel")],
        assistantActivity: `step ${index + 1}`,
      }),
    }));
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({ generating: true, turns: [turn("user", "say hello")] }),
      },
      ...activitySteps,
      {
        name: "browser_evaluate",
        result: observed({
          turns: [turn("user", "say hello"), turn("assistant", "Hello there")],
          latestAssistantCompleted: true,
          terminalAssistantText: "Hello there",
          assistantModelText: "Hello there",
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      settleMs: 5,
      stallMs: 5_000,
      completionTimeoutMs: 5_000,
    });
    const onText = vi.fn();

    const completion = await driver.waitForCompletion(REF, "say hello", { onText });

    expect(completion.outcome).toBe("completed");
    expect(completion.text).toBe("Hello there");
    expect(onText).toHaveBeenLastCalledWith("Hello there", expect.anything());
  });

  it("returns stalled when generating text stops growing past stallMs", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({ generating: true, turns: [turn("user", "say hello")] }),
      },
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          turns: [turn("user", "say hello"), turn("assistant", "partial")],
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      settleMs: 30,
      stallMs: 50,
      completionTimeoutMs: 5_000,
    });

    const completion = await driver.waitForCompletion(REF, "say hello");

    expect(completion.outcome).toBe("stalled");
    expect(completion.text).toBe("partial");
  });

  it("does not wait forever when the submitted turn never becomes observable", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({ generating: false, turns: [] }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      turnStartTimeoutMs: 50,
      completionTimeoutMs: 5_000,
    });

    const completion = await driver.waitForCompletion(REF, "missing prompt");

    expect(completion.outcome).toBe("timeout");
  });

  it("does not match a short prompt inside an older internal preamble", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({
          generating: false,
          turns: [
            turn("user", "Internal instructions about doing work"),
            turn("assistant", "An older answer"),
          ],
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      turnStartTimeoutMs: 50,
      completionTimeoutMs: 5_000,
    });

    const completion = await driver.waitForCompletion(REF, "oi");

    expect(completion.outcome).toBe("timeout");
  });

  it("matches a short prompt in a valid Synara context frame", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({
          turns: [
            turn("user", prependChatGptPromptContext("Oii", "internal context")),
            turn("assistant", "Oii, Trapstar."),
          ],
          latestAssistantCompleted: true,
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({
      rpc: fake.rpc,
      sleep: fastSleep,
      pollMs: 10,
      turnStartTimeoutMs: 50,
      completionTimeoutMs: 5_000,
    });

    const completion = await driver.waitForCompletion(REF, "Oii");

    expect(completion).toMatchObject({ outcome: "completed", text: "Oii, Trapstar." });
  });

  it("interrupt clicks the first visible stop selector", async () => {
    const fake = createFakeRpc([{ name: "browser_click", result: {} }]);
    const driver = new ChatGptWebDriver({ rpc: fake.rpc, sleep: fastSleep });

    await driver.interrupt(REF);

    expect(clickSelectors(fake.calls)).toEqual(['button[data-testid="stop-button"]']);
    expect(fake.call).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "browser_click",
        args: expect.objectContaining({
          target: { selector: 'button[data-testid="stop-button"]' },
        }),
      }),
    );
  });

  it("maps an unavailable browser bridge to browser-unavailable", async () => {
    const call = vi.fn(async (): Promise<unknown> => {
      throw new BrowserHostRpcError("unavailable", "no browser");
    });
    const driver = new ChatGptWebDriver({
      rpc: { call },
      sleep: fastSleep,
      pollMs: 5,
      readyTimeoutMs: 500,
    });

    const failure = await expectFailure(() => driver.ensureConversation(), "browser-unavailable");
    expect(failure.message).toContain("default-browser bridge");
  });

  it("fails a send with rate-limited when the access notice is showing", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({
          rateLimitText:
            "Too many requests You have been temporarily limited. Try again in a few minutes.",
          rateLimitDismissible: true,
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({ rpc: fake.rpc, sleep: fastSleep });

    const failure = await expectFailure(() => driver.sendPrompt(REF, "hello"), "rate-limited");

    expect(failure.message).toContain("Too many requests");
    expect(failure.message).toContain("few minutes");
    // The dismiss expression is evaluated exactly once even though the send
    // never starts. `button.click()` only exists in the dismiss script.
    const dismissals = fake.calls.filter(
      (input) =>
        input.name === "browser_evaluate" &&
        typeof input.args["expression"] === "string" &&
        (input.args["expression"] as string).includes("button.click()"),
    );
    expect(dismissals.length).toBe(1);
    expect(fake.calls.some((input) => input.name === "browser_type")).toBe(false);
  });

  it("does not click when the access notice exposes no single acknowledgement", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({
          rateLimitText:
            "Too many requests You have been temporarily limited. Try again in a few minutes.",
          rateLimitDismissible: false,
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({ rpc: fake.rpc, sleep: fastSleep });

    await expectFailure(() => driver.sendPrompt(REF, "hello"), "rate-limited");

    const dismissalExpressions = fake.calls.filter(
      (input) =>
        input.name === "browser_evaluate" &&
        typeof input.args["expression"] === "string" &&
        (input.args["expression"] as string).includes("button.click()"),
    );
    expect(dismissalExpressions.length).toBe(0);
  });

  it("returns rate_limited from waitForCompletion instead of stalling", async () => {
    const fake = createFakeRpc([
      {
        name: "browser_evaluate",
        result: observed({
          generating: true,
          composerText: "",
          turns: [turn("user", "hello"), turn("assistant", "partial")],
          rateLimitText:
            "Too many requests You have been temporarily limited. Try again in a few minutes.",
          rateLimitDismissible: true,
        }),
        times: Number.POSITIVE_INFINITY,
      },
    ]);
    const driver = new ChatGptWebDriver({ rpc: fake.rpc, sleep: fastSleep, pollMs: 5 });

    const completion = await driver.waitForCompletion(REF, "hello");

    expect(completion.outcome).toBe("rate_limited");
    expect(completion.observation.rateLimitText).not.toBeNull();
  });
});
