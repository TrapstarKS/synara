// @vitest-environment happy-dom

// FILE: pageScript.test.ts
// Purpose: Verify the ChatGPT page observation expression and its defensive
//          parser against DOM fixtures that mirror the live chatgpt.com shapes.
// Layer: Server provider / ChatGPT web driver tests
//
// The expression is compiled through the Function constructor exactly the way
// the desktop browser evaluates it, so these tests exercise the real
// self-contained source instead of a TypeScript re-implementation.

import { describe, expect, it } from "vitest";

import {
  buildChatGptObservationExpression,
  buildDismissRateLimitExpression,
  parseChatGptObservation,
} from "./pageScript.ts";
import type { ChatGptObservation } from "./types.ts";
import { prependChatGptPromptContext } from "./userPrompt.ts";

// The server tsconfig has no DOM lib, so declare only the happy-dom globals
// this test touches. At runtime these come from the happy-dom environment.
declare const document: {
  readonly body: { innerHTML: string; textContent: string | null };
  readonly querySelector: (selector: string) => unknown;
};
declare const window: {
  readonly happyDOM?: { readonly setURL?: (url: string) => void };
};

const DEFAULT_URL = "https://chatgpt.com/";
const urlApiAvailable = typeof window.happyDOM?.setURL === "function";

const observe = (
  html: string,
  url: string = DEFAULT_URL,
  setup?: () => void,
): ChatGptObservation => {
  if (urlApiAvailable) window.happyDOM?.setURL?.(url);
  document.body.innerHTML = html;
  setup?.();
  const expression = buildChatGptObservationExpression();
  const evaluate = new Function(`return (${expression});`);
  const raw: unknown = evaluate();
  const observation = parseChatGptObservation(raw);
  if (!observation) throw new Error("expression did not produce a parsable observation");
  return observation;
};

