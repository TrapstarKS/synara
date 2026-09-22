import {
  ClaudeCacheObservation,
  type ProviderKind,
  type OrchestrationThreadActivity,
  type ThreadTokenUsageSnapshot,
} from "@synara/contracts";
import { normalizeModelSlug, stripClaudeContextWindowSuffix } from "@synara/shared/model";
import { Schema } from "effect";

const decodeClaudeCacheObservation = Schema.decodeUnknownOption(ClaudeCacheObservation);

function readClaudeCacheObservation(value: unknown): ClaudeCacheObservation | null {
  const decoded = decodeClaudeCacheObservation(value);
  return decoded._tag === "Some" ? decoded.value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readCumulativeUsage(
  value: unknown,
): NonNullable<ThreadTokenUsageSnapshot["cumulativeUsage"]> | null {
  const usage = asRecord(value);
  const inputTokens = asNonNegativeInteger(usage?.inputTokens);
  const outputTokens = asNonNegativeInteger(usage?.outputTokens);
  if (inputTokens === null || outputTokens === null) return null;
  const cachedInputTokens = asNonNegativeInteger(usage?.cachedInputTokens);
  const cacheCreationInputTokens = asNonNegativeInteger(usage?.cacheCreationInputTokens);
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== null ? { cacheCreationInputTokens } : {}),
  };
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asContextWindowPercent(value: unknown): number | null {
  const percent = asFiniteNumber(value);
  if (percent === null) {
    return null;
  }
  return Math.max(0, Math.min(100, percent));
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly codexCacheObservation: CodexCacheObservation | null;
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export interface ContextWindowState {
  readonly snapshot: ContextWindowSnapshot | null;
  readonly invalidatedByCompaction: boolean;
}

export interface CodexCacheObservation {
  readonly observedAt: string;
}

export interface CodexCacheAssessment {
  readonly state: "recent" | "aging" | "unknown";
  readonly ageSeconds: number | null;
}

export interface ContextWindowSelectionStatus {
  readonly activeLabel: string | null;
  readonly selectedLabel: string | null;
  readonly pendingSelectedLabel: string | null;
}

export interface ContextWindowMeterDisplay {
  readonly usedPercentageLabel: string | null;
  readonly tokenUsageLabel: string;
  readonly hasReliableTokenRatio: boolean;
  readonly normalizedPercentage: number;
  readonly compactLabel: string;
  readonly ariaLabel: string;
}

const KNOWN_CONTEXT_WINDOW_MAX_TOKENS = {
  "200k": 200_000,
  "1m": 1_000_000,
} as const;

export function isCompletedContextCompaction(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-compaction") {
    return false;
  }
  const payload = asRecord(activity.payload);
  return payload?.state === "compacted" || payload?.status === "completed";
}

// Native rate-limit notifications can repeat the last request's token counters.
// Use the oldest event in the latest unchanged cumulative series as its time.
export function deriveCodexCacheObservation(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): CodexCacheObservation | null {
  let latest: {
    readonly sessionId: string | null;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly readTokens: number | null;
    readonly writtenTokens: number | null;
    observedAt: string;
  } | null = null;

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) continue;
    if (
      activity.kind === "context-window.configured" ||
      activity.kind === "model.rerouted" ||
      activity.kind === "provider.session.boundary" ||
      activity.kind === "provider.handoff.completed" ||
      isCompletedContextCompaction(activity)
    ) {
      break;
    }
    if (activity.kind !== "context-window.updated") continue;

    const payload = asRecord(activity.payload);
    if (payload?.provider !== "codex") return null;
    const cumulative = readCumulativeUsage(payload.cumulativeUsage);
    if (!cumulative) return null;
    const sessionId = typeof payload.usageSessionId === "string" ? payload.usageSessionId : null;
    const readTokens = asNonNegativeInteger(
      payload.lastCachedInputTokens ?? payload.cachedInputTokens,
    );
    const writtenTokens = asNonNegativeInteger(
      payload.lastCacheCreationInputTokens ?? payload.cacheCreationInputTokens,
    );

    if (latest) {
      if (
        latest.sessionId !== sessionId ||
        latest.inputTokens !== cumulative.inputTokens ||
        latest.outputTokens !== cumulative.outputTokens
      ) {
        break;
      }
      if (latest.readTokens !== readTokens || latest.writtenTokens !== writtenTokens) return null;
      latest.observedAt = activity.createdAt;
      continue;
    }
    latest = {
      sessionId,
      inputTokens: cumulative.inputTokens,
      outputTokens: cumulative.outputTokens,
      readTokens,
      writtenTokens,
      observedAt: activity.createdAt,
    };
  }

  return latest && ((latest.readTokens ?? 0) > 0 || (latest.writtenTokens ?? 0) > 0)
    ? { observedAt: latest.observedAt }
    : null;
}

