import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";

import { CODEX_MCP_CONFIG_STATE_FILE, reconcileCodexMcpConfig } from "./codexMcpConfig";

const SOURCE = [
  'model = "gpt-5.5"',
  "",
  "[mcp_servers.user-tool]",
  'url = "http://127.0.0.1:2222/user-tool"',
].join("\n");

const ROBLOX_SERVER = ["[mcp_servers.roblox]", 'command = "roblox-studio-mcp"'].join("\n");

function serversOf(config: string): Record<string, unknown> {
  const parsed = parse(config, { integersAsBigInt: true });
  return (parsed.mcp_servers ?? {}) as Record<string, unknown>;
}

function stateOf(stateText: string): { applied: Record<string, string>; owned: string[] } {
  return JSON.parse(stateText) as { applied: Record<string, string>; owned: string[] };
}

/** Applies one refresh and returns the overlay + bookkeeping the refresh persisted. */
function refresh(input: {
  readonly source: string;
  readonly overlay?: string;
  readonly state?: string;
  readonly managed?: readonly string[];
}) {
  return reconcileCodexMcpConfig({
    sourceConfig: input.source,
    ...(input.overlay !== undefined ? { overlayConfig: input.overlay } : {}),
    ...(input.state !== undefined ? { stateText: input.state } : {}),
    managedServerNames: input.managed ?? [],
  });
}

describe("reconcileCodexMcpConfig", () => {
  it("keeps a user-added MCP server across refresh cycles", () => {
    // First refresh seeds the overlay and bookkeeping from the source config.
    const first = refresh({ source: SOURCE });
    expect(serversOf(first.config)).toHaveProperty("user-tool");

    // Codex `config/value/write` appends the new server to the overlay only.
    const overlay = `${first.config}\n\n${ROBLOX_SERVER}\n`;
    const second = refresh({ source: SOURCE, overlay, state: first.stateText });

    expect(serversOf(second.config)).toHaveProperty("roblox");
    expect(second.config).toContain('command = "roblox-studio-mcp"');
    expect(stateOf(second.stateText).owned).toContain("roblox");

    // The next refresh must keep preserving it, not just the first one.
    const third = refresh({ source: SOURCE, overlay: second.config, state: second.stateText });
    expect(serversOf(third.config)).toHaveProperty("roblox");
  });

  it("preserves the user's divergent edit of a server that also exists in the source config", () => {
    const first = refresh({ source: SOURCE });
    const overlay = first.config.replace(
      'url = "http://127.0.0.1:2222/user-tool"',
      'url = "http://127.0.0.1:9999/user-tool"',
    );

    const second = refresh({ source: SOURCE, overlay, state: first.stateText });

    expect(second.config).toContain('url = "http://127.0.0.1:9999/user-tool"');
    expect(stateOf(second.stateText).owned).toContain("user-tool");
  });

  it("applies source changes for servers the user never touched", () => {
    const first = refresh({ source: SOURCE });
    const updatedSource = SOURCE.replace("http://127.0.0.1:2222", "http://127.0.0.1:3333");

    const second = refresh({
      source: updatedSource,
      overlay: first.config,
      state: first.stateText,
    });

    expect(second.config).toContain('url = "http://127.0.0.1:3333/user-tool"');
    expect(stateOf(second.stateText).owned).not.toContain("user-tool");
  });

  it("treats a server the source still has as unowned when the user did not edit it", () => {
    const first = refresh({ source: SOURCE });
    const second = refresh({ source: SOURCE, overlay: first.config, state: first.stateText });

    expect(stateOf(second.stateText).owned).toEqual([]);
    expect(second.config).toBe(SOURCE);
  });

  it("remembers a user deletion instead of reviving it from the source config", () => {
    const first = refresh({ source: SOURCE });
    // Codex `config/value/write` with mergeStrategy "replace" removes the table.
    const overlay = first.config.slice(0, first.config.indexOf("[mcp_servers.user-tool]"));

    const second = refresh({ source: SOURCE, overlay, state: first.stateText });

    expect(serversOf(second.config)).not.toHaveProperty("user-tool");
    expect(stateOf(second.stateText).owned).toContain("user-tool");

    const third = refresh({ source: SOURCE, overlay: second.config, state: second.stateText });
    expect(serversOf(third.config)).not.toHaveProperty("user-tool");
  });

  it("strips the Synara-managed server table and never records it as user-owned", () => {
    const source = [SOURCE, "", "[mcp_servers.synara]", 'url = "http://127.0.0.1:1111/stale"'].join(
      "\n",
    );

    const result = refresh({ source, managed: ["synara"] });

    expect(serversOf(result.config)).not.toHaveProperty("synara");
    expect(serversOf(result.config)).toHaveProperty("user-tool");
    expect(stateOf(result.stateText).owned).not.toContain("synara");
    expect(stateOf(result.stateText).applied).not.toHaveProperty("synara");
  });

  it("adopts existing overlay MCP servers when no bookkeeping exists yet", () => {
    // Upgrading from a Synara build that recreated the overlay on every refresh:
    // the only surviving evidence is the overlay itself.
    const overlay = [SOURCE, "", ROBLOX_SERVER, ""].join("\n");

    const result = refresh({ source: SOURCE, overlay });

    expect(serversOf(result.config)).toHaveProperty("roblox");
    expect(stateOf(result.stateText).owned).toContain("roblox");
    expect(stateOf(result.stateText).owned).not.toContain("user-tool");
  });

  it("refuses to discard MCP edits when the overlay vanished but bookkeeping exists", () => {
    const first = refresh({ source: SOURCE });

    expect(() => refresh({ source: SOURCE, state: first.stateText })).toThrow(
      /refusing to discard MCP edits/i,
    );
  });

  it("tolerates a missing source config", () => {
    const result = refresh({ source: "", overlay: `${ROBLOX_SERVER}\n` });

    expect(serversOf(result.config)).toHaveProperty("roblox");
  });

  it("preserves unchanged source formatting while no MCP edits exist", () => {
    const source = `# keep this comment\n${SOURCE}\n`;
    const result = refresh({ source, managed: [] });

    expect(result.config).toBe(source);
  });
});

describe("CODEX_MCP_CONFIG_STATE_FILE", () => {
  it("names the bookkeeping file the overlay must exclude from symlinking", () => {
    expect(CODEX_MCP_CONFIG_STATE_FILE).toBe("synara-mcp-config-state-v1.json");
  });
});
