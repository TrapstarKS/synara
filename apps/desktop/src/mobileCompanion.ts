import type { ChildProcess } from "node:child_process";
import * as FS from "node:fs";
import { probeMobileCompanion } from "@synara/shared/mobileCompanionHealth";
import { spawnProcess } from "@synara/shared/processRuntime";

export { probeMobileCompanion } from "@synara/shared/mobileCompanionHealth";

// Login, updates and wake can temporarily leave Tailscale unavailable or the
// previous companion holding its lock. Back off, but never abandon recovery.
const MIN_HEALTHY_RUN_MS = 60_000;
const INITIAL_RESTART_DELAY_MS = 5_000;
const MAX_RESTART_DELAY_MS = 60_000;
const SHUTDOWN_GRACE_MS = 5_000;
const STARTUP_GRACE_MS = 120_000;
const HEALTH_INTERVAL_MS = 15_000;
const MAX_HEALTH_FAILURES = 3;

export interface MobileCompanionOptions {
  readonly entry: string;
  readonly log: (message: string) => void;
}

/**
 * Runs the bundled phone companion for as long as the desktop app lives. It
 * discovers this backend itself, so backend restarts on a new port are followed.
 */
export function startMobileCompanion(options: MobileCompanionOptions): () => void {
  const port = Number(process.env.SYNARA_MOBILE_PORT ?? 58091);
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | undefined;
  let stopChild: (() => void) | undefined;
  let stopped = false;
  let restartDelay = INITIAL_RESTART_DELAY_MS;

  const scheduleRestart = () => {
    if (stopped || timer) return;
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY_MS);
    options.log(`mobile companion retry in ${delay / 1000}s`);
    timer = setTimeout(() => {
      timer = undefined;
      spawn();
    }, delay);
    timer.unref();
  };

  const spawn = () => {
    if (stopped || !FS.existsSync(options.entry)) return;
    const startedAt = Date.now();
    let current: ChildProcess;
    try {
      current = spawnProcess(process.execPath, [options.entry], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          SYNARA_MOBILE_PARENT_STDIN: "1",
        },
        // Stdin stays open: EOF stops the companion if this process dies.
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (error) {
      options.log(
        `mobile companion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      scheduleRestart();
      return;
    }
    child = current;
    const lifetime = new AbortController();
    let healthTimer: NodeJS.Timeout | undefined;
    let shutdownTimer: NodeJS.Timeout | undefined;
    let shuttingDown = false;
    let ready = false;
    let failures = 0;
    const ownsLiveChild = () =>
      child === current && current.exitCode === null && current.signalCode === null;
    const stopHealth = () => {
      clearTimeout(healthTimer);
      healthTimer = undefined;
      lifetime.abort();
    };
    const shutdown = () => {
      stopHealth();
      if (shuttingDown || !ownsLiveChild()) return;
      shuttingDown = true;
      // Reuse the parent-stdin shutdown path. Never signal a PID discovered from
      // a lock or listener; only this still-owned child can be force-stopped.
      current.stdin?.end();
      shutdownTimer = setTimeout(() => {
        if (ownsLiveChild()) current.kill();
      }, SHUTDOWN_GRACE_MS);
      shutdownTimer.unref();
    };
    stopChild = shutdown;
    const checkHealth = async () => {
      healthTimer = undefined;
      if (stopped || lifetime.signal.aborted || !ownsLiveChild()) return;
      const healthy = await probeMobileCompanion(port, lifetime.signal);
      if (stopped || lifetime.signal.aborted || !ownsLiveChild()) return;
      if (healthy) {
        ready = true;
        failures = 0;
      } else if (ready || Date.now() - startedAt >= STARTUP_GRACE_MS) {
        failures += 1;
        if (failures >= MAX_HEALTH_FAILURES) {
          options.log("mobile companion unresponsive; restarting owned child");
          shutdown();
          return;
        }
      }
      // Schedule after completion so a slow probe never overlaps another one.
      healthTimer = setTimeout(() => void checkHealth(), HEALTH_INTERVAL_MS);
      healthTimer.unref();
    };
    healthTimer = setTimeout(() => void checkHealth(), HEALTH_INTERVAL_MS);
    healthTimer.unref();
    current.stderr?.setEncoding("utf8");
    current.stderr?.on("data", (chunk: string) => options.log(`mobile companion: ${chunk.trim()}`));
    current.on("error", (error) => options.log(`mobile companion failed: ${error.message}`));
    current.once("exit", stopHealth);
    // close also follows a failed spawn, which need not emit exit, and waits
    // for the child's pipes to finish before starting a replacement.
    current.once("close", (code, signal) => {
      stopHealth();
      clearTimeout(shutdownTimer);
      if (child !== current) return;
      child = null;
      stopChild = undefined;
      options.log(`mobile companion exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (Date.now() - startedAt >= MIN_HEALTHY_RUN_MS) {
        restartDelay = INITIAL_RESTART_DELAY_MS;
      }
      scheduleRestart();
    });
  };

  spawn();
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    stopChild?.();
  };
}
