// FILE: ComposerPromptEditor.mobile.browser.tsx
// Purpose: Prevents iOS from auto-zooming the composer when it receives focus.

import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor } from "./ComposerPromptEditor";

afterEach(async () => {
  await page.viewport(960, 720);
});

describe("ComposerPromptEditor mobile typography", () => {
  it("uses the 16px input size that prevents Safari focus zoom", async () => {
    await page.viewport(430, 932);
    const mounted = await render(
      <ComposerPromptEditor
        value=""
        cursor={0}
        terminalContexts={[]}
        disabled={false}
        placeholder="Write a message"
        onRemoveTerminalContext={vi.fn()}
        onChange={vi.fn()}
        onPaste={vi.fn()}
      />,
    );

    const editor = page.getByTestId("composer-editor");
    await expect.element(editor).toBeVisible();
    expect(getComputedStyle(editor.element()).fontSize).toBe("16px");

    await mounted.unmount();
  });
});
