// FILE: pageScript.ts
// Purpose: Build the self-contained `browser_evaluate` expression that reads a
//          live chatgpt.com page into a ChatGptObservation, and defensively
//          parse the JSON value that comes back over the browser RPC.
// Layer: Server provider / ChatGPT web driver
//
// Adapted from Chat On Steroids (MIT) — extension/chatgpt-dom.js for the safe
// read style (every read answers with an empty value instead of throwing) and
// the turn/message/selector strategy.
// Terminal completion evidence is adapted from extension/fiber.js
// `turnEndMessageId`: the page model's successful `end_turn: true` is
// authoritative even if a stale Stop control remains.
//
// The expression is compiled and run by the desktop browser in the page's main
// world, so it must stay fully self-contained (no imports, no closures) and its
// result must be plain JSON data. Selector strings are injected from the
// provider's single selector inventory, so ChatGPT vocabulary stays there.

import { CHATGPT_SELECTORS } from "./selectors.ts";
import type { ChatGptObservation, ChatGptTurnObservation } from "./types.ts";

/** Only the newest turns are observed; the driver walks history separately. */
const MAX_TURNS = 10;
/** ChatGptTurnObservation.text cap in both the expression and the parser. */
// 10 turns × 12k keeps the whole observation comfortably inside the
// browser tool's 256 KiB result bound.
const MESSAGE_TEXT_CAP = 12_000;
/** ChatGptObservation.errorText cap. */
const ERROR_TEXT_CAP = 500;
/** ChatGptObservation.rateLimitText cap. */
const RATE_LIMIT_TEXT_CAP = 500;
/** ChatGptObservation.composerText cap. */
const COMPOSER_TEXT_CAP = 20_000;
/** Leading body-text window scanned for signed-out account copy. */
const LOGIN_SCAN_CAP = 4_000;
/** Mutation-driven observations still need a bounded fallback for throttled pages. */
const DEFAULT_OBSERVATION_WAIT_MS = 1_000;

/**
 * `/c/<id>` or a Project's `/g/<gid>/c/<id>`. `/share/c/<id>` is a public
 * read-only snapshot and is deliberately not recognised.
 */
const CONVERSATION_PATH_RE = /^\/(?:g\/[^/]+\/)?c\/[0-9a-f-]{8,64}$/;

/**
 * Builds `(() => { ... })()`. The returned string is passed verbatim to
 * `browser_evaluate`, so it references nothing outside itself and returns an
 * object with exactly the ChatGptObservation shape. Every sub-read is wrapped
 * so a page redesign yields empty data instead of an exception.
 */
