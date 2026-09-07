import fs from "node:fs/promises";
import path from "node:path";

import type {
  CodexProfile,
  CodexProfileId,
  ModelSelection,
  ProviderStartOptions,
  ServerSettings,
} from "@synara/contracts";

const MANAGED_CODEX_CONFIG = 'cli_auth_credentials_store = "file"\n';

export function resolveManagedCodexProfileHome(
  secretsDir: string,
  profileId: CodexProfileId,
): string {
  return path.join(secretsDir, "codex-profiles", profileId);
}

export function findCodexProfile(
  settings: ServerSettings,
  profileId: CodexProfileId,
): CodexProfile | undefined {
  return settings.providers.codex.profiles.find((profile) => profile.id === profileId);
}

export function resolveCodexProfileOptions(input: {
  settings: ServerSettings;
  secretsDir: string;
  modelSelection: ModelSelection | undefined;
  providerOptions?: ProviderStartOptions;
}): ProviderStartOptions {
  const profileId =
    input.modelSelection?.provider === "codex" ? input.modelSelection.profileId : undefined;
  if (!profileId) return input.providerOptions ?? {};
  if (!findCodexProfile(input.settings, profileId)) {
    throw new Error(`Codex account '${profileId}' no longer exists.`);
  }
  return {
    ...input.providerOptions,
    codex: {
      ...input.providerOptions?.codex,
      homePath: resolveManagedCodexProfileHome(input.secretsDir, profileId),
      profileId,
    },
  };
}

export async function ensureManagedCodexProfileHome(
  secretsDir: string,
  profileId: CodexProfileId,
): Promise<string> {
  const root = path.join(secretsDir, "codex-profiles");
  const homePath = resolveManagedCodexProfileHome(secretsDir, profileId);
  await fs.mkdir(homePath, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await ensureManagedCodexHome(homePath);
  return homePath;
}

export async function ensureManagedCodexHome(homePath: string): Promise<void> {
  await fs.mkdir(homePath, { recursive: true, mode: 0o700 });
  await fs.chmod(homePath, 0o700);
  const configPath = path.join(homePath, "config.toml");
  let config = "";
  try {
    config = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const credentialStorePattern = /^[\t ]*cli_auth_credentials_store[\t ]*=.*$/m;
  const normalizedConfig = credentialStorePattern.test(config)
    ? config.replace(credentialStorePattern, MANAGED_CODEX_CONFIG.trimEnd())
    : `${MANAGED_CODEX_CONFIG}${config.length > 0 ? `\n${config}` : ""}`;
  if (normalizedConfig !== config) {
    await fs.writeFile(configPath, normalizedConfig, { encoding: "utf8", mode: 0o600 });
  }
  await fs.chmod(configPath, 0o600);
}