export function assessCodexCacheObservation(
  observation: CodexCacheObservation | null,
  nowMs: number,
): CodexCacheAssessment {
  const observedAtMs = observation ? Date.parse(observation.observedAt) : NaN;
  if (!Number.isFinite(nowMs) || !Number.isFinite(observedAtMs) || observedAtMs > nowMs) {
    return { state: "unknown", ageSeconds: null };
  }
  const ageSeconds = Math.floor((nowMs - observedAtMs) / 1_000);
  return {
    state: ageSeconds < 5 * 60 ? "recent" : ageSeconds < 30 * 60 ? "aging" : "unknown",
    ageSeconds,
  };
}

export function formatCacheDuration(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"}${remainingMinutes > 0 ? ` ${remainingMinutes} min` : ""}`;
}

// Read the latest token-usage snapshot emitted by the runtime.
export function deriveLatestContextWindowState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowState {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) {
      continue;
    }
    // A new configuration starts a new reporting epoch. Old usage cannot
    // establish the effective threshold of a resumed or switched session.
    if (activity.kind === "context-window.configured") {
      return { snapshot: null, invalidatedByCompaction: false };
    }
    if (isCompletedContextCompaction(activity)) {
      return { snapshot: null, invalidatedByCompaction: true };
    }
    if (activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const rawUsedTokens = asFiniteNumber(payload?.usedTokens);
    const usedTokens = rawUsedTokens ?? 0;
    const payloadUsedPercent = asContextWindowPercent(payload?.usedPercent);
    const maxTokens = asFiniteNumber(payload?.maxTokens);
    if (usedTokens <= 0 && payloadUsedPercent === null && (maxTokens === null || maxTokens <= 0)) {
      continue;
    }

    const usedPercentage =
      payloadUsedPercent ??
      (maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null);
    const hasReliableTokenUsage =
      rawUsedTokens !== null &&
      (usedTokens > 0 || payloadUsedPercent === null || (maxTokens !== null && maxTokens > 0));
    const remainingTokens =
      maxTokens !== null && hasReliableTokenUsage
        ? Math.max(0, Math.round(maxTokens - usedTokens))
        : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      snapshot: {
        claudeCache: readClaudeCacheObservation(payload?.claudeCache),
        codexCacheObservation:
          payload?.provider === "codex" ? deriveCodexCacheObservation(activities) : null,
        cumulativeUsage: readCumulativeUsage(payload?.cumulativeUsage),
        usedTokens,
        usedPercent: payloadUsedPercent,
        // Older Claude totals counted completed content blocks repeatedly.
        // Keep the context meter, but withhold an unverifiable lifetime counter.
        totalProcessedTokens:
          payload?.provider === "claudeAgent" && payload.tokenAccountingVersion !== 1
            ? null
            : asFiniteNumber(payload?.totalProcessedTokens),
        tokenAccountingVersion: payload?.tokenAccountingVersion === 1 ? 1 : null,
        maxTokens,
        remainingTokens,
        usedPercentage,
        remainingPercentage,
        inputTokens: asNonNegativeInteger(payload?.inputTokens),
        cachedInputTokens: asNonNegativeInteger(payload?.cachedInputTokens),
        cacheCreationInputTokens: asNonNegativeInteger(payload?.cacheCreationInputTokens),
        outputTokens: asFiniteNumber(payload?.outputTokens),
        reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
        lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
        lastInputTokens: asNonNegativeInteger(payload?.lastInputTokens),
        lastCachedInputTokens: asNonNegativeInteger(payload?.lastCachedInputTokens),
        lastCacheCreationInputTokens: asNonNegativeInteger(payload?.lastCacheCreationInputTokens),
        lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
        lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
        toolUses: asFiniteNumber(payload?.toolUses),
        durationMs: asFiniteNumber(payload?.durationMs),
        compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
        updatedAt: activity.createdAt,
      },
      invalidatedByCompaction: false,
    };
  }

  return { snapshot: null, invalidatedByCompaction: false };
}

