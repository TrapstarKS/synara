import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireRendererReload,
  beginRendererOperation,
  isRendererReloadPending,
  onRendererReloadChange,
  pendingRendererOperationCount,
  runRendererOperation,
} from "./rendererReloadSafety";

afterEach(() => vi.useRealTimers());

describe("renderer reload guard", () => {
  it("notifies queue owners once per handoff and release, then removes their listeners", () => {
    const listener = vi.fn();
    const unsubscribe = onRendererReloadChange(listener);
    const release = acquireRendererReload();
    expect(release).not.toBeNull();
    release?.();
    release?.();
    expect(listener.mock.calls).toEqual([[true], [false]]);
    unsubscribe();
    acquireRendererReload()?.();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("holds a long send through all async preflight work without an age-based expiry", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const running = runRendererOperation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    expect(pendingRendererOperationCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(pendingRendererOperationCount()).toBe(1);
    expect(acquireRendererReload()).toBeNull();
    complete();
    await running;
    expect(pendingRendererOperationCount()).toBe(0);
  });

  it("refuses a new upload before its body runs while handoff is held", async () => {
    const release = acquireRendererReload();
    expect(release).not.toBeNull();
    const upload = vi.fn(async () => "uploaded");
    try {
      expect(isRendererReloadPending()).toBe(true);
      await expect(runRendererOperation(upload)).rejects.toThrow("interface is reloading");
      expect(upload).not.toHaveBeenCalled();
      expect(pendingRendererOperationCount()).toBe(0);
    } finally {
      release?.();
    }
    expect(isRendererReloadPending()).toBe(false);
    expect(await runRendererOperation(upload)).toBe("uploaded");
  });

  it("settles failures and idempotent releases without leaking a busy marker", async () => {
    await expect(
      runRendererOperation(async () => {
        throw new Error("upload failed");
      }),
    ).rejects.toThrow("upload failed");
    const release = beginRendererOperation();
    release();
    release();
    expect(pendingRendererOperationCount()).toBe(0);
  });
});
