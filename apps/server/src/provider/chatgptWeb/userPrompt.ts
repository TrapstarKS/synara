// FILE: userPrompt.ts
// Purpose: Frame Synara-only context inside a ChatGPT user message while
//          preserving the exact text the user authored for receipts and UI.
// Layer: Server provider / ChatGPT web prompt transport
//
// Adapted from Chat On Steroids (MIT) — src/shared/user-prompt.ts. The length
// prefix makes marker-like text inside either the context or authored prompt
// unambiguous; this is transport framing, not a second prompt source.

const CONTEXT_HEADER = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/;
const CONTEXT_BOUNDARY = "\n[[/COS_CONTEXT]]\n\n";

const normalizeNewlines = (value: string): string => value.replace(/\r\n?/gu, "\n");

/** Returns the authored tail of a framed prompt, or null for ordinary text. */
export function chatGptAuthoredPromptText(value: string): string | null {
  const text = normalizeNewlines(value);
  const header = CONTEXT_HEADER.exec(text);
  if (!header) return null;
  const contextLength = Number(header[1]);
  const contextEnd = header[0].length + contextLength;
  return text.startsWith(CONTEXT_BOUNDARY, contextEnd)
    ? text.slice(contextEnd + CONTEXT_BOUNDARY.length)
    : null;
}

/** Prepends hidden provider context without ever nesting an existing frame. */
export function prependChatGptPromptContext(text: string, context: string): string {
  const normalizedText = normalizeNewlines(text);
  const normalizedContext = normalizeNewlines(context);
  const authored = chatGptAuthoredPromptText(normalizedText) ?? normalizedText;
  return `[[COS_CONTEXT:${normalizedContext.length}]]\n${normalizedContext}${CONTEXT_BOUNDARY}${authored}`;
}
