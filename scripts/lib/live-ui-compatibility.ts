// FILE: live-ui-compatibility.ts
// Purpose: Fingerprint all non-renderer release inputs; emit this with web outputs.
// This intentionally rejects some compatible updates instead of guessing whether
// changed backend/preload behavior is safe for an older in-memory runtime.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Release scripts run directly in Node, where the contracts barrel's extensionless
// imports are not resolved. This leaf has no runtime dependencies.
import {
  LIVE_UI_MANIFEST_FILENAME,
  type LiveUiManifest,
  parseLiveUiManifest,
} from "../../packages/contracts/src/liveUiUpdate.ts";
import { releasePackageFiles } from "../update-release-package-versions.ts";

export interface LiveUiCompatibilityInput {
  readonly path: string;
  readonly contents: string | Uint8Array;
}

const releaseManifests = new Set<string>(releasePackageFiles);
const releaseWorkspaces = new Set(releasePackageFiles.map((file) => file.slice(0, -13)));
export const LIVE_UI_RUNTIME_STAMP_FILENAME = "live-ui-build-stamp.json";

// Hash every tracked/new non-ignored file in these runtime/build trees. Keeping
// build scripts, native patches, package manifests and the entire dependency lock
// covers behavior changes which a protocol-only hash would miss.
const runtimeTrees = [
  "apps/server/",
  "apps/desktop/",
  "packages/contracts/",
  "packages/shared/",
  "scripts/",
  "patches/",
  "extensions/",
];
const rootInputs = new Set([
  "package.json",
  "bun.lock",
  ".mise.toml",
  "tsconfig.base.json",
  "turbo.json",
  "turbo.jsonc",
  ".github/workflows/release.yml",
  "apps/web/package.json",
]);

// A failed renderer can already have hydrated/migrated storage before rollback.
// Its storage schemas, serializers and normalizers must match the previous UI,
// even when the backend/preload has not changed. Presentation-only code remains
// eligible, while storage owners (including future direct storage callers) do not.
const webStorageContracts = new Set([
  "appSettings.ts",
  "types.ts",
  "editorPreferences.ts",
  "editorViewState.ts",
  "storageOriginMigration.ts",
  "persistedRecord.ts",
  "pendingUserInputRecovery.ts",
  "computerControlMode.ts",
  "splitView.logic.ts",
  "diffRouteSearch.ts",
  "rightDockStore.logic.ts",
  "providerOrdering.ts",
  "sidebarNavOrdering.ts",
  "cursorModelVariants.ts",
  "providerModelOptions.ts",
  "components/BranchToolbar.logic.ts",
  "lib/storage.ts",
  "lib/indexedDb.ts",
  "lib/composerImageBlobStore.ts",
  "lib/composerImageSource.ts",
  "lib/composerPastedText.ts",
  "lib/assistantSelections.ts",
  "lib/browserAnnotations.ts",
  "lib/fileComments.ts",
  "lib/pullRequestContext.ts",
  "lib/terminalContext.ts",
  "lib/appSnapIconStore.ts",
  "lib/codexReasoningEffort.ts",
  "lib/appDensity.ts",
  "lib/chatWidth.ts",
  "lib/desktopInterfaceUpdate.ts",
  "hooks/useLocalStorage.ts",
]);
const storageIo =
  /\b(?:localStorage|sessionStorage|indexedDB|IDBDatabase|useLocalStorage|getLocalStorageItem|setLocalStorageItem|removeLocalStorageItem|createDeferredPersistStorage|createJSONStorage)\b|["']zustand\/middleware["']/;

function isWebSource(file: string): boolean {
  return (
    file.startsWith("apps/web/src/") &&
    /\.[cm]?[jt]sx?$/.test(file) &&
    !/\.(test|spec|browser)\.[cm]?[jt]sx?$/.test(file) &&
    !file.startsWith("apps/web/src/test/") &&
    !file.includes("TestFixtures")
  );
}

export function isLiveUiRuntimeInput(file: string, contents?: string | Uint8Array): boolean {
  if (
    /(^|\/)(AGENTS|CLAUDE)\.md$/.test(file) ||
    /\.(test|spec|browser)\.[cm]?[jt]sx?$/.test(file)
  ) {
    return false;
  }
  if (rootInputs.has(file) || runtimeTrees.some((prefix) => file.startsWith(prefix))) return true;
  if (!isWebSource(file)) return false;
  const relative = file.slice("apps/web/src/".length);
  if (
    webStorageContracts.has(relative) ||
    /(?:^|\/)[^/]*Store(?:\.logic)?\.ts$/.test(relative) ||
    /^(?:composerDraft[A-Z][^/]*|store(?:State|Persistence|Normalization|Projection|EventReducer)?)\.ts$/.test(
      relative,
    )
  )
    return true;
  const text =
    typeof contents === "string"
      ? contents
      : contents
        ? Buffer.from(contents).toString("utf8")
        : "";
  return storageIo.test(text);
}

function normalizeInput(file: string, contents: string | Uint8Array): Uint8Array | string {
  const buffer =
    typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
  if (releaseManifests.has(file)) {
    const manifest = JSON.parse(buffer.toString("utf8")) as Record<string, unknown>;
    delete manifest.version;
    return JSON.stringify(manifest);
  }
  if (file === "bun.lock") {
    // Bun's text lock permits trailing commas. Preserve quoted strings (including
    // URLs and comma/bracket sequences) while removing only syntactic commas.
    const json = buffer
      .toString("utf8")
      .replace(
        /("(?:\\.|[^"\\])*")|,(?=\s*[}\]])/g,
        (_match, quoted: string | undefined) => quoted ?? "",
      );
    const lock = JSON.parse(json) as { workspaces?: Record<string, Record<string, unknown>> };
    if (!lock.workspaces || typeof lock.workspaces !== "object") {
      throw new Error("Live UI compatibility requires a Bun lockfile with workspace metadata.");
    }
    for (const workspace of releaseWorkspaces) {
      if (lock.workspaces[workspace]) delete lock.workspaces[workspace].version;
    }
    return JSON.stringify(lock);
  }
  // Release JS can be built on Linux and packaged on Windows/macOS. Normalize
  // checkout CRLF only for round-tripping UTF-8 text; never rewrite binary input.
  if (!buffer.includes(0)) {
    const text = buffer.toString("utf8");
    if (Buffer.from(text, "utf8").equals(buffer)) return text.replaceAll("\r\n", "\n");
  }
  return buffer;
}

