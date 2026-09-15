import "../../index.css";

import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { Sidebar, SidebarProvider } from "./sidebar";

function MobileSidebarHarness({ side = "left" }: { side?: "left" | "right" }) {
  const [open, setOpen] = useState(false);

  return (
    <SidebarProvider
      mobileOpen={open}
      mobileSwipeSide={side}
      onMobileOpenChange={setOpen}
      open={false}
    >
      <Sidebar side={side}>
        <button className="flex h-full w-full items-center justify-center" type="button">
          Threads
        </button>
      </Sidebar>
      <main className="h-screen w-full">Chat</main>
    </SidebarProvider>
  );
}

function dispatchPointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      isPrimary: true,
      pointerId: 1,
      pointerType: "touch",
    }),
  );
}

beforeEach(async () => {
  await page.viewport(430, 932);
});

afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(960, 720);
});

it("opens from the left edge and closes with an outward swipe", async () => {
  const mounted = await render(<MobileSidebarHarness />);

  try {
    dispatchPointer(document, "pointerdown", 8, 400);
    dispatchPointer(document, "pointermove", 80, 402);
    dispatchPointer(document, "pointerup", 80, 402);
    await expect.element(page.getByText("Threads")).toBeVisible();

    const popup = document.querySelector<HTMLElement>(
      '[data-mobile="true"][data-sidebar-side="left"]',
    );
    if (!popup) throw new Error("Mobile sidebar popup is missing");
    expect(getComputedStyle(popup).overscrollBehavior).toBe("contain");
    expect(popup.style.paddingBlock).toContain("safe-area-inset");
    const threadButton = popup.querySelector("button");
    if (!threadButton) throw new Error("Mobile sidebar thread button is missing");
    dispatchPointer(threadButton, "pointerdown", 300, 400);
    dispatchPointer(threadButton, "pointermove", 220, 402);
    dispatchPointer(threadButton, "pointerup", 220, 402);
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-mobile="true"][data-sidebar-side="left"]'),
      ).toBeNull();
    });
  } finally {
    await mounted.unmount();
  }
});

it("keeps vertical scrolling gestures from opening the sidebar", async () => {
  const mounted = await render(<MobileSidebarHarness />);

  try {
    dispatchPointer(document, "pointerdown", 8, 400);
    dispatchPointer(document, "pointermove", 10, 500);
    dispatchPointer(document, "pointerup", 10, 500);
    expect(
      document.querySelector('[data-mobile="true"][data-sidebar-side="left"]'),
    ).toBeNull();
  } finally {
    await mounted.unmount();
  }
});

it("mirrors the gesture from the right edge for right-side panels", async () => {
  const mounted = await render(<MobileSidebarHarness side="right" />);

  try {
    dispatchPointer(document, "pointerdown", 422, 400);
    dispatchPointer(document, "pointermove", 350, 402);
    dispatchPointer(document, "pointerup", 350, 402);
    await expect.element(page.getByText("Threads")).toBeVisible();
  } finally {
    await mounted.unmount();
  }
});
