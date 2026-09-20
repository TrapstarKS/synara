// FILE: MessagesTimeline.toolDetails.browser.tsx
// Purpose: Browser regressions for inline tool-call detail expand/collapse motion.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId, TurnId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkspaceFileOpenerContext } from "../../lib/workspaceFileOpener";
import { formatTimestamp } from "../../timestampFormat";
import { deriveTimelineEntries, type TimelineEntry } from "../../workLog";
import { MessagesTimeline } from "./MessagesTimeline";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";

const imageWorker = setupWorker(
  http.get(
    "*/api/local-image",
    () =>
      new HttpResponse(
        Uint8Array.from(
          atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==",
          ),
          (char) => char.charCodeAt(0),
        ),
        { headers: { "Content-Type": "image/png" } },
      ),
  ),
);
beforeAll(() => imageWorker.start({ quiet: true, onUnhandledRequest: "bypass" }));
afterAll(() => imageWorker.stop());

function ToolDetailsTimeline({ entries }: { entries?: TimelineEntry[] }) {
  return (
    <MessagesTimeline
      hasMessages
      isWorking={entries !== undefined}
      activeTurnInProgress={entries !== undefined}
      activeTurnStartedAt={null}
      timelineEntries={
        entries ?? [
          {
            id: "entry-command-details",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-command-details",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Searched",
              command: `rg -n "toolDetails" apps/web/src`,
              toolDetails: {
                kind: "command",
                title: "Searched",
                command: `rg -n "toolDetails" apps/web/src`,
                output: {
                  stdout: "apps/web/src/session-logic.ts:55: toolDetails",
                },
              },
            },
          },
        ]
      }
      turnDiffSummaryByAssistantMessageId={new Map()}
      nowIso="2026-03-17T19:12:30.000Z"
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
    />
  );
}

function LiveActivityTimeline() {
  const nowMs = Date.now();
  return (
    <TimelineWorkEntryRow
      workEntry={{
        id: "work-live-activity",
        createdAt: "2026-03-17T19:12:28.000Z",
        label: "Bash",
        tone: "tool",
        itemType: "command_execution",
        toolTitle: "Running",
        command: "bun install",
        liveActivity: {
          state: "running_tool",
          label: "Running bun install",
          startedAt: new Date(nowMs - 134_000).toISOString(),
          lastActivityAt: new Date(nowMs - 2_000).toISOString(),
          detail: "Resolving packages",
          progress: 0.42,
          elapsedSeconds: 132,
        },
      }}
      chatMetaFontSizePx={12}
      textFontSizePx={13}
      density="compact"
      onImageExpand={() => {}}
      markdownCwd={undefined}
      timestampFormat="24-hour"
    />
  );
}

function createTimelineHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:600px;height:520px;overflow:hidden;";
  document.body.append(host);
  return host;
}

