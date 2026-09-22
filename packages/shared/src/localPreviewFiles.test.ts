import { describe, expect, it } from "vitest";

import { isSupportedLocalPreviewFilePath, isSupportedLocalVideoPath } from "./localPreviewFiles";

describe("local preview file extensions", () => {
  it.each(["clip.mp4", "recording.MOV", "animation.webm", "archive.mkv", "capture.avi"])(
    "recognizes %s as a video preview",
    (filePath) => {
      expect(isSupportedLocalVideoPath(filePath)).toBe(true);
      expect(isSupportedLocalPreviewFilePath(filePath)).toBe(true);
    },
  );

  it.each(["notes.ts", "photo.png.tmp", "video.mp4.txt"])(
    "does not recognize %s as a video preview",
    (filePath) => {
      expect(isSupportedLocalVideoPath(filePath)).toBe(false);
    },
  );
});