describe("buildChatGptObservationExpression", () => {
  it("builds one self-contained expression", () => {
    const expression = buildChatGptObservationExpression();
    expect(expression.startsWith("(() => ") || expression.startsWith("(() => {")).toBe(true);
    expect(expression).not.toContain("import ");
  });

  it("reads user and assistant turns with text and message ids", () => {
    const observation = observe(`
      <section data-testid="conversation-turn-1" data-turn="user" data-turn-id="turn-1">
        <div data-message-author-role="user" data-message-id="user-1">
          <div class="whitespace-pre-wrap">Hello there</div>
        </div>
      </section>
      <section data-testid="conversation-turn-2" data-turn="assistant" data-turn-id="turn-2">
        <div data-message-id="assistant-1">
          <div data-message-author-role="assistant">
            <div class="markdown"><p>Hi.</p></div>
            <div class="markdown"><p>How can I help?</p></div>
          </div>
        </div>
      </section>
    `);

    expect(observation.turns).toEqual([
      { role: "user", text: "Hello there", messageId: "user-1", interrupted: false },
      {
        role: "assistant",
        text: "Hi.\n\nHow can I help?",
        messageId: "assistant-1",
        interrupted: false,
      },
    ]);
    expect(observation.latestAssistantCompleted).toBe(false);
    expect(observation.terminalAssistantText).toBeNull();
  });

  it("reads section-level roles and terminal assistant evidence from React Fiber", () => {
    const observation = observe(
      `
        <section data-testid="conversation-turn-1" data-turn="user" data-turn-id="turn-1">
          <div data-message-id="user-1"><div class="markdown">Hello there</div></div>
        </section>
        <section data-testid="conversation-turn-2" data-turn="assistant" data-turn-id="turn-2">
          <div data-message-id="assistant-1"><div class="markdown">Rendered answer</div></div>
        </section>
        <form>
          <div id="prompt-textarea" contenteditable="true"></div>
          <button data-testid="stop-button">Stop</button>
        </form>
      `,
      DEFAULT_URL,
      () => {
        const section = document.querySelector(
          'section[data-testid="conversation-turn-2"]',
        ) as Record<string, unknown> | null;
        if (!section) throw new Error("assistant section missing");
        section["__reactFiber$test"] = {
          memoizedProps: {
            turn: {
              messages: [
                {
                  id: "assistant-1",
                  author: { role: "assistant" },
                  channel: "final",
                  content: { content_type: "text", parts: ["Terminal answer"] },
                  end_turn: true,
                  status: "finished_successfully",
                },
                {
                  id: "analysis-after-final",
                  author: { role: "assistant" },
                  channel: "analysis",
                  content: { content_type: "text", parts: [""] },
                  end_turn: false,
                  status: "in_progress",
                },
              ],
            },
          },
        };
      },
    );

    expect(observation.generating).toBe(true);
    expect(observation.turns).toEqual([
      { role: "user", text: "Hello there", messageId: "user-1", interrupted: false },
      {
        role: "assistant",
        text: "Rendered answer",
        messageId: "assistant-1",
        interrupted: false,
      },
    ]);
    expect(observation.latestAssistantCompleted).toBe(true);
    expect(observation.terminalAssistantText).toBe("Terminal answer");
  });

  it("returns and presents only authored user text from a framed model message", () => {
    const observation = observe(
      `
        <section data-testid="conversation-turn-1" data-turn="user">
          <div data-message-author-role="user" data-message-id="user-1">
            <div class="markdown">[[COS_CONTEXT:16]] internal context [[/COS_CONTEXT]] oi</div>
          </div>
        </section>
      `,
      DEFAULT_URL,
      () => {
        const section = document.querySelector(
          'section[data-testid="conversation-turn-1"]',
        ) as Record<string, unknown> | null;
        if (!section) throw new Error("user section missing");
        section["__reactFiber$test"] = {
          memoizedProps: {
            turn: {
              messages: [
                {
                  id: "user-1",
                  author: { role: "user" },
                  content: {
                    content_type: "text",
                    parts: ["[[COS_CONTEXT:16]]\ninternal\ncontext\n[[/COS_CONTEXT]]\n\noi"],
                  },
                },
              ],
            },
          },
        };
      },
    );

    expect(observation.turns).toEqual([
      { role: "user", text: "oi", messageId: "user-1", interrupted: false },
    ]);
    const display = document.querySelector("[data-synara-user-text]") as {
      readonly textContent?: string | null;
    } | null;
    const hidden = document.querySelector("[data-synara-prompt-hidden]") as {
      readonly textContent?: string | null;
    } | null;
    expect(display?.textContent).toBe("oi");
    expect(hidden?.textContent).toContain("COS_CONTEXT");
  });

  it("parses hidden context beyond the transcript text cap without exposing it", () => {
    const framed = prependChatGptPromptContext("authored tail", "x".repeat(15_000));
    const observation = observe(
      `
        <section data-testid="conversation-turn-1" data-turn="user">
          <div data-message-author-role="user" data-message-id="user-long">
            <div class="markdown">rendered transport frame</div>
          </div>
        </section>
      `,
      DEFAULT_URL,
      () => {
        const section = document.querySelector(
          'section[data-testid="conversation-turn-1"]',
        ) as Record<string, unknown> | null;
        if (!section) throw new Error("user section missing");
        section["__reactFiber$test"] = {
          memoizedProps: {
            turn: {
              messages: [
                {
                  id: "user-long",
                  author: { role: "user" },
                  content: { content_type: "text", parts: [framed] },
                },
              ],
            },
          },
        };
      },
    );

    expect(observation.turns[0]?.text).toBe("authored tail");
    expect(observation.turns[0]?.text).not.toContain("xxxxxxxx");
  });

  it("excludes interrupted commentary from assistant text but flags the turn", () => {
    const observation = observe(`
      <section data-testid="conversation-turn-1" data-turn="assistant">
        <div data-message-author-role="assistant" data-message-id="assistant-1">
          <div data-interrupted="true">
            <div class="markdown"><p>Working on it</p></div>
          </div>
          <div class="markdown"><p>Final answer</p></div>
        </div>
      </section>
    `);

    expect(observation.turns).toHaveLength(1);
    expect(observation.turns[0]?.interrupted).toBe(true);
    expect(observation.turns[0]?.text).toBe("Final answer");
  });

  it("counts tool rows in the newest assistant turn and keeps them out of text", () => {
    const observation = observe(`
      <section data-testid="conversation-turn-1" data-turn="assistant">
        <div data-message-author-role="assistant" data-message-id="assistant-1">
          <span class="tool-message">Old row</span>
          <div class="markdown"><p>First answer</p></div>
        </div>
      </section>
      <section data-testid="conversation-turn-2" data-turn="user">
        <div data-message-author-role="user" data-message-id="user-1">
          <div class="whitespace-pre-wrap">Next</div>
        </div>
      </section>
      <section data-testid="conversation-turn-3" data-turn="assistant">
        <div data-message-author-role="assistant" data-message-id="assistant-2">
          <div data-interrupted="true">
            <span class="tool-message">Searched the web</span>
            <div class="pointer-events-none contents">Read file.ts</div>
            <div class="pointer-events-none contents">
              <div class="markdown"><p>Expanded tool output</p></div>
            </div>
          </div>
          <div class="markdown"><p>Second answer</p></div>
        </div>
      </section>
    `);

    expect(observation.toolRowCount).toBe(2);
    expect(observation.turns[2]?.text).toBe("Second answer");
    expect(observation.turns[2]?.text).not.toContain("Searched the web");
    expect(observation.turns[2]?.text).not.toContain("Expanded tool output");
  });

  it("groups adjacent sections that belong to one logical assistant turn", () => {
    const observation = observe(`
      <section data-testid="conversation-turn-1" data-turn="user" data-turn-id="turn-user">
        <div class="whitespace-pre-wrap">Question</div>
      </section>
      <section data-testid="conversation-turn-2" data-turn="assistant" data-turn-id="turn-answer">
        <div class="markdown">First part</div>
      </section>
      <section data-testid="conversation-turn-3" data-turn="assistant" data-turn-id="turn-answer">
        <div class="pointer-events-none contents">Used a tool</div>
        <div class="markdown">Second part</div>
      </section>
    `);

    expect(observation.turns).toEqual([
      { role: "user", text: "Question", messageId: null, interrupted: false },
      {
        role: "assistant",
        text: "First part\n\nSecond part",
        messageId: null,
        interrupted: false,
      },
    ]);
    expect(observation.toolRowCount).toBe(1);
  });

  it("keeps only the newest ten turn sections", () => {
    const sections = Array.from({ length: 12 }, (_, index) => {
      const number = index + 1;
      return `
        <section data-testid="conversation-turn-${number}" data-turn="user">
          <div data-message-author-role="user" data-message-id="user-${number}">
            <div class="whitespace-pre-wrap">message-${number}</div>
          </div>
        </section>`;
    }).join("");
    const observation = observe(sections);

    expect(observation.turns).toHaveLength(10);
    expect(observation.turns[0]?.text).toBe("message-3");
    expect(observation.turns[9]?.text).toBe("message-12");
  });

  it("reads the generating and send-enabled flags from the composer controls", () => {
    const observation = observe(`
      <form>
        <div id="prompt-textarea" contenteditable="true">Draft text</div>
        <button data-testid="stop-button">Stop</button>
        <button data-testid="send-button">Send</button>
      </form>
    `);

    expect(observation.composerPresent).toBe(true);
    expect(observation.composerText).toBe("Draft text");
    expect(observation.generating).toBe(true);
    expect(observation.sendEnabled).toBe(true);
  });

  it("treats a hidden stop control as not generating and a disabled send as not enabled", () => {
    const observation = observe(`
      <form>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="stop-button" hidden>Stop</button>
        <button data-testid="send-button" disabled>Send</button>
      </form>
    `);

    expect(observation.generating).toBe(false);
    expect(observation.sendEnabled).toBe(false);
  });

  it("treats controls inside aria-hidden or inert ancestors as not visible", () => {
    const observation = observe(`
      <form>
        <div id="prompt-textarea" contenteditable="true"></div>
        <div aria-hidden="true"><button data-testid="stop-button">Stop</button></div>
        <button data-testid="send-button" aria-disabled="true">Send</button>
        <button aria-label="Stop answering" inert>Stop answering</button>
      </form>
    `);

    expect(observation.generating).toBe(false);
    expect(observation.sendEnabled).toBe(false);
  });

  it("detects a signed-out surface from body copy when no composer exists", () => {
    const observation = observe(`
      <main>
        <h1>Welcome back</h1>
        <button>Log in</button>
      </main>
    `);

    expect(observation.composerPresent).toBe(false);
    expect(observation.loginRequired).toBe(true);
  });

  it("does not report loginRequired when the composer is present", () => {
    const observation = observe(`
      <form>
        <p>Welcome back</p>
        <div id="prompt-textarea" contenteditable="true"></div>
      </form>
    `);

    expect(observation.loginRequired).toBe(false);
  });

  // The /auth path can only be asserted when the happy-dom URL API is present.
  it.skipIf(!urlApiAvailable)("detects an /auth path as loginRequired", () => {
    const observation = observe(
      "<main>Sign in to continue</main>",
      "https://chatgpt.com/auth/login",
    );
    expect(observation.loginRequired).toBe(true);
  });

  // Conversation paths come from location; skipped when the URL API is absent.
  it.skipIf(!urlApiAvailable)("derives the conversationPath prefix from the pathname", () => {
    const observation = observe("<main></main>", "https://chatgpt.com/g/proj_123/c/68f0a1b2-3c4d/");
    expect(observation.conversationPath).toBe("/g/proj_123/c/68f0a1b2-3c4d");
  });

  it.skipIf(!urlApiAvailable)("reads a root conversation path", () => {
    const observation = observe("<main></main>", "https://chatgpt.com/c/68f0a1b2-3c4d");
    expect(observation.conversationPath).toBe("/c/68f0a1b2-3c4d");
  });

  it.skipIf(!urlApiAvailable)("rejects share and non-conversation paths", () => {
    const share = observe("<main></main>", "https://chatgpt.com/share/c/68f0a1b2-3c4d");
    const root = observe("<main></main>", "https://chatgpt.com/");
    expect(share.conversationPath).toBeNull();
    expect(root.conversationPath).toBeNull();
  });

  it("reads a visible transport alert and skips hidden announcements", () => {
    const observation = observe(`
      <div class="sr-only" role="alert">Reasoning details opened</div>
      <div role="alert" aria-hidden="true">Hidden alert</div>
      <div role="alert">Message delivery timed out. Please try again.</div>
    `);

    expect(observation.errorText).toBe("Message delivery timed out. Please try again.");
  });

  it("ignores visible non-failure alerts", () => {
    const observation = observe(`
      <div role="alert">Actions refreshed.</div>
      <div role="alert">Dictation is active and in use</div>
    `);

    expect(observation.errorText).toBeNull();
  });

  it("detects a transport-failure card in the newest assistant turn", () => {
    const observation = observe(`
      <section data-testid="conversation-turn-1" data-turn="assistant">
        <div class="markdown">Message delivery timed out. Please try again.</div>
        <button>Retry</button>
      </section>
    `);

    expect(observation.errorText).toContain("Message delivery timed out. Please try again.");
    expect(observation.errorText).toContain("Retry");
    expect(observation.turns[0]?.text).toBe("");
  });

  it("does not carry a historical assistant failure into the newest answer", () => {
    const observation = observe(`
      <section data-testid="conversation-turn-1" data-turn="assistant">
        <div class="markdown">Network error.</div>
      </section>
      <section data-testid="conversation-turn-2" data-turn="user">
        <div class="whitespace-pre-wrap">Try again</div>
      </section>
      <section data-testid="conversation-turn-3" data-turn="assistant">
        <div class="markdown">Recovered answer</div>
      </section>
    `);

    expect(observation.errorText).toBeNull();
  });

  it("clamps oversized message text and ignores an unknown oversized banner", () => {
    const message = "x".repeat(30_000);
    const banner = "y".repeat(1_000);
    const observation = observe(`
      <section data-testid="conversation-turn-1" data-turn="user">
        <div data-message-author-role="user" data-message-id="user-1">
          <div class="whitespace-pre-wrap">${message}</div>
        </div>
      </section>
      <div role="alert">${banner}</div>
    `);

    expect(observation.turns[0]?.text.length).toBe(12_000);
    expect(observation.errorText).toBeNull();
  });

  it("returns safe defaults on an empty DOM without throwing", () => {
    const observation = observe("");

    expect(typeof observation.url).toBe("string");
    expect(observation.conversationPath).toBeNull();
    expect(observation.loginRequired).toBe(false);
    expect(observation.composerPresent).toBe(false);
    expect(observation.composerText).toBe("");
    expect(observation.generating).toBe(false);
    expect(observation.sendEnabled).toBe(false);
    expect(observation.turns).toEqual([]);
    expect(observation.latestAssistantCompleted).toBe(false);
    expect(observation.terminalAssistantText).toBeNull();
    expect(observation.toolRowCount).toBe(0);
    expect(observation.errorText).toBeNull();
  });
});