export function buildChatGptObservationExpression(): string {
  return String.raw`(() => {
  // ChatGPT vocabulary is injected from the provider's selector inventory.
  var S = ${JSON.stringify(CHATGPT_SELECTORS)};
  var TURN_SECTION = S.turnSection;
  var MESSAGE_ANCHOR = S.messageRoleAnchor;
  var USER_TEXT = S.userText;
  var USER_PROMPT_DISPLAY = S.userPromptDisplay;
  var ASSISTANT_MARKDOWN = S.assistantMarkdown;
  var TOOL_ROW = S.toolRow;
  var INTERRUPTED = S.interruptedMarker;
  var STOP_CONTROL = S.stopControl;
  var SEND_CONTROL = S.sendControl;
  var COMPOSER = S.composer;
  var ALERT_BANNER = S.alertBanner;
  var DIALOG = S.dialog;
  var DIALOG_HEADING = S.dialogHeading;
  var SCREEN_READER_ONLY = S.screenReaderOnly;
  var MESSAGE_ID = S.messageId;
  var ATTRIBUTE_MESSAGE_ROLE = S.attributes.messageRole;
  var ATTRIBUTE_MESSAGE_ID = S.attributes.messageId;
  var ATTRIBUTE_TURN_ROLE = S.attributes.turnRole;
  var ATTRIBUTE_TURN_ID = S.attributes.turnId;
  var ATTRIBUTE_USER_PROMPT_HIDDEN = S.attributes.userPromptHidden;
  var ATTRIBUTE_USER_PROMPT_DISPLAY = S.attributes.userPromptDisplay;

  var MAX_TURNS = ${MAX_TURNS};
  var MESSAGE_TEXT_CAP = ${MESSAGE_TEXT_CAP};
  var ERROR_TEXT_CAP = ${ERROR_TEXT_CAP};
  var RATE_LIMIT_TEXT_CAP = ${RATE_LIMIT_TEXT_CAP};
  var COMPOSER_TEXT_CAP = ${COMPOSER_TEXT_CAP};
  var LOGIN_SCAN_CAP = ${LOGIN_SCAN_CAP};
  // The hidden frame can be larger than the transcript observation cap. It is
  // parsed inside the page and only its authored tail crosses the bridge.
  var FRAMED_USER_TEXT_CAP = 100000;

  // Conversation identity comes from the pathname only: an optional /g/<gid>
  // project segment, then /c/<id>. The trailing separator is matched so a bare
  // /c/<id> prefix cannot swallow a longer unrelated path, then stripped.
  var CONVERSATION_PATH = /^\/(?:g\/[^/]+\/)?c\/[0-9a-f-]{8,64}(?:\/|$)/;

  // Login heuristic: a signed-out surface either lives under /auth or shows
  // account copy ("Log in", "Welcome back", ...) in the first screenful of body
  // text, and it has no composer. The driver only uses this to ask the user to
  // sign in, so a false positive is cheap and a false negative is retried.
  var LOGIN_NOTICE = /log in|sign in|welcome back|create account/i;

  // Provider access throttling is a modal notice ("Too many requests" +
  // "temporarily limited ... access" + "few minutes"), not a transport error.
  // Ported from the reference implementation, including the Korean surface.
  var RATE_LIMIT_HEADING = /^too many requests$/i;
  var RATE_LIMIT_BODY = /temporarily limited.*access/i;
  var RATE_LIMIT_WINDOW = /few minutes/i;
  var RATE_LIMIT_HEADING_KO = "\uc694\uccad\uc774 \ub108\ubb34 \ub9ce\uc2b5\ub2c8\ub2e4";
  var RATE_LIMIT_BODY_KO_A = "\uc561\uc138\uc2a4\uac00 \uc77c\uc2dc\uc801\uc73c\ub85c \uc81c\ud55c\ub418\uc5c8\uc2b5\ub2c8\ub2e4";
  var RATE_LIMIT_BODY_KO_B = "\uba87 \ubd84 \ud6c4 \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694";
  var RATE_LIMIT_ACK = /^got it$/i;
  var RATE_LIMIT_ACK_KO = "\uc54c\uaca0\uc2b5\ub2c8\ub2e4";
  var TRANSPORT_FAILURE = /^(?:conversation not found\.?|this conversation is no longer available\.?|message delivery timed out(?:\. please try again\.?)?|connection interrupted\.? waiting for the complete answer\.?|unknown error occurred\.?|there was an error generating (?:a|the) response\.?|error in message stream\.?|network error\.?|something went wrong\.?|something went wrong while generating the response(?:\. if this issue persists please contact us through our help center at help\.openai\.com\.?)?\.?)(?: retry)?$/i;

  var safe = function (read, fallback) {
    try {
      var value = read();
      return value === undefined || value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  };

  var textOf = function (node, cap) {
    if (!node) return "";
    var value = typeof node.textContent === "string" ? node.textContent : "";
    return value.replace(/\u00a0/g, " ").trim().slice(0, cap);
  };

  var inside = function (node, selector) {
    return safe(function () {
      return typeof node.closest === "function" && node.closest(selector) !== null;
    }, false);
  };

  var contains = function (node, selector) {
    return safe(function () {
      return typeof node.querySelector === "function" && node.querySelector(selector) !== null;
    }, false);
  };

  // Simple visibility: hidden/aria-hidden/inert ancestors, then a layout box.
  // A DOM that cannot measure (no getClientRects) counts as visible, so a
  // reduced environment cannot silently hide a real stop control or error.
  var isVisible = function (node) {
    if (!node) return false;
    for (var parent = node; parent; parent = parent.parentElement) {
      if (parent.hidden === true) return false;
      if (typeof parent.getAttribute !== "function") continue;
      if (parent.getAttribute("aria-hidden") === "true") return false;
      if (typeof parent.hasAttribute === "function" && parent.hasAttribute("inert")) return false;
    }
    if (typeof node.getClientRects !== "function") return true;
    return node.getClientRects().length > 0;
  };

  var readConversationPath = function () {
    return safe(function () {
      var match = CONVERSATION_PATH.exec(String(location.pathname || ""));
      return match ? match[0].replace(/\/$/, "") : null;
    }, null);
  };

  var readComposer = function () {
    return safe(function () {
      return document.querySelector(COMPOSER);
    }, null);
  };

  var readComposerText = function (node) {
    if (!node) return "";
    return safe(function () {
      var value =
        typeof node.value === "string"
          ? node.value
          : typeof node.textContent === "string"
            ? node.textContent
            : "";
      return value.replace(/\u00a0/g, " ").trim().slice(0, COMPOSER_TEXT_CAP);
    }, "");
  };

  var readGenerating = function () {
    return safe(function () {
      var buttons = document.querySelectorAll(STOP_CONTROL);
      for (var index = 0; index < buttons.length; index++) {
        if (isVisible(buttons[index])) return true;
      }
      return false;
    }, false);
  };

  var readSendEnabled = function () {
    return safe(function () {
      var buttons = document.querySelectorAll(SEND_CONTROL);
      for (var index = 0; index < buttons.length; index++) {
        var button = buttons[index];
        if (button.disabled === true) continue;
        if (typeof button.getAttribute === "function" &&
          button.getAttribute("aria-disabled") === "true") continue;
        return true;
      }
      return false;
    }, false);
  };

  var isTransportFailure = function (value) {
    return TRANSPORT_FAILURE.test(String(value || "").replace(/\s+/g, " ").trim());
  };

  var newestAssistantContains = function (group, node) {
    return safe(function () {
      if (!group || !node) return false;
      var section = node.closest(TURN_SECTION);
      if (!section) return true;
      return group.sections.indexOf(section) !== -1;
    }, false);
  };

  var readErrorText = function (newestAssistantGroup) {
    return safe(function () {
      var alerts = document.querySelectorAll(ALERT_BANNER);
      for (var index = 0; index < alerts.length; index++) {
        var alert = alerts[index];
        // Screen-reader-only live regions are announcements, not visible errors.
        if (inside(alert, SCREEN_READER_ONLY)) continue;
        if (!isVisible(alert)) continue;
        var value = textOf(alert, ERROR_TEXT_CAP);
        if (value && isTransportFailure(value)) return value;
      }
      // Current failure cards may have no alert role. Start from their exact
      // Retry control and accept only the nearest complete known notice.
      var buttons = document.querySelectorAll("button");
      for (var buttonIndex = 0; buttonIndex < buttons.length; buttonIndex++) {
        var button = buttons[buttonIndex];
        if (!isVisible(button) || !/^retry$/i.test(textOf(button, 64))) continue;
        if (!newestAssistantContains(newestAssistantGroup, button)) continue;
        for (var node = button.parentElement, up = 0;
          node && node !== document.body && up < 8;
          up++, node = node.parentElement) {
          var notice = textOf(node, ERROR_TEXT_CAP);
          if (notice.length >= ERROR_TEXT_CAP) break;
          if (isVisible(node) && isTransportFailure(notice)) return notice;
        }
      }
      if (newestAssistantGroup) {
        for (var sectionIndex = 0;
          sectionIndex < newestAssistantGroup.sections.length;
          sectionIndex++) {
          var section = newestAssistantGroup.sections[sectionIndex];
          var markdown = section.querySelectorAll(ASSISTANT_MARKDOWN);
          for (var markdownIndex = 0; markdownIndex < markdown.length; markdownIndex++) {
            var markdownText = textOf(markdown[markdownIndex], ERROR_TEXT_CAP);
            if (markdownText && isTransportFailure(markdownText)) return markdownText;
          }
          var expanded = section.querySelectorAll('button[aria-expanded]');
          for (var expandedIndex = 0; expandedIndex < expanded.length; expandedIndex++) {
            if (isVisible(expanded[expandedIndex]) &&
              textOf(expanded[expandedIndex], 64) === "Thinking failed") {
              return "Thinking failed";
            }
          }
        }
      }
      return null;
    }, null);
  };

  // Identifies the live access-limit notice. Returns the notice text and
  // whether a single acknowledgement button can dismiss it. Pure read: the
  // caller decides when to click, so observation never mutates the page.
  var readRateLimit = function () {
    return safe(function () {
      var dialogs = document.querySelectorAll(DIALOG);
      for (var index = 0; index < dialogs.length; index++) {
        var node = dialogs[index];
        if (inside(node, SCREEN_READER_ONLY)) continue;
        if (!isVisible(node)) continue;
        var headingNode = node.querySelector(DIALOG_HEADING);
        var headingText = headingNode ? textOf(headingNode, RATE_LIMIT_TEXT_CAP) : "";
        var value = "";
        var raw =
          typeof node.innerText === "string" && node.innerText.length > 0
            ? node.innerText
            : typeof node.textContent === "string"
              ? node.textContent
              : "";
        value = raw.replace(/\s+/g, " ").trim();
        var english =
          RATE_LIMIT_HEADING.test(headingText) &&
          RATE_LIMIT_BODY.test(value) &&
          RATE_LIMIT_WINDOW.test(value);
        var korean =
          headingText === RATE_LIMIT_HEADING_KO &&
          value.indexOf(RATE_LIMIT_BODY_KO_A) !== -1 &&
          value.indexOf(RATE_LIMIT_BODY_KO_B) !== -1;
        if (value.length >= 500 || (!english && !korean)) continue;
        var notice =
          headingText && value.indexOf(headingText) === 0
            ? headingText + " " + value.slice(headingText.length).trim()
            : value;
        var acks = 0;
        var buttons = node.querySelectorAll("button");
        for (var buttonIndex = 0; buttonIndex < buttons.length; buttonIndex++) {
          var button = buttons[buttonIndex];
          if (!isVisible(button)) continue;
          if (button.disabled === true) continue;
          if (typeof button.getAttribute === "function" &&
            button.getAttribute("aria-disabled") === "true") continue;
          var label = textOf(button, 64);
          if (RATE_LIMIT_ACK.test(label) || label === RATE_LIMIT_ACK_KO) acks++;
        }
        return { text: notice.slice(0, RATE_LIMIT_TEXT_CAP), dismissible: acks === 1 };
      }
      return { text: null, dismissible: false };
    }, { text: null, dismissible: false });
  };

  var readRole = function (anchor) {
    return safe(function () {
      if (!anchor || typeof anchor.getAttribute !== "function") return "";
      return String(anchor.getAttribute(ATTRIBUTE_MESSAGE_ROLE) || "");
    }, "");
  };

  var readSectionRole = function (section, anchor) {
    var messageRole = readRole(anchor);
    if (messageRole === "user" || messageRole === "assistant") return messageRole;
    return safe(function () {
      if (!section || typeof section.getAttribute !== "function") return "";
      var turnRole = String(section.getAttribute(ATTRIBUTE_TURN_ROLE) || "");
      return turnRole === "user" || turnRole === "assistant" ? turnRole : "";
    }, "");
  };

  var readTurnId = function (section) {
    return safe(function () {
      if (!section || typeof section.getAttribute !== "function") return null;
      var value = String(section.getAttribute(ATTRIBUTE_TURN_ID) || "");
      return value || null;
    }, null);
  };

  var readMessageId = function (anchor) {
    return safe(function () {
      if (!anchor || typeof anchor.closest !== "function") return null;
      var holder = anchor.closest(MESSAGE_ID) || anchor.querySelector(MESSAGE_ID);
      if (!holder || typeof holder.getAttribute !== "function") return null;
      var id = String(holder.getAttribute(ATTRIBUTE_MESSAGE_ID) || "");
      return id || null;
    }, null);
  };

  var readUserText = function (anchor) {
    var presented = safe(function () {
      return anchor.querySelector(USER_PROMPT_DISPLAY);
    }, null);
    if (presented) return textOf(presented, MESSAGE_TEXT_CAP);
    var parts = [];
    var held = safe(function () {
      return anchor.querySelectorAll(USER_TEXT);
    }, []);
    for (var index = 0; index < held.length; index++) {
      var part = held[index];
      if (safe(function () { return part.matches(USER_PROMPT_DISPLAY); }, false)) continue;
      // Nested wrappers with the same class would otherwise read twice.
      var outer = safe(function () {
        var parent = part.parentElement;
        if (!parent || typeof parent.closest !== "function") return null;
        return parent.closest(USER_TEXT);
      }, null);
      if (outer && outer !== anchor && typeof anchor.contains === "function" &&
        anchor.contains(outer)) continue;
      var value = textOf(part, MESSAGE_TEXT_CAP);
      if (value) parts.push(value);
    }
    if (parts.length > 0) return parts.join("\n").slice(0, MESSAGE_TEXT_CAP);
    return textOf(anchor, MESSAGE_TEXT_CAP);
  };

  var readAssistantText = function (anchor) {
    var parts = [];
    var blocks = safe(function () {
      return anchor.querySelectorAll(ASSISTANT_MARKDOWN);
    }, []);
    for (var index = 0; index < blocks.length; index++) {
      var block = blocks[index];
      // Progress/commentary blocks and tool rows are chrome, not the answer.
      if (inside(block, INTERRUPTED)) continue;
      if (inside(block, TOOL_ROW)) continue;
      var value = textOf(block, MESSAGE_TEXT_CAP);
      if (!value) continue;
      if (isTransportFailure(value)) continue;
      if (parts.length > 0 && parts[parts.length - 1] === value) continue;
      parts.push(value);
    }
    return parts.join("\n\n").slice(0, MESSAGE_TEXT_CAP);
  };

  // React exposes the page's turn model on an ancestor Fiber of the rendered
  // conversation section. Read only the public terminal assistant message:
  // no request arguments, account state or private analysis crosses the RPC.
  var fiberOf = function (node) {
    return safe(function () {
      for (var key in node) {
        if (key.indexOf("__reactFiber$") === 0) return node[key];
      }
      return null;
    }, null);
  };

  var turnMessagesOf = function (fiber) {
    return safe(function () {
      for (var at = fiber, up = 0; at && up < 80; up++, at = at.return) {
        var props = at.memoizedProps;
        if (!props || typeof props !== "object") continue;
        var turn = props.turn;
        if (turn && typeof turn === "object" && Array.isArray(turn.messages)) {
          return turn.messages;
        }
        if (Array.isArray(props.allMessages)) return props.allMessages;
      }
      return null;
    }, null);
  };

  // React does not attach the Fiber marker to one stable DOM node. The older
  // renderer put it on the turn section itself; the current renderer can put
  // it on the message anchor (or one of its markdown descendants). Prefer a
  // Fiber whose ancestor actually exposes the turn model, rather than stopping
  // at the first marker that happens to be present on a layout wrapper.
  var turnMessagesFromSection = function (section) {
    return safe(function () {
      if (!section) return null;
      var direct = turnMessagesOf(fiberOf(section));
      if (Array.isArray(direct)) return direct;
      var nodes = section.querySelectorAll(
        MESSAGE_ANCHOR + "," + MESSAGE_ID + "," + ASSISTANT_MARKDOWN
      );
      for (var index = 0; index < nodes.length; index++) {
        var messages = turnMessagesOf(fiberOf(nodes[index]));
        if (Array.isArray(messages)) return messages;
      }
      return null;
    }, null);
  };

  var modelMessageText = function (message, cap) {
    return safe(function () {
      var content = message && typeof message === "object" ? message.content : null;
      if (!content || typeof content !== "object") return "";
      if (Array.isArray(content.parts)) {
        var parts = [];
        for (var index = 0; index < content.parts.length; index++) {
          if (typeof content.parts[index] === "string") parts.push(content.parts[index]);
        }
        return parts.join("\n").slice(0, cap);
      }
      return typeof content.text === "string"
        ? content.text.slice(0, cap)
        : "";
    }, "");
  };

  var publicAssistantText = function (message) {
    return modelMessageText(message, MESSAGE_TEXT_CAP);
  };

  // Wire framing matches chatgptWeb/userPrompt.ts and the MIT reference. The
  // exact length means user-authored marker-like text stays literal.
  var authoredPromptText = function (value) {
    return safe(function () {
      value = String(value || "").replace(/\r\n?/g, "\n").trimStart();
      var header = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(value);
      if (!header) return null;
      var contextEnd = header[0].length + Number(header[1]);
      var boundary = "\n[[/COS_CONTEXT]]\n\n";
      return value.indexOf(boundary, contextEnd) === contextEnd
        ? value.slice(contextEnd + boundary.length)
        : null;
    }, null);
  };

  var readModelUserText = function (section, messageId) {
    return safe(function () {
      var messages = turnMessagesFromSection(section);
      if (!Array.isArray(messages)) return null;
      var candidates = [];
      for (var index = 0; index < messages.length; index++) {
        var message = messages[index];
        if (!message || typeof message !== "object") continue;
        if (!message.author || message.author.role !== "user") continue;
        var content = message.content;
        if (!content || typeof content !== "object") continue;
        if (["text", "multimodal_text"].indexOf(content.content_type) === -1) continue;
        var value = modelMessageText(message, FRAMED_USER_TEXT_CAP);
        if (!value) continue;
        if (messageId && message.id === messageId) return value;
        candidates.push(value);
      }
      return candidates.length === 1 ? candidates[0] : null;
    }, null);
  };

  // Presentation only. The native framed bytes remain in ChatGPT's message
  // model for model context and receipts; the human sees exactly the authored
  // tail, matching Chat On Steroids' prompt presentation contract.
  var presentAuthoredUserText = function (anchor, authored) {
    safe(function () {
      var existing = anchor.querySelector(USER_PROMPT_DISPLAY);
      var all = anchor.querySelectorAll(USER_TEXT);
      var raw = [];
      for (var index = 0; index < all.length; index++) {
        var part = all[index];
        if (part.matches(USER_PROMPT_DISPLAY)) continue;
        var outer = part.parentElement && part.parentElement.closest
          ? part.parentElement.closest(USER_TEXT)
          : null;
        if (outer && outer !== anchor && anchor.contains(outer)) continue;
        raw.push(part);
      }
      if (raw.length === 0 && anchor.matches && anchor.matches(USER_TEXT) &&
        !anchor.matches(USER_PROMPT_DISPLAY)) raw.push(anchor);
      if (raw.length === 0) return;
      if (!existing) {
        existing = document.createElement("div");
        existing.setAttribute(ATTRIBUTE_USER_PROMPT_DISPLAY, "");
        existing.className = "whitespace-pre-wrap";
        existing.dir = "auto";
        existing.style.whiteSpace = "pre-wrap";
        existing.style.overflowWrap = "anywhere";
        var last = raw[raw.length - 1];
        if (last.after) last.after(existing);
        else anchor.appendChild(existing);
      }
      if (existing.textContent !== authored) existing.textContent = authored;
      for (var rawIndex = 0; rawIndex < raw.length; rawIndex++) {
        raw[rawIndex].setAttribute(ATTRIBUTE_USER_PROMPT_HIDDEN, "");
        raw[rawIndex].style.setProperty("display", "none", "important");
      }
    }, null);
  };

  var readTerminalAssistant = function (section) {
    return safe(function () {
      var messages = turnMessagesFromSection(section);
      if (!Array.isArray(messages)) return { found: false, completed: false, text: null };
      // The newest public answer-capable message decides. A retry can leave an
      // older completed attempt in the same model while the replacement runs.
      for (var index = messages.length - 1; index >= 0; index--) {
        var message = messages[index];
        if (!message || typeof message !== "object") continue;
        var author = message.author;
        if (!author || author.role !== "assistant") continue;
        var content = message.content;
        if (!content || typeof content !== "object") continue;
        if (["text", "multimodal_text", "image"].indexOf(content.content_type) === -1) {
          continue;
        }
        if (message.channel === "analysis" || message.channel === "commentary") continue;
        var metadata = message.metadata;
        if (metadata && typeof metadata === "object" &&
          (metadata.is_visually_hidden_from_conversation === true ||
            metadata.is_visually_hidden === true)) continue;
        if (message.end_turn === true && message.status === "finished_successfully") {
          var value = publicAssistantText(message);
          return { found: true, completed: true, text: value || null };
        }
        // A turn in progress already streams its text through the model. The
        // visible reveal is animation-frame gated and pauses in a background
        // tab, so the model text is what keeps Synara live while the user
        // stays on their own tab.
        return { found: true, completed: false, text: publicAssistantText(message) || null };
      }
      return { found: false, completed: false, text: null };
    }, { found: false, completed: false, text: null });
  };

  // React can advance tool/reasoning state before the visible markdown changes. Keep a
  // privacy-safe activity fingerprint of the newest assistant model: ids and bounded
  // metadata prove that the turn moved, while authored model text continues to cross the
  // bridge only through assistantModelText/terminalAssistantText.
  var modelActivityOf = function (section) {
    return safe(function () {
      var messages = turnMessagesFromSection(section);
      if (!Array.isArray(messages)) return "";
      var parts = [];
      var start = Math.max(0, messages.length - 24);
      for (var index = start; index < messages.length; index++) {
        var message = messages[index];
        if (!message || typeof message !== "object") continue;
        var author = message.author;
        var role = author && typeof author.role === "string" ? author.role : "";
        if (role !== "assistant" && role !== "tool") continue;
        var content = message.content;
        var contentType = content && typeof content === "object" &&
          typeof content.content_type === "string" ? content.content_type : "";
        var textLength = modelMessageText(message, MESSAGE_TEXT_CAP).length;
        parts.push([
          typeof message.id === "string" ? message.id.slice(0, 120) : "",
          role,
          typeof message.channel === "string" ? message.channel : "",
          typeof message.status === "string" ? message.status : "",
          message.end_turn === true ? "1" : "0",
          contentType,
          String(textLength)
        ].join(":"));
      }
      return parts.join("|").slice(-4_000);
    }, "");
  };

  var sections = safe(function () {
    var found = document.querySelectorAll(TURN_SECTION);
    var list = [];
    for (var index = 0; index < found.length; index++) list.push(found[index]);
    return list;
  }, []);
  // Current ChatGPT can split one logical turn across multiple adjacent
  // sections carrying the same data-turn-id. Scan a bounded physical tail,
  // then group before enforcing MAX_TURNS so a split answer is not truncated
  // or mistaken for several independent assistant turns.
  sections = sections.slice(Math.max(0, sections.length - MAX_TURNS * 4));

  var groups = [];
  for (var index = 0; index < sections.length; index++) {
    var section = sections[index];
    var anchor = safe(function () {
      if (typeof section.matches === "function" && section.matches(MESSAGE_ANCHOR)) return section;
      return section.querySelector(MESSAGE_ANCHOR) || section;
    }, section);
    var role = readSectionRole(section, anchor);
    if (role !== "user" && role !== "assistant") continue;
    var messageId = readMessageId(anchor);
    var visibleText = role === "user" ? readUserText(anchor) : readAssistantText(anchor);
    if (role === "user") {
      var modelText = readModelUserText(section, messageId);
      var authoredText = modelText === null ? null : authoredPromptText(modelText);
      if (authoredText !== null) {
        presentAuthoredUserText(anchor, authoredText);
        visibleText = authoredText.slice(0, MESSAGE_TEXT_CAP);
      }
    }
    var turnId = readTurnId(section);
    var previousGroup = groups.length > 0 ? groups[groups.length - 1] : null;
    var group = previousGroup && turnId && previousGroup.turnId === turnId &&
      previousGroup.role === role
      ? previousGroup
      : null;
    if (!group) {
      group = {
        role: role,
        turnId: turnId,
        textParts: [],
        messageId: null,
        interrupted: false,
        sections: []
      };
      groups.push(group);
    }
    if (visibleText && group.textParts[group.textParts.length - 1] !== visibleText) {
      group.textParts.push(visibleText);
    }
    if (!group.messageId && messageId) group.messageId = messageId;
    group.interrupted = group.interrupted || contains(anchor, INTERRUPTED);
    group.sections.push(section);
  }
  groups = groups.slice(Math.max(0, groups.length - MAX_TURNS));

  var turns = [];
  var newestAssistant = null;
  var newestAssistantGroupIndex = -1;
  var newestUserGroupIndex = -1;
  for (var groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    var currentGroup = groups[groupIndex];
    turns.push({
      role: currentGroup.role,
      text: currentGroup.textParts.join(currentGroup.role === "assistant" ? "\n\n" : "\n")
        .slice(0, MESSAGE_TEXT_CAP),
      messageId: currentGroup.messageId,
      interrupted: currentGroup.interrupted
    });
    if (currentGroup.role === "assistant") {
      newestAssistant = currentGroup;
      newestAssistantGroupIndex = groupIndex;
    } else {
      newestUserGroupIndex = groupIndex;
    }
  }

  // A terminal assistant from history cannot complete a newly submitted user
  // turn. Only accept model evidence when that assistant follows the latest
  // visible user section.
  var terminalAssistant =
    { found: false, completed: false, text: null };
  if (newestAssistant && newestAssistantGroupIndex > newestUserGroupIndex) {
    for (var terminalIndex = newestAssistant.sections.length - 1; terminalIndex >= 0; terminalIndex--) {
      var terminalCandidate = readTerminalAssistant(newestAssistant.sections[terminalIndex]);
      if (terminalCandidate.found) {
        terminalAssistant = terminalCandidate;
        break;
      }
    }
  }

  var toolRowCount = 0;
  if (newestAssistant) {
    // A display-contents wrapper can hold a whole answer, so only rows with no
    // .markdown descendant count as tool rows (structural check).
    toolRowCount = safe(function () {
      var count = 0;
      for (var sectionIndex = 0; sectionIndex < newestAssistant.sections.length; sectionIndex++) {
        var rows = newestAssistant.sections[sectionIndex].querySelectorAll(TOOL_ROW);
        for (var index = 0; index < rows.length; index++) {
          if (contains(rows[index], ASSISTANT_MARKDOWN)) continue;
          count++;
        }
      }
      return count;
    }, 0);
  }

  // The turn watchdog must see progress beyond the answer text: tool output,
  // reasoning chrome and status rows all render inside the newest assistant
  // turn. A bounded tail plus the rendered size tells the driver the turn is
  // still moving even while the final answer has not grown yet.
  var assistantActivity = "";
  if (newestAssistant) {
    assistantActivity = safe(function () {
      var total = 0;
      var tail = "";
      var model = "";
      for (var index = 0; index < newestAssistant.sections.length; index++) {
        var raw = String(newestAssistant.sections[index].textContent || "");
        total += raw.length;
        tail = (tail + raw.slice(-200)).slice(-200);
        var nextModel = modelActivityOf(newestAssistant.sections[index]);
        if (nextModel && model.indexOf(nextModel) === -1) {
          model = (model ? model + "|" : "") + nextModel;
        }
      }
      return String(total) + ":" + tail + ":model:" + model;
    }, "");
  }

  var rateLimit = readRateLimit();
  var composerNode = readComposer();
  var composerPresent = composerNode !== null;
  var composerText = readComposerText(composerNode);
  var loginRequired = safe(function () {
    if (composerPresent) return false;
    if (String(location.pathname || "").indexOf("/auth") === 0) return true;
    var body =
      document.body && typeof document.body.textContent === "string"
        ? document.body.textContent
        : "";
    return LOGIN_NOTICE.test(body.slice(0, LOGIN_SCAN_CAP));
  }, false);

  return {
    url: safe(function () {
      return String(location.href);
    }, ""),
    conversationPath: readConversationPath(),
    loginRequired: loginRequired,
    composerPresent: composerPresent,
    composerText: composerText,
    generating: readGenerating(),
    sendEnabled: readSendEnabled(),
    turns: turns,
    latestAssistantCompleted: terminalAssistant.completed,
    latestAssistantInProgress: terminalAssistant.found && !terminalAssistant.completed,
    terminalAssistantText: terminalAssistant.completed ? terminalAssistant.text : null,
    assistantModelText: terminalAssistant.text,
    assistantActivity: assistantActivity,
    toolRowCount: toolRowCount,
    errorText: readErrorText(newestAssistant),
    rateLimitText: rateLimit.text,
    rateLimitDismissible: rateLimit.dismissible
  };
})()`;
}

