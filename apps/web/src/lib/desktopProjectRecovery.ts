// FILE: desktopProjectRecovery.ts
// Purpose: Detects desktop startup snapshots that can hide projects while thread rows still exist.
// Exports: project membership selector and snapshot guard used by the desktop bootstrap repair path.

import type { OrchestrationReadModel, OrchestrationShellSnapshot } from "@synara/contracts";
import type { AppState } from "../storeState";

type ProjectRecoverySnapshot = OrchestrationReadModel | OrchestrationShellSnapshot;

export function selectNeedsDesktopProjectRecovery(state: AppState): boolean {
  if (state.projects.length === 0) return true;

  const projectIds = new Set(state.projects.map((project) => project.id));
  return (
    state.threadIds?.some((threadId) => {
      const shell = state.threadShellById?.[threadId];
      return shell !== undefined && !projectIds.has(shell.projectId);
    }) ?? false
  );
}

export function hasLiveThreadsWithMissingProjects(snapshot: ProjectRecoverySnapshot): boolean {
  const liveProjectIds = new Set(
    snapshot.projects
      .filter((project) => !("deletedAt" in project) || project.deletedAt === null)
      .map((project) => project.id),
  );

  return snapshot.threads.some((thread) => {
    const isLiveThread = !("deletedAt" in thread) || thread.deletedAt === null;
    return isLiveThread && !liveProjectIds.has(thread.projectId);
  });
}

/**
 * A genuinely empty profile is a valid first-run state, not evidence that its
 * projections are damaged. Rebuilding projections in that case is expensive
 * and, when the desktop bootstrap reruns, can keep the orchestration database
 * busy long enough for unrelated provider commands to time out.
 */
export function shouldRepairDesktopProjectSnapshot(snapshot: ProjectRecoverySnapshot): boolean {
  const requiresEmptyProjectShellRepair =
    "requiresEmptyProjectShellRepair" in snapshot &&
    snapshot.requiresEmptyProjectShellRepair === true;

  return (
    hasLiveThreadsWithMissingProjects(snapshot) ||
    (snapshot.projects.length === 0 &&
      snapshot.threads.length === 0 &&
      requiresEmptyProjectShellRepair)
  );
}
