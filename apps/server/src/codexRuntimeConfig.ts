// Process-scoped integration settings for the official Codex app-server.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { buildCodexMcpConfigOverrides } from "./agentGateway/mcpInjection.ts";

export const SYNARA_COMPETING_BROWSER_PLUGIN_NAMES = [
  "browser@openai-bundled",
  "chrome@openai-bundled",
  "computer-use@openai-bundled",
] as const;

export async function buildCodexRuntimeConfig(input: {
  readonly homePath: string;
  readonly endpointUrl?: string;
}): Promise<{ readonly configOverrides: string[]; readonly gatewayMcpServerName?: string }> {
  const source = await fs
    .readFile(path.join(input.homePath, "config.toml"), "utf8")
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
  const plugins = parse(source).plugins;
  const names = new Set<string>(SYNARA_COMPETING_BROWSER_PLUGIN_NAMES);
  if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
    for (const name of Object.keys(plugins)) {
      if (/^[a-z0-9][a-z0-9-]{5}-browser@local$/.test(name)) names.add(name);
    }
  }
  // CLI dotted keys are not TOML headers: quoting a segment would become part
  // of its literal name. These known plugin keys contain no dots or '='.
  const configOverrides = [...names].map((name) => `plugins.${name}.enabled=false`);
  if (!input.endpointUrl) return { configOverrides };
  // A fresh namespace avoids merging an old stdio entry (including a project
  // entry) with our HTTP transport. No native user configuration is rewritten.
  const gatewayMcpServerName = `synara_${randomBytes(4).toString("hex")}`;
  configOverrides.push(...buildCodexMcpConfigOverrides(input.endpointUrl, gatewayMcpServerName));
  return { configOverrides, gatewayMcpServerName };
}
