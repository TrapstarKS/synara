import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentActivityDetailView } from "./AgentActivityDetailView";

describe("AgentActivityDetailView", () => {
  it("renders a full agent activity detail surface", () => {
    const markup = renderToStaticMarkup(
      <AgentActivityDetailView
        detail={{
          id: "agent-task-1",
          title: "Find changelog implementation",
          summary: "Agent found the relevant files.",
          primaryEntry: {
            id: "agent-task-1",
            createdAt: "2026-06-05T00:00:00.000Z",
            label: "Find changelog implementation",
            tone: "tool",
            itemType: "collab_agent_tool_call",
            detail: "Agent found the relevant files.",
            subagentAction: {
              tool: "task",
              status: "completed",
              summaryText: "Agent activity",
              prompt: "Explore the changelog implementation.",
            },
          },
          entries: [
            {
              id: "agent-task-1",
              createdAt: "2026-06-05T00:00:00.000Z",
              label: "Find changelog implementation",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              detail: "Agent found the relevant files.",
              subagentAction: {
                tool: "task",
                status: "completed",
                summaryText: "Agent activity",
                prompt: "Explore the changelog implementation.",
              },
              subagents: [
                {
                  threadId: "child-provider",
                  resolvedThreadId: "subagent:parent:child-provider",
                  nickname: "Newton",
                  role: "explorer",
                  model: "gpt-5.6-luna",
                  statusLabel: "Running",
                  isActive: true,
                  latestUpdate: "Inspecting lifecycle events.",
                },
              ],
            },
          ],
        }}
        chatFontSizePx={14}
        markdownCwd={undefined}
        onBack={() => {}}
        onImageExpand={() => {}}
        onOpenThread={() => {}}
        timestampFormat="locale"
      />,
    );

    expect(markup).toContain("Back");
    expect(markup).toContain("Find changelog implementation");
    expect(markup).toContain("Explore the changelog implementation.");
    expect(markup).toContain("Agent found the relevant files.");
    expect(markup).toContain("Agents");
    expect(markup).toContain("Newton");
    expect(markup).toContain("Inspecting lifecycle events.");
    expect(markup).toContain("Open");
  });
});
