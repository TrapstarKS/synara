// FILE: liveUiPreparation.ts
// Purpose: Prepare web assets from a verified macOS update without touching the
// installed bundle. Activation and generation retention belong to the controller.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import {
  LIVE_UI_MANIFEST_FILENAME,
  areLiveUiManifestsCompatible,
  parseLiveUiManifest,
  type LiveUiManifest,
} from "@synara/contracts";
import { execProcessFile } from "@synara/shared/processRuntime";
import {
  fingerprintUpdateArtifact,
  isUpdateArtifactIdentity,
  type UpdateArtifactIdentity,
} from "./updateArtifactIdentity";

export interface LiveUiSigningIdentity {
  readonly certificateSha1: string;
}

export class LiveUiRestartRequiredError extends Error {
  constructor(
    message = "This update changes the desktop runtime and requires a full app restart.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LiveUiRestartRequiredError";
  }
}

export interface PrepareLiveUiUpdateInput {
  readonly artifact: UpdateArtifactIdentity;
  readonly version: string;
  readonly currentManifest: LiveUiManifest;
  readonly expectedSigner: LiveUiSigningIdentity;
  readonly expectedBundleId: string;
  readonly cacheRoot: string;
  readonly signal: AbortSignal;
}

export interface PreparedLiveUiUpdate {
  readonly dir: string;
  readonly version: string;
  readonly dispose: () => Promise<void>;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}
type RunCommand = (
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<CommandResult>;
export interface LiveUiPreparationDependencies {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: RunCommand;
  /** Electron must use original-fs for physical trees containing app.asar. */
  readonly removeTree?: (directory: string) => Promise<void>;
}

const runCommand: RunCommand = (command, args, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    execProcessFile(
      command,
      args,
      {
        platform: "darwin",
        requireExecutable: true,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(`Live UI preparation failed (${Path.basename(command)}).`, { cause: error }),
          );
        else resolve({ stdout, stderr });
      },
    );
  });

function bundleRequirement(bundleId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{1,254}$/.test(bundleId))
    throw new Error("Invalid live UI bundle identity.");
  return `identifier "${bundleId}" and info[CFBundleIdentifier] = "${bundleId}"`;
}

function requireMac(platform: NodeJS.Platform): void {
  if (platform !== "darwin")
    throw new Error("Live UI update preparation is available only on macOS.");
}

/** Capture the actual leaf certificate at startup, not a claimed TeamIdentifier
 * or an untrusted designated-requirement string. Unsigned/ad-hoc apps fail closed. */
export async function readLiveUiSigningIdentity(
  appPath: string,
  expectedBundleId: string,
  signal?: AbortSignal,
  dependencies: LiveUiPreparationDependencies = {},
): Promise<LiveUiSigningIdentity> {
  requireMac(dependencies.platform ?? process.platform);
  const run = dependencies.runCommand ?? runCommand;
  const requirement = bundleRequirement(expectedBundleId);
  signal?.throwIfAborted();
  // Existing custom Finder icons can add metadata rejected by --strict. The
  // candidate below is always verified strictly; startup still verifies its seal.
  await run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--test-requirement", `=${requirement}`, appPath],
    signal,
  );
  const work = await mkdtemp(Path.join(tmpdir(), "synara-live-ui-signer-"));
  try {
    const prefix = Path.join(work, "certificate-");
    await run(
      "/usr/bin/codesign",
      ["--display", `--extract-certificates=${prefix}`, appPath],
      signal,
    );
    const certificatePath = `${prefix}0`;
    const stat = await lstat(certificatePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 64 * 1024) {
      throw new Error("The installed app has no verifiable signing certificate.");
    }
    const certificateSha1 = createHash("sha1")
      .update(await readFile(certificatePath))
      .digest("hex");
    signal?.throwIfAborted();
    return { certificateSha1 };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

interface ZipEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly localOffset: number;
  readonly dataOffset: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly method: number;
  readonly crc: number;
  readonly flags: number;
  target?: string;
}

