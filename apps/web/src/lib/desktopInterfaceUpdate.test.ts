import type {
  DesktopInterfaceUpdateState,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyThreadDraft } from "../composerDraftDomain";
import {
  INTERFACE_UPDATE_HANDOFF_TIMEOUT_MS,
  hasVolatileComposerDrafts,
  interfaceUpdateBootConfirmation,
  prepareAndApplyInterfaceUpdate,
  readInterfaceUpdateAttempt,
  releaseInterfaceUpdateHandoff,
  type InterfaceUpdateDependencies,
  type InterfaceUpdateSafety,
} from "./desktopInterfaceUpdate";

const ready: DesktopInterfaceUpdateState = {
  status: "ready",
  currentVersion: "0.9.26",
  targetVersion: "0.9.27",
  attemptId: "attempt-1",
  message: null,
};
const nativeState: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  currentVersion: "0.9.26",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.9.27",
  downloadedVersion: "0.9.27",
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  installFailureCount: 0,
  flavor: "production",
  releaseUrl: null,
  interfaceUpdate: ready,
};
const safe: InterfaceUpdateSafety = {
  serverInstanceId: "server-1",
  pendingMutations: 0,
  pendingOperations: 0,
  hasVolatileDrafts: false,
};
const attempt = { attemptId: "attempt-1", version: "0.9.27", serverInstanceId: "server-1" };

function result(
  status: DesktopInterfaceUpdateState["status"] = "ready",
): DesktopUpdateActionResult {
  return {
    accepted: true,
    completed: true,
    state: { ...nativeState, interfaceUpdate: { ...ready, status } },
  };
}

function setup() {
  const restore = vi.fn();
  const release = vi.fn();
  const deps = {
    bridge: {
      prepare: vi.fn(async () => result()),
      apply: vi.fn(async () => result("reloading")),
      confirm: vi.fn(async () => true),
    },
    readSafety: vi.fn(() => safe),
    flushEditors: vi.fn(async () => true),
    hasUnsavedEditors: vi.fn(() => false),
    persist: vi.fn(),
    rememberAttempt: vi.fn(),
    freezeInteraction: vi.fn(() => restore),
    acquireReload: vi.fn<InterfaceUpdateDependencies["acquireReload"]>(() => release),
  } satisfies InterfaceUpdateDependencies;
  return { deps, restore, release };
}

