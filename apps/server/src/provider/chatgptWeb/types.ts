// FILE: types.ts
// Purpose: Shared types for driving a ChatGPT web conversation inside the
//          Synara browser (provider "chatgpt").
// Layer: Server provider / ChatGPT web driver
//
// The driver talks to the desktop-owned browser through the server's
// `BrowserAutomationHost` RPC. Everything in this file is deliberately plain
// data so page scripts can be unit tested against jsdom fixtures and the
// driver can be exercised with a fake RPC.

/** Browser tool names the driver is allowed to call. */
export type ChatGptBrowserToolName =
  | "browser_open"
  | "browser_navigate"
  | "browser_tabs"
  | "browser_wait"
  | "browser_evaluate"
  | "browser_click"
  | "browser_press"
  | "browser_type"
  | "browser_screenshot"
  | "browser_close";

export interface ChatGptBrowserCallInput {
  readonly name: ChatGptBrowserToolName;
  readonly args: Record<string, unknown>;
  readonly timeoutMs?: number;
}

/**
 * Bound RPC to the visible Synara browser for one provider session. The
 * implementation injects `provider: "chatgpt"`, the owning `threadId` and a
 * session key; tests provide a fake.
 */
export interface ChatGptBrowserRpc {
  readonly call: (input: ChatGptBrowserCallInput) => Promise<unknown>;
}

export interface ChatGptTurnObservation {
  readonly role: "user" | "assistant";
  /** Visible message text, already stripped of tool rows and progress boxes. */
  readonly text: string;
  readonly messageId: string | null;
  /** A progress/commentary block rendered with `data-interrupted`. */
  readonly interrupted: boolean;
}

export interface ChatGptObservation {
  readonly url: string;
  /** `/c/<id>` or `/g/<gid>/c/<id>` when the conversation has an id. */
  readonly conversationPath: string | null;
  /** The page is showing a signed-out or login surface. */
  readonly loginRequired: boolean;
  readonly composerPresent: boolean;
  /** Draft text currently in the composer. */
  readonly composerText: string;
  /** ChatGPT is generating (a stop control is present). */
  readonly generating: boolean;
  /** The native send control is present and enabled. */
  readonly sendEnabled: boolean;
  /** Last turns in page order, oldest first; only the tail is captured. */
  readonly turns: readonly ChatGptTurnObservation[];
  /** Count of tool/connector rows visible in the newest assistant turn. */
  readonly toolRowCount: number;
  /** Visible error banner text, when one is displayed. */
  readonly errorText: string | null;
  /**
   * Live provider access-limit notice ("Too many requests ... temporarily
   * limited ... access"), when ChatGPT is throttling this account.
   */
  readonly rateLimitText: string | null;
  /** The access-limit notice exposes exactly one acknowledgement control. */
  readonly rateLimitDismissible: boolean;
}

export interface ChatGptConversationRef {
  /** Browser tab that owns this conversation; null before the tab is known. */
  readonly tabId: string | null;
  /** Absolute URL of the conversation tab. */
  readonly url: string;
  /** `/c/<id>` form when available. */
  readonly conversationPath: string | null;
}
