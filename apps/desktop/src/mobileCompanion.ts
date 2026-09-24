import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";

// A run shorter than this is a startup refusal (for example another companion
// already holds ~/.synara-mobile/server.lock); retrying it would only spin.
const MIN_HEALTHY_RUN_MS = 60_000;
const RESTART_DELAY_MS = 30_000;

export interface MobileCompanionOptions {
  readonly entry: string;
  readonly log: (message: string) => void;
}

/**
 * Runs the bundled phone companion for as long as the desktop app lives. It
 * discovers this backend itself, so backend restarts on a new port are followed.
 */
export function startMobileCompanion(options: MobileCompanionOptions): () => void {
  let child: ChildProcess.ChildProcess | null = null;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const spawn = () => {
    if (stopped || !FS.existsSync(options.entry)) return;
    const startedAt = Date.now();
    const current = ChildProcess.spawn(process.execPath, [options.entry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        SYNARA_MOBILE_PARENT_STDIN: "1",
      },
      // Stdin stays open: EOF stops the companion if this process dies.
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    child = current;
    current.stderr?.setEncoding("utf8");
    current.stderr?.on("data", (chunk: string) => options.log(`mobile companion: ${chunk.trim()}`));
    current.on("error", (error) => options.log(`mobile companion failed: ${error.message}`));
    current.on("exit", (code, signal) => {
      if (child === current) child = null;
      options.log(`mobile companion exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (!stopped && Date.now() - startedAt >= MIN_HEALTHY_RUN_MS) {
        timer = setTimeout(spawn, RESTART_DELAY_MS);
      }
    });
  };

  spawn();
  return () => {
    stopped = true;
    clearTimeout(timer);
    child?.kill();
    child = null;
  };
}