const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3 - 1;
const MAX_EXTRACTED_BYTES = 4 * 1024 ** 3;
const MAX_DIRECTORY_BYTES = 16 * 1024 ** 2;
const MAX_LINK_BYTES = 4096;
const canonical = (path: string) => path.normalize("NFD").toLowerCase();
const invalidZip = (): never => {
  throw new Error(
    "The update ZIP contains unsupported or unsafe entries. Use the full app update.",
  );
};

function zipPath(bytes: Buffer, flags: number): string {
  if (!(flags & 0x800) && bytes.some((byte) => byte >= 128)) return invalidZip();
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // Archive paths must reject control bytes rather than passing them to ditto.
  // eslint-disable-next-line no-control-regex
  if (!value || value.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith("/"))
    return invalidZip();
  const parts = value.replace(/\/$/, "").split("/");
  if (parts.length > 64 || parts.some((part) => !part || part === "." || part === ".."))
    return invalidZip();
  return value;
}

function validateZipExtra(bytes: Buffer): void {
  // Only timestamp/UID metadata used by the release ZIP writers. In particular,
  // reject ZIP64, alternate Unicode paths, Unix hardlinks and unknown extensions
  // which could make ditto interpret a different path/type than this preflight.
  const allowed = new Set([0x5455, 0x7875, 0x7855, 0x5855, 0x000a]);
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) return invalidZip();
    const id = bytes.readUInt16LE(offset);
    const size = bytes.readUInt16LE(offset + 2);
    if (!allowed.has(id) || offset + 4 + size > bytes.length) return invalidZip();
    offset += 4 + size;
  }
}

/** Preflight BOTH central and local headers before invoking ditto. Implements a
 * deliberately narrow classic ZIP subset (PKWARE APPNOTE 4.3); ZIP64, encryption
 * and alternate path metadata are refused, never extracted optimistically. */
