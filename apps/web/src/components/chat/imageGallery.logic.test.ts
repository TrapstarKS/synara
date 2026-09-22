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

  it("collects sent attachments and generated images once with newest images first", () => {
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
      { src: "/tmp/result.png", name: "Generated image", origin: "Agent" },
      { src: "/api/attachments/upload-1", name: "reference.png", origin: "You" },
    ]);
  });

  it("collects completed generated-image work entries without assistant Markdown", () => {
    const images = collectChatGalleryImages(
      [],
      [
        {
          id: "generated-work",
          createdAt: "2026-09-09T10:02:00.000Z",
          tone: "tool",
          itemType: "image_generation",
          activityKind: "tool.completed",
          toolStatus: "completed",
          detail: "/tmp/generated-output.png",
        },
      ],
    );

    expect(images).toEqual([
      {
        id: "generated-work:generated-image",
        src: "/tmp/generated-output.png",
        name: "generated-output.png",
        origin: "Agent",
        createdAt: "2026-09-09T10:02:00.000Z",
      },
    ]);
  });

  it("does not add running or failed generated-image work entries", () => {
    const images = collectChatGalleryImages(
      [],
      [
        {
          id: "running-work",
          createdAt: "2026-09-09T10:02:00.000Z",
          tone: "tool",
          itemType: "image_generation",
          activityKind: "tool.started",
          toolStatus: "running",
          detail: "/tmp/running.png",
        },
        {
          id: "failed-work",
          createdAt: "2026-09-09T10:03:00.000Z",
          tone: "error",
          itemType: "image_generation",
          activityKind: "tool.completed",
          toolStatus: "failed",
          detail: "/tmp/failed.png",
        },
      ],
    );

    expect(images).toEqual([]);
  });

  it("ignores unsafe or non-image Markdown destinations", () => {
    expect(extractMarkdownImages("![x](javascript:alert(1)) ![file](/tmp/readme.txt)")).toEqual([]);
  });
});
