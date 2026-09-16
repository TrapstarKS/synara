// FILE: driver.ts
// Purpose: Drives one ChatGPT web conversation in the user's browser:
//          open/resume a chat, insert and send a prompt, stream the answer,
//          stop a generation, and open fresh worker chats.
// Layer: Server provider / ChatGPT web driver
//
// The driver never talks to chatgpt.com directly: every page action goes
// through the browser bridge RPC. The page observation script lives in
// `pageScript.ts`; this file owns timing, acceptance and completion rules.
//
// Adapted from Chat On Steroids (MIT) — extension/content.js turn lifecycle
// (`sendSubmittedText`, `endOutcome`, settle windows) with the extension
// replaced by plain RPC calls.

import { BrowserHostRpcError } from "../../browserAutomation/browserHostRpcClient.ts";
import {
  buildChatGptObservationExpression,
  buildDismissRateLimitExpression,
  parseChatGptObservation,
} from "./pageScript.ts";
import { chatGptAuthoredPromptText } from "./userPrompt.ts";
import type {
  ChatGptBrowserCallInput,
  ChatGptBrowserRpc,
  ChatGptConversationRef,
  ChatGptObservation,
} from "./types.ts";

export type ChatGptDriverFailureCode =
  | "browser-unavailable"
  | "login-required"
  | "interrupted-by-human"
  | "rate-limited"
  | "busy"
  | "send-failed"
  | "timeout"
  | "tool-error"
  | "page-unexpected";

export class ChatGptDriverFailure extends Error {
  readonly code: ChatGptDriverFailureCode;

  constructor(code: ChatGptDriverFailureCode, message: string) {
    super(message);
    this.name = "ChatGptDriverFailure";
    this.code = code;
  }
}

export interface ChatGptCompletion {
  readonly outcome: "completed" | "interrupted" | "failed" | "stalled" | "timeout" | "rate_limited";
  readonly text: string;
  readonly observation: ChatGptObservation;
}

export interface ChatGptSendResult {
  readonly accepted: boolean;
  readonly observation: ChatGptObservation;
}

export interface ChatGptSendOptions {
  /**
   * Text that ChatGPT renders as the authored user message. The driver may
   * send additional provider context before it, so this is intentionally
   * separate from the full browser prompt.
   */
  readonly submittedText?: string;
}

export interface ChatGptDriverOptions {
  readonly rpc: ChatGptBrowserRpc;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollMs?: number;
  readonly settleMs?: number;
  readonly readyTimeoutMs?: number;
  readonly sendAcceptTimeoutMs?: number;
  /** Absolute upper bound for inserting, sending and accepting one prompt. */
  readonly sendTimeoutMs?: number;
  /** How long to wait for the submitted user turn to become observable. */
  readonly turnStartTimeoutMs?: number;
  readonly stallMs?: number;
  readonly completionTimeoutMs?: number;
  /**
   * How long to keep polling after the sign-in page appears, giving the user
   * time to log in (in the user's browser) while the turn waits. Zero fails
   * immediately with `login-required`.
   */
  readonly loginWaitMs?: number;
  /** Called once per wait when the page first asks for a sign-in. */
  readonly onLoginRequired?: () => void;
}

const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com", "www.chatgpt.com"]);

const DEFAULT_POLL_MS = 1000;
const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_SEND_ACCEPT_TIMEOUT_MS = 30_000;
const DEFAULT_SEND_TIMEOUT_MS = 90_000;
const DEFAULT_TURN_START_TIMEOUT_MS = 60_000;
// Long tool runs and deep reasoning produce tool output and reasoning chrome
// long before the answer text grows; the activity signal covers those, so this
// watchdog only has to catch a page that stopped moving entirely.
const DEFAULT_STALL_MS = 20 * 60_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_LOGIN_WAIT_MS = 5 * 60_000;

const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'form button[aria-label^="Send" i]',
] as const;

const COMPOSER_SELECTOR = "#prompt-textarea";

const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[data-testid="composer-stop-button"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop answering"]',
] as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const normalize = (value: string): string => value.replace(/\s+/gu, " ").trim();

/** First N normalized characters; enough to recognize a submitted message. */
const promptFingerprint = (value: string): string => normalize(value).slice(0, 160);