/**
 * Builds a mutation-driven observation expression for the streaming loop.
 *
 * Chat On Steroids keeps a Fiber recorder alive and uses MutationObserver to wake it when
 * React commits a new answer/tool phase. The external-browser bridge cannot keep a page
 * callback open, so this expression uses the same idea for one bounded RPC: read once,
 * resolve on the next relevant DOM/React commit, and fall back to a short timer when Chrome
 * throttles a background document. The returned value is still the normal observation shape.
 */
export function buildChatGptObservationWaitExpression(
  waitMs = DEFAULT_OBSERVATION_WAIT_MS,
): string {
  const boundedWaitMs = Math.max(
    100,
    Math.min(Number.isFinite(waitMs) ? Math.floor(waitMs) : DEFAULT_OBSERVATION_WAIT_MS, 5_000),
  );
  const observationExpression = buildChatGptObservationExpression();
  return String.raw`(() => {
  var initial = ${observationExpression};
  var signature = function (value) {
    try {
      return JSON.stringify({
        url: value && value.url || "",
        conversationPath: value && value.conversationPath || null,
        loginRequired: value && value.loginRequired === true,
        composerPresent: value && value.composerPresent === true,
        composerText: value && value.composerText || "",
        generating: value && value.generating === true,
        sendEnabled: value && value.sendEnabled === true,
        turns: value && Array.isArray(value.turns) ? value.turns : [],
        latestAssistantCompleted: value && value.latestAssistantCompleted === true,
        latestAssistantInProgress: value && value.latestAssistantInProgress === true,
        terminalAssistantText: value && value.terminalAssistantText || null,
        assistantModelText: value && value.assistantModelText || null,
        assistantActivity: value && value.assistantActivity || "",
        toolRowCount: value && value.toolRowCount || 0,
        errorText: value && value.errorText || null,
        rateLimitText: value && value.rateLimitText || null,
        rateLimitDismissible: value && value.rateLimitDismissible === true
      });
    } catch (error) {
      return "";
    }
  };
  var initialSignature = signature(initial);
  if (typeof MutationObserver !== "function" || !document.body) return initial;
  var selectors = ${JSON.stringify(CHATGPT_SELECTORS)};
  var relevantSelector = [
    selectors.turnSection,
    selectors.composer,
    selectors.alertBanner,
    selectors.stopControl,
    selectors.sendControl
  ].join(",");
  var matchesRelevant = function (node) {
    try {
      if (!node || node.nodeType !== 1) return false;
      return node.matches(relevantSelector) ||
        node.closest(relevantSelector) !== null ||
        node.querySelector(relevantSelector) !== null;
    } catch (error) {
      return false;
    }
  };
  return new Promise(function (resolve) {
    var settled = false;
    var queued = false;
    var timer = null;
    var observer = null;
    var read = function () {
      try {
        return ${observationExpression};
      } catch (error) {
        return initial;
      }
    };
    var finish = function (value) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (observer) observer.disconnect();
      resolve(value);
    };
    var check = function () {
      if (settled) return;
      var next = read();
      if (signature(next) !== initialSignature) finish(next);
    };
    observer = new MutationObserver(function (records) {
      var relevant = false;
      for (var index = 0; index < records.length && !relevant; index++) {
        var record = records[index];
        if (matchesRelevant(record.target && record.target.nodeType === 1
          ? record.target : record.target && record.target.parentElement)) {
          relevant = true;
          break;
        }
        var changed = [];
        for (var addedIndex = 0; addedIndex < (record.addedNodes || []).length; addedIndex++) {
          changed.push(record.addedNodes[addedIndex]);
        }
        for (var removedIndex = 0; removedIndex < (record.removedNodes || []).length; removedIndex++) {
          changed.push(record.removedNodes[removedIndex]);
        }
        for (var nodeIndex = 0; nodeIndex < changed.length; nodeIndex++) {
          if (matchesRelevant(changed[nodeIndex])) {
            relevant = true;
            break;
          }
        }
      }
      if (!relevant) return;
      if (settled || queued) return;
      queued = true;
      Promise.resolve().then(function () {
        queued = false;
        check();
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "aria-hidden",
        "aria-label",
        "class",
        "data-message-author-role",
        "data-message-id",
        "data-testid",
        "data-turn",
        "data-turn-id",
        "hidden",
        "inert",
        "style"
      ]
    });
    timer = setTimeout(function () { finish(read()); }, ${boundedWaitMs});
    check();
  });
})()`;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const asNullableString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const clampText = (value: unknown, cap: number): string => asString(value).slice(0, cap);

const asCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
};

