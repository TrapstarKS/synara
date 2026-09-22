import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@synara/contracts";

import {
  assessCodexCacheObservation,
  deriveContextWindowSelectionStatus,
  deriveComposerContextWindowLabel,
  deriveAppliedContextWindowSelection,
  deriveContextWindowMeterDisplay,
  deriveCumulativeCostUsd,
  deriveCodexCacheObservation,
  deriveLatestContextWindowState,
  deriveSelectedContextWindowSnapshot,
  formatContextWindowSelectionLabel,
  formatContextWindowTokens,
  inferContextWindowSelectionValue,
} from "./contextWindow";

function makeActivity(
  id: string,
  kind: string,
  payload: OrchestrationThreadActivity["payload"],
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.makeUnsafe("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("uses the first event in a repeated Codex usage series for cache recency", () => {
    const first = makeActivity("usage-first", "context-window.updated", {
      provider: "codex",
      usageSessionId: "session-1",
      usedTokens: 100,
      lastCachedInputTokens: 40,
      cumulativeUsage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 },
    });
    const repeated = {
      ...first,
      id: EventId.makeUnsafe("usage-repeat"),
      createdAt: "2026-03-23T00:20:00.000Z",
    };
    const observation = deriveCodexCacheObservation([first, repeated]);
    expect(observation).toEqual({ observedAt: first.createdAt });
    expect(assessCodexCacheObservation(observation, Date.parse("2026-03-23T00:22:00Z"))).toEqual({
      state: "aging",
      ageSeconds: 22 * 60,
    });
  });

  it("invalidates Codex cache recency after a miss, compaction, or model reroute", () => {
    const hit = makeActivity("usage-hit", "context-window.updated", {
      provider: "codex",
      usageSessionId: "session-1",
      usedTokens: 100,
      lastCachedInputTokens: 40,
      cumulativeUsage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 },
    });
    const miss = makeActivity("usage-miss", "context-window.updated", {
      provider: "codex",
      usageSessionId: "session-1",
      usedTokens: 200,
      lastCachedInputTokens: 0,
      lastCacheCreationInputTokens: 0,
      cumulativeUsage: { inputTokens: 200, outputTokens: 20, cachedInputTokens: 40 },
    });
    expect(deriveCodexCacheObservation([hit, miss])).toBeNull();
    expect(
      deriveCodexCacheObservation([
        hit,
        makeActivity("compact", "context-compaction", {
          state: "compacted",
        }),
      ]),
    ).toBeNull();
    expect(
      deriveCodexCacheObservation([hit, makeActivity("rerouted", "model.rerouted", {})]),
    ).toBeNull();
    expect(
      deriveCodexCacheObservation([hit, makeActivity("boundary", "provider.session.boundary", {})]),
    ).toBeNull();
  });

  it("marks cache recency as an estimate and never declares an old entry expired", () => {
    const observation = { observedAt: "2026-03-23T00:00:00.000Z" };
    const now = Date.parse(observation.observedAt);
    expect(assessCodexCacheObservation(observation, now + 4 * 60_000).state).toBe("recent");
    expect(assessCodexCacheObservation(observation, now + 5 * 60_000).state).toBe("aging");
    expect(assessCodexCacheObservation(observation, now + 30 * 60_000).state).toBe("unknown");
    expect(assessCodexCacheObservation(observation, now - 1_000)).toEqual({
      state: "unknown",
      ageSeconds: null,
    });
  });

  it("does not label a runtime threshold as the target when configuration history is missing", () => {
    expect(
      deriveContextWindowSelectionStatus({
        activeSnapshot: deriveSelectedContextWindowSnapshot("1m"),
        appliedValue: null,
        selectedValue: "auto",
      }),
    ).toEqual({ activeLabel: null, selectedLabel: "Auto", pendingSelectedLabel: null });
  });

  it("uses persisted applied modes so Auto is not permanently pending", () => {
    for (const [payload, appliedValue] of [
      [{ cleared: true }, "auto"],
      [{ maxTokens: 200_000 }, "200k"],
      [{ maxTokens: 1_000_000 }, "1m"],
    ] as const) {
      const applied = deriveAppliedContextWindowSelection([
        makeActivity("configured", "context-window.configured", payload),
      ]);
      expect(applied).toBe(appliedValue);
      expect(
        deriveContextWindowSelectionStatus({
          activeSnapshot: deriveSelectedContextWindowSnapshot("1m"),
          appliedValue: applied,
          selectedValue: appliedValue,
        }).pendingSelectedLabel,
      ).toBeNull();
    }
  });

  it("keeps the runtime denominator with its percentage", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("configured", "context-window.configured", { maxTokens: 1_000_000 }),
      makeActivity("usage", "context-window.updated", {
        usedTokens: 500_000,
        maxTokens: 967_000,
        usedPercent: 51.7,
      }),
    ]).snapshot;
    expect(snapshot?.maxTokens).toBe(967_000);
    expect(snapshot?.usedPercentage).toBe(51.7);
  });

  it("preserves validated Claude cache evidence from the latest usage snapshot", () => {
    const claudeCache = {
      observedAt: "2026-03-23T00:00:00.000Z",
      state: "unknown",
      source: "request-usage",
      contextTokens: 887_036,
      lastRequest: { messageId: "request-1", cacheCreationInputTokens: 887_036 },
    };
    const derive = (value: OrchestrationThreadActivity["payload"] | undefined) =>
      deriveLatestContextWindowState([
        makeActivity("cache", "context-window.updated", {
          usedTokens: 887_036,
          ...(value === undefined ? {} : { claudeCache: value }),
        }),
      ]).snapshot;
    expect(derive(claudeCache)?.claudeCache).toEqual(claudeCache);
    expect(derive(undefined)?.claudeCache).toBeNull();
    expect(derive({ ...claudeCache, state: "warm" })?.claudeCache).toBeNull();
    expect(derive({ ...claudeCache, contextTokens: -1 })?.claudeCache).toBeNull();
  });

  it("keeps Codex session cache totals and ignores malformed counters", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("usage", "context-window.updated", {
        provider: "codex",
        usedTokens: 193_000,
        inputTokens: 193_000,
        cachedInputTokens: 96_000,
        cacheCreationInputTokens: 40_000,
        cumulativeUsage: {
          inputTokens: 2_400_000,
          outputTokens: 120_000,
          cachedInputTokens: 1_200_000,
          cacheCreationInputTokens: 400_000,
        },
      }),
    ]).snapshot;
    expect(snapshot?.cachedInputTokens).toBe(96_000);
    expect(snapshot?.cacheCreationInputTokens).toBe(40_000);
    expect(snapshot?.cumulativeUsage).toEqual({
      inputTokens: 2_400_000,
      outputTokens: 120_000,
      cachedInputTokens: 1_200_000,
      cacheCreationInputTokens: 400_000,
    });

    const malformed = deriveLatestContextWindowState([
      makeActivity("usage-bad", "context-window.updated", {
        usedTokens: 193_000,
        cachedInputTokens: -10,
        cacheCreationInputTokens: -20,
        cumulativeUsage: { inputTokens: -1, outputTokens: 120_000, cachedInputTokens: 30 },
      }),
    ]).snapshot;
    expect(malformed?.cumulativeUsage).toBeNull();
    expect(malformed?.cachedInputTokens).toBeNull();
    expect(malformed?.cacheCreationInputTokens).toBeNull();
  });

  it("withholds old Claude processed totals while preserving context and other providers", () => {
    for (const provider of ["claudeAgent", "codex"]) {
      const payload = { provider, usedTokens: 100, totalProcessedTokens: 400 };
      const legacy = deriveLatestContextWindowState([
        makeActivity("legacy", "context-window.updated", payload),
      ]).snapshot;
      expect(legacy?.usedTokens).toBe(100);
      expect(legacy?.totalProcessedTokens).toBe(provider === "claudeAgent" ? null : 400);
      const corrected = deriveLatestContextWindowState([
        makeActivity("corrected", "context-window.updated", {
          ...payload,
          tokenAccountingVersion: 1,
        }),
      ]).snapshot;
      expect(corrected?.totalProcessedTokens).toBe(400);
    }
  });

  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("invalidates earlier usage at a completed compaction until fresh usage arrives", () => {
    const beforeCompaction = [
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "200k",
        maxTokens: 200_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 180_000,
        maxTokens: 200_000,
      }),
      makeActivity("activity-3", "context-compaction", {
        state: "compacted",
      }),
      makeActivity("activity-4", "context-window.updated", {
        usedTokens: 0,
        totalProcessedTokens: 340_000,
      }),
    ];

    expect(deriveLatestContextWindowState(beforeCompaction).snapshot).toBeNull();
    expect(deriveLatestContextWindowState(beforeCompaction).invalidatedByCompaction).toBe(true);

    const afterFreshUsage = deriveLatestContextWindowState([
      ...beforeCompaction,
      makeActivity("activity-5", "context-window.updated", {
        usedTokens: 20_000,
        maxTokens: 200_000,
      }),
    ]).snapshot;

    expect(afterFreshUsage?.usedTokens).toBe(20_000);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {}),
    ]).snapshot;

    expect(snapshot).toBeNull();
  });

  it("derives percent-only context window snapshots", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercent).toBe(5.8);
    expect(snapshot?.usedPercentage).toBe(5.8);
    expect(snapshot?.maxTokens).toBeNull();
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("derives real zero-percent context window snapshots", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 0,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercent).toBe(0);
    expect(snapshot?.usedPercentage).toBe(0);
  });

  it("keeps zero-token usage reliable when runtime reports max tokens", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 0,
        maxTokens: 128_000,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot?.remainingTokens).toBe(128_000);
    expect(deriveContextWindowMeterDisplay(snapshot!)).toMatchObject({
      hasReliableTokenRatio: true,
      tokenUsageLabel: "0",
      compactLabel: "0%",
    });
  });

  it("does not infer remaining tokens from percent-only usage", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercentage).toBe(5.8);
    expect(snapshot?.maxTokens).toBeNull();
    expect(snapshot?.remainingTokens).toBeNull();
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]).snapshot;

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("uses runtime reporting instead of the configured target", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
    ]).snapshot;

    expect(snapshot?.usedTokens).toBe(23_000);
    expect(snapshot?.maxTokens).toBe(200_000);
  });

  it("invalidates old usage when Auto is applied", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
      makeActivity("activity-3", "context-window.configured", { cleared: true }),
    ]).snapshot;

    expect(snapshot).toBeNull();
  });

  it("waits for runtime usage instead of presenting the target as a measurement", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
    ]).snapshot;

    expect(snapshot).toBeNull();
  });

  it("creates an initial selected context window snapshot before runtime usage arrives", () => {
    const snapshot = deriveSelectedContextWindowSnapshot("1m");

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.maxTokens).toBe(1_000_000);
    expect(snapshot?.usedPercentage).toBe(0);
  });

  it("derives meter display labels without inventing token ratios", () => {
    const percentOnly = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
      }),
    ]).snapshot;

    expect(percentOnly).not.toBeNull();
    expect(deriveContextWindowMeterDisplay(percentOnly!)).toMatchObject({
      usedPercentageLabel: "5.8%",
      tokenUsageLabel: "0",
      hasReliableTokenRatio: false,
      normalizedPercentage: 5.8,
      compactLabel: "6%",
      ariaLabel: "Context window 5.8% used",
    });
  });

  it("formats context window selection labels for Claude options", () => {
    expect(formatContextWindowSelectionLabel("1m")).toBe("1M");
    expect(formatContextWindowSelectionLabel("200k")).toBe("200k");
  });

  it("uses Cursor cumulative cost without summing it as a turn delta", () => {
    expect(
      deriveCumulativeCostUsd([
        makeActivity("turn-1", "turn.completed", {
          cumulativeCostUsd: 0.2,
        }),
        makeActivity("turn-2", "turn.completed", {
          cumulativeCostUsd: 0.25,
        }),
      ]),
    ).toBe(0.25);
  });

  it("infers the active Claude context window from max tokens", () => {
    expect(inferContextWindowSelectionValue(200_000)).toBe("200k");
    expect(inferContextWindowSelectionValue(1_000_000)).toBe("1m");
    expect(inferContextWindowSelectionValue(333_000)).toBeNull();
  });

  it("marks a selected Claude context window as pending when the live session differs", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
    ]).snapshot;

    expect(
      deriveContextWindowSelectionStatus({
        activeSnapshot: snapshot,
        selectedValue: "1m",
      }),
    ).toEqual({
      activeLabel: "200k",
      selectedLabel: "1M",
      pendingSelectedLabel: "1M",
    });
  });
});

