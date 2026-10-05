// Provider transitions are durable conversation metadata, outside the work-log
// cap. `provider.handoff` / `provider.handoff.failed` are the current
// same-thread handoff rows; `requested` / `completed` are legacy fork rows that
// persisted threads may still contain.
const PROVIDER_HANDOFF_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "provider.handoff",
  "provider.handoff.requested",
  "provider.handoff.completed",
  "provider.handoff.failed",
]);

export function isProviderHandoffActivity(activity: { readonly kind: string }): boolean {
  return PROVIDER_HANDOFF_ACTIVITY_KINDS.has(activity.kind);
}

export function retainProviderHandoffHistory<T extends { readonly kind: string }>(
  activities: readonly T[],
  maxActivities: number,
): readonly T[] {
  if (activities.length <= maxActivities) return activities;
  const tailStart = activities.length - maxActivities;
  return activities.filter(
    (activity, index) => index >= tailStart || isProviderHandoffActivity(activity),
  );
}
