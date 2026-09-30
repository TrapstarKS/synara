import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexProfileId } from "@synara/contracts";
import { buildCodexProcessEnv } from "./codexProcessEnv";
import { isProviderCredentialKey } from "./providerChildEnvironment.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(config = "") {
  const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
  roots.push(root);
  const homePath = path.join(root, ".codex");
  mkdirSync(homePath);
  writeFileSync(path.join(homePath, "config.toml"), config);
  return { root, homePath, env: { SYNARA_HOME: path.join(root, ".synara"), CODEX_HOME: homePath } };
}

describe("buildCodexProcessEnv", () => {
  it.each(["win32", "darwin"] as const)(
    "uses the native home on %s without copying config, authentication or databases",
    async (platform) => {
      const config = '# user settings\nmodel="user-choice"\n';
      const f = fixture(config);
      writeFileSync(path.join(f.homePath, "auth.json"), "native-auth");
      writeFileSync(path.join(f.homePath, "state_5.sqlite"), "utf8");
      const env = await buildCodexProcessEnv({ env: f.env, platform });
      expect(env.CODEX_HOME).toBe(f.homePath);
      expect(env.CODEX_SQLITE_HOME).toBe(f.homePath);
      expect(readFileSync(path.join(f.homePath, "config.toml"), "utf8")).toBe(config);
      expect(readFileSync(path.join(f.homePath, "auth.json"), "utf8")).toBe("native-auth");
      expect(readFileSync(path.join(f.homePath, "state_5.sqlite"), "utf8")).toBe("utf8");
      expect(existsSync(f.env.SYNARA_HOME)).toBe(false);
    },
  );

  it("honors an explicit home and SQLite location", async () => {
    const f = fixture();
    const selected = path.join(f.root, "selected-home");
    const env = await buildCodexProcessEnv({
      env: { ...f.env, CODEX_SQLITE_HOME: "explicit-sqlite" },
      homePath: selected,
      platform: "win32",
    });
    expect(env.CODEX_HOME).toBe(selected);
    expect(env.CODEX_SQLITE_HOME).toBe("explicit-sqlite");
    expect(existsSync(selected)).toBe(false);
  });

  it("keeps accounts in their explicitly selected private homes without inheriting a global API key", async () => {
    const f = fixture();
    const profiles = [
      "be54e3c8-c56b-4113-8257-a9090d97b936",
      "7cc2e449-3a05-4a0e-9556-c8cc959e180e",
    ];
    const envs = await Promise.all(
      profiles.map((id) =>
        buildCodexProcessEnv({
          env: { ...f.env, OPENAI_API_KEY: "must-not-leak" },
          homePath: path.join(f.root, id),
          profileId: CodexProfileId.makeUnsafe(id),
          platform: "win32",
        }),
      ),
    );
    for (let index = 0; index < envs.length; index++) {
      const env = envs[index]!;
      expect(env.CODEX_HOME).toBe(path.join(f.root, profiles[index]!));
      expect(env.OPENAI_API_KEY).toBeUndefined();
      if (process.platform !== "win32") {
        expect(statSync(env.CODEX_HOME!).mode & 0o777).toBe(0o700);
        expect(statSync(path.join(env.CODEX_HOME!, "config.toml")).mode & 0o777).toBe(0o600);
      }
    }
    expect(envs[0]!.CODEX_HOME).not.toBe(envs[1]!.CODEX_HOME);
  });

  it("uses login-shell PATH for a custom provider without prioritizing the retired fork", async () => {
    const f = fixture('model_provider="acme"\n[model_providers.acme]\nenv_key="ACME_KEY"\n');
    const env = await buildCodexProcessEnv({
      env: {
        ...f.env,
        SHELL: "/bin/zsh",
        PATH: "/inherited/bin",
        SYNARA_MANAGED_CODEX_BIN_DIR: "/retired/bin",
        SYNARA_LUNA_HOME: "/retired",
      },
      platform: "darwin",
      readEnvironment: () => ({ PATH: "/shell/bin", ACME_KEY: "secret" }),
    });
    expect(env.PATH).toBe("/shell/bin");
    expect(env.ACME_KEY).toBe("secret");
    expect(env.SYNARA_MANAGED_CODEX_BIN_DIR).toBeUndefined();
    expect(env.SYNARA_LUNA_HOME).toBeUndefined();
  });

  it("registers custom provider credential keys and avoids unnecessary shell reads", async () => {
    const f = fixture(
      'model_provider="acme"\n[model_providers.acme]\nenv_key="ACME-LICENSE.INTEGRATION"\n',
    );
    const readEnvironment = vi.fn(() => ({}));
    await buildCodexProcessEnv({
      env: { ...f.env, SHELL: "/bin/zsh", "ACME-LICENSE.INTEGRATION": "already-present" },
      platform: "darwin",
      readEnvironment,
    });
    expect(isProviderCredentialKey("ACME-LICENSE.INTEGRATION")).toBe(true);
    expect(readEnvironment).not.toHaveBeenCalled();
  });
});
