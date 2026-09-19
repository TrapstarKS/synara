// Native archive regression: exercise the pinned builder and macOS signing tools.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { finalizeMacUpdateZip } from "./lib/mac-update-zip-finalize.ts";
import { assertMacUpdateManifestZipMetadata } from "./lib/mac-update-zip.ts";

const roots: string[] = [];
const zipFileName = "Synara-0.0.1-arm64.zip";
const originalManifest = `version: 0.0.1
files:
  - url: ${zipFileName}
    sha512: oldzip
    size: 1
    blockMapSize: 50
  - url: Synara-0.0.1-arm64.dmg
    sha512: unchanged-dmg
    size: 200
path: ${zipFileName}
sha512: oldzip
`;

function command(program: string, args: string[], cwd?: string): void {
  execFileSync(program, args, { cwd, stdio: "pipe", timeout: 20000 });
}

function plist(executable: string, identifier: string, kind: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundlePackageType</key><string>${kind}</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synara-zip-finalize-"));
  roots.push(root);
  const app = join(root, "mac", "Synara.app");
  const contents = join(app, "Contents");
  const framework = join(contents, "Frameworks", "Electron Framework.framework");
  const frameworkVersion = join(framework, "Versions", "A");
  for (const directory of [
    join(contents, "MacOS"),
    join(contents, "Resources"),
    ...["Helpers", "Libraries", "Resources"].map((name) => join(frameworkVersion, name)),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  cpSync("/usr/bin/true", join(contents, "MacOS", "Synara"));
  cpSync("/usr/bin/true", join(frameworkVersion, "Electron Framework"));
  writeFileSync(join(contents, "Info.plist"), plist("Synara", "test.synara.zip", "APPL"));
  writeFileSync(
    join(frameworkVersion, "Resources", "Info.plist"),
    plist("Electron Framework", "test.synara.framework", "FMWK"),
  );
  writeFileSync(join(contents, "Resources", "payload.txt"), "signed payload");
  symlinkSync("A", join(framework, "Versions", "Current"));
  for (const name of ["Electron Framework", "Helpers", "Libraries", "Resources"]) {
    symlinkSync(`Versions/Current/${name}`, join(framework, name));
  }
  command("codesign", ["--force", "--sign", "-", "--timestamp=none", framework]);
  command("codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
  command("codesign", ["--verify", "--deep", "--strict", app]);
  const zipPath = join(root, zipFileName);
  const manifestPath = join(root, "latest-mac.yml");
  writeFileSync(manifestPath, originalManifest);
  writeFileSync(`${zipPath}.blockmap`, "remove for full-archive updates");
  return { root, app, zipPath, manifestPath };
}

async function builderZip(zipPath: string, app: string): Promise<void> {
  const requireFromScripts = createRequire(new URL("./package.json", import.meta.url));
  const requireFromBuilder = createRequire(requireFromScripts.resolve("electron-builder/cli.js"));
  const { archive } = requireFromBuilder("app-builder-lib/out/targets/archive.js") as {
    archive(
      format: string,
      out: string,
      source: string,
      options: Record<string, unknown>,
    ): Promise<string>;
  };
  await archive("zip", zipPath, app, {
    compression: "normal",
    withoutDir: false,
    preserveSymlinks: true,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")("macOS update archive finalization", () => {
  it("reuses byte-identical builder output after real original and extracted signature checks", async () => {
    const { root, app, zipPath, manifestPath } = fixture();
    await builderZip(zipPath, app);
    const originalZip = readFileSync(zipPath);
    const result = await finalizeMacUpdateZip({ stageDistDir: root, signed: true });
    expect(result.repacked).toBe(false);
    expect(readFileSync(zipPath)).toEqual(originalZip);
    expect(result.size).toBe(statSync(zipPath).size);
    expect(result.sha512).toBe(createHash("sha512").update(originalZip).digest("base64"));
    expect(existsSync(`${zipPath}.blockmap`)).toBe(false);
    const manifest = readFileSync(manifestPath, "utf8");
    expect(manifest).toContain("sha512: unchanged-dmg");
    expect(manifest).not.toContain("blockMapSize");
    assertMacUpdateManifestZipMetadata(manifest, zipFileName, result);
  }, 30_000);

  it("repairs a legacy flattened archive with ditto and validates the signed result", async () => {
    const { root, app, zipPath, manifestPath } = fixture();
    command("zip", ["-q", "-r", zipPath, "Synara.app"], dirname(app));
    const result = await finalizeMacUpdateZip({ stageDistDir: root, signed: true });
    expect(result.repacked).toBe(true);
    assertMacUpdateManifestZipMetadata(readFileSync(manifestPath, "utf8"), zipFileName, result);
  }, 30_000);

  it("rejects a corrupt archive without repairing it or publishing new metadata", async () => {
    const { root, zipPath, manifestPath } = fixture();
    writeFileSync(zipPath, "not a zip archive");
    await expect(finalizeMacUpdateZip({ stageDistDir: root, signed: true })).rejects.toThrow(
      /unzip .* failed/,
    );
    expect(readFileSync(zipPath, "utf8")).toBe("not a zip archive");
    expect(readFileSync(manifestPath, "utf8")).toBe(originalManifest);
  }, 30_000);

  it("rejects changed signed resources in the archive even when its symlinks are valid", async () => {
    const { root, app, zipPath, manifestPath } = fixture();
    const alteredRoot = mkdtempSync(join(tmpdir(), "synara-zip-altered-"));
    roots.push(alteredRoot);
    const alteredApp = join(alteredRoot, "Synara.app");
    cpSync(app, alteredApp, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(alteredApp, "Contents", "Resources", "payload.txt"), "tampered payload");
    await builderZip(zipPath, alteredApp);
    const originalZip = readFileSync(zipPath);
    await expect(finalizeMacUpdateZip({ stageDistDir: root, signed: true })).rejects.toThrow(
      /codesign .*synara-mac-update-zip-.* failed/,
    );
    expect(readFileSync(zipPath)).toEqual(originalZip);
    expect(readFileSync(manifestPath, "utf8")).toBe(originalManifest);
  }, 30_000);
});
