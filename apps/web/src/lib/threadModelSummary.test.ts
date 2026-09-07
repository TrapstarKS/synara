import { describe, expect, it } from "vitest";

import { resolveThreadModelSummary } from "./threadModelSummary";

describe("resolveThreadModelSummary", () => {
  it("returns null without a selection", () => {
    expect(resolveThreadModelSummary(null)).toBeNull();
    expect(resolveThreadModelSummary(undefined)).toBeNull();
  });

  it("summarizes a codex selection with its reasoning effort", () => {
    const summary = resolveThreadModelSummary({
      provider: "codex",
      model: "gpt-5.5",
      options: { reasoningEffort: "high" },
    });

    expect(summary?.provider).toBe("codex");
    expect(summary?.modelLabel.length).toBeGreaterThan(0);
    expect(summary?.statusLabel?.toLowerCase()).toBe("high");
  });

  it("falls back to the model's default effort when none is stored", () => {
    const withEffort = resolveThreadModelSummary({
      provider: "codex",
      model: "gpt-5.5",
      options: { reasoningEffort: "low" },
    });
    const withoutOptions = resolveThreadModelSummary({
      provider: "codex",
      model: "gpt-5.5",
    });

    expect(withEffort?.statusLabel?.toLowerCase()).toBe("low");
    expect(withoutOptions?.statusLabel).not.toBeNull();
    expect(withoutOptions?.statusLabel).not.toBe(withEffort?.statusLabel);
  });

  it("summarizes a claude selection", () => {
    const summary = resolveThreadModelSummary({
      provider: "claudeAgent",
      model: "claude-sonnet-5",
      options: { effort: "high" },
    });

    expect(summary?.provider).toBe("claudeAgent");
    expect(summary?.modelLabel.length).toBeGreaterThan(0);
    expect(summary?.fastMode).toBe(false);
  });
});

describe("runtime Codex model effort", () => {
  it("preserves an explicit effort before discovery without guessing an unknown default", () => {
    expect(
      resolveThreadModelSummary({
        provider: "codex",
        model: "gpt-6-astra",
        options: { reasoningEffort: "low" },
      })?.statusLabel,
    ).toBe("Low");
    expect(
      resolveThreadModelSummary({
        provider: "codex",
        model: "gpt-6-astra",
      })?.statusLabel,
    ).toBeNull();
  });

  it("uses the discovered default and labels for dynamic models", () => {
    const runtimeModel = {
      slug: "gpt-6-astra",
      name: "GPT-6 Astra",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ value: "low" }, { value: "medium", label: "Medium" }],
    };
    expect(
      resolveThreadModelSummary(
        {
          provider: "codex",
          model: "gpt-6-astra",
        },
        runtimeModel,
      )?.statusLabel,
    ).toBe("Medium");
    expect(
      resolveThreadModelSummary(
        {
          provider: "codex",
          model: "gpt-6-astra",
          options: { reasoningEffort: "low" },
        },
        runtimeModel,
      )?.statusLabel,
    ).toBe("Low");
  });
});
