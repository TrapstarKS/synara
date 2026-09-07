import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_DESKTOP_EXECUTABLE = "/Applications/Synara.app/Contents/MacOS/Synara";
const SERVER_ENTRY_SUFFIX = "/apps/server/dist/index.mjs";

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2_000,
  });
}

export function parseProcessTable(output, desktopExecutable) {
  const rows = new Map();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*([1-9]\d*)\s+([1-9]\d*|0)\s+(.+)$/);
    if (match)
      rows.set(Number(match[1]), {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      });
  }
  return [...rows.values()].filter((row) => {
    const parent = rows.get(row.ppid);
    return (
      row.command.startsWith(desktopExecutable + " ") &&
      row.command.includes(SERVER_ENTRY_SUFFIX) &&
      parent?.command === desktopExecutable
    );
  });
}

export function parseDesktopEnvironment(output, expectedHome) {
  const field = (name, pattern) =>
    output.match(new RegExp(`(?:^|\\s)${name}=(${pattern})(?=\\s|$)`))?.[1];
  const port = Number(field("SYNARA_PORT", "[0-9]{1,5}"));
  const token = field("SYNARA_AUTH_TOKEN", "[0-9a-fA-F]{48}");
  const mode = field("SYNARA_MODE", "[^\\s]+") ?? "";
  const home = field("SYNARA_HOME", "[^\\s]+") ?? "";
  if (
    !Number.isInteger(port) ||
    port < 1_024 ||
    port > 65_535 ||
    !token ||
    mode !== "desktop" ||
    resolve(home) !== resolve(expectedHome)
  )
    return null;
  return { port, token };
}

export function discoverDesktopUpstream({
  desktopExecutable = DEFAULT_DESKTOP_EXECUTABLE,
  desktopHome = resolve(homedir(), ".synara"),
  exec = run,
} = {}) {
  let rows;
  try {
    rows = parseProcessTable(exec("/bin/ps", ["-axo", "pid=,ppid=,command="]), desktopExecutable);
  } catch {
    throw new Error("Cannot inspect the local Synara desktop process");
  }
  for (const row of rows) {
    try {
      const environment = parseDesktopEnvironment(
        exec("/bin/ps", ["eww", "-p", String(row.pid), "-o", "command="]),
        desktopHome,
      );
      if (!environment) continue;
      const listener = exec("/usr/sbin/lsof", [
        "-nP",
        "-a",
        "-p",
        String(row.pid),
        `-iTCP:${environment.port}`,
        "-sTCP:LISTEN",
        "-t",
      ]).trim();
      if (listener !== String(row.pid)) continue;
      return {
        origin: `http://127.0.0.1:${environment.port}`,
        token: environment.token,
        scope: `desktop:${resolve(desktopHome)}`,
      };
    } catch {}
  }
  throw new Error("Synara.app is not running");
}

function fixedTarget(origin, token) {
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("SYNARA_MOBILE_UPSTREAM must be a loopback HTTP origin");
  return { origin: url.origin, token: token || undefined, scope: url.origin };
}

export function createUpstreamResolver({
  upstream,
  token,
  discover = discoverDesktopUpstream,
  cacheMs = 2_000,
  now = Date.now,
} = {}) {
  const fixed = upstream ? fixedTarget(upstream, token) : null;
  let cached,
    expiresAt = 0;
  return {
    resolve({ fresh = false } = {}) {
      if (fixed) return fixed;
      if (!fresh && cached && now() < expiresAt) return cached;
      cached = discover();
      expiresAt = now() + cacheMs;
      return cached;
    },
    invalidate() {
      if (!fixed) expiresAt = 0;
    },
  };
}
