// FILE: codexHomePaths.ts
// Purpose: Pure helpers that mirror how codexAppServerManager.ts decides which
//          CODEX_HOME directory the codex app-server child process runs against.
//          Centralizing this lets consumers outside the manager (the local image
//          allowlist, image-path predictions, etc.) stay in sync with the actual
//          runtime so they don't 404 paths Codex legitimately wrote.
// Layer: Server utility (no IO; safe to import from anywhere)
// Exports: overlay constants, base/overlay home resolvers, write-home + allowlist helpers.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { expandProviderAccountHomePath } from "./providerAccountHomePath.ts";

export const SYNARA_CODEX_HOME_OVERLAY_DIR = "codex-home-overlay";
export const SYNARA_CODEX_HOME_ACCOUNT_OVERLAYS_DIR = "accounts";

export interface CodexHomePathsInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
}

export function resolveBaseCodexHomePath(
  env: NodeJS.ProcessEnv,
  explicitHomePath?: string,
): string {
  return expandProviderAccountHomePath(
    explicitHomePath?.trim() || env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"),
  );
}

export function resolveSynaraCodexHomeOverlayPath(
  env: NodeJS.ProcessEnv,
  sourceHomePath: string,
  accountSegment?: string,
): string {
  const overlayHome = path.join(
    synaraCodexOverlayRoot(env, sourceHomePath),
    SYNARA_CODEX_HOME_OVERLAY_DIR,
  );
  return accountSegment
    ? path.join(overlayHome, SYNARA_CODEX_HOME_ACCOUNT_OVERLAYS_DIR, accountSegment)
    : overlayHome;
}

function synaraCodexOverlayRoot(env: NodeJS.ProcessEnv, sourceHomePath: string): string {
  const runtimeHome = env.SYNARA_HOME?.trim();
  return runtimeHome || path.join(path.dirname(sourceHomePath), ".synara", "runtime");
}

const LEGACY_CODEX_PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Overlay used by earlier fork releases for a Synara-managed Codex profile.
 * Those profiles now run as provider instances whose home is
 * `<secrets>/codex-profiles/<uuid>`, so the profile id is derived from the home.
 */
export function resolveLegacyCodexProfileOverlayPath(
  env: NodeJS.ProcessEnv,
  sourceHomePath: string,
): string | undefined {
  const profileId = path.basename(sourceHomePath);
  if (
    path.basename(path.dirname(sourceHomePath)) !== "codex-profiles" ||
    !LEGACY_CODEX_PROFILE_ID_PATTERN.test(profileId)
  ) {
    return undefined;
  }
  return path.join(synaraCodexOverlayRoot(env, sourceHomePath), "codex-home-overlays", profileId);
}

export function resolveCodexHomeOverlayAccountSegment(
  input: Pick<CodexHomePathsInput, "accountId" | "homePath" | "shadowHomePath">,
): string | undefined {
  const accountId = input.accountId?.trim();
  const shadowHomePath = input.shadowHomePath?.trim();
  if ((!accountId || accountId === "default") && !shadowHomePath) {
    return undefined;
  }

  const label = (accountId || "shadow").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 32) || "codex";
  const digest = createHash("sha256")
    .update(accountId ?? "")
    .update("\0")
    .update(input.homePath ?? "")
    .update("\0")
    .update(shadowHomePath ?? "")
    .digest("hex")
    .slice(0, 12);
  return `${label}-${digest}`;
}

/**
 * Returns the home directory that the codex app-server child process actually
 * writes under. Interactive sessions use the user's normal Codex home, or the
 * explicitly selected account home. Legacy overlays remain readable below.
 */
export function resolveActiveCodexHomeWritePath(input: CodexHomePathsInput = {}): string {
  const env = input.env ?? process.env;
  return resolveBaseCodexHomePath(env, input.homePath);
}

/**
 * Returns every Codex home directory we should treat as legitimate when
 * allowlisting locally-generated image files: the source home and the overlay
 * home if they are distinct. Callers pre-`realpath`-resolve these as needed.
 *
 * The overlay candidate remains included so generated images from earlier
 * sessions stay serveable until they are removed.
 */
export function resolveCodexHomeAllowlistCandidates(
  input: CodexHomePathsInput = {},
): readonly string[] {
  const env = input.env ?? process.env;
  const source = resolveBaseCodexHomePath(env, input.homePath);
  const shadow = input.shadowHomePath
    ? resolveBaseCodexHomePath(env, input.shadowHomePath)
    : undefined;
  const accountSegment = resolveCodexHomeOverlayAccountSegment({
    homePath: source,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(shadow ? { shadowHomePath: shadow } : {}),
  });
  const overlay =
    resolveLegacyCodexProfileOverlayPath(env, source) ??
    resolveSynaraCodexHomeOverlayPath(env, source, accountSegment);
  const legacyOverlay = resolveSynaraCodexHomeOverlayPath(env, source);
  const sourceResolved = path.resolve(source);
  const overlayResolved = path.resolve(overlay);
  const candidates = sourceResolved === overlayResolved ? [source] : [source, overlay];
  if (
    path.resolve(legacyOverlay) !== overlayResolved &&
    !candidates.some((candidate) => path.resolve(candidate) === path.resolve(legacyOverlay))
  ) {
    candidates.push(legacyOverlay);
  }
  if (shadow && !candidates.some((candidate) => path.resolve(candidate) === path.resolve(shadow))) {
    candidates.push(shadow);
  }
  return candidates;
}