export function hashLiveUiCompatibilityInputs(inputs: readonly LiveUiCompatibilityInput[]): string {
  const hash = createHash("sha256").update("synara-live-ui-runtime-v1\0");
  const paths = new Set<string>();
  for (const input of inputs
    .filter((entry) => isLiveUiRuntimeInput(entry.path, entry.contents))
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
    if (paths.has(input.path)) throw new Error(`Duplicate runtime input: ${input.path}`);
    paths.add(input.path);
    const normalized = normalizeInput(input.path, input.contents);
    const bytes =
      typeof normalized === "string" ? Buffer.from(normalized, "utf8") : Buffer.from(normalized);
    hash
      .update(`${Buffer.byteLength(input.path)}:${input.path}:${bytes.byteLength}:`)
      .update(bytes);
  }
  if (paths.size === 0) throw new Error("Live UI compatibility has no runtime inputs.");
  return hash.digest("hex");
}

export function createLiveUiManifest(repoRoot: string, version: string): LiveUiManifest {
  // Git's inventory avoids including a platform's generated binaries, caches or
  // node_modules. --others includes new source files before they are committed.
  const inventory = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const files = [
    ...new Set(
      inventory.split("\0").filter((file) => isLiveUiRuntimeInput(file) || isWebSource(file)),
    ),
  ];
  for (const required of [
    "bun.lock",
    "apps/desktop/src/preload.ts",
    "apps/server/src/wsCompatibility.ts",
  ]) {
    if (!files.includes(required))
      throw new Error(`Missing runtime fingerprint input: ${required}`);
  }
  const runtimeHash = hashLiveUiCompatibilityInputs(
    files.map((file) => {
      const absolute = join(repoRoot, file);
      if (!lstatSync(absolute).isFile())
        throw new Error(`Runtime fingerprint input is not a regular file: ${file}`);
      return { path: file, contents: readFileSync(absolute) };
    }),
  );
  const manifest = parseLiveUiManifest({ schemaVersion: 1, version, runtimeHash });
  if (!manifest) throw new Error("Invalid live UI build version.");
  return manifest;
}

