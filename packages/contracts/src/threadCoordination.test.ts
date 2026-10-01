import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  COORDINATION_WS_METHODS,
  SynaraAskCoordinatorInput,
  SynaraAnswerQuestionInput,
  ThreadCoordinationAnswerQuestionInput,
} from "./threadCoordination";
import { WsFeatureRpcGroup } from "./rpc";

describe("thread coordination contracts", () => {
  it("rejects recipient overrides and bounds executor questions", () => {
    const decode = Schema.decodeUnknownSync(SynaraAskCoordinatorInput);
    expect(decode({ requestId: "question-1", question: "Which branch?" }).question).toBe(
      "Which branch?",
    );
    for (const value of [
      { requestId: "q", question: "Which branch?", recipientThreadId: "other" },
      { requestId: "q", question: "x".repeat(4_001) },
      { requestId: "x".repeat(161), question: "Which branch?" },
      { requestId: "q", question: " " },
    ])
      expect(() => decode(value)).toThrow();
  });

  it("bounds human and coordinator answer payloads", () => {
    expect(() =>
      Schema.decodeUnknownSync(SynaraAnswerQuestionInput)({
        questionId: "q",
        answer: "x".repeat(8_001),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ThreadCoordinationAnswerQuestionInput)({
        threadId: "parent",
        questionId: "q",
        answer: " ",
      }),
    ).toThrow();
  });

  it("registers each coordination method on the authenticated feature RPC group", () => {
    for (const method of Object.values(COORDINATION_WS_METHODS)) {
      expect(WsFeatureRpcGroup.requests.has(method)).toBe(true);
    }
  });
});
