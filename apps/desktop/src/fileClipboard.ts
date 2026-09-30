// FILE: fileClipboard.ts
// Purpose: Stages scoped renderer downloads for native file copy without opening host paths.
// Layer: Desktop clipboard boundary

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_DESKTOP_CLIPBOARD_FILE_BYTES, type DesktopClipboardFile } from "@synara/contracts";
import { resolveWindowsPowerShellExecutable } from "@synara/shared/platformEnvironment";
import { execProcessFile } from "@synara/shared/processRuntime";
import type { Clipboard, IpcMain } from "electron";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const MAX_CACHED_FILES = 4;
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
const STAGING_DIRECTORY_PATTERN = /^copy-[a-zA-Z0-9]{6}$/;

// The filename is data in the child environment, never interpolated into PowerShell.
// SetFileDropList uses the native FileDrop format and persists it after the STA exits.
const WINDOWS_COPY_FILE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$synaraFiles = New-Object System.Collections.Specialized.StringCollection",
  "[void]$synaraFiles.Add($env:SYNARA_CLIPBOARD_FILE)",
  "[System.Windows.Forms.Clipboard]::SetFileDropList($synaraFiles)",
].join("\n");

export function parseClipboardFile(value: unknown): DesktopClipboardFile | null {
  if (!value || typeof value !== "object") return null;
  const { name, bytes } = value as Partial<DesktopClipboardFile>;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    Buffer.byteLength(name, "utf8") > 240 ||
    name === "." ||
    name === ".." ||
    /[\x00-\x1f\x7f/\\]/u.test(name) ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > MAX_DESKTOP_CLIPBOARD_FILE_BYTES
  ) {
    return null;
  }
  return { name, bytes };
}

function stagingFilename(name: string): string {
  const portable = name.replace(/[<>:"|?*]/gu, "_").replace(/[. ]+$/u, "") || "file";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(portable)
    ? `_${portable}`
    : portable;
}

export async function writeNativeClipboardFile(
  filePath: string,
  options: {
    platform: NodeJS.Platform;
    clipboard: Pick<Clipboard, "writeBuffer" | "readBuffer">;
    execFile?: typeof execProcessFile;
  },
): Promise<boolean> {
  if (options.platform === "win32") {
    const execFile = options.execFile ?? execProcessFile;
    return new Promise((resolve) => {
      try {
        execFile(
          resolveWindowsPowerShellExecutable(),
          [
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-EncodedCommand",
            Buffer.from(WINDOWS_COPY_FILE_SCRIPT, "utf16le").toString("base64"),
          ],
          {
            platform: options.platform,
            env: { ...process.env, SYNARA_CLIPBOARD_FILE: filePath },
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer: 4096,
          },
          (error) => resolve(error === null),
        );
      } catch {
        resolve(false);
      }
    });
  }
  const format = options.platform === "darwin" ? "public.file-url" : "text/uri-list";
  const data = Buffer.from(
    pathToFileURL(filePath).href + (options.platform === "darwin" ? "" : "\r\n"),
    "utf8",
  );
  try {
    options.clipboard.writeBuffer(format, data);
    // Inspect only the format we just wrote; never read or log previous clipboard data.
    return options.clipboard.readBuffer(format).equals(data);
  } catch {
    return false;
  }
}

async function pruneClipboardFiles(directory: string, keep: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && STAGING_DIRECTORY_PATTERN.test(entry.name))
      .map(async (entry) => {
        const candidate = path.join(directory, entry.name);
        const stats = await fs.stat(candidate);
        return { path: candidate, modifiedAt: stats.mtimeMs };
      }),
  );
  const previousCopies = candidates.filter((candidate) => candidate.path !== keep);
  previousCopies.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const now = Date.now();
  for (const [index, candidate] of previousCopies.entries()) {
    if (index >= MAX_CACHED_FILES - 1 || now - candidate.modifiedAt > MAX_CACHE_AGE_MS) {
      await fs.rm(candidate.path, { recursive: true, force: true });
    }
  }
}

export function createFileClipboardWriter(options: {
  directory: string;
  writeFile: (filePath: string) => Promise<boolean>;
}): (input: unknown) => Promise<boolean> {
  let writing = false;
  return async (input) => {
    const file = parseClipboardFile(input);
    // Reject overlapping writes rather than retain multiple large IPC payloads in a queue.
    if (!file || writing) return false;
    writing = true;
    let stagingDirectory: string | undefined;
    let copied = false;
    try {
      await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
      stagingDirectory = await fs.mkdtemp(path.join(options.directory, "copy-"));
      const filePath = path.join(stagingDirectory, stagingFilename(file.name));
      await fs.writeFile(filePath, file.bytes, { flag: "wx", mode: 0o600 });
      copied = await options.writeFile(filePath);
      if (copied) {
        // Keep copied files after app exit, so pasting still works. Only this cache is pruned.
        await pruneClipboardFiles(options.directory, stagingDirectory).catch(() => undefined);
      }
      return copied;
    } catch {
      return false;
    } finally {
      if (stagingDirectory && !copied) {
        await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      writing = false;
    }
  };
}

export function registerFileClipboardIpc(
  ipcMain: Pick<IpcMain, "removeHandler" | "handle">,
  options: {
    isTrustedRenderer: (id: number) => boolean;
    writeFile: (input: unknown) => Promise<boolean>;
  },
): void {
  ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.clipboardWriteFile);
  ipcMain.handle(DESKTOP_IPC_CHANNELS.clipboardWriteFile, (event, input: unknown) => {
    if (
      !options.isTrustedRenderer(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      return false;
    }
    return options.writeFile(input);
  });
}
