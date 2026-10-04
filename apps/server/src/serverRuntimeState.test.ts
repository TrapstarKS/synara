import * as NodeServices from "@effect/platform-node/NodeServices";
import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import { ServerConfig } from "./config";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  PersistedServerRuntimeState,
  recoverWindowsServerRuntimeCredential,
} from "./serverRuntimeState";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-runtime-state-",
}).pipe(Layer.provide(NodeServices.layer));
const testLayer = Layer.merge(NodeServices.layer, serverConfigLayer);

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);

describe("serverRuntimeState", () => {
  it("publishes the local companion credential only for a private desktop listener", () => {
    const config = {
      host: "127.0.0.1",
      mode: "desktop" as const,
      authToken: "desktop-secret",
    };
    const make = (overrides = {}) =>
      makePersistedServerRuntimeState({
        config: { ...config, ...overrides },
        port: 4123,
      });
    expect(make().desktopAuthToken).toBe("desktop-secret");
    expect(make({ mode: "web" }).desktopAuthToken).toBeUndefined();
    expect(make({ host: "0.0.0.0" }).desktopAuthToken).toBeUndefined();
    expect(make({ publicUrl: "https://synara.example" }).desktopAuthToken).toBeUndefined();
  });

  it("persists and clears runtime state", async () => {
    const result = await run(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const state = makePersistedServerRuntimeState({ config, port: 4123 });
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state,
        });
        const mode = fs.statSync(config.serverRuntimeStatePath).mode & 0o777;
        const persisted = fs.readFileSync(config.serverRuntimeStatePath, "utf8");
        yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
        const cleared = !fs.existsSync(config.serverRuntimeStatePath);
        return { persisted, cleared, mode };
      }),
    );

    const persisted = Schema.decodeUnknownSync(Schema.fromJsonString(PersistedServerRuntimeState))(
      result.persisted,
    );
    expect(persisted.origin).toBe("http://127.0.0.1:4123");
    expect(result.cleared).toBe(true);
    if (process.platform !== "win32") expect(result.mode).toBe(0o600);
  });

  it("recovers a transiently unavailable Windows desktop credential", async () => {
    await run(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const state = makePersistedServerRuntimeState({
          config: {
            host: "127.0.0.1",
            mode: "desktop",
            authToken: "desktop-secret",
          },
          port: 4123,
        });
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state,
        });
        const { desktopAuthToken: _token, ...withoutCredential } = state;
        fs.writeFileSync(config.serverRuntimeStatePath, `${JSON.stringify(withoutCredential)}\n`);
        let checks = 0;
        yield* recoverWindowsServerRuntimeCredential({
          path: config.serverRuntimeStatePath,
          state,
          platform: "win32",
          retryInterval: 1,
          verifyPrivateDirectory: async () => {
            checks += 1;
            if (checks === 1) throw new Error("ACL check timed out");
          },
        });
        expect(JSON.parse(fs.readFileSync(config.serverRuntimeStatePath, "utf8"))).toMatchObject({
          desktopAuthToken: "desktop-secret",
        });
        yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
      }),
    );
  });

  it("does not overwrite another runtime generation", async () => {
    await run(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const state = makePersistedServerRuntimeState({
          config: {
            host: "127.0.0.1",
            mode: "desktop",
            authToken: "desktop-secret",
          },
          port: 4123,
        });
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state,
        });
        const { desktopAuthToken: _token, ...withoutCredential } = state;
        const otherRuntime = {
          ...withoutCredential,
          startedAt: "2099-01-01T00:00:00.000Z",
        };
        fs.writeFileSync(config.serverRuntimeStatePath, `${JSON.stringify(otherRuntime)}\n`);
        yield* recoverWindowsServerRuntimeCredential({
          path: config.serverRuntimeStatePath,
          state,
          platform: "win32",
          retryInterval: 1,
          verifyPrivateDirectory: async () => undefined,
        });
        expect(JSON.parse(fs.readFileSync(config.serverRuntimeStatePath, "utf8"))).toEqual(
          otherRuntime,
        );
        yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
      }),
    );
  });

  it("aborts a pending ACL recovery before shutdown clears the runtime", async () => {
    await run(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const state = makePersistedServerRuntimeState({
          config: {
            host: "127.0.0.1",
            mode: "desktop",
            authToken: "desktop-secret",
          },
          port: 4123,
        });
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state,
        });
        const { desktopAuthToken: _token, ...withoutCredential } = state;
        fs.writeFileSync(config.serverRuntimeStatePath, `${JSON.stringify(withoutCredential)}\n`);
        const scope = yield* Scope.make();
        let started!: () => void;
        const pendingStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        let release!: () => void;
        const releasePending = new Promise<void>((resolve) => {
          release = resolve;
        });
        let observedSignal: AbortSignal | undefined;
        let aborted = false;
        yield* Scope.addFinalizer(
          scope,
          clearPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
            Effect.provide(testLayer),
            Effect.ignore,
          ),
        );
        yield* recoverWindowsServerRuntimeCredential({
          path: config.serverRuntimeStatePath,
          state,
          platform: "win32",
          retryInterval: 0,
          verifyPrivateDirectory: async (signal) => {
            observedSignal = signal;
            started();
            await releasePending;
            aborted = signal?.aborted === true;
          },
        }).pipe(Effect.forkIn(scope));
        yield* Effect.promise(() => pendingStarted);
        const closePromise = Effect.runPromise(Scope.close(scope, Exit.void));
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              if (observedSignal?.aborted) resolve();
              else observedSignal?.addEventListener("abort", () => resolve(), { once: true });
            }),
        );
        expect(observedSignal?.aborted).toBe(true);
        release();
        yield* Effect.promise(() => closePromise);
        expect(aborted).toBe(true);
        expect(fs.existsSync(config.serverRuntimeStatePath)).toBe(false);
      }),
    );
  });

  it("refuses to publish when the runtime directory is swapped during ACL verification", async () => {
    await run(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const state = makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", mode: "desktop", authToken: "desktop-secret" },
          port: 4123,
        });
        yield* persistServerRuntimeState({ path: config.serverRuntimeStatePath, state });
        const { desktopAuthToken: _token, ...withoutCredential } = state;
        fs.writeFileSync(config.serverRuntimeStatePath, `${JSON.stringify(withoutCredential)}\n`);
        let gateStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          gateStarted = resolve;
        });
        let releaseGate!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        let checks = 0;
        const recoveryScope = yield* Scope.make();
        const fiber = yield* recoverWindowsServerRuntimeCredential({
          path: config.serverRuntimeStatePath,
          state,
          platform: "win32",
          retryInterval: 0,
          verifyPrivateDirectory: async () => {
            checks += 1;
            if (checks === 1) {
              gateStarted();
              await gate;
            }
          },
        }).pipe(Effect.forkIn(recoveryScope));
        yield* Effect.promise(() => started);
        const runtimeDirectory = path.dirname(config.serverRuntimeStatePath);
        const sibling = `${runtimeDirectory}-swapped`;
        fs.renameSync(runtimeDirectory, sibling);
        fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
        fs.copyFileSync(
          path.join(sibling, path.basename(config.serverRuntimeStatePath)),
          config.serverRuntimeStatePath,
        );
        releaseGate();
        yield* Fiber.join(fiber);
        yield* Scope.close(recoveryScope, Exit.void);
        const persisted = JSON.parse(fs.readFileSync(config.serverRuntimeStatePath, "utf8"));
        expect(persisted.desktopAuthToken).toBeUndefined();
        fs.rmSync(runtimeDirectory, { recursive: true, force: true });
        fs.renameSync(sibling, runtimeDirectory);
        yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
      }),
    );
  });

  it("retries after an atomic rename failure and publishes on the next attempt", async () => {
    const renameSpy = vi.mocked(fsPromises.rename);
    const originalRename = renameSpy.getMockImplementation();
    try {
      await run(
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const state = makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", mode: "desktop", authToken: "desktop-secret" },
            port: 4123,
          });
          yield* persistServerRuntimeState({ path: config.serverRuntimeStatePath, state });
          const { desktopAuthToken: _token, ...withoutCredential } = state;
          fs.writeFileSync(config.serverRuntimeStatePath, `${JSON.stringify(withoutCredential)}\n`);
          let renameAttempts = 0;
          renameSpy.mockImplementation(async (...args) => {
            renameAttempts += 1;
            if (renameAttempts === 1) {
              const error = new Error("simulated access denial") as NodeJS.ErrnoException;
              error.code = "EACCES";
              throw error;
            }
            if (!originalRename) throw new Error("missing original rename implementation");
            return originalRename(...args);
          });
          yield* recoverWindowsServerRuntimeCredential({
            path: config.serverRuntimeStatePath,
            state,
            platform: "win32",
            retryInterval: 0,
            verifyPrivateDirectory: async () => undefined,
          });
          expect(renameAttempts).toBe(2);
          expect(JSON.parse(fs.readFileSync(config.serverRuntimeStatePath, "utf8"))).toMatchObject({
            desktopAuthToken: "desktop-secret",
          });
          yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
        }),
      );
    } finally {
      renameSpy.mockClear();
      if (originalRename) renameSpy.mockImplementation(originalRename);
    }
  });
});
