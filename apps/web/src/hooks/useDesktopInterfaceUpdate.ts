import type { DesktopUpdateActionResult, DesktopUpdateState } from "@synara/contracts";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { APP_VERSION } from "../branding";
import { pendingComposerAttachmentSyncGenerationCount } from "../composerDraftAttachments";
import { persistComposerDraftsNow, useComposerDraftStore } from "../composerDraftStore";
import { toastManager } from "../components/ui/toast";
import {
  getDesktopInterfaceUpdateMessage,
  isDesktopInterfaceUpdateBusy,
} from "../components/desktopUpdate.logic";
import {
  INTERFACE_UPDATE_ATTEMPT_KEY,
  hasVolatileComposerDrafts,
  interfaceUpdateBootConfirmation,
  prepareAndApplyInterfaceUpdate,
  readInterfaceUpdateAttempt,
  releaseInterfaceUpdateHandoff,
} from "../lib/desktopInterfaceUpdate";
import {
  acquireRendererReload,
  isRendererReloadPending,
  pendingRendererOperationCount,
} from "../lib/rendererReloadSafety";
import { flushWorkspaceEditors, hasUnsavedWorkspaceEditors } from "../lib/workspaceEditorSession";
import { persistAppStateNow, useStore } from "../store";
import { readPendingWsMutationCount, readWsServerInstanceId } from "../wsNativeApi";
import { addWsTransportStateListener } from "../wsTransportEvents";

export function useDesktopUpdateState() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.getUpdateState || !bridge.onUpdateState) return;
    let disposed = false;
    let receivedUpdate = false;
    const unsubscribe = bridge.onUpdateState((next) => {
      if (disposed) return;
      receivedUpdate = true;
      releaseInterfaceUpdateHandoff(next.interfaceUpdate);
      setState(next);
    });
    void bridge
      .getUpdateState()
      .then((next) => {
        if (!disposed && !receivedUpdate) setState(next);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  return [state, setState] as const;
}

let pendingUpdate: Promise<DesktopUpdateActionResult> | null = null;

function requestInterfaceUpdate(queryClient: QueryClient): Promise<DesktopUpdateActionResult> {
  if (pendingUpdate) return pendingUpdate;
  const bridge = window.desktopBridge?.interfaceUpdate;
  if (!bridge)
    return Promise.reject(new Error("This native app does not support interface updates."));
  const operation = prepareAndApplyInterfaceUpdate({
    bridge,
    readSafety: () => ({
      serverInstanceId: readWsServerInstanceId(),
      pendingMutations: readPendingWsMutationCount() + queryClient.isMutating(),
      pendingOperations:
        pendingRendererOperationCount() + pendingComposerAttachmentSyncGenerationCount(),
      hasVolatileDrafts: hasVolatileComposerDrafts(
        Object.values(useComposerDraftStore.getState().draftsByThreadId),
      ),
    }),
    flushEditors: () => flushWorkspaceEditors(queryClient),
    hasUnsavedEditors: () => hasUnsavedWorkspaceEditors(queryClient),
    persist: () => {
      persistComposerDraftsNow();
      persistAppStateNow();
    },
    rememberAttempt: (attempt) =>
      sessionStorage.setItem(INTERFACE_UPDATE_ATTEMPT_KEY, JSON.stringify(attempt)),
    freezeInteraction: () => {
      const root = document.getElementById("root");
      const wasInert = root?.inert ?? false;
      if (root) root.inert = true;
      return () => {
        if (root) root.inert = wasInert;
      };
    },
    acquireReload: acquireRendererReload,
  });
  pendingUpdate = operation;
  void operation
    .finally(() => {
      if (pendingUpdate === operation) pendingUpdate = null;
    })
    .catch(() => undefined);
  return operation;
}

export function useDesktopInterfaceUpdateAction(
  state: DesktopUpdateState | null,
  setState: (state: DesktopUpdateState) => void,
) {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    if (isRendererReloadPending() || isDesktopInterfaceUpdateBusy(state)) return;
    try {
      const result = await requestInterfaceUpdate(queryClient);
      setState(result.state);
      const status = result.state.interfaceUpdate?.status;
      if (status === "reloading") return;
      toastManager.add({
        type: status === "error" ? "error" : "info",
        title:
          status === "restart-required" ? "Native update requires a restart" : "Interface update",
        description: getDesktopInterfaceUpdateMessage(result.state, APP_VERSION),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Interface reload was not confirmed",
        description:
          cause instanceof Error ? cause.message : "Check the update status before trying again.",
      });
    }
  }, [queryClient, setState, state]);
}

/** Global menu and boot acknowledgement also run on Home without any thread details. */
export function useDesktopInterfaceUpdateCoordinator(): void {
  const [state, setState] = useDesktopUpdateState();
  const requestUpdate = useDesktopInterfaceUpdateAction(state, setState);
  const shellHydrated = useStore((store) => store.threadsHydrated);
  const [serverInstanceId, setServerInstanceId] = useState(readWsServerInstanceId);
  const attemptedConfirmation = useRef<string | null>(null);
  useEffect(
    () =>
      addWsTransportStateListener(
        () => {
          setServerInstanceId(readWsServerInstanceId());
        },
        { replayCurrent: true },
      ),
    [],
  );
  useEffect(
    () =>
      window.desktopBridge?.onMenuAction((action) => {
        if (action === "update-interface") void requestUpdate();
      }),
    [requestUpdate],
  );
  useEffect(() => {
    const bridge = window.desktopBridge?.interfaceUpdate;
    if (!bridge || !state) return;
    const confirmation = interfaceUpdateBootConfirmation({
      state: state.interfaceUpdate,
      attempt: readInterfaceUpdateAttempt(),
      uiVersion: APP_VERSION,
      serverInstanceId,
      shellHydrated,
    });
    if (!confirmation) return;
    const key = JSON.stringify(confirmation);
    if (attemptedConfirmation.current === key) return;
    attemptedConfirmation.current = key;
    void bridge
      .confirm(confirmation)
      .then((confirmed) => {
        if (!confirmed) return;
        sessionStorage.removeItem(INTERFACE_UPDATE_ATTEMPT_KEY);
        toastManager.add({
          type: "success",
          title: "Interface updated",
          description: `Interface ${APP_VERSION} is active. Native app ${state.currentVersion} is still running.`,
        });
      })
      .catch(() => undefined);
  }, [serverInstanceId, shellHydrated, state]);
}
