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
if (process.platform !== "darwin" || !["install", "uninstall", "status"].includes(command)) {
  console.error(
    "macOS usage: node service.mjs install [--origin https://MAC.ts.net:8443] [--synara-home PATH] | status | uninstall",
  );
  process.exit(1);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--origin", "--synara-home"].includes(args[i]) || !args[i + 1])
    throw new Error("Unknown or missing option");
  options[args[i]] = args[i + 1];
}
const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, "../..");
const agents = join(homedir(), "Library/LaunchAgents");
const domain = `gui/${process.getuid()}`;
const jobs = [
  {
    label: "com.synara.mobile.backend",
    port: 58090,
    file: join(repo, "apps/server/dist/index.mjs"),
  },
  { label: "com.synara.mobile.companion", port: 58091, file: join(root, "server.mjs") },
];
const run = (args) => spawnSync("/bin/launchctl", args, { encoding: "utf8" });
if (command === "status") {
  for (const job of jobs) {
    const result = run(["print", `${domain}/${job.label}`]);
    const state = result.stdout?.match(/state = (.+)/)?.[1] ?? "not loaded";
    const pid = result.stdout?.match(/pid = (\d+)/)?.[1];
    console.log(`${job.label}: ${state}${pid ? ` (PID ${pid})` : ""}`);
  }
  process.exit(0);
}
function inspect(job) {
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
  const pids = listenerPids(
    spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${job.port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    }),
  );
  verifyServiceOwnership({ job, path, installed, loaded, pids });
  return { path, installed, loaded };
}
// Check both jobs before changing either, then recheck immediately before bootout.
const existing = jobs.map(inspect);
function bootout(job, inspected) {
  if (!inspected.loaded) return;
  const result = run(["bootout", `${domain}/${job.label}`]);
  if (result.status !== 0 || result.error)
    throw new Error(`Could not stop owned service: ${job.label}`);
}
if (command === "uninstall") {
  for (const job of jobs.toReversed()) {
    const inspected = inspect(job);
    bootout(job, inspected);
    if (inspected.installed) unlinkSync(inspected.path);
  }
  console.log("Services removed. Saved data and Tailscale Serve configuration were preserved.");
  process.exit(0);
}
const settings = resolveServiceSettings({
  backend: existing[0].installed,
  companion: existing[1].installed,
  origin: options["--origin"],
  synaraHome: options["--synara-home"],
  mobileHome: process.env.SYNARA_MOBILE_HOME,
  defaultSynaraHome: join(homedir(), ".synara-preview-synara"),
  defaultMobileHome: join(homedir(), ".synara-mobile"),
});
const data = settings.mobileHome;
for (const job of jobs)
  if (!existsSync(job.file)) throw new Error(`Build Synara first: missing ${job.file}`);
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
for (const job of jobs) {
  const path = join(agents, job.label + ".plist");
  const program =
    job === jobs[0]
      ? [
          "/usr/bin/env",
          "-u",
          "SYNARA_AUTH_TOKEN",
          "-u",
          "VITE_DEV_SERVER_URL",
          process.execPath,
          job.file,
          "--home-dir",
          settings.synaraHome,
          "--host",
          "127.0.0.1",
          "--port",
          "58090",
          "--no-browser",
        ]
      : [process.execPath, job.file];
  const previous = existing[jobs.indexOf(job)].installed;
  const config = {
    ...previous,
    Label: job.label,
    ProgramArguments: program,
    WorkingDirectory: repo,
    EnvironmentVariables: {
      ...previous?.EnvironmentVariables,
      PATH: previous?.EnvironmentVariables?.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
      SYNARA_MOBILE_HOME: data,
      SYNARA_MOBILE_ORIGIN: settings.origin,
      SYNARA_MOBILE_UPSTREAM: "http://127.0.0.1:58090",
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
  const result = run(["bootstrap", domain, path]);
  if (result.status !== 0) throw new Error(result.stderr || `Could not start ${job.label}`);
  console.log(`Installed ${job.label}`);
}
console.log(
  "Services start at login and restart after a crash. Run node cli.mjs pair to connect your phone.",
);
