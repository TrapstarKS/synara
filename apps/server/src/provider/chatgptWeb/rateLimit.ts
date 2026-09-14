// FILE: rateLimit.ts
// Purpose: Cooldown helpers for ChatGPT's live access-limit notice
//          ("Too many requests ... temporarily limited ... few minutes").
// Layer: Server provider / ChatGPT web driver
//
// The rate limit blocks new sends while it is showing. Synara never retries by
// itself: it records a bounded cooldown, refuses new turns with the remaining
// time, and lets the user (or the next deliberate attempt) decide when to try
// again. Detection lives in pageScript.ts; this file owns the timing policy.

/** How long a detected access limit suppresses new turns before a retry is allowed. */
export const CHATGPT_RATE_LIMIT_COOLDOWN_MS = 60_000;

export function rateLimitCooldownUntil(nowMs: number): number {
  return nowMs + CHATGPT_RATE_LIMIT_COOLDOWN_MS;
}

export function remainingRateLimitCooldownMs(
  untilMs: number | null | undefined,
  nowMs: number,
): number {
  if (typeof untilMs !== "number" || !Number.isFinite(untilMs)) return 0;
  return Math.max(0, untilMs - nowMs);
}

/** Failure message for a turn that ended because ChatGPT throttled access. */
export function rateLimitedTurnMessage(notice: string | null): string {
  const prefix = notice?.trim() ? notice.trim() : "ChatGPT is temporarily limiting access.";
  return `${prefix} Limits usually clear within a few minutes; retry then.`;
}

/** Validation message shown when a new turn is attempted during the cooldown. */
export function rateLimitRetryHintMessage(remainingMs: number): string {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return `ChatGPT access is temporarily limited. Retry in about ${seconds}s; limits usually clear within a few minutes.`;
}
