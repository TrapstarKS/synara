// FILE: threadHierarchy.ts
// Purpose: Parent/child traversal over subagent and orchestrator thread linkage shared by server and web.
// Exports: collectSubagentDescendants, lifecycleParentThreadId

interface HierarchyThread {
  readonly id: string;
  readonly parentThreadId?: string | null | undefined;
  readonly creationSource?: string | null | undefined;
  readonly sourceThreadId?: string | null | undefined;
}

// A subagent belongs to its parentThreadId; a thread created through the Synara
// gateway (synara_create_threads) belongs to the orchestrator that created it.
export function lifecycleParentThreadId(thread: HierarchyThread): string | null {
  if (thread.parentThreadId) return thread.parentThreadId;
  return thread.creationSource === "synara_mcp" ? (thread.sourceThreadId ?? null) : null;
}

// Collects every thread reachable from `rootThreadId` through lifecycle parent
// links (subagent parents and orchestrators), breadth-first, excluding the root
// itself. Children are only reachable through their parent thread, so lifecycle
// changes on a parent (archive, restore, delete) apply to this whole subtree. Visited tracking keeps
// corrupted self- or cyclic linkage from hanging the caller.
export function collectSubagentDescendants<T extends HierarchyThread>(
  threads: readonly T[],
  rootThreadId: T["id"],
): T[] {
  const childrenByParentId = new Map<string, T[]>();
  for (const thread of threads) {
    const parentThreadId = lifecycleParentThreadId(thread);
    if (parentThreadId === null) {
      continue;
    }
    const siblings = childrenByParentId.get(parentThreadId);
    if (siblings === undefined) {
      childrenByParentId.set(parentThreadId, [thread]);
    } else {
      siblings.push(thread);
    }
  }

  const descendants: T[] = [];
  const visitedThreadIds = new Set<string>([rootThreadId]);
  const queue: string[] = [rootThreadId];
  for (let index = 0; index < queue.length; index += 1) {
    const parentThreadId = queue[index];
    if (parentThreadId === undefined) {
      break;
    }
    for (const child of childrenByParentId.get(parentThreadId) ?? []) {
      if (visitedThreadIds.has(child.id)) {
        continue;
      }
      visitedThreadIds.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}
