import {
  assessCodexCacheObservation,
  formatCacheDuration,
  formatContextWindowTokens,
  type ContextWindowSnapshot,
} from "~/lib/contextWindow";

function cacheShare(cached: number, input: number | null | undefined): string | null {
  if (input == null || input <= 0 || cached > input) return null;
  return `${Math.round((cached / input) * 100)}% of input`;
}

function CacheRow({
  label,
  cached,
  input,
}: {
  label: string;
  cached: number;
  input?: number | null | undefined;
}) {
  const share = cacheShare(cached, input);
  return (
    <>
      <dt>{label}</dt>
      <dd className="text-right tabular-nums">
        {formatContextWindowTokens(cached)} tokens{share ? ` · ${share}` : ""}
      </dd>
    </>
  );
}

export function CodexCacheDetails({
  usage,
  nowMs,
}: {
  usage: ContextWindowSnapshot;
  nowMs: number;
}) {
  const assessment = assessCodexCacheObservation(usage.codexCacheObservation, nowMs);
  const statusLabel =
    assessment.state === "recent"
      ? "Recently observed"
      : assessment.state === "aging"
        ? "Observation aging"
        : "Unknown";
  const statusDot =
    assessment.state === "recent"
      ? "bg-success"
      : assessment.state === "aging"
        ? "bg-warning"
        : "bg-muted-foreground";
  const lastCached = usage.lastCachedInputTokens ?? usage.cachedInputTokens;
  const lastWritten = usage.lastCacheCreationInputTokens ?? usage.cacheCreationInputTokens;
  const lastInput = usage.lastInputTokens ?? usage.inputTokens;
  const sessionCached = usage.cumulativeUsage?.cachedInputTokens;
  const sessionWritten = usage.cumulativeUsage?.cacheCreationInputTokens;
  const sessionInput = usage.cumulativeUsage?.inputTokens;
  return (
    <div className="space-y-1.5 border-t border-border/50 pt-2 text-ui leading-snug text-muted-foreground">
      <div className="font-medium text-foreground">Codex prompt cache</div>
      <div className="flex items-center gap-1.5">
        <span className={`size-1.5 shrink-0 rounded-full ${statusDot}`} aria-hidden="true" />
        <span>Cache status: {statusLabel}</span>
        {assessment.state !== "unknown" ? <span className="text-ui-xs">(estimate)</span> : null}
      </div>
      {assessment.ageSeconds !== null ? (
        <div>Last confirmed cache activity: {formatCacheDuration(assessment.ageSeconds)} ago</div>
      ) : null}
      {lastCached != null ||
      lastWritten != null ||
      sessionCached != null ||
      sessionWritten != null ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          {lastCached != null ? (
            <CacheRow label="Last request · read" cached={lastCached} input={lastInput} />
          ) : null}
          {lastWritten != null ? (
            <CacheRow label="Last request · written" cached={lastWritten} />
          ) : null}
          {sessionCached != null ? (
            <CacheRow label="Session · read" cached={sessionCached} input={sessionInput} />
          ) : null}
          {sessionWritten != null ? (
            <CacheRow label="Session · written" cached={sessionWritten} />
          ) : null}
        </dl>
      ) : null}
      <p className="max-w-72 leading-relaxed">
        Recent cache activity does not guarantee a hit on the next request. Cache tokens still use
        context space.
      </p>
    </div>
  );
}
