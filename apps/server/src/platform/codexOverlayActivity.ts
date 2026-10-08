import { execProcessFile } from "@synara/shared/processRuntime";

/** False includes active and unknown homes; only a silent lsof exit 1 proves idle. */
export function isCodexOverlayIdle(home: string, signal?: AbortSignal): Promise<boolean> {
  if ((process.platform !== "darwin" && process.platform !== "linux") || signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      execProcessFile(
        "lsof",
        ["-nP", "-F", "n", "+D", home],
        { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024, signal },
        (error, stdout, stderr) => {
          resolve(
            error?.code === 1 &&
              !error.killed &&
              !error.signal &&
              !signal?.aborted &&
              stdout === "" &&
              stderr === "",
          );
        },
      );
    } catch {
      resolve(false);
    }
  });
}
