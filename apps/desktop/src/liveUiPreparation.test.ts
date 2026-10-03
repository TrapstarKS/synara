import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_UI_MANIFEST_FILENAME, type LiveUiManifest } from "@synara/contracts";
import {
  LiveUiRestartRequiredError,
  prepareLiveUiUpdate,
  readLiveUiSigningIdentity,
  validateLiveUiZip,
  type LiveUiPreparationDependencies,
} from "./liveUiPreparation";
import { fingerprintUpdateArtifact } from "./updateArtifactIdentity";

interface FixtureEntry {
  name: string;
  data?: string;
  mode?: number;
  method?: number;
  flags?: number;
  localName?: string;
  extra?: Buffer;
  descriptor?: boolean;
}

// Small real ZIP records (including CRC and optional descriptors) exercise the
// archive parser; preparation tests replace only OS codesign/ditto operations.
function zipBytes(entries: readonly FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const data = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 0;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const extra = entry.extra ?? Buffer.alloc(0);
    const flags = (entry.flags ?? 0) | (entry.descriptor ? 8 : 0);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!entry.descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
    if (entry.descriptor) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(packed.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
    }
    const record = Buffer.concat([local, localName, extra, packed, descriptor]);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(3 * 256 + 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE(
      ((entry.mode ?? (entry.name.endsWith("/") ? 0o40755 : 0o100644)) * 65536) >>> 0,
      38,
    );
    header.writeUInt32LE(offset, 42);
    locals.push(record);
    central.push(Buffer.concat([header, name, extra]));
    offset += record.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const roots: string[] = [];
async function root() {
  const directory = await mkdtemp(join(tmpdir(), "synara-live-ui-test-"));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function archive(entries: readonly FixtureEntry[]) {
  const directory = await root();
  const path = join(directory, "release.zip");
  await writeFile(path, zipBytes(entries));
  return path;
}

const goodManifest: LiveUiManifest = {
  schemaVersion: 1,
  version: "0.9.28",
  runtimeHash: "a".repeat(64),
};
const clientPrefix = "Synara.app/Contents/Resources/app.asar/apps/server/dist/client/";
const signer = { certificateSha1: "b".repeat(40) };
const bundleId = "com.emanueledipietro.synara";

function appEntries(manifest: unknown = goodManifest): FixtureEntry[] {
  return [
    {
      name: "Synara.app/Contents/Resources/app.asar/package.json",
      data: JSON.stringify({ version: "0.9.28" }),
    },
    { name: `${clientPrefix}${LIVE_UI_MANIFEST_FILENAME}`, data: JSON.stringify(manifest) },
    { name: `${clientPrefix}index.html`, data: '<script src="/assets/app.js"></script>' },
    { name: `${clientPrefix}assets/app.js`, data: "window.loaded = true;" },
  ];
}

async function prepareFixture(entries = appEntries()) {
  const zip = await archive(entries);
  const cacheRoot = join(dirname(zip), "cache");
  const abort = new AbortController();
  const command = vi.fn<NonNullable<LiveUiPreparationDependencies["runCommand"]>>(
    async (file, args) => {
      if (file.endsWith("/ditto")) {
        const destination = args.at(-1)!;
        for (const entry of entries) {
          const path = join(destination, entry.name);
          await mkdir(dirname(path), { recursive: true });
          if (entry.name.endsWith("/")) await mkdir(path, { recursive: true });
          else if (entry.mode === 0o120777) await symlink(entry.data!, path);
          else await writeFile(path, entry.data ?? "");
        }
      }
      return { stdout: "", stderr: "" };
    },
  );
  return {
    input: {
      artifact: await fingerprintUpdateArtifact(zip),
      version: "0.9.28",
      currentManifest: { ...goodManifest, version: "0.9.27" },
      expectedSigner: signer,
      expectedBundleId: bundleId,
      cacheRoot,
      signal: abort.signal,
    },
    dependencies: { platform: "darwin" as const, runCommand: command },
    command,
    abort,
  };
}

describe("ZIP validation before extraction", () => {
  it("accepts ordinary framework symlinks, deflate and data descriptors", async () => {
    const path = await archive([
      {
        name: "Synara.app/Framework/Versions/A/Resources/file",
        data: "ok",
        method: 8,
        descriptor: true,
      },
      { name: "Synara.app/Framework/Versions/Current", data: "A", mode: 0o120777, method: 8 },
      {
        name: "Synara.app/Framework/Resources",
        data: "Versions/Current/Resources",
        mode: 0o120777,
      },
    ]);
    await expect(validateLiveUiZip(path)).resolves.toBe("Synara.app");
  });

  it.each([
    "../outside",
    "/tmp/outside",
    "Synara.app/../outside",
    "Synara.app\\file",
    "Synara.app/x:y",
    "Synara.app/a//b",
    "Synara.app/a\nfile",
  ])("rejects unsafe path %j", async (name) => {
    await expect(validateLiveUiZip(await archive([{ name }]))).rejects.toThrow();
  });

  it.each(["/tmp/outside", "../../outside", "a/../../../outside"])(
    "rejects escaping link %j",
    async (data) => {
      await expect(
        validateLiveUiZip(await archive([{ name: "Synara.app/link", data, mode: 0o120777 }])),
      ).rejects.toThrow();
    },
  );

  it("rejects entries written through a symlink and cyclic links", async () => {
    for (const entries of [
      [
        { name: "Synara.app/link", data: "target", mode: 0o120777 },
        { name: "Synara.app/link/file", data: "bad" },
      ],
      [
        { name: "Synara.app/a", data: "b", mode: 0o120777 },
        { name: "Synara.app/b", data: "a", mode: 0o120777 },
      ],
      [
        { name: "Synara.app/a", data: "b/../..", mode: 0o120777 },
        { name: "Synara.app/b", data: ".", mode: 0o120777 },
      ],
    ])
      await expect(validateLiveUiZip(await archive(entries))).rejects.toThrow();
  });

  it("rejects duplicates, case/Unicode aliases and file-parent conflicts", async () => {
    for (const names of [
      ["x", "x"],
      ["X/a", "x/b"],
      ["é", "e\u0301"],
      ["x", "x/file"],
    ]) {
      await expect(
        validateLiveUiZip(
          await archive(names.map((name) => ({ name: `Synara.app/${name}`, flags: 0x800 }))),
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects conflicting local names, extra path metadata, special files and encrypted ZIPs", async () => {
    for (const entry of [
      { name: "Synara.app/a", localName: "../outside/a" },
      { name: "Synara.app/a", extra: Buffer.from([0x75, 0x70, 0, 0]) },
      { name: "Synara.app/a", extra: Buffer.from([1, 0, 0, 0]) },
      { name: "Synara.app/a", mode: 0o020600 },
      { name: "Synara.app/a", flags: 1 },
    ])
      await expect(validateLiveUiZip(await archive([entry]))).rejects.toThrow();
  });

  it("rejects multi-bundle and truncated archives", async () => {
    await expect(
      validateLiveUiZip(await archive([{ name: "Synara.app/a" }, { name: "Other.app/a" }])),
    ).rejects.toThrow();
    const zip = await archive([{ name: "Synara.app/a" }]);
    await writeFile(zip, (await readFile(zip)).subarray(0, -1));
    await expect(validateLiveUiZip(zip)).rejects.toThrow();
  });

  it("bounds path depth before extraction", async () => {
    const zip = await archive([{ name: `Synara.app/${"directory/".repeat(65)}file` }]);
    await expect(validateLiveUiZip(zip)).rejects.toThrow();
  });
});

describe("prepareLiveUiUpdate", () => {
  it("returns only verified compatible web assets and an idempotent disposer", async () => {
    const fixture = await prepareFixture();
    const removeTree = vi.fn((directory: string) =>
      rm(directory, { recursive: true, force: true }),
    );
    const result = await prepareLiveUiUpdate(fixture.input, {
      ...fixture.dependencies,
      removeTree,
    });
    expect(result.version).toBe("0.9.28");
    expect(await readFile(join(result.dir, "assets/app.js"), "utf8")).toBe("window.loaded = true;");
    expect(await readdir(dirname(result.dir))).toEqual(["client"]);
    expect(removeTree).toHaveBeenCalledExactlyOnceWith(join(dirname(result.dir), "extracted"));
    const codesign = fixture.command.mock.calls.find(([file]) => file.endsWith("/codesign"));
    expect(codesign?.[1]).toContain("--strict");
    expect(codesign?.[1]).toContain(
      `=identifier "${bundleId}" and info[CFBundleIdentifier] = "${bundleId}" and certificate leaf = H"${signer.certificateSha1}"`,
    );
    expect(existsSync(fixture.input.artifact.path)).toBe(true);
    await result.dispose();
    await result.dispose();
    expect(removeTree).toHaveBeenLastCalledWith(dirname(result.dir));
    expect(await readdir(fixture.input.cacheRoot)).toEqual([]);
  });

  it("never invokes extraction for a hostile ZIP", async () => {
    const fixture = await prepareFixture([{ name: "../outside" }]);
    await expect(prepareLiveUiUpdate(fixture.input, fixture.dependencies)).rejects.toThrow();
    expect(fixture.command).not.toHaveBeenCalled();
    expect(await readdir(fixture.input.cacheRoot)).toEqual([]);
  });

  it("rejects replaced updater bytes before extraction", async () => {
    const fixture = await prepareFixture();
    await writeFile(fixture.input.artifact.path, "replaced");
    await expect(prepareLiveUiUpdate(fixture.input, fixture.dependencies)).rejects.toThrow(
      /changed/,
    );
    expect(fixture.command).not.toHaveBeenCalled();
  });

  it("fails closed on missing signer and unsupported platform", async () => {
    const fixture = await prepareFixture();
    await expect(
      prepareLiveUiUpdate(
        { ...fixture.input, expectedSigner: { certificateSha1: "" } },
        fixture.dependencies,
      ),
    ).rejects.toThrow(/pinned signer/);
    await expect(
      prepareLiveUiUpdate(fixture.input, { ...fixture.dependencies, platform: "win32" }),
    ).rejects.toThrow(/macOS/);
    expect(fixture.command).not.toHaveBeenCalled();
  });

  it("propagates signature rejection and removes the candidate", async () => {
    const fixture = await prepareFixture();
    const extraction = fixture.command.getMockImplementation()!;
    fixture.command.mockImplementation(async (file, args, signal) => {
      if (file.endsWith("/codesign")) throw new Error("wrong signer");
      return extraction(file, args, signal);
    });
    await expect(prepareLiveUiUpdate(fixture.input, fixture.dependencies)).rejects.toThrow(
      /wrong signer/,
    );
    expect(await readdir(fixture.input.cacheRoot)).toEqual([]);
  });

  it.each([
    null,
    { ...goodManifest, runtimeHash: "c".repeat(64) },
    { ...goodManifest, schemaVersion: 2 },
    { ...goodManifest, version: "0.9.29" },
  ])("requires a full restart for an incompatible manifest", async (manifest) => {
    const fixture = await prepareFixture(appEntries(manifest));
    await expect(prepareLiveUiUpdate(fixture.input, fixture.dependencies)).rejects.toBeInstanceOf(
      LiveUiRestartRequiredError,
    );
    expect(await readdir(fixture.input.cacheRoot)).toEqual([]);
  });

  it("requires a restart for a legacy release with no manifest", async () => {
    const fixture = await prepareFixture(
      appEntries().filter((entry) => !entry.name.endsWith(LIVE_UI_MANIFEST_FILENAME)),
    );
    await expect(prepareLiveUiUpdate(fixture.input, fixture.dependencies)).rejects.toBeInstanceOf(
      LiveUiRestartRequiredError,
    );
  });

  it("cancels staging without removing an older retained generation", async () => {
    const fixture = await prepareFixture();
    const previous = join(fixture.input.cacheRoot, "previous");
    await mkdir(previous, { recursive: true });
    await writeFile(join(previous, "index.html"), "old");
    const extraction = fixture.command.getMockImplementation()!;
    fixture.command.mockImplementation(async (file, args, signal) => {
      const result = await extraction(file, args, signal);
      fixture.abort.abort(new Error("cancelled"));
      return result;
    });
    await expect(prepareLiveUiUpdate(fixture.input, fixture.dependencies)).rejects.toThrow(
      /cancelled/,
    );
    expect(await readdir(fixture.input.cacheRoot)).toEqual(["previous"]);
  });

  it("rejects symlinks inside copied web assets", async () => {
    const fixture = await prepareFixture([
      ...appEntries(),
      { name: `${clientPrefix}assets/link.js`, data: "app.js", mode: 0o120777 },
    ]);
    await expect(prepareLiveUiUpdate(fixture.input, fixture.dependencies)).rejects.toThrow(
      /Web assets must not contain symlinks/,
    );
  });
});

describe("startup signer capture", () => {
  it("pins the actual leaf certificate and removes temporary certificate files", async () => {
    let certificate = "";
    const runCommand = vi.fn<NonNullable<LiveUiPreparationDependencies["runCommand"]>>(
      async (_file, args) => {
        const extraction = args.find((arg) => arg.startsWith("--extract-certificates="));
        if (args.includes("--display")) {
          // codesign's optional prefix belongs to the option itself. A separate
          // argument is interpreted as another app path and fails on macOS.
          expect(args).toHaveLength(3);
          expect(extraction).toBeDefined();
          certificate = `${extraction!.slice("--extract-certificates=".length)}0`;
          await writeFile(certificate, "leaf certificate");
        }
        return { stdout: "", stderr: "TeamIdentifier=not-the-trust-anchor" };
      },
    );
    await expect(
      readLiveUiSigningIdentity("/fixture/Synara.app", bundleId, undefined, {
        platform: "darwin",
        runCommand,
      }),
    ).resolves.toEqual({
      certificateSha1: createHash("sha1").update("leaf certificate").digest("hex"),
    });
    expect(existsSync(certificate)).toBe(false);
    expect(runCommand.mock.calls[0]?.[1]).toContain(
      `=identifier "${bundleId}" and info[CFBundleIdentifier] = "${bundleId}"`,
    );
  });

  it("never skips trust when certificate extraction is unavailable", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(
      readLiveUiSigningIdentity("/fixture/Synara.app", bundleId, undefined, {
        platform: "darwin",
        runCommand,
      }),
    ).rejects.toThrow();
  });
});
