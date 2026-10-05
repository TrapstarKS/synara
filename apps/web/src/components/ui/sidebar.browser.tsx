import "../../index.css";

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  SIDEBAR_OFFCANVAS_MOTION_CLASS,
  useSidebar,
} from "./sidebar";

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

function Controls({ name }: { name: string }) {
  const { state } = useSidebar();
  return (
    <>
      <SidebarTrigger aria-label={`Toggle ${name}`} />
      <output aria-label={`${name} state`}>{state}</output>
    </>
  );
}

function ControlledSidebar() {
  const [open, setOpen] = useState(true);
  return (
    <SidebarProvider open={open} onOpenChange={setOpen}>
      <Controls name="right" />
    </SidebarProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("sidebar toggles", () => {
  it.each(["left", "right"] as const)(
    "settles the %s panel and layout gap immediately with reduced motion",
    async (side) => {
      const protocol = cdp() as {
        send(
          method: "Emulation.setEmulatedMedia",
          params: { features: { name: string; value: string }[] },
        ): Promise<void>;
      };
      await protocol.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      await page.viewport(1280, 800);
      const screen = await render(
        <SidebarProvider defaultOpen>
          <SidebarTrigger aria-label="Toggle motion panel" className="relative z-50" />
          <Sidebar
            side={side}
            className={SIDEBAR_OFFCANVAS_MOTION_CLASS}
            gapClassName={SIDEBAR_OFFCANVAS_MOTION_CLASS}
          >
            Panel content
          </Sidebar>
        </SidebarProvider>,
      );
      try {
        const panel = screen.container.querySelector<HTMLElement>(
          '[data-slot="sidebar-container"]',
        )!;
        const gap = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!;
        const initial = panel.getBoundingClientRect();
        await page.getByRole("button", { name: "Toggle motion panel" }).click();
        expect(panel.getAnimations()).toHaveLength(0);
        expect(gap.getAnimations()).toHaveLength(0);
        expect(panel.getBoundingClientRect().left).toBeCloseTo(
          initial.left + (side === "left" ? -initial.width : initial.width),
          0,
        );
        expect(gap.getBoundingClientRect().width).toBe(0);
        await page.getByRole("button", { name: "Toggle motion panel" }).click();
        expect(panel.getAnimations()).toHaveLength(0);
        expect(gap.getAnimations()).toHaveLength(0);
        expect(panel.getBoundingClientRect().left).toBeCloseTo(initial.left, 0);
        expect(gap.getBoundingClientRect().width).toBeCloseTo(initial.width, 0);
      } finally {
        await screen.unmount();
        await protocol.send("Emulation.setEmulatedMedia", { features: [] });
      }
    },
  );

  it.each(["missing", "rejecting"])(
    "toggles controlled and uncontrolled sidebars when CookieStore is %s",
    async (cookieStoreState) => {
      await page.viewport(1280, 800);
      vi.stubGlobal(
        "cookieStore",
        cookieStoreState === "missing"
          ? undefined
          : {
              set: () =>
                Promise.reject(
                  new TypeError("An unknown error occurred while writing the cookie."),
                ),
            },
      );
      const screen = await render(
        <>
          <SidebarProvider defaultOpen>
            <Controls name="left" />
          </SidebarProvider>
          <ControlledSidebar />
        </>,
      );
      try {
        for (const state of ["collapsed", "expanded"]) {
          for (const name of ["left", "right"]) {
            await page.getByRole("button", { name: `Toggle ${name}` }).click();
            await expect
              .element(page.getByRole("status", { name: `${name} state` }))
              .toHaveTextContent(state);
          }
        }
      } finally {
        await screen.unmount();
      }
    },
  );
});

describe("mobile sidebar gestures", () => {
  beforeEach(async () => {
    await page.viewport(430, 932);
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(960, 720);
  });

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
        expect(document.querySelector('[data-mobile="true"][data-sidebar-side="left"]')).toBeNull();
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
      expect(document.querySelector('[data-mobile="true"][data-sidebar-side="left"]')).toBeNull();
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
});
