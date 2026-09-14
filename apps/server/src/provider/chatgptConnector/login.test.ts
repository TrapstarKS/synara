// FILE: login.test.ts
// Purpose: Verify the on-demand ChatGPT sign-in flow: unavailable desktops,
//          an already signed-in page, and the bounded wait for a manual login.
// Layer: Server provider connector tests

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationHostShape } from "../../browserAutomation/Services/BrowserAutomationHost.ts";
import { openChatGptLogin } from "./login.ts";

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

const makeHost = (options: {
  readonly available?: boolean;
  readonly observations: ReadonlyArray<Record<string, unknown>>;
}): BrowserAutomationHostShape => {
  let evaluateCount = 0;
  return {
    available: options.available ?? true,
    execute: vi.fn((call) => {
      switch (call.name) {
        case "browser_tabs":
          return Effect.succeed({ tabs: [], activeTabId: null, assignedTabId: null });
        case "browser_open":
          return Effect.succeed({ tabId: "t1", finalUrl: "https://chatgpt.com/" });
        case "browser_evaluate": {
          const index = Math.min(evaluateCount, options.observations.length - 1);
          evaluateCount += 1;
          return Effect.succeed({ value: observation(options.observations[index]) });
        }
        default:
          return Effect.succeed({});
      }
    }),
  } as unknown as BrowserAutomationHostShape;
};

describe("openChatGptLogin", () => {
  it("reports unavailable when the desktop browser host is absent", async () => {
    const host = makeHost({ available: false, observations: [] });
    const result = await openChatGptLogin({ browserHost: host, threadId: "thread-1" as never });

    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("desktop");
  });

  it("resolves as signed-in when the composer is already present", async () => {
    const host = makeHost({ observations: [{}] });
    const result = await openChatGptLogin({ browserHost: host, threadId: "thread-1" as never });

    expect(result.status).toBe("signed-in");
    expect(result.url).toBe("https://chatgpt.com/");
  });

  it("waits for a manual sign-in and reports the bounded timeout", async () => {
    const host = makeHost({
      observations: [{ composerPresent: false, loginRequired: true }],
    });
    const result = await openChatGptLogin({
      browserHost: host,
      threadId: "thread-1" as never,
      waitMs: 60,
    });

    expect(result.status).toBe("sign-in-required");
    expect(result.message).toContain("Finish signing in");
  });
});
