import type { AsyncUserInput, AsyncUserInputQuestions } from "@synara/contracts";

type MessageWithAsyncInput = {
  readonly role: string;
  readonly asyncUserInput?: AsyncUserInput | undefined;
};

export function hasPendingAsyncUserInput(message: MessageWithAsyncInput): boolean {
  return (
    message.role === "assistant" &&
    message.asyncUserInput !== undefined &&
    message.asyncUserInput.response === undefined
  );
}

/** Keep outstanding questions addressable when the ordinary transcript tail is capped. */
export function retainMessagesWithPendingAsyncInputs<T extends MessageWithAsyncInput>(
  messages: readonly T[],
  limit: number,
): T[] {
  const tailStart = Math.max(0, messages.length - limit);
  return messages.filter(
    (message, index) => index >= tailStart || hasPendingAsyncUserInput(message),
  );
}

export const ASYNC_USER_INPUT_ALREADY_ANSWERED =
  "This asynchronous question has already been answered.";

export function formatAsyncUserInputResponse(
  questions: AsyncUserInputQuestions,
  answers: readonly string[],
): string {
  return questions
    .map((question, index) => `${question.title}\n${answers[index] ?? ""}`)
    .join("\n\n");
}
