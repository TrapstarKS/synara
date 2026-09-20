// FILE: execSessions.ts
// Purpose: Bounded shell sessions (run, poll, write, kill) for the ChatGPT connector's
//   command-execution tool surface.
// Layer: Server provider connector (ChatGPT connector tools)
//
// Adapted from Chat On Steroids (MIT) — src/main/codex/unified-exec.ts and
// src/main/codex/head-tail-buffer.ts. The session lifecycle follows that manager: a command that
// finishes inside the initial yield window is handed back whole and never retained; a command
// still running after it is kept as a session whose accumulated output is capped, keeping the
// tail behind an omission marker. Polls drain what has arrived since the previous call, so no
// byte is delivered twice.

import type { ChildProcess } from "node:child_process";
import { prepareShellProcess } from "@synara/shared/platformProcess";
import { spawnPlannedProcess } from "@synara/shared/processRuntime";

export interface ExecSessionManagerOptions {
  /** Retained (still-running) sessions allowed at once. */
  readonly maxSessions: number;
  /** Per-session accumulated output cap; the tail is kept. */
  readonly maxOutputBytes: number;
  /** How long the initial `run` wait may last. */
  readonly defaultYieldMs: number;
  /** Upper bound for any caller-supplied yield time. */
  readonly maxYieldMs: number;
}

export interface ExecRunInput {
  readonly command: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  /** Aborts the initial wait, killing the child. Only the `run` call honors it. */
  readonly signal?: AbortSignal;
  readonly yieldMs?: number;
}

export interface ExecRunResult {
  /** Present only while the process is still running and was retained. */
  readonly sessionId: number | null;
  readonly output: string;
  readonly exitCode: number | null;
  /**
   * Seconds spent in the initial wait window only (spawn to deadline or exit, rounded to three
   * decimals). The bounded stdio flush after exit is deliberately excluded.
   */
  readonly wallTimeSeconds: number;
  readonly running: boolean;
}

export interface ExecPollResult {
  readonly output: string;
  readonly exitCode: number | null;
  readonly running: boolean;
}

export interface ExecSessionSummary {
  readonly sessionId: number;
  readonly running: boolean;
  readonly startedAt: string;
  readonly command: string;
}

const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_YIELD_MS = 10_000;
const DEFAULT_MAX_YIELD_MS = 30_000;
/** Longest a blank poll waits when no output arrives. */
const EMPTY_POLL_WINDOW_MS = 1_000;
/** After exit, how long the manager waits for stdio to close before draining. */
const EXIT_FLUSH_MS = 500;
/** Grace period before a SIGTERM'd child is SIGKILL'd. */
const KILL_GRACE_MS = 500;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function roundSeconds(milliseconds: number): number {
  return Math.round((milliseconds / 1000) * 1000) / 1000;
}

/**
 * Bytes-only rolling buffer that keeps the tail of a stream.
 *
 * Dropped bytes are counted, and a drain renders `[… truncated N bytes …]` ahead of the
 * retained tail. A trim can leave the retained window starting inside a UTF-8 character; the
 * partial leading character is dropped at drain time and counted as omitted.
 */
class TailOutputBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private omitted = 0;

  constructor(private readonly maxBytes: number) {}

  get hasUndeliveredOutput(): boolean {
    return this.bytes > 0 || this.omitted > 0;
  }

  push(chunk: Buffer): boolean {
    if (chunk.length === 0) return false;
    if (this.maxBytes <= 0) {
      this.omitted += chunk.length;
      return true;
    }
    if (chunk.length >= this.maxBytes) {
      this.omitted += this.bytes + (chunk.length - this.maxBytes);
      this.chunks = [Buffer.from(chunk.subarray(chunk.length - this.maxBytes))];
      this.bytes = this.maxBytes;
      return true;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0];
      if (head === undefined) break;
      const excess = this.bytes - this.maxBytes;
      if (head.length <= excess) {
        this.chunks.shift();
        this.bytes -= head.length;
        this.omitted += head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.bytes -= excess;
        this.omitted += excess;
      }
    }
    return true;
  }

  drain(): { text: string; omittedBytes: number } {
    let retained = this.bytes > 0 ? Buffer.concat(this.chunks, this.bytes) : Buffer.alloc(0);
    let skip = 0;
    while (skip < retained.length && (retained[skip]! & 0xc0) === 0x80) skip += 1;
    if (skip > 0) retained = retained.subarray(skip);
    const omitted = this.omitted + skip;
    this.chunks = [];
    this.bytes = 0;
    this.omitted = 0;
    if (omitted === 0) return { text: retained.toString("utf8"), omittedBytes: 0 };
    return {
      text: `[… truncated ${omitted} bytes …]\n${retained.toString("utf8")}`,
      omittedBytes: omitted,
    };
  }
}

