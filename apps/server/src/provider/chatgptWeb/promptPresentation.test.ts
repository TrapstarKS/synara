// @vitest-environment happy-dom

// FILE: promptPresentation.test.ts
// Purpose: Execute the exact Chromium content script against a ChatGPT-shaped
//          DOM and prove hidden transport context never becomes visible text.
// Layer: Server provider / ChatGPT extension integration tests

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const SOURCE = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../extensions/chatgpt-browser/prompt-presentation.js",
  ),
  "utf8",
);

declare const document: {
  readonly body: { innerHTML: string };
  readonly querySelector: (selector: string) => unknown;
};

it("presents the authored tail while retaining the native framed message", () => {
  document.body.innerHTML = `
    <section data-testid="conversation-turn-1" data-turn="user">
      <div data-message-author-role="user" data-message-id="user-1">
        <div class="markdown">rendered transport frame</div>
      </div>
    </section>
    <section data-testid="conversation-turn-2" data-turn="user">
      <div data-message-author-role="user" data-message-id="user-2">
        <div class="whitespace-pre-wrap">ordinary message</div>
      </div>
    </section>
  `;
  const framed = document.querySelector('section[data-testid="conversation-turn-1"]') as Record<
    string,
    unknown
  > | null;
  const ordinary = document.querySelector('section[data-testid="conversation-turn-2"]') as Record<
    string,
    unknown
  > | null;
  if (!framed || !ordinary) throw new Error("fixture sections are missing");
  framed["__reactFiber$test"] = {
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
  ordinary["__reactFiber$test"] = {
    memoizedProps: {
      turn: {
        messages: [
          {
            id: "user-2",
            author: { role: "user" },
            content: { content_type: "text", parts: ["ordinary message"] },
          },
        ],
      },
    },
  };

  new Function(SOURCE)();

  const display = document.querySelector("[data-synara-user-text]") as {
    readonly textContent?: string | null;
  } | null;
  const hidden = document.querySelector("[data-synara-prompt-hidden]") as {
    readonly style?: { readonly display?: string };
  } | null;
  const ordinaryText = document.querySelector(
    'section[data-testid="conversation-turn-2"] .whitespace-pre-wrap',
  ) as { readonly textContent?: string | null } | null;
  expect(display?.textContent).toBe("oi");
  expect(hidden?.style?.display).toBe("none");
  expect(ordinaryText?.textContent).toBe("ordinary message");
});
