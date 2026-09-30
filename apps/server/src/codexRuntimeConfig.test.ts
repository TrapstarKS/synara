import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import {
  buildCodexRuntimeConfig,
  SYNARA_COMPETING_BROWSER_PLUGIN_NAMES,
} from "./codexRuntimeConfig.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home(config: string) {
  const root = mkdtempSync(path.join(tmpdir(), "synara-codex-process-config-"));
  roots.push(root);
  writeFileSync(path.join(root, "config.toml"), config);
  return root;
}

describe("process-local Codex configuration", () => {
  it("isolates gateway settings without rewriting a user's existing stdio entry or shell filters", async () => {
    const source =
      '[mcp_servers.synara]\ncommand="external-bridge"\nargs=["serve"]\n[shell_environment_policy]\nexclude=["PRIVATE_*"]\n[plugins."browser@openai-bundled"]\nenabled=true\n';
    const homePath = home(source);
    const first = await buildCodexRuntimeConfig({
      homePath,
      endpointUrl: "http://127.0.0.1:3773/mcp",
    });
    const second = await buildCodexRuntimeConfig({
      homePath,
      endpointUrl: "http://127.0.0.1:4884/mcp",
    });
    expect(first.gatewayMcpServerName).toMatch(/^synara_[a-f0-9]{8}$/);
    expect(second.gatewayMcpServerName).not.toBe(first.gatewayMcpServerName);
    const config = parse(
      first.configOverrides.filter((value) => !value.startsWith("plugins.")).join("\n"),
    );
    expect(config.mcp_servers).toEqual({
      [first.gatewayMcpServerName!]: {
        url: "http://127.0.0.1:3773/mcp",
        bearer_token_env_var: "SYNARA_AGENT_GATEWAY_TOKEN",
      },
    });
    expect(config.shell_environment_policy).toEqual({ set: { SYNARA_AGENT_GATEWAY_TOKEN: "" } });
    for (const plugin of SYNARA_COMPETING_BROWSER_PLUGIN_NAMES) {
      expect(first.configOverrides).toContain(`plugins.${plugin}.enabled=false`);
    }
    expect(readFileSync(path.join(homePath, "config.toml"), "utf8")).toBe(source);
  });

  it("keeps discovery secret-free and disables known competing local browser plugins per process", async () => {
    const homePath = home(
      '[plugins."abcdef-browser@local"]\nenabled=true\n[plugins."user-plugin@local"]\nenabled=true\n',
    );
    const config = await buildCodexRuntimeConfig({ homePath });
    expect(config.gatewayMcpServerName).toBeUndefined();
    expect(config.configOverrides).toContain("plugins.abcdef-browser@local.enabled=false");
    expect(config.configOverrides.join("\n")).not.toContain("user-plugin");
    expect(config.configOverrides.join("\n")).not.toContain("GATEWAY_TOKEN");
  });
});
