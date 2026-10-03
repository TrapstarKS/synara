import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { isWsRequestSafeToAbandonForReload } from "./wsReadOnlyMethods";

describe("requests across interface reload", () => {
  it.each([
    ORCHESTRATION_WS_METHODS.getShellSnapshot,
    ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot,
    ORCHESTRATION_WS_METHODS.subscribeThread,
    WS_METHODS.providerListModels,
    WS_METHODS.gitStatus,
    WS_METHODS.serverGetConfig,
  ])("does not wait for a background read or subscription: %s", (method) => {
    expect(isWsRequestSafeToAbandonForReload(method)).toBe(true);
  });

  it.each([
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    WS_METHODS.projectsWriteFile,
    WS_METHODS.terminalWrite,
    WS_METHODS.gitCreateWorktree,
    WS_METHODS.serverUpdateSettings,
    "future.getAndDelete",
  ])("keeps a mutation or unknown method blocking: %s", (method) => {
    expect(isWsRequestSafeToAbandonForReload(method)).toBe(false);
  });
});