describe("composer context budget label", () => {
  const model = "claude-fable-5-1";
  it.each([
    ["auto", "auto", 967000, model, "(1M)"],
    ["1m", "1m", 967000, `${model}[1m]`, "(1M)"],
    ["1m", "1m", 167000, model, "(200k)"],
    ["200k", "1m", 167000, model, "(200k · 1M next)"],
    ["1m", "auto", 967000, model, "(1M · Auto next)"],
    [null, "1m", null, null, "(1M next)"],
    [null, "auto", null, null, null],
    ["1m", "1m", 967000, "claude-opus-4-7", "(1M next)"],
    ["1m", "1m", 967000, null, "(1M next)"],
    ["1m", "1m", 50000, model, "(1M target)"],
  ])(
    "applied %s, selected %s, budget %s, model %s",
    (applied, selected, maxTokens, observedModel, expected) => {
      const snapshot =
        maxTokens === null
          ? null
          : {
              ...deriveSelectedContextWindowSnapshot("1m")!,
              maxTokens,
              claudeCache: observedModel
                ? {
                    model: observedModel,
                    observedAt: "2026-09-17T00:00:00.000Z",
                    state: "unknown" as const,
                    source: "request-usage" as const,
                  }
                : null,
            };
      const status = deriveContextWindowSelectionStatus({
        activeSnapshot: snapshot,
        appliedValue: applied,
        selectedValue: selected,
      });
      expect(
        deriveComposerContextWindowLabel({ provider: "claudeAgent", model, snapshot, status }),
      ).toBe(expected);
      expect(
        deriveComposerContextWindowLabel({ provider: "codex", model, snapshot, status }),
      ).toBeNull();
    },
  );
});
