import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn() }));
vi.mock("@synara/shared/processRuntime", () => ({ spawnProcess: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));

import { startMobileCompanion } from "./mobileCompanion";

function makeChild() {
  return Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
}

describe("mobile companion recovery", () => {
  const children: ReturnType<typeof makeChild>[] = [];
  let stop: (() => void) | undefined;
  const log = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.exists.mockReturnValue(true);
    mocks.spawn.mockImplementation(() => {
      const child = makeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    for (const child of children.splice(0)) {
      child.emit("close", 0, null);
      child.stdin.destroy();
      child.stderr.destroy();
    }
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("retries an early startup refusal and caps repeated failures without overlapping children", () => {
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
      const count = children.length;
      children.at(-1)!.emit("close", 1, null);
      vi.advanceTimersByTime(delay - 1);
      expect(children).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(children).toHaveLength(count + 1);
    }
    vi.advanceTimersByTime(120_000);
    expect(children).toHaveLength(7);
  });

  it("recovers when spawn emits error and close without exit", () => {
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    children[0]!.emit("error", new Error("temporary spawn failure"));
    expect(vi.getTimerCount()).toBe(0);
    children[0]!.emit("close", -1, null);
    vi.advanceTimersByTime(5000);
    expect(children).toHaveLength(2);
    expect(log).toHaveBeenCalledWith("mobile companion failed: temporary spawn failure");
  });

  it("recovers from a synchronous launch failure", () => {
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("temporary launch failure");
    });
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    vi.advanceTimersByTime(5000);
    expect(children).toHaveLength(1);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("resets backoff after the companion has been healthy for a minute", () => {
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    children[0]!.emit("close", 1, null);
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(60_000);
    children[1]!.emit("close", 1, null);
    vi.advanceTimersByTime(5000);
    expect(children).toHaveLength(3);
  });

  it("cancels recovery when the desktop stops during backoff", () => {
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    children[0]!.emit("close", 1, null);
    stop();
    vi.advanceTimersByTime(120_000);
    expect(children).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes stdin for a clean shutdown and never kills a child that has already closed", () => {
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    const child = children[0]!;
    stop();
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    vi.advanceTimersByTime(120_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(children).toHaveLength(1);
  });

  it("force-stops only the owned child when graceful shutdown stalls", () => {
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    stop();
    vi.advanceTimersByTime(5000);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    children[0]!.emit("close", null, "SIGTERM");
    vi.advanceTimersByTime(120_000);
    expect(children).toHaveLength(1);
  });

  it("does not start or keep retrying a missing bundled entry", () => {
    mocks.exists.mockReturnValue(false);
    stop = startMobileCompanion({ entry: "/missing/server.mjs", log });
    vi.advanceTimersByTime(120_000);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
