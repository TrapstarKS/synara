import { describe, expect, it } from "vitest";

import { type AppSettings, AppSettingsSchema } from "~/appSettings";

import {
  createProviderInstallResetPatch,
  isProviderInstallSettingsDirty,
  providerInstanceLaunchConfigFor,
} from "./ProvidersSettingsPanel";

const defaults = AppSettingsSchema.makeUnsafe({});

describe("isProviderInstallSettingsDirty", () => {
  it("covers every provider install text and boolean field", () => {
    const dirtyPatches = [
      { codexBinaryPath: "/opt/codex" },
      { codexHomePath: "/tmp/codex-home" },
      { claudeBinaryPath: "/opt/claude" },
      { cursorBinaryPath: "/opt/cursor" },
      { cursorApiEndpoint: "https://cursor.example" },
      { devinBinaryPath: "/opt/devin" },
      { antigravityBinaryPath: "/opt/agy" },
      { grokBinaryPath: "/opt/grok" },
      { droidBinaryPath: "/opt/droid" },
      { openCodeBinaryPath: "/opt/opencode" },
      { openCodeServerUrl: "http://127.0.0.1:5001" },
      { openCodeExperimentalWebSockets: true },
      { claudeEnableArtifacts: true },
      { claudeEnableChrome: true },
      { piBinaryPath: "/opt/pi" },
      { piAgentDir: "/tmp/pi-agent" },
      { chatGptTunnelMode: "cloudflared" },
      { chatGptTunnelBinaryPath: "/opt/cloudflared" },
      { chatGptOpenAiTunnelId: "tunnel_0123456789abcdef0123456789abcdef" },
    ] satisfies ReadonlyArray<Partial<AppSettings>>;

    expect(isProviderInstallSettingsDirty(defaults, defaults)).toBe(false);
    for (const patch of dirtyPatches) {
      expect(isProviderInstallSettingsDirty({ ...defaults, ...patch }, defaults)).toBe(true);
    }
  });

  it("uses configured flags instead of unreadable password values", () => {
    expect(
      isProviderInstallSettingsDirty({ ...defaults, openCodeServerPassword: "secret" }, defaults),
    ).toBe(false);
    expect(
      isProviderInstallSettingsDirty(
        { ...defaults, openCodeServerPasswordConfigured: true },
        defaults,
      ),
    ).toBe(true);
    expect(
      isProviderInstallSettingsDirty(
        { ...defaults, chatGptOpenAiTunnelApiKeyConfigured: true },
        defaults,
      ),
    ).toBe(true);
  });
});

describe("createProviderInstallResetPatch", () => {
  it("resets every configured field and writes password values so configured flags clear", () => {
    const patch = createProviderInstallResetPatch({
      ...defaults,
      openCodeServerPassword: "",
    });

    expect(Object.keys(patch).sort()).toEqual(
      [
        "antigravityBinaryPath",
        "chatGptOpenAiTunnelApiKey",
        "chatGptOpenAiTunnelId",
        "chatGptTunnelBinaryPath",
        "chatGptTunnelMode",
        "claudeBinaryPath",
        "claudeEnableArtifacts",
        "claudeEnableChrome",
        "claudeHomePath",
        "codexAccounts",
        "codexBinaryPath",
        "codexHomePath",
        "cursorApiEndpoint",
        "cursorBinaryPath",
        "devinBinaryPath",
        "droidBinaryPath",
        "grokBinaryPath",
        "ompAgentDir",
        "ompBinaryPath",
        "openCodeBinaryPath",
        "openCodeExperimentalWebSockets",
        "openCodeServerPassword",
        "openCodeServerUrl",
        "piAgentDir",
        "piBinaryPath",
        "providerInstances",
        "selectedCodexAccountId",
      ].sort(),
    );
    expect(patch.openCodeServerPassword).toBe("");
    expect(patch.chatGptOpenAiTunnelApiKey).toBe("");
  });
});

describe("providerInstanceLaunchConfigFor", () => {
  it("maps Pi-family agent directories to agentDir, not binaryPath", () => {
    expect(
      providerInstanceLaunchConfigFor("omp", {
        ...defaults,
        ompBinaryPath: "/usr/local/bin/omp",
        ompAgentDir: "~/.omp-work/agent",
      }),
    ).toEqual({ binaryPath: "/usr/local/bin/omp", agentDir: "~/.omp-work/agent" });
    expect(
      providerInstanceLaunchConfigFor("pi", { ...defaults, piAgentDir: "~/.pi-work/agent" }),
    ).toEqual({ agentDir: "~/.pi-work/agent" });
  });

  it("keeps the Claude binary path and leaves the provider-wide Artifacts setting out", () => {
    expect(
      providerInstanceLaunchConfigFor("claudeAgent", {
        ...defaults,
        claudeBinaryPath: "/opt/homebrew/bin/claude",
        claudeEnableArtifacts: true,
      }),
    ).toEqual({ binaryPath: "/opt/homebrew/bin/claude" });
  });
});
