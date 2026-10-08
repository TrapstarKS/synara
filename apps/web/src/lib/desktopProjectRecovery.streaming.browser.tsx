import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { applyOrchestrationEventsHotPath } from "../storeEventReducer";
import { syncServerReadModel } from "../storeProjection";
import { createAllThreadsSelector, createSidebarThreadSummariesSelector } from "../storeSelectors";
import { initialState } from "../storeState";
import { makeDomainEvent, makeReadModel, makeReadModelThread } from "../storeTestFixtures";
import { selectNeedsDesktopProjectRecovery } from "./desktopProjectRecovery";

describe("recovery rendering during concurrent streaming", () => {
  it("keeps recovery and sidebar subscribers idle during 100 flushes of 20 streams", async () => {
    const threads = Array.from({ length: 20 }, (_, index) =>
      makeReadModelThread({ id: ThreadId.makeUnsafe(`stream-${index}`) }),
    );
    const state = syncServerReadModel(initialState, {
      ...makeReadModel(threads[0]!),
      projects: [],
      threads,
    });
    const store = createStore(() => state);
    const selectAllThreads = createAllThreadsSelector();
    const selectSidebar = createSidebarThreadSummariesSelector();
    const renders = { detailed: 0, recovery: 0, sidebar: 0 };
    const detailed = await renderHook(() => {
      renders.detailed += 1;
      return useStore(store, selectAllThreads);
    });
    const recovery = await renderHook(() => {
      renders.recovery += 1;
      return useStore(store, selectNeedsDesktopProjectRecovery);
    });
    const sidebar = await renderHook(() => {
      renders.sidebar += 1;
      return useStore(store, selectSidebar);
    });
    try {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const initialRenders = { ...renders };
      let sequence = 1;
      for (let flush = 0; flush < 100; flush += 1) {
        await act(async () => {
          store.setState(
            applyOrchestrationEventsHotPath(
              store.getState(),
              threads.map((thread) =>
                makeDomainEvent(
                  "thread.message-sent",
                  {
                    threadId: thread.id,
                    messageId: MessageId.makeUnsafe(`message-${thread.id}`),
                    turnId: TurnId.makeUnsafe(`turn-${thread.id}`),
                    role: "assistant",
                    streaming: true,
                    text: "delta ",
                    createdAt: "2026-10-08T00:00:00.000Z",
                    updatedAt: new Date(Date.UTC(2026, 9, 8, 0, 0, flush)).toISOString(),
                    attachments: [],
                    source: "native",
                  },
                  { sequence: ++sequence },
                ),
              ),
            ),
          );
        });
      }
      expect(renders.detailed - initialRenders.detailed).toBe(100);
      expect(renders.recovery - initialRenders.recovery).toBe(0);
      expect(renders.sidebar - initialRenders.sidebar).toBe(0);
      expect(recovery.result.current).toBe(true);
      expect(detailed.result.current[0]?.messages[0]?.text).toBe("delta ".repeat(100));
    } finally {
      await detailed.unmount();
      await recovery.unmount();
      await sidebar.unmount();
      vi.unstubAllGlobals();
    }
  });
});