/**
 * Whitespace-insensitive identity for prompt confirmation. The native input
 * path lets ChatGPT's editor re-render an inserted prompt into separate
 * paragraphs, so a newline the prompt string contains can vanish from the
 * DOM's `textContent` between block elements. Comparing compacted text keeps
 * the confirmation stable across both DOM shapes without weakening it.
 */
const compactPromptText = (value: string): string => value.replace(/\s+/gu, "");

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const isChatGptUrl = (value: string): boolean => {
  try {
    return CHATGPT_HOSTS.has(new URL(value).host);
  } catch {
    return false;
  }
};

/** Reads the structured host error code from a remote browser host rejection. */
const browserHostErrorCode = (error: BrowserHostRpcError): string | null => {
  const data = asRecord(error.data);
  const envelope = asRecord(data?.["error"]);
  const code = envelope?.["code"];
  return typeof code === "string" ? code : null;
};

export class ChatGptWebDriver {
  private readonly rpc: ChatGptBrowserRpc;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly settleMs: number;
  private readonly readyTimeoutMs: number;
  private readonly sendAcceptTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly turnStartTimeoutMs: number;
  private readonly stallMs: number;
  private readonly completionTimeoutMs: number;
  private readonly loginWaitMs: number;
  private readonly onLoginRequired: (() => void) | undefined;

  constructor(options: ChatGptDriverOptions) {
    this.rpc = options.rpc;
    this.sleep = options.sleep ?? delay;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.sendAcceptTimeoutMs = options.sendAcceptTimeoutMs ?? DEFAULT_SEND_ACCEPT_TIMEOUT_MS;
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.turnStartTimeoutMs = options.turnStartTimeoutMs ?? DEFAULT_TURN_START_TIMEOUT_MS;
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    this.completionTimeoutMs = options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
    this.loginWaitMs = options.loginWaitMs ?? DEFAULT_LOGIN_WAIT_MS;
    this.onLoginRequired = options.onLoginRequired;
  }