// Configuration identifies the applied target, never the runtime denominator.
export function deriveAppliedContextWindowSelection(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string | null {
  const activity = activities.findLast((item) => item.kind === "context-window.configured");
  const payload = asRecord(activity?.payload);
  if (payload?.cleared === true) return "auto";
  const maxTokens = asFiniteNumber(payload?.maxTokens);
  return (
    Object.entries(KNOWN_CONTEXT_WINDOW_MAX_TOKENS).find(
      ([, tokens]) => tokens === maxTokens,
    )?.[0] ?? null
  );
}

export function deriveSelectedContextWindowSnapshot(
  selectedValue: string | null | undefined,
): ContextWindowSnapshot | null {
  const normalized = selectedValue?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const maxTokens =
    KNOWN_CONTEXT_WINDOW_MAX_TOKENS[normalized as keyof typeof KNOWN_CONTEXT_WINDOW_MAX_TOKENS] ??
    null;
  if (maxTokens === null) {
    return null;
  }

  return {
    claudeCache: null,
    codexCacheObservation: null,
    usedTokens: 0,
    usedPercent: null,
    totalProcessedTokens: null,
    maxTokens,
    remainingTokens: maxTokens,
    usedPercentage: 0,
    remainingPercentage: 100,
    inputTokens: null,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastCacheCreationInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    updatedAt: "",
  };
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function deriveContextWindowMeterDisplay(
  usage: ContextWindowSnapshot,
): ContextWindowMeterDisplay {
  const usedPercentageLabel = formatPercentage(usage.usedPercentage);
  const tokenUsageLabel = formatContextWindowTokens(usage.usedTokens);
  const hasReliableTokenRatio =
    usage.maxTokens !== null &&
    (usage.usedTokens > 0 || usage.usedPercent === null || usage.remainingTokens !== null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  return {
    usedPercentageLabel,
    tokenUsageLabel,
    hasReliableTokenRatio,
    normalizedPercentage,
    compactLabel:
      usage.usedPercentage !== null ? `${Math.round(usage.usedPercentage)}%` : tokenUsageLabel,
    ariaLabel: usedPercentageLabel
      ? `Context window ${usedPercentageLabel} used`
      : `Context window ${tokenUsageLabel} tokens used`,
  };
}

export function deriveCumulativeCostUsd(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  let turnDeltaTotal = 0;
  let latestCumulative: number | null = null;
  let foundTurnDelta = false;
  for (const activity of activities) {
    if (activity.kind !== "turn.completed") continue;
    const payload = asRecord(activity.payload);
    const cumulativeCost = asFiniteNumber(payload?.cumulativeCostUsd);
    if (cumulativeCost !== null) {
      latestCumulative = cumulativeCost;
      continue;
    }
    const cost = asFiniteNumber(payload?.totalCostUsd);
    if (cost === null) continue;
    turnDeltaTotal += cost;
    foundTurnDelta = true;
  }
  if (latestCumulative !== null) {
    return latestCumulative + turnDeltaTotal;
  }
  return foundTurnDelta ? turnDeltaTotal : null;
}

export function formatContextWindowSelectionLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "auto") return "Auto";
  if (normalized === "1m") {
    return "1M";
  }
  if (normalized === "200k") {
    return "200k";
  }
  return normalized.replace(/m$/u, "M");
}

export function inferContextWindowSelectionValue(
  maxTokens: number | null | undefined,
): string | null {
  if (maxTokens == null || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return null;
  }
  const bestMatch = Object.entries(KNOWN_CONTEXT_WINDOW_MAX_TOKENS).reduce<{
    value: string | null;
    relativeDistance: number;
  }>(
    (best, [value, knownMaxTokens]) => {
      const relativeDistance = Math.abs(maxTokens - knownMaxTokens) / knownMaxTokens;
      return relativeDistance < best.relativeDistance ? { value, relativeDistance } : best;
    },
    { value: null, relativeDistance: Number.POSITIVE_INFINITY },
  );
  return bestMatch.relativeDistance <= 0.2 ? bestMatch.value : null;
}

export function deriveContextWindowSelectionStatus(input: {
  activeSnapshot: ContextWindowSnapshot | null;
  appliedValue?: string | null;
  selectedValue: string | null | undefined;
}): ContextWindowSelectionStatus {
  const activeValue =
    input.appliedValue === undefined
      ? inferContextWindowSelectionValue(input.activeSnapshot?.maxTokens ?? null)
      : input.appliedValue;
  const selectedValue = input.selectedValue?.trim().toLowerCase() ?? null;
  const activeLabel =
    formatContextWindowSelectionLabel(activeValue) ??
    (input.appliedValue === undefined && input.activeSnapshot?.maxTokens != null
      ? formatContextWindowTokens(input.activeSnapshot.maxTokens)
      : null);
  const selectedLabel = formatContextWindowSelectionLabel(selectedValue);
  const pendingSelectedLabel =
    selectedLabel !== null && activeValue !== null && selectedValue !== activeValue
      ? selectedLabel
      : null;

  return {
    activeLabel,
    selectedLabel,
    pendingSelectedLabel,
  };
}

// Budget is runtime evidence; the configured mode remains a separate target.
export function deriveComposerContextWindowLabel(input: {
  provider: ProviderKind;
  model: string;
  snapshot: ContextWindowSnapshot | null;
  status: ContextWindowSelectionStatus;
}): string | null {
  if (input.provider !== "claudeAgent") return null;
  const observedModel = input.snapshot?.claudeCache?.model;
  const sameModel =
    observedModel !== undefined &&
    stripClaudeContextWindowSuffix(normalizeModelSlug(observedModel, "claudeAgent") ?? "") ===
      stripClaudeContextWindowSuffix(normalizeModelSlug(input.model, "claudeAgent") ?? "");
  const budget = sameModel
    ? formatContextWindowSelectionLabel(inferContextWindowSelectionValue(input.snapshot?.maxTokens))
    : null;
  const { selectedLabel, activeLabel, pendingSelectedLabel } = input.status;
  const pending = pendingSelectedLabel ?? (!sameModel ? selectedLabel : null);
  if (budget) return pending ? `(${budget} · ${pending} next)` : `(${budget})`;
  if (selectedLabel === null || (selectedLabel === "Auto" && !pendingSelectedLabel)) return null;
  return `(${selectedLabel} ${pending || activeLabel === null ? "next" : "target"})`;
}

export function formatCostUsd(value: number): string {
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  if (value < 0.001) return `$${value.toFixed(5)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 0.1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatContextWindowTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
