import { Effect, FileSystem, Schema } from "effect";
import { dirname } from "node:path";

import { writeFileStringAtomically } from "./atomicWrite";
import type { ServerConfigShape } from "./config";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "./startupAccess";
import { externalMcpRuntimeSecret } from "./externalMcp/runtimeProof.ts";
import { assertPrivateWindowsRuntimePath } from "./externalMcp/bridge.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  startedAt: Schema.String,
  externalMcpRuntimeSecret: Schema.String,
  desktopAuthToken: Schema.optional(Schema.String),
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

const runtimeOriginForConfig = (
  config: Pick<ServerConfigShape, "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<ServerConfigShape, "host"> &
    Partial<Pick<ServerConfigShape, "mode" | "authToken" | "publicUrl">>;
  readonly port: number;
}): PersistedServerRuntimeState => ({
  version: 1,
  pid: process.pid,
  ...(input.config.host ? { host: input.config.host } : {}),
  port: input.port,
  origin: runtimeOriginForConfig(input.config, input.port),
  startedAt: new Date().toISOString(),
  externalMcpRuntimeSecret,
  // The private runtime file lets local companions follow desktop restarts on Windows.
  ...(input.config.mode === "desktop" &&
  isLoopbackHost(input.config.host) &&
  !input.config.publicUrl &&
  input.config.authToken
    ? { desktopAuthToken: input.config.authToken }
    : {}),
});

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  Effect.gen(function* () {
    let state = input.state;
    if (process.platform === "win32" && state.desktopAuthToken) {
      // New files inherit their directory's DACL. Never publish a desktop credential
      // under a shared Windows home; keep ordinary desktop startup available there.
      const privateDirectory = yield* Effect.try(() =>
        assertPrivateWindowsRuntimePath(dirname(input.path), "directory"),
      ).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      if (!privateDirectory) {
        const { desktopAuthToken: _token, ...withoutCredential } = state;
        state = withoutCredential;
        yield* Effect.logWarning("Mobile discovery disabled: Windows runtime directory ACL is not private.");
      }
    }
    yield* writeFileStringAtomically({
      filePath: input.path,
      contents: `${JSON.stringify(state)}\n`,
    });
  });

export const clearPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path, { force: true }).pipe(Effect.ignore({ log: true }));
  });