  private async call(input: ChatGptBrowserCallInput, deadlineAtMs?: number): Promise<unknown> {
    const boundedInput =
      deadlineAtMs === undefined
        ? input
        : (() => {
            const remaining = deadlineAtMs - Date.now();
            if (remaining <= 0) {
              throw new ChatGptDriverFailure(
                "timeout",
                "The ChatGPT prompt did not reach the page before the send timeout.",
              );
            }
            return {
              ...input,
              timeoutMs: Math.max(100, Math.min(input.timeoutMs ?? 20_000, remaining)),
            };
          })();
    try {
      return await this.rpc.call(boundedInput);
    } catch (error) {
      if (error instanceof BrowserHostRpcError) {
        if (error.kind === "unavailable") {
          throw new ChatGptDriverFailure(
            "browser-unavailable",
            "The default-browser bridge is unavailable. Load the Synara ChatGPT extension and try again.",
          );
        }
        if (error.kind === "timeout") {
          throw new ChatGptDriverFailure(
            "timeout",
            "The browser did not answer while Synara was sending the ChatGPT prompt. Check the ChatGPT tab and try again.",
          );
        }
        if (browserHostErrorCode(error) === "BrowserInterruptedByHuman") {
          throw new ChatGptDriverFailure(
            "interrupted-by-human",
            "You interacted with the ChatGPT tab while Synara was driving it, so this action was cancelled. Start the turn again and leave the tab alone while it runs.",
          );
        }
        throw new ChatGptDriverFailure("tool-error", `Browser action failed: ${error.message}`);
      }
      throw new ChatGptDriverFailure(
        "tool-error",
        `Browser action failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async listTabs(): Promise<
    ReadonlyArray<{ tabId: string; url: string; active: boolean }>
  > {
    const raw = asRecord(await this.call({ name: "browser_tabs", args: {}, timeoutMs: 10_000 }));
    const tabs = Array.isArray(raw?.tabs) ? raw.tabs : [];
    const parsed: Array<{ tabId: string; url: string; active: boolean }> = [];
    for (const entry of tabs) {
      const record = asRecord(entry);
      const tabId = typeof record?.tabId === "string" ? record.tabId : null;
      const url = typeof record?.url === "string" ? record.url : null;
      if (tabId === null || url === null) continue;
      parsed.push({ tabId, url, active: record?.active === true });
    }
    return parsed;
  }

  private isRecoverableTabSelectionFailure(error: unknown): boolean {
    return (
      error instanceof ChatGptDriverFailure &&
      error.code === "tool-error" &&
      /only control ChatGPT|ChatGPT tab did not finish loading|No tab with id|tab (?:was )?closed/iu.test(
        error.message,
      )
    );
  }

  /** Finds (or opens) the engine's ChatGPT conversation for a thread. */
  async ensureConversation(input?: {
    readonly existingUrl?: string;
    readonly openUrl?: string;
  }): Promise<ChatGptConversationRef> {
    const tabs = await this.listTabs().catch(() => [] as const);
    const wantedUrl = input?.existingUrl ?? input?.openUrl;
    if (wantedUrl && isChatGptUrl(wantedUrl)) {
      const existing = tabs.find((tab) => tab.url === wantedUrl);
      if (existing) {
        try {
          return await this.waitReady(existing.tabId, existing.url, { navigateIfStale: false });
        } catch (error) {
          // The tab can navigate or close between browser_tabs and the first
          // evaluation. Open the requested conversation again rather than
          // failing session startup on that stale selection.
          if (!this.isRecoverableTabSelectionFailure(error)) throw error;
        }
      }
    }
    if (!wantedUrl) {
      const reusable =
        tabs.find((tab) => tab.active && isChatGptUrl(tab.url) && !this.isLoginLikeUrl(tab.url)) ??
        tabs.find((tab) => isChatGptUrl(tab.url) && !this.isLoginLikeUrl(tab.url));
      if (reusable) {
        try {
          return await this.waitReady(reusable.tabId, reusable.url, { navigateIfStale: true });
        } catch (error) {
          if (!this.isRecoverableTabSelectionFailure(error)) throw error;
        }
      }
    }
    const opened = await this.openTab(
      wantedUrl && isChatGptUrl(wantedUrl) ? wantedUrl : "https://chatgpt.com/",
    );
    return await this.waitReady(opened.tabId, opened.url, { navigateIfStale: false });
  }

  private isLoginLikeUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.pathname.startsWith("/auth") || parsed.pathname.startsWith("/login");
    } catch {
      return false;
    }
  }

  private async openTab(url: string): Promise<{ tabId: string; url: string }> {
    const raw = asRecord(
      await this.call({
        name: "browser_open",
        args: { url, reuse: false },
        timeoutMs: 30_000,
      }),
    );
    const tabId = typeof raw?.tabId === "string" ? raw.tabId : null;
    const finalUrl = typeof raw?.finalUrl === "string" ? raw.finalUrl : url;
    if (tabId === null) {
      throw new ChatGptDriverFailure("tool-error", "The browser did not return a tab id.");
    }
    return { tabId, url: finalUrl };
  }

  /**
   * Waits until the conversation shows a composer (signed in) or a login
   * surface. When `navigateIfStale` is set and the page never becomes ready,
   * one navigation to the ChatGPT root is attempted before failing.
   */
  private async waitReady(
    tabId: string,
    url: string,
    options: { readonly navigateIfStale: boolean },
  ): Promise<ChatGptConversationRef> {
    let deadline = Date.now() + this.readyTimeoutMs;
    let navigated = !options.navigateIfStale;
    let loginSeen = false;
    while (Date.now() < deadline) {
      const observation = await this.observe({ tabId, url, conversationPath: null });
      if (observation.loginRequired) {
        if (this.loginWaitMs <= 0) {
          throw new ChatGptDriverFailure(
            "login-required",
            `Sign in to ChatGPT in your default browser (${observation.url}). The conversation tab is open and waiting.`,
          );
        }
        if (!loginSeen) {
          loginSeen = true;
          deadline = Date.now() + this.loginWaitMs;
          this.onLoginRequired?.();
        }
        await this.sleep(Math.min(this.pollMs, 500));
        continue;
      }
      if (observation.composerPresent) {
        return { tabId, url: observation.url, conversationPath: observation.conversationPath };
      }
      if (!navigated) {
        navigated = true;
        const retried = asRecord(
          await this.call({
            name: "browser_navigate",
            args: { url: "https://chatgpt.com/", tabId },
            timeoutMs: 30_000,
          }),
        );
        const finalUrl = typeof retried?.finalUrl === "string" ? retried.finalUrl : url;
        url = finalUrl;
      }
      await this.sleep(this.pollMs);
    }
    if (loginSeen) {
      throw new ChatGptDriverFailure(
        "login-required",
        "ChatGPT is still showing the sign-in page. Finish signing in to chatgpt.com in your default browser, then start the turn again.",
      );
    }
    throw new ChatGptDriverFailure(
      "timeout",
      "The ChatGPT page did not show its composer in time. Check the ChatGPT tab in your default browser and try again.",
    );
  }

  /**
   * Polls a signed-out page until the composer appears. Returns the refreshed
   * observation when the page becomes ready, or null when the login wait is
   * disabled or expires.
   */
  private async waitForLogin(
    ref: ChatGptConversationRef,
    initial: ChatGptObservation,
    operationDeadlineAtMs?: number,
  ): Promise<ChatGptObservation | null> {
    if (this.loginWaitMs <= 0) return null;
    this.onLoginRequired?.();
    const deadline = Math.min(
      Date.now() + this.loginWaitMs,
      operationDeadlineAtMs ?? Number.POSITIVE_INFINITY,
    );
    let observation = initial;
    while (Date.now() < deadline) {
      await this.sleep(Math.min(this.pollMs, 500));
      observation = await this.observe(ref, deadline);
      if (observation.composerPresent && !observation.loginRequired) return observation;
    }
    return null;
  }

  async observe(ref: ChatGptConversationRef, deadlineAtMs?: number): Promise<ChatGptObservation> {
    const raw = asRecord(
      await this.call(
        {
          name: "browser_evaluate",
          args: {
            expression: buildChatGptObservationExpression(),
            ...(ref.tabId === null ? {} : { tabId: ref.tabId }),
          },
          timeoutMs: 20_000,
        },
        deadlineAtMs,
      ),
    );
    const observation = parseChatGptObservation(raw?.value);
    if (!observation) {
      throw new ChatGptDriverFailure("page-unexpected", "Could not read the ChatGPT page state.");
    }
    return observation;
  }

  /** Clicks the first matching selector; returns whether any click was issued. */
  private async clickFirst(
    selectors: ReadonlyArray<string>,
    tabId: string | null,
    deadlineAtMs?: number,
  ): Promise<boolean> {
    for (const selector of selectors) {
      try {
        const raw = asRecord(
          await this.call(
            {
              name: "browser_click",
              args: { target: { selector }, ...(tabId === null ? {} : { tabId }) },
              timeoutMs: 15_000,
            },
            deadlineAtMs,
          ),
        );
        if (raw !== null) return true;
      } catch (error) {
        // A missing control is expected while selectors drift. Transport,
        // timeout and human-control failures must escape immediately instead
        // of being multiplied by every fallback selector.
        if (
          error instanceof ChatGptDriverFailure &&
          (error.code === "browser-unavailable" ||
            error.code === "interrupted-by-human" ||
            error.code === "timeout")
        ) {
          throw error;
        }
      }
    }
    return false;
  }

  private rateLimitFailure(observation: ChatGptObservation): ChatGptDriverFailure {
    const notice = observation.rateLimitText ?? "ChatGPT is temporarily limiting access.";
    return new ChatGptDriverFailure(
      "rate-limited",
      `${notice} Access is limited for a few minutes; wait before retrying.`,
    );
  }

  /**
   * Clicks the access-limit acknowledgement when the notice exposes exactly
   * one. Clicking clears the blocking surface only; it does not grant a retry,
   * and a failure here is not fatal.
   */
  private async dismissRateLimit(ref: ChatGptConversationRef): Promise<boolean> {
    try {
      const raw = asRecord(
        await this.call({
          name: "browser_evaluate",
          args: {
            expression: buildDismissRateLimitExpression(),
            ...(ref.tabId === null ? {} : { tabId: ref.tabId }),
          },
          timeoutMs: 10_000,
        }),
      );
      return raw?.value === true;
    } catch {
      return false;
    }
  }

  private containsSubmittedPrompt(observation: ChatGptObservation, text: string): boolean {
    const normalized = normalize(text);
    const fingerprint = promptFingerprint(normalized);
    if (fingerprint.length === 0) return false;

    // The newest user turn is the only one that can acknowledge the current
    // send. Looking only at it prevents an old repeated prompt from accepting
    // a click that ChatGPT ignored.
    const latestUser = observation.turns.findLast((turn) => turn.role === "user");
    if (!latestUser) return false;
    const visible = normalize(latestUser.text);
    if (visible.length === 0) return false;
    // Synara prefixes its internal context to the native ChatGPT user turn.
    // The current renderer can expose that raw frame instead of the
    // presentation-only authored tail, especially while a turn is live. A
    // short authored prompt ("oi", "Oii", ...) must still prove this exact
    // turn; substring matching it against the context would be unsafe.
    const authored = chatGptAuthoredPromptText(latestUser.text);
    if (authored !== null) return normalize(authored) === normalized;
    return (
      visible === normalized ||
      // A long message may be clipped by the page observer. Short messages
      // must match exactly: accepting `oi` merely because those two letters
      // occur inside the hidden provider preamble can bind this turn to an old
      // user row and then complete it from an unrelated historical answer.
      (fingerprint.length >= 8 && visible.includes(fingerprint)) ||
      // Some ChatGPT renderers trim a long message. Its substantial visible
      // fragment can still prove the send, while the length guard avoids
      // matching arbitrary short leftovers.
      (visible.length >= 8 && fingerprint.includes(visible))
    );
  }

  /**
   * Inserts a prompt and sends it. Sending is accepted only when the page
   * proves it: the submitted text appears as a user turn, the composer clears,
   * or generation starts. A click alone is never acceptance.
   */
  async sendPrompt(
    ref: ChatGptConversationRef,
    text: string,
    options: ChatGptSendOptions = {},
  ): Promise<ChatGptSendResult> {
    const submittedText = options.submittedText ?? text;
    const deadlineAtMs = Date.now() + this.sendTimeoutMs;
    return this.sendPromptWithinDeadline(ref, text, submittedText, deadlineAtMs);
  }

  private async sendPromptWithinDeadline(
    ref: ChatGptConversationRef,
    text: string,
    submittedText: string,
    deadlineAtMs: number,
  ): Promise<ChatGptSendResult> {
    const before = await this.observe(ref, deadlineAtMs);
    if (before.rateLimitText !== null) {
      if (before.rateLimitDismissible) await this.dismissRateLimit(ref);
      throw this.rateLimitFailure(before);
    }
    if (before.loginRequired) {
      const ready = await this.waitForLogin(ref, before, deadlineAtMs);
      if (!ready) {
        throw new ChatGptDriverFailure(
          "login-required",
          "Sign in to ChatGPT in your default browser first.",
        );
      }
      return this.sendPromptWithinDeadline(ref, text, submittedText, deadlineAtMs);
    }
    if (before.generating && !before.latestAssistantCompleted) {
      throw new ChatGptDriverFailure(
        "busy",
        "ChatGPT is still generating a reply in this conversation. Wait for it to finish or stop it first.",
      );
    }
    if (!before.composerPresent) {
      throw new ChatGptDriverFailure("timeout", "The ChatGPT composer is not on the page yet.");
    }

    await this.call({
      name: "browser_type",
      args: {
        target: { selector: COMPOSER_SELECTOR },
        text,
        append: false,
        ...(ref.tabId === null ? {} : { tabId: ref.tabId }),
      },
      timeoutMs: 20_000,
    });

    // Confirm the editor holds the text before spending a click on it. The
    // editor can still be re-rendering the native insertion, so the comparison
    // ignores whitespace and keeps polling while the DOM settles.
    const insertDeadline = Math.min(Date.now() + 5_000, deadlineAtMs);
    const fingerprint = compactPromptText(text).slice(0, 160);
    let inserted = false;
    while (Date.now() < insertDeadline) {
      const current = await this.observe(ref, insertDeadline);
      if (compactPromptText(current.composerText).includes(fingerprint)) {
        inserted = true;
        break;
      }
      await this.sleep(250);
    }
    if (!inserted) {
      throw new ChatGptDriverFailure(
        "send-failed",
        "The prompt could not be inserted into the ChatGPT composer.",
      );
    }

    // Wait briefly for the send control to enable, then click it.
    const sendDeadline = Math.min(Date.now() + 5_000, deadlineAtMs);
    let clicked = false;
    while (Date.now() < sendDeadline && !clicked) {
      const current = await this.observe(ref, sendDeadline);
      if (current.sendEnabled) {
        clicked = await this.clickFirst(SEND_SELECTORS, ref.tabId, sendDeadline);
      }
      if (!clicked) await this.sleep(250);
    }
    if (!clicked) {
      await this.call(
        {
          name: "browser_press",
          args: { keys: ["Enter"], ...(ref.tabId === null ? {} : { tabId: ref.tabId }) },
          timeoutMs: 10_000,
        },
        deadlineAtMs,
      );
    }

    const acceptDeadline = Math.min(Date.now() + this.sendAcceptTimeoutMs, deadlineAtMs);
    let lastObservation = before;
    while (Date.now() < acceptDeadline) {
      const observation = await this.observe(ref, acceptDeadline);
      lastObservation = observation;
      if (observation.rateLimitText !== null) {
        if (observation.rateLimitDismissible) await this.dismissRateLimit(ref);
        throw this.rateLimitFailure(observation);
      }
      if (
        observation.generating ||
        this.containsSubmittedPrompt(observation, submittedText) ||
        (observation.composerText.trim().length === 0 && observation.sendEnabled === false)
      ) {
        return { accepted: true, observation };
      }
      await this.sleep(Math.min(this.pollMs, 500));
    }
    if (Date.now() >= deadlineAtMs) {
      throw new ChatGptDriverFailure(
        "timeout",
        "The ChatGPT page did not confirm the prompt before the send timeout. Check the ChatGPT tab and try again.",
      );
    }
    return { accepted: false, observation: lastObservation };
  }

  /**
   * Polls until the reply to `submittedText` settles. Streaming updates are
   * delivered through `onText`; the returned outcome mirrors the reference
   * implementation's settle rules (stable text, stop control gone).
   */
  async waitForCompletion(
    ref: ChatGptConversationRef,
    submittedText: string,
    hooks?: {
      readonly onText?: (text: string, observation: ChatGptObservation) => void | Promise<void>;
      readonly signal?: AbortSignal;
    },
  ): Promise<ChatGptCompletion> {
    const startedAt = Date.now();
    let lastText = "";
    let lastChangeAt = Date.now();
    let stableSince: number | null = null;
    let rateLimitDismissed = false;
    let submittedTurnSeen = false;
    // Settling by quietness is only safe after this turn visibly did something:
    // the Stop control can be missing before the answer starts or between
    // phases, and a fresh turn would otherwise "complete" on arrival.
    let sawActivity = false;
    let lastActivity = "";
    let lastObservation = await this.observe(ref);

    for (;;) {
      if (hooks?.signal?.aborted === true) {
        throw new ChatGptDriverFailure("tool-error", "The turn was interrupted before completion.");
      }
      if (Date.now() - startedAt > this.completionTimeoutMs) {
        return { outcome: "timeout", text: lastText, observation: lastObservation };
      }

      const observation = await this.observe(ref);
      lastObservation = observation;
      if (observation.rateLimitText !== null) {
        if (observation.rateLimitDismissible && !rateLimitDismissed) {
          rateLimitDismissed = true;
          await this.dismissRateLimit(ref);
        }
        return { outcome: "rate_limited", text: lastText, observation };
      }
      const lastAssistant = observation.turns.findLast((turn) => turn.role === "assistant");
      // Tool output and reasoning chrome update inside the newest assistant
      // turn even while the answer text has not grown yet; any change there is
      // progress for the stall watchdog.
      if (observation.assistantActivity !== lastActivity) {
        lastActivity = observation.assistantActivity;
        lastChangeAt = Date.now();
      }
      // The model text is authoritative and keeps growing while the visible
      // reveal is paused (background tab), so it leads the fallback chain.
      const observedText =
        observation.assistantModelText ??
        observation.terminalAssistantText ??
        lastAssistant?.text ??
        "";
      // A renderer catch-up can briefly drop the assistant text while the turn
      // is still running; never replace a real answer with an empty string.
      const text =
        observedText.length === 0 && lastText.length > 0 && !observation.latestAssistantCompleted
          ? lastText
          : observedText;
      if (
        observation.generating ||
        observation.latestAssistantInProgress ||
        observation.latestAssistantCompleted ||
        text.length > 0
      ) {
        sawActivity = true;
      }
      if (text !== lastText) {
        lastText = text;
        lastChangeAt = Date.now();
        stableSince = null;
        await hooks?.onText?.(text, observation);
      }

      const hasUserTurn = this.containsSubmittedPrompt(observation, submittedText);
      if (hasUserTurn) submittedTurnSeen = true;
      if (!submittedTurnSeen && Date.now() - startedAt > this.turnStartTimeoutMs) {
        return { outcome: "timeout", text: lastText, observation };
      }
      // The page observer scopes transport failures to the newest assistant
      // turn. They outrank a stale successful Fiber message left behind by a
      // retry, otherwise a delivery-error card can be promoted to completion.
      if (hasUserTurn && observation.errorText !== null && !observation.generating) {
        return { outcome: "failed", text, observation };
      }
      // ChatGPT's model-level end_turn flag is exact completion evidence. The
      // Stop control is only a busy hint and can remain mounted after the final
      // message, which previously left Synara in "Thinking" indefinitely.
      if (hasUserTurn && observation.latestAssistantCompleted) {
        return {
          outcome: lastAssistant?.interrupted === true ? "interrupted" : "completed",
          text,
          observation,
        };
      }
      // ChatGPT's model state outranks the Stop control: the control can be
      // unmounted for a moment or for a whole phase while the answer keeps
      // being produced. Only quiet once activity was seen and the newest
      // answer message is neither waiting nor in progress.
      const settledByQuiet =
        sawActivity && !observation.generating && !observation.latestAssistantInProgress;
      if (settledByQuiet && hasUserTurn) {
        if (stableSince === null) stableSince = Date.now();
        if (Date.now() - stableSince >= this.settleMs) {
          if (observation.errorText !== null) {
            return { outcome: "failed", text, observation };
          }
          if (lastAssistant?.interrupted === true) {
            return { outcome: "interrupted", text, observation };
          }
          return { outcome: "completed", text, observation };
        }
      } else {
        stableSince = null;
      }

      if (
        (observation.generating || observation.latestAssistantInProgress) &&
        Date.now() - lastChangeAt > this.stallMs
      ) {
        return { outcome: "stalled", text, observation };
      }

      await this.sleep(observation.generating ? this.pollMs : Math.min(this.pollMs, 500));
    }
  }

  /** Requests generation stop; safe to call when nothing is generating. */
  async interrupt(ref: ChatGptConversationRef): Promise<void> {
    await this.clickFirst(STOP_SELECTORS, ref.tabId);
  }

  /** Opens a brand-new chat, optionally pinning model and reasoning effort. */
  async openFreshConversation(input?: {
    readonly model?: string;
    readonly reasoningEffort?: string;
  }): Promise<ChatGptConversationRef> {
    const params = new URLSearchParams();
    if (input?.model && input.model.trim().length > 0) params.set("model", input.model.trim());
    if (input?.reasoningEffort && input.reasoningEffort.trim().length > 0) {
      params.set("reasoning_effort", input.reasoningEffort.trim());
    }
    const query = params.toString();
    const url = query.length > 0 ? `https://chatgpt.com/?${query}` : "https://chatgpt.com/";
    const opened = await this.openTab(url);
    return await this.waitReady(opened.tabId, opened.url, { navigateIfStale: false });
  }

  /** Closes a tab the driver opened, e.g. after a failed worker bootstrap. */
  async closeConversation(ref: ChatGptConversationRef): Promise<void> {
    if (ref.tabId === null) return;
    await this.call({ name: "browser_close", args: { tabId: ref.tabId }, timeoutMs: 10_000 });
  }
}
