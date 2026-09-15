import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import { CodexProfileId } from "@synara/contracts";
import { SYNARA_MANAGED_CODEX_BIN_DIR_ENV } from "@synara/shared/managedCodexRuntime";

import {
  buildCodexProcessEnv,
  disableCodexConfigSections,
  linkOrCopyCodexOverlayEntry,
  prioritizeCodexOverlayEntries,
} from "./codexProcessEnv";
import { CODEX_MCP_CONFIG_STATE_FILE } from "./codexMcpConfig";
import { isProviderCredentialKey } from "./providerChildEnvironment.ts";
import { buildCodexMcpConfigToml } from "./agentGateway/mcpInjection.ts";

// Mirrors how the Synara MCP server block is appended per session: it must
// never count as user content when the overlay config is reconciled.
function codexMcpServerBlock(): string {
  return [
    "[mcp_servers.roblox]",
    'command = "roblox-studio-mcp"',
    'args = ["--port", "44755"]',
  ].join("\n");
}

function readMcpState(overlayHome: string): { applied: Record<string, string>; owned: string[] } {
  return JSON.parse(readFileSync(path.join(overlayHome, CODEX_MCP_CONFIG_STATE_FILE), "utf8")) as {
    applied: Record<string, string>;
    owned: string[];
  };
}

function readOverlayConfig(overlayHome: string): string {
  return readFileSync(path.join(overlayHome, "config.toml"), "utf8");
}

/** Overlay config re-serialized by the reconciler: assert values, not formatting. */
function readOverlayConfigToml(overlayHome: string): Record<string, unknown> {
  return parse(readOverlayConfig(overlayHome), { integersAsBigInt: true }) as Record<
    string,
    unknown
  >;
}

function readMcpServers(overlayHome: string): Record<string, unknown> {
  return (readOverlayConfigToml(overlayHome).mcp_servers ?? {}) as Record<string, unknown>;
}