export async function validateLiveUiZip(zip: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(zip, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 22 || stat.size > MAX_ARCHIVE_BYTES) return invalidZip();
    const read = async (offset: number, length: number): Promise<Buffer> => {
      signal?.throwIfAborted();
      if (offset < 0 || length < 0 || offset + length > stat.size) return invalidZip();
      const result = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(result, done, length - done, offset + done);
        if (!bytesRead) return invalidZip();
        done += bytesRead;
      }
      return result;
    };
    const tailOffset = Math.max(0, stat.size - 65_557);
    const tail = await read(tailOffset, stat.size - tailOffset);
    let end = tail.length - 22;
    while (
      end >= 0 &&
      !(
        tail.readUInt32LE(end) === 0x06054b50 &&
        end + 22 + tail.readUInt16LE(end + 20) === tail.length
      )
    )
      end -= 1;
    if (end < 0) return invalidZip();
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (
      tail.readUInt16LE(end + 4) ||
      tail.readUInt16LE(end + 6) ||
      !count ||
      count === 0xffff ||
      tail.readUInt16LE(end + 8) !== count ||
      directorySize > MAX_DIRECTORY_BYTES ||
      directoryOffset + directorySize !== tailOffset + end
    )
      return invalidZip();
    const directory = await read(directoryOffset, directorySize);
    const entries: ZipEntry[] = [];
    let offset = 0;
    let inflatedBytes = 0;
    for (let index = 0; index < count; index += 1) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50)
        return invalidZip();
      const flags = directory.readUInt16LE(offset + 8);
      const method = directory.readUInt16LE(offset + 10);
      const crc = directory.readUInt32LE(offset + 16);
      const compressedSize = directory.readUInt32LE(offset + 20);
      const size = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const attributes = directory.readUInt32LE(offset + 38);
      const localOffset = directory.readUInt32LE(offset + 42);
      const endOffset = offset + 46 + nameLength + extraLength + commentLength;
      if (
        endOffset > directory.length ||
        directory.readUInt16LE(offset + 6) > 20 ||
        directory.readUInt16LE(offset + 34) ||
        flags & ~0x80e ||
        ![0, 8].includes(method) ||
        compressedSize === 0xffffffff ||
        size === 0xffffffff ||
        localOffset === 0xffffffff
      )
        return invalidZip();
      const name = directory.subarray(offset + 46, offset + 46 + nameLength);
      const path = zipPath(name, flags);
      validateZipExtra(
        directory.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength),
      );
      const type = (attributes >>> 16) & 0o170000;
      if (![0, 0o100000, 0o040000, 0o120000].includes(type)) return invalidZip();
      const kind = type === 0o120000 ? "symlink" : path.endsWith("/") ? "directory" : "file";
      if (
        (type === 0o040000 && kind !== "directory") ||
        (kind === "directory" && type && type !== 0o040000) ||
        (kind === "symlink" && path.endsWith("/"))
      )
        return invalidZip();
      if (kind !== "file" && (size > MAX_LINK_BYTES || compressedSize > MAX_LINK_BYTES))
        return invalidZip();
      if (kind === "directory" && size !== 0) return invalidZip();
      inflatedBytes += size;
      if (inflatedBytes > MAX_EXTRACTED_BYTES) return invalidZip();
      const local = await read(localOffset, 30);
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(4) > 20 ||
        local.readUInt16LE(6) !== flags ||
        local.readUInt16LE(8) !== method ||
        local.readUInt16LE(26) !== nameLength
      )
        return invalidZip();
      for (const [at, expected] of [
        [14, crc],
        [18, compressedSize],
        [22, size],
      ] as const) {
        if (local.readUInt32LE(at) !== expected && !(flags & 8 && local.readUInt32LE(at) === 0))
          return invalidZip();
      }
      const localExtraLength = local.readUInt16LE(28);
      const names = await read(localOffset + 30, nameLength + localExtraLength);
      if (!names.subarray(0, nameLength).equals(name)) return invalidZip();
      validateZipExtra(names.subarray(nameLength));
      const dataOffset = localOffset + 30 + nameLength + localExtraLength;
      if (
        dataOffset + compressedSize > directoryOffset ||
        (method === 0 && size !== compressedSize)
      )
        return invalidZip();
      const entry: ZipEntry = {
        path: path.replace(/\/$/, ""),
        kind,
        localOffset,
        dataOffset,
        compressedSize,
        size,
        method,
        crc,
        flags,
      };
      if (kind === "symlink") {
        const encoded = await read(dataOffset, compressedSize);
        const targetBytes =
          method === 0 ? encoded : inflateRawSync(encoded, { maxOutputLength: MAX_LINK_BYTES });
        if (targetBytes.length !== size || crc32(targetBytes) !== crc) return invalidZip();
        const target = new TextDecoder("utf-8", { fatal: true }).decode(targetBytes);
        // The same control-byte exclusion applies to symlink payloads.
        // eslint-disable-next-line no-control-regex
        if (!target || /[\\:\x00-\x1f\x7f]/.test(target) || target.startsWith("/"))
          return invalidZip();
        entry.target = target;
      }
      entries.push(entry);
      offset = endOffset;
    }
    if (offset !== directory.length) return invalidZip();
    const ordered = entries.toSorted((left, right) => left.localOffset - right.localOffset);
    let nextOffset = 0;
    for (const entry of ordered) {
      // Reject prepended executables, hidden local entries and overlaps. A data
      // descriptor is validated too, rather than trusting ditto to find its end.
      if (entry.localOffset !== nextOffset) return invalidZip();
      nextOffset = entry.dataOffset + entry.compressedSize;
      if (entry.flags & 8) {
        const first = await read(nextOffset, 4);
        const signatureBytes = first.readUInt32LE(0) === 0x08074b50 ? 4 : 0;
        const descriptor = await read(nextOffset + signatureBytes, 12);
        if (
          descriptor.readUInt32LE(0) !== entry.crc ||
          descriptor.readUInt32LE(4) !== entry.compressedSize ||
          descriptor.readUInt32LE(8) !== entry.size
        )
          return invalidZip();
        nextOffset += signatureBytes + 12;
      }
    }
    if (nextOffset !== directoryOffset) return invalidZip();
    const byPath = new Map<string, ZipEntry>();
    const spellings = new Map<string, string>();
    let prefixBytes = 0;
    const roots = new Set<string>();
    for (const entry of entries) {
      const parts = entry.path.split("/");
      const root = parts[0]!;
      if (root !== "__MACOSX") roots.add(root);
      else if (entry.kind === "symlink") return invalidZip();
      const key = canonical(entry.path);
      if (byPath.has(key)) return invalidZip();
      byPath.set(key, entry);
      for (let length = 1; length <= parts.length; length += 1) {
        const prefix = parts.slice(0, length).join("/");
        const existing = spellings.get(canonical(prefix));
        if (existing !== undefined && existing !== prefix) return invalidZip();
        if (existing === undefined) {
          prefixBytes += Buffer.byteLength(prefix);
          if (prefixBytes > MAX_DIRECTORY_BYTES) return invalidZip();
        }
        spellings.set(canonical(prefix), prefix);
      }
    }
    const appName = [...roots][0];
    if (roots.size !== 1 || !appName?.endsWith(".app")) return invalidZip();
    for (const entry of entries) {
      const parts = entry.path.split("/");
      for (let length = 1; length < parts.length; length += 1) {
        const ancestor = byPath.get(canonical(parts.slice(0, length).join("/")));
        if (ancestor && ancestor.kind !== "directory") return invalidZip();
      }
      if (entry.kind !== "symlink") continue;
      // Resolve links component-by-component, including intermediate symlinks
      // before processing '..'. This rejects escape chains and cycles.
      const remaining = [...parts.slice(0, -1), ...entry.target!.split("/")];
      const resolved: string[] = [];
      let links = 0;
      while (remaining.length) {
        const part = remaining.shift()!;
        if (!part || part === ".") continue;
        if (part === "..") {
          if (resolved.length <= 1) return invalidZip();
          resolved.pop();
          continue;
        }
        resolved.push(part);
        const link = byPath.get(canonical(resolved.join("/")));
        if (link?.kind === "symlink") {
          if (++links > 40) return invalidZip();
          resolved.pop();
          remaining.unshift(...link.target!.split("/"));
        }
      }
      if (canonical(resolved[0] ?? "") !== canonical(appName)) return invalidZip();
    }
    return appName;
  } finally {
    await handle.close();
  }
}