/** Never relabel stale web outputs with a fresh fingerprint during packaging. */
export function assertLiveUiBuildManifest(clientDir: string, expected: LiveUiManifest): void {
  let actual: LiveUiManifest | null;
  try {
    actual = parseLiveUiManifest(
      JSON.parse(readFileSync(join(clientDir, LIVE_UI_MANIFEST_FILENAME), "utf8")),
    );
  } catch (cause) {
    throw new Error(
      "Missing live UI build manifest. Rebuild web/server/desktop outputs before packaging.",
      { cause },
    );
  }
  if (
    !actual ||
    actual.version !== expected.version ||
    actual.runtimeHash !== expected.runtimeHash
  ) {
    throw new Error(
      "Live UI build manifest does not match the release source. Rebuild web/server/desktop outputs before packaging.",
    );
  }
}

function runtimeOutputDigests(outputDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  function visit(relative: string): void {
    for (const entry of readdirSync(join(outputDir, relative), { withFileTypes: true }).toSorted(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      // The server copies the client/helper sources after tsdown; these are
      // attested separately by the web manifest and runtime source fingerprint.
      if (!relative && (entry.name === "client" || entry.name === "device-helper")) continue;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Runtime output contains a symlink: ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (!entry.isFile()) throw new Error(`Runtime output is not a regular file: ${file}`);
      else if (/\.[cm]?js$/.test(file)) {
        files[file] = createHash("sha256")
          .update(readFileSync(join(outputDir, file)))
          .digest("hex");
      }
    }
  }
  visit("");
  if (!Object.keys(files).length) throw new Error("Runtime build produced no JavaScript outputs.");
  return files;
}

/** Capture before compilation and stamp only successful, unchanged-source builds.
 * Multiple desktop configs must all finish with the SAME source identity. */
export function createLiveUiBuildTracker(input: {
  readonly repoRoot: string;
  readonly version: string;
  readonly outputDir: string;
  readonly parts: readonly string[];
}) {
  const started = new Map<string, LiveUiManifest>();
  const completed = new Map<string, LiveUiManifest>();
  const stampPath = join(input.outputDir, LIVE_UI_RUNTIME_STAMP_FILENAME);
  return {
    begin(part: string): void {
      if (!input.parts.includes(part)) throw new Error(`Unknown runtime build part: ${part}`);
      rmSync(stampPath, { force: true });
      completed.delete(part);
      started.set(part, createLiveUiManifest(input.repoRoot, input.version));
    },
    complete(part: string): void {
      const before = started.get(part);
      const current = createLiveUiManifest(input.repoRoot, input.version);
      if (!before || before.runtimeHash !== current.runtimeHash)
        throw new Error("Runtime sources changed during compilation; rebuild before packaging.");
      completed.set(part, current);
      if (!input.parts.every((name) => completed.get(name)?.runtimeHash === current.runtimeHash))
        return;
      const outputs = runtimeOutputDigests(input.outputDir);
      mkdirSync(input.outputDir, { recursive: true });
      writeFileSync(stampPath, `${JSON.stringify({ ...current, outputs })}\n`);
    },
  };
}

export function assertLiveUiRuntimeBuildStamp(outputDir: string, expected: LiveUiManifest): void {
  const raw = JSON.parse(
    readFileSync(join(outputDir, LIVE_UI_RUNTIME_STAMP_FILENAME), "utf8"),
  ) as Record<string, unknown>;
  const actual = parseLiveUiManifest(raw);
  if (
    !actual ||
    actual.version !== expected.version ||
    actual.runtimeHash !== expected.runtimeHash ||
    JSON.stringify(raw.outputs) !== JSON.stringify(runtimeOutputDigests(outputDir))
  ) {
    throw new Error(
      "Runtime build stamp or output hashes do not match the release source. Rebuild before packaging.",
    );
  }
}

export function assertLiveUiReleaseBuildOutputs(root: string, expected: LiveUiManifest): void {
  assertLiveUiBuildManifest(join(root, "apps/server/dist/client"), expected);
  assertLiveUiRuntimeBuildStamp(join(root, "apps/server/dist"), expected);
  assertLiveUiRuntimeBuildStamp(join(root, "apps/desktop/dist-electron"), expected);
}
