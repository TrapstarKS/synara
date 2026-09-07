import { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { SidebarThreadSummary } from "~/types";
import { SubagentsPanel } from "./SubagentsPanel";

it("keeps completed agents accessible, separates live work, and follows completion", async () => {
  const parentId = ThreadId.makeUnsafe("parent");
  const completed: SidebarThreadSummary = {
    id: ThreadId.makeUnsafe("completed"),
    projectId: ProjectId.makeUnsafe("project"),
    parentThreadId: parentId,
    title: "Investigate sidebar",
    modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-09-07T20:00:00.000Z",
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn"),
      state: "completed",
      requestedAt: "2026-09-07T20:00:00.000Z",
      startedAt: "2026-09-07T20:00:00.000Z",
      completedAt: "2026-09-07T20:01:00.000Z",
      assistantMessageId: null,
    },
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
  };
  const working = {
    ...completed,
    id: ThreadId.makeUnsafe("working"),
    title: "Review changes",
    hasLiveTailWork: true,
  };
  const unrelated = {
    ...completed,
    id: ThreadId.makeUnsafe("unrelated"),
    parentThreadId: ThreadId.makeUnsafe("other"),
    title: "Other task",
  };
  const archived = {
    ...completed,
    id: ThreadId.makeUnsafe("archived"),
    archivedAt: "2026-09-07T20:05:00.000Z",
    title: "Archived agent",
  };
  const onOpen = vi.fn();
  const view = await render(
    <SubagentsPanel
      threadId={parentId}
      threads={[completed, working, unrelated, archived]}
      onOpen={onOpen}
    />,
  );
  await expect.element(page.getByRole("heading", { name: "Active · 1" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Completed · 1" })).toBeVisible();
  await expect.element(page.getByText("Other task")).not.toBeInTheDocument();
  await expect.element(page.getByText("Archived agent")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Open Investigate sidebar, Completed" }).click();
  expect(onOpen).toHaveBeenCalledWith(completed.id);
  await view.rerender(
    <SubagentsPanel
      threadId={parentId}
      threads={[completed, { ...working, hasLiveTailWork: false }]}
      onOpen={onOpen}
    />,
  );
  await expect.element(page.getByText("No active subagents")).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Completed · 2" })).toBeVisible();
});
