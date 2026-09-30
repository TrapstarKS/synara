import fs from "node:fs/promises";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { statFilesystemEntry } from "./workspaceEntries";

const directories: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-stat-"));
  directories.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("statFilesystemEntry", () => {
  it.each(["docs", ".synara", "backup.zip", "image.png", "space (100%) #1"])(
    "recognizes directory %s without a trailing separator",
    async (name) => {
      const root = await fixture();
      const folder = path.join(root, name);
      await fs.mkdir(folder);
      expect(await statFilesystemEntry({ cwd: root, path: name })).toEqual({
        path: folder,
        kind: "directory",
        workspaceRelativePath: name,
      });
      expect(await statFilesystemEntry({ path: folder })).toEqual({
        path: folder,
        kind: "directory",
        workspaceRelativePath: null,
      });
    },
  );

  it("distinguishes the root, extensionless files and missing paths", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "LICENSE"), "text");
    expect(await statFilesystemEntry({ cwd: root, path: "." })).toEqual({
      path: root,
      kind: "directory",
      workspaceRelativePath: "",
    });
    expect(await statFilesystemEntry({ cwd: root, path: "LICENSE" })).toMatchObject({
      kind: "file",
    });
    expect(await statFilesystemEntry({ cwd: root, path: "LICENSE/child" })).toMatchObject({
      kind: "missing",
    });
    expect(await statFilesystemEntry({ cwd: root, path: "absent" })).toMatchObject({
      kind: "missing",
    });
  });

  it("resolves directory symlinks without revealing external targets in the workspace tree", async () => {
    const root = await fixture();
    const outside = await fixture();
    const target = path.join(root, "real");
    await fs.mkdir(target);
    const type = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(target, path.join(root, "inside"), type);
    await fs.symlink(outside, path.join(root, "outside"), type);
    await fs.symlink(path.join(root, "missing"), path.join(root, "broken"), type);
    expect(await statFilesystemEntry({ cwd: root, path: "inside" })).toMatchObject({
      kind: "directory",
      workspaceRelativePath: "real",
    });
    expect(await statFilesystemEntry({ cwd: root, path: "outside" })).toMatchObject({
      kind: "directory",
      workspaceRelativePath: null,
    });
    expect(await statFilesystemEntry({ cwd: root, path: "broken" })).toMatchObject({
      kind: "other",
      workspaceRelativePath: null,
    });
  });

  it.skipIf(process.platform === "win32")(
    "classifies a socket without opening it for reading",
    async () => {
      const root = await fixture();
      const socketPath = path.join(root, "ipc");
      const server = net.createServer();
      try {
        server.listen(socketPath);
        await once(server, "listening");
        expect(await statFilesystemEntry({ cwd: root, path: "ipc" })).toEqual({
          path: socketPath,
          kind: "other",
          workspaceRelativePath: null,
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("does not mask permission failures as missing files", async () => {
    const root = await fixture();
    const error = Object.assign(new Error("Access denied"), { code: "EACCES" });
    vi.spyOn(fs, "stat").mockRejectedValueOnce(error);
    await expect(statFilesystemEntry({ cwd: root, path: "private" })).rejects.toBe(error);
  });

  it.each(["https://example.com", "javascript:alert(1)", "bad\0path"])(
    "rejects non-filesystem input %s",
    async (input) => {
      await expect(statFilesystemEntry({ path: input })).rejects.toThrow();
    },
  );

  it("requires a workspace for relative paths", async () => {
    await expect(statFilesystemEntry({ path: "docs" })).rejects.toThrow("current project");
  });

  it.skipIf(process.platform === "win32")(
    "does not reinterpret a Windows path on a POSIX host",
    async () => {
      await expect(
        statFilesystemEntry({ path: String.raw`C:\Users\tester\.codex` }),
      ).rejects.toThrow("only supported on Windows");
    },
  );
});