interface ExecSession {
  id: number;
  readonly command: string;
  readonly startedAt: string;
  readonly child: ChildProcess;
  readonly buffer: TailOutputBuffer;
  readonly waiters: Set<() => void>;
  exited: boolean;
  exitCode: number | null;
  stdioClosed: boolean;
  spawnError: string | null;
  killTimer: NodeJS.Timeout | null;
  readonly onData: (chunk: Buffer) => void;
  readonly onExit: () => void;
  readonly onError: (error: Error) => void;
  readonly onClose: () => void;
}

export class ExecSessionManager {
  private readonly options: ExecSessionManagerOptions;
  private readonly sessions = new Map<number, ExecSession>();
  private nextSessionId = 1;

  constructor(options: Partial<ExecSessionManagerOptions> = {}) {
    this.options = {
      maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      defaultYieldMs: options.defaultYieldMs ?? DEFAULT_YIELD_MS,
      maxYieldMs: options.maxYieldMs ?? DEFAULT_MAX_YIELD_MS,
    };
  }

  /**
   * Starts a command. Admission is checked before spawning so a full manager never creates an
   * orphan child; a command still running when its yield window closes is retained as a session.
   */
  async run(input: ExecRunInput): Promise<ExecRunResult> {
    if (this.sessions.size >= this.options.maxSessions) {
      throw new Error(
        `exec session limit reached (${this.options.maxSessions}); kill or drain an existing session first`,
      );
    }
    if (input.signal?.aborted) {
      throw new Error("exec aborted");
    }

    const env = { ...process.env, ...input.env };
    let child: ChildProcess;
    try {
      const plan = prepareShellProcess(input.command, { cwd: input.cwd, env });
      child = spawnPlannedProcess(plan, {
        cwd: input.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`failed to start command: ${errorText(error)}`, { cause: error });
    }

    const session: ExecSession = {
      id: 0,
      command: input.command,
      startedAt: new Date().toISOString(),
      child,
      buffer: new TailOutputBuffer(this.options.maxOutputBytes),
      waiters: new Set(),
      exited: false,
      exitCode: null,
      stdioClosed: false,
      spawnError: null,
      killTimer: null,
      onData: (chunk: Buffer) => {
        if (session.buffer.push(chunk)) this.notifyWaiters(session);
      },
      onExit: () => this.handleExit(session),
      onError: (error: Error) => {
        session.spawnError = error.message;
        session.exited = true;
        this.clearKillTimer(session);
        this.notifyWaiters(session);
      },
      onClose: () => {
        session.stdioClosed = true;
        this.notifyWaiters(session);
      },
    };
    child.stdout?.on("data", session.onData);
    child.stderr?.on("data", session.onData);
    child.stdin?.on("error", () => undefined);
    child.on("exit", session.onExit);
    child.on("error", session.onError);
    child.on("close", session.onClose);

    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      this.terminateChild(session);
      this.notifyWaiters(session);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const yieldMs = this.clampYield(input.yieldMs);
    const waitStarted = performance.now();
    await this.waitUntil(session, yieldMs, () => session.exited || aborted);
    // The initial-wait duration is the caller-visible cost of starting a session; the flush
    // grace below belongs to delivering the exit, not to the wait window.
    const wallTimeSeconds = roundSeconds(performance.now() - waitStarted);
    input.signal?.removeEventListener("abort", onAbort);

    if (aborted) {
      throw new Error("exec aborted");
    }
    if (session.exited) await this.waitUntil(session, EXIT_FLUSH_MS, () => session.stdioClosed);

    const drained = session.buffer.drain();
    if (session.exited) {
      this.disposeSession(session);
      return {
        sessionId: null,
        output: this.withSpawnError(session, drained.text),
        exitCode: session.exitCode,
        wallTimeSeconds,
        running: false,
      };
    }

    session.id = this.nextSessionId;
    this.nextSessionId += 1;
    this.sessions.set(session.id, session);
    return {
      sessionId: session.id,
      output: drained.text,
      exitCode: null,
      wallTimeSeconds,
      running: true,
    };
  }

  /**
   * Writes to a live session, or polls it when `chars` is blank.
   *
   * A non-empty write keeps a collection window: it waits up to the yield time so one
   * interactive response is gathered whole. A blank poll returns as soon as new output appears
   * or the process exits, and otherwise after a bounded short window with whatever arrived.
   * Delivering the final output of an exited session retires it; a later call throws.
   */
  async write(
    sessionId: number,
    chars: string,
    opts: { yieldMs?: number } = {},
  ): Promise<ExecPollResult> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`no such exec session: ${sessionId}`);
    }

    if (chars.length > 0) {
      if (!session.exited) {
        try {
          session.child.stdin?.write(chars);
        } catch {
          // The child may have closed stdin between the exit event and this write.
        }
      }
      if (!session.exited) {
        // The collection window is deliberately short by default: a live stdin write is
        // interactive, so it falls back to the same bounded window as a blank poll.
        const writeWindow =
          opts.yieldMs === undefined ? EMPTY_POLL_WINDOW_MS : this.clampYield(opts.yieldMs);
        await this.waitUntil(session, writeWindow, () => session.exited);
      }
    } else if (!session.exited && !session.buffer.hasUndeliveredOutput) {
      const pollWindow =
        opts.yieldMs === undefined ? EMPTY_POLL_WINDOW_MS : this.clampYield(opts.yieldMs);
      await this.waitUntil(
        session,
        pollWindow,
        () => session.exited || session.buffer.hasUndeliveredOutput,
      );
    }

    if (session.exited && !session.stdioClosed) {
      await this.waitUntil(session, EXIT_FLUSH_MS, () => session.stdioClosed);
    }
    const drained = session.buffer.drain();
    if (session.exited) {
      this.disposeSession(session);
      return {
        output: this.withSpawnError(session, drained.text),
        exitCode: session.exitCode,
        running: false,
      };
    }
    return { output: drained.text, exitCode: null, running: true };
  }

  /** Terminates one session and forgets it. Returns false when the id is unknown. */
  kill(sessionId: number): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    this.sessions.delete(sessionId);
    if (!session.exited) this.terminateChild(session);
    this.notifyWaiters(session);
    return true;
  }

  /** Terminates every retained session. Intended for teardown. */
  killAll(): void {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      if (!session.exited) this.terminateChild(session);
      this.notifyWaiters(session);
    }
  }

  list(): ReadonlyArray<ExecSessionSummary> {
    return [...this.sessions.values()]
      .toSorted((left, right) => left.id - right.id)
      .map((session) => ({
        sessionId: session.id,
        running: !session.exited,
        startedAt: session.startedAt,
        command: session.command,
      }));
  }

  private clampYield(yieldMs: number | undefined): number {
    const requested =
      yieldMs === undefined || !Number.isFinite(yieldMs) ? this.options.defaultYieldMs : yieldMs;
    return Math.min(Math.max(Math.floor(requested), 0), this.options.maxYieldMs);
  }

  private handleExit(session: ExecSession): void {
    session.exited = true;
    session.exitCode = session.child.exitCode;
    this.clearKillTimer(session);
    this.notifyWaiters(session);
  }

  /**
   * Waits until `condition` holds or the timeout elapses. Every waiter is removed on settle and
   * only a condition-satisfying wake-up ends the wait, so output wake-ups cannot end an exit
   * wait by accident.
   */
  private waitUntil(
    session: ExecSession,
    timeoutMs: number,
    condition: () => boolean,
  ): Promise<"met" | "timeout"> {
    if (condition()) return Promise.resolve("met");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: "met" | "timeout"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.waiters.delete(onWake);
        resolve(result);
      };
      const onWake = (): void => {
        if (condition()) finish("met");
      };
      const timer = setTimeout(() => finish("timeout"), Math.max(0, timeoutMs));
      session.waiters.add(onWake);
    });
  }

  private notifyWaiters(session: ExecSession): void {
    // Deletion during Set iteration is safe, so waiters may retire themselves as they wake.
    for (const waiter of session.waiters) waiter();
  }

  private terminateChild(session: ExecSession): void {
    if (session.exited) return;
    try {
      session.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    if (session.killTimer !== null) return;
    session.killTimer = setTimeout(() => {
      session.killTimer = null;
      if (session.exited) return;
      try {
        session.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS);
  }

  private clearKillTimer(session: ExecSession): void {
    if (session.killTimer === null) return;
    clearTimeout(session.killTimer);
    session.killTimer = null;
  }

  private withSpawnError(session: ExecSession, output: string): string {
    if (session.spawnError === null) return output;
    const detail = `Error: ${session.spawnError}`;
    return output.length > 0 ? `${output}\n${detail}` : detail;
  }

  private disposeSession(session: ExecSession): void {
    if (session.id > 0) this.sessions.delete(session.id);
    this.clearKillTimer(session);
    session.child.stdout?.removeListener("data", session.onData);
    session.child.stderr?.removeListener("data", session.onData);
    session.child.removeListener("exit", session.onExit);
    session.child.removeListener("error", session.onError);
    session.child.removeListener("close", session.onClose);
  }
}
