// Reconcile user MCP edits in CODEX_HOME with the source config. The overlay is
// durable, profile-scoped storage; it must not be treated as a disposable copy.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";

export const CODEX_MCP_CONFIG_STATE_FILE = "synara-mcp-config-state-v1.json";

interface McpConfigState {
  readonly version: 1;
  /** Fingerprints only: do not duplicate MCP credentials in the bookkeeping. */
  readonly applied: Readonly<Record<string, string>>;
  /** Includes deleted names so a subsequent source refresh cannot revive them. */
  readonly owned: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readState(text: string | undefined): McpConfigState | undefined {
  if (text === undefined) return undefined;
  const state: unknown = JSON.parse(text);
  if (
    !isRecord(state) ||
    state.version !== 1 ||
    !isRecord(state.applied) ||
    !Object.values(state.applied).every((value) => typeof value === "string") ||
    !Array.isArray(state.owned) ||
    !state.owned.every((value) => typeof value === "string")
  ) {
    throw new Error("Invalid persisted Codex MCP configuration state; refusing to overwrite it.");
  }
  return state as unknown as McpConfigState;
}

function readServers(config: TomlTable): TomlTable {
  const servers = config.mcp_servers;
  if (servers === undefined) return {};
  if (!isRecord(servers)) throw new Error("Codex mcp_servers must be a TOML table.");
  return servers as TomlTable;
}

/**
 * Canonical, JSON-serializable view of one TOML value. Plain tables become
 * key-sorted records and bigint integers become strings so a fingerprint
 * survives JSON.stringify regardless of the value's runtime type.
 */
function canonicalValue(value: TomlValue): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value instanceof Date) return value.toISOString();
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key] as TomlValue)]),
    );
  }
  return typeof value === "bigint" ? value.toString() : value;
}

function fingerprint(value: TomlValue | undefined): string | undefined {
  return value === undefined
    ? undefined
    : createHash("sha256")
        .update(JSON.stringify(canonicalValue(value)) ?? "undefined")
        .digest("hex");
}

export function reconcileCodexMcpConfig(input: {
  readonly sourceConfig: string;
  readonly overlayConfig?: string;
  readonly stateText?: string;
  readonly managedServerNames: readonly string[];
}): { readonly config: string; readonly stateText: string } {
  const state = readState(input.stateText);
  if (state && input.overlayConfig === undefined) {
    throw new Error("Persisted Codex MCP config.toml is missing; refusing to discard MCP edits.");
  }
  const source = parse(input.sourceConfig, { integersAsBigInt: true });
  const sourceServers = readServers(source);
  const overlayServers = readServers(parse(input.overlayConfig ?? "", { integersAsBigInt: true }));
  const owned = new Set(state?.owned ?? []);
  const merged: TomlTable = { ...sourceServers };
  const managed = new Set(input.managedServerNames);
  const names = new Set([
    ...Object.keys(sourceServers),
    ...Object.keys(overlayServers),
    ...Object.keys(state?.applied ?? {}),
    ...owned,
  ]);

  for (const name of names) {
    if (managed.has(name)) {
      owned.delete(name);
      delete merged[name];
      continue;
    }
    const overlayValue = Object.hasOwn(overlayServers, name) ? overlayServers[name] : undefined;
    const sourceValue = Object.hasOwn(sourceServers, name) ? sourceServers[name] : undefined;
    if (state) {
      const previous = Object.hasOwn(state.applied, name) ? state.applied[name] : undefined;
      if (fingerprint(overlayValue) !== previous) owned.add(name);
    } else if (overlayValue !== undefined && !isDeepStrictEqual(overlayValue, sourceValue)) {
      // Upgrade existing overlays without requiring the user to recreate MCPs.
      owned.add(name);
    }
    if (owned.has(name)) {
      // Replace the entire server, not its fields: switching transport or
      // removing credentials must not retain stale source keys.
      if (overlayValue === undefined) delete merged[name];
      else
        Object.defineProperty(merged, name, {
          value: overlayValue,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
  }

  const applied = Object.fromEntries(
    Object.entries(merged)
      .filter(([name]) => !managed.has(name))
      .map(([name, value]) => [name, fingerprint(value)!]),
  );
  const nextState: McpConfigState = { version: 1, applied, owned: [...owned].sort() };
  if (isDeepStrictEqual(merged, sourceServers)) {
    return { config: input.sourceConfig, stateText: `${JSON.stringify(nextState)}\n` };
  }
  source.mcp_servers = merged;
  return {
    config: stringify(source, { numbersAsFloat: true }),
    stateText: `${JSON.stringify(nextState)}\n`,
  };
}
