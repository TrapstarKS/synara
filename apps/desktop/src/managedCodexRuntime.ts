// FILE: managedCodexRuntime.ts
// Purpose: Installs the pinned Luna Max Fast Codex runtime embedded in the macOS app.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  MANAGED_CODEX_RUNTIME_MANIFEST,
  type ManagedCodexRuntimeManifest,
} from "@synara/shared/managedCodexRuntime";

const EXECUTABLES = [
  "bin/codex-luna-max-fast",
  "bin/codex-luna-max-fast.real",
  "bin/codex-code-mode-host",
  "bin/update-codex-luna-max-fast",
  "codex-path/rg",
  "codex-resources/zsh/bin/zsh",
] as const;

const PAYLOAD_FILES = [
  ...EXECUTABLES.map((relativePath) => ({ relativePath, mode: 0o755 })),
  { relativePath: "OPENAI_CODEX_LICENSE", mode: 0o644 },
  { relativePath: "OPENAI_CODEX_NOTICE", mode: 0o644 },
] as const;

export type ManagedCodexRuntimeStatus = "installed" | "ready" | "unavailable" | "unsupported";

export interface ManagedCodexRuntimeResult {
  readonly status: ManagedCodexRuntimeStatus;
  readonly binaryPath?: string;
}

export function settingsUseManagedCodexRuntime(
  raw: unknown,
  managedBinaryPath: string,
): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
  const envelope = raw as Record<string, unknown>;
  const settings =
    envelope.settings && typeof envelope.settings === "object" && !Array.isArray(envelope.settings)
      ? (envelope.settings as Record<string, unknown>)
      : envelope;
  const providers = settings.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return true;
  const codex = (providers as Record<string, unknown>).codex;
  if (!codex || typeof codex !== "object" || Array.isArray(codex)) return true;
  const configured = (codex as Record<string, unknown>).binaryPath;
  if (typeof configured !== "string" || !configured.trim() || configured.trim() === "codex") {
    return true;
  }
  return Path.resolve(configured.trim()) === Path.resolve(managedBinaryPath);
}

