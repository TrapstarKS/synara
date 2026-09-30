// Build the normal Codex environment without redirecting it to a Synara overlay.
import path from "node:path";
import type { CodexProfileId } from "@synara/contracts";
import { readActiveCodexProviderEnvKey } from "@synara/shared/codexConfig";
import { removeRetiredCodexEnvironment } from "@synara/shared/codexExecutable";
import {
  readEnvironmentFromLoginShell,
  resolveLoginShell,
  type ShellEnvironmentReader,
} from "@synara/shared/shell";
import { ensureManagedCodexHome } from "./codexProfiles.ts";
import { resolveBaseCodexHomePath } from "./codexHomePaths.ts";
import {
  buildProviderChildEnvironment,
  registerProviderCredentialKey,
} from "./providerChildEnvironment.ts";

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const codexConfigQueues = new Map<string, Promise<void>>();

// Native-home migration and MCP config/value/write requests share this queue.
export async function serializeCodexConfigAccess<A>(
  homePath: string,
  prepare: () => Promise<A>,
): Promise<A> {
  homePath = path.resolve(homePath);
  const previous = codexConfigQueues.get(homePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(prepare);
  const queued = current.then(
    () => undefined,
    () => undefined,
  );
  codexConfigQueues.set(homePath, queued);
  try {
    return await current;
  } finally {
    if (codexConfigQueues.get(homePath) === queued) {
      codexConfigQueues.delete(homePath);
    }
  }
}

/** Test seam: resolves once the queued config access for one home has settled. */
export function waitForCodexConfigAccess(homePath: string): Promise<void> {
  return codexConfigQueues.get(path.resolve(homePath)) ?? Promise.resolve();
}

export async function buildCodexProcessEnv(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homePath?: string;
    readonly profileId?: CodexProfileId;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: ShellEnvironmentReader;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const baseEnv = { ...(input.env ?? process.env) };
  if (input.profileId && input.homePath) {
    await ensureManagedCodexHome(input.homePath);
    delete baseEnv.OPENAI_API_KEY;
  }
  const homePath = path.resolve(resolveBaseCodexHomePath(baseEnv, input.homePath));
  const configuredEnv: NodeJS.ProcessEnv = { ...baseEnv, CODEX_HOME: homePath };
  // Older releases already used this source directory for SQLite. Keep the
  // database and its sidecars on the same path while native sessions use it too.
  if (!configuredEnv.CODEX_SQLITE_HOME?.trim()) configuredEnv.CODEX_SQLITE_HOME = homePath;
  const platform = input.platform ?? process.platform;
  const effectiveEnv = buildProviderChildEnvironment({
    provider: "codex",
    baseEnv: configuredEnv,
  });
  const providerEnvKey = readActiveCodexProviderEnvKey(effectiveEnv);
  if (providerEnvKey) {
    registerProviderCredentialKey(providerEnvKey);
  }

  if (platform === "darwin" || platform === "linux") {
    try {
      const shell = resolveLoginShell(platform, effectiveEnv.SHELL);
      if (shell && providerEnvKey && !effectiveEnv[providerEnvKey]?.trim()) {
        const shellEnvironment = (input.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
          ...CODEX_PROCESS_SHELL_ENV_NAMES,
          providerEnvKey,
        ]);

        if (shellEnvironment.PATH) {
          effectiveEnv.PATH = shellEnvironment.PATH;
        }
        if (!effectiveEnv.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
          effectiveEnv.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
        }
        if (shellEnvironment[providerEnvKey]) {
          effectiveEnv[providerEnvKey] = shellEnvironment[providerEnvKey];
        }
      }
    } catch {
      // Keep inherited environment if shell lookup fails.
    }
  }

  return removeRetiredCodexEnvironment(
    {
      ...effectiveEnv,
      SYNARA_MANAGED_CODEX_BIN_DIR: baseEnv.SYNARA_MANAGED_CODEX_BIN_DIR,
    },
    platform,
  );
}
