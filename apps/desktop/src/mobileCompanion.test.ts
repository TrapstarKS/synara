import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(), request: vi.fn() }));
vi.mock("@synara/shared/processRuntime", () => ({ spawnProcess: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
vi.mock("node:http", () => ({ request: mocks.request }));

import { probeMobileCompanion, startMobileCompanion } from "./mobileCompanion";

function makeChild() {
  return Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
}

function makeProbe(options: RequestOptions, onResponse: (response: IncomingMessage) => void) {
  const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  const response = Object.assign(new EventEmitter(), { statusCode: 200, destroy: vi.fn() });
  return {
    options,
    request,
    response,
    respond(statusCode = 200, body = '{"paired":false}', end = true) {
      response.statusCode = statusCode;
      onResponse(response as unknown as IncomingMessage);
      response.emit("data", Buffer.from(body));
      if (end) response.emit("end");
    },
  };
}

describe("mobile companion recovery", () => {
  const children: ReturnType<typeof makeChild>[] = [];
  const probes: ReturnType<typeof makeProbe>[] = [];
  let reply: (probe: ReturnType<typeof makeProbe>) => void;
  let stop: (() => void) | undefined;
  const log = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.exists.mockReturnValue(true);
    reply = (probe) => probe.request.emit("error", new Error("connection refused"));
    mocks.request.mockImplementation((options, onResponse) => {
      const probe = makeProbe(options, onResponse);
      probes.push(probe);
      probe.request.end.mockImplementation(() => queueMicrotask(() => reply(probe)));
      return probe.request;
    });
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
    probes.length = 0;
    vi.unstubAllEnvs();
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
    expect(children).toHaveLength(1);
    expect(children[0]!.stdin.writableEnded).toBe(false);
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

  it("recovers a live companion that never becomes available without overlapping children", async () => {
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    const child = children[0]!;
    await vi.advanceTimersByTimeAsync(119_999);
    expect(child.stdin.writableEnded).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(1);
    child.emit("close", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(5000);
    expect(children).toHaveLength(2);
  });

  it("accepts a local companion without pairing or a connected backend", async () => {
    vi.stubEnv("SYNARA_MOBILE_PORT", "58991");
    vi.stubEnv("SYNARA_MOBILE_UPSTREAM_TOKEN", "must-not-be-sent");
    reply = (probe) => probe.respond();
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(children).toHaveLength(1);
    expect(children[0]!.stdin.writableEnded).toBe(false);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    expect(probes.length).toBeGreaterThan(1);
    expect(probes[0]!.options).toEqual({
      hostname: "127.0.0.1",
      port: 58991,
      path: "/mobile/api/status",
      method: "GET",
      agent: false,
    });
  });

  it("recovers after a responsive companion stops answering and waits for close", async () => {
    reply = (probe) => probe.respond();
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    await vi.advanceTimersByTimeAsync(15_000);
    reply = () => {};
    await vi.advanceTimersByTimeAsync(60_000);
    const child = children[0]!;
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(1);
    child.emit("close", null, "SIGTERM");
    reply = (probe) => probe.respond();
    await vi.advanceTimersByTimeAsync(5000);
    expect(children).toHaveLength(2);
  });

  it("resets consecutive failures when the companion responds again", async () => {
    reply = (probe) => probe.respond();
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    await vi.advanceTimersByTimeAsync(15_000);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      reply = (probe) => probe.request.emit("error", new Error("temporary refusal"));
      await vi.advanceTimersByTimeAsync(30_000);
      reply = (probe) => probe.respond();
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(children[0]!.stdin.writableEnded).toBe(false);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    expect(children).toHaveLength(1);
  });

  it("bounds pending probes and never overlaps them", async () => {
    reply = () => {};
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.request.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(probes[0]!.request.destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes).toHaveLength(2);
  });

  it("cancels an in-flight probe on close and ignores its late response after replacement", async () => {
    reply = () => {};
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    await vi.advanceTimersByTimeAsync(15_000);
    const oldProbe = probes[0]!;
    const oldChild = children[0]!;
    oldChild.emit("close", 1, null);
    expect(oldProbe.request.destroy).toHaveBeenCalledOnce();
    reply = (probe) => probe.respond();
    await vi.advanceTimersByTimeAsync(5000);
    expect(children).toHaveLength(2);
    oldProbe.respond(503, "late failure");
    oldProbe.request.emit("error", new Error("late connection error"));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(children).toHaveLength(2);
    expect(oldChild.kill).not.toHaveBeenCalled();
    expect(children[1]!.stdin.writableEnded).toBe(false);
    expect(children[1]!.kill).not.toHaveBeenCalled();
  });

  it("cancels an in-flight probe and further recovery when stopped", async () => {
    reply = () => {};
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    await vi.advanceTimersByTimeAsync(15_000);
    const probe = probes[0]!;
    stop();
    expect(probe.request.destroy).toHaveBeenCalledOnce();
    children[0]!.emit("close", 0, null);
    probe.respond();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(children).toHaveLength(1);
    expect(probes).toHaveLength(1);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not signal an exited child while waiting for its pipes to close", async () => {
    reply = () => {};
    stop = startMobileCompanion({ entry: "/app/mobile-remote/server.mjs", log });
    await vi.advanceTimersByTimeAsync(15_000);
    const child = children[0]!;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    expect(probes[0]!.request.destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(child.stdin.writableEnded).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(children).toHaveLength(1);
    child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(children).toHaveLength(2);
  });

  it.each([
    [302, '{"paired":false}'],
    [503, '{"paired":false}'],
    [200, "not json"],
    [200, "null"],
    [200, "{}"],
    [200, '{"paired":"false"}'],
    [200, `{"paired":false,"padding":"${"x".repeat(1024)}"}`],
  ])("rejects an invalid health response (%s, %s)", async (statusCode, body) => {
    reply = (probe) => probe.respond(statusCode, body);
    expect(await probeMobileCompanion(58091, new AbortController().signal)).toBe(false);
    expect(probes[0]!.request.destroy).toHaveBeenCalledOnce();
    expect(probes[0]!.response.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a response whose body never completes", async () => {
    reply = (probe) => probe.respond(200, '{"paired":', false);
    const result = probeMobileCompanion(58091, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe(false);
    expect(probes[0]!.response.destroy).toHaveBeenCalledOnce();
    expect(probes[0]!.request.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send an already-cancelled probe and cleans up synchronous request failures", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await probeMobileCompanion(58091, controller.signal)).toBe(false);
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.request.mockImplementationOnce(() => {
      throw new Error("request unavailable");
    });
    expect(await probeMobileCompanion(58091, new AbortController().signal)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
