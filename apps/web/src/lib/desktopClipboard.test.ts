import { MAX_DESKTOP_CLIPBOARD_FILE_BYTES } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ grant: vi.fn() }));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ projects: { createLocalFilePreviewGrant: harness.grant } }),
}));

import {
  canCopyFileToDesktopClipboard,
  copyFileToDesktopClipboard,
  copyImageToClipboard,
  createLocalFileClipboardSource,
  fetchFileClipboardBlob,
} from "./desktopClipboard";

const fetchMock = vi.fn<typeof fetch>();
const writeFile = vi.fn();
const server = "https://remote-pc.test:8443";
const source = { url: `${server}/api/local-image?path=output.zip&cwd=C%3A%5Crepo&download=1` };

beforeEach(() => {
  vi.stubGlobal("window", {
    location: { href: "https://client.test/", origin: "https://client.test" },
    desktopBridge: {
      getWsUrl: () => "wss://remote-pc.test:8443?token=test-token",
      clipboard: { writeFile },
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", {});
  fetchMock.mockReset();
  writeFile.mockReset().mockResolvedValue(true);
  harness.grant.mockReset().mockResolvedValue({ grant: "fresh-grant" });
});
afterEach(() => vi.unstubAllGlobals());

describe("scoped clipboard downloads", () => {
  it("copies remote bytes and basename through the bridge, never a host path", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([0x50, 0x4b, 0, 255])));
    await expect(copyFileToDesktopClipboard(source, "output.zip")).resolves.toBe(true);
    expect(writeFile).toHaveBeenCalledWith({
      name: "output.zip",
      bytes: new Uint8Array([0x50, 0x4b, 0, 255]),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      source.url,
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );
  });

  it("renews absolute remote grants at copy time and preserves the active server token", async () => {
    const file = createLocalFileClipboardSource({ path: "C:\\work\\résumé.txt" });
    expect(harness.grant).not.toHaveBeenCalled();
    const url = new URL(await file.resolveUrl!());
    expect(harness.grant).toHaveBeenCalledWith({ path: "C:\\work\\résumé.txt" });
    expect(url.origin).toBe(server);
    expect(url.searchParams.get("path")).toBe("C:\\work\\résumé.txt");
    expect(url.searchParams.get("token")).toBe("test-token");
    expect(url.searchParams.get("grant")).toBe("fresh-grant");
    expect(url.searchParams.get("download")).toBe("1");
  });

  it("uses the workspace resource for a relative path without widening its grant", () => {
    const file = createLocalFileClipboardSource({ path: "out/archive.zip", cwd: "C:\\repo" });
    expect(file.resolveUrl).toBeUndefined();
    expect(new URL(file.url).searchParams.get("cwd")).toBe("C:\\repo");
    expect(harness.grant).not.toHaveBeenCalled();
  });

  it.each([
    "https://untrusted.test/api/local-image?path=x",
    `${server}/other`,
    "file:///Users/local/private.zip",
  ])("refuses a non-resource URL without fetching it: %s", async (url) => {
    await expect(fetchFileClipboardBlob({ url })).rejects.toThrow("scoped file download");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([403, 404, 206, 502])("does not copy an HTTP %i response as a file", async (status) => {
    fetchMock.mockResolvedValue(new Response("untrusted error body", { status }));
    await expect(copyFileToDesktopClipboard(source, "output.zip")).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("rejects partial and truncated bodies, even when HTTP reports success", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("partial", { headers: { "Content-Range": "bytes 0-6/20" } }),
    );
    await expect(fetchFileClipboardBlob(source)).rejects.toThrow("complete file");
    fetchMock.mockResolvedValueOnce(
      new Response("partial", { headers: { "Content-Length": "20" } }),
    );
    await expect(fetchFileClipboardBlob(source)).rejects.toThrow("complete file");
  });

  it("accepts a proven empty file and rejects an absent body of unknown/nonzero length", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { headers: { "Content-Length": "0" } }));
    expect((await fetchFileClipboardBlob(source)).size).toBe(0);
    fetchMock.mockResolvedValueOnce(new Response(null));
    await expect(fetchFileClipboardBlob(source)).rejects.toThrow("complete file");
    fetchMock.mockResolvedValueOnce(new Response(null, { headers: { "Content-Length": "3" } }));
    await expect(fetchFileClipboardBlob(source)).rejects.toThrow("complete file");
  });

  it("rejects oversized responses before reading or invoking IPC", async () => {
    fetchMock.mockResolvedValue(
      new Response("", {
        headers: { "Content-Length": String(MAX_DESKTOP_CLIPBOARD_FILE_BYTES + 1) },
      }),
    );
    await expect(copyFileToDesktopClipboard(source, "large.mp4")).rejects.toThrow(
      "larger than 64 MB",
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("bounds streaming bodies even without a Content-Length header", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 65) controller.enqueue(chunk);
        else controller.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(body));
    await expect(fetchFileClipboardBlob(source)).rejects.toThrow("larger than 64 MB");
  });

  it("redacts grant-resolution and transport failures", async () => {
    await expect(
      fetchFileClipboardBlob({
        url: source.url,
        resolveUrl: async () => {
          throw new Error("token=private");
        },
      }),
    ).rejects.toThrow("scoped file download");
    fetchMock.mockRejectedValue(new Error("Failed to fetch token=private"));
    await expect(fetchFileClipboardBlob(source)).rejects.toThrow(
      "Could not load the file for copying. Try downloading it again.",
    );
  });

  it("reports native rejection and browser unavailability without copying a path", async () => {
    fetchMock.mockResolvedValue(new Response("file bytes"));
    writeFile.mockResolvedValue(false);
    await expect(copyFileToDesktopClipboard(source, "file.txt")).resolves.toBe(false);
    vi.stubGlobal("window", { location: { href: "https://client.test/" } });
    expect(canCopyFileToDesktopClipboard()).toBe(false);
    fetchMock.mockClear();
    await expect(copyFileToDesktopClipboard(source, "file.txt")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("image clipboard", () => {
  it("writes PNG bytes through browser ClipboardItem and reports actual rejection", async () => {
    class Item {
      constructor(readonly contents: Record<string, Blob>) {}
    }
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", Item);
    vi.stubGlobal("navigator", { clipboard: { write } });
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    expect(await copyImageToClipboard(png)).toBe(true);
    expect(write).toHaveBeenCalledWith([new Item({ "image/png": png })]);
    write.mockRejectedValue(new Error("denied"));
    expect(await copyImageToClipboard(png)).toBe(false);
  });
});
