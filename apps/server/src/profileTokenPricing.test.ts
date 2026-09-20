import { describe, expect, it } from "vitest";

import { estimateProfileTokenCost, estimateProfileTokenUsageUsd } from "./profileTokenPricing";

describe("profile token pricing", () => {
  it("prices billions of cached tokens per million instead of as a tiny provider cost", () => {
    // 12,000 requests * 250k cached-input tokens = exactly 3B tokens. Keeping
    // each request below 272k also proves the long-context surcharge is request-
    // scoped rather than incorrectly applied to an aggregate lifetime count.
    const result = estimateProfileTokenCost(
      Array.from({ length: 12_000 }, () => ({
        provider: "codex",
        model: "gpt-5.6-sol",
        inputTokens: 250_000,
        cachedInputTokens: 250_000,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        fastMode: false,
        lastInputTokens: 250_000,
      })),
    );

    expect(result.pricedTokens).toBe(3_000_000_000);
    expect(result.costUsd).toBeCloseTo(1_200);
  });

  it("treats cached input and reasoning as subsets instead of double-counting them", () => {
    expect(
      estimateProfileTokenUsageUsd({
        provider: "codex",
        model: "gpt-5.3-codex",
        inputTokens: 1_000_000,
        cachedInputTokens: 900_000,
        cacheWriteInputTokens: 0,
        outputTokens: 100_000,
        fastMode: null,
        lastInputTokens: null,
      }),
    ).toBeCloseTo(1.7325);
  });

  it("applies long-context and explicit Fast multipliers per request", () => {
    expect(
      estimateProfileTokenUsageUsd({
        provider: "codex",
        model: "gpt-5.6-sol",
        inputTokens: 300_000,
        cachedInputTokens: 250_000,
        cacheWriteInputTokens: 0,
        outputTokens: 10_000,
        fastMode: true,
        lastInputTokens: 300_000,
      }),
    ).toBeCloseTo(2.25);
  });

  it("starts the long-context surcharge only above 272k request input", () => {
    const price = (lastInputTokens: number) =>
      estimateProfileTokenUsageUsd({
        provider: "codex",
        model: "gpt-5.6-sol",
        inputTokens: lastInputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        fastMode: false,
        lastInputTokens,
      });
    expect(price(272_000)).toBeCloseTo(1.088);
    expect(price(272_001)).toBeCloseTo(2.176008);
  });

  it("does not infer long context from cumulative volume across smaller requests", () => {
    const result = estimateProfileTokenCost(
      Array.from({ length: 2 }, () => ({
        provider: "codex",
        model: "gpt-5.6-sol",
        inputTokens: 200_000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        fastMode: false,
        lastInputTokens: 200_000,
      })),
    );
    expect(result.pricedTokens).toBe(400_000);
    expect(result.costUsd).toBeCloseTo(1.6);
  });

  it("leaves Fast-capable usage uncovered when the turn mode is unknown", () => {
    expect(
      estimateProfileTokenUsageUsd({
        provider: "codex",
        model: "gpt-5.6-sol",
        inputTokens: 1000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 100,
        fastMode: null,
        lastInputTokens: 1000,
      }),
    ).toBeNull();
  });

  it("leaves unpublished or non-Codex pricing uncovered", () => {
    expect(
      estimateProfileTokenUsageUsd({
        provider: "codex",
        model: "gpt-5.3-codex-spark",
        inputTokens: 1000,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 0,
        outputTokens: 100,
        fastMode: null,
        lastInputTokens: null,
      }),
    ).toBeNull();
    expect(
      estimateProfileTokenUsageUsd({
        provider: "claudeAgent",
        model: "claude-sonnet-5",
        inputTokens: 1000,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 0,
        outputTokens: 100,
        fastMode: null,
        lastInputTokens: null,
      }),
    ).toBeNull();
  });

  it("does not charge Codex cache writes", () => {
    expect(
      estimateProfileTokenUsageUsd({
        provider: "codex",
        model: "gpt-5.3-codex",
        inputTokens: 1_000_000,
        cachedInputTokens: 800_000,
        cacheWriteInputTokens: 100_000,
        outputTokens: 0,
        fastMode: null,
        lastInputTokens: null,
      }),
    ).toBeCloseTo(0.315);
  });
});
