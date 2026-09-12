// FILE: prepare-release-update-feed.ts
// Purpose: Prepares updater metadata for historical bridge and current Latest releases.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareReleaseUpdateManifests,
  readReleaseUpdatePolicyConfig,
} from "./lib/release-update-policy.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetDirectory = resolve(process.argv[2] ?? "release-assets");
const platformOption = process.argv[3];
if ((platformOption !== undefined && platformOption !== "--no-linux") || process.argv.length > 4) {
  throw new Error("Usage: prepare-release-update-feed.ts [assets-dir] [--no-linux]");
}
const prepared = prepareReleaseUpdateManifests(
  assetDirectory,
  readReleaseUpdatePolicyConfig(repoRoot),
  { includeLinux: platformOption !== "--no-linux" },
);

console.log(`Prepared updater manifests: ${prepared.join(", ")}`);
