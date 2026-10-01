import "../../index.css";
import { ThreadId, TurnId, type ThreadCoordinationListResult } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ThreadCoordinationPanelContent } from "./ThreadCoordinationPanel";
import { useAsyncUserInputDraftStore } from "./asyncUserInputDraftStore";

const threadId = ThreadId.makeUnsafe("coordinator-ui");
const childId = ThreadId.makeUnsafe("executor-ui");
const data: ThreadCoordinationListResult = {
  waits: [
    {
      waitId: "wait-ui",
      threadId,
      createdAt: "2026-10-01T10:00:00.000Z",
      state: "waiting",
      cancellable: true,
      targets: [
        {
          threadId: childId,
          title: "Review the queue and cancellation paths",
          provider: "codex",
          runId: null,
          messageId: null,
          state: "question",
        },
        {
          threadId: ThreadId.makeUnsafe("tests-ui"),
          title: "Run focused tests",
          provider: "claudeAgent",
          runId: null,
          messageId: null,
          state: "completed",
        },
      ],
    },
  ],
  questions: [
    {
      questionId: "question-ui",
      waitId: "wait-ui",
      coordinatorThreadId: threadId,
      executorThreadId: childId,
      executorTurnId: TurnId.makeUnsafe("executor-ask-run"),
      question: "Should this change also ship in Stable?",
      state: "human",
      answer: null,
      escalationReason: "The release scope needs your decision.",
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z",
    },
  ],
  hasMore: false,
};

describe("ThreadCoordinationPanel", () => {
  afterEach(() => useAsyncUserInputDraftStore.setState({ drafts: {}, inFlight: new Set() }));

  it("shows exact task progress, opens the selected thread and prevents duplicate cancellation", async () => {
    let accept!: () => void;
    const onCancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const onOpenThread = vi.fn();
    const screen = await render(
      <ThreadCoordinationPanelContent
        data={{ ...data, questions: [] }}
        threadId={threadId}
        onOpenThread={onOpenThread}
        onCancel={onCancel}
        onAnswer={vi.fn()}
      />,
    );
    await expect.element(screen.getByText("1/2 finished")).toBeVisible();
    await expect
      .element(screen.getByText("Waiting for coordinator", { exact: true }))
      .toBeVisible();
    await screen
      .getByRole("button", { name: "Open thread: Review the queue and cancellation paths" })
      .click();
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(childId);
    await screen.getByRole("button", { name: "Cancel wait", exact: true }).click();
    await expect.element(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(onCancel).toHaveBeenCalledExactlyOnceWith("wait-ui");
    accept();
    await expect
      .element(screen.getByRole("button", { name: "Cancel wait", exact: true }))
      .toBeEnabled();
  });

  it("keeps the user's answer after a rejected send and never presents it as accepted", async () => {
    const onAnswer = vi.fn().mockRejectedValue(new Error("This question was cancelled."));
    const screen = await render(
      <ThreadCoordinationPanelContent
        data={data}
        threadId={threadId}
        onOpenThread={vi.fn()}
        onCancel={vi.fn()}
        onAnswer={onAnswer}
      />,
    );
    await expect
      .element(screen.getByRole("form", { name: "Questions from delegated task" }))
      .toBeVisible();
    await screen.getByRole("textbox").fill("Beta first, keep Stable unchanged.");
    await screen.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("This question was cancelled.");
    await expect
      .element(screen.getByRole("textbox"))
      .toHaveValue("Beta first, keep Stable unchanged.");
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(
      "question-ui",
      "Beta first, keep Stable unchanged.",
    );
    await expect.element(screen.getByText("Answered", { exact: true })).not.toBeInTheDocument();
  });

  it("isolates questions by coordinator and disables stale mutating actions", async () => {
    const props = { data, onOpenThread: vi.fn(), onCancel: vi.fn(), onAnswer: vi.fn() };
    const screen = await render(
      <ThreadCoordinationPanelContent {...props} threadId={ThreadId.makeUnsafe("another-chat")} />,
    );
    await expect
      .element(screen.getByRole("region", { name: "Thread coordination" }))
      .not.toBeInTheDocument();
    await screen.rerender(<ThreadCoordinationPanelContent {...props} threadId={threadId} stale />);
    await expect.element(screen.getByRole("textbox")).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Cancel wait", exact: true }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Send answer", exact: true }))
      .toBeDisabled();
  });

  it("keeps long task names and a human question inside a compact chat column", async () => {
    const screen = await render(
      <div style={{ width: 360, height: 720 }}>
        <ThreadCoordinationPanelContent
          data={data}
          threadId={threadId}
          onOpenThread={vi.fn()}
          onCancel={vi.fn()}
          onAnswer={vi.fn()}
        />
      </div>,
    );
    await expect.element(screen.getByText("Delegated task needs your answer")).toBeVisible();
    const section = document.querySelector<HTMLElement>('[aria-label="Thread coordination"]')!;
    expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth + 1);
    const textbox = screen.getByRole("textbox");
    await expect.element(textbox).toHaveAttribute("maxlength", "8000");
    await page.screenshot({
      path: "__screenshots__/ThreadCoordinationPanel.browser.tsx/compact.png",
    });
  });
});
