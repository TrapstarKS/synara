// FILE: SidebarStatusTrailingGlyph.tsx
// Purpose: Keep thread status glyphs identical across classic and Activity sidebar rows.
// Layer: Sidebar UI primitive

import { cn } from "~/lib/utils";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { ThreadRunningSpinner } from "./ThreadRunningSpinner";

export function SidebarUnreadCompletionGlyph({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Unread completion"
      className={cn("size-[7px] shrink-0 rounded-full bg-[var(--color-text-accent)]", className)}
    />
  );
}

export function SidebarStatusTrailingGlyph({ status }: { status: ThreadStatusPill }) {
  if (status.label === "Completed") {
    return <SidebarUnreadCompletionGlyph />;
  }
  if (status.working) {
    return (
      <span
        role="img"
        aria-label={`${status.label} · Working`}
        className="relative inline-flex shrink-0 items-center justify-center"
      >
        <ThreadRunningSpinner />
        <span className={cn("absolute size-1.5 rounded-full", status.dotClass)} />
      </span>
    );
  }
  if (status.pulse) {
    return (
      <span role="img" aria-label={status.label} className="inline-flex shrink-0">
        <ThreadRunningSpinner />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={status.label}
      className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)}
    />
  );
}