const parseTurn = (value: unknown): ChatGptTurnObservation | null => {
  const record = asRecord(value);
  if (!record) return null;
  const role = record["role"];
  if (role !== "user" && role !== "assistant") return null;
  return {
    role,
    text: clampText(record["text"], MESSAGE_TEXT_CAP),
    messageId: asNullableString(record["messageId"]),
    interrupted: record["interrupted"] === true,
  };
};

/**
 * Narrows the raw `browser_evaluate` result back into a ChatGptObservation.
 * Returns null when the top level is not an object or carries no url; every
 * other field falls back to its safe default, string fields are clamped to the
 * observation caps, and only well-formed turns survive.
 */
export function parseChatGptObservation(value: unknown): ChatGptObservation | null {
  const record = asRecord(value);
  if (!record) return null;

  const url = asString(record["url"]).trim();
  if (!url) return null;

  const rawTurns = Array.isArray(record["turns"]) ? record["turns"] : [];
  const turns: ChatGptTurnObservation[] = [];
  for (const entry of rawTurns) {
    const turn = parseTurn(entry);
    if (turn) turns.push(turn);
  }

  const conversationPath = asNullableString(record["conversationPath"]);
  const errorText = asNullableString(record["errorText"]);
  const rateLimitText = asNullableString(record["rateLimitText"]);
  const terminalAssistantText = asNullableString(record["terminalAssistantText"]);
  const assistantModelText = asNullableString(record["assistantModelText"]);
  const assistantActivity = asNullableString(record["assistantActivity"]);

  return {
    url,
    conversationPath:
      conversationPath && CONVERSATION_PATH_RE.test(conversationPath) ? conversationPath : null,
    loginRequired: record["loginRequired"] === true,
    composerPresent: record["composerPresent"] === true,
    composerText: clampText(record["composerText"], COMPOSER_TEXT_CAP),
    generating: record["generating"] === true,
    sendEnabled: record["sendEnabled"] === true,
    turns: turns.slice(-MAX_TURNS),
    latestAssistantCompleted: record["latestAssistantCompleted"] === true,
    latestAssistantInProgress: record["latestAssistantInProgress"] === true,
    terminalAssistantText: terminalAssistantText
      ? terminalAssistantText.slice(0, MESSAGE_TEXT_CAP)
      : null,
    assistantModelText: assistantModelText ? assistantModelText.slice(0, MESSAGE_TEXT_CAP) : null,
    assistantActivity: assistantActivity ? assistantActivity.slice(0, 1_024) : "",
    toolRowCount: asCount(record["toolRowCount"]),
    errorText: errorText ? errorText.slice(0, ERROR_TEXT_CAP) : null,
    rateLimitText: rateLimitText ? rateLimitText.slice(0, RATE_LIMIT_TEXT_CAP) : null,
    rateLimitDismissible: record["rateLimitDismissible"] === true,
  };
}

