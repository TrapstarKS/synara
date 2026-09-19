import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appSnapReleaseCacheKey,
  prepareAppSnapReleaseCache,
  restoreAppSnapReleaseCache,
  saveAppSnapReleaseCache,
  type AppSnapReleaseCache,
} from "./appsnap-release-cache.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synara-appsnap-cache-test-"));
  roots.push(root);
  const script = join(root, "apps/desktop/scripts/build-appsnap-helper.mjs");
  const source = join(root, "apps/desktop/native/appsnap/main.swift");
  for (const file of [script, source]) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(script, "build helper");
  writeFileSync(source, "Swift source");
  const cache: AppSnapReleaseCache = {
    cachedOutputPath: join(root, "cache", "helper"),
    stageOutputPath: join(root, "stage", "helper"),
  };
  return { root, script, source, cache };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AppSnap release cache", () => {
  it("invalidates for source, build script, architecture, Swift and SDK changes", () => {
    const { root, script, source } = fixture();
    const key = () =>
      appSnapReleaseCacheKey(root, "arm64", ["Swift 6", "/swiftc", "/sdk", "sdk-build"]);
    const original = key();
    expect(key()).toBe(original);
    expect(
      appSnapReleaseCacheKey(root, "x64", ["Swift 6", "/swiftc", "/sdk", "sdk-build"]),
    ).not.toBe(original);
    expect(
      appSnapReleaseCacheKey(root, "arm64", ["Swift 7", "/swiftc", "/sdk", "sdk-build"]),
    ).not.toBe(original);
    expect(
      appSnapReleaseCacheKey(root, "arm64", ["Swift 6", "/swiftc", "/sdk", "new-sdk-build"]),
    ).not.toBe(original);
    writeFileSync(source, "updated Swift source");
    expect(key()).not.toBe(original);
    writeFileSync(source, "Swift source");
    writeFileSync(script, "updated compiler flags");
    expect(key()).not.toBe(original);
  });

  it("copies the existing helper metadata and isolates subsequent release signing from the cached binary", () => {
    const { cache } = fixture();
    mkdirSync(dirname(cache.stageOutputPath));
    writeFileSync(cache.stageOutputPath, "ad-hoc helper");
    chmodSync(cache.stageOutputPath, 0o755);
    writeFileSync(`${cache.stageOutputPath}.build.json`, '{"fingerprint":"source"}\n');
    expect(saveAppSnapReleaseCache(cache)).toBe(true);
    rmSync(dirname(cache.stageOutputPath), { recursive: true });
    expect(restoreAppSnapReleaseCache(cache)).toBe(true);
    expect(readFileSync(cache.stageOutputPath, "utf8")).toBe("ad-hoc helper");
    expect(readFileSync(`${cache.stageOutputPath}.build.json`, "utf8")).toBe(
      '{"fingerprint":"source"}\n',
    );
    writeFileSync(cache.stageOutputPath, "release signed helper");
    expect(readFileSync(cache.cachedOutputPath, "utf8")).toBe("ad-hoc helper");
    expect(readdirSync(dirname(cache.cachedOutputPath)).toSorted()).toEqual([
      "helper",
      "helper.build.json",
    ]);
  });

  it("ignores missing or incomplete cache pairs", () => {
    const { cache } = fixture();
    expect(restoreAppSnapReleaseCache(cache)).toBe(false);
    mkdirSync(dirname(cache.cachedOutputPath));
    writeFileSync(cache.cachedOutputPath, "incomplete helper");
    expect(restoreAppSnapReleaseCache(cache)).toBe(false);
    expect(existsSync(cache.stageOutputPath)).toBe(false);
  });

  it("keeps a usable stage when the configured cache cannot be written", () => {
    const { root, cache } = fixture();
    mkdirSync(dirname(cache.stageOutputPath));
    writeFileSync(cache.stageOutputPath, "valid helper");
    writeFileSync(`${cache.stageOutputPath}.build.json`, '{"fingerprint":"source"}');
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory");
    expect(saveAppSnapReleaseCache({ ...cache, cachedOutputPath: join(blocked, "helper") })).toBe(
      false,
    );
    expect(readFileSync(cache.stageOutputPath, "utf8")).toBe("valid helper");
  });

  it("does no toolchain or filesystem work when no cache was requested", () => {
    expect(prepareAppSnapReleaseCache("/missing", "/missing", "arm64", undefined)).toBeUndefined();
    expect(prepareAppSnapReleaseCache("/missing", "/missing", "arm64", "  ")).toBeUndefined();
  });
});
