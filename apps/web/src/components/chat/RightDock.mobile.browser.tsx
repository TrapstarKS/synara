import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RightDock } from "./RightDock";

beforeEach(async () => {
  await page.viewport(430, 932);
});

afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(960, 720);
});

it("opens a controlled dock pane as a mobile sheet", async () => {
  const onCollapse = vi.fn();
  const screen = await render(
    <RightDock
      state={{
        open: true,
        activePaneId: "images",
        panes: [
          {
            id: "images",
            kind: "images",
            threadId: null,
            diffTurnId: null,
            diffFilePath: null,
            filePath: null,
            pullRequestProjectId: null,
            pullRequestRepository: null,
            pullRequestNumber: null,
            pullRequestInitialTab: null,
          },
        ],
      }}
      minWidth={320}
      defaultWidth="28rem"
      shouldAcceptWidth={() => true}
      addMenuKinds={[]}
      onClosePane={vi.fn()}
      onCollapse={onCollapse}
      onOpenChange={vi.fn()}
      onAddPane={vi.fn()}
      renderPane={() => <div>Mobile image gallery</div>}
    />,
  );

  try {
    await expect.element(page.getByText("Mobile image gallery")).toBeVisible();
    await expect.element(page.getByText("Images")).toBeVisible();
    await page.getByRole("button", { name: "Collapse panel" }).click();
    expect(onCollapse).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});
