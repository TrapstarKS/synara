// Resolve the user's Codex installation without reviving the retired bundled fork.
import { readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  executableCandidates,
  envPathKeyFor,
  isExecutableFile,
  type ExecutableLookupOptions,
} from "./executable";

/** Drop only the PATH injection identified by an older desktop's runtime marker. */
export function removeRetiredCodexEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const next = { ...env };
  const retiredBin = env.SYNARA_MANAGED_CODEX_BIN_DIR?.trim();
  const key = envPathKeyFor(next, platform);
  if (retiredBin && next[key]) {
    const normalize = (value: string) => {
      const normalized = value
        .trim()
        .replace(/^"|"$/g, "")
        .replaceAll("\\", "/")
        .replace(/\/+$/, "");
      return platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    const delimiter = platform === "win32" ? ";" : ":";
    next[key] = next[key]!.split(delimiter)
      .filter((entry) => normalize(entry) !== normalize(retiredBin))
      .join(delimiter);
  }
  delete next.SYNARA_MANAGED_CODEX_BIN_DIR;
  delete next.SYNARA_LUNA_HOME;
  return next;
}

function hasRetiredBinaryName(value: string): boolean {
  const name = value.trim().replaceAll("\\", "/").split("/").at(-1) ?? "";
  return /^codex-luna-max-fast(?:\.real)?(?:\.(?:exe|cmd|bat))?$/i.test(name);
}

/** Also recognizes the `bin/codex` symlink installed by older Synara releases. */
export function isRetiredCodexExecutable(value: string): boolean {
  if (hasRetiredBinaryName(value)) return true;
  try {
    return hasRetiredBinaryName(realpathSync(value));
  } catch {
    try {
      return hasRetiredBinaryName(readlinkSync(value));
    } catch {
      return false;
    }
  }
}

export function resolveCodexExecutable(
  command: string,
  options: ExecutableLookupOptions = {},
): string | null {
  const requested = command.trim() || "codex";
  const atWorkingDirectory = (value: string) => (options.cwd ? resolve(options.cwd, value) : value);
  const lookup = isRetiredCodexExecutable(atWorkingDirectory(requested)) ? "codex" : requested;
  for (const candidate of executableCandidates(lookup, options)) {
    if (
      isExecutableFile(candidate.path, options) &&
      !isRetiredCodexExecutable(atWorkingDirectory(candidate.path))
    ) {
      return candidate.path;
    }
  }
  return null;
}
