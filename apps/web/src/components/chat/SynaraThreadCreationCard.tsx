// FILE: SynaraThreadCreationCard.tsx
// Purpose: End-of-turn recap for threads created through the Synara MCP harness.
// Layer: Chat transcript UI

import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";
import { ThreadId } from "@synara/contracts";
import { memo, useEffect, useMemo, useState } from "react";

import type { WorkLogSynaraThreadCreation } from "../../session-logic";
import { useStore } from "../../store";
import { createThreadSelector } from "../../storeSelectors";
import { retainThreadDetailSubscription } from "../../threadDetailSubscriptionRetention";
import type { ChatMessage } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { ProviderIcon } from "../ProviderIcon";
import { SynaraLogo } from "../SynaraLogo";
import { Button } from "../ui/button";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { deriveOrchestratorChildStripItems } from "./ComposerSubagentStrip.logic";

export const CHILD_TRANSCRIPT_LIMIT = 20;

/** Last visible messages of a child thread; the final one is its latest reply/summary. */
export function childTranscriptPreview(
  messages: ReadonlyArray<ChatMessage>,
  limit = CHILD_TRANSCRIPT_LIMIT,
): ChatMessage[] {
  return messages.filter((m) => m.role !== "system" && m.text.trim().length > 0).slice(-limit);
}

function ChildStatus({ threadId }: { readonly threadId: string }) {
  const summary = useStore(
    (state) => state.sidebarThreadSummaryById[ThreadId.makeUnsafe(threadId)],
  );
  if (!summary) return null;
  const item = deriveOrchestratorChildStripItems([summary])[0];
  return (
    <span className="shrink-0 font-system-ui text-ui-xs text-muted-foreground/65">
      {item?.statusLabel}
    </span>
  );
}

// Mounted only while expanded, so the detail subscription is lazy.
function ChildTranscript({ threadId }: { readonly threadId: string }) {
  const id = ThreadId.makeUnsafe(threadId);
  useEffect(() => retainThreadDetailSubscription(id), [id]);
  const thread = useStore(useMemo(() => createThreadSelector(id), [id]));
  const recent = useMemo(() => childTranscriptPreview(thread?.messages ?? []), [thread?.messages]);
  if (!thread) {
    return <p className="px-3 py-2 text-ui-xs text-muted-foreground/60">Loading…</p>;
  }
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {recent.length === 0 ? (
        <p className="text-ui-xs text-muted-foreground/60">No messages yet.</p>
      ) : (
        recent.map((message) => (
          <div key={message.id} className="min-w-0">
            <p className="text-ui-xs font-medium text-muted-foreground/70">
              {message.role === "user" ? "Prompt" : "Reply"}
            </p>
            <ChatMarkdown
              text={message.text}
              cwd={undefined}
              isStreaming={false}
              className="text-ui-sm"
            />
          </div>
        ))
      )}
    </div>
  );
}

function ChildRow({
  thread,
  onOpenThread,
}: {
  readonly thread: WorkLogSynaraThreadCreation["threads"][number];
  readonly onOpenThread: ((threadId: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-[color:var(--color-border-light)] first:border-t-0">
      <div className="flex min-w-0 items-center gap-2.5 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <DisclosureChevron open={open} className="size-3 shrink-0 text-muted-foreground/60" />
          <ProviderIcon provider={thread.provider} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-system-ui text-ui font-medium text-foreground/90">
              {thread.title}
            </span>
            <span className="block truncate font-system-ui text-ui-xs text-muted-foreground/52">
              {threadMeta(thread)}
            </span>
          </span>
          <ChildStatus threadId={thread.threadId} />
        </button>
        {onOpenThread ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={() => onOpenThread(thread.threadId)}
          >
            Open thread
          </Button>
        ) : null}
      </div>
      <DisclosureRegion open={open}>
        {open ? <ChildTranscript threadId={thread.threadId} /> : null}
      </DisclosureRegion>
    </div>
  );
}

function threadMeta(thread: WorkLogSynaraThreadCreation["threads"][number]): string {
  const model = formatModelDisplayName(thread.model) ?? thread.model;
  const environment = thread.environment === "worktree" ? "Worktree" : "Local";
  return `${PROVIDER_DISPLAY_NAMES[thread.provider]} · ${model} · ${environment}`;
}

export const SynaraThreadCreationCard = memo(function SynaraThreadCreationCard({
  creation,
  onOpenThread,
}: {
  readonly creation: WorkLogSynaraThreadCreation;
  readonly onOpenThread?: (threadId: string) => void;
}) {
  const singleThread = creation.threads.length === 1 ? creation.threads[0] : undefined;
  const title = singleThread ? "Thread created" : `${creation.createdCount} threads created`;
  const summary = singleThread
    ? singleThread.title
    : `${creation.createdCount}/${creation.requestedCount} requested threads created`;

  return (
    <div
      className="overflow-hidden rounded-[0.65rem] border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] dark:border-[color:color-mix(in_srgb,var(--color-border-light)_55%,transparent)]"
      data-synara-thread-creation-card="true"
    >
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-foreground">
          <SynaraLogo className="h-[22px] w-auto" aria-label="Synara" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-system-ui text-ui-lg font-medium text-foreground/95">
            {title}
          </p>
          <p className="truncate font-system-ui text-ui-sm text-muted-foreground/65">{summary}</p>
        </div>
      </div>

      <div className="border-t border-[color:var(--color-border-light)]">
        {creation.threads.map((thread) => (
          <ChildRow key={thread.threadId} thread={thread} onOpenThread={onOpenThread} />
        ))}
      </div>
    </div>
  );
});
