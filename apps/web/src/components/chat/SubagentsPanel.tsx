import type { ThreadId } from "@synara/contracts";

import { BotIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import {
  humanizeSubagentStatus,
  resolveSubagentPresentationForThread,
} from "~/lib/subagentPresentation";
import type { SidebarThreadSummary } from "~/types";
import { isThreadActivelyWorking, resolveThreadStatusPill } from "../Sidebar.logic";
import { Button } from "../ui/button";

export function SubagentsPanel({
  threadId,
  threads,
  onOpen,
}: {
  threadId: ThreadId;
  threads: readonly SidebarThreadSummary[];
  onOpen: (threadId: ThreadId) => void;
}) {
  const children = threads
    .filter((thread) => thread.parentThreadId === threadId && thread.archivedAt == null)
    .toSorted(
      (left, right) =>
        Date.parse(right.latestTurn?.completedAt ?? right.updatedAt ?? right.createdAt) -
        Date.parse(left.latestTurn?.completedAt ?? left.updatedAt ?? left.createdAt),
    );
  const rows = children.map((thread) => {
    const pill = resolveThreadStatusPill({
      thread,
      hasPendingApprovals: thread.hasPendingApprovals,
      hasPendingUserInput: thread.hasPendingUserInput,
    });
    const active =
      isThreadActivelyWorking(thread) ||
      pill?.label === "Connecting" ||
      pill?.label === "Pending Approval" ||
      pill?.label === "Awaiting Input";
    const status = active
      ? (pill?.label ?? "Working")
      : (humanizeSubagentStatus(thread.latestTurn?.state ?? thread.session?.status) ?? "Idle");
    return { thread, active, status };
  });
  const active = rows.filter((row) => row.active);
  const completed = rows.filter((row) => !row.active);

  return (
    <div className="h-full overflow-y-auto px-3 py-5">
      {[
        { label: "Active", items: active },
        { label: "Completed", items: completed },
      ].map(({ label, items }) => (
        <section key={label} aria-label={`${label} subagents`} className="mb-6">
          <h2 className="mb-2 px-2 text-xs font-normal text-muted-foreground">
            {label} · {items.length}
          </h2>
          {items.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {label === "Active" ? "No active subagents" : "No completed subagents"}
            </p>
          ) : (
            items.map(({ thread, active, status }) => {
              const identity = resolveSubagentPresentationForThread({ thread });
              const timestamp =
                thread.latestTurn?.completedAt ?? thread.updatedAt ?? thread.createdAt;
              return (
                <Button
                  key={thread.id}
                  variant="ghost"
                  className="h-11 w-full justify-start gap-3 px-2 font-normal"
                  aria-label={`Open ${identity.primaryLabel}, ${status}`}
                  title={identity.fullLabel}
                  onClick={() => onOpen(thread.id)}
                >
                  <BotIcon className="size-4 shrink-0" style={{ color: identity.accentColor }} />
                  <span className="min-w-0 flex-1 truncate text-left text-sm">
                    {identity.primaryLabel}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {active || status !== "Completed" ? (
                      status
                    ) : (
                      <time dateTime={timestamp} title={status}>
                        {formatRelativeTime(timestamp)}
                      </time>
                    )}
                  </span>
                </Button>
              );
            })
          )}
        </section>
      ))}
    </div>
  );
}
