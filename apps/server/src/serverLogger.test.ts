import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Logger } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "./config";
import { ServerLoggerLive } from "./serverLogger";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const tempRoots: string[] = [];

function makeHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synara-server-logger-"));
  tempRoots.push(root);
  return root;
}

function runLogger(home: string, effect: Effect.Effect<void>): Promise<void> {
  const configLayer = ServerConfig.layerTest(process.cwd(), home).pipe(
    Layer.provide(NodeServices.layer),
  );
  return Effect.runPromise(
    effect.pipe(Effect.provide(ServerLoggerLive), Effect.provide(configLayer)),
  );
}

beforeEach(() => {
  vi.spyOn(Logger.defaultLogger, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ServerLoggerLive", () => {
  it("keeps simple formatting, console logging and flushes pending records on close", async () => {
    const home = makeHome();
    await runLogger(
      home,
      Effect.logInfo("server lifecycle message").pipe(
        Effect.annotateLogs({ scope: "server-logger-test" }),
      ),
    );

    const logPath = path.join(home, "userdata", "logs", "server.log");
    const contents = fs.readFileSync(logPath, "utf8");
    expect(contents).toMatch(/^timestamp=\S+ level=Info fiber=#\d+ /);
    expect(contents).toContain('message="\\"server lifecycle message\\""');
    expect(contents).toContain('scope="\\"server-logger-test\\""\n');
    expect(Logger.defaultLogger.log).toHaveBeenCalledTimes(1);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(logPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    }
  });

  it("rotates a full file, retains three backups and leaves other logs untouched", async () => {
    const home = makeHome();
    const logsDir = path.join(home, "userdata", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, "server.log");
    fs.writeFileSync(logPath, Buffer.alloc(MAX_LOG_BYTES, "a"));
    fs.writeFileSync(`${logPath}.1`, "recent");
    fs.writeFileSync(`${logPath}.2`, "older");
    fs.writeFileSync(`${logPath}.3`, "oldest");
    fs.writeFileSync(`${logPath}.4`, "stale");
    fs.writeFileSync(path.join(logsDir, "provider.log"), "provider");
    fs.writeFileSync(`${logPath}.notes`, "notes");

    await runLogger(home, Effect.logInfo("new record"));

    expect(fs.readFileSync(logPath, "utf8")).toContain('message="\\"new record\\""');
    expect(fs.statSync(`${logPath}.1`).size).toBe(MAX_LOG_BYTES);
    expect(fs.readFileSync(`${logPath}.2`, "utf8")).toBe("recent");
    expect(fs.readFileSync(`${logPath}.3`, "utf8")).toBe("older");
    expect(fs.existsSync(`${logPath}.4`)).toBe(false);
    expect(fs.readFileSync(path.join(logsDir, "provider.log"), "utf8")).toBe("provider");
    expect(fs.readFileSync(`${logPath}.notes`, "utf8")).toBe("notes");

    for (const suffix of ["", ".1", ".2", ".3"]) {
      const stat = fs.statSync(`${logPath}${suffix}`);
      expect(stat.size).toBeLessThanOrEqual(MAX_LOG_BYTES);
      if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("bounds new oversized records without dropping their bytes", async () => {
    const home = makeHome();
    const message = `oversized ${"x".repeat(MAX_LOG_BYTES)}`;
    await runLogger(home, Effect.logInfo(message));

    const logPath = path.join(home, "userdata", "logs", "server.log");
    expect(fs.statSync(`${logPath}.1`).size).toBe(MAX_LOG_BYTES);
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
    const contents = fs.readFileSync(`${logPath}.1`, "utf8") + fs.readFileSync(logPath, "utf8");
    expect(contents.includes(`message=${JSON.stringify(JSON.stringify(message))}`)).toBe(true);
    expect(contents.endsWith("\n")).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(`${logPath}.1`).mode & 0o777).toBe(0o600);
      expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves an existing oversized legacy log when it rotates", async () => {
    const home = makeHome();
    const logsDir = path.join(home, "userdata", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, "server.log");
    fs.writeFileSync(logPath, Buffer.alloc(MAX_LOG_BYTES + 1, "a"));

    await runLogger(home, Effect.logInfo("new record"));

    expect(fs.statSync(`${logPath}.1`).size).toBe(MAX_LOG_BYTES + 1);
    expect(fs.readFileSync(logPath, "utf8")).toContain('message="\\"new record\\""');
  });
});