async function validateExtractedTree(root: string, signal: AbortSignal): Promise<void> {
  const rootPath = await realpath(root);
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted();
      const file = Path.join(directory, entry.name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) {
        const target = await realpath(file);
        if (target !== rootPath && !target.startsWith(`${rootPath}${Path.sep}`))
          throw new Error("The update contains an escaping symlink.");
      } else if (stat.isDirectory()) await visit(file);
      else if (!stat.isFile()) throw new Error("The update contains a special file.");
    }
  }
  await visit(rootPath);
}

async function copyClient(source: string, destination: string, signal: AbortSignal): Promise<void> {
  let bytes = 0;
  let files = 0;
  async function visit(from: string, to: string): Promise<void> {
    await mkdir(to, { mode: 0o700 });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      signal.throwIfAborted();
      const sourceFile = Path.join(from, entry.name);
      const target = Path.join(to, entry.name);
      const stat = await lstat(sourceFile);
      if (stat.isSymbolicLink()) throw new Error("Web assets must not contain symlinks.");
      if (stat.isDirectory()) await visit(sourceFile, target);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (++files > 65_534 || bytes > 1024 ** 3)
          throw new Error("Web assets exceed the live update budget.");
        // Electron's patched readFile supports ASAR; copyFile/fs.cp do not.
        await writeFile(target, await readFile(sourceFile), { flag: "wx", mode: 0o600 });
      } else throw new Error("Web assets contain a special file.");
    }
  }
  await visit(source, destination);
  const index = await lstat(Path.join(destination, "index.html"));
  if (!index.isFile() || index.size === 0) throw new Error("The update has no web entry point.");
}

