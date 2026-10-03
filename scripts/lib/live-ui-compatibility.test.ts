import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_UI_MANIFEST_FILENAME,
  areLiveUiManifestsCompatible,
  parseLiveUiManifest,
} from "@synara/contracts";
import {
  LIVE_UI_RUNTIME_STAMP_FILENAME,
  assertLiveUiBuildManifest,
  assertLiveUiReleaseBuildOutputs,
  assertLiveUiRuntimeBuildStamp,
  createLiveUiBuildTracker,
  createLiveUiManifest,
  hashLiveUiCompatibilityInputs as hash,
  isLiveUiRuntimeInput,
} from "./live-ui-compatibility";

const runtime = { path: "apps/server/src/handler.ts", contents: "return 1;" };

describe("live UI runtime compatibility", () => {
  it("allows renderer changes while rejecting backend, preload and shared behavior changes", () => {
    const baseline = hash([runtime]);
    expect(hash([runtime, { path: "apps/web/src/Chat.tsx", contents: "new UI" }])).toBe(baseline);
    for (const path of [
      "apps/server/src/handler.ts",
      "apps/desktop/src/preload.ts",
      "packages/contracts/src/ws.ts",
      "packages/shared/src/helper.ts",
      "patches/runtime.patch",
      "scripts/build-desktop-artifact.ts",
    ]) {
      expect(
        hash(
          [runtime, { path, contents: "changed" }].filter(
            (item) => item !== runtime || path !== runtime.path,
          ),
        ),
      ).not.toBe(baseline);
    }
  });

  it("ignores only release versions, retaining dependency versions and integrity", () => {
    const inputs = (version: string, dependency: string) => [
      runtime,
      {
        path: "apps/desktop/package.json",
        contents: JSON.stringify({ version, dependencies: { electron: dependency } }),
      },
      {
        path: "bun.lock",
        contents: `{"workspaces":{"apps/desktop":{"version":"${version}",},},"packages":{"dep":["dep@${dependency}","sha512-integrity",],},}`,
      },
    ];
    expect(hash(inputs("0.9.27", "43.4.1"))).toBe(hash(inputs("0.9.28", "43.4.1")));
    expect(hash(inputs("0.9.27", "43.4.1"))).not.toBe(hash(inputs("0.9.28", "43.4.2")));
  });

  it("retains strings which resemble trailing commas inside the lockfile", () => {
    const first = { path: "bun.lock", contents: '{"workspaces":{},"value":"https://example/,}",}' };
    const second = { ...first, contents: '{"workspaces":{},"value":"https://example/}"}' };
    expect(hash([runtime, first])).not.toBe(hash([runtime, second]));
  });

  it("normalizes checkout CRLF without changing binary inputs", () => {
    expect(hash([{ ...runtime, contents: "a\r\nb\r\n" }])).toBe(
      hash([{ ...runtime, contents: "a\nb\n" }]),
    );
    expect(hash([{ ...runtime, contents: Buffer.from([0, 13, 10]) }])).not.toBe(
      hash([{ ...runtime, contents: Buffer.from([0, 10]) }]),
    );
  });

  it("rejects persisted storage schema/normalizer changes while allowing presentation and transport fixes", () => {
    for (const path of [
      "composerDraftDomain.ts",
      "composerDraftPersistence.ts",
      "composerDraftStore.ts",
      "composerDraftAttachments.ts",
      "appSettings.ts",
      "storeState.ts",
      "storePersistence.ts",
      "splitViewStore.ts",
      "splitView.logic.ts",
      "lib/indexedDb.ts",
      "lib/composerImageBlobStore.ts",
      "lib/fileComments.ts",
      "lib/assistantSelections.ts",
    ]) {
      const before = { path: `apps/web/src/${path}`, contents: "const version = 1;" };
      expect(hash([runtime, before])).not.toBe(
        hash([runtime, { ...before, contents: "const version = 2;" }]),
      );
    }
    for (const path of ["components/PurePanel.tsx", "index.css", "wsTransport.ts"]) {
      expect(hash([runtime, { path: `apps/web/src/${path}`, contents: "old" }])).toBe(
        hash([runtime, { path: `apps/web/src/${path}`, contents: "new" }]),
      );
    }
  });

  it("detects a new storage writer even when its filename is unrelated to storage", () => {
    const before = {
      path: "apps/web/src/lib/unrelated.ts",
      contents: 'localStorage.setItem("draft", "v1")',
    };
    expect(hash([runtime, before])).not.toBe(
      hash([runtime, { ...before, contents: 'localStorage.setItem("draft", "v2")' }]),
    );
    expect(hash([runtime, before])).not.toBe(hash([runtime]));
  });

  it("is deterministic across inventory ordering and detects additions/deletions", () => {
    const extra = { path: "apps/desktop/src/extra.ts", contents: "export {};" };
    expect(hash([runtime, extra])).toBe(hash([extra, runtime]));
    expect(hash([runtime, extra])).not.toBe(hash([runtime]));
    expect(() => hash([runtime, runtime])).toThrow(/Duplicate/);
  });

  it("excludes operator instructions and tests without excluding runtime code", () => {
    for (const path of [
      "AGENTS.md",
      "apps/server/CLAUDE.md",
      "apps/server/src/x.test.ts",
      "apps/web/src/x.ts",
    ])
      expect(isLiveUiRuntimeInput(path)).toBe(false);
    expect(isLiveUiRuntimeInput("apps/desktop/patches/cua-driver/0001.patch")).toBe(true);
  });

  it("fails closed on absent, malformed or future manifests", () => {
    const good = { schemaVersion: 1, version: "0.9.27", runtimeHash: hash([runtime]) };
    expect(parseLiveUiManifest(good)).toEqual(good);
    expect(areLiveUiManifestsCompatible(good, { ...good, version: "0.9.28" })).toBe(true);
    for (const bad of [
      null,
      {},
      { ...good, schemaVersion: 2 },
      { ...good, runtimeHash: "bad" },
      { ...good, runtimeHash: "0".repeat(64) },
      { ...good, version: "../x" },
    ]) {
      expect(areLiveUiManifestsCompatible(good, bad)).toBe(false);
    }
  });
});

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function buildFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "synara-live-ui-build-"));
  fixtures.push(repoRoot);
  execFileSync("git", ["init", "-q", repoRoot]);
  function put(path: string, contents: string) {
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
    writeFileSync(join(repoRoot, path), contents);
  }
  put(".gitignore", "dist/\ndist-electron/\n");
  put("bun.lock", '{"workspaces":{},}');
  put("apps/desktop/src/preload.ts", "export {};\n");
  put("apps/server/src/wsCompatibility.ts", "export {};\n");
  const outputDir = join(repoRoot, "apps/desktop/dist-electron");
  const tracker = createLiveUiBuildTracker({
    repoRoot,
    version: "0.9.28",
    outputDir,
    parts: ["main", "preload"],
  });
  const writeOutputs = () => {
    put("apps/desktop/dist-electron/main.js", "main()");
    put("apps/desktop/dist-electron/preload.js", "preload()");
  };
  return { repoRoot, outputDir, tracker, put, writeOutputs };
}