describe("parseChatGptObservation", () => {
  it("rejects non-objects and values without a url", () => {
    expect(parseChatGptObservation(null)).toBeNull();
    expect(parseChatGptObservation(undefined)).toBeNull();
    expect(parseChatGptObservation(42)).toBeNull();
    expect(parseChatGptObservation("observation")).toBeNull();
    expect(parseChatGptObservation([])).toBeNull();
    expect(parseChatGptObservation({})).toBeNull();
    expect(parseChatGptObservation({ url: 7 })).toBeNull();
    expect(parseChatGptObservation({ url: "" })).toBeNull();
  });

  it("filters invalid turns and clamps oversized fields", () => {
    const observation = parseChatGptObservation({
      url: "https://chatgpt.com/c/68f0a1b2",
      conversationPath: "not-a-path",
      loginRequired: "yes",
      composerPresent: 1,
      composerText: "z".repeat(25_000),
      generating: false,
      sendEnabled: true,
      toolRowCount: -3.9,
      errorText: "e".repeat(1_000),
      latestAssistantCompleted: true,
      terminalAssistantText: "t".repeat(25_000),
      turns: [
        { role: "system", text: "ignored" },
        null,
        "turn",
        { role: "user", text: "u".repeat(25_000), messageId: 12, interrupted: "true" },
        { role: "assistant", text: "answer", messageId: "assistant-1", interrupted: true },
      ],
    });

    expect(observation).not.toBeNull();
    expect(observation?.conversationPath).toBeNull();
    expect(observation?.loginRequired).toBe(false);
    expect(observation?.composerPresent).toBe(false);
    expect(observation?.composerText.length).toBe(20_000);
    expect(observation?.toolRowCount).toBe(0);
    expect(observation?.errorText?.length).toBe(500);
    expect(observation?.latestAssistantCompleted).toBe(true);
    expect(observation?.terminalAssistantText?.length).toBe(12_000);
    expect(observation?.turns).toEqual([
      { role: "user", text: "u".repeat(12_000), messageId: null, interrupted: false },
      { role: "assistant", text: "answer", messageId: "assistant-1", interrupted: true },
    ]);
  });

  it("keeps only the newest ten turns", () => {
    const turns = Array.from({ length: 12 }, (_, index) => ({
      role: "user",
      text: `turn-${index}`,
      messageId: `message-${index}`,
      interrupted: false,
    }));
    const observation = parseChatGptObservation({ url: "https://chatgpt.com/", turns });

    expect(observation?.turns).toHaveLength(10);
    expect(observation?.turns[0]?.text).toBe("turn-2");
    expect(observation?.turns[9]?.text).toBe("turn-11");
  });

  it("keeps a well-formed conversationPath and defaults missing fields", () => {
    const observation = parseChatGptObservation({
      url: "https://chatgpt.com/g/abc/c/68f0a1b2",
      conversationPath: "/g/abc/c/68f0a1b2",
    });

    expect(observation?.conversationPath).toBe("/g/abc/c/68f0a1b2");
    expect(observation?.turns).toEqual([]);
    expect(observation?.latestAssistantCompleted).toBe(false);
    expect(observation?.terminalAssistantText).toBeNull();
    expect(observation?.composerText).toBe("");
    expect(observation?.toolRowCount).toBe(0);
    expect(observation?.errorText).toBeNull();
  });
});

