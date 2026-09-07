import "../../index.css";

import { MessageId } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { ChatMessage } from "~/types";
import { ImagesPanel } from "./ImagesPanel";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

afterEach(() => {
  document.body.innerHTML = "";
});

it("shows sent and generated images and expands the selected item", async () => {
  const messages: ChatMessage[] = [
    {
      id: MessageId.makeUnsafe("user-image"),
      role: "user",
      text: "",
      attachments: [
        {
          type: "image",
          id: "reference",
          name: "Reference image",
          mimeType: "image/svg+xml",
          sizeBytes: 10,
          previewUrl: PIXEL,
        },
      ],
      createdAt: "2026-09-09T10:00:00.000Z",
      streaming: false,
    },
    {
      id: MessageId.makeUnsafe("assistant-image"),
      role: "assistant",
      text: `![Generated result](${PIXEL}#generated)`,
      createdAt: "2026-09-09T10:01:00.000Z",
      streaming: false,
    },
  ];

  const screen = await render(<ImagesPanel messages={messages} cwd={null} />);
  try {
    await expect.element(page.getByText("2")).toBeVisible();
    await expect.element(page.getByText("You")).toBeVisible();
    await expect.element(page.getByText("Agent")).toBeVisible();
    await page.getByRole("button", { name: "Open Generated result" }).click();
    await expect
      .element(page.getByRole("dialog", { name: "Expanded image preview" }))
      .toBeVisible();
    await expect.element(page.getByText("Generated result (2/2)")).toBeVisible();
  } finally {
    await screen.unmount();
  }
});
