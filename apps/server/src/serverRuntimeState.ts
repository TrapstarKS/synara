import { Duration, Effect, FileSystem, Schema } from "effect";
import fs from "node:fs";
import { dirname } from "node:path";

import { writeFileStringAtomically } from "./atomicWrite";
import type { ServerConfigShape } from "./config";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "./startupAccess";
import { externalMcpRuntimeSecret } from "./externalMcp/runtimeProof.ts";
import {
  assertPrivateWindowsRuntimePathAsync,
  protectWindowsRuntimeDirectoryAsync,
} from "./externalMcp/bridge.ts";

const WINDOWS_RUNTIME_RECOVERY_INTERVAL = Duration.seconds(15);
const runtimeGenerations = new Map<string, string>();

const runtimeGeneration = (state: PersistedServerRuntimeState) =>
  `${state.pid}:${state.startedAt}:${state.externalMcpRuntimeSecret}`;

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
    const generation = runtimeGeneration(input.state);
    runtimeGenerations.set(input.path, generation);
    let state = input.state;
    if (process.platform === "win32" && state.desktopAuthToken) {
      // New files inherit their directory's DACL. Never publish a desktop credential
      // under a shared Windows home; keep ordinary desktop startup available there.
      const directoryPath = dirname(input.path);
      const directoryBefore = yield* Effect.try({
        try: () => fs.lstatSync(directoryPath),
        catch: (cause) => cause,
      }).pipe(Effect.option);
      const privateDirectory = yield* Effect.tryPromise({
        try: (signal) =>
          assertPrivateWindowsRuntimePathAsync(directoryPath, "directory", signal).catch(() =>
            protectWindowsRuntimeDirectoryAsync(directoryPath, signal).then(() =>
              assertPrivateWindowsRuntimePathAsync(directoryPath, "directory", signal),
            ),
          ),
        catch: (cause) => cause,
      }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      const directoryAfter = yield* Effect.try({
        try: () => fs.lstatSync(directoryPath),
        catch: (cause) => cause,
      }).pipe(Effect.option);
      if (
        !privateDirectory ||
        directoryBefore._tag !== "Some" ||
        directoryAfter._tag !== "Some" ||
        !sameRuntimeDirectory(directoryBefore.value, directoryAfter.value)
      ) {
        const { desktopAuthToken: _token, ...withoutCredential } = state;
        state = withoutCredential;
        yield* Effect.logWarning(
          "Mobile discovery disabled: Windows runtime directory ACL is not private.",
        );
      }
    }
    yield* writeFileStringAtomically({
      filePath: input.path,
      contents: `${JSON.stringify(state)}\n`,
    });
    return {
      desktopCredentialPublished: Boolean(state.desktopAuthToken),
    } as const;
  });

const persistedRuntimeIsGeneration = (path: string, generation: string): boolean => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path, "utf8"),
    ) as Partial<PersistedServerRuntimeState>;
    return (
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.externalMcpRuntimeSecret === "string" &&
      runtimeGeneration(parsed as PersistedServerRuntimeState) === generation
    );
  } catch {
    return false;
  }
};

const sameRuntimeDirectory = (before: fs.Stats, after: fs.Stats) =>
  before.dev === after.dev && before.ino === after.ino;

export const recoverWindowsServerRuntimeCredential = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
  readonly platform?: NodeJS.Platform;
  readonly verifyPrivateDirectory?: (signal?: AbortSignal) => Promise<void>;
  readonly retryInterval?: number;
}) =>
  Effect.gen(function* () {
    if ((input.platform ?? process.platform) !== "win32" || !input.state.desktopAuthToken) return;
    const generation = runtimeGeneration(input.state);
    const verifyPrivateDirectory =
      input.verifyPrivateDirectory ??
      ((signal?: AbortSignal) =>
        assertPrivateWindowsRuntimePathAsync(dirname(input.path), "directory", signal));
    while (runtimeGenerations.get(input.path) === generation) {
      yield* Effect.sleep(input.retryInterval ?? WINDOWS_RUNTIME_RECOVERY_INTERVAL);
      let directoryBefore: fs.Stats;
      try {
        directoryBefore = fs.lstatSync(dirname(input.path));
      } catch {
        continue;
      }
      const privateDirectory = yield* Effect.tryPromise({
        try: (signal) => verifyPrivateDirectory(signal),
        catch: (cause) => cause,
      }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      if (!privateDirectory) continue;
      if (
        runtimeGenerations.get(input.path) !== generation ||
        !persistedRuntimeIsGeneration(input.path, generation)
      ) {
        return;
      }
      // Revalidate immediately before the credential-bearing atomic replacement.
      const stillPrivate = yield* Effect.tryPromise({
        try: (signal) => verifyPrivateDirectory(signal),
        catch: (cause) => cause,
      }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      if (!stillPrivate) continue;
      let directoryAfter: fs.Stats;
      try {
        directoryAfter = fs.lstatSync(dirname(input.path));
      } catch {
        continue;
      }
      if (
        !sameRuntimeDirectory(directoryBefore, directoryAfter) ||
        runtimeGenerations.get(input.path) !== generation ||
        !persistedRuntimeIsGeneration(input.path, generation)
      ) {
        return;
      }
      const published = yield* writeFileStringAtomically({
        filePath: input.path,
        contents: `${JSON.stringify(input.state)}\n`,
      }).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: () => true,
        }),
      );
      if (published) return;
    }
  });

export const clearPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    runtimeGenerations.delete(path);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path, { force: true }).pipe(Effect.ignore({ log: true }));
  });
