import { afterEach, describe, expect, it, vi } from "vitest";
import { copyImageToClipboard } from "./desktopClipboard";

const originalBridgeDescriptor = Object.getOwnPropertyDescriptor(window, "desktopBridge");
afterEach(() => {
  if (originalBridgeDescriptor)
    Object.defineProperty(window, "desktopBridge", originalBridgeDescriptor);
  else Reflect.deleteProperty(window, "desktopBridge");
});

describe("clipboard image conversion in Chromium", () => {
  it("decodes a JPEG and sends real PNG pixels through the existing native image bridge", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 12;
    canvas.getContext("2d")!.fillRect(0, 0, 16, 12);
    const jpeg = await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), "image/jpeg"),
    );
    const writeImagePngDataUrl = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { clipboard: { writeImagePngDataUrl } },
    });
    expect(await copyImageToClipboard(jpeg)).toBe(true);
    const dataUrl = writeImagePngDataUrl.mock.calls[0]![0] as string;
    expect(dataUrl).toMatch(/^data:image\/png;base64,/u);
    const decoded = new Image();
    decoded.src = dataUrl;
    await decoded.decode();
    expect(decoded.naturalWidth).toBe(16);
    expect(decoded.naturalHeight).toBe(12);
  });
});