export async function prepareLiveUiUpdate(
  input: PrepareLiveUiUpdateInput,
  dependencies: LiveUiPreparationDependencies = {},
): Promise<PreparedLiveUiUpdate> {
  requireMac(dependencies.platform ?? process.platform);
  const run = dependencies.runCommand ?? runCommand;
  const removeTree =
    dependencies.removeTree ??
    ((directory: string) => rm(directory, { recursive: true, force: true }));
  input.signal.throwIfAborted();
  if (
    !isUpdateArtifactIdentity(input.artifact) ||
    input.artifact.size > MAX_ARCHIVE_BYTES ||
    !/^[0-9a-f]{40}$/.test(input.expectedSigner?.certificateSha1 ?? "")
  ) {
    throw new Error(
      "Live UI update requires a verified artifact, runtime manifest and pinned signer.",
    );
  }
  if (!parseLiveUiManifest(input.currentManifest)) throw new LiveUiRestartRequiredError();
  const requirement = `${bundleRequirement(input.expectedBundleId)} and certificate leaf = H"${input.expectedSigner.certificateSha1}"`;
  await mkdir(input.cacheRoot, { recursive: true, mode: 0o700 });
  const cacheStat = await lstat(input.cacheRoot);
  if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink())
    throw new Error("Invalid live UI cache directory.");
  const work = await mkdtemp(Path.join(await realpath(input.cacheRoot), "ui-"));
  const dispose = () => removeTree(work);
  try {
    const zip = Path.join(work, "update.zip");
    await copyFile(input.artifact.path, zip, constants.COPYFILE_EXCL);
    const identity = await fingerprintUpdateArtifact(zip);
    if (identity.sha512 !== input.artifact.sha512 || identity.size !== input.artifact.size)
      throw new Error("The downloaded update changed before preparation.");
    input.signal.throwIfAborted();
    const appName = await validateLiveUiZip(zip, input.signal);
    const extracted = Path.join(work, "extracted");
    await mkdir(extracted, { mode: 0o700 });
    // All archive paths and link targets have passed preflight. Suppress resource
    // forks/extended metadata; signature validation below must accept this result.
    await run(
      "/usr/bin/ditto",
      ["-x", "-k", "--norsrc", "--noextattr", "--noacl", zip, extracted],
      input.signal,
    );
    await validateExtractedTree(extracted, input.signal);
    const appPath = Path.join(extracted, appName);
    const appStat = await lstat(appPath);
    if (!appStat.isDirectory() || appStat.isSymbolicLink())
      throw new Error("The update has no regular app bundle.");
    await run(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--test-requirement", `=${requirement}`, appPath],
      input.signal,
    );
    input.signal.throwIfAborted();
    const asar = Path.join(appPath, "Contents", "Resources", "app.asar");
    const source = Path.join(asar, "apps", "server", "dist", "client");
    const manifestPath = Path.join(source, LIVE_UI_MANIFEST_FILENAME);
    let candidate: LiveUiManifest | null;
    try {
      const manifestStat = await lstat(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 16 * 1024)
        throw new Error("Invalid live UI manifest.");
      candidate = parseLiveUiManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    } catch (cause) {
      throw new LiveUiRestartRequiredError(
        "This release has no supported live UI manifest. Use the full app update.",
        { cause },
      );
    }
    const packageMetadata = JSON.parse(await readFile(Path.join(asar, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (
      !candidate ||
      candidate.version !== input.version ||
      packageMetadata.version !== input.version ||
      !areLiveUiManifestsCompatible(input.currentManifest, candidate)
    ) {
      throw new LiveUiRestartRequiredError();
    }
    const dir = Path.join(work, "client");
    await copyClient(source, dir, input.signal);
    input.signal.throwIfAborted();
    await removeTree(extracted);
    await rm(zip);
    input.signal.throwIfAborted();
    return { dir, version: candidate.version, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
