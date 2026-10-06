import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { migrateLegacyCodexHome } from "./codexLegacyHome.ts";
import { CODEX_MCP_CONFIG_STATE_FILE, reconcileCodexMcpConfig } from "./codexMcpConfig.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(profileId?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "synara-codex-native-home-"));
  roots.push(root);
  const homePath = profileId
    ? path.join(root, "secrets", "codex-profiles", profileId)
    : path.join(root, ".codex");
  const runtime = path.join(root, ".synara");
  const overlay = profileId
    ? path.join(runtime, "codex-home-overlays", profileId)
    : path.join(runtime, "codex-home-overlay");
  mkdirSync(homePath, { recursive: true });
  mkdirSync(overlay, { recursive: true });
  const configPath = path.join(homePath, "config.toml");
  const overlayConfigPath = path.join(overlay, "config.toml");
  const input = {
    env: { SYNARA_HOME: runtime },
    homePath,
  };
  return { root, homePath, runtime, overlay, configPath, overlayConfigPath, input };
}

describe("native Codex home migration", () => {
  it("recovers owned MCP changes/deletions once while preserving native config, auth and old files", async () => {
    const f = fixture();
    const original =
      '# user comment\nmodel = "user-model"\n[mcp_servers.keep]\ncommand="keep"\n[mcp_servers.edited]\ncommand="old"\n[mcp_servers.deleted]\ncommand="old"\n[mcp_servers.synara]\ncommand="user-bridge"\n';
    writeFileSync(f.configPath, original);
    writeFileSync(path.join(f.homePath, "auth.json"), "native-auth");
    const baseline = reconcileCodexMcpConfig({
      sourceConfig: original,
      managedServerNames: ["synara"],
    });
    writeFileSync(path.join(f.overlay, CODEX_MCP_CONFIG_STATE_FILE), baseline.stateText);
    const edited = parse(baseline.config);
    edited.mcp_servers = {
      keep: { command: "keep" },
      edited: { command: "new" },
      added: { url: "https://mcp.example" },
      synara: { url: "http://127.0.0.1:1/mcp", bearer_token_env_var: "SYNARA_AGENT_GATEWAY_TOKEN" },
    };
    writeFileSync(f.overlayConfigPath, stringify(edited));
    writeFileSync(path.join(f.overlay, "auth.json"), "obsolete-auth");
    mkdirSync(path.join(f.overlay, "sessions"));
    writeFileSync(path.join(f.overlay, "sessions", "history.jsonl"), "retained-history");
    await Promise.all(Array.from({ length: 4 }, () => migrateLegacyCodexHome(f.input)));
    const migrated = parse(readFileSync(f.configPath, "utf8"));
    expect(migrated.model).toBe("user-model");
    expect(migrated.mcp_servers).toEqual({
      keep: { command: "keep" },
      edited: { command: "new" },
      added: { url: "https://mcp.example" },
      synara: { command: "user-bridge" },
    });
    expect(readFileSync(path.join(f.homePath, "auth.json"), "utf8")).toBe("native-auth");
    expect(readFileSync(path.join(f.overlay, "sessions", "history.jsonl"), "utf8")).toBe(
      "retained-history",
    );
    const backup = readdirSync(f.overlay).find((name) => name.endsWith("-backup.toml"))!;
    expect(readFileSync(path.join(f.overlay, backup), "utf8")).toBe(original);
    writeFileSync(
      f.configPath,
      '# edited in official Codex after migration\nmodel="new-native-model"\n',
    );
    await migrateLegacyCodexHome(f.input);
    expect(readFileSync(f.configPath, "utf8")).toContain('model="new-native-model"');
    expect(readFileSync(f.configPath, "utf8")).not.toContain("mcp_servers");
  });

  it("migrates a migrated profile home's legacy overlay only", async () => {
    const f = fixture("be54e3c8-c56b-4113-8257-a9090d97b936");
    writeFileSync(f.configPath, 'cli_auth_credentials_store="file"\n');
    writeFileSync(f.overlayConfigPath, '[mcp_servers.mine]\ncommand="my-profile-tool"\n');
    const other = path.join(f.runtime, "codex-home-overlay");
    mkdirSync(other);
    writeFileSync(
      path.join(other, "config.toml"),
      '[mcp_servers.other]\ncommand="other-account"\n',
    );
    await migrateLegacyCodexHome(f.input);
    expect(parse(readFileSync(f.configPath, "utf8")).mcp_servers).toEqual({
      mine: { command: "my-profile-tool" },
    });
    expect(readdirSync(other)).toEqual(["config.toml"]);
  });

  it("retains source bytes and remains retryable after malformed legacy state", async () => {
    const f = fixture();
    const original = '# native file\nmodel="keep-me"\n';
    writeFileSync(f.configPath, original);
    writeFileSync(f.overlayConfigPath, '[mcp_servers.saved]\ncommand="saved-tool"\n');
    const statePath = path.join(f.overlay, CODEX_MCP_CONFIG_STATE_FILE);
    writeFileSync(statePath, "invalid-json");
    await expect(migrateLegacyCodexHome(f.input)).rejects.toThrow();
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
    rmSync(statePath);
    await migrateLegacyCodexHome(f.input);
    expect(parse(readFileSync(f.configPath, "utf8")).mcp_servers).toEqual({
      saved: { command: "saved-tool" },
    });
  });

  it("does not create an overlay or native config on a fresh install", async () => {
    const f = fixture();
    rmSync(f.overlay, { recursive: true });
    await migrateLegacyCodexHome(f.input);
    expect(existsSync(f.overlay)).toBe(false);
    expect(existsSync(f.configPath)).toBe(false);
  });
});
