import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { stageManagedCodexRuntime } from "./build-desktop-artifact.ts";

it.skipIf(process.platform !== "darwin")(
  "retains a pinned bootstrap after the automatic feed changes and rejects unverified fallbacks",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-pinned-codex-"));
    try {
      const original = join(root, "original.tar.gz");
      const feed = join(root, "latest.tar.gz");
      writeFileSync(original, "pinned-runtime");
      writeFileSync(feed, "updated-runtime");
      const manifest = {
        version: "1.0.0",
        assetFileName: "staged.tar.gz",
        sha256: createHash("sha256").update("pinned-runtime").digest("hex"),
        downloadUrl: pathToFileURL(feed).href,
        pinnedDownloadUrl: pathToFileURL(original).href,
      };
      const stage = () =>
        Effect.runPromise(
          stageManagedCodexRuntime(root, "arm64", false, manifest).pipe(
            Effect.provide(NodeServices.layer),
            Effect.scoped,
          ),
        );
      await stage();
      expect(readFileSync(join(root, manifest.assetFileName), "utf8")).toBe("pinned-runtime");
      rmSync(original);
      await expect(stage()).rejects.toThrow("checksum mismatch");
      writeFileSync(feed, "pinned-runtime");
      await stage();
      expect(readFileSync(join(root, manifest.assetFileName), "utf8")).toBe("pinned-runtime");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
