import { describe, expect, it } from "vitest";

import { deriveWorkLogToolDetails } from "~/lib/toolCallDetails";

import {
  collectChatGalleryImages,
  extractMarkdownImages,
  extractToolResultImagePaths,
  type ChatGalleryWorkEntry,
} from "./imageGallery.logic";

const toolEntry = (
  id: string,
  toolDetails: ChatGalleryWorkEntry["toolDetails"],
  overrides: Partial<ChatGalleryWorkEntry> = {},
): ChatGalleryWorkEntry => ({
  id,
  createdAt: "2026-09-24T10:00:00.000Z",
  tone: "tool",
  itemType: "mcp_tool_call",
  activityKind: "tool.completed",
  ...(toolDetails ? { toolDetails } : {}),
  ...overrides,
});

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

  it("collects images that non-Codex tools report as saved paths", () => {
    const images = collectChatGalleryImages(
      [],
      [
        // Claude's serialized tool_result (text plus an inline image block).
        toolEntry("claude-generate", {
          kind: "tool-call",
          title: "generate_image",
          result:
            '[{"type":"text","text":"Saved 2 images:\\n/Users/me/repo/cat.png\\n/Users/me/repo/cat-2.webp"},{"type":"image","synaraImageOmitted":true}]',
        }),
        toolEntry("proof", {
          kind: "tool-call",
          title: "browser_screenshot",
          structuredResult: '{"artifactPath":"C:\\\\Users\\\\me\\\\proof.png"}',
        }),
      ],
    );
    expect(images.map((image) => image.src).toSorted()).toEqual([
      "/Users/me/repo/cat-2.webp",
      "/Users/me/repo/cat.png",
      "C:\\Users\\me\\proof.png",
    ]);
    expect(images.every((image) => image.origin === "Agent")).toBe(true);
  });

  it("reads the saved path from a Claude codex-media tool_result payload", () => {
    const toolDetails = deriveWorkLogToolDetails({
      itemType: "mcp_tool_call",
      label: "generate_image",
      payload: {
        data: {
          toolName: "mcp__codex-media__generate_image",
          input: { prompt: "a cat" },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "Saved 1 image:\n/Users/me/repo/a-cat.png" },
              { type: "image", source: { type: "base64", synaraImageOmitted: true } },
            ],
          },
        },
      },
    });
    expect(extractToolResultImagePaths(toolEntry("claude", toolDetails))).toEqual([
      "/Users/me/repo/a-cat.png",
    ]);
  });

  it("skips URLs, commands and failed or running tool calls", () => {
    expect(
      extractToolResultImagePaths(
        toolEntry("remote", {
          kind: "tool-call",
          title: "fetch",
          result: "See https://example.com/a.png and ./relative.png",
        }),
      ),
    ).toEqual([]);
    const saved = { kind: "tool-call" as const, title: "t", result: "Saved /tmp/a.png" };
    expect(
      collectChatGalleryImages(
        [],
        [
          toolEntry("command", {
            kind: "command",
            title: "ls",
            command: "ls",
            result: "/tmp/a.png",
          }),
          toolEntry("failed", saved, { toolStatus: "failed" }),
          toolEntry("running", saved, { activityKind: "tool.updated" }),
        ],
      ),
    ).toEqual([]);
  });

  it("ignores unsafe or non-image Markdown destinations", () => {
    expect(extractMarkdownImages("![x](javascript:alert(1)) ![file](/tmp/readme.txt)")).toEqual([]);
  });
});
