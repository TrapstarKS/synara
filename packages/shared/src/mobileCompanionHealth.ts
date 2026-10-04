import * as Http from "node:http";

const HEALTH_TIMEOUT_MS = 5_000;
const MAX_HEALTH_RESPONSE_BYTES = 1024;

// This endpoint is public and independent of backend discovery, pairing and
// provider readiness. A local login service may legitimately own the listener.
export function probeMobileCompanion(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let request: Http.ClientRequest | undefined;
    let response: Http.IncomingMessage | undefined;
    let completed = false;
    const finish = (healthy: boolean) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      response?.destroy();
      request?.destroy();
      resolve(healthy);
    };
    const abort = () => finish(false);
    const timeout = setTimeout(abort, HEALTH_TIMEOUT_MS);
    timeout.unref();
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    try {
      request = Http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mobile/api/status",
          method: "GET",
          agent: false,
        },
        (incoming) => {
          response = incoming;
          incoming.once("error", abort);
          incoming.once("close", abort);
          if (completed || incoming.statusCode !== 200) {
            incoming.destroy();
            abort();
            return;
          }
          let bytes = 0;
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => {
            if (completed) return;
            bytes += chunk.length;
            if (bytes > MAX_HEALTH_RESPONSE_BYTES) abort();
            else chunks.push(chunk);
          });
          incoming.once("end", () => {
            if (completed) return;
            try {
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              finish(
                typeof value === "object" &&
                  value !== null &&
                  "paired" in value &&
                  typeof value.paired === "boolean",
              );
            } catch {
              abort();
            }
          });
        },
      );
      request.once("error", abort);
      request.end();
    } catch {
      abort();
    }
  });
}
