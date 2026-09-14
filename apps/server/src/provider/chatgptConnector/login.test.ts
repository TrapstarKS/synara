// FILE: login.test.ts
// Purpose: Verify the default-browser ChatGPT sign-in flow: unavailable local
//          bridges, an already signed-in page, and the bounded wait for login.
// Layer: Server provider connector tests

import { describe, expect, it, vi } from "vitest";

import { openChatGptLogin } from "./login.ts";
import type { ChatGptExternalBrowserShape } from "./Services/ChatGptExternalBrowser.ts";

const observation = (overrides: Record<string, unknown> = {}) => ({
  url: "https://chatgpt.com/",
  conversationPath: null,
  loginRequired: false,
  composerPresent: true,
  composerText: "",
  generating: false,
  sendEnabled: false,
  turns: [],
  toolRowCount: 0,
  errorText: null,
  rateLimitText: null,
  rateLimitDismissible: false,
  ...overrides,
});

const makeBridge = (options: {
  readonly available?: boolean;
  readonly observations: ReadonlyArray<Record<string, unknown>>;
  readonly connected?: boolean;
}): ChatGptExternalBrowserShape => {
  let evaluateCount = 0;
  return {
    available: options.available ?? true,
    createPairing: vi.fn(() => ({
      pairingUrl: "http://127.0.0.1:3773/provider/chatgpt/browser/pair?token=test-token",
      chatgptUrl: "https://chatgpt.com/",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    hasPairing: vi.fn(() => true),
    renderPairingPage: vi.fn(() => "<html></html>"),
    attachClient: vi.fn(() => ({ clientId: "client-1", threadId: "thread-1" as never })),
    handleClientMessage: vi.fn(),
    detachClient: vi.fn(),
    waitForClient: vi.fn(async () => options.connected ?? true),
    execute: vi.fn(async (call) => {
      switch (call.name) {
        case "browser_tabs":
          return { tabs: [], activeTabId: null, assignedTabId: null };
        case "browser_open":
          return { tabId: "t1", finalUrl: "https://chatgpt.com/" };
        case "browser_evaluate": {
          const index = Math.max(0, Math.min(evaluateCount, options.observations.length - 1));
          evaluateCount += 1;
          return { value: observation(options.observations[index] ?? {}) };
        }
        default:
          return {};
      }
    }),
  };
};

describe("openChatGptLogin", () => {
  it("reports unavailable when the local bridge is absent", async () => {
    const bridge = makeBridge({ available: false, observations: [] });
    const result = await openChatGptLogin({
      externalBrowser: bridge,
      openBrowser: vi.fn(async () => undefined),
      threadId: "thread-1" as never,
    });

    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("locally");
  });

  it("opens the default browser and resolves when the composer is already present", async () => {
    const bridge = makeBridge({ observations: [{}] });
    const openBrowser = vi.fn(async () => undefined);
    const result = await openChatGptLogin({
      externalBrowser: bridge,
      openBrowser,
      threadId: "thread-1" as never,
    });

    expect(result.status).toBe("signed-in");
    expect(result.url).toBe("https://chatgpt.com/");
    expect(openBrowser).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3773/provider/chatgpt/browser/pair?token=test-token",
    );
    expect(openBrowser).toHaveBeenNthCalledWith(2, "https://chatgpt.com/");
  });

  it("reports a missing extension without waiting for the ChatGPT page", async () => {
    const bridge = makeBridge({ connected: false, observations: [] });
    const result = await openChatGptLogin({
      externalBrowser: bridge,
      openBrowser: vi.fn(async () => undefined),
      threadId: "thread-1" as never,
      connectWaitMs: 0,
    });

    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("extensions/chatgpt-browser");
    expect(bridge.execute).not.toHaveBeenCalled();
  });

  it("waits for a manual sign-in and reports the bounded timeout", async () => {
    const bridge = makeBridge({
      observations: [{ composerPresent: false, loginRequired: true }],
    });
    const result = await openChatGptLogin({
      externalBrowser: bridge,
      openBrowser: vi.fn(async () => undefined),
      threadId: "thread-1" as never,
      waitMs: 60,
      connectWaitMs: 0,
    });

    expect(result.status).toBe("sign-in-required");
    expect(result.message).toContain("Finish signing in");
  });
});
