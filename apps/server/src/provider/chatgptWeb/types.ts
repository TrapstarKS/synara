// FILE: types.ts
// Purpose: Shared types for driving a ChatGPT web conversation in the user's
//          browser (provider "chatgpt").
// Layer: Server provider / ChatGPT web driver
//
// The driver talks to the desktop-owned browser through the server's
// browser bridge RPC. Everything in this file is deliberately plain
// data so page scripts can be unit tested against jsdom fixtures and the
// driver can be exercised with a fake RPC.

/** Browser tool names the driver is allowed to call. */
export type ChatGptBrowserToolName =
  | "browser_open"
  | "browser_navigate"
  | "browser_tabs"
  | "browser_wait"
  | "browser_evaluate"
  | "browser_debug"
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
 * Bound RPC to one browser tab for one provider session. Tests provide a fake.
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
  /**
   * ChatGPT's own message model says the newest assistant turn reached
   * `end_turn: true` with a successful status. This is stronger completion
   * evidence than the Stop control, which can remain mounted after a reply.
   */
  readonly latestAssistantCompleted: boolean;
  /**
   * An answer-capable assistant message exists for the current turn and has
   * not reached `end_turn` yet. The Stop control can disappear for a moment
   * while ChatGPT is still working; this model state is the reliable busy
   * signal that keeps a turn from settling early.
   */
  readonly latestAssistantInProgress: boolean;
  /** Final public assistant text read from the same terminal model message. */
  readonly terminalAssistantText: string | null;
  /**
   * Public assistant text read from the newest answer-capable model message,
   * available while the turn is still streaming. ChatGPT's on-screen reveal is
   * animation-frame gated and stays frozen in a background tab, so the model
   * text is what keeps deltas live when the visible DOM lags behind.
   */
  readonly assistantModelText: string | null;
  /**
   * Rendered size plus tail of the newest assistant turn, tool rows and
   * reasoning chrome included. Any change means the turn is still moving,
   * which keeps the stall watchdog from killing a long tool or reasoning
   * phase that has not produced answer text yet.
   */
  readonly assistantActivity: string;
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
