import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { assertPrivateWindowsPath } from "./windows.mjs";

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
  desktopHome = resolve(process.env.SYNARA_MOBILE_DESKTOP_HOME || join(homedir(), ".synara")),
  exec = run,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") return discoverRuntimeUpstream({ desktopHome });
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

export async function discoverRuntimeUpstream({
  desktopHome = resolve(process.env.SYNARA_MOBILE_DESKTOP_HOME || join(homedir(), ".synara")),
  fetchImpl = fetch,
} = {}) {
  const candidates = ["userdata", "dev"].flatMap((kind) => {
    const path = join(desktopHome, kind, "server-runtime.json");
    if (!existsSync(path)) return [];
    for (const entry of [dirname(path), path]) {
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink() || !(entry === path ? stat.isFile() : stat.isDirectory()))
        throw new Error("Unsafe Synara runtime path");
      if (process.platform === "win32") assertPrivateWindowsPath(entry);
      else if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
        throw new Error("Synara runtime must be private to the current user");
    }
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state.version !== 1 || !Number.isSafeInteger(state.pid) || state.pid <= 0 ||
        !Number.isInteger(state.port) || state.port < 1024 || state.port > 65535 ||
        typeof state.externalMcpRuntimeSecret !== "string" || state.externalMcpRuntimeSecret.length < 32)
      throw new Error("Invalid Synara runtime state");
    if (!/^[a-f0-9]{48}$/i.test(state.desktopAuthToken ?? "")) return [];
    try { process.kill(state.pid, 0); }
    catch (error) {
      if (error.code === "ESRCH") return [];
      if (error.code !== "EPERM") throw error;
    }
    return [state];
  });
  if (!candidates.length) throw new Error("Open an updated Synara desktop to enable mobile access");
  if (candidates.length > 1) throw new Error("Multiple Synara desktops found; use a separate desktop home");
  const state = candidates[0];
  const target = fixedTarget(state.origin, state.desktopAuthToken);
  if (Number(new URL(target.origin).port) !== state.port) throw new Error("Invalid runtime port");
  // A recycled PID or port must not receive the desktop credential.
  const nonce = randomBytes(24).toString("base64url");
  const response = await fetchImpl(new URL("/api/mcp/external/runtime-challenge", target.origin), {
    method: "POST", headers: { "x-synara-runtime-challenge": nonce },
    signal: AbortSignal.timeout(2000), redirect: "error",
  });
  const body = await response.json();
  const expected = createHmac("sha256", state.externalMcpRuntimeSecret)
    .update("synara.external-mcp.runtime\0").update(nonce).digest("base64url");
  if (!response.ok || typeof body.proof !== "string" || body.proof.length !== expected.length ||
      !timingSafeEqual(Buffer.from(body.proof), Buffer.from(expected)))
    throw new Error("Cannot verify the running Synara instance");
  return { ...target, scope: `desktop:${resolve(desktopHome)}` };
}

function fixedTarget(origin, token) {
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
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
      // Keep sync macOS callers compatible while invalidating failed async discovery.
      if (cached?.then) cached = cached.catch((error) => { expiresAt = 0; throw error; });
      expiresAt = now() + cacheMs;
      return cached;
    },
    invalidate() {
      if (!fixed) expiresAt = 0;
    },
  };
}
