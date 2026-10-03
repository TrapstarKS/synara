import type {
  DesktopBridge,
  DesktopInterfaceUpdateConfirmInput,
  DesktopInterfaceUpdateState,
  DesktopUpdateActionResult,
} from "@synara/contracts";
import type { ComposerThreadDraftState } from "../composerDraftDomain";

export const INTERFACE_UPDATE_ATTEMPT_KEY = "synara:interface-update-attempt:v1";
// The native controller rolls back after 45 seconds. Release an old renderer too
// if IPC/navigation never completes; never retry a mutation or force a reload.
export const INTERFACE_UPDATE_HANDOFF_TIMEOUT_MS = 50_000;

let activeHandoff: { attemptId: string; release: () => void } | null = null;

export function releaseInterfaceUpdateHandoff(
  state: DesktopInterfaceUpdateState | undefined,
): void {
  if (
    !activeHandoff ||
    !state ||
    (state.attemptId !== null && state.attemptId !== activeHandoff.attemptId) ||
    !["blocked", "error", "restart-required", "unsupported", "applied"].includes(state.status)
  )
    return;
  activeHandoff.release();
}

export interface InterfaceUpdateSafety {
  serverInstanceId: string | null;
  pendingMutations: number;
  pendingOperations: number;
  hasVolatileDrafts: boolean;
}

export function hasVolatileComposerDrafts(drafts: Iterable<ComposerThreadDraftState>): boolean {
  for (const draft of drafts) {
    for (const slot of [draft, draft.promptHistorySavedDraft]) {
      if (!slot) continue;
      if (slot.files.length > 0 || slot.nonPersistedImageIds.length > 0) return true;
      const saved = new Set(
        slot.persistedAttachments
          .filter((attachment) => attachment.blobKey || attachment.dataUrl)
          .map((attachment) => attachment.id),
      );
      if (slot.images.some((image) => !saved.has(image.id))) return true;
    }
    // Queued file/image objects can still be owned only by this renderer.
    if (
      draft.queuedTurns.some(
        (turn) => turn.kind === "chat" && (turn.files.length > 0 || turn.images.length > 0),
      )
    )
      return true;
  }
  return false;
}

export function interfaceUpdateBlockReason(
  safety: InterfaceUpdateSafety,
  expectedServerInstanceId?: string,
): string | null {
  if (!safety.serverInstanceId) return "Reconnect to the server before updating the interface.";
  if (expectedServerInstanceId && safety.serverInstanceId !== expectedServerInstanceId) {
    return "The server changed while preparing the reload. Try the interface update again.";
  }
  if (safety.pendingMutations > 0 || safety.pendingOperations > 0) {
    return "A send, upload, or other change is still in progress. Finish it before reloading.";
  }
  if (safety.hasVolatileDrafts) {
    return "Some draft attachments are not saved for reload. Finish saving, send, or remove them first.";
  }
  return null;
}

export function interfaceUpdateBootConfirmation(input: {
  state: DesktopInterfaceUpdateState | undefined;
  attempt: DesktopInterfaceUpdateConfirmInput | null;
  uiVersion: string;
  serverInstanceId: string | null;
  shellHydrated: boolean;
}): DesktopInterfaceUpdateConfirmInput | null {
  const { state, attempt, serverInstanceId } = input;
  if (
    state?.status !== "reloading" ||
    !attempt ||
    !input.shellHydrated ||
    !serverInstanceId ||
    state.attemptId !== attempt.attemptId ||
    state.targetVersion !== input.uiVersion ||
    attempt.version !== input.uiVersion ||
    attempt.serverInstanceId !== serverInstanceId
  )
    return null;
  return { attemptId: attempt.attemptId, version: input.uiVersion, serverInstanceId };
}

