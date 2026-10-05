// FILE: continuationIdentity.ts
// Purpose: Identifies provider-native session storage independently from account/runtime options.
// Layer: Server provider utility.

import { homedir } from "node:os";
import path from "node:path";

import type { ProviderKind, ProviderStartOptions } from "@synara/contracts";

import { resolveBaseCodexHomePath } from "../codexHomePaths.ts";
import { resolveCodexPathIdentity } from "../codexPathIdentity.ts";
import type { CodexProcessEnvInput } from "../codexProcessEnv.ts";
import { expandProviderAccountHomePath } from "../providerAccountHomePath.ts";

function canonicalStoragePath(value: string): string {
  return resolveCodexPathIdentity(value);
}

function codexContinuationInput(options: ProviderStartOptions | undefined): Pick<
  CodexProcessEnvInput,
  "homePath" | "shadowHomePath" | "accountId"
> & {
  readonly env: NodeJS.ProcessEnv;
} {
  const codex = options?.codex;
  return {
    env: { ...process.env, ...codex?.environment },
    ...(codex?.homePath ? { homePath: codex.homePath } : {}),
    ...(codex?.shadowHomePath ? { shadowHomePath: codex.shadowHomePath } : {}),
    ...(codex?.accountId ? { accountId: codex.accountId } : {}),
  };
}

const CODEX_SHARED_CONTINUATION_V1_PREFIX = "codex:shared-v1:";
const CODEX_SHARED_CONTINUATION_V2_PREFIX = "codex:shared-v2:";
const CODEX_SHARED_CONTINUATION_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ParsedCodexSharedContinuationIdentity =
  | { readonly version: 1; readonly sourceIdentity: string }
  | { readonly version: 2; readonly generation: string; readonly sourceIdentity: string };

export function parseCodexSharedContinuationIdentity(
  value: string | undefined,
): ParsedCodexSharedContinuationIdentity | undefined {
  if (!value) return undefined;
  if (value.startsWith(CODEX_SHARED_CONTINUATION_V1_PREFIX)) {
    const sourceIdentity = value.slice(CODEX_SHARED_CONTINUATION_V1_PREFIX.length);
    return sourceIdentity ? { version: 1, sourceIdentity } : undefined;
  }
  if (!value.startsWith(CODEX_SHARED_CONTINUATION_V2_PREFIX)) return undefined;
  const generationStart = CODEX_SHARED_CONTINUATION_V2_PREFIX.length;
  const generationEnd = value.indexOf(":", generationStart);
  if (generationEnd < 0) return undefined;
  const generation = value.slice(generationStart, generationEnd);
  const sourceIdentity = value.slice(generationEnd + 1);
  if (!CODEX_SHARED_CONTINUATION_GENERATION_PATTERN.test(generation) || !sourceIdentity) {
    return undefined;
  }
  return { version: 2, generation: generation.toLowerCase(), sourceIdentity };
}

export function codexSharedContinuationGeneration(
  identity: string | undefined,
): string | undefined {
  const parsed = parseCodexSharedContinuationIdentity(identity);
  return parsed?.version === 2 ? parsed.generation : undefined;
}

export function codexSharedContinuationIdentityIsSafeMigration(input: {
  readonly persistedIdentity: string;
  readonly currentIdentity: string | undefined;
}): boolean {
  const persisted = parseCodexSharedContinuationIdentity(input.persistedIdentity);
  const current = parseCodexSharedContinuationIdentity(input.currentIdentity);
  return (
    persisted?.version === 1 &&
    current?.version === 2 &&
    persisted.sourceIdentity === current.sourceIdentity
  );
}

// Codex sessions use the native home directly, so there is no overlay to
// materialize before evaluating a persisted resume cursor.
export async function prepareProviderContinuationIdentity(
  provider: ProviderKind,
  options: ProviderStartOptions | undefined,
  _persistedIdentity: string | undefined,
): Promise<string | undefined> {
  return providerContinuationIdentity(provider, options);
}

export async function prepareProviderContinuationIdentityForExplicitResume(
  provider: ProviderKind,
  options: ProviderStartOptions | undefined,
): Promise<string | undefined> {
  return providerContinuationIdentity(provider, options);
}

/**
 * Returns the identity of the storage that owns a provider-native resume
 * cursor. Account auth, binary paths, and turn settings deliberately do not
 * participate: Codex threads resume only from the native home that owns them.
 */
export function providerContinuationIdentity(
  provider: ProviderKind,
  options: ProviderStartOptions | undefined,
): string | undefined {
  switch (provider) {
    case "codex": {
      const continuationInput = codexContinuationInput(options);
      return `codex:native-v1:${canonicalStoragePath(
        resolveBaseCodexHomePath(
          continuationInput.env,
          continuationInput.shadowHomePath ?? continuationInput.homePath,
        ),
      )}`;
    }
    case "claudeAgent": {
      const claude = options?.claudeAgent;
      const env = { ...process.env, ...claude?.environment };
      const fallbackHome = homedir();
      const explicitHome = claude?.homePath?.trim();
      // An explicit home deliberately drops an inherited CLAUDE_CONFIG_DIR;
      // without one, the final merged environment remains authoritative.
      const configuredRoot = explicitHome
        ? claude?.environment?.CLAUDE_CONFIG_DIR?.trim()
        : env.CLAUDE_CONFIG_DIR?.trim();
      const effectiveHome = explicitHome
        ? expandProviderAccountHomePath(explicitHome, fallbackHome)
        : env.HOME?.trim() || fallbackHome;
      const storageRoot = configuredRoot
        ? expandProviderAccountHomePath(configuredRoot, effectiveHome)
        : path.join(effectiveHome, ".claude");
      return `claudeAgent:${canonicalStoragePath(storageRoot)}`;
    }
    default:
      return undefined;
  }
}