async function settleLayout(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

describe("MessagesTimeline tool details", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps historical tool disclosures above the next request after late updates", async () => {
    const oldTurn = TurnId.makeUnsafe("old-tools");
    const newTurn = TurnId.makeUnsafe("current-tools");
    const entries = (late: boolean) =>
      deriveTimelineEntries(
        [
          {
            id: MessageId.makeUnsafe("old-user"),
            role: "user",
            text: "Earlier request",
            createdAt: "2026-09-07T00:00:00Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("old-answer"),
            role: "assistant",
            turnId: oldTurn,
            text: "Earlier answer",
            createdAt: "2026-09-07T00:01:00Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("current-user"),
            role: "user",
            text: "Current request",
            createdAt: "2026-09-07T00:02:00Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("current-answer"),
            role: "assistant",
            turnId: newTurn,
            text: "Current answer",
            createdAt: "2026-09-07T00:02:01Z",
            streaming: true,
          },
        ],
        [],
        [
          ...Array.from({ length: 79 }, (_, index) => ({
            id: `earlier-tool-${index}`,
            turnId: oldTurn,
            tone: "tool" as const,
            label: "Earlier tool",
            createdAt: late ? "2026-09-07T00:03:00Z" : "2026-09-07T00:00:30Z",
          })),
          {
            id: "current-tool",
            turnId: newTurn,
            tone: "tool",
            label: "Current tool",
            createdAt: "2026-09-07T00:02:02Z",
          },
        ],
      );
    const host = createTimelineHost();
    const screen = await render(<ToolDetailsTimeline entries={entries(false)} />, {
      container: host,
    });
    try {
      await screen.rerender(<ToolDetailsTimeline entries={entries(true)} />);
      await settleLayout();
      const boundary = host.querySelector('[data-message-id="current-user"]')!;
      expect(boundary).not.toBeNull();
      const rows = [...host.querySelectorAll("[data-timeline-row-kind]")];
      const currentRows = rows.filter((row) =>
        Boolean(boundary.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
      const currentText = currentRows.map((row) => row.textContent).join(" ");
      expect(currentText).toContain("Current tool");
      expect(currentText).not.toMatch(/Earlier tool|Show .* more/);
      const earlierRows = rows.filter((row) =>
        Boolean(boundary.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING),
      );
      expect(earlierRows.length).toBeGreaterThan(0);
      expect(earlierRows.some((row) => row.textContent?.includes("Earlier answer"))).toBe(true);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("opens and closes command details with the shared disclosure motion", async () => {
    const host = createTimelineHost();
    const screen = await render(<ToolDetailsTimeline />, { container: host });
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    const pendingFrames: Array<FrameRequestCallback | null> = [];

    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      );
      expect(trigger).not.toBeNull();
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();

      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        pendingFrames.push(callback);
        return pendingFrames.length;
      };
      window.cancelAnimationFrame = (handle: number) => {
        pendingFrames[handle - 1] = null;
      };

      trigger?.click();

      await expect.poll(() => trigger?.getAttribute("aria-expanded")).toBe("true");
      await expect
        .poll(() => document.querySelector("[data-tool-details-inline='true']") !== null)
        .toBe(true);
      const openingHiddenRegion = document
        .querySelector("[data-tool-details-inline='true']")
        ?.closest("[aria-hidden='true']");
      expect(openingHiddenRegion).not.toBeNull();
      expect(openingHiddenRegion?.hasAttribute("inert")).toBe(true);

      const framesToFlush = pendingFrames.splice(0);
      expect(framesToFlush.some((frame) => frame !== null)).toBe(true);
      for (const frame of framesToFlush) {
        frame?.(performance.now());
      }
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;

      await expect
        .poll(
          () =>
            document
              .querySelector("[data-tool-details-inline='true']")
              ?.closest("[aria-hidden='true']") ?? null,
        )
        .toBeNull();
      expect(document.body.textContent ?? "").toContain(`rg -n "toolDetails" apps/web/src`);

      trigger?.click();

      await expect.poll(() => trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-tool-details-inline='true']")).not.toBeNull();
      const closingHiddenRegion = document
        .querySelector("[data-tool-details-inline='true']")
        ?.closest("[aria-hidden='true']");
      expect(closingHiddenRegion).not.toBeNull();
      expect(closingHiddenRegion?.hasAttribute("inert")).toBe(true);

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 320);
      });
      await expect
        .poll(() => document.querySelector("[data-tool-details-inline='true']"))
        .toBeNull();
      await settleLayout();
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });

  it("keeps live activity compact and reveals technical metadata on demand", async () => {
    const host = createTimelineHost();
    const screen = await render(<LiveActivityTimeline />, { container: host });

    try {
      expect(document.body.textContent ?? "").toContain("Running bun install");
      expect(document.body.textContent ?? "").toContain("Active");
      expect(document.body.textContent ?? "").toContain("2m 14s elapsed");
      expect(document.body.textContent ?? "").toContain("42%");
      expect(document.body.textContent ?? "").not.toContain("Resolving packages");
      const displayText = document.querySelector("[data-work-entry-display-text='true']");
      const activityMeta = document.querySelector("[data-live-activity-meta='true']");
      expect(displayText?.closest("p")).toBe(activityMeta?.closest("p"));
      expect(displayText?.closest("p")?.textContent ?? "").toContain(
        "Running bun install · Active",
      );

      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      );
      expect(trigger).not.toBeNull();
      trigger?.click();

      await expect.poll(() => document.body.textContent ?? "").toContain("Resolving packages");
      expect(document.body.textContent ?? "").toContain("Activity");
      expect(document.body.textContent ?? "").toContain("Running tool");
      expect(document.body.textContent ?? "").toContain("42%");
      for (const time of document.querySelectorAll<HTMLTimeElement>("time[datetime]")) {
        expect(time.textContent).toBe(formatTimestamp(time.dateTime, "24-hour"));
      }
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });

  it("keeps MCP calls compact by default and reveals native Codex v2 identity, arguments, and results", async () => {
    const host = createTimelineHost();
    const screen = await render(
      <TimelineWorkEntryRow
        workEntry={{
          id: "mcp-native-details",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "MCP tool call",
          tone: "tool",
          itemType: "mcp_tool_call",
          toolName: "mcp__computer-use__get_app_state",
          toolTitle: "Computer: Get app state",
          toolStatus: "completed",
          liveActivity: {
            state: "completed",
            label: "Computer: Get app state",
            startedAt: "2026-03-17T19:12:28.000Z",
            lastActivityAt: "2026-03-17T19:12:30.000Z",
          },
          toolDetails: {
            kind: "tool-call",
            title: "Computer: Get app state",
            appName: "Computer",
            actionName: "Get app state",
            server: "computer-use",
            tool: "get_app_state",
            arguments: '{\n  "app": "Safari",\n  "includeDom": false\n}',
            result: "Safari is focused",
            structuredResult: '{\n  "focused": true\n}',
            durationMs: 2_000,
          },
        }}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        timestampFormat="locale"
      />,
      { container: host },
    );

    try {
      expect(document.body.textContent ?? "").toContain("Computer: Get app state");
      expect(document.body.textContent ?? "").not.toContain("computer-use");
      expect(document.body.textContent ?? "").not.toContain('"includeDom"');
      expect(document.body.textContent ?? "").not.toContain("Safari is focused");

      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      );
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      trigger?.click();

      await expect.poll(() => document.body.textContent ?? "").toContain("MCP server");
      const expandedText = document.body.textContent ?? "";
      expect(expandedText).toContain("computer-use");
      expect(expandedText).toContain("get_app_state");
      expect(expandedText).toContain("Arguments");
      expect(expandedText).toContain("includeDom");
      expect(expandedText).toContain("Safari is focused");
      expect(expandedText).toContain("Structured result");
      expect(expandedText).toContain("2.0 s");
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });

  it("reveals the generated image preview inside expanded activity details", async () => {
    const onImageExpand = vi.fn();
    const host = createTimelineHost();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <TimelineWorkEntryRow
          workEntry={{
            id: "generated-image-activity",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Generated image",
            tone: "tool",
            itemType: "image_generation",
            detail: "/tmp/synara/generated/pose_HAYMAKER_orig.png",
            liveActivity: {
              state: "completed",
              label: "Generated image",
              lastActivityAt: "2026-03-17T19:12:29.000Z",
            },
          }}
          chatMetaFontSizePx={12}
          textFontSizePx={13}
          density="compact"
          onImageExpand={onImageExpand}
          markdownCwd={undefined}
          timestampFormat="locale"
        />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      );
      expect(trigger).not.toBeNull();
      trigger?.click();

      await expect
        .poll(() => document.querySelector<HTMLImageElement>('img[alt="Generated image"]'))
        .not.toBeNull();
      const image = document.querySelector<HTMLImageElement>('img[alt="Generated image"]');
      expect(image?.src).toContain("pose_HAYMAKER_orig.png");
      await expect.poll(() => image?.naturalWidth).toBe(1);
      document.querySelector<HTMLButtonElement>('[aria-label="Expand generated image"]')?.click();
      expect(onImageExpand).toHaveBeenCalledWith({
        images: [
          expect.objectContaining({
            name: "pose_HAYMAKER_orig.png",
          }),
        ],
        index: 0,
      });
    } finally {
      await screen.unmount();
      queryClient.clear();
      host.remove();
      await settleLayout();
    }
  });

  it("states settled tool calls as a sentence without a lifecycle tail", async () => {
    const host = createTimelineHost();
    const screen = await render(
      <TimelineWorkEntryRow
        workEntry={{
          id: "work-settled-command",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Ran command",
          tone: "tool",
          itemType: "command_execution",
          toolTitle: "Searched",
          command: `rg -n "toolDetails" apps/web/src`,
          liveActivity: {
            state: "completed",
            label: "Searched",
            startedAt: "2026-03-17T19:12:28.000Z",
            lastActivityAt: "2026-03-17T19:12:29.000Z",
            elapsedSeconds: 1,
          },
        }}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        timestampFormat="locale"
      />,
      { container: host },
    );

    try {
      const rowText = document.querySelector("[data-work-entry-display-text='true']")?.textContent;
      expect(rowText).toBe("Searched for toolDetails in web/src");
      expect(document.querySelector("[data-live-activity-meta='true']")).toBeNull();
      expect(document.body.textContent ?? "").not.toContain("Completed");
      expect(document.body.textContent ?? "").not.toContain("elapsed");
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });

  it("keeps agent activity as the primary action when live metadata is present", async () => {
    const onOpenAgentActivity = vi.fn();
    const nowMs = Date.now();
    const host = createTimelineHost();
    const screen = await render(
      <TimelineWorkEntryRow
        workEntry={{
          id: "agent-live-activity",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Agent task",
          tone: "tool",
          itemType: "collab_agent_tool_call",
          detail: "Review the implementation",
          liveActivity: {
            state: "running_tool",
            label: "Agent task",
            startedAt: new Date(nowMs - 2_000).toISOString(),
            lastActivityAt: new Date(nowMs - 1_000).toISOString(),
          },
        }}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        onOpenAgentActivity={onOpenAgentActivity}
        timestampFormat="locale"
      />,
      { container: host },
    );

    try {
      expect(document.querySelector("[data-tool-detail-trigger='true']")).toBeNull();
      document.querySelector<HTMLButtonElement>("button")?.click();
      expect(onOpenAgentActivity).toHaveBeenCalledWith("agent-live-activity");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();
      expect(document.body.textContent ?? "").toContain("Agent task");
      expect(document.body.textContent ?? "").toContain("Subagent working");
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });

  it("opens the turn diff for activity-only file rows", async () => {
    const onOpenTurnDiff = vi.fn();
    const turnId = TurnId.makeUnsafe("turn-file-activity");
    const host = createTimelineHost();
    const screen = await render(
      <TimelineWorkEntryRow
        workEntry={{
          id: "file-live-activity",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Edited file",
          tone: "tool",
          itemType: "file_change",
          changedFiles: ["src/app.ts"],
          liveActivity: {
            state: "completed",
            label: "Edited file",
            lastActivityAt: "2026-03-17T19:12:29.000Z",
          },
        }}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        turnId={turnId}
        onOpenTurnDiff={onOpenTurnDiff}
        timestampFormat="locale"
      />,
      { container: host },
    );

    try {
      const fileRow = document.querySelector<HTMLButtonElement>("[data-file-change-row='true']");
      expect(fileRow).not.toBeNull();
      fileRow?.click();
      expect(onOpenTurnDiff).toHaveBeenCalledWith(turnId, "src/app.ts");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });

  it("preserves the file-open action for activity-only read rows", async () => {
    const openFile = vi.fn(() => true);
    const host = createTimelineHost();
    const screen = await render(
      <WorkspaceFileOpenerContext.Provider value={{ openFile }}>
        <TimelineWorkEntryRow
          workEntry={{
            id: "read-live-activity",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Read file",
            tone: "tool",
            requestKind: "file-read",
            detail: "src/app.ts",
            liveActivity: {
              state: "completed",
              label: "Read file",
              lastActivityAt: "2026-03-17T19:12:29.000Z",
            },
          }}
          chatMetaFontSizePx={12}
          textFontSizePx={13}
          density="compact"
          onImageExpand={() => {}}
          markdownCwd={undefined}
          timestampFormat="locale"
        />
      </WorkspaceFileOpenerContext.Provider>,
      { container: host },
    );

    try {
      expect(document.querySelector("[data-tool-detail-trigger='true']")).toBeNull();
      document.querySelector<HTMLButtonElement>("button")?.click();
      expect(openFile).toHaveBeenCalledWith("src/app.ts");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();
      expect(document.body.textContent ?? "").toContain("Read file app.ts");
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });
});
