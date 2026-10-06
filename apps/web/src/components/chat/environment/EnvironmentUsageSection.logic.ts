// FILE: EnvironmentUsageSection.logic.ts
// Purpose: Pure compact-summary decisions for provider rows in the Environment panel.

import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import type { ResolvedProviderInstance } from "@synara/shared/providerInstances";
import { providerUsageDisplayName } from "@synara/shared/providerUsage";
import type { ProviderUsageDisplayRow } from "~/lib/providerUsageDisplay";

export interface ProviderUsageAccount {
  readonly instance: ResolvedProviderInstance;
  readonly snapshot: ServerProviderUsageSnapshot;
  readonly label: string;
}

/** One usage entry per enabled account of `provider`, labelled when more than one exists. */
export function resolveProviderUsageAccounts(input: {
  readonly provider: ProviderKind;
  readonly instances: ReadonlyArray<ResolvedProviderInstance>;
  readonly snapshots: ReadonlyArray<ServerProviderUsageSnapshot>;
}): ReadonlyArray<ProviderUsageAccount> {
  const { provider } = input;
  const providerInstances = input.instances.filter(
    (instance) => instance.enabled && instance.driver === provider,
  );
  return providerInstances.flatMap((instance) => {
    const snapshot = input.snapshots.find(
      (entry) =>
        entry.provider === provider && (entry.instanceId ?? entry.provider) === instance.instanceId,
    );
    if (!snapshot) return [];
    const hasUsage =
      snapshot.limits.length > 0 ||
      snapshot.usageLines.length > 0 ||
      (snapshot.resetCredits?.availableCount ?? 0) > 0;
    // Unused default providers should not crowd the panel. Configured extra
    // accounts stay visible so an expired login or failed usage check is clear.
    if (
      instance.isDefault &&
      providerInstances.length === 1 &&
      !instance.raw.displayName &&
      !hasUsage &&
      (snapshot.status === "needs-auth" || (snapshot.status ?? "ok") === "ok")
    )
      return [];
    const providerName = providerUsageDisplayName(provider);
    const showAccountName =
      !instance.isDefault || providerInstances.length > 1 || instance.displayName !== providerName;
    const accountName =
      instance.isDefault && instance.displayName === providerName
        ? "Default"
        : instance.displayName;
    return [
      {
        instance,
        snapshot,
        label: showAccountName ? `${providerName} · ${accountName}` : providerName,
      },
    ];
  });
}

export interface EnvironmentProviderUsageSummary {
  readonly rows: ReadonlyArray<ProviderUsageDisplayRow>;
  readonly statusLabel: string;
  readonly ariaLabel: string;
}

function providerUsageStatusLabel(
  snapshot: ServerProviderUsageSnapshot | undefined,
  hasUsageLines: boolean,
): string {
  switch (snapshot?.status) {
    case "needs-auth":
      return "Sign in";
    case "unsupported":
      return "Unsupported";
    case "error":
      return "Unavailable";
    default:
      return hasUsageLines ? "Connected" : "No data";
  }
}

export function resolveEnvironmentProviderUsageSummary(input: {
  readonly providerName: string;
  readonly rows: ReadonlyArray<ProviderUsageDisplayRow>;
  /** Live batch snapshot when available; the row renders without one (local/thread fallbacks). */
  readonly snapshot: ServerProviderUsageSnapshot | undefined;
  readonly hasUsageLines: boolean;
}): EnvironmentProviderUsageSummary {
  const statusLabel = providerUsageStatusLabel(input.snapshot, input.hasUsageLines);
  const rowSummary = input.rows
    .map((row) => `${row.label} ${row.remainingLabel} remaining`)
    .join(", ");

  return {
    rows: input.rows,
    statusLabel,
    ariaLabel: `${input.providerName} usage: ${rowSummary || statusLabel}`,
  };
}
