// FILE: MessagesTimeline.find.browser.tsx
// Purpose: Browser regression for imperative active-match updates in mounted rows.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId } from "@synara/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vitest/browser";
import { createRef, useRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { MessagesTimeline, type MessagesTimelineController } from "./MessagesTimeline";
import type { TimelineEntry } from "../../session-logic";

const MESSAGE_ID = MessageId.makeUnsafe("assistant-find");
const TIMELINE_ENTRIES: TimelineEntry[] = [
  {
    id: "assistant-find",
    kind: "message",
    createdAt: "2026-01-01T00:00:00.000Z",
    message: {
      id: MESSAGE_ID,
      role: "assistant",
      text: "Error one. Error two.",
      createdAt: "2026-01-01T00:00:00.000Z",
      streaming: false,
    },
  },
];

function FindTimelineHarness({
  onNavigate = () => {},
  listRef,
}: {
  onNavigate?: () => void;
  listRef?: RefObject<LegendListRef | null>;
}) {
  const controllerRef = useRef<MessagesTimelineController | null>(null);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          controllerRef.current?.setActiveFindMatch({
            messageId: MESSAGE_ID,
            startOffset: 11,
            endOffset: 16,
          });
        }}
      >
        Activate second
      </button>
      <button
        type="button"
        onClick={() => controllerRef.current?.scrollToMessage(MESSAGE_ID, { fineScrollFind: true })}
      >
        Jump to match
      </button>
      <button type="button" onClick={() => controllerRef.current?.scrollToMessage(MESSAGE_ID)}>
        Jump to pinned message
      </button>
      <div style={{ height: 420 }}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          controllerRef={controllerRef}
          {...(listRef ? { listRef } : {})}
          onNavigate={onNavigate}
          timelineEntries={TIMELINE_ENTRIES}
          turnDiffSummaryByAssistantMessageId={new Map()}
          nowIso="2026-01-01T00:00:01.000Z"
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat="locale"
          workspaceRoot={undefined}
          findHighlight={{
            query: "error",
            activeMatch: { messageId: MESSAGE_ID, startOffset: 0, endOffset: 5 },
          }}
        />
      </div>
    </div>
  );
}

describe("MessagesTimeline in-thread find", () => {
  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it("moves the active decoration through the DOM without a timeline state update", async () => {
    await render(<FindTimelineHarness />);
    expect(
      document.querySelector('[data-chat-find-start="0"]')?.getAttribute("data-chat-find-match"),
    ).toBe("active");

    await page.getByRole("button", { name: "Activate second" }).click();

    expect(
      document.querySelector('[data-chat-find-start="0"]')?.getAttribute("data-chat-find-match"),
    ).toBe("true");
    expect(
      document.querySelector('[data-chat-find-start="11"]')?.getAttribute("data-chat-find-match"),
    ).toBe("active");
  });

  it("scrolls to the active search occurrence and still supports pinned-message jumps", async () => {
    const onNavigate = vi.fn();
    const scrolledElements: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolledElements.push(this);
    });
    await render(<FindTimelineHarness onNavigate={onNavigate} />);
    await page.getByRole("button", { name: "Activate second" }).click();
    await page.getByRole("button", { name: "Jump to match", exact: true }).click();
    await expect
      .poll(() =>
        scrolledElements.some((element) => element.getAttribute("data-chat-find-start") === "11"),
      )
      .toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(1);

    await page.getByRole("button", { name: "Jump to pinned message", exact: true }).click();
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(document.querySelector(`[data-message-id="${MESSAGE_ID}"]`)?.className).toContain(
      "bg-[var(--color-background-elevated-secondary)]",
    );
  });

  it("centers the search occurrence only after the list's row jump settles", async () => {
    const listRef = createRef<LegendListRef>();
    await render(<FindTimelineHarness listRef={listRef} />);
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const coarse = vi.spyOn(listRef.current!, "scrollToIndex").mockReturnValue(pending);
    const fine = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    await page.getByRole("button", { name: "Jump to match", exact: true }).click();
    expect(coarse).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(fine).not.toHaveBeenCalled();
    settle();
    await expect.poll(() => fine.mock.calls.length).toBe(1);
  });

  it.each(["new jump", "wheel", "unmount"])(
    "does not finish an obsolete search jump after %s",
    async (reason) => {
      const listRef = createRef<LegendListRef>();
      const screen = await render(<FindTimelineHarness listRef={listRef} />);
      let settle!: () => void;
      vi.spyOn(listRef.current!, "scrollToIndex").mockReturnValue(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
      const fine = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
      await page.getByRole("button", { name: "Jump to match", exact: true }).click();
      if (reason === "new jump") {
        await page.getByRole("button", { name: "Jump to pinned message", exact: true }).click();
      } else if (reason === "wheel") {
        listRef
          .current!.getScrollableNode()!
          .dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -40 }));
      } else {
        await screen.unmount();
      }
      settle();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      expect(fine).not.toHaveBeenCalled();
    },
  );
});
