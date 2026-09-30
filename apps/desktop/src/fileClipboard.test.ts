import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { execProcessFile } from "@synara/shared/processRuntime";
import { MAX_DESKTOP_CLIPBOARD_FILE_BYTES } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileClipboardWriter,
  parseClipboardFile,
  registerFileClipboardIpc,
  writeNativeClipboardFile,
} from "./fileClipboard";

const directories: string[] = [];
async function fixtureDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-clipboard-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("native file clipboard staging", () => {
  it.each(["../private.txt", "/tmp/private.txt", "C:\\private.txt", "..", "", "bad\0name"])(
    "rejects filenames that could name an existing host path: %s",
    (name) => {
      expect(parseClipboardFile({ name, bytes: new Uint8Array([1]) })).toBeNull();
    },
  );
  it("bounds payloads and rejects string/path data instead of bytes", () => {
    expect(parseClipboardFile({ name: "file.zip", bytes: "C:\\private.zip" })).toBeNull();
    expect(
      parseClipboardFile({
        name: "file.zip",
        bytes: new Uint8Array(MAX_DESKTOP_CLIPBOARD_FILE_BYTES + 1),
      }),
    ).toBeNull();
    expect(parseClipboardFile({ name: "empty.txt", bytes: new Uint8Array() })).not.toBeNull();
  });

  it("stages exact remote bytes and retains them after successful copy", async () => {
    const directory = await fixtureDirectory();
    const nativeWrite = vi.fn(async (filePath: string) => {
      expect(path.dirname(path.dirname(filePath))).toBe(directory);
      expect(path.basename(filePath)).toBe("résumé.zip");
      expect(await fs.readFile(filePath)).toEqual(Buffer.from([80, 75, 0, 255]));
      return true;
    });
    const copy = createFileClipboardWriter({ directory, writeFile: nativeWrite });
    expect(await copy({ name: "résumé.zip", bytes: new Uint8Array([80, 75, 0, 255]) })).toBe(true);
    expect(await fs.readFile(nativeWrite.mock.calls[0]![0])).toEqual(Buffer.from([80, 75, 0, 255]));
  });

  it("cleans failed staging files and never reports success when native copy rejects", async () => {
    const directory = await fixtureDirectory();
    const copy = createFileClipboardWriter({ directory, writeFile: async () => false });
    expect(await copy({ name: "file.mp4", bytes: new Uint8Array([1]) })).toBe(false);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("prunes only owned cache directories and keeps a bounded history for pasting", async () => {
    const directory = await fixtureDirectory();
    await fs.mkdir(path.join(directory, "unrelated"));
    const paths: string[] = [];
    const copy = createFileClipboardWriter({
      directory,
      writeFile: async (filePath) => {
        paths.push(filePath);
        return true;
      },
    });
    for (let index = 0; index < 6; index++) {
      expect(await copy({ name: "file.txt", bytes: new Uint8Array([index]) })).toBe(true);
    }
    expect(await fs.readdir(directory)).toHaveLength(5);
    expect(await fs.readFile(paths.at(-1)!)).toEqual(Buffer.from([5]));
    expect((await fs.stat(path.join(directory, "unrelated"))).isDirectory()).toBe(true);
  });

  it("rejects overlapping large copies without queuing more staging files", async () => {
    const directory = await fixtureDirectory();
    let complete!: (value: boolean) => void;
    const nativeWrite = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const copy = createFileClipboardWriter({ directory, writeFile: nativeWrite });
    const first = copy({ name: "one.zip", bytes: new Uint8Array([1]) });
    await vi.waitFor(() => expect(nativeWrite).toHaveBeenCalledOnce());
    expect(await copy({ name: "two.zip", bytes: new Uint8Array([2]) })).toBe(false);
    complete(true);
    expect(await first).toBe(true);
    expect(await fs.readdir(directory)).toHaveLength(1);
  });
});

describe("platform clipboard formats", () => {
  it("writes an encoded macOS file URL and verifies its native buffer", async () => {
    let buffer = Buffer.alloc(0);
    const filePath = path.join(os.tmpdir(), "copied files", "résumé.zip");
    const clipboard = {
      writeBuffer: vi.fn((_format, value: Buffer) => {
        buffer = Buffer.from(value);
      }),
      readBuffer: vi.fn(() => buffer),
    };
    expect(
      await writeNativeClipboardFile(filePath, {
        platform: "darwin",
        clipboard,
      }),
    ).toBe(true);
    expect(clipboard.writeBuffer).toHaveBeenCalledWith(
      "public.file-url",
      Buffer.from(pathToFileURL(filePath).href),
    );
    expect(buffer.toString("utf8")).toContain("copied%20files/r%C3%A9sum%C3%A9.zip");
    clipboard.readBuffer.mockReturnValue(Buffer.alloc(0));
    expect(await writeNativeClipboardFile("/tmp/file.zip", { platform: "darwin", clipboard })).toBe(
      false,
    );
  });

  it("uses STA native FileDrop on Windows with the filename as environment data", async () => {
    const execFile = vi.fn<typeof execProcessFile>((_command, _args, _options, callback) => {
      callback(null, "", "");
      return {} as ChildProcess;
    });
    const filePath = "C:\\temp\\copy\\file $(Write-Error 'injection').zip";
    const clipboard = { writeBuffer: vi.fn(), readBuffer: vi.fn() };
    expect(
      await writeNativeClipboardFile(filePath, { platform: "win32", clipboard, execFile }),
    ).toBe(true);
    const [, args, options] = execFile.mock.calls[0]!;
    expect(args).toContain("-Sta");
    expect(options.env?.SYNARA_CLIPBOARD_FILE).toBe(filePath);
    expect(options.timeout).toBe(10_000);
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("SetFileDropList");
    expect(script).not.toContain(filePath);
    expect(clipboard.writeBuffer).not.toHaveBeenCalled();
  });
});

describe("clipboard IPC authorization", () => {
  it("requires a trusted top-level renderer before passing bytes to staging", async () => {
    let handler!: (event: IpcMainInvokeEvent, input: unknown) => unknown;
    const ipc = {
      removeHandler: vi.fn(),
      handle: vi.fn((_channel, listener) => {
        handler = listener;
      }),
    } as unknown as Pick<IpcMain, "removeHandler" | "handle">;
    const writeFile = vi.fn().mockResolvedValue(true);
    registerFileClipboardIpc(ipc, { isTrustedRenderer: (id) => id === 7, writeFile });
    const frame = {};
    const event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame } as IpcMainInvokeEvent;
    const input = { name: "file.zip", bytes: new Uint8Array([1]) };
    expect(await handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, input)).toBe(false);
    expect(
      await handler({ ...event, sender: { id: 8, mainFrame: frame } } as IpcMainInvokeEvent, input),
    ).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
    expect(await handler(event, input)).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(input);
  });
});
