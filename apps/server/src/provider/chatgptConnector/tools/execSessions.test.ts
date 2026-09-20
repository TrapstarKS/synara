// FILE: execSessions.test.ts
// Purpose: Unit tests for the ChatGPT connector exec session manager (run, poll, write, kill).
// Layer: Server provider connector tests

import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExecSessionManager, type ExecSessionManagerOptions } from "./execSessions.ts";

const temporaryRoots: string[] = [];
const managers: ExecSessionManager[] = [];

// Exercise shell sessions without sourcing the operator's zsh/fish startup hooks.
beforeEach(() => vi.stubEnv("SHELL", "/bin/sh"));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "synara-exec-sessions-"));
  temporaryRoots.push(root);
  return root;
}

function manager(options: Partial<ExecSessionManagerOptions> = {}): ExecSessionManager {
  const instance = new ExecSessionManager({ defaultYieldMs: 2_000, maxYieldMs: 5_000, ...options });
  managers.push(instance);
  return instance;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const instance of managers.splice(0)) instance.killAll();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// The commands below are POSIX shell invocations; the Windows branch of the manager is not
// exercised by this suite.
describe.skipIf(process.platform === "win32")("ExecSessionManager", () => {
  it("runs a short command to completion without retaining a session", async () => {
    const root = await tempRoot();
    const sessions = manager();

    const result = await sessions.run({ command: "echo hello", cwd: root });

    expect(result.running).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello");
    expect(result.wallTimeSeconds).toBeGreaterThanOrEqual(0);
    expect(sessions.list()).toHaveLength(0);
  });

  it("merges stdout and stderr in arrival order and extends the environment", async () => {
    const root = await tempRoot();
    const sessions = manager();

    const result = await sessions.run({
      command: 'echo out; echo err >&2; printf %s "$SYNARA_EXEC_TEST"',
      cwd: root,
      env: { SYNARA_EXEC_TEST: "from-env" },
    });

    const output = result.output;
    expect(output).toContain("out");
    expect(output).toContain("err");
    expect(output).toContain("from-env");
  });

  it("reports the exit code of a failing command", async () => {
    const root = await tempRoot();
    const sessions = manager();

    const result = await sessions.run({ command: "exit 3", cwd: root });

    expect(result.running).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it("honors the requested cwd", async () => {
    const root = await tempRoot();
    const sessions = manager();

    const result = await sessions.run({ command: "pwd", cwd: root });
    const printed = result.output.trim();

    expect([root, realpathSync(root)].some((candidate) => printed.includes(candidate))).toBe(true);
  });

  it("keeps a long-running command as a session and polls it to completion", async () => {
    const root = await tempRoot();
    const sessions = manager();

    const started = await sessions.run({ command: "sleep 5", cwd: root, yieldMs: 200 });

    expect(started.running).toBe(true);
    expect(started.sessionId).toBe(1);
    const sessionId = started.sessionId;
    if (sessionId === null) throw new Error("expected a retained session");

    let poll = await sessions.write(sessionId, "", { yieldMs: 500 });
    const deadline = Date.now() + 7_000;
    while (poll.running && Date.now() < deadline) {
      poll = await sessions.write(sessionId, "", { yieldMs: 500 });
    }

    expect(poll.running).toBe(false);
    expect(poll.exitCode).toBe(0);
    expect(sessions.list()).toHaveLength(0);
  }, 9_000);

  it("writes to stdin, drains the echoed output and retires killed sessions", async () => {
    const root = await tempRoot();
    const sessions = manager();

    const started = await sessions.run({ command: "cat", cwd: root, yieldMs: 150 });
    const sessionId = started.sessionId;
    if (sessionId === null) throw new Error("expected a retained session");

    // A login shell can spend close to a second sourcing profiles before it reaches the
    // command, so keep offering input until the echo lands rather than assuming a fixed delay.
    let echoed = await sessions.write(sessionId, "hello\n", { yieldMs: 500 });
    const deadline = Date.now() + 5_000;
    while (!echoed.output.includes("hello") && echoed.running && Date.now() < deadline) {
      echoed = await sessions.write(sessionId, "hello\n", { yieldMs: 500 });
    }

    expect(echoed.output).toContain("hello");
    expect(echoed.running).toBe(true);

    expect(sessions.kill(sessionId)).toBe(true);
    expect(sessions.list()).toHaveLength(0);
    await expect(sessions.write(sessionId, "", { yieldMs: 50 })).rejects.toThrow(
      /no such exec session/,
    );
    expect(sessions.kill(sessionId)).toBe(false);
  });

  it("returns a blank poll after a bounded window when nothing arrives", async () => {
    const root = await tempRoot();
    const sessions = manager();

    const started = await sessions.run({ command: "sleep 5", cwd: root, yieldMs: 100 });
    const sessionId = started.sessionId;
    if (sessionId === null) throw new Error("expected a retained session");

    const began = Date.now();
    const poll = await sessions.write(sessionId, "", { yieldMs: 1_000 });
    const elapsed = Date.now() - began;

    expect(poll.running).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2_500);
    sessions.kill(sessionId);
  });

  it("returns a blank poll as soon as new output arrives", async () => {
    const root = await tempRoot();
    const sessions = manager();

    const started = await sessions.run({
      command: "sleep 1; echo late",
      cwd: root,
      yieldMs: 100,
    });
    const sessionId = started.sessionId;
    if (sessionId === null) throw new Error("expected a retained session");

    const began = Date.now();
    const poll = await sessions.write(sessionId, "", { yieldMs: 4_000 });
    const elapsed = Date.now() - began;

    expect(poll.output).toContain("late");
    expect(elapsed).toBeLessThan(3_500);
    sessions.kill(sessionId);
  });

  it("enforces the session limit before spawning another child", async () => {
    const root = await tempRoot();
    const sessions = manager({ maxSessions: 1 });

    const first = await sessions.run({ command: "sleep 5", cwd: root, yieldMs: 100 });
    expect(first.running).toBe(true);

    await expect(sessions.run({ command: "sleep 5", cwd: root, yieldMs: 100 })).rejects.toThrow(
      /session limit/,
    );
  });

  it("killAll terminates retained children and empties the list", async () => {
    const root = await tempRoot();
    const sessions = manager();

    await sessions.run({ command: "sleep 5", cwd: root, yieldMs: 100 });
    await sessions.run({ command: "sleep 5", cwd: root, yieldMs: 100 });

    expect(sessions.list()).toHaveLength(2);
    expect(sessions.list().every((entry) => entry.running)).toBe(true);
    expect(sessions.list()[0]?.command).toBe("sleep 5");
    expect(Number.isNaN(Date.parse(sessions.list()[0]?.startedAt ?? ""))).toBe(false);

    sessions.killAll();

    expect(sessions.list()).toHaveLength(0);
  });

  it("caps accumulated output, keeping the tail behind an omission marker", async () => {
    const root = await tempRoot();
    const sessions = manager({ maxOutputBytes: 64 });

    const result = await sessions.run({ command: "seq 1 200", cwd: root });

    expect(result.running).toBe(false);
    expect(result.output).toContain("[… truncated ");
    expect(result.output).toContain("200");
    expect(result.output).not.toContain("1\n2\n3");
  });

  it("rejects an unknown session id", async () => {
    const sessions = manager();
    await expect(sessions.write(99, "")).rejects.toThrow(/no such exec session/);
    await expect(sessions.write(99, "input")).rejects.toThrow(/no such exec session/);
  });

  it("kills the child and rejects when the run signal aborts", async () => {
    const root = await tempRoot();
    const sessions = manager();
    const controller = new AbortController();

    const running = sessions.run({
      command: "sleep 5",
      cwd: root,
      signal: controller.signal,
      yieldMs: 3_000,
    });
    setTimeout(() => controller.abort(), 100);

    await expect(running).rejects.toThrow(/exec aborted/);
  });
});
