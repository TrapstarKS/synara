import type { MessageId } from "@synara/contracts";
import { hasPendingAsyncUserInput } from "@synara/shared/asyncUserInput";
import { CircleQuestionIcon, ChevronDownIcon } from "~/lib/icons";
import type { ChatMessage } from "../../types";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { AsyncUserInputCard } from "./AsyncUserInputCard";
import { asyncQuestionDraftKey } from "./asyncUserInputDraftStore";

export function ComposerAsyncUserInputPanel({
  threadId,
  messages,
  onRespond,
}: {
  threadId: string;
  messages: readonly ChatMessage[];
  onRespond: (messageId: MessageId, answers: readonly string[]) => Promise<void>;
}) {
  const pending = messages.filter(hasPendingAsyncUserInput);
  if (pending.length === 0) return null;
  const questionCount = pending.reduce(
    (count, message) => count + message.asyncUserInput!.questions.length,
    0,
  );
  const pendingLabel = `${questionCount} ${questionCount === 1 ? "question awaits" : "questions await"} your answer`;
  return (
    <Collapsible className="mb-2 rounded-xl border border-amber-500/30 bg-amber-500/5">
      <CollapsibleTrigger
        aria-label={pendingLabel}
        className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <CircleQuestionIcon
          className="size-4 shrink-0 text-amber-600 dark:text-amber-300"
          aria-hidden="true"
        />
        <span className="flex-1" role="status" aria-live="polite">
          {pendingLabel}
        </span>
        <ChevronDownIcon
          className="size-3.5 shrink-0 group-aria-expanded:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel keepMounted>
        <div className="max-h-[40vh] overflow-y-auto overscroll-contain px-3 pb-2">
          {pending.map((message) => (
            <AsyncUserInputCard
              key={message.id}
              draftKey={asyncQuestionDraftKey(threadId, message.id)}
              messageId={message.id}
              input={message.asyncUserInput!}
              onRespond={onRespond}
              defaultOpen={pending.length === 1}
            />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
