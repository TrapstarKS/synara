// FILE: fileReferenceContextMenu.test.ts
// Purpose: Verifies file-reference menu labels and desktop reveal/copy actions.
// Layer: Web UI helper tests

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  clicked: null as string | null,
  copyText: vi.fn(),
  copyContents: vi.fn(),
  copyFile: vi.fn(),
  copyImage: vi.fn(),
  fetchBlob: vi.fn(),
  download: vi.fn(),
  showContextMenu: vi.fn(),
  showInFolder: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  copyTextToClipboard: harness.copyText,
  copyFileContentsToClipboard: harness.copyContents,
}));

vi.mock("~/lib/desktopClipboard", () => ({
  canCopyFileToDesktopClipboard: () =>
    typeof window.desktopBridge?.clipboard?.writeFile === "function",
  copyFileToDesktopClipboard: harness.copyFile,
  copyImageToClipboard: harness.copyImage,
  fetchFileClipboardBlob: harness.fetchBlob,
  resolveFileClipboardUrl: async (source: { url: string }) => source.url,
}));
vi.mock("~/lib/browserDownload", () => ({ downloadUrlAsBlob: harness.download }));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    contextMenu: { show: harness.showContextMenu },
    shell: { showInFolder: harness.showInFolder },
  }),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

import { showFileReferenceContextMenu } from "./fileReferenceContextMenu";

beforeEach(() => {
  vi.stubGlobal("window", { desktopBridge: {} });
  vi.stubGlobal("navigator", { platform: "Win32" });
  harness.clicked = null;
  harness.copyText.mockReset();
  harness.copyContents.mockReset().mockResolvedValue(undefined);
  harness.copyFile.mockReset().mockResolvedValue(true);
  harness.copyImage.mockReset().mockResolvedValue(true);
  harness.fetchBlob.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  harness.download.mockReset().mockResolvedValue(undefined);
  harness.showContextMenu.mockReset();
  harness.showInFolder.mockReset();
  harness.toast.mockReset();
  harness.showContextMenu.mockImplementation(async () => harness.clicked);
  harness.copyText.mockResolvedValue(undefined);
  harness.showInFolder.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showFileReferenceContextMenu", () => {
  it("copies the actual scoped file rather than its displayed remote path", async () => {
    vi.stubGlobal("window", { desktopBridge: { clipboard: { writeFile: vi.fn() } } });
    harness.clicked = "copy-file";
    const fileForCopy = { url: "https://remote.test/api/local-image?path=clip.mp4&download=1" };
    await showFileReferenceContextMenu({
      path: "C:\\remote\\clip.mp4",
      fileForCopy,
      position: { x: 1, y: 2 },
      onReferenceInChat: undefined,
    });
    expect(harness.copyFile).toHaveBeenCalledWith(fileForCopy, "clip.mp4");
    expect(harness.copyText).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith({
      type: "success",
      title: "File copied",
      description: "clip.mp4",
    });
  });

  it("offers image pixels alongside the native file and path actions", async () => {
    vi.stubGlobal("window", { desktopBridge: { clipboard: { writeFile: vi.fn() } } });
    harness.clicked = "copy-image";
    const fileForCopy = { url: "https://remote.test/api/local-image?path=photo.png&download=1" };
    await showFileReferenceContextMenu({
      path: "photo.png",
      fileForCopy,
      position: { x: 1, y: 2 },
      onReferenceInChat: undefined,
    });
    expect(harness.showContextMenu.mock.calls[0]![0]).toEqual([
      { id: "copy-path", label: "Copy path" },
      { id: "copy-image", label: "Copy image" },
      { id: "copy-file", label: "Copy file" },
      { id: "download-file", label: "Download file" },
    ]);
    expect(harness.copyImage).toHaveBeenCalledOnce();
    expect(harness.copyFile).not.toHaveBeenCalled();
  });

  it("offers Download file in browsers and never calls that a clipboard copy", async () => {
    vi.stubGlobal("window", {});
    harness.clicked = "download-file";
    const fileForCopy = { url: "https://remote.test/api/local-image?path=archive.zip&download=1" };
    await showFileReferenceContextMenu({
      path: "archive.zip",
      fileForCopy,
      position: { x: 1, y: 2 },
      onReferenceInChat: undefined,
    });
    expect(harness.showContextMenu.mock.calls[0]![0]).toEqual([
      { id: "copy-path", label: "Copy path" },
      { id: "download-file", label: "Download file" },
    ]);
    expect(harness.download).toHaveBeenCalledWith({
      url: fileForCopy.url,
      filename: "archive.zip",
    });
    expect(harness.copyFile).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it("copies loaded text with the same partial-read warning as the header", async () => {
    harness.clicked = "copy-contents";
    await showFileReferenceContextMenu({
      path: "notes.txt",
      contentsForCopy: "loaded text",
      truncated: true,
      position: { x: 1, y: 2 },
      onReferenceInChat: undefined,
    });
    expect(harness.copyContents).toHaveBeenCalledWith("loaded text", "notes.txt", {
      partial: true,
    });
    expect(harness.copyText).not.toHaveBeenCalled();
  });

  it.each([false, new Error("token=private")])(
    "reports failed native copies without success or signed URL leakage",
    async (failure) => {
      vi.stubGlobal("window", { desktopBridge: { clipboard: { writeFile: vi.fn() } } });
      harness.clicked = "copy-file";
      if (failure instanceof Error) harness.copyFile.mockRejectedValue(failure);
      else harness.copyFile.mockResolvedValue(failure);
      await showFileReferenceContextMenu({
        path: "archive.zip",
        fileForCopy: { url: "/api/local-image?token=private" },
        position: { x: 1, y: 2 },
        onReferenceInChat: undefined,
      });
      expect(harness.toast).toHaveBeenCalledOnce();
      expect(harness.toast.mock.calls[0]![0]).toEqual({
        type: "error",
        title: "Failed to copy file",
        description: "Clipboard access failed or the file is unavailable. Try Download file.",
      });
      expect(harness.copyText).not.toHaveBeenCalled();
    },
  );

  it("offers reveal before copy when an absolute reveal path is available", async () => {
    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [
        { id: "reveal-in-folder", label: "Open in Explorer" },
        { id: "copy-path", label: "Copy path" },
      ],
      { x: 12, y: 34 },
    );
  });

  it("hides the desktop-only reveal action in the browser", async () => {
    vi.stubGlobal("window", {});

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [{ id: "copy-path", label: "Copy path" }],
      { x: 12, y: 34 },
    );
  });

  it("reveals the requested file through the desktop shell", async () => {
    harness.clicked = "reveal-in-folder";

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showInFolder).toHaveBeenCalledWith("/repo/output/video.mp4");
    expect(harness.copyText).not.toHaveBeenCalled();
  });

  it("reports a stale file without leaking the shell rejection", async () => {
    harness.clicked = "reveal-in-folder";
    harness.showInFolder.mockRejectedValue(new Error("Folder not found: /repo/output/video.mp4"));

    await expect(
      showFileReferenceContextMenu({
        path: "/repo/output/video.mp4",
        revealPath: "/repo/output/video.mp4",
        position: { x: 12, y: 34 },
        onReferenceInChat: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(harness.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Unable to reveal file",
      description: "Folder not found: /repo/output/video.mp4",
    });
  });

  it("copies the displayed filesystem path with the shared clipboard fallback", async () => {
    harness.clicked = "copy-path";

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.copyText).toHaveBeenCalledWith("/repo/output/video.mp4");
    expect(harness.showInFolder).not.toHaveBeenCalled();
  });
});