describe("build provenance gates", () => {
  it("stamps only after every runtime config succeeds and binds the output bytes", () => {
    const f = buildFixture();
    f.tracker.begin("main");
    f.tracker.begin("preload");
    f.writeOutputs();
    f.tracker.complete("main");
    expect(existsSync(join(f.outputDir, LIVE_UI_RUNTIME_STAMP_FILENAME))).toBe(false);
    f.tracker.complete("preload");
    const manifest = createLiveUiManifest(f.repoRoot, "0.9.28");
    expect(() => assertLiveUiRuntimeBuildStamp(f.outputDir, manifest)).not.toThrow();
    f.put("apps/desktop/dist-electron/preload.js", "old preload()");
    expect(() => assertLiveUiRuntimeBuildStamp(f.outputDir, manifest)).toThrow(/output hashes/);
  });

  it("rejects runtime sources changed during compilation", () => {
    const f = buildFixture();
    f.tracker.begin("main");
    f.writeOutputs();
    f.put("apps/desktop/src/preload.ts", "changed()");
    expect(() => f.tracker.complete("main")).toThrow(/changed during compilation/);
    expect(existsSync(join(f.outputDir, LIVE_UI_RUNTIME_STAMP_FILENAME))).toBe(false);
  });

  it("does not bless a stale second config after one part is rebuilt", () => {
    const f = buildFixture();
    f.tracker.begin("main");
    f.tracker.begin("preload");
    f.writeOutputs();
    f.tracker.complete("main");
    f.tracker.complete("preload");
    f.put("apps/desktop/src/preload.ts", "changed()");
    f.tracker.begin("main");
    f.tracker.complete("main");
    expect(existsSync(join(f.outputDir, LIVE_UI_RUNTIME_STAMP_FILENAME))).toBe(false);
  });

  it("rejects missing/stale web manifests without rewriting them at packaging", () => {
    const f = buildFixture();
    f.writeOutputs();
    const manifest = createLiveUiManifest(f.repoRoot, "0.9.28");
    expect(() => assertLiveUiBuildManifest(f.outputDir, manifest)).toThrow(/Missing/);
    const contents = JSON.stringify({ ...manifest, runtimeHash: "e".repeat(64) });
    writeFileSync(join(f.outputDir, LIVE_UI_MANIFEST_FILENAME), contents);
    expect(() => assertLiveUiBuildManifest(f.outputDir, manifest)).toThrow(/does not match/);
    expect(readFileSync(join(f.outputDir, LIVE_UI_MANIFEST_FILENAME), "utf8")).toBe(contents);
    writeFileSync(join(f.outputDir, LIVE_UI_MANIFEST_FILENAME), JSON.stringify(manifest));
    expect(() => assertLiveUiBuildManifest(f.outputDir, manifest)).not.toThrow();
  });

  it("requires all three build records, including the server output identity", () => {
    const f = buildFixture();
    f.tracker.begin("main");
    f.tracker.begin("preload");
    f.writeOutputs();
    f.tracker.complete("main");
    f.tracker.complete("preload");
    const expected = createLiveUiManifest(f.repoRoot, "0.9.28");
    f.put(`apps/server/dist/client/${LIVE_UI_MANIFEST_FILENAME}`, JSON.stringify(expected));
    expect(() => assertLiveUiReleaseBuildOutputs(f.repoRoot, expected)).toThrow();
    const server = createLiveUiBuildTracker({
      repoRoot: f.repoRoot,
      version: "0.9.28",
      outputDir: join(f.repoRoot, "apps/server/dist"),
      parts: ["server"],
    });
    server.begin("server");
    f.put("apps/server/dist/index.mjs", "server()");
    server.complete("server");
    expect(() => assertLiveUiReleaseBuildOutputs(f.repoRoot, expected)).not.toThrow();
  });

  it("detects new runtime source files but ignores generated outputs and renderer changes", () => {
    const f = buildFixture();
    const initial = createLiveUiManifest(f.repoRoot, "0.9.28");
    f.writeOutputs();
    f.put("apps/web/src/Chat.tsx", "new renderer()");
    expect(createLiveUiManifest(f.repoRoot, "0.9.28")).toEqual(initial);
    f.put("apps/server/src/new.ts", "new behavior()");
    expect(createLiveUiManifest(f.repoRoot, "0.9.28").runtimeHash).not.toBe(initial.runtimeHash);
  });
});
