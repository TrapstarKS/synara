import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { CodexProfileId, DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@synara/contracts";
import {
  ensureManagedCodexProfileHome,
  resolveCodexProfileOptions,
  resolveManagedCodexProfileHome,
} from "./codexProfiles.ts";

const profileId = CodexProfileId.makeUnsafe("82eb5d15-7a72-4ec6-bca1-e58bf35b6284");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((entry) => fs.rm(entry, { recursive: true })),
  );
});

function settingsWithProfile(): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        profiles: [{ id: profileId, name: "Work" }],
        defaultProfileId: profileId,
      },
    },
  };
}

describe("Codex profiles", () => {
  it("resolves a selected profile to a private server-owned home", () => {
    const options = resolveCodexProfileOptions({
      settings: settingsWithProfile(),
      secretsDir: "/private/secrets",
      modelSelection: { provider: "codex", model: "gpt-5.6-sol", profileId },
      providerOptions: { codex: { binaryPath: "/bin/codex", homePath: "/untrusted" } },
    });
    assert.deepEqual(options.codex, {
      binaryPath: "/bin/codex",
      homePath: path.join("/private/secrets", "codex-profiles", profileId),
      profileId,
    });
  });

  it("fails closed when a persisted profile no longer exists", () => {
    assert.throws(
      () =>
        resolveCodexProfileOptions({
          settings: DEFAULT_SERVER_SETTINGS,
          secretsDir: "/private/secrets",
          modelSelection: { provider: "codex", model: "gpt-5.6-sol", profileId },
        }),
      /no longer exists/,
    );
  });

  it("creates a file-backed private Codex home", async () => {
    const secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-codex-profile-"));
    temporaryDirectories.push(secretsDir);
    const homePath = await ensureManagedCodexProfileHome(secretsDir, profileId);
    assert.equal(homePath, resolveManagedCodexProfileHome(secretsDir, profileId));
    assert.match(
      await fs.readFile(path.join(homePath, "config.toml"), "utf8"),
      /cli_auth_credentials_store = "file"/,
    );
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(homePath)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(homePath, "config.toml"))).mode & 0o777, 0o600);
    }
  });

  it("keeps the managed account on file auth when its config was edited", async () => {
    const secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-codex-profile-"));
    temporaryDirectories.push(secretsDir);
    const homePath = resolveManagedCodexProfileHome(secretsDir, profileId);
    await fs.mkdir(homePath, { recursive: true });
    await fs.writeFile(
      path.join(homePath, "config.toml"),
      'model = "gpt-5.6-sol"\ncli_auth_credentials_store = "keyring"\n',
    );

    await ensureManagedCodexProfileHome(secretsDir, profileId);

    const config = await fs.readFile(path.join(homePath, "config.toml"), "utf8");
    assert.match(config, /cli_auth_credentials_store = "file"/);
    assert.doesNotMatch(config, /keyring/);
    assert.match(config, /model = "gpt-5\.6-sol"/);
  });
});
