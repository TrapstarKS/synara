// Preserve MCP edits from old Synara overlays when returning to the native home.
// Rollouts/images stay at their original paths, including paths indexed by Codex.
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import {
  resolveBaseCodexHomePath,
  resolveLegacyCodexProfileOverlayPath,
  resolveSynaraCodexHomeOverlayPath,
  type CodexHomePathsInput,
} from "./codexHomePaths.ts";
import { CODEX_MCP_CONFIG_STATE_FILE, reconcileCodexMcpConfig } from "./codexMcpConfig.ts";
import { serializeCodexConfigAccess } from "./codexProcessEnv.ts";

async function readOptional(filePath: string): Promise<string | undefined> {
  return fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
}

export async function migrateLegacyCodexHome(input: CodexHomePathsInput = {}): Promise<void> {
  const env = input.env ?? process.env;
  const source = path.resolve(resolveBaseCodexHomePath(env, input.homePath));
  const overlay =
    resolveLegacyCodexProfileOverlayPath(env, source) ??
    resolveSynaraCodexHomeOverlayPath(env, source);
  if (source === path.resolve(overlay)) return;
  await serializeCodexConfigAccess(source, async () => {
    // Scope the marker to this exact destination; explicitly configured homes
    // must never silently reuse another account's migration result.
    const destinationId = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const marker = path.join(overlay, `native-home-${destinationId}-v1.json`);
    if ((await readOptional(marker)) !== undefined) return;
    const overlayConfig = await readOptional(path.join(overlay, "config.toml"));
    if (overlayConfig === undefined) return;
    const sourcePath = path.join(source, "config.toml");
    const sourceConfig = (await readOptional(sourcePath)) ?? "";
    const stateText = await readOptional(path.join(overlay, CODEX_MCP_CONFIG_STATE_FILE));
    const migrated = reconcileCodexMcpConfig({
      sourceConfig,
      overlayConfig,
      ...(stateText !== undefined ? { stateText } : {}),
      managedServerNames: ["synara"],
      preserveManagedSourceServers: true,
    });
    if (migrated.config !== sourceConfig) {
      // Keep a private, non-overwritten backup before the one-time native edit.
      await fs
        .writeFile(path.join(overlay, `native-home-${destinationId}-backup.toml`), sourceConfig, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        })
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
      if (((await readOptional(sourcePath)) ?? "") !== sourceConfig) {
        throw new Error("Codex configuration changed during migration. Retry the session.");
      }
      await fs.mkdir(source, { recursive: true, mode: 0o700 });
      await Effect.runPromise(
        writeFileStringAtomically({ filePath: sourcePath, contents: migrated.config }),
      );
    }
    // Commit last. A failed migration is retryable and never destroys the overlay.
    await Effect.runPromise(
      writeFileStringAtomically({
        filePath: marker,
        contents: `${JSON.stringify({ version: 1, sourceHome: source })}\n`,
      }),
    );
  });
}
