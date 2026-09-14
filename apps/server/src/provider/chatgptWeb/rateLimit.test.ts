// FILE: rateLimit.test.ts
// Purpose: Pin the ChatGPT access-limit cooldown policy: bounded, never
//          self-retrying, and always reported with actionable remaining time.
// Layer: Server provider / ChatGPT web driver tests
//
// Adapted from Chat On Steroids (MIT) — the access-limit handling notes in
// extension/content.js (a limit that outlives a few seconds is the usual kind).

import { describe, expect, it } from "vitest";

import {
  CHATGPT_RATE_LIMIT_COOLDOWN_MS,
  rateLimitCooldownUntil,
  rateLimitRetryHintMessage,
  rateLimitedTurnMessage,
  remainingRateLimitCooldownMs,
} from "./rateLimit.ts";

describe("rate limit cooldown", () => {
  it("sets a bounded cooldown window", () => {
    expect(rateLimitCooldownUntil(1_000)).toBe(1_000 + CHATGPT_RATE_LIMIT_COOLDOWN_MS);
    expect(CHATGPT_RATE_LIMIT_COOLDOWN_MS).toBeLessThanOrEqual(120_000);
  });

  it("reports zero when no cooldown is recorded or it has passed", () => {
    expect(remainingRateLimitCooldownMs(null, 10_000)).toBe(0);
    expect(remainingRateLimitCooldownMs(undefined, 10_000)).toBe(0);
    expect(remainingRateLimitCooldownMs(Number.NaN, 10_000)).toBe(0);
    expect(remainingRateLimitCooldownMs(5_000, 10_000)).toBe(0);
  });

  it("reports the remaining window while the cooldown is active", () => {
    expect(remainingRateLimitCooldownMs(15_000, 10_000)).toBe(5_000);
  });

  it("formats an actionable turn failure message", () => {
    expect(
      rateLimitedTurnMessage("Too many requests Please try again in a few minutes."),
    ).toContain("Too many requests");
    expect(rateLimitedTurnMessage(null)).toContain("temporarily limiting access");
    expect(rateLimitedTurnMessage("Too many requests")).toContain("few minutes");
  });

  it("formats a retry hint with a whole-second bound", () => {
    expect(rateLimitRetryHintMessage(1)).toContain("about 1s");
    expect(rateLimitRetryHintMessage(60_000)).toContain("about 60s");
    expect(rateLimitRetryHintMessage(59_100)).toContain("about 60s");
    expect(rateLimitRetryHintMessage(0)).toContain("about 1s");
  });
});
