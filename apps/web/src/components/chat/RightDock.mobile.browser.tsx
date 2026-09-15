import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RIGHT_DOCK_WIDTH_STORAGE_KEY, RightDock } from "./RightDock";

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

it("restores a custom desktop width after the dock remounts", async () => {
  await page.viewport(1280, 720);
  const previousWidth = localStorage.getItem(RIGHT_DOCK_WIDTH_STORAGE_KEY);
  localStorage.setItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, "432");
  const state = {
    open: true,
    activePaneId: "images",
    panes: [
      {
        id: "images",
        kind: "images" as const,
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
  };
  const renderDock = () =>
    render(
      <RightDock
        state={state}
        minWidth={320}
        defaultWidth="28rem"
        shouldAcceptWidth={() => true}
        addMenuKinds={[]}
        onClosePane={vi.fn()}
        onCollapse={vi.fn()}
        onOpenChange={vi.fn()}
        onAddPane={vi.fn()}
        renderPane={() => <div>Desktop image gallery</div>}
      />,
    );

  try {
    const firstScreen = await renderDock();
    try {
      await expect.element(page.getByText("Desktop image gallery")).toBeVisible();
      await expect
        .poll(() =>
          document
            .querySelector<HTMLElement>("[data-slot='sidebar-wrapper']")
            ?.style.getPropertyValue("--sidebar-width"),
        )
        .toBe("432px");
    } finally {
      await firstScreen.unmount();
    }

    const secondScreen = await renderDock();
    try {
      await expect
        .poll(() =>
          document
            .querySelector<HTMLElement>("[data-slot='sidebar-wrapper']")
            ?.style.getPropertyValue("--sidebar-width"),
        )
        .toBe("432px");
    } finally {
      await secondScreen.unmount();
    }
  } finally {
    if (previousWidth === null) {
      localStorage.removeItem(RIGHT_DOCK_WIDTH_STORAGE_KEY);
    } else {
      localStorage.setItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, previousWidth);
    }
  }
});
