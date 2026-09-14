// FILE: tunnel.ts
// Purpose: Supervises the child process that exposes the local ChatGPT MCP connector
//          to chatgpt.com (manual, Cloudflare quick tunnel, OpenAI Secure MCP Tunnel).
// Layer: Server provider / ChatGPT connector
//
// Adapted from Chat On Steroids (MIT) — src/main/tunnel: the cloudflared and OpenAI
// process adapters, the PATH locator, and the bounded line reader derive from that
// implementation.
//
// Plain Node by design (no Effect) so the supervisor is unit testable with a fake
// child process; the provider layer wraps it and observes `status()`.
//
// Lifecycle contract:
// - `start()` resolves once the requested mode has been applied: `off` and `manual`
//   resolve immediately, tunnel modes resolve with `starting` right after spawn, and
//   invalid configuration resolves with `error`. Later transitions (`connected`,
//   `error`) are observed through `status()`.
// - Starting a mode while a child runs retires that child first (SIGTERM, then a
//   bounded 2s wait), so the supervisor owns at most one tunnel process.
// - `stop()` retires the child and reports `stopped`, except while the state is
//   already `off` or `manual`; those states and their guidance messages are kept.

import { resolveExecutable } from "@synara/shared/executable";

export type ChatGptTunnelMode = "off" | "manual" | "cloudflared" | "openai";

export interface ChatGptTunnelConfig {
  readonly mode: ChatGptTunnelMode;
  /** Absolute path override for the tunnel binary. Empty/undefined = resolve on PATH. */
  readonly binaryPath?: string;
  readonly openAiTunnelId?: string;
  readonly openAiTunnelApiKey?: string;
  /** Local connector URL, e.g. http://127.0.0.1:58090/mcp/chatgpt/<token>. */
  readonly localUrl: string;
}

export interface ChatGptTunnelStatus {
  readonly state: "off" | "manual" | "starting" | "connected" | "error" | "stopped";
  readonly publicUrl: string | null;
  readonly message: string | null;
  readonly updatedAt: string;
}

export interface ChatGptTunnelChild {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ChatGptTunnelDependencies {
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; cwd?: string },
  ) => ChatGptTunnelChild;
  readonly resolveBinary?: (name: string, override?: string) => string | null;
  readonly now?: () => Date;
  readonly readyGraceMs?: number;
  readonly readyTimeoutMs?: number;
}

const CLOUDFLARED_BINARY = "cloudflared";
const OPENAI_TUNNEL_BINARY = "tunnel-client";
const CLOUDFLARED_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const OPENAI_TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;
const OPENAI_ERROR_LOG_PATTERN = /"level"\s*:\s*"error"/;
const DEFAULT_READY_GRACE_MS = 5_000;
const DEFAULT_READY_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 2_000;
const RETAINED_OUTPUT_LIMIT = 8 * 1024;
const MAX_LINE_CARRY = 16_384;
const LAST_LINE_LIMIT = 200;
const OFF_MESSAGE = "Tunnel disabled.";
const CLOUDFLARED_STARTING_MESSAGE = "Starting Cloudflare quick tunnel…";
const CLOUDFLARED_CONNECTED_MESSAGE = "Cloudflare quick tunnel active.";
const CLOUDFLARED_TIMEOUT_MESSAGE = "Cloudflare tunnel did not report a URL in time.";
const OPENAI_STARTING_MESSAGE = "Starting OpenAI tunnel…";
const OPENAI_CONNECTED_MESSAGE =
  "OpenAI tunnel connected. The tunnel is managed by OpenAI and the local connector URL stays private.";
const INVALID_TUNNEL_ID_MESSAGE =
  "Enter a tunnel ID that looks like tunnel_ followed by 32 hex characters.";
const MISSING_OPENAI_KEY_MESSAGE = "Add your OpenAI tunnel API key first.";
const STOPPED_MESSAGE = "Tunnel stopped.";

/** The public hostname cloudflared prints once its quick tunnel is live. */
export function extractCloudflaredUrl(text: string): string | null {
  const match = CLOUDFLARED_URL_PATTERN.exec(text);
  return match ? match[0] : null;
}

/**
 * cloudflared is pointed at the loopback origin, but must forward the original Host
 * header: the connector's loopback host check rejects the public trycloudflare host.
 */
export function buildCloudflaredArgs(input: { readonly localUrl: string }): string[] {
  const local = new URL(input.localUrl);
  return [
    "tunnel",
    "--no-autoupdate",
    "--url",
    `${local.protocol}//${local.host}`,
    "--http-host-header",
    local.host,
  ];
}

/**
 * The two variables tunnel-client needs. The supervisor spreads them over the
 * inherited process environment; the API key never becomes an argv entry.
 */
