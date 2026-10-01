import {
  MessageId,
  ThreadId,
  type CoordinatorQuestion,
  type ThreadCoordinationListResult,
  type ThreadCoordinationWait,
} from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { ensureNativeApi } from "../../nativeApi";
import { ChevronDownIcon, CircleQuestionIcon, ClockIcon } from "../../lib/icons";
import {
  coordinationFinishedCount,
  coordinationTargetLabels,
  coordinationWaitLabel,
} from "../../lib/threadCoordination";
import {
  threadCoordinationQueryKey,
  useThreadCoordination,
} from "../../lib/threadCoordinationQuery";
import { ProviderIcon } from "../ProviderIcon";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { AsyncUserInputCard } from "./AsyncUserInputCard";

function WaitCard({
  wait,
  onOpenThread,
  onCancel,
  disabled,
}: {
  wait: ThreadCoordinationWait;
  onOpenThread: (threadId: ThreadId) => void;
  onCancel: (waitId: string) => Promise<void>;
  disabled: boolean;
}) {
  const [cancelling, setCancelling] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    if (inFlight.current || disabled || !wait.cancellable) return;
    inFlight.current = true;
    setCancelling(true);
    setError(null);
    try {
      await onCancel(wait.waitId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel the wait. Try again.");
    } finally {
      inFlight.current = false;
      setCancelling(false);
    }
  };
  return (
    <Collapsible defaultOpen className="rounded-xl border border-border bg-muted/20">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 text-left text-ui">
          <ClockIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate" role="status">
            {coordinationWaitLabel(wait)}
          </span>
          <span className="shrink-0 text-ui-xs tabular-nums text-muted-foreground">
            {coordinationFinishedCount(wait)}/{wait.targets.length} finished
          </span>
          <ChevronDownIcon
            className="size-3.5 shrink-0 group-aria-expanded:rotate-180"
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        {wait.cancellable && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void cancel()}
            disabled={disabled || cancelling}
          >
            {cancelling ? "Cancelling…" : "Cancel wait"}
          </Button>
        )}
      </div>
      <CollapsiblePanel>
        <div className="space-y-2 border-t border-border/60 px-3 py-2">
          {wait.targets.map((target) => (
            <div
              key={JSON.stringify([target.threadId, target.messageId ?? target.runId])}
              className="flex min-w-0 items-center gap-2 text-ui"
            >
              <ProviderIcon provider={target.provider} className="size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate" title={target.title}>
                  {target.title}
                </p>
                <p className="text-ui-xs text-muted-foreground">
                  {coordinationTargetLabels[target.state]}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onOpenThread(target.threadId)}
                disabled={target.state === "unavailable"}
                aria-label={`Open thread: ${target.title}`}
              >
                Open thread
              </Button>
            </div>
          ))}
          <p className="text-ui-xs text-muted-foreground">
            This conversation continues automatically. Cancelling the wait leaves delegated tasks
            running.
          </p>
        </div>
      </CollapsiblePanel>
      {error && (
        <p role="alert" className="px-3 pb-2 text-ui-sm text-destructive">
          {error}
        </p>
      )}
    </Collapsible>
  );
}

