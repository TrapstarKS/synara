import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LiveUiUpdateController,
  type LiveUiUpdateDependencies,
  type PreparedInterfaceUpdate,
} from "./liveUiUpdateController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const update = (version = "1.0.1"): PreparedInterfaceUpdate => ({
  dir: `/verified/${version}`,
  version,
  dispose: vi.fn(async () => undefined),
});

function harness(overrides: Partial<LiveUiUpdateDependencies> = {}) {
  let runtime = {};
  let blocked: string | null = null;
  const prepared = update();
  const deps = {
    currentVersion: "1.0.0",
    unsupportedReason: () => null,
    runtimeIdentity: () => runtime,
    prepare: vi.fn(async () => prepared),
    classifyError: () => "error" as const,
    reloadBlockedReason: () => blocked,
    selectRoots: vi.fn(),
    reload: vi.fn(),
    onState: vi.fn(),
    confirmationTimeoutMs: 1_000,
    ...overrides,
  } satisfies LiveUiUpdateDependencies;
  const controller = new LiveUiUpdateController(deps);
  const apply = () =>
    controller.apply({
      attemptId: controller.getState().attemptId!,
      serverInstanceId: "same-server",
    });
  const confirm = () =>
    controller.confirm({
      attemptId: controller.getState().attemptId!,
      version: controller.getState().targetVersion!,
      serverInstanceId: "same-server",
    });
  return {
    controller,
    deps,
    prepared,
    apply,
    confirm,
    replaceRuntime: () => {
      runtime = {};
    },
    block: (reason: string | null) => {
      blocked = reason;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("LiveUiUpdateController", () => {
  it("enables the entry point after updater startup without preparing an update", () => {
    let reason: string | null = "Updater not configured yet";
    const h = harness({ unsupportedReason: () => reason });
    expect(h.controller.getState().status).toBe("unsupported");
    reason = null;
    h.controller.refreshAvailability();
    expect(h.controller.getState()).toMatchObject({ status: "idle", message: null });
    expect(h.deps.prepare).not.toHaveBeenCalled();
    expect(h.deps.reload).not.toHaveBeenCalled();
  });

  it("prepares without reloading and commits only a matching hydrated interface", async () => {
    const h = harness();
    await h.controller.prepare();
    expect(h.controller.getState()).toMatchObject({
      status: "ready",
      currentVersion: "1.0.0",
      targetVersion: "1.0.1",
    });
    expect(h.deps.reload).not.toHaveBeenCalled();
    expect(h.deps.selectRoots).not.toHaveBeenCalled();
    expect(h.apply()).toBe(true);
    expect(h.controller.getState().currentVersion).toBe("1.0.0");
    expect(h.deps.selectRoots).toHaveBeenCalledWith(h.prepared.dir, null);
    const identity = {
      attemptId: h.controller.getState().attemptId!,
      version: "1.0.1",
      serverInstanceId: "same-server",
    };
    expect(h.controller.confirm({ ...identity, version: "1.0.0" })).toBe(false);
    expect(h.controller.confirm({ ...identity, serverInstanceId: "different-server" })).toBe(false);
    expect(h.controller.confirm({ ...identity, attemptId: "old-attempt" })).toBe(false);
    expect(h.controller.confirm(identity)).toBe(true);
    expect(h.controller.getState()).toMatchObject({
      status: "applied",
      currentVersion: "1.0.1",
      attemptId: null,
    });
    expect(h.controller.confirm(identity)).toBe(false);
    expect(h.deps.reload).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });

  it("coalesces preparation and blocks installation while the trial owns loading", async () => {
    const pending = deferred<PreparedInterfaceUpdate>();
    const prepare = vi.fn(() => pending.promise);
    const h = harness({ prepare });
    const first = h.controller.prepare();
    const second = h.controller.prepare();
    expect(prepare).toHaveBeenCalledOnce();
    expect(h.controller.isBusy()).toBe(true);
    pending.resolve(h.prepared);
    await Promise.all([first, second]);
    expect(h.controller.isBusy()).toBe(false);
    h.apply();
    expect(h.controller.isBusy()).toBe(true);
    expect(h.apply()).toBe(false);
    h.confirm();
    expect(h.controller.isBusy()).toBe(false);
    h.controller.dispose();
  });

  it("keeps embedded browser pages and permits a later explicit retry", async () => {
    const h = harness();
    await h.controller.prepare();
    h.block("A renderer-owned page is open.");
    expect(h.apply()).toBe(false);
    expect(h.controller.getState().status).toBe("blocked");
    expect(h.deps.reload).not.toHaveBeenCalled();
    expect(h.deps.selectRoots).not.toHaveBeenCalled();
    h.block(null);
    await h.controller.prepare();
    expect(h.apply()).toBe(true);
    h.confirm();
    h.controller.dispose();
  });

  it("discards a preparation from a replaced server and does not reload", async () => {
    const pending = deferred<PreparedInterfaceUpdate>();
    const h = harness({ prepare: () => pending.promise });
    const preparation = h.controller.prepare();
    h.replaceRuntime();
    pending.resolve(h.prepared);
    await preparation;
    expect(h.controller.getState().status).toBe("blocked");
    expect(h.prepared.dispose).toHaveBeenCalledOnce();
    expect(h.deps.reload).not.toHaveBeenCalled();
  });

  it("re-prepares a stale candidate instead of silently reusing its old runtime", async () => {
    const next = update("1.0.2");
    const prepare = vi.fn().mockResolvedValueOnce(update()).mockResolvedValueOnce(next);
    const h = harness({ prepare });
    await h.controller.prepare();
    h.replaceRuntime();
    expect(h.apply()).toBe(false);
    await h.controller.prepare();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.apply()).toBe(true);
    h.confirm();
    expect(h.controller.getState().currentVersion).toBe("1.0.2");
    h.controller.dispose();
  });

  it("rolls back once after timeout and rejects a late acknowledgement", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.controller.prepare();
    const attemptId = h.controller.getState().attemptId!;
    h.apply();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.controller.getState()).toMatchObject({ status: "error", currentVersion: "1.0.0" });
    expect(h.deps.selectRoots).toHaveBeenLastCalledWith(null, h.prepared.dir);
    expect(h.deps.reload).toHaveBeenCalledTimes(2);
    expect(
      h.controller.confirm({ attemptId, version: "1.0.1", serverInstanceId: "same-server" }),
    ).toBe(false);
    expect(h.controller.failLoading("Rollback page failed")).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.deps.reload).toHaveBeenCalledTimes(2);
    await h.controller.prepare();
    expect(h.controller.getState().status).toBe("restart-required");
  });

  it("defers even rollback while a new renderer-owned browser page needs the document", async () => {
    const h = harness();
    await h.controller.prepare();
    h.apply();
    h.block("Page is still open.");
    expect(h.controller.failLoading("Load failed")).toBe(true);
    expect(h.controller.getState().status).toBe("blocked");
    expect(h.deps.reload).toHaveBeenCalledTimes(1);
    expect(h.controller.isBusy()).toBe(false);
    expect(h.prepared.dispose).not.toHaveBeenCalled();
    expect(h.confirm()).toBe(false);
    h.block(null);
    await h.controller.prepare();
    expect(h.deps.reload).toHaveBeenCalledTimes(2);
    expect(h.controller.getState().status).toBe("error");
  });

  it("retains the previous confirmed root across successive compatible updates", async () => {
    const a = update("1.0.1");
    const b = update("1.0.2");
    const c = update("1.0.3");
    const prepare = vi
      .fn()
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b)
      .mockResolvedValueOnce(c);
    const h = harness({ prepare });
    await h.controller.prepare();
    h.apply();
    h.confirm();
    await h.controller.prepare();
    h.apply();
    h.confirm();
    expect(a.dispose).not.toHaveBeenCalled();
    await h.controller.prepare();
    h.apply();
    expect(h.deps.selectRoots).toHaveBeenLastCalledWith(c.dir, b.dir);
    h.confirm();
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(b.dispose).not.toHaveBeenCalled();
    expect(c.dispose).not.toHaveBeenCalled();
    h.controller.dispose();
  });

  it("cleans up a preparation that finishes after disposal without a reload", async () => {
    const pending = deferred<PreparedInterfaceUpdate>();
    const prepare = vi.fn(() => pending.promise);
    const h = harness({ prepare });
    const preparation = h.controller.prepare();
    h.controller.dispose();
    pending.resolve(h.prepared);
    await preparation;
    expect(h.prepared.dispose).toHaveBeenCalledOnce();
    expect(h.deps.reload).not.toHaveBeenCalled();
    expect(h.deps.selectRoots).not.toHaveBeenCalled();
  });

  it("retains failed document assets when the rollback navigation itself throws", async () => {
    const next = update("1.0.2");
    const prepare = vi.fn().mockResolvedValueOnce(update()).mockResolvedValueOnce(next);
    const reload = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("Navigation refused");
      });
    const h = harness({ prepare, reload });
    await h.controller.prepare();
    const failed = await prepare.mock.results[0]!.value;
    h.apply();
    h.controller.failLoading("Candidate failed");
    expect(failed.dispose).not.toHaveBeenCalled();
    expect(h.controller.getState().message).toContain("View → Reload");
    await h.controller.prepare();
    h.apply();
    h.confirm();
    expect(failed.dispose).toHaveBeenCalledOnce();
    h.controller.dispose();
  });

  it("keeps restart-required and unsupported updates out of activation", async () => {
    const h = harness({
      prepare: async () => {
        throw new Error("Runtime differs");
      },
      classifyError: () => "restart-required",
    });
    await h.controller.prepare();
    expect(h.controller.getState().status).toBe("restart-required");
    expect(h.apply()).toBe(false);
    expect(h.deps.reload).not.toHaveBeenCalled();
    const unsupported = harness({ unsupportedReason: () => "macOS only" });
    await unsupported.controller.prepare();
    expect(unsupported.controller.getState().status).toBe("unsupported");
    expect(unsupported.deps.prepare).not.toHaveBeenCalled();
  });
});
