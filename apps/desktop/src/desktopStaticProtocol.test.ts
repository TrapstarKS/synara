import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDesktopStaticProtocolResolver,
  createDesktopStaticProtocolSelector,
} from "./desktopStaticProtocol";

const staticRoot = Path.resolve("/virtual/synara-static");
const rootIndex = Path.join(staticRoot, "index.html");

function resolverWithExistingPaths(paths: ReadonlyArray<string>) {
  const existingPaths = new Set(paths.map((entry) => Path.resolve(entry)));
  return createDesktopStaticProtocolResolver(staticRoot, (candidate) =>
    existingPaths.has(Path.resolve(candidate)),
  );
}

describe("createDesktopStaticProtocolResolver", () => {
  it("resolves an existing asset inside the static root", () => {
    const assetPath = Path.join(staticRoot, "assets", "app.js");
    const resolveRequest = resolverWithExistingPaths([rootIndex, assetPath]);

    expect(resolveRequest("synara://app/assets/app.js")).toEqual({ path: assetPath });
  });

  it("returns Electron file-not-found for a missing asset", () => {
    const resolveRequest = resolverWithExistingPaths([rootIndex]);

    expect(resolveRequest("synara://app/assets/missing.js")).toEqual({ error: -6 });
  });

  it("resolves an extensionless route to its existing nested index", () => {
    const nestedIndex = Path.join(staticRoot, "settings", "index.html");
    const resolveRequest = resolverWithExistingPaths([rootIndex, nestedIndex]);

    expect(resolveRequest("synara://app/settings")).toEqual({ path: nestedIndex });
  });

  it("falls back to the root index for a missing navigation route", () => {
    const resolveRequest = resolverWithExistingPaths([rootIndex]);

    expect(resolveRequest("synara://app/thread/missing")).toEqual({ path: rootIndex });
  });

  it("keeps encoded traversal inside the root and safely handles malformed encoding", () => {
    const observedPaths: string[] = [];
    const resolveRequest = createDesktopStaticProtocolResolver(staticRoot, (candidate) => {
      const resolvedCandidate = Path.resolve(candidate);
      observedPaths.push(resolvedCandidate);
      return resolvedCandidate === rootIndex;
    });

    expect(resolveRequest("synara://app/..%2Foutside.js")).toEqual({ error: -6 });
    expect(resolveRequest("synara://app/%E0%A4%A")).toEqual({ path: rootIndex });
    expect(
      observedPaths.every(
        (candidate) => candidate === staticRoot || candidate.startsWith(`${staticRoot}${Path.sep}`),
      ),
    ).toBe(true);
  });
});

it("switches shell HTML while retaining previous hashed chunks and the backend root", () => {
  const newerRoot = Path.resolve("/virtual/synara-next");
  const newestRoot = Path.resolve("/virtual/synara-newest");
  const paths = new Set([
    rootIndex,
    Path.join(staticRoot, "assets", "old-123.js"),
    Path.join(newerRoot, "index.html"),
    Path.join(newerRoot, "assets", "new-456.js"),
    Path.join(newestRoot, "index.html"),
  ]);
  const selector = createDesktopStaticProtocolSelector(staticRoot, (file) => paths.has(file));
  const backend = createDesktopStaticProtocolResolver(staticRoot, (file) => paths.has(file));
  selector.select(newerRoot, null);
  expect(selector.resolve("synara://app/thread/one")).toEqual({
    path: Path.join(newerRoot, "index.html"),
  });
  expect(selector.resolve("synara://app/assets/old-123.js")).toEqual({
    path: Path.join(staticRoot, "assets", "old-123.js"),
  });
  expect(backend("synara://app/thread/one")).toEqual({ path: rootIndex });
  selector.select(newestRoot, newerRoot);
  expect(selector.resolve("synara://app/assets/new-456.js")).toEqual({
    path: Path.join(newerRoot, "assets", "new-456.js"),
  });
  expect(selector.resolve("synara://app/assets/missing.js")).toEqual({ error: -6 });
  selector.select(null, null);
  expect(selector.resolve("synara://app/thread/one")).toEqual({ path: rootIndex });
});
