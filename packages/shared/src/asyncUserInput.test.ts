import { describe, expect, it } from "vitest";
import { MessageId } from "@synara/contracts";
import {
  clearRemovedAsyncUserInputResponses,
  hasPendingAsyncUserInput,
  mergeAsyncUserInput,
  retainMessagesWithPendingAsyncInputs,
} from "./asyncUserInput";

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

  it("only clears answers removed by a history edit", () => {
    const questions = [{ title: "Which option?" }];
    const answered = {
      questions,
      response: { messageId: MessageId.makeUnsafe("answer"), answers: ["A"] },
      responseSequence: 5,
    };
    const messages = [{ id: "question", asyncUserInput: answered }];
    expect(
      clearRemovedAsyncUserInputResponses(messages, new Set(["question", "answer"]), 10)[0],
    ).toBe(messages[0]);
    expect(
      clearRemovedAsyncUserInputResponses(messages, new Set(["question"]), 10)[0]?.asyncUserInput,
    ).toEqual({ questions, responseSequence: 10 });
  });

  it("orders answer and rollback metadata independently of message text", () => {
    const pending = { questions: [{ title: "Which option?" }] };
    const answered = {
      ...pending,
      response: { messageId: MessageId.makeUnsafe("answer"), answers: ["A"] },
      responseSequence: 5,
    };
    const reopened = { ...pending, responseSequence: 10 };
    expect(mergeAsyncUserInput(answered, pending)).toBe(answered);
    expect(mergeAsyncUserInput(answered, reopened)).toBe(reopened);
    expect(mergeAsyncUserInput(reopened, answered)).toBe(reopened);
    const replacement = {
      ...answered,
      response: { ...answered.response, answers: ["B"] },
      responseSequence: 15,
    };
    expect(mergeAsyncUserInput(reopened, replacement)).toBe(replacement);
    expect(mergeAsyncUserInput(replacement, answered)).toBe(replacement);
  });
});