describe("access-limit detection", () => {
  const englishDialog = `
    <div role="dialog">
      <h2>Too many requests</h2>
      <p>You have been temporarily limited. Access to this conversation is temporarily limited for a few minutes. Please try again later.</p>
      <button type="button">Got it</button>
    </div>`;

  it("detects the English access-limit dialog and its acknowledgement", () => {
    const observation = observe(englishDialog);

    expect(observation.rateLimitText).toContain("Too many requests");
    expect(observation.rateLimitText).toContain("few minutes");
    expect(observation.rateLimitDismissible).toBe(true);
  });

  it("detects the Korean surface", () => {
    const korean = `
      <div role="alertdialog">
        <h1>요청이 너무 많습니다</h1>
        <p>데이터를 보호하기 위해 대화에 대한 액세스가 일시적으로 제한되었습니다. 몇 분 후 다시 시도해 주세요.</p>
        <button type="button">알겠습니다</button>
      </div>`;
    const observation = observe(korean);

    expect(observation.rateLimitText).toContain("요청이 너무 많습니다");
    expect(observation.rateLimitDismissible).toBe(true);
  });

  it("ignores hidden dialogs, unrelated modals and oversized bodies", () => {
    const hidden = observe(`<div role="dialog" hidden>${englishDialog}</div>`);
    expect(hidden.rateLimitText).toBeNull();

    const unrelated = observe(`
      <div role="dialog"><h2>Share conversation</h2><p>Anyone with the link can view.</p></div>`);
    expect(unrelated.rateLimitText).toBeNull();

    const oversized = observe(`
      <div role="dialog">
        <h2>Too many requests</h2>
        <p>You have been temporarily limited for a few minutes. ${"x".repeat(600)}</p>
        <button type="button">Got it</button>
      </div>`);
    expect(oversized.rateLimitText).toBeNull();
  });

  it("marks the notice non-dismissible when several acknowledgements exist", () => {
    const observation = observe(`
      <div role="dialog">
        <h2>Too many requests</h2>
        <p>You have been temporarily limited. Access is temporarily limited for a few minutes.</p>
        <button type="button">Got it</button>
        <button type="button">Got it</button>
      </div>`);

    expect(observation.rateLimitText).not.toBeNull();
    expect(observation.rateLimitDismissible).toBe(false);
  });

  it("dismisses exactly one acknowledgement through the dispatch expression", () => {
    if (typeof window !== "object") return;
    // happy-dom needs the DOM query APIs; the observation helper already proves
    // the environment supports them.
    const evaluateDismiss = (html: string): boolean => {
      document.body.innerHTML = html;
      const expression = buildDismissRateLimitExpression();
      const evaluate = new Function(`return (${expression});`);
      return evaluate() === true;
    };

    expect(evaluateDismiss(englishDialog)).toBe(true);
    expect(evaluateDismiss(`<div role="dialog"><h2>Share</h2></div>`)).toBe(false);
  });

  it("keeps rate-limit defaults safe on an empty DOM", () => {
    const observation = observe("");
    expect(observation.rateLimitText).toBeNull();
    expect(observation.rateLimitDismissible).toBe(false);
  });
});