function CoordinatorQuestionCard({
  question,
  onAnswer,
  onOpenThread,
  disabled,
}: {
  question: CoordinatorQuestion;
  onAnswer: (questionId: string, answer: string) => Promise<void>;
  onOpenThread: (threadId: ThreadId) => void;
  disabled: boolean;
}) {
  const human = question.state === "human";
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-ui">
      <div className="flex items-center gap-2">
        <CircleQuestionIcon
          className="size-4 shrink-0 text-amber-600 dark:text-amber-300"
          aria-hidden="true"
        />
        <span className="flex-1 font-medium" role="status">
          {human
            ? "Delegated task needs your answer"
            : question.state === "answering"
              ? "Returning the answer to the executor"
              : "Executor has a question"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onOpenThread(question.executorThreadId)}
        >
          Open executor
        </Button>
      </div>
      {question.escalationReason && (
        <p className="mt-2 whitespace-pre-wrap text-ui-sm text-muted-foreground">
          {question.escalationReason}
        </p>
      )}
      {human ? (
        <AsyncUserInputCard
          messageId={MessageId.makeUnsafe(`coordinator-question:${question.questionId}`)}
          draftKey={JSON.stringify([
            "coordinator-question",
            question.coordinatorThreadId,
            question.questionId,
          ])}
          input={{ questions: [{ title: question.question }] }}
          defaultOpen
          sourceLabel="delegated task"
          footerLabel="Your answer returns to the executor"
          maxAnswerLength={8_000}
          onRespond={
            disabled
              ? undefined
              : async (_messageId, answers) => onAnswer(question.questionId, answers[0] ?? "")
          }
        />
      ) : (
        <>
          <p className="mt-2 whitespace-pre-wrap">{question.question}</p>
          <p className="mt-1 text-ui-xs text-muted-foreground">
            {question.state === "answering"
              ? "The executor will continue when its current response finishes."
              : "The coordinator can answer from the existing task context or ask you here."}
          </p>
        </>
      )}
    </div>
  );
}

export function ThreadCoordinationPanelContent({
  data,
  threadId,
  onOpenThread,
  onCancel,
  onAnswer,
  stale = false,
}: {
  data: ThreadCoordinationListResult;
  threadId: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
  onCancel: (waitId: string) => Promise<void>;
  onAnswer: (questionId: string, answer: string) => Promise<void>;
  stale?: boolean;
}) {
  const waits = data.waits.filter((wait) => wait.threadId === threadId);
  const questions = data.questions.filter(
    (question) =>
      question.coordinatorThreadId === threadId &&
      question.state !== "answered" &&
      question.state !== "cancelled",
  );
  if (waits.length === 0 && questions.length === 0) return null;
  return (
    <section
      aria-label="Thread coordination"
      data-scroll-anchor-ignore
      className="max-h-[40vh] shrink-0 space-y-2 overflow-y-auto overscroll-contain px-4 py-2"
    >
      {stale && (
        <p role="alert" className="text-ui-sm text-destructive">
          Coordination status could not be refreshed. Reconnect or refresh before taking action.
        </p>
      )}
      {questions.map((question) => (
        <CoordinatorQuestionCard
          key={question.questionId}
          question={question}
          onAnswer={onAnswer}
          onOpenThread={onOpenThread}
          disabled={stale}
        />
      ))}
      {waits.map((wait) => (
        <WaitCard
          key={wait.waitId}
          wait={wait}
          onOpenThread={onOpenThread}
          onCancel={onCancel}
          disabled={stale}
        />
      ))}
      {data.hasMore && (
        <p className="text-ui-xs text-muted-foreground">
          Showing the most recent coordination requests.
        </p>
      )}
    </section>
  );
}

export function ThreadCoordinationPanel({
  threadId: rawThreadId,
  onOpenThread,
  enabled = true,
}: {
  threadId: string;
  onOpenThread: (threadId: ThreadId) => void;
  enabled?: boolean;
}) {
  const threadId = ThreadId.makeUnsafe(rawThreadId);
  const query = useThreadCoordination(threadId, enabled);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: threadCoordinationQueryKey });
  if (!enabled || !query.data) return null;
  return (
    <ThreadCoordinationPanelContent
      data={query.data}
      threadId={threadId}
      onOpenThread={onOpenThread}
      stale={query.isError}
      onCancel={async (waitId) => {
        const api = ensureNativeApi().coordination;
        if (!api) throw new Error("Thread coordination is unavailable in this app version.");
        const result = await api.cancelWait({ threadId, waitId });
        await refresh();
        if (!result.accepted)
          throw new Error("This wait already changed. Its current status has been refreshed.");
      }}
      onAnswer={async (questionId, answer) => {
        const api = ensureNativeApi().coordination;
        if (!api) throw new Error("Thread coordination is unavailable in this app version.");
        const result = await api.answerQuestion({ threadId, questionId, answer });
        await refresh();
        if (!result.accepted) throw new Error("This question no longer accepts an answer.");
      }}
    />
  );
}
