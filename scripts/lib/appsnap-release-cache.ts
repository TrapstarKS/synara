// FILE: appsnap-release-cache.ts
// Purpose: Restores the existing AppSnap build cache into an isolated release stage.
// Layer: Release/build helper

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface AppSnapReleaseCache {
  readonly cachedOutputPath: string;
  readonly stageOutputPath: string;
}

export function appSnapReleaseCacheKey(
  repoRoot: string,
  arch: string,
  toolchain: ReadonlyArray<string>,
): string {
  const sourceDirectory = join(repoRoot, "apps/desktop/native/appsnap");
  const script = join(repoRoot, "apps/desktop/scripts/build-appsnap-helper.mjs");
  const sources = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith(".swift"))
    .toSorted();
  const hash = createHash("sha256").update("synara-appsnap-release-cache-v1\0");
  hash.update(JSON.stringify([resolve(repoRoot), arch, "release", toolchain]));
  for (const file of [script, ...sources.map((name) => join(sourceDirectory, name))]) {
    hash.update("\0").update(file).update("\0").update(readFileSync(file));
  }
  return hash.digest("hex");
}

function inspectToolchain(): string[] {
  return [
    ["swiftc", "--version"],
    ["--find", "swiftc"],
    ["--show-sdk-path"],
    ["--show-sdk-build-version"],
  ].map((args) => {
    const result = spawnSync("xcrun", args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout.trim())
      throw new Error("Cannot fingerprint the AppSnap compiler toolchain.");
    return result.stdout.trim();
  });
}

export function restoreAppSnapReleaseCache(cache: AppSnapReleaseCache): boolean {
  try {
    if (!existsSync(cache.cachedOutputPath) || !existsSync(`${cache.cachedOutputPath}.build.json`))
      return false;
    mkdirSync(dirname(cache.stageOutputPath), { recursive: true });
    copyFileSync(cache.cachedOutputPath, cache.stageOutputPath);
    copyFileSync(`${cache.cachedOutputPath}.build.json`, `${cache.stageOutputPath}.build.json`);
    return true;
  } catch {
    // The helper still checks source fingerprints and codesign, then rebuilds
    // missing or invalid cache entries in the writable release stage.
    return false;
  }
}

export function prepareAppSnapReleaseCache(
  repoRoot: string,
  stageOutputPath: string,
  arch: string,
  cacheDirectory: string | undefined,
): AppSnapReleaseCache | undefined {
  if (!cacheDirectory?.trim()) return undefined;
  try {
    const key = appSnapReleaseCacheKey(repoRoot, arch, inspectToolchain());
    const cache = {
      cachedOutputPath: join(resolve(cacheDirectory), arch, key, "synara-appsnap-helper"),
      stageOutputPath,
    };
    restoreAppSnapReleaseCache(cache);
    return cache;
  } catch {
    return undefined;
  }
}

export function saveAppSnapReleaseCache(cache: AppSnapReleaseCache): boolean {
  const temporary = `${cache.cachedOutputPath}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(cache.cachedOutputPath), { recursive: true });
    copyFileSync(cache.stageOutputPath, temporary);
    copyFileSync(`${cache.stageOutputPath}.build.json`, `${temporary}.build.json`);
    renameSync(temporary, cache.cachedOutputPath);
    renameSync(`${temporary}.build.json`, `${cache.cachedOutputPath}.build.json`);
    return true;
  } catch {
    return false;
  } finally {
    for (const path of [temporary, `${temporary}.build.json`]) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* A cache write cannot invalidate the staged helper. */
      }
    }
  }
}