export function buildOpenAiTunnelEnv(input: {
  readonly localUrl: string;
  readonly apiKey: string;
}): NodeJS.ProcessEnv {
  return {
    CONTROL_PLANE_API_KEY: input.apiKey,
    MCP_SERVER_URL: `url=${input.localUrl},channel=main`,
  };
}

/** Finds an executable the way a shell would, honoring the caller's env/platform. */
export function resolveOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return resolveExecutable(binary, { env, platform });
}

function defaultResolveBinary(name: string, override?: string): string | null {
  const trimmedOverride = override?.trim();
  if (trimmedOverride) {
    const fromOverride = resolveOnPath(trimmedOverride, process.env, process.platform);
    if (fromOverride) return fromOverride;
  }
  return resolveOnPath(name, process.env, process.platform);
}

function boundedText(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `code ${code}`;
  if (signal !== null) return `signal ${signal}`;
  return "an unknown status";
}

function findErrorLogLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (OPENAI_ERROR_LOG_PATTERN.test(line)) return line;
  }
  return null;
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

interface LineCarry {
  text: string;
}

/** Splits stream chunks into complete lines; output without newlines is bounded. */
function consumeLines(
  stream: NodeJS.ReadableStream | null,
  carry: LineCarry,
  onLine: (line: string) => void,
): void {
  if (stream === null) return;
  stream.on("data", (chunk: unknown) => {
    carry.text += chunkToString(chunk);
    let newline = carry.text.indexOf("\n");
    while (newline !== -1) {
      const line = carry.text.slice(0, newline).replace(/\r$/, "").trimEnd();
      carry.text = carry.text.slice(newline + 1);
      if (line.length > 0) onLine(line);
      newline = carry.text.indexOf("\n");
    }
    if (carry.text.length > MAX_LINE_CARRY) {
      carry.text = carry.text.slice(-MAX_LINE_CARRY);
    }
  });
}

interface TunnelRunHooks {
  readonly onLine: (run: TunnelRun, line: string) => void;
  readonly onExit: (run: TunnelRun, code: number | null, signal: NodeJS.Signals | null) => void;
  readonly onError: (run: TunnelRun, error: Error) => void;
}

type TunnelRunMode = "cloudflared" | "openai";

/** One owned tunnel child, its bounded output tail, and its exit waiters. */
class TunnelRun {
  readonly mode: TunnelRunMode;
  readonly localPathname: string;
  readonly child: ChatGptTunnelChild;
  retired = false;
  exited = false;
  connected = false;
  timedOut = false;
  errorLine: string | null = null;
  lastLine: string | null = null;
  startTimer: NodeJS.Timeout | null = null;

  private readonly exitWaiters: Array<() => void> = [];
  private readonly stdoutCarry: LineCarry = { text: "" };
  private readonly stderrCarry: LineCarry = { text: "" };
  private retainedOutput = "";

  constructor(
    mode: TunnelRunMode,
    localPathname: string,
    child: ChatGptTunnelChild,
    hooks: TunnelRunHooks,
  ) {
    this.mode = mode;
    this.localPathname = localPathname;
    this.child = child;
    consumeLines(child.stdout, this.stdoutCarry, (line) => hooks.onLine(this, line));
    consumeLines(child.stderr, this.stderrCarry, (line) => hooks.onLine(this, line));
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.flushExitWaiters();
      if (!this.retired) hooks.onExit(this, code, signal);
    });
    child.on("error", (error) => {
      this.exited = true;
      this.flushExitWaiters();
      if (!this.retired) hooks.onError(this, error);
    });
  }

  retain(line: string): void {
    this.lastLine = line;
    this.retainedOutput += `${line}\n`;
    if (this.retainedOutput.length > RETAINED_OUTPUT_LIMIT) {
      this.retainedOutput = this.retainedOutput.slice(-RETAINED_OUTPUT_LIMIT);
    }
  }

  retainedOutputTail(): string {
    return this.retainedOutput;
  }

  /** Marks the run as deliberately retired; late child events are ignored. */
  retire(): void {
    this.retired = true;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  /** Resolves when the child has exited, or after `timeoutMs` as a bound. */
  waitForExit(timeoutMs: number): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve();
      }, timeoutMs);
      this.exitWaiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private flushExitWaiters(): void {
    for (const waiter of this.exitWaiters.splice(0)) waiter();
  }
}

