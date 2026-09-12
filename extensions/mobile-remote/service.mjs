import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseLoadedJob,
  listenerPids,
  verifyServiceOwnership,
  resolveServiceSettings,
} from "./lib/service-config.mjs";

const [command, ...args] = process.argv.slice(2);
if (!["darwin", "win32"].includes(process.platform) ||
    !["install", "uninstall", "status", ...(process.platform === "win32" ? ["run"] : [])].includes(command)) {
  console.error(
    "macOS/Windows usage: node service.mjs install [--origin https://COMPUTER.ts.net:8443] | status | uninstall",
  );
  process.exit(1);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (args[i] !== "--origin" || !args[i + 1]) throw new Error("Unknown or missing option");
  options[args[i]] = args[i + 1];
}
const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, "../..");
if (process.platform === "win32") {
  // The task runs under the logged-in user and follows the already running desktop.
  if (process.env.SYNARA_MOBILE_HOME)
    throw new Error("Windows login service uses %USERPROFILE%\\.synara-mobile; use server.mjs for a custom mobile home");
  const { windowsService } = await import("./lib/windows-service.mjs");
  await windowsService({ command, origin: options["--origin"],
    directory: join(homedir(), ".synara-mobile"), entry: fileURLToPath(import.meta.url), repo });
} else {
const agents = join(homedir(), "Library/LaunchAgents");
const domain = `gui/${process.getuid()}`;
const legacyBackend = {
  label: "com.synara.mobile.backend",
  port: 58090,
  file: join(repo, "apps/server/dist/index.mjs"),
};
const companion = {
  label: "com.synara.mobile.companion",
  port: 58091,
  file: join(root, "server.mjs"),
};
const run = (args) => spawnSync("/bin/launchctl", args, { encoding: "utf8" });
const pause = (milliseconds) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
if (command === "status") {
  const result = run(["print", `${domain}/${companion.label}`]);
  const state = result.stdout?.match(/state = (.+)/)?.[1] ?? "not loaded";
  const pid = result.stdout?.match(/pid = (\d+)/)?.[1];
  console.log(`${companion.label}: ${state}${pid ? ` (PID ${pid})` : ""}`);
  process.exit(0);
}
function inspect(job, { ignorePortWhenAbsent = false } = {}) {
  const path = join(agents, job.label + ".plist");
  let installed = null;
  if (existsSync(path)) {
    const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
      encoding: "utf8",
    });
    if (result.status !== 0 || result.error)
      throw new Error(`Cannot read service configuration: ${path}`);
    installed = JSON.parse(result.stdout);
  }
  const result = run(["print", `${domain}/${job.label}`]);
  let loaded = null;
  if (result.status === 0) loaded = parseLoadedJob(result.stdout);
  else if (result.error || !/Could not find service/.test(result.stderr ?? ""))
    throw new Error(`Cannot inspect loaded job: ${job.label}`);
  const pids =
    ignorePortWhenAbsent && !installed && !loaded
      ? []
      : listenerPids(
          spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${job.port}`, "-sTCP:LISTEN", "-t"], {
            encoding: "utf8",
          }),
        );
  verifyServiceOwnership({ job, path, installed, loaded, pids });
  return { path, installed, loaded };
}
function bootout(job, inspected) {
  if (!inspected.loaded) return;
  const result = run(["bootout", `${domain}/${job.label}`]);
  if (result.status !== 0 || result.error)
    throw new Error(`Could not stop owned service: ${job.label}`);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (run(["print", `${domain}/${job.label}`]).status !== 0) return;
    pause(100);
  }
  throw new Error(`Timed out waiting for service to stop: ${job.label}`);
}
if (command === "uninstall") {
  for (const job of [companion, legacyBackend]) {
    const inspected = inspect(job, { ignorePortWhenAbsent: job === legacyBackend });
    bootout(job, inspected);
    if (inspected.installed) unlinkSync(inspected.path);
  }
  console.log("Services removed. Saved data and Tailscale Serve configuration were preserved.");
  process.exit(0);
}
// A previous version started a second Synara backend with a separate database.
// Verify that old job before changing anything, then remove it during this upgrade.
const existingLegacyBackend = inspect(legacyBackend, { ignorePortWhenAbsent: true });
const existingCompanion = inspect(companion);
const settings = resolveServiceSettings({
  backend: existingLegacyBackend.installed,
  companion: existingCompanion.installed,
  origin: options["--origin"],
  mobileHome: process.env.SYNARA_MOBILE_HOME,
  defaultMobileHome: join(homedir(), ".synara-mobile"),
});
const data = settings.mobileHome;
if (!existsSync(companion.file)) throw new Error(`Missing mobile companion: ${companion.file}`);
mkdirSync(agents, { recursive: true });
mkdirSync(data, { recursive: true, mode: 0o700 });
const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const plist = (value) =>
  Array.isArray(value)
    ? `<array>${value.map(plist).join("")}</array>`
    : typeof value === "object"
      ? `<dict>${Object.entries(value)
          .map(([k, v]) => `<key>${esc(k)}</key>${plist(v)}`)
          .join("")}</dict>`
      : typeof value === "boolean"
        ? `<${value ? "true" : "false"}/>`
        : typeof value === "number"
          ? `<integer>${value}</integer>`
          : `<string>${esc(value)}</string>`;
bootout(legacyBackend, inspect(legacyBackend, { ignorePortWhenAbsent: true }));
if (existingLegacyBackend.installed) unlinkSync(existingLegacyBackend.path);

for (const job of [companion]) {
  const path = join(agents, job.label + ".plist");
  const program = [process.execPath, job.file];
  const previous = existingCompanion.installed;
  const previousEnvironment = { ...previous?.EnvironmentVariables };
  delete previousEnvironment.SYNARA_MOBILE_UPSTREAM;
  delete previousEnvironment.SYNARA_MOBILE_UPSTREAM_TOKEN;
  const config = {
    ...previous,
    Label: job.label,
    ProgramArguments: program,
    WorkingDirectory: repo,
    EnvironmentVariables: {
      ...previousEnvironment,
      PATH: previousEnvironment.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
      SYNARA_MOBILE_HOME: data,
      SYNARA_MOBILE_ORIGIN: settings.origin,
      SYNARA_MOBILE_PORT: "58091",
    },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    StandardOutPath: join(data, job.label + ".log"),
    StandardErrorPath: join(data, job.label + ".error.log"),
  };
  bootout(job, inspect(job));
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plist(config)}</plist>\n`,
    { mode: 0o600 },
  );
  let result;
  for (let attempt = 0; attempt < 20; attempt++) {
    result = run(["bootstrap", domain, path]);
    if (result.status === 0 && !result.error) break;
    if (!String(result.stderr).includes("Bootstrap failed: 5")) break;
    pause(250);
  }
  if (result.status !== 0) throw new Error(result.stderr || `Could not start ${job.label}`);
  console.log(`Installed ${job.label}`);
}
console.log(
  "The companion follows Synara.app, starts at login, and restarts after a crash. Run node cli.mjs pair to connect your phone.",
);
}
