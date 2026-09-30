import type { ChildProcess } from "node:child_process";
import * as FS from "node:fs";
import { spawnProcess } from "@synara/shared/processRuntime";

// Login, updates and wake can temporarily leave Tailscale unavailable or the
// previous companion holding its lock. Back off, but never abandon recovery.
const MIN_HEALTHY_RUN_MS = 60_000;
const INITIAL_RESTART_DELAY_MS = 5_000;
const MAX_RESTART_DELAY_MS = 60_000;
const SHUTDOWN_GRACE_MS = 5_000;

export interface MobileCompanionOptions {
  readonly entry: string;
  readonly log: (message: string) => void;
}

/**
 * Runs the bundled phone companion for as long as the desktop app lives. It
 * discovers this backend itself, so backend restarts on a new port are followed.
 */
export function startMobileCompanion(options: MobileCompanionOptions): () => void {
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | undefined;
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
    current.stderr?.setEncoding("utf8");
    current.stderr?.on("data", (chunk: string) => options.log(`mobile companion: ${chunk.trim()}`));
    current.on("error", (error) => options.log(`mobile companion failed: ${error.message}`));
    // close also follows a failed spawn, which need not emit exit, and waits
    // for the child's pipes to finish before starting a replacement.
    current.once("close", (code, signal) => {
      if (child === current) child = null;
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
    const current = child;
    if (!current) return;
    // Let the companion release its lock and listeners before a desktop update
    // starts the replacement. Only this still-owned child may be force-stopped.
    current.stdin?.end();
    const shutdownTimer = setTimeout(() => {
      if (child === current) current.kill();
    }, SHUTDOWN_GRACE_MS);
    shutdownTimer.unref();
    current.once("close", () => clearTimeout(shutdownTimer));
  };
}
