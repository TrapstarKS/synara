// A release may replace only its web assets when its complete runtime fingerprint
// matches the one captured by the running desktop. Missing manifests fail closed.
export const LIVE_UI_MANIFEST_FILENAME = "live-ui-manifest.json";
export const LIVE_UI_MANIFEST_SCHEMA_VERSION = 1;

export interface LiveUiManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly runtimeHash: string;
}

export function parseLiveUiManifest(value: unknown): LiveUiManifest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== LIVE_UI_MANIFEST_SCHEMA_VERSION ||
    typeof record.version !== "string" ||
    record.version.length > 128 ||
    !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(record.version) ||
    typeof record.runtimeHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.runtimeHash)
  )
    return null;
  return { schemaVersion: 1, version: record.version, runtimeHash: record.runtimeHash };
}

export function areLiveUiManifestsCompatible(current: unknown, candidate: unknown): boolean {
  const left = parseLiveUiManifest(current);
  const right = parseLiveUiManifest(candidate);
  return left !== null && right !== null && left.runtimeHash === right.runtimeHash;
}
