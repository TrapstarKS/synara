import {
  PROVIDER_DISPLAY_NAMES,
  type ThreadCoordinationListResult,
  type ThreadCoordinationTarget,
  type ThreadCoordinationWait,
} from "@synara/contracts";

export const coordinationTargetLabels: Record<ThreadCoordinationTarget["state"], string> = {
  pending: "Preparing or saving result",
  queued: "Queued",
  running: "Working",
  approval: "Needs approval",
  input: "Needs an answer",
  question: "Waiting for coordinator",
  completed: "Completed",
  error: "Failed",
  interrupted: "Interrupted",
  unavailable: "Unavailable",
};

export function coordinationFinishedCount(wait: ThreadCoordinationWait): number {
  return wait.targets.filter((target) =>
    ["completed", "error", "interrupted", "unavailable"].includes(target.state),
  ).length;
}

export function coordinationWaitLabel(wait: ThreadCoordinationWait): string {
  if (wait.state !== "waiting") return "Continuing with thread results";
  const unfinished = wait.targets.filter(
    (target) => !["completed", "error", "interrupted", "unavailable"].includes(target.state),
  );
  const provider = unfinished.length === 1 ? unfinished[0]?.provider : null;
  if (provider) return `Waiting for ${PROVIDER_DISPLAY_NAMES[provider]}`;
  return "Waiting for thread results";
}

export interface ThreadCoordinationBadge {
  readonly label: string;
  readonly needsInput: boolean;
}

export function coordinationBadges(
  data: ThreadCoordinationListResult | undefined,
): Map<string, ThreadCoordinationBadge> {
  const badges = new Map<string, ThreadCoordinationBadge>();
  if (!data) return badges;
  for (const wait of data.waits) {
    if (!badges.has(wait.threadId)) {
      badges.set(wait.threadId, {
        label:
          wait.targets.length > 1
            ? `Waiting · ${coordinationFinishedCount(wait)}/${wait.targets.length}`
            : coordinationWaitLabel(wait),
        needsInput: false,
      });
    }
  }
  for (const question of data.questions) {
    if (question.state === "human") {
      badges.set(question.coordinatorThreadId, { label: "Needs your answer", needsInput: true });
    } else if (
      (question.state === "asked" || question.state === "notified") &&
      !badges.get(question.coordinatorThreadId)?.needsInput
    ) {
      badges.set(question.coordinatorThreadId, {
        label: "Executor has a question",
        needsInput: false,
      });
    }
    if (
      question.state !== "answered" &&
      question.state !== "cancelled" &&
      !badges.has(question.executorThreadId)
    ) {
      badges.set(question.executorThreadId, {
        label: "Waiting for coordinator",
        needsInput: false,
      });
    }
  }
  return badges;
}
