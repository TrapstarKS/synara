import { ChildProcess, type ExecFileException } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as processRuntime from "@synara/shared/processRuntime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCodexOverlayIdle } from "./codexOverlayActivity";

function exitError(
  code: string | number,
  extra: Partial<ExecFileException> = {},
): ExecFileException {
  return Object.assign(new Error("lsof fixture"), { code, ...extra });
}

describe("Codex overlay activity probe", () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const home = path.join(os.tmpdir(), "isolated-codex-overlay");

  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", platformDescriptor);
  });

  function respond(error: ExecFileException | null, stdout = "", stderr = "") {
    return vi
      .spyOn(processRuntime, "execProcessFile")
      .mockImplementation((_command, _args, _options, callback) => {
        callback(error, stdout, stderr);
        return new ChildProcess();
      });
  }

  it("proves idle only for a silent no-match exit and bounds the whole-home probe", async () => {
    const exec = respond(exitError(1));
    const controller = new AbortController();

    await expect(isCodexOverlayIdle(home, controller.signal)).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith(
      "lsof",
      ["-nP", "-F", "n", "+D", home],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        signal: controller.signal,
      },
      expect.any(Function),
    );
  });

  it.each([
    ["a database", `p42\nn${home}/state_5.sqlite\n`],
    ["the index", `p42\nn${home}/session_index.jsonl\n`],
    ["configuration", `p42\nn${home}/config.toml\n`],
    ["a working directory", `p42\nn${home}\n`],
    ["an unexpected record", "unexpected output\n"],
    ["whitespace", "\n"],
  ])("preserves the entire home when stdout reports %s", async (_name, stdout) => {
    respond(null, stdout);

    await expect(isCodexOverlayIdle(home)).resolves.toBe(false);
  });

  it.each([
    ["empty success", null, "", ""],
    ["warnings", exitError(1), "", "lsof: cannot inspect a directory\n"],
    ["stderr whitespace", exitError(1), "", "\n"],
    ["missing lsof", exitError("ENOENT"), "", ""],
    ["cancellation", exitError("ABORT_ERR"), "", ""],
    ["unexpected failure", exitError(2), "", ""],
    ["string exit code", exitError("1"), "", ""],
    ["timeout", exitError(1, { killed: true, signal: "SIGTERM" }), "", ""],
    ["output overflow", exitError("ERR_CHILD_PROCESS_STDIO_MAXBUFFER"), "partial", ""],
    ["a partial no-match result", exitError(1), "p42\n", ""],
  ])("preserves the home after %s", async (_name, error, stdout, stderr) => {
    respond(error, stdout, stderr);

    await expect(isCodexOverlayIdle(home)).resolves.toBe(false);
  });

  it("preserves the home when executable resolution throws", async () => {
    vi.spyOn(processRuntime, "execProcessFile").mockImplementation(() => {
      throw new Error("lsof unavailable");
    });

    await expect(isCodexOverlayIdle(home)).resolves.toBe(false);
  });

  it.each(["win32", "freebsd"])("does not probe unsupported platform %s", async (platform) => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
    const exec = respond(exitError(1));

    await expect(isCodexOverlayIdle(home)).resolves.toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not spawn after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = respond(exitError(1));

    await expect(isCodexOverlayIdle(home, controller.signal)).resolves.toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not certify idle when cancellation races a no-match result", async () => {
    const controller = new AbortController();
    vi.spyOn(processRuntime, "execProcessFile").mockImplementation(
      (_command, _args, options, callback) => {
        expect(options.signal).toBe(controller.signal);
        controller.abort();
        callback(exitError(1), "", "");
        return new ChildProcess();
      },
    );

    await expect(isCodexOverlayIdle(home, controller.signal)).resolves.toBe(false);
  });
});

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "detects a live database handle outside the session artifact directories",
  async ({ skip }) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synara-overlay-activity-"));
    try {
      if (!(await isCodexOverlayIdle(home))) {
        skip("lsof cannot establish idle on this host");
        return;
      }
      const database = await fs.open(path.join(home, "state_5.sqlite"), "w");
      try {
        await expect(isCodexOverlayIdle(home)).resolves.toBe(false);
      } finally {
        await database.close();
      }
      await expect(isCodexOverlayIdle(home)).resolves.toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  },
);