describe("linkOrCopyCodexOverlayEntry", () => {
  it("hard-links auth.json when symlinks are unavailable", async () => {
    const link = vi.fn(async () => undefined);
    const copyFile = vi.fn(async () => undefined);

    await linkOrCopyCodexOverlayEntry(
      {
        entryName: "auth.json",
        sourcePath: "C:\\Users\\test\\.codex\\auth.json",
        targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
        type: "file",
      },
      {
        symlink: vi.fn(async () => {
          throw new Error("symlinks unavailable");
        }),
        link,
        copyFile,
      },
    );

    expect(link).toHaveBeenCalledOnce();
    expect(copyFile).not.toHaveBeenCalled();
  });

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
      {
        symlink,
        link: vi.fn(async () => {
          throw new Error("hard links unavailable");
        }),
        copyFile,
      },
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

describe("buildCodexProcessEnv", () => {
  it("keeps the managed Codex directory first when a provider shell refreshes PATH", async () => {
    const sourceHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-path-source-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-path-runtime-"));
    writeFileSync(
      path.join(sourceHome, "config.toml"),
      ['model_provider = "acme"', "", "[model_providers.acme]", 'env_key = "ACME_KEY"'].join("\n"),
    );

    try {
      const env = await buildCodexProcessEnv({
        env: {
          CODEX_HOME: sourceHome,
          SYNARA_HOME: runtimeHome,
          SHELL: "/bin/zsh",
          PATH: "/inherited/bin",
          [SYNARA_MANAGED_CODEX_BIN_DIR_ENV]: "/managed/bin",
        },
        platform: "darwin",
        readEnvironment: () => ({ PATH: "/shell/bin", ACME_KEY: "secret" }),
      });

      expect(env.PATH).toBe("/managed/bin:/shell/bin");
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("isolates managed profile overlays and keeps them private", async () => {
    const sourceHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-profile-source-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-profile-runtime-"));
    const first = CodexProfileId.makeUnsafe("be54e3c8-c56b-4113-8257-a9090d97b936");
    const second = CodexProfileId.makeUnsafe("7cc2e449-3a05-4a0e-9556-c8cc959e180e");
    writeFileSync(path.join(sourceHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');

    try {
      const firstEnv = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome, OPENAI_API_KEY: "must-not-leak" },
        homePath: sourceHome,
        profileId: first,
        platform: "win32",
      });
      const secondEnv = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: sourceHome,
        profileId: second,
        platform: "win32",
      });

      expect(firstEnv.CODEX_HOME).toBe(path.join(runtimeHome, "codex-home-overlays", first));
      expect(secondEnv.CODEX_HOME).toBe(path.join(runtimeHome, "codex-home-overlays", second));
      expect(firstEnv.OPENAI_API_KEY).toBeUndefined();
      expect(firstEnv.CODEX_HOME).not.toBe(secondEnv.CODEX_HOME);
      if (process.platform !== "win32") {
        expect(statSync(firstEnv.CODEX_HOME!).mode & 0o777).toBe(0o700);
        expect(statSync(path.join(firstEnv.CODEX_HOME!, "config.toml")).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("repairs mixed transports in the saved gateway config during an auth probe", async () => {
    const sourceHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-source-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-runtime-"));
    const sourceConfig = [
      "[mcp_servers.synara]",
      'command = "external-bridge"',
      "args = []",
      "[mcp_servers.user-tool]",
      'command = "user-tool"',
      "",
    ].join("\n");
    const sourceConfigPath = path.join(sourceHome, "config.toml");
    writeFileSync(sourceConfigPath, sourceConfig);
    const input = { env: { SYNARA_HOME: runtimeHome }, homePath: sourceHome };
    const managedConfig = buildCodexMcpConfigToml("http://127.0.0.1:3773/mcp");

    try {
      const env = await buildCodexProcessEnv({ ...input, appendConfigToml: managedConfig });
      const overlayConfigPath = path.join(env.CODEX_HOME!, "config.toml");
      const cleanConfig = readFileSync(overlayConfigPath, "utf8");
      // An external MCP registration can leave stdio fields in the saved HTTP block.
      writeFileSync(
        overlayConfigPath,
        cleanConfig
          .replace(
            "[mcp_servers.synara]",
            '[mcp_servers.synara]\ncommand = "external-bridge"\nargs = [\n  "serve",\n]\ncwd = "/tmp"',
          )
          .replace(
            "[shell_environment_policy]",
            '[mcp_servers.synara.env]\nSTDIO_ONLY = "value"\n\n[shell_environment_policy]',
          ),
      );

      await buildCodexProcessEnv(input);

      expect(readFileSync(overlayConfigPath, "utf8")).toBe(cleanConfig);
      expect(readFileSync(sourceConfigPath, "utf8")).toBe(sourceConfig);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("registers the active custom provider env key for diagnostic redaction", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-provider-key-"));
    writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'model_provider = "acme"',
        "",
        "[model_providers.acme]",
        'env_key = "ACME-LICENSE.INTEGRATION"',
      ].join("\n"),
      "utf8",
    );

    try {
      await buildCodexProcessEnv({ env: { CODEX_HOME: codexHome }, platform: "win32" });
      expect(isProviderCredentialKey("ACME-LICENSE.INTEGRATION")).toBe(true);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("keeps a user-provided CODEX_SQLITE_HOME for the session overlay", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-sqlite-home-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    const sqliteHome = mkdtempSync(path.join(os.tmpdir(), "synara-user-sqlite-home-"));
    writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"', "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome, CODEX_SQLITE_HOME: sqliteHome },
        homePath: codexHome,
        platform: "win32",
      });

      expect(env.CODEX_HOME).toBe(path.join(runtimeHome, "codex-home-overlay"));
      expect(env.CODEX_SQLITE_HOME).toBe(sqliteHome);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
      rmSync(sqliteHome, { recursive: true, force: true });
    }
  });

  it("replaces a user-defined Synara MCP table only inside the session overlay", async () => {
    const sourceHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-source-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-runtime-"));
    const sourceConfig = [
      'model = "gpt-5.5"',
      "",
      "[mcp_servers.synara]",
      'url = "http://127.0.0.1:1111/stale-mcp"',
      'bearer_token_env_var = "STALE_GATEWAY_TOKEN"',
      "",
      "[mcp_servers.synara.headers]",
      'Authorization = "stale-inline-secret"',
      "",
      "[mcp_servers.synara.env]",
      'STALE_GATEWAY_TOKEN = "stale-inline-secret"',
      "",
      "[mcp_servers.synara-other]",
      'url = "http://127.0.0.1:2111/synara-other"',
      "",
      "[mcp_servers.user-tool]",
      'url = "http://127.0.0.1:2222/user-tool"',
      "",
      "[shell_environment_policy]",
      'inherit = "core"',
      'exclude = ["USER_SECRET"]',
    ].join("\n");
    const managedConfig = [
      "[mcp_servers.synara]",
      'url = "http://127.0.0.1:3773/mcp"',
      'bearer_token_env_var = "SYNARA_AGENT_GATEWAY_TOKEN"',
      "",
      "[shell_environment_policy]",
      'exclude = ["SYNARA_AGENT_GATEWAY_TOKEN"]',
    ].join("\n");
    const sourceConfigPath = path.join(sourceHome, "config.toml");
    writeFileSync(sourceConfigPath, sourceConfig, "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: sourceHome,
        platform: "darwin",
        appendConfigToml: managedConfig,
      });
      const overlayHome = env.CODEX_HOME;
      if (!overlayHome) {
        throw new Error("Expected a Synara Codex home overlay.");
      }
      const overlayConfig = readFileSync(path.join(overlayHome, "config.toml"), "utf8");

      expect(overlayConfig.match(/^\[mcp_servers\.synara\]$/gm)).toHaveLength(1);
      expect(overlayConfig).toContain('url = "http://127.0.0.1:3773/mcp"');
      expect(overlayConfig).toContain('bearer_token_env_var = "SYNARA_AGENT_GATEWAY_TOKEN"');
      expect(overlayConfig).not.toContain("http://127.0.0.1:1111/stale-mcp");
      expect(overlayConfig).not.toContain("STALE_GATEWAY_TOKEN");
      expect(overlayConfig).not.toContain("stale-inline-secret");
      expect(overlayConfig).not.toContain("[mcp_servers.synara.headers]");
      expect(overlayConfig).not.toContain("[mcp_servers.synara.env]");
      expect(overlayConfig).toContain(
        '[mcp_servers.synara-other]\nurl = "http://127.0.0.1:2111/synara-other"',
      );
      expect(overlayConfig).toContain(
        '[mcp_servers.user-tool]\nurl = "http://127.0.0.1:2222/user-tool"',
      );
      expect(overlayConfig).toContain('inherit = "core"');
      expect(
        (readOverlayConfigToml(overlayHome).shell_environment_policy as { exclude: string[] })
          .exclude,
      ).toEqual(["SYNARA_AGENT_GATEWAY_TOKEN", "USER_SECRET"]);
      expect(readFileSync(sourceConfigPath, "utf8")).toBe(sourceConfig);

      const state = readMcpState(overlayHome);
      expect(Object.keys(state.applied).sort()).toEqual(["synara-other", "user-tool"]);
      expect(state.applied).not.toHaveProperty("synara");
      expect(state.owned).toEqual([]);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("keeps an MCP server added through a session across thread switches and restarts", async () => {
    const sourceHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-mcp-source-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-mcp-runtime-"));
    const sourceConfig = [
      'model = "gpt-5.5"',
      "",
      "[mcp_servers.user-tool]",
      'url = "http://127.0.0.1:2222/user-tool"',
    ].join("\n");
    const sourceConfigPath = path.join(sourceHome, "config.toml");
    writeFileSync(sourceConfigPath, sourceConfig, "utf8");
    const managedConfig = [
      "[mcp_servers.synara]",
      'url = "http://127.0.0.1:3773/mcp"',
      'bearer_token_env_var = "SYNARA_AGENT_GATEWAY_TOKEN"',
    ].join("\n");

    try {
      // Thread 1: the first session seeds the overlay and its bookkeeping.
      const firstEnv = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: sourceHome,
        platform: "darwin",
        appendConfigToml: managedConfig,
      });
      const overlayHome = firstEnv.CODEX_HOME;
      if (!overlayHome) {
        throw new Error("Expected a Synara Codex home overlay.");
      }

      // The user (or the agent, through `synara_mcp_add`) writes the server
      // into the overlay only: this is what codex `config/value/write` does.
      writeFileSync(
        path.join(overlayHome, "config.toml"),
        `${readOverlayConfig(overlayHome)}\n\n${codexMcpServerBlock()}\n`,
        "utf8",
      );

      // Thread 2: opening another thread refreshes the overlay from source.
      await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: sourceHome,
        platform: "darwin",
        appendConfigToml: managedConfig,
      });

      const afterSecondThread = readOverlayConfig(overlayHome);
      expect(afterSecondThread.match(/^\[mcp_servers\.synara\]$/gm)).toHaveLength(1);
      expect(readMcpServers(overlayHome).roblox).toEqual({
        command: "roblox-studio-mcp",
        args: ["--port", "44755"],
      });
      expect(readMcpState(overlayHome).owned).toContain("roblox");

      // Application restart: the next session refreshes the same overlay again.
      await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: sourceHome,
        platform: "darwin",
        appendConfigToml: managedConfig,
      });

      expect(readMcpServers(overlayHome)).toEqual({
        "user-tool": { url: "http://127.0.0.1:2222/user-tool" },
        roblox: { command: "roblox-studio-mcp", args: ["--port", "44755"] },
        synara: {
          url: "http://127.0.0.1:3773/mcp",
          bearer_token_env_var: "SYNARA_AGENT_GATEWAY_TOKEN",
        },
      });
      expect(readFileSync(sourceConfigPath, "utf8")).toBe(sourceConfig);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("adopts MCP servers from an overlay written by a build without bookkeeping", async () => {
    const sourceHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-mcp-upgrade-source-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-mcp-upgrade-runtime-"));
    const sourceConfig = 'model = "gpt-5.5"';
    writeFileSync(path.join(sourceHome, "config.toml"), sourceConfig, "utf8");

    try {
      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      mkdirSync(overlayHome, { recursive: true });
      writeFileSync(
        path.join(overlayHome, "config.toml"),
        [`${sourceConfig}\n`, codexMcpServerBlock()].join("\n"),
        "utf8",
      );

      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: sourceHome,
        platform: "darwin",
      });
      if (!env.CODEX_HOME) {
        throw new Error("Expected a Synara Codex home overlay.");
      }

      expect(readOverlayConfig(overlayHome)).toContain("[mcp_servers.roblox]");
      expect(readMcpState(overlayHome).owned).toContain("roblox");
      expect(readFileSync(path.join(sourceHome, "config.toml"), "utf8")).toBe(sourceConfig);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("serializes concurrent overlay refreshes for the same Codex home", async () => {
    const sourceHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-mcp-race-source-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-mcp-race-runtime-"));
    writeFileSync(
      path.join(sourceHome, "config.toml"),
      ['model = "gpt-5.5"', "", "[mcp_servers.user-tool]", 'command = "user-tool"'].join("\n"),
      "utf8",
    );

    try {
      const envs = await Promise.all(
        Array.from({ length: 4 }, () =>
          buildCodexProcessEnv({
            env: { SYNARA_HOME: runtimeHome },
            homePath: sourceHome,
            platform: "darwin",
          }),
        ),
      );
      const overlayHome = envs[0]?.CODEX_HOME;
      if (!overlayHome) {
        throw new Error("Expected a Synara Codex home overlay.");
      }
      for (const env of envs) {
        expect(env.CODEX_HOME).toBe(overlayHome);
      }

      const overlayConfig = readOverlayConfig(overlayHome);
      expect(overlayConfig.match(/^\[mcp_servers\.user-tool\]$/gm)).toHaveLength(1);
      expect(readMcpState(overlayHome).owned).toEqual([]);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });
});
