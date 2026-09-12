import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

vi.mock("@synara/shared/managedCodexRuntime", () => ({
  MANAGED_CODEX_RUNTIME_MANIFEST: {
    assetFileName: "runtime.tar.gz",
    sha256: createHash("sha256").update("verified-runtime").digest("hex"),
  },
}));

import { assertPackagedMacCodexRuntime } from "./build-desktop-artifact.ts";

it("verifies the packaged runtime alongside DMG/ZIP files and still rejects a wrong checksum", async () => {
  const root = mkdtempSync(join(tmpdir(), "synara-mac-runtime-"));
  try {
    writeFileSync(join(root, "Synara-arm64.dmg"), "dmg");
    writeFileSync(join(root, "Synara-arm64.zip"), "zip");
    const resources = join(root, "mac-arm64", "Synara.app", "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    const archive = join(resources, "runtime.tar.gz");
    writeFileSync(archive, "verified-runtime");
    const verify = () =>
      Effect.runPromise(
        assertPackagedMacCodexRuntime(root, "Synara").pipe(Effect.provide(NodeServices.layer)),
      );
    await expect(verify()).resolves.toBeUndefined();
    writeFileSync(archive, "wrong-runtime");
    await expect(verify()).rejects.toThrow("missing the pinned Codex runtime");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
