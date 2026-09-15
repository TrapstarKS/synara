import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProcessLock, isLockOwnerAlive, parseLockOwner } from "./process-lock.mjs";

test("does not mistake a live unrelated process for the mobile companion", () => {
  const inspect = {
    entryPath: "/repo/extensions/mobile-remote/server.mjs",
    kill: () => {},
    getProcessCommand: () => "/System/Library/PrivateFrameworks/IMCore.framework/imagent",
  };
  assert.equal(isLockOwnerAlive({ pid: 762 }, inspect), false);
  assert.equal(
    isLockOwnerAlive(
      { pid: 762 },
      {
        ...inspect,
        getProcessCommand: () => "/usr/local/bin/node /repo/extensions/mobile-remote/server.mjs",
      },
    ),
    true,
  );
});

test("reclaims a legacy numeric lock and release cannot remove a replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synara-process-lock-test-"));
  const lockPath = join(directory, "server.lock");
  const options = {
    entryPath: "/repo/extensions/mobile-remote/server.mjs",
    pid: 4321,
    kill: () => {},
    getProcessCommand: () => "/usr/bin/imagent",
  };

  try {
    await writeFile(lockPath, "762");
    const acquired = acquireProcessLock(lockPath, options);
    const owner = parseLockOwner(await readFile(lockPath, "utf8"));
    assert.equal(owner.pid, 4321);
    assert.equal(owner.entryPath, options.entryPath);

    await writeFile(
      lockPath,
      JSON.stringify({ version: 1, pid: 9999, entryPath: options.entryPath, token: "replacement" }),
    );
    acquired.release();
    assert.match(await readFile(lockPath, "utf8"), /replacement/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps a lock held by the mobile companion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synara-process-lock-test-"));
  const lockPath = join(directory, "server.lock");
  const options = {
    entryPath: "/repo/extensions/mobile-remote/server.mjs",
    pid: 4321,
    kill: () => {},
    getProcessCommand: () => "/usr/local/bin/node /repo/extensions/mobile-remote/server.mjs",
  };

  try {
    const first = acquireProcessLock(lockPath, options);
    assert.throws(
      () => acquireProcessLock(lockPath, { ...options, pid: 9876 }),
      /already running \(PID 4321\)/,
    );
    first.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