export class ChatGptTunnelSupervisor {
  private readonly spawnChild: ChatGptTunnelDependencies["spawn"];
  private readonly resolveBinary: (name: string, override?: string) => string | null;
  private readonly now: () => Date;
  private readonly readyGraceMs: number;
  private readonly readyTimeoutMs: number;
  private readonly hooks: TunnelRunHooks;
  private run: TunnelRun | null = null;
  private currentStatus: ChatGptTunnelStatus;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dependencies: ChatGptTunnelDependencies) {
    this.spawnChild = dependencies.spawn;
    this.resolveBinary = dependencies.resolveBinary ?? defaultResolveBinary;
    this.now = dependencies.now ?? (() => new Date());
    this.readyGraceMs = dependencies.readyGraceMs ?? DEFAULT_READY_GRACE_MS;
    this.readyTimeoutMs = dependencies.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.currentStatus = {
      state: "off",
      publicUrl: null,
      message: OFF_MESSAGE,
      updatedAt: this.now().toISOString(),
    };
    this.hooks = {
      onLine: (run, line) => this.handleLine(run, line),
      onExit: (run, code, signal) => this.handleExit(run, code, signal),
      onError: (run, error) => this.handleChildError(run, error),
    };
  }

  /** The latest status. Startup transitions land here after `start()` resolves. */
  status(): ChatGptTunnelStatus {
    return this.currentStatus;
  }

  start(config: ChatGptTunnelConfig): Promise<ChatGptTunnelStatus> {
    return this.enqueue(() => this.startInternal(config));
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.stopInternal());
  }

  /** Serializes start/stop so at most one owned child exists at a time. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async startInternal(config: ChatGptTunnelConfig): Promise<ChatGptTunnelStatus> {
    await this.retireActiveRun();

    switch (config.mode) {
      case "off":
        return this.applyStatus({ state: "off", publicUrl: null, message: OFF_MESSAGE });
      case "manual":
        return this.applyStatus({
          state: "manual",
          publicUrl: null,
          message: `Forward ${config.localUrl} with your own HTTPS tunnel, then paste the full public URL (including the secret path) into ChatGPT as the connector URL.`,
        });
      case "cloudflared":
        return this.startCloudflared(config);
      case "openai":
        return this.startOpenAi(config);
    }
  }

  private async stopInternal(): Promise<void> {
    await this.retireActiveRun();
    const { state } = this.currentStatus;
    if (state === "off" || state === "manual") return;
    this.applyStatus({ state: "stopped", publicUrl: null, message: STOPPED_MESSAGE });
  }

  private startCloudflared(config: ChatGptTunnelConfig): ChatGptTunnelStatus {
    const binary = this.resolveBinary(CLOUDFLARED_BINARY, config.binaryPath);
    if (!binary) {
      return this.applyStatus({
        state: "error",
        publicUrl: null,
        message:
          "cloudflared was not found. Install it from Cloudflare or set the tunnel binary path in settings.",
      });
    }

    let pathname: string;
    let args: readonly string[];
    try {
      pathname = new URL(config.localUrl).pathname;
      args = buildCloudflaredArgs({ localUrl: config.localUrl });
    } catch {
      return this.applyStatus({
        state: "error",
        publicUrl: null,
        message: "The local connector URL is not a valid URL.",
      });
    }

    return this.launch({
      mode: "cloudflared",
      binary,
      args,
      env: process.env,
      localPathname: pathname,
      startingMessage: CLOUDFLARED_STARTING_MESSAGE,
    });
  }

  private startOpenAi(config: ChatGptTunnelConfig): ChatGptTunnelStatus {
    const tunnelId = config.openAiTunnelId?.trim() ?? "";
    if (!OPENAI_TUNNEL_ID_PATTERN.test(tunnelId)) {
      return this.applyStatus({
        state: "error",
        publicUrl: null,
        message: INVALID_TUNNEL_ID_MESSAGE,
      });
    }

    const apiKey = config.openAiTunnelApiKey?.trim() ?? "";
    if (!apiKey) {
      return this.applyStatus({
        state: "error",
        publicUrl: null,
        message: MISSING_OPENAI_KEY_MESSAGE,
      });
    }

    const binary = this.resolveBinary(OPENAI_TUNNEL_BINARY, config.binaryPath);
    if (!binary) {
      return this.applyStatus({
        state: "error",
        publicUrl: null,
        message:
          "tunnel-client was not found. Install it from OpenAI or set the tunnel binary path in settings.",
      });
    }

    const args = [
      "run",
      "--control-plane.tunnel-id",
      tunnelId,
      "--health.listen-addr",
      "127.0.0.1:0",
      "--log.format",
      "json",
      "--log.level",
      "info",
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...buildOpenAiTunnelEnv({ localUrl: config.localUrl, apiKey }),
    };

    return this.launch({
      mode: "openai",
      binary,
      args,
      env,
      localPathname: "/",
      startingMessage: OPENAI_STARTING_MESSAGE,
    });
  }

  private launch(input: {
    readonly mode: TunnelRunMode;
    readonly binary: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly localPathname: string;
    readonly startingMessage: string;
  }): ChatGptTunnelStatus {
    let child: ChatGptTunnelChild;
    try {
      child = this.spawnChild(input.binary, input.args, { env: input.env });
    } catch (error) {
      return this.applyStatus({
        state: "error",
        publicUrl: null,
        message:
          error instanceof Error
            ? `Could not start the tunnel: ${error.message}`
            : "The tunnel process could not be started.",
      });
    }

    const run = new TunnelRun(input.mode, input.localPathname, child, this.hooks);
    this.run = run;
    const status = this.applyStatus({
      state: "starting",
      publicUrl: null,
      message: input.startingMessage,
    });

    run.startTimer =
      input.mode === "cloudflared"
        ? this.schedule(() => this.handleCloudflaredDeadline(run), this.readyTimeoutMs)
        : this.schedule(() => this.handleOpenAiReadyGrace(run), this.readyGraceMs);
    return status;
  }

  private schedule(callback: () => void, delayMs: number): NodeJS.Timeout {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  }

  private handleLine(run: TunnelRun, line: string): void {
    run.retain(line);

    if (run.mode === "cloudflared") {
      if (run.connected || run.timedOut || run.retired) return;
      const publicBase = extractCloudflaredUrl(line);
      if (publicBase === null) return;
      run.connected = true;
      this.clearRunTimer(run);
      this.applyStatus({
        state: "connected",
        publicUrl: `${publicBase}${run.localPathname}`,
        message: CLOUDFLARED_CONNECTED_MESSAGE,
      });
      return;
    }

    if (run.errorLine === null && OPENAI_ERROR_LOG_PATTERN.test(line)) {
      run.errorLine = line;
    }
  }

  private handleCloudflaredDeadline(run: TunnelRun): void {
    run.startTimer = null;
    if (this.run !== run || run.retired || run.exited || run.connected) return;
    run.timedOut = true;
    this.applyStatus({
      state: "error",
      publicUrl: null,
      message: CLOUDFLARED_TIMEOUT_MESSAGE,
    });
  }

  private handleOpenAiReadyGrace(run: TunnelRun): void {
    run.startTimer = null;
    if (this.run !== run || run.retired || run.exited) return;

    const errorLine = findErrorLogLine(run.retainedOutputTail()) ?? run.errorLine;
    if (errorLine !== null) {
      this.applyStatus({
        state: "error",
        publicUrl: null,
        message: boundedText(errorLine, LAST_LINE_LIMIT),
      });
      return;
    }

    this.applyStatus({
      state: "connected",
      publicUrl: null,
      message: OPENAI_CONNECTED_MESSAGE,
    });
  }

  private handleExit(run: TunnelRun, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.run === run) this.run = null;
    this.clearRunTimer(run);

    if (run.mode === "cloudflared") {
      const message =
        run.lastLine !== null
          ? boundedText(run.lastLine, LAST_LINE_LIMIT)
          : `Cloudflare tunnel stopped (${describeExit(code, signal)}).`;
      this.applyStatus({ state: "error", publicUrl: null, message });
      return;
    }

    this.applyStatus({
      state: "error",
      publicUrl: null,
      message: `OpenAI tunnel exited (${describeExit(code, signal)}).`,
    });
  }

  private handleChildError(run: TunnelRun, error: Error): void {
    if (this.run === run) this.run = null;
    this.clearRunTimer(run);
    this.applyStatus({
      state: "error",
      publicUrl: null,
      message:
        run.mode === "cloudflared"
          ? `Could not start cloudflared: ${error.message}`
          : `Could not start the OpenAI tunnel: ${error.message}`,
    });
  }

  private async retireActiveRun(): Promise<void> {
    const run = this.run;
    if (!run) return;
    this.run = null;
    run.retire();
    if (run.exited) return;

    try {
      run.child.kill("SIGTERM");
    } catch {
      // The process is already gone.
    }
    await run.waitForExit(STOP_TIMEOUT_MS);
  }

  private clearRunTimer(run: TunnelRun): void {
    if (!run.startTimer) return;
    clearTimeout(run.startTimer);
    run.startTimer = null;
  }

  private applyStatus(next: {
    readonly state: ChatGptTunnelStatus["state"];
    readonly publicUrl: string | null;
    readonly message: string | null;
  }): ChatGptTunnelStatus {
    this.currentStatus = {
      state: next.state,
      publicUrl: next.publicUrl,
      message: next.message,
      updatedAt: this.now().toISOString(),
    };
    return this.currentStatus;
  }
}