function runFile(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: options.timeout ?? 30_000,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[+-][0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(candidate: string, minimum: string): boolean {
  const parsedCandidate = parseVersion(candidate);
  const parsedMinimum = parseVersion(minimum);
  if (!parsedCandidate || !parsedMinimum) return false;
  for (let index = 0; index < parsedCandidate.length; index += 1) {
    if (parsedCandidate[index]! > parsedMinimum[index]!) return true;
    if (parsedCandidate[index]! < parsedMinimum[index]!) return false;
  }
  return true;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const stat = await FS.stat(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function hasUsableInstalledRuntime(baseDir: string, minimumVersion: string): Promise<boolean> {
  const versionPath = Path.join(baseDir, "codex-luna-max-fast", "version");
  let installedVersion: string;
  try {
    installedVersion = await FS.readFile(versionPath, "utf8");
  } catch {
    return false;
  }
  if (!versionAtLeast(installedVersion, minimumVersion)) return false;
  const executableChecks = await Promise.all(
    EXECUTABLES.map((relativePath) => isExecutable(Path.join(baseDir, relativePath))),
  );
  return executableChecks.every(Boolean);
}

function assertSafeArchiveEntries(entries: string): void {
  for (const rawEntry of entries.split("\n")) {
    const entry = rawEntry.trim().replace(/\/$/, "");
    if (!entry) continue;
    if (
      Path.posix.isAbsolute(entry) ||
      entry === ".." ||
      entry.startsWith("../") ||
      entry.endsWith("/..") ||
      entry.includes("/../") ||
      (entry !== "payload" && !entry.startsWith("payload/"))
    ) {
      throw new Error(`Bundled Codex runtime contains an unsafe path: ${rawEntry}`);
    }
  }
}

async function writeAtomically(filePath: string, contents: string, mode: number): Promise<void> {
  const pendingPath = `${filePath}.next-${process.pid}-${randomBytes(4).toString("hex")}`;
  await FS.mkdir(Path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await FS.writeFile(pendingPath, contents, { encoding: "utf8", mode });
    await FS.rename(pendingPath, filePath);
  } finally {
    await FS.rm(pendingPath, { force: true });
  }
}

async function installFile(sourcePath: string, destinationPath: string, mode: number): Promise<void> {
  const pendingPath = `${destinationPath}.next-${process.pid}-${randomBytes(4).toString("hex")}`;
  await FS.mkdir(Path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  try {
    await FS.copyFile(sourcePath, pendingPath);
    await FS.chmod(pendingPath, mode);
    await FS.rename(pendingPath, destinationPath);
  } finally {
    await FS.rm(pendingPath, { force: true });
  }
}

async function ensureDefaultCodexAlias(baseDir: string): Promise<string> {
  const binaryPath = Path.join(baseDir, "bin", "codex");
  const pendingPath = `${binaryPath}.next-${process.pid}-${randomBytes(4).toString("hex")}`;
  await FS.mkdir(Path.dirname(binaryPath), { recursive: true, mode: 0o700 });
  try {
    await FS.symlink("codex-luna-max-fast", pendingPath);
    await FS.rename(pendingPath, binaryPath);
  } finally {
    await FS.rm(pendingPath, { force: true });
  }
  return binaryPath;
}

export async function ensureBundledCodexRuntime(input: {
  readonly archivePath: string | null;
  readonly baseDir: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly manifest?: ManagedCodexRuntimeManifest;
}): Promise<ManagedCodexRuntimeResult> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") {
    return { status: "unsupported" };
  }
  const manifest = input.manifest ?? MANAGED_CODEX_RUNTIME_MANIFEST;
  if (await hasUsableInstalledRuntime(input.baseDir, manifest.version)) {
    return {
      status: "ready",
      binaryPath: await ensureDefaultCodexAlias(input.baseDir),
    };
  }
  if (!input.archivePath) {
    return { status: "unavailable" };
  }

  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error("Bundled Codex runtime checksum is malformed.");
  }
  if ((await sha256File(input.archivePath)) !== manifest.sha256) {
    throw new Error("Bundled Codex runtime checksum does not match the pinned release.");
  }

  const archiveEntries = await runFile("/usr/bin/tar", ["-tzf", input.archivePath]);
  assertSafeArchiveEntries(archiveEntries);
  const temporaryRoot = await FS.mkdtemp(Path.join(OS.tmpdir(), "synara-codex-runtime-"));
  try {
    await runFile("/usr/bin/tar", ["-xzf", input.archivePath, "-C", temporaryRoot]);
    const payloadRoot = Path.join(temporaryRoot, "payload");
    const version = (await FS.readFile(Path.join(payloadRoot, "VERSION"), "utf8")).trim();
    if (version !== manifest.version) {
      throw new Error(
        `Bundled Codex runtime reports version ${version || "unknown"}; expected ${manifest.version}.`,
      );
    }
    for (const relativePath of EXECUTABLES) {
      if (!(await isExecutable(Path.join(payloadRoot, relativePath)))) {
        throw new Error(`Bundled Codex runtime is missing executable ${relativePath}.`);
      }
    }
    const reportedVersion = (
      await runFile(Path.join(payloadRoot, "bin", "codex-luna-max-fast.real"), ["--version"], {
        timeout: 5_000,
      })
    ).trim();
    if (reportedVersion !== `codex-cli ${manifest.version}`) {
      throw new Error(`Bundled Codex runtime version check returned: ${reportedVersion || "empty"}.`);
    }

    for (const { relativePath, mode } of PAYLOAD_FILES) {
      await installFile(
        Path.join(payloadRoot, relativePath),
        Path.join(input.baseDir, relativePath),
        mode,
      );
    }
    await writeAtomically(
      Path.join(input.baseDir, "codex-luna-max-fast", "archive.sha256"),
      `${manifest.sha256}\n`,
      0o600,
    );
    await writeAtomically(
      Path.join(input.baseDir, "codex-luna-max-fast", "version"),
      `${manifest.version}\n`,
      0o600,
    );
    return {
      status: "installed",
      binaryPath: await ensureDefaultCodexAlias(input.baseDir),
    };
  } finally {
    await FS.rm(temporaryRoot, { recursive: true, force: true });
  }
}
