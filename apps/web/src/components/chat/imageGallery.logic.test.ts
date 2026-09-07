import { describe, expect, it } from "vitest";

import { collectChatGalleryImages, extractMarkdownImages } from "./imageGallery.logic";

describe("image gallery", () => {
  it("extracts remote and angle-bracketed local Markdown images", () => {
    expect(
      extractMarkdownImages(
        "![Remote](https://example.com/a.png) ![Generated image](</tmp/generated image.webp>)",
      ),
    ).toEqual([
      { src: "https://example.com/a.png", alt: "Remote" },
      { src: "/tmp/generated image.webp", alt: "Generated image" },
    ]);
  });

  it("collects sent attachments and generated images once in message order", () => {
    const images = collectChatGalleryImages([
      {
        id: "user-1" as never,
        role: "user",
        text: "",
        attachments: [
          {
            type: "image",
            id: "upload-1",
            name: "reference.png",
            mimeType: "image/png",
            sizeBytes: 10,
            previewUrl: "/api/attachments/upload-1",
          },
        ],
        createdAt: "2026-09-09T10:00:00.000Z",
      },
      {
        id: "assistant-1" as never,
        role: "assistant",
        text: "![Generated image](</tmp/result.png>)\n![duplicate](</tmp/result.png>)",
        createdAt: "2026-09-09T10:01:00.000Z",
      },
    ]);

    expect(images).toMatchObject([
      { src: "/api/attachments/upload-1", name: "reference.png", origin: "You" },
      { src: "/tmp/result.png", name: "Generated image", origin: "Agent" },
    ]);
  });

  it("ignores unsafe or non-image Markdown destinations", () => {
    expect(extractMarkdownImages("![x](javascript:alert(1)) ![file](/tmp/readme.txt)")).toEqual([]);
  });
});
