// FILE: userPrompt.test.ts
// Purpose: Lock the ChatGPT context frame to the reference-compatible exact
//          length protocol used by the page observer and prompt presentation.
// Layer: Server provider / ChatGPT web prompt transport tests

import { describe, expect, it } from "vitest";

import { chatGptAuthoredPromptText, prependChatGptPromptContext } from "./userPrompt.ts";

describe("ChatGPT user prompt framing", () => {
  it("round-trips internal context and the exact authored message", () => {
    const framed = prependChatGptPromptContext("oi\n\ntudo bem?", "internal\ncontext");

    expect(framed).toBe(
      "[[COS_CONTEXT:16]]\ninternal\ncontext\n[[/COS_CONTEXT]]\n\noi\n\ntudo bem?",
    );
    expect(chatGptAuthoredPromptText(framed)).toBe("oi\n\ntudo bem?");
  });

  it("normalizes transport newlines before measuring the context", () => {
    const framed = prependChatGptPromptContext("hello\r\nworld", "one\r\ntwo");

    expect(framed.startsWith("[[COS_CONTEXT:7]]\none\ntwo")).toBe(true);
    expect(chatGptAuthoredPromptText(framed)).toBe("hello\nworld");
  });

  it("does not unwrap malformed or user-authored marker-like text", () => {
    expect(
      chatGptAuthoredPromptText("[[COS_CONTEXT:3]]\nfive\n[[/COS_CONTEXT]]\n\nkeep this literal"),
    ).toBeNull();
    expect(chatGptAuthoredPromptText("ordinary message")).toBeNull();
  });

  it("replaces an existing transport frame instead of nesting it", () => {
    const original = prependChatGptPromptContext("authored", "old context");
    const reframed = prependChatGptPromptContext(original, "new context");

    expect(reframed.match(/\[\[COS_CONTEXT:/gu)).toHaveLength(1);
    expect(chatGptAuthoredPromptText(reframed)).toBe("authored");
  });
});
