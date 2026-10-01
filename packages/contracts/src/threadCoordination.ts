import { Schema } from "effect";

import { IsoDateTime, MessageId, ThreadId, TurnId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

export const COORDINATION_WS_METHODS = {
  list: "coordination.list",
  cancelWait: "coordination.cancelWait",
  answerQuestion: "coordination.answerQuestion",
} as const;

export const SynaraAskCoordinatorInput = Schema.Struct({
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SynaraAskCoordinatorInput = typeof SynaraAskCoordinatorInput.Type;

export const SynaraAnswerQuestionInput = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  answer: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8_000))),
  needsUser: Schema.optional(Schema.Boolean),
  reason: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SynaraAnswerQuestionInput = typeof SynaraAnswerQuestionInput.Type;

export const CoordinatorQuestion = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  waitId: TrimmedNonEmptyString,
  coordinatorThreadId: ThreadId,
  executorThreadId: ThreadId,
  executorTurnId: TurnId,
  question: Schema.String.check(Schema.isMaxLength(4_000)),
  state: Schema.Literals(["asked", "notified", "human", "answering", "answered", "cancelled"]),
  answer: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8_000))),
  escalationReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CoordinatorQuestion = typeof CoordinatorQuestion.Type;

export const ThreadCoordinationTarget = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  provider: Schema.NullOr(ProviderKind),
  runId: Schema.NullOr(TurnId),
  messageId: Schema.NullOr(MessageId),
  state: Schema.Literals([
    "pending",
    "queued",
    "running",
    "approval",
    "input",
    "question",
    "completed",
    "error",
    "interrupted",
    "unavailable",
  ]),
});
export type ThreadCoordinationTarget = typeof ThreadCoordinationTarget.Type;

export const ThreadCoordinationWait = Schema.Struct({
  waitId: TrimmedNonEmptyString,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  state: Schema.Literals(["waiting", "dispatching", "dispatched"]),
  cancellable: Schema.Boolean,
  targets: Schema.Array(ThreadCoordinationTarget),
});
export type ThreadCoordinationWait = typeof ThreadCoordinationWait.Type;

export const ThreadCoordinationListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
});
export type ThreadCoordinationListInput = typeof ThreadCoordinationListInput.Type;

export const ThreadCoordinationListResult = Schema.Struct({
  waits: Schema.Array(ThreadCoordinationWait),
  questions: Schema.Array(CoordinatorQuestion),
  hasMore: Schema.Boolean,
});
export type ThreadCoordinationListResult = typeof ThreadCoordinationListResult.Type;

export const ThreadCoordinationCancelWaitInput = Schema.Struct({
  threadId: ThreadId,
  waitId: TrimmedNonEmptyString,
});
export type ThreadCoordinationCancelWaitInput = typeof ThreadCoordinationCancelWaitInput.Type;

export const ThreadCoordinationAnswerQuestionInput = Schema.Struct({
  threadId: ThreadId,
  questionId: TrimmedNonEmptyString,
  answer: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
});
export type ThreadCoordinationAnswerQuestionInput =
  typeof ThreadCoordinationAnswerQuestionInput.Type;

export const ThreadCoordinationActionResult = Schema.Struct({ accepted: Schema.Boolean });
export type ThreadCoordinationActionResult = typeof ThreadCoordinationActionResult.Type;
