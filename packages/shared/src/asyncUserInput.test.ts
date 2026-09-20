import { describe, expect, it } from "vitest";
import { MessageId } from "@synara/contracts";
import { hasPendingAsyncUserInput, retainMessagesWithPendingAsyncInputs } from "./asyncUserInput";

describe("pending asynchronous questions", () => {
  it("retains every unanswered question outside the transcript window in causal order", () => {
    const question = {
      id: "question",
      role: "assistant",
      asyncUserInput: { questions: [{ title: "Which branch?" }] },
    };
    const messages = [
      question,
      ...Array.from({ length: 2_001 }, (_, index) => ({ id: `text-${index}`, role: "assistant" })),
    ];
    const retained = retainMessagesWithPendingAsyncInputs(messages, 2_000);
    expect(retained).toEqual([question, ...messages.slice(-2_000)]);
    expect(retained[0]).toBe(question);
  });

  it("releases answered questions and ignores user-authored question metadata", () => {
    const asyncUserInput = {
      questions: [{ title: "Which branch?" }],
      response: { messageId: MessageId.makeUnsafe("answer"), answers: ["main"] },
    };
    const messages = [
      { role: "assistant", asyncUserInput },
      { role: "user", asyncUserInput: { questions: asyncUserInput.questions } },
      { role: "assistant" },
    ];
    expect(messages.some(hasPendingAsyncUserInput)).toBe(false);
    expect(retainMessagesWithPendingAsyncInputs(messages, 1)).toEqual([messages[2]]);
  });
});
