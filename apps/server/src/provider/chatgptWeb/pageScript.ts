// FILE: pageScript.ts
// Purpose: Build the self-contained `browser_evaluate` expression that reads a
//          live chatgpt.com page into a ChatGptObservation, and defensively
//          parse the JSON value that comes back over the browser RPC.
// Layer: Server provider / ChatGPT web driver
//
// Adapted from Chat On Steroids (MIT) — extension/chatgpt-dom.js for the safe
// read style (every read answers with an empty value instead of throwing) and
// the turn/message/selector strategy.
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

  var MAX_TURNS = ${MAX_TURNS};
  var MESSAGE_TEXT_CAP = ${MESSAGE_TEXT_CAP};
  var ERROR_TEXT_CAP = ${ERROR_TEXT_CAP};
  var RATE_LIMIT_TEXT_CAP = ${RATE_LIMIT_TEXT_CAP};
  var COMPOSER_TEXT_CAP = ${COMPOSER_TEXT_CAP};
  var LOGIN_SCAN_CAP = ${LOGIN_SCAN_CAP};

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

  var readErrorText = function () {
    return safe(function () {
      var alerts = document.querySelectorAll(ALERT_BANNER);
      for (var index = 0; index < alerts.length; index++) {
        var alert = alerts[index];
        // Screen-reader-only live regions are announcements, not visible errors.
        if (inside(alert, SCREEN_READER_ONLY)) continue;
        if (!isVisible(alert)) continue;
        var value = textOf(alert, ERROR_TEXT_CAP);
        if (value) return value;
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
    var parts = [];
    var held = safe(function () {
      return anchor.querySelectorAll(USER_TEXT);
    }, []);
    for (var index = 0; index < held.length; index++) {
      var part = held[index];
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
      if (parts.length > 0 && parts[parts.length - 1] === value) continue;
      parts.push(value);
    }
    return parts.join("\n\n").slice(0, MESSAGE_TEXT_CAP);
  };

  var sections = safe(function () {
    var found = document.querySelectorAll(TURN_SECTION);
    var list = [];
    for (var index = 0; index < found.length; index++) list.push(found[index]);
    return list;
  }, []);
  sections = sections.slice(Math.max(0, sections.length - MAX_TURNS));

  var turns = [];
  var newestAssistant = null;
  for (var index = 0; index < sections.length; index++) {
    var section = sections[index];
    var anchor = safe(function () {
      return section.querySelector(MESSAGE_ANCHOR);
    }, null);
    var role = readRole(anchor);
    if (role !== "user" && role !== "assistant") continue;
    turns.push({
      role: role,
      text: role === "user" ? readUserText(anchor) : readAssistantText(anchor),
      messageId: readMessageId(anchor),
      interrupted: contains(anchor, INTERRUPTED)
    });
    if (role === "assistant") newestAssistant = section;
  }

  var toolRowCount = 0;
  if (newestAssistant) {
    // A display-contents wrapper can hold a whole answer, so only rows with no
    // .markdown descendant count as tool rows (structural check).
    toolRowCount = safe(function () {
      var rows = newestAssistant.querySelectorAll(TOOL_ROW);
      var count = 0;
      for (var index = 0; index < rows.length; index++) {
        if (contains(rows[index], ASSISTANT_MARKDOWN)) continue;
        count++;
      }
      return count;
    }, 0);
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
    toolRowCount: toolRowCount,
    errorText: readErrorText(),
    rateLimitText: rateLimit.text,
    rateLimitDismissible: rateLimit.dismissible
  };
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
