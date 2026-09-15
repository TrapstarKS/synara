import { execFileSync } from "node:child_process";
import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const LOCK_VERSION = 1;
const PROCESS_INSPECTION_TIMEOUT_MS = 2_000;

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Reads both the current JSON lock format and the numeric PID written by older
 * companions. Keeping the legacy format readable lets a forced shutdown repair
 * an old lock on the first start after an upgrade.
 */
export function parseLockOwner(value) {
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const pid = Number(raw);
    return validPid(pid) ? { pid } : null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !validPid(parsed.pid)) return null;

  return {
    pid: parsed.pid,
    ...(typeof parsed.entryPath === "string" && parsed.entryPath.length > 0
      ? { entryPath: parsed.entryPath }
      : {}),
    ...(typeof parsed.token === "string" && parsed.token.length > 0
      ? { token: parsed.token }
      : {}),
  };
}

function inspectProcessCommand(pid, platform) {
  if (platform === "win32") {
    return execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${String(pid)}').CommandLine`,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: PROCESS_INSPECTION_TIMEOUT_MS,
      },
    ).trim();
  }

  return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_INSPECTION_TIMEOUT_MS,
  }).trim();
}

/**
 * A PID is not an identity: after a forced shutdown the operating system can
 * reuse it for an unrelated process. Confirm the command line before treating
 * an existing lock as live. Inspection failures fail closed so two companions
 * are never started accidentally.
 */
export function isLockOwnerAlive(
  owner,
  {
    entryPath,
    platform = process.platform,
    kill = process.kill,
    getProcessCommand = (pid) => inspectProcessCommand(pid, platform),
  } = {},
) {
  if (!owner || !validPid(owner.pid)) return false;

  try {
    kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the process exists but cannot be inspected by this user.
    // Treat all other errors conservatively as live as well.
    return true;
  }

  let command;
  try {
    command = getProcessCommand(owner.pid);
  } catch {
    return true;
  }
  if (!command) return true;

  const candidates = [entryPath, owner.entryPath]
    .filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => resolve(value));
  return candidates.length === 0 || candidates.some((candidate) => command.includes(candidate));
}

function sameOwner(left, right) {
  return left?.pid === right?.pid && left?.token === right?.token;
}

/**
 * Acquires a crash-tolerant process lock. A stale lock is reclaimed only when
 * its PID is gone or belongs to a different command; a live companion lock is
 * never removed. The ownership token also prevents an old process from
 * deleting a replacement lock during its exit handler.
 */
export function acquireProcessLock(
  lockPath,
  {
    entryPath,
    pid = process.pid,
    platform = process.platform,
    kill = process.kill,
    getProcessCommand = (ownerPid) => inspectProcessCommand(ownerPid, platform),
    maxAttempts = 16,
  } = {},
) {
  if (typeof entryPath !== "string" || entryPath.length === 0)
    throw new Error("A process entry path is required for the mobile lock");
  if (!validPid(pid)) throw new Error("A valid process PID is required for the mobile lock");

  const owner = {
    version: LOCK_VERSION,
    pid,
    entryPath: resolve(entryPath),
    token: randomUUID(),
  };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(owner));
      } finally {
        closeSync(fd);
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const current = parseLockOwner(readFileSync(lockPath, "utf8"));
          if (sameOwner(current, owner)) unlinkSync(lockPath);
        } catch {}
      };
      return { owner, release };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      let existing;
      try {
        existing = parseLockOwner(readFileSync(lockPath, "utf8"));
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }

      if (
        isLockOwnerAlive(existing, {
          entryPath,
          platform,
          kill,
          getProcessCommand,
        })
      ) {
        throw new Error(`Mobile service already running (PID ${existing.pid})`);
      }

      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }

  throw new Error("Could not acquire the mobile service lock after concurrent retries");
}
