import {
  existsSync,
  lstatSync,
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
import {
  buildCodexProcessEnv,
  disableCodexConfigSections,
  hydrateCodexProviderCredentialEnvironment,
  linkOrCopyCodexOverlayEntry,
  prioritizeCodexOverlayEntries,
  writeCodexOverlayConfigAtomically,
} from "./codexProcessEnv";
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

describe("hydrateCodexProviderCredentialEnvironment", () => {
  it("hydrates only missing provider credentials without trusting shell PATH", () => {
    const readEnvironment = vi.fn(() => ({
      AZURE_OPENAI_API_KEY: "shell-key",
      PATH: "/untrusted/shell/bin",
    }));
    const hydrated = hydrateCodexProviderCredentialEnvironment({
      env: { PATH: "/trusted/bin" },
      credentialEnvNames: ["AZURE_OPENAI_API_KEY"],
      trustedEnv: { SHELL: "/bin/zsh" },
      platform: "darwin",
      readEnvironment,
    });
    expect(hydrated).toEqual({
      PATH: "/trusted/bin",
      AZURE_OPENAI_API_KEY: "shell-key",
    });
    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", ["AZURE_OPENAI_API_KEY"]);
  });

  it("keeps an inherited provider credential and skips shell probing", () => {
    const readEnvironment = vi.fn();
    const hydrated = hydrateCodexProviderCredentialEnvironment({
      env: { AZURE_OPENAI_API_KEY: "inherited-key" },
      credentialEnvNames: ["AZURE_OPENAI_API_KEY"],
      platform: "linux",
      readEnvironment,
    });
    expect(hydrated.AZURE_OPENAI_API_KEY).toBe("inherited-key");
    expect(readEnvironment).not.toHaveBeenCalled();
  });
});

describe("writeCodexOverlayConfigAtomically", () => {
  it("keeps the old complete config when publication is interrupted", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-config-publish-"));
    const targetPath = path.join(root, "config.toml");
    writeFileSync(targetPath, 'model = "old"\n', "utf8");
    let temporaryPath: string | undefined;

    try {
      await expect(
        writeCodexOverlayConfigAtomically(targetPath, 'model = "new"\n', {
          beforeRename: (candidatePath) => {
            temporaryPath = candidatePath;
            expect(readFileSync(targetPath, "utf8")).toBe('model = "old"\n');
            expect(readFileSync(candidatePath, "utf8")).toBe('model = "new"\n');
            throw new Error("simulated publication interruption");
          },
        }),
      ).rejects.toThrow("simulated publication interruption");

      expect(readFileSync(targetPath, "utf8")).toBe('model = "old"\n');
      if (!temporaryPath) {
        throw new Error("Expected atomic publication to create a temporary config path.");
      }
      expect(existsSync(temporaryPath)).toBe(false);

      await writeCodexOverlayConfigAtomically(targetPath, 'model = "new"\n');

      expect(readFileSync(targetPath, "utf8")).toBe('model = "new"\n');
      if (process.platform !== "win32") {
        expect(lstatSync(targetPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves both publication and cleanup errors", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-config-cleanup-"));
    const targetPath = path.join(root, "config.toml");
    writeFileSync(targetPath, 'model = "old"\n', "utf8");

    try {
      let thrown: unknown;
      try {
        await writeCodexOverlayConfigAtomically(targetPath, 'model = "new"\n', {
          beforeRename: () => {
            throw new Error("primary publication failure");
          },
          removeTemporaryFile: () => {
            throw new Error("temporary cleanup failure");
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors.map((error) => (error as Error).message)).toEqual([
        "primary publication failure",
        "temporary cleanup failure",
      ]);
      expect(aggregate.cause).toBe(aggregate.errors[0]);
      expect(readFileSync(targetPath, "utf8")).toBe('model = "old"\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("linkOrCopyCodexOverlayEntry", () => {
  it("copies auth.json when symlink creation is unavailable", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });
    const copyFile = vi.fn(async () => undefined);

    await linkOrCopyCodexOverlayEntry(
      {
        entryName: "auth.json",
        sourcePath: "C:\\Users\\test\\.codex\\auth.json",
        targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
        type: "file",
      },
      { symlink, copyFile },
    );

    expect(symlink).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
      "file",
    );
    expect(copyFile).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
    );
  });

  it("keeps symlink failures visible for other overlay entries", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });

    await expect(
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "sessions",
          sourcePath: "C:\\Users\\test\\.codex\\sessions",
          targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\sessions",
          type: "dir",
        },
        { symlink, copyFile: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow("symlinks unavailable");
  });
});

describe("prioritizeCodexOverlayEntries", () => {
  it("prepares auth.json before entries whose symlinks may fail first", () => {
    expect(prioritizeCodexOverlayEntries(["sessions", "auth.json", "config.toml"])).toEqual([
      "auth.json",
      "sessions",
      "config.toml",
    ]);
  });
});

describe("disableCodexConfigSections", () => {
  const canonicalHeader = '[plugins."computer-use@openai-bundled"]';

  it.each([
    ["literal-quoted", "[plugins.'computer-use@openai-bundled']"],
    ["whitespace-varied", '[ plugins . "computer-use@openai-bundled" ]'],
    ["escaped basic-quoted", String.raw`[plugins."computer-use\u0040openai-bundled"]`],
    ["trailing-comment", "[plugins.'computer-use@openai-bundled'] # keep this comment"],
  ])("disables a semantically equivalent %s table without appending a duplicate", (_, header) => {
    const result = disableCodexConfigSections(
      `${header}\nenabled = true\n\n[plugins.other]\nenabled = true`,
      [canonicalHeader],
      true,
    );

    expect(result).toBe(`${header}\nenabled = false\n\n[plugins.other]\nenabled = true`);
    expect(result.match(/enabled = false/g)).toHaveLength(1);
    expect(result).not.toContain(canonicalHeader);
  });
});
