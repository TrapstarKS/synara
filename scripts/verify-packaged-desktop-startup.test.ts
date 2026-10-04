import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPackagedDesktopSmokeEnvironment,
  hasPackagedDesktopStartupProof,
  PACKAGED_DESKTOP_SMOKE_FIXTURE_PREFIX,
  parsePackagedDesktopStartupArgs,
  readPackagedStartupLogTails,
  readPackagedStartupDiagnostics,
  resolveNativePackagedDesktopPlatform,
  verifyPackagedRuntimeDependencies,
} from "./verify-packaged-desktop-startup.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("packaged desktop startup verification", () => {
  it.skipIf(process.platform === "win32")(
    "keeps the packaged smoke admin socket within the macOS Unix socket path budget",
    () => {
      const root = mkdtempSync(join(tmpdir(), PACKAGED_DESKTOP_SMOKE_FIXTURE_PREFIX));
      temporaryRoots.push(root);
      const adminSocket = join(root, "state", "synara-mobile", "admin.sock");
      expect(Buffer.byteLength(adminSocket)).toBeLessThan(104);
    },
  );

  it("preserves bounded startup failure details before the isolated tree is removed", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-startup-diagnostics-"));
    temporaryRoots.push(root);
    writeFileSync(
      join(root, "desktop-main.log"),
      `old-prefix${"x".repeat(20_000)}bootstrap failed`,
    );
    writeFileSync(join(root, "server-child.log"), "Error: packaged backend could not start");
    const diagnostics = readPackagedStartupDiagnostics(root);
    expect(diagnostics).toContain("bootstrap failed");
    expect(diagnostics).toContain("Error: packaged backend could not start");
    expect(diagnostics).not.toContain("old-prefix");
    expect(diagnostics.length).toBeLessThan(17_000);
  });

  it("retains bounded failure diagnostics even when a startup log is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-startup-diagnostics-test-"));
    temporaryRoots.push(root);
    writeFileSync(join(root, "desktop-main.log"), "old entry" + "x".repeat(20_000) + "app ready");

    const diagnostics = readPackagedStartupLogTails(root);
    expect(diagnostics).toContain("app ready");
    expect(diagnostics).not.toContain("old entry");
    expect(diagnostics).toContain("server-child.log: unavailable");
    expect(diagnostics.length).toBeLessThan(16_500);
  });

  it("parses a bounded native payload request", () => {
    expect(
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
      ]),
    ).toEqual({
      assetsDirectory: expect.stringMatching(/release-publish$/),
      platform: "linux",
      arch: "x64",
      version: "1.2.3",
      timeoutMs: 60_000,
      executableName: "synara",
    });

    expect(
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
        "--executable-name",
        "synara-beta",
      ]),
    ).toMatchObject({ executableName: "synara-beta" });

    for (const bad of ["../outside", "a/b", "..", "synara\\beta"]) {
      expect(() =>
        parsePackagedDesktopStartupArgs([
          "--assets-dir",
          "./release-publish",
          "--platform",
          "linux",
          "--arch",
          "x64",
          "--version",
          "1.2.3",
          "--executable-name",
          bad,
        ]),
      ).toThrow("Invalid packaged startup executable name");
    }

    expect(() =>
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
        "--timeout-ms",
        "4999",
      ]),
    ).toThrow("--timeout-ms must be an integer between 5000 and 180000");
  });

  it("isolates user state and removes inherited runtime authority", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-packaged-smoke-env-test-"));
    temporaryRoots.push(root);

    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "linux", version: "1.2.3", executableName: "synara-beta" },
      {
        PATH: process.env.PATH,
        SYNARA_AUTH_TOKEN: "must-not-leak",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--import=outside-loader.mjs",
        NODE_PATH: "/outside/node_modules",
        SYNARA_MOBILE_UPSTREAM: "http://127.0.0.1:58000",
        SYNARA_MOBILE_UPSTREAM_TOKEN: "production-credential",
        SYNARA_MOBILE_ORIGIN: "https://production.tail.ts.net:8443",
        SYNARA_MOBILE_HOME: "/outside/mobile",
        SYNARA_MOBILE_DESKTOP_HOME: "/outside/desktop",
        SYNARA_MOBILE_PORT: "58091",
        SYNARA_MOBILE_PARENT_STDIN: "1",
        synara_mobile_upstream_token: "lowercase-production-credential",
        synara_auth_token: "lowercase-desktop-credential",
      },
    );

    expect(env.SYNARA_AUTH_TOKEN).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.SYNARA_MOBILE_UPSTREAM).toBeUndefined();
    expect(env.SYNARA_MOBILE_UPSTREAM_TOKEN).toBeUndefined();
    expect(env.SYNARA_MOBILE_PARENT_STDIN).toBeUndefined();
    expect(env.synara_mobile_upstream_token).toBeUndefined();
    expect(env.synara_auth_token).toBeUndefined();
    expect(env.SYNARA_MOBILE_PORT).toBeUndefined();
    expect(env.SYNARA_MOBILE_ORIGIN).toBe("https://mobile.test:8443");
    expect(env.SYNARA_MOBILE_DESKTOP_HOME).toBe(env.SYNARA_BETA_HOME);
    for (const name of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "SYNARA_HOME",
      "SYNARA_BETA_HOME",
      "SYNARA_MOBILE_HOME",
    ] as const) {
      expect(env[name]?.startsWith(root)).toBe(true);
      expect(existsSync(env[name]!)).toBe(true);
    }
    expect(env.SYNARA_BETA_HOME).not.toBe(env.SYNARA_HOME);
  });

  it("points Stable companion discovery only to its isolated Stable home", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-packaged-stable-env-test-"));
    temporaryRoots.push(root);
    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "linux", version: "1.2.3", executableName: "synara" },
      {},
    );
    expect(env.SYNARA_MOBILE_DESKTOP_HOME).toBe(env.SYNARA_HOME);
    expect(env.SYNARA_MOBILE_HOME).toBe(join(root, "synara-mobile"));
  });

  it("requires a responsive companion as well as the backend and window startup proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-packaged-companion-test-"));
    temporaryRoots.push(root);
    const logPath = join(root, "desktop-main.log");
    const desktopProof =
      "app ready\nbootstrap main window created\nbootstrap backend ready source=health\n";
    writeFileSync(logPath, desktopProof);
    let status = 503;
    let body = '{"paired":false}';
    const companion = createServer((req, res) => {
      expect(req.url).toBe("/mobile/api/status");
      expect(req.method).toBe("GET");
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
    companion.listen(0, "127.0.0.1");
    await once(companion, "listening");
    try {
      const address = companion.address();
      if (!address || typeof address === "string") throw new Error("Missing companion port");
      const probe = () =>
        hasPackagedDesktopStartupProof(logPath, address.port, AbortSignal.timeout(2000));
      expect(await probe()).toBe(false);
      status = 200;
      body = '{"paired":"false"}';
      expect(await probe()).toBe(false);
      body = '{"paired":false}';
      expect(await probe()).toBe(true);
      writeFileSync(logPath, "app ready\n");
      expect(await probe()).toBe(false);
      writeFileSync(logPath, desktopProof);
      companion.closeAllConnections();
      await new Promise<void>((resolveClose) => companion.close(() => resolveClose()));
      expect(await probe()).toBe(false);
    } finally {
      companion.closeAllConnections();
      if (companion.listening) {
        await new Promise<void>((resolveClose) => companion.close(() => resolveClose()));
      }
    }
  });

  it("rejects a missing packaged peer even when the development tree provides it", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-runtime-deps-test-"));
    temporaryRoots.push(root);
    const app = join(root, "app.asar");
    const dist = join(app, "apps/server/dist");
    const sdk = join(app, "node_modules/@agentclientprotocol/sdk");
    const developmentModules = join(root, "development/node_modules");
    const writeZod = (modules: string) => {
      const directory = join(modules, "zod");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), '{"type":"module","exports":"./index.js"}');
      writeFileSync(join(directory, "index.js"), 'export const version = "test";');
    };
    mkdirSync(dist, { recursive: true });
    mkdirSync(sdk, { recursive: true });
    writeFileSync(
      join(dist, "runtimeDependencySmoke.mjs"),
      'await import("@agentclientprotocol/sdk");',
    );
    writeFileSync(join(sdk, "package.json"), '{"type":"module","exports":"./index.js"}');
    writeFileSync(join(sdk, "index.js"), 'export { version } from "zod";');
    writeZod(developmentModules);

    const runtime = { executable: process.execPath, resourcesDirectory: root };
    const env = {
      ...process.env,
      NODE_PATH: developmentModules,
      NODE_OPTIONS: "--invalid-development-node-option",
    };
    expect(() => verifyPackagedRuntimeDependencies(runtime, env, 5_000)).toThrow(
      /Cannot find package 'zod'/,
    );

    writeZod(join(app, "node_modules"));
    expect(() => verifyPackagedRuntimeDependencies(runtime, env, 5_000)).not.toThrow();
  });

  it("bounds a runtime import that never finishes", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-runtime-timeout-test-"));
    temporaryRoots.push(root);
    const dist = join(root, "app.asar/apps/server/dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "runtimeDependencySmoke.mjs"), "setInterval(() => {}, 1000);");

    expect(() =>
      verifyPackagedRuntimeDependencies(
        { executable: process.execPath, resourcesDirectory: root },
        process.env,
        200,
      ),
    ).toThrow(/ETIMEDOUT/);
  });
});
