// FILE: profileTokenPricing.ts
// Purpose: Convert recorded Codex token usage into a current-rate USD equivalent.
// Rates are public per-1M-token prices, not the user's actual subscription bill.

export const PROFILE_TOKEN_PRICING_AS_OF = "2026-09-22";

const TOKENS_PER_MILLION = 1_000_000;
const LONG_CONTEXT_INPUT_THRESHOLD = 272_000;

interface TokenRates {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
  readonly fastMultiplier?: number;
  readonly longContext?: true;
}

export interface ProfileTokenPricingUsage {
  readonly provider: string | null;
  readonly model: string | null;
  // Codex inputTokens includes cachedInputTokens. cachedInputTokens is a subset.
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly fastMode: boolean | null;
  readonly lastInputTokens: number | null;
}

export interface ProfileTokenCostEstimate {
  readonly costUsd: number;
  readonly pricedTokens: number;
}

// ChatGPT Work / Codex USD rates where published. Older Codex models retain
// their current API rates so existing local history can still be repriced.
// Source checked 2026-09-22:
// https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing
const CODEX_TOKEN_RATES: ReadonlyArray<readonly [string, TokenRates]> = [
  ["gpt-6-astra", { input: 10, cachedInput: 1, output: 50, fastMultiplier: 2.5 }],
  ["gpt-6-sol", { input: 2, cachedInput: 0.2, output: 10, fastMultiplier: 2, longContext: true }],
  [
    "gpt-6-luna",
    { input: 0.1, cachedInput: 0.01, output: 0.5, fastMultiplier: 2, longContext: true },
  ],
  [
    "gpt-5.6-sol",
    { input: 4, cachedInput: 0.4, output: 20, fastMultiplier: 2.5, longContext: true },
  ],
  [
    "gpt-5.6-terra",
    { input: 2, cachedInput: 0.2, output: 12, fastMultiplier: 2.5, longContext: true },
  ],
  [
    "gpt-5.6-luna",
    { input: 0.2, cachedInput: 0.02, output: 1.2, fastMultiplier: 2.5, longContext: true },
  ],
  ["gpt-5.5", { input: 5, cachedInput: 0.5, output: 30, fastMultiplier: 2.5, longContext: true }],
  ["daybreak-blue", { input: 4, cachedInput: 0.4, output: 20 }],
  ["daybreak-red", { input: 12.5, cachedInput: 1.25, output: 75 }],
  [
    "gpt-5.4-mini",
    { input: 0.75, cachedInput: 0.075, output: 4.5, fastMultiplier: 2, longContext: true },
  ],
  ["gpt-5.4", { input: 2.5, cachedInput: 0.25, output: 15, fastMultiplier: 2, longContext: true }],
  ["gpt-5.3-codex", { input: 1.75, cachedInput: 0.175, output: 14 }],
  ["gpt-5.2-codex", { input: 1.75, cachedInput: 0.175, output: 14 }],
  ["gpt-5.2", { input: 1.75, cachedInput: 0.175, output: 14 }],
  ["gpt-5.1-codex-max", { input: 1.25, cachedInput: 0.125, output: 10 }],
  ["gpt-5.1-codex", { input: 1.25, cachedInput: 0.125, output: 10 }],
  ["gpt-5.1", { input: 1.25, cachedInput: 0.125, output: 10 }],
  ["gpt-5-codex", { input: 1.25, cachedInput: 0.125, output: 10 }],
  ["gpt-5", { input: 1.25, cachedInput: 0.125, output: 10 }],
];

function nonNegativeFinite(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function ratesForCodexModel(model: string | null): TokenRates | null {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  // Spark is listed in the current Work rate card without final token pricing.
  // Do not silently inherit GPT-5.3-Codex pricing from its slug prefix.
  if (normalized === "gpt-5.3-codex-spark" || normalized.startsWith("gpt-5.3-codex-spark-")) {
    return null;
  }
  for (const [slug, rates] of CODEX_TOKEN_RATES) {
    if (normalized === slug || normalized.startsWith(`${slug}-`)) {
      return rates;
    }
  }
  return null;
}

export function estimateProfileTokenUsageUsd(usage: ProfileTokenPricingUsage): number | null {
  if (usage.provider !== "codex") {
    return null;
  }
  const rates = ratesForCodexModel(usage.model);
  const inputTokens = nonNegativeFinite(usage.inputTokens);
  const cachedInputTokens = nonNegativeFinite(usage.cachedInputTokens);
  const cacheWriteInputTokens = nonNegativeFinite(usage.cacheWriteInputTokens);
  const outputTokens = nonNegativeFinite(usage.outputTokens);
  const lastInputTokens =
    usage.lastInputTokens === null ? null : nonNegativeFinite(usage.lastInputTokens);
  if (
    !rates ||
    inputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    outputTokens === null
  ) {
    return null;
  }
  if (rates.fastMultiplier !== undefined && usage.fastMode === null) {
    return null;
  }
  if (rates.longContext === true && lastInputTokens === null) {
    return null;
  }

  // Codex reports cached input as a subset of input. Clamp malformed telemetry
  // instead of allowing it to create negative uncached usage. Cache writes are
  // also included in input but carry no charge on the current Codex rate card.
  // Reasoning output is already a subset of output and is intentionally not added.
  const cached = Math.min(cachedInputTokens, inputTokens);
  const cacheWrites = Math.min(cacheWriteInputTokens, inputTokens - cached);
  const uncached = inputTokens - cached - cacheWrites;
  const isLongContext =
    rates.longContext === true &&
    lastInputTokens !== null &&
    lastInputTokens > LONG_CONTEXT_INPUT_THRESHOLD;
  const inputMultiplier = isLongContext ? 2 : 1;
  const outputMultiplier = isLongContext ? 1.5 : 1;
  const fastMultiplier = usage.fastMode === true ? (rates.fastMultiplier ?? 1) : 1;

  return (
    ((uncached * rates.input * inputMultiplier +
      cached * rates.cachedInput * inputMultiplier +
      outputTokens * rates.output * outputMultiplier) /
      TOKENS_PER_MILLION) *
    fastMultiplier
  );
}

export function estimateProfileTokenCost(
  usages: ReadonlyArray<ProfileTokenPricingUsage>,
): ProfileTokenCostEstimate {
  let costUsd = 0;
  let pricedTokens = 0;
  for (const usage of usages) {
    const rowCost = estimateProfileTokenUsageUsd(usage);
    if (rowCost === null) {
      continue;
    }
    costUsd += rowCost;
    pricedTokens += Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
  }
  return { costUsd, pricedTokens };
}