/**
 * Builds the acknowledge-only click for a visible access-limit notice. The
 * driver calls this once per turn: the notice blocks new sends, and ChatGPT
 * ships exactly one "Got it" control while it is showing. Clicking grants no
 * retry authority — it only clears the blocking surface so the next attempt
 * can be made deliberately.
 */
export function buildDismissRateLimitExpression(): string {
  return String.raw`(() => {
  var S = ${JSON.stringify(CHATGPT_SELECTORS)};
  var DIALOG = S.dialog;
  var DIALOG_HEADING = S.dialogHeading;
  var SCREEN_READER_ONLY = S.screenReaderOnly;
  var RATE_LIMIT_HEADING = /^too many requests$/i;
  var RATE_LIMIT_BODY = /temporarily limited.*access/i;
  var RATE_LIMIT_WINDOW = /few minutes/i;
  var RATE_LIMIT_HEADING_KO = "\uc694\uccad\uc774 \ub108\ubb34 \ub9ce\uc2b5\ub2c8\ub2e4";
  var RATE_LIMIT_BODY_KO_A = "\uc561\uc138\uc2a4\uac00 \uc77c\uc2dc\uc801\uc73c\ub85c \uc81c\ud55c\ub418\uc5c8\uc2b5\ub2c8\ub2e4";
  var RATE_LIMIT_BODY_KO_B = "\uba87 \ubd84 \ud6c4 \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694";
  var RATE_LIMIT_ACK = /^got it$/i;
  var RATE_LIMIT_ACK_KO = "\uc54c\uaca0\uc2b5\ub2c8\ub2e4";
  try {
    var visible = function (node) {
      for (var parent = node; parent; parent = parent.parentElement) {
        if (parent.hidden === true) return false;
        if (typeof parent.getAttribute !== "function") continue;
        if (parent.getAttribute("aria-hidden") === "true") return false;
        if (typeof parent.hasAttribute === "function" && parent.hasAttribute("inert")) return false;
      }
      if (typeof node.getClientRects !== "function") return true;
      return node.getClientRects().length > 0;
    };
    var dialogs = document.querySelectorAll(DIALOG);
    for (var index = 0; index < dialogs.length; index++) {
      var node = dialogs[index];
      if (node.closest(SCREEN_READER_ONLY)) continue;
      if (!visible(node)) continue;
      var headingNode = node.querySelector(DIALOG_HEADING);
      var headingText = headingNode ? String(headingNode.textContent || "").trim() : "";
      var raw =
        typeof node.innerText === "string" && node.innerText.length > 0
          ? node.innerText
          : typeof node.textContent === "string"
            ? node.textContent
            : "";
      var value = raw.replace(/\s+/g, " ").trim();
      var english =
        RATE_LIMIT_HEADING.test(headingText) &&
        RATE_LIMIT_BODY.test(value) &&
        RATE_LIMIT_WINDOW.test(value);
      var korean =
        headingText === RATE_LIMIT_HEADING_KO &&
        value.indexOf(RATE_LIMIT_BODY_KO_A) !== -1 &&
        value.indexOf(RATE_LIMIT_BODY_KO_B) !== -1;
      if (value.length >= 500 || (!english && !korean)) continue;
      var buttons = node.querySelectorAll("button");
      for (var buttonIndex = 0; buttonIndex < buttons.length; buttonIndex++) {
        var button = buttons[buttonIndex];
        if (!visible(button)) continue;
        if (button.disabled === true) continue;
        if (typeof button.getAttribute === "function" &&
          button.getAttribute("aria-disabled") === "true") continue;
        var label = String(button.textContent || "").trim();
        if (RATE_LIMIT_ACK.test(label) || label === RATE_LIMIT_ACK_KO) {
          button.click();
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    return false;
  }
})()`;
}
