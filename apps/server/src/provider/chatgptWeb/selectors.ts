// FILE: selectors.ts
// Purpose: The single inventory of ChatGPT DOM selectors the provider uses to
//          observe and drive chatgpt.com from its browser session.
// Layer: Server provider / ChatGPT web driver
//
// Adapted from Chat On Steroids (MIT) — extension/chatgpt-dom.js
//
// This is the only file in the provider allowed to contain a ChatGPT selector.
// None of these are a public API: they were read from live 2026 pages and can
// change without notice, so every read that uses them must degrade safely — a
// selector that stops matching has to produce an empty or absent value, never a
// thrown error. Hashed CSS-module class names are deliberately never matched.

export const CHATGPT_SELECTORS = {
  /**
   * One rendered conversation turn. ChatGPT has used both `<section>` and
   * `<article>` roots across renderer variants; accept both.
   */
  turnSection:
    'section[data-testid^="conversation-turn"], article[data-testid^="conversation-turn"]',
  /** The message element that names its author role (user or assistant). */
  messageRoleAnchor: '[data-message-author-role="user"], [data-message-author-role="assistant"]',
  /** Authored user text across the plain-text and Markdown renderers. */
  userText: ".whitespace-pre-wrap, .markdown",
  /** Synara's presentation-only authored-text replacement for a framed prompt. */
  userPromptDisplay: "[data-synara-user-text]",
  /** Authored assistant prose inside an assistant message. */
  assistantMarkdown: ".markdown",
  /** Legacy tool/connector row shape (older renderer). */
  toolRowLegacy: 'span[class*="tool-message"]',
  /** Current tool/connector row shape: a display-contents wrapper. */
  toolRowCurrent: "div.pointer-events-none.contents",
  /** Both tool-row shapes; this union is what the observation counts. */
  toolRow: 'span[class*="tool-message"], div.pointer-events-none.contents',
  /** ChatGPT's progress/commentary marker; text under it is not the final answer. */
  interruptedMarker: "[data-interrupted]",
  /** Stop control union across the renderers ChatGPT has shipped. */
  stopControl:
    'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], ' +
    'button[aria-label="Stop streaming"], button[aria-label="Stop generating"], ' +
    'button[aria-label="Stop answering"]',
  /** The native send control. */
  sendControl: 'button[data-testid="send-button"], form button[aria-label^="Send" i]',
  /** The composer's editable element. */
  composer: "#prompt-textarea",
  /** A visible error/notice banner. */
  alertBanner: '[role="alert"]',
  /** Modal surfaces; provider access throttling renders here, not as a banner. */
  dialog: '[role="dialog"], [role="alertdialog"]',
  /** Heading inside a modal; the access-limit notice is identified by its title. */
  dialogHeading: 'h1, h2, h3, [role="heading"]',
  /** Accessible hiding; alerts here are announcements, not visible errors. */
  screenReaderOnly: '.sr-only, .visually-hidden, [data-testid="visually-hidden"]',
  /** Message identity attribute holder. */
  messageId: "[data-message-id]",
  /** Attribute names read directly from a node, kept beside their selectors. */
  attributes: {
    messageRole: "data-message-author-role",
    messageId: "data-message-id",
    turnRole: "data-turn",
    turnId: "data-turn-id",
    userPromptHidden: "data-synara-prompt-hidden",
    userPromptDisplay: "data-synara-user-text",
  },
} as const;
