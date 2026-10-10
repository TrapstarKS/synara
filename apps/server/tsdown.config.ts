// FILE: tsdown.config.ts
// Purpose: Builds the Synara server CLI and controls diagnostic source maps.
// Layer: Server build config
// Depends on: tsdown.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";
import { createLiveUiBuildTracker } from "../../scripts/lib/live-ui-compatibility.ts";
import pkg from "./package.json" with { type: "json" };

const sourcemapEnv = process.env.SYNARA_SERVER_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationRuntimeSource = fs.readFileSync(
  path.join(repoRoot, "apps/server/src/persistence/Migrations.ts"),
  "utf8",
);
const migrationRuntimeSourceDigest = createHash("sha256")
  .update(migrationRuntimeSource, "utf8")
  .digest("hex");

export default defineConfig({
  hooks(hooks) {
    let liveUiBuild: ReturnType<typeof createLiveUiBuildTracker>;
    hooks.hook("build:prepare", ({ options }) => {
      liveUiBuild = createLiveUiBuildTracker({
        repoRoot,
        version: pkg.version,
        outputDir: options.outDir,
        parts: ["server"],
      });
      liveUiBuild.begin("server");
    });
    hooks.hook("build:done", () => liveUiBuild.complete("server"));
  },
  entry: ["src/index.ts", "src/restoreMigrationBackup.ts", "src/runtimeDependencySmoke.ts"],
  format: ["esm"],
  outDir: "dist",
  // Bun builtins only resolve at runtime under Bun; MigrationBackup.ts guards
  // the import behind a `process.versions.bun` check.
  external: [/^bun:/u],
  sourcemap: buildSourcemap,
  define: {
    __SYNARA_MIGRATION_RUNTIME_SOURCE_DIGEST__: JSON.stringify(migrationRuntimeSourceDigest),
  },
  clean: true,
  noExternal: (id) => id.startsWith("@synara/"),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