export function readInterfaceUpdateAttempt(
  storage?: Pick<Storage, "getItem">,
): DesktopInterfaceUpdateConfirmInput | null {
  try {
    const value: unknown = JSON.parse(
      (storage ?? globalThis.sessionStorage).getItem(INTERFACE_UPDATE_ATTEMPT_KEY) ?? "null",
    );
    if (!value || typeof value !== "object") return null;
    const attempt = value as Record<string, unknown>;
    if (
      typeof attempt.attemptId !== "string" ||
      !attempt.attemptId ||
      typeof attempt.version !== "string" ||
      !attempt.version ||
      typeof attempt.serverInstanceId !== "string" ||
      !attempt.serverInstanceId
    )
      return null;
    return {
      attemptId: attempt.attemptId,
      version: attempt.version,
      serverInstanceId: attempt.serverInstanceId,
    };
  } catch {
    return null;
  }
}

export interface InterfaceUpdateDependencies {
  bridge: NonNullable<DesktopBridge["interfaceUpdate"]>;
  readSafety: () => InterfaceUpdateSafety;
  flushEditors: () => Promise<boolean>;
  hasUnsavedEditors: () => boolean;
  persist: () => void;
  rememberAttempt: (attempt: DesktopInterfaceUpdateConfirmInput) => void;
  freezeInteraction: () => () => void;
  acquireReload: () => (() => void) | null;
}

/** Two phases keep edits made during download in the final saved snapshot. */
export async function prepareAndApplyInterfaceUpdate(
  dependencies: InterfaceUpdateDependencies,
): Promise<DesktopUpdateActionResult> {
  const prepared = await dependencies.bridge.prepare();
  const candidate = prepared.state.interfaceUpdate;
  if (
    !prepared.accepted ||
    candidate?.status !== "ready" ||
    !candidate.attemptId ||
    !candidate.targetVersion
  ) {
    return prepared;
  }
  const blocked = (message: string): DesktopUpdateActionResult => ({
    accepted: false,
    completed: false,
    state: { ...prepared.state, interfaceUpdate: { ...candidate, status: "blocked", message } },
  });
  const initial = dependencies.readSafety();
  const initialBlock = interfaceUpdateBlockReason(initial);
  if (initialBlock) return blocked(initialBlock);
  const serverInstanceId = initial.serverInstanceId!;
  const restoreInteraction = dependencies.freezeInteraction();
  let releaseReload: (() => void) | null = null;
  let handedOff = false;
  let released = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timeout);
    releaseReload?.();
    releaseReload = null;
    if (activeHandoff?.release === release) activeHandoff = null;
    restoreInteraction();
  };
  try {
    if (!(await dependencies.flushEditors()) || dependencies.hasUnsavedEditors()) {
      return blocked("Could not save editor changes. Resolve the save error before reloading.");
    }
    const afterFlush = interfaceUpdateBlockReason(dependencies.readSafety(), serverInstanceId);
    if (afterFlush) return blocked(afterFlush);
    dependencies.persist();
    const beforeApply = interfaceUpdateBlockReason(dependencies.readSafety(), serverInstanceId);
    if (beforeApply) return blocked(beforeApply);
    releaseReload = dependencies.acquireReload();
    if (!releaseReload)
      return blocked("A change started before the reload. Try again when it finishes.");
    dependencies.rememberAttempt({
      attemptId: candidate.attemptId,
      version: candidate.targetVersion,
      serverInstanceId,
    });
    activeHandoff = { attemptId: candidate.attemptId, release };
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        release();
        reject(
          new Error(
            "The interface reload was not confirmed. Check the update status before trying again.",
          ),
        );
      }, INTERFACE_UPDATE_HANDOFF_TIMEOUT_MS);
    });
    const result = await Promise.race([
      dependencies.bridge.apply({ attemptId: candidate.attemptId, serverInstanceId }),
      timedOut,
    ]);
    // apply's IPC reply is not boot success. Keep the page quiet until navigation;
    // the next renderer confirms its version, server identity and hydrated shell.
    handedOff = result.accepted && result.state.interfaceUpdate?.status === "reloading";
    return result;
  } finally {
    if (!handedOff) release();
  }
}
