// Keeps Synara's transport context in ChatGPT's native message model while
// presenting only the exact user-authored tail in the visible conversation.
// Adapted from Chat On Steroids (MIT) — extension/chatgpt-dom.js.

(() => {
  "use strict";

  const ACTIVE = "__synaraPromptPresentationV1";
  if (window[ACTIVE]) return;
  window[ACTIVE] = true;

  const TURN = 'section[data-testid^="conversation-turn"]';
  const ROLE = '[data-message-author-role="user"]';
  const USER_TEXT = ".whitespace-pre-wrap, .markdown";
  const DISPLAY = "[data-synara-user-text]";
  const MAX_SOURCE_CHARS = 100_000;
  const settledSections = new WeakSet();

  function safe(read, fallback) {
    try {
      const value = read();
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function fiberOf(node) {
    return safe(() => {
      for (const key in node) {
        if (key.startsWith("__reactFiber$")) return node[key];
      }
      return null;
    }, null);
  }

  function turnMessagesOf(fiber) {
    return safe(() => {
      for (let at = fiber, up = 0; at && up < 80; up++, at = at.return) {
        const props = at.memoizedProps;
        if (!props || typeof props !== "object") continue;
        if (props.turn && typeof props.turn === "object" && Array.isArray(props.turn.messages)) {
          return props.turn.messages;
        }
        if (Array.isArray(props.allMessages)) return props.allMessages;
      }
      return null;
    }, null);
  }

  function messageText(message) {
    return safe(() => {
      const content = message?.content;
      if (!content || typeof content !== "object") return "";
      if (Array.isArray(content.parts)) {
        return content.parts
          .filter((part) => typeof part === "string")
          .join("\n")
          .slice(0, MAX_SOURCE_CHARS);
      }
      return typeof content.text === "string" ? content.text.slice(0, MAX_SOURCE_CHARS) : "";
    }, "");
  }

  function authoredPromptText(value) {
    return safe(() => {
      const text = String(value || "")
        .replace(/\r\n?/g, "\n")
        .trimStart();
      const header = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(text);
      if (!header) return null;
      const contextEnd = header[0].length + Number(header[1]);
      const boundary = "\n[[/COS_CONTEXT]]\n\n";
      return text.startsWith(boundary, contextEnd)
        ? text.slice(contextEnd + boundary.length)
        : null;
    }, null);
  }

  function modelUserText(section, messageId) {
    return safe(() => {
      const messages = turnMessagesOf(fiberOf(section));
      if (!Array.isArray(messages)) return null;
      const candidates = [];
      for (const message of messages) {
        if (!message || message.author?.role !== "user") continue;
        if (
          !message.content ||
          !["text", "multimodal_text"].includes(message.content.content_type)
        ) {
          continue;
        }
        const value = messageText(message);
        if (!value) continue;
        if (messageId && message.id === messageId) return value;
        candidates.push(value);
      }
      return candidates.length === 1 ? candidates[0] : null;
    }, null);
  }

  function rawBlocks(anchor) {
    return safe(
      () =>
        [...anchor.querySelectorAll(USER_TEXT)].filter((part) => {
          if (part.matches(DISPLAY)) return false;
          const outer = part.parentElement?.closest(USER_TEXT);
          return !outer || outer === anchor || !anchor.contains(outer);
        }),
      [],
    );
  }

  function present(section) {
    if (settledSections.has(section)) return;
    const anchor = section.matches(ROLE) ? section : section.querySelector(ROLE) || section;
    const role =
      anchor.getAttribute?.("data-message-author-role") || section.getAttribute?.("data-turn");
    if (role !== "user") return;
    const holder =
      anchor.closest?.("[data-message-id]") || anchor.querySelector?.("[data-message-id]");
    const messageId = holder?.getAttribute?.("data-message-id") || null;
    const source = modelUserText(section, messageId);
    if (source === null) return;
    const authored = source === null ? null : authoredPromptText(source);
    if (authored === null) {
      settledSections.add(section);
      return;
    }

    const raw = rawBlocks(anchor);
    if (raw.length === 0) return;
    let display = anchor.querySelector(DISPLAY);
    if (!display) {
      display = document.createElement("div");
      display.setAttribute("data-synara-user-text", "");
      display.className = "whitespace-pre-wrap";
      display.dir = "auto";
      display.style.whiteSpace = "pre-wrap";
      display.style.overflowWrap = "anywhere";
      raw.at(-1).after(display);
    }
    if (display.textContent !== authored) display.textContent = authored;
    for (const block of raw) {
      if (!block.hasAttribute("data-synara-prompt-hidden")) {
        block.setAttribute("data-synara-prompt-hidden", "");
      }
      if (block.style.getPropertyValue("display") !== "none") {
        block.style.setProperty("display", "none", "important");
      }
    }
    settledSections.add(section);
  }

  function presentAll() {
    for (const section of document.querySelectorAll(TURN)) present(section);
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      presentAll();
    });
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-message-author-role", "data-message-id", "data-turn", "data-turn-id"],
    characterData: true,
    childList: true,
    subtree: true,
  });
  presentAll();
})();