describe("interface update handoff", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    releaseInterfaceUpdateHandoff({ ...ready, status: "error" });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("saves the latest edits after preparation and only then applies to the original server", async () => {
    const { deps, restore, release } = setup();
    const order: string[] = [];
    let draft = "before download";
    deps.bridge.prepare.mockImplementation(async () => {
      draft = "edited during download";
      order.push("prepare");
      return result();
    });
    deps.flushEditors.mockImplementation(async () => {
      order.push("flush");
      return true;
    });
    deps.persist.mockImplementation(() => {
      expect(draft).toBe("edited during download");
      order.push("persist");
    });
    deps.bridge.apply.mockImplementation(async () => {
      order.push("apply");
      return result("reloading");
    });
    const applied = await prepareAndApplyInterfaceUpdate(deps);
    expect(order).toEqual(["prepare", "flush", "persist", "apply"]);
    expect(deps.rememberAttempt).toHaveBeenCalledWith(attempt);
    expect(deps.bridge.apply).toHaveBeenCalledExactlyOnceWith({
      attemptId: "attempt-1",
      serverInstanceId: "server-1",
    });
    expect(deps.bridge.confirm).not.toHaveBeenCalled();
    expect(applied.state.currentVersion).toBe("0.9.26");
    expect(restore).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERFACE_UPDATE_HANDOFF_TIMEOUT_MS);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["unsupported", "idle", "blocked", "restart-required", "error"] as const)(
    "does not flush or apply when preparation returns %s",
    async (status) => {
      const { deps } = setup();
      deps.bridge.prepare.mockResolvedValue(result(status));
      await prepareAndApplyInterfaceUpdate(deps);
      expect(deps.flushEditors).not.toHaveBeenCalled();
      expect(deps.bridge.apply).not.toHaveBeenCalled();
    },
  );

  it.each([
    { pendingMutations: 1 },
    { pendingOperations: 1 },
    { hasVolatileDrafts: true },
    { serverInstanceId: null },
  ])("refuses unsafe renderer work %j without interrupting it", async (partial) => {
    const { deps } = setup();
    deps.readSafety.mockReturnValue({ ...safe, ...partial });
    const blocked = await prepareAndApplyInterfaceUpdate(deps);
    expect(blocked.state.interfaceUpdate?.status).toBe("blocked");
    expect(deps.flushEditors).not.toHaveBeenCalled();
    expect(deps.bridge.apply).not.toHaveBeenCalled();
  });

  it("preserves drafts and restores input when the editor cannot flush", async () => {
    const { deps, restore } = setup();
    deps.flushEditors.mockResolvedValue(false);
    expect((await prepareAndApplyInterfaceUpdate(deps)).state.interfaceUpdate?.status).toBe(
      "blocked",
    );
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.bridge.apply).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it.each([
    { serverInstanceId: "server-restarted" },
    { pendingOperations: 1 },
    { pendingMutations: 1 },
  ])("rechecks work and server identity after async flush: %j", async (partial) => {
    const { deps, restore } = setup();
    deps.readSafety.mockReturnValueOnce(safe).mockReturnValue({ ...safe, ...partial });
    expect((await prepareAndApplyInterfaceUpdate(deps)).state.interfaceUpdate?.status).toBe(
      "blocked",
    );
    expect(deps.bridge.apply).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
  });

  it("does not reload if persistence throws or a new mutation appears during persistence", async () => {
    const first = setup();
    first.deps.persist.mockImplementation(() => {
      throw new Error("Storage full");
    });
    await expect(prepareAndApplyInterfaceUpdate(first.deps)).rejects.toThrow("Storage full");
    expect(first.deps.bridge.apply).not.toHaveBeenCalled();
    expect(first.restore).toHaveBeenCalledOnce();
    const second = setup();
    second.deps.persist.mockImplementation(() =>
      second.deps.readSafety.mockReturnValue({ ...safe, pendingMutations: 1 }),
    );
    expect((await prepareAndApplyInterfaceUpdate(second.deps)).state.interfaceUpdate?.status).toBe(
      "blocked",
    );
    expect(second.deps.bridge.apply).not.toHaveBeenCalled();
  });

  it("releases the latch on a native refusal and does not retry apply", async () => {
    const { deps, restore, release } = setup();
    deps.bridge.apply.mockResolvedValue({ ...result("blocked"), accepted: false });
    await prepareAndApplyInterfaceUpdate(deps);
    expect(deps.bridge.apply).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("restores an old page after a lost IPC reply without replaying the mutation", async () => {
    const { deps, restore, release } = setup();
    deps.bridge.apply.mockImplementation(() => new Promise(() => undefined));
    const handoff = prepareAndApplyInterfaceUpdate(deps);
    const assertion = expect(handoff).rejects.toThrow("not confirmed");
    await vi.advanceTimersByTimeAsync(INTERFACE_UPDATE_HANDOFF_TIMEOUT_MS + 1);
    await assertion;
    expect(deps.bridge.apply).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases on a matching native rollback, but ignores another attempt's state", async () => {
    const { deps, restore } = setup();
    await prepareAndApplyInterfaceUpdate(deps);
    releaseInterfaceUpdateHandoff({ ...ready, attemptId: "other", status: "error" });
    expect(restore).not.toHaveBeenCalled();
    releaseInterfaceUpdateHandoff({ ...ready, status: "error" });
    expect(restore).toHaveBeenCalledOnce();
  });
});

describe("interface boot acknowledgement", () => {
  const boot = {
    state: { ...ready, status: "reloading" as const },
    attempt,
    uiVersion: "0.9.27",
    serverInstanceId: "server-1",
    shellHydrated: true,
  };
  it("confirms Home from the hydrated shell without waiting for any thread details", () => {
    expect(interfaceUpdateBootConfirmation(boot)).toEqual(attempt);
  });
  it.each([
    { uiVersion: "0.9.26" },
    { shellHydrated: false },
    { serverInstanceId: null },
    { serverInstanceId: "server-restarted" },
    { attempt: null },
    { attempt: { ...attempt, attemptId: "old-attempt" } },
    { state: { ...ready, status: "applied" as const } },
  ])("refuses incomplete or mismatched boot %j", (partial) => {
    expect(interfaceUpdateBootConfirmation({ ...boot, ...partial })).toBeNull();
  });
  it("rejects corrupt or unavailable attempt storage", () => {
    expect(readInterfaceUpdateAttempt({ getItem: () => JSON.stringify(attempt) })).toEqual(attempt);
    expect(readInterfaceUpdateAttempt({ getItem: () => "broken" })).toBeNull();
    expect(readInterfaceUpdateAttempt({ getItem: () => '{"attemptId":"old"}' })).toBeNull();
    expect(
      readInterfaceUpdateAttempt({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBeNull();
  });
  it("retains volatile file and image drafts instead of losing them on reload", () => {
    const draft = createEmptyThreadDraft();
    draft.prompt = "keep this prompt";
    expect(hasVolatileComposerDrafts([draft])).toBe(false);
    draft.nonPersistedImageIds = ["image-1"];
    expect(hasVolatileComposerDrafts([draft])).toBe(true);
    expect(draft.prompt).toBe("keep this prompt");
  });
});
