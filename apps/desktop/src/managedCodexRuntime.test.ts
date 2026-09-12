import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureBundledCodexRuntime,
  settingsUseManagedCodexRuntime,
} from "./managedCodexRuntime";
import type { ManagedCodexRuntimeManifest } from "@synara/shared/managedCodexRuntime";

const temporaryRoots: string[] = [];

function makeFixture(version = "1.2.3") {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-managed-codex-test-"));
  temporaryRoots.push(root);
  const payload = Path.join(root, "fixture", "payload");
  const executables = [
    "bin/codex-luna-max-fast",
    "bin/codex-luna-max-fast.real",
    "bin/codex-code-mode-host",
    "bin/update-codex-luna-max-fast",
    "codex-path/rg",
    "codex-resources/zsh/bin/zsh",
  ];
  for (const relativePath of executables) {
    const filePath = Path.join(payload, relativePath);
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    const contents =
      relativePath === "bin/codex-luna-max-fast.real"
        ? `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`
        : relativePath === "bin/codex-luna-max-fast"
          ? `#!/bin/sh\nexec "$(dirname "$0")/codex-luna-max-fast.real" "$@"\n`
          : "#!/bin/sh\nexit 0\n";
    FS.writeFileSync(filePath, contents, { mode: 0o755 });
  }
  FS.writeFileSync(Path.join(payload, "VERSION"), `${version}\n`);
  FS.writeFileSync(Path.join(payload, "OPENAI_CODEX_LICENSE"), "license\n");
  FS.writeFileSync(Path.join(payload, "OPENAI_CODEX_NOTICE"), "notice\n");

  const archivePath = Path.join(root, "runtime.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", archivePath, "-C", Path.join(root, "fixture"), "payload"]);
  const sha256 = createHash("sha256").update(FS.readFileSync(archivePath)).digest("hex");
  const manifest: ManagedCodexRuntimeManifest = {
    version,
    assetFileName: Path.basename(archivePath),
    sha256,
    downloadUrl: "https://example.invalid/runtime.tar.gz",
  };
  return { archivePath, baseDir: Path.join(root, "home"), manifest };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    FS.rmSync(root, { recursive: true, force: true });
  }
});

describe("ensureBundledCodexRuntime", () => {
  it("installs the verified payload and makes it the default codex command", async () => {
    const fixture = makeFixture();

    await expect(
      ensureBundledCodexRuntime({
        ...fixture,
        platform: "darwin",
        arch: "arm64",
      }),
    ).resolves.toEqual({
      status: "installed",
      binaryPath: Path.join(fixture.baseDir, "bin", "codex"),
    });

    expect(FS.readlinkSync(Path.join(fixture.baseDir, "bin", "codex"))).toBe(
      "codex-luna-max-fast",
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: Path.join(Path.dirname(fixture.baseDir), "unrelated-home"),
      SYNARA_CODEX_AUTO_UPDATE: "0",
    };
    delete env.SYNARA_LUNA_HOME;
    expect(
      execFileSync(Path.join(fixture.baseDir, "bin", "codex"), ["--version"], {
        encoding: "utf8",
        env,
      }),
    ).toBe("codex-cli 1.2.3\n");
    expect(FS.readFileSync(Path.join(fixture.baseDir, "codex-luna-max-fast", "version"), "utf8"))
      .toBe("1.2.3\n");
    expect(
      FS.readFileSync(
        Path.join(fixture.baseDir, "codex-luna-max-fast", "OPENAI_CODEX_LICENSE"),
        "utf8",
      ),
    ).toBe("license\n");
  });

  it("keeps a complete newer runtime when the embedded archive is unavailable", async () => {
    const fixture = makeFixture();
    await ensureBundledCodexRuntime({
      ...fixture,
      platform: "darwin",
      arch: "arm64",
    });
    FS.writeFileSync(Path.join(fixture.baseDir, "codex-luna-max-fast", "version"), "2.0.0\n");

    await expect(
      ensureBundledCodexRuntime({
        ...fixture,
        archivePath: null,
        platform: "darwin",
        arch: "arm64",
      }),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("reinstalls a same-version runtime when its pinned archive changed", async () => {
    const fixture = makeFixture();
    await ensureBundledCodexRuntime({
      ...fixture,
      platform: "darwin",
      arch: "arm64",
    });
    FS.writeFileSync(
      Path.join(fixture.baseDir, "codex-luna-max-fast", "archive.sha256"),
      `${"0".repeat(64)}\n`,
    );

    await expect(
      ensureBundledCodexRuntime({
        ...fixture,
        manifest: {
          ...fixture.manifest,
          supersededSha256s: ["0".repeat(64)],
        },
        platform: "darwin",
        arch: "arm64",
      }),
    ).resolves.toMatchObject({ status: "installed" });
  });

  it("keeps an unknown same-version runtime installed by the verified update feed", async () => {
    const fixture = makeFixture();
    await ensureBundledCodexRuntime({
      ...fixture,
      platform: "darwin",
      arch: "arm64",
    });
    FS.writeFileSync(
      Path.join(fixture.baseDir, "codex-luna-max-fast", "archive.sha256"),
      `${"1".repeat(64)}\n`,
    );

    await expect(
      ensureBundledCodexRuntime({
        ...fixture,
        manifest: {
          ...fixture.manifest,
          supersededSha256s: ["0".repeat(64)],
        },
        platform: "darwin",
        arch: "arm64",
      }),
    ).resolves.toMatchObject({ status: "ready" });
  });
});

describe("settingsUseManagedCodexRuntime", () => {
  it("uses the managed default without replacing an explicit custom binary", () => {
    expect(settingsUseManagedCodexRuntime({}, "/managed/codex")).toBe(true);
    expect(
      settingsUseManagedCodexRuntime(
        { settings: { providers: { codex: { binaryPath: "codex" } } } },
        "/managed/codex",
      ),
    ).toBe(true);
    expect(
      settingsUseManagedCodexRuntime(
        { settings: { providers: { codex: { binaryPath: "/managed/codex" } } } },
        "/managed/codex",
      ),
    ).toBe(true);
    expect(
      settingsUseManagedCodexRuntime(
        { settings: { providers: { codex: { binaryPath: "/custom/codex" } } } },
        "/managed/codex",
      ),
    ).toBe(false);
  });
});
