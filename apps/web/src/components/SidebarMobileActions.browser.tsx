// FILE: SidebarMobileActions.browser.tsx
// Purpose: Keeps compact sidebar actions tappable without overlapping on mobile.

import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ArchiveIcon, PinIcon } from "~/lib/icons";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarRowHoverActions } from "./SidebarRowHoverActions";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";

afterEach(async () => {
  await page.viewport(960, 720);
});

describe("mobile sidebar actions", () => {
  it("shows separate, real hit boxes for thread and project actions", async () => {
    await page.viewport(430, 932);
    const mounted = await render(
      <div className="w-72">
        <div className="group/thread-row relative flex h-11 items-center justify-end">
          <SidebarRowHoverActions threadId="mobile-thread">
            <div className="inline-flex items-center gap-2">
              <ThreadPinToggleButton pinned={false} presentation="inline" onToggle={() => {}} />
              <SidebarIconButton icon={ArchiveIcon} label="Archive mobile thread" />
            </div>
          </SidebarRowHoverActions>
        </div>
        <div className="group/project-header relative h-11" data-testid="project-row">
          <SidebarSectionToolbar placement="overlay" revealOnHover>
            <SidebarIconButton icon={PinIcon} label="First project action" />
            <SidebarIconButton icon={ArchiveIcon} label="Second project action" />
          </SidebarSectionToolbar>
        </div>
      </div>,
    );

    const threadActions = document.querySelector<HTMLElement>(
      '[data-testid="thread-hover-actions-mobile-thread"]',
    );
    expect(threadActions).not.toBeNull();
    expect(getComputedStyle(threadActions!).position).toBe("static");
    expect(getComputedStyle(threadActions!).pointerEvents).toBe("auto");
    expect(getComputedStyle(threadActions!).opacity).toBe("1");

    const threadButtons = [
      page.getByRole("button", { name: "Pin thread" }).element(),
      page.getByRole("button", { name: "Archive mobile thread" }).element(),
    ] as const;
    const projectButtons = [
      page.getByRole("button", { name: "First project action" }).element(),
      page.getByRole("button", { name: "Second project action" }).element(),
    ] as const;
    for (const button of [...threadButtons, ...projectButtons]) {
      expect(button.getBoundingClientRect().width).toBe(32);
      expect(button.getBoundingClientRect().height).toBe(32);
    }
    expect(threadButtons[0].getBoundingClientRect().right).toBeLessThanOrEqual(
      threadButtons[1].getBoundingClientRect().left,
    );
    expect(projectButtons[0].getBoundingClientRect().right).toBeLessThanOrEqual(
      projectButtons[1].getBoundingClientRect().left,
    );
    expect(getComputedStyle(projectButtons[0].parentElement!).pointerEvents).toBe("auto");

    await mounted.unmount();
  });
});
