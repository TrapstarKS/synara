import type { ThreadId } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Resolves the projection thread that owns provider-session side effects.
 * Lookup failures intentionally propagate: falling back to the child id on a
 * transient failure would let independent reactors choose different lease keys.
 */
export function resolveProviderSessionThread(
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
  threadId: ThreadId,
) {
  return Effect.gen(function* () {
    const thread = Option.getOrNull(yield* projectionSnapshotQuery.getThreadDetailById(threadId));
    if (thread === null) {
      return null;
    }
    if (thread.parentThreadId) {
      return (
        Option.getOrNull(
          yield* projectionSnapshotQuery.getThreadDetailById(thread.parentThreadId),
        ) ?? thread
      );
    }
    if (!(thread.id as string).startsWith("subagent:")) {
      return thread;
    }
    return (
      Option.getOrNull(
        yield* projectionSnapshotQuery.findSyntheticSubagentParentThread(thread.id),
      ) ?? thread
    );
  });
}

export const resolveSubagentProviderThreadId = (
  threadId: ThreadId,
  parentThreadId: ThreadId | null | undefined,
): string | undefined => {
  if (!parentThreadId) {
    return undefined;
  }

  const prefix = `subagent:${parentThreadId}:`;
  const rawThreadId = threadId as string;
  return rawThreadId.startsWith(prefix) ? rawThreadId.slice(prefix.length) : undefined;
};
