import { basename, isAbsolute, resolve } from "node:path";

export function parseLoadedJob(output) {
  const field = (name) => output.match(new RegExp(`^\\t${name} = (.+)$`, "m"))?.[1];
  const block = output.match(/^\targuments = \{\n([\s\S]*?)^\t\}/m)?.[1];
  if (!block || !field("program") || !field("path"))
    throw new Error("Cannot verify loaded launchd job");
  const args = block
    .trimEnd()
    .split("\n")
    .map((line) => {
      if (!line.startsWith("\t\t")) throw new Error("Cannot parse launchd arguments");
      return line.slice(2);
    });
  const environment = {};
  const envBlock = output.match(/^\tenvironment = \{\n([\s\S]*?)^\t\}/m)?.[1] ?? "";
  for (const line of envBlock.trimEnd().split("\n")) {
    const match = line.match(/^\t\t([^ ]+) => (.*)$/);
    if (match) environment[match[1]] = match[2];
  }
  const pid = field("pid");
  if (pid !== undefined && !/^[1-9]\d*$/.test(pid)) throw new Error("Cannot verify launchd PID");
  return {
    path: field("path"),
    program: field("program"),
    args,
    pid: pid ? Number(pid) : null,
    cwd: field("working directory"),
    environment,
  };
}

export function listenerPids(result) {
  if (result.error || ![0, 1].includes(result.status) || (result.stderr ?? "").trim())
    throw new Error("Cannot inspect listening processes");
  const lines = (result.stdout ?? "").trim().split("\n").filter(Boolean);
  if (result.status === 1 && lines.length) throw new Error("Ambiguous listener inspection");
  if (lines.some((line) => !/^[1-9]\d*$/.test(line))) throw new Error("Invalid listener PID");
  return [...new Set(lines.map(Number))];
}

function ownedArguments(job, args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || /[\r\n]/.test(arg)))
    return false;
  let offset = 0;
  if (args[0] === "/usr/bin/env") {
    if (
      args[1] !== "-u" ||
      args[2] !== "SYNARA_AUTH_TOKEN" ||
      args[3] !== "-u" ||
      args[4] !== "VITE_DEV_SERVER_URL"
    )
      return false;
    offset = 5;
  }
  if (
    !isAbsolute(args[offset] ?? "") ||
    basename(args[offset]) !== "node" ||
    args[offset + 1] !== job.file
  )
    return false;
  const remaining = args.slice(offset + 2);
  if (job.port === 58091) return remaining.length === 0;
  return (
    remaining.length === 7 &&
    remaining[0] === "--home-dir" &&
    isAbsolute(remaining[1]) &&
    remaining[2] === "--host" &&
    remaining[3] === "127.0.0.1" &&
    remaining[4] === "--port" &&
    remaining[5] === String(job.port) &&
    remaining[6] === "--no-browser"
  );
}

export function verifyServiceOwnership({ job, path, installed, loaded, pids = [] }) {
  if (
    installed &&
    (installed.Label !== job.label ||
      !ownedArguments(job, installed.ProgramArguments) ||
      (installed.Program !== undefined && installed.Program !== installed.ProgramArguments[0]))
  ) {
    throw new Error(`Service configuration is not owned by this checkout: ${job.label}`);
  }
  if (loaded) {
    if (
      !installed ||
      loaded.path !== path ||
      !ownedArguments(job, loaded.args) ||
      loaded.program !== (installed.Program ?? installed.ProgramArguments[0]) ||
      JSON.stringify(loaded.args) !== JSON.stringify(installed.ProgramArguments) ||
      loaded.cwd !== installed.WorkingDirectory ||
      Object.entries(installed.EnvironmentVariables ?? {}).some(
        ([key, value]) => loaded.environment[key] !== value,
      )
    ) {
      throw new Error(`Cannot prove loaded service ownership/configuration: ${job.label}`);
    }
  }
  if (pids.some((pid) => !loaded?.pid || pid !== loaded.pid))
    throw new Error(`Port ${job.port} has a listener outside its owned service`);
}

export function resolveServiceSettings({
  backend,
  companion,
  origin,
  synaraHome,
  mobileHome,
  defaultSynaraHome,
  defaultMobileHome,
}) {
  const configs = [backend, companion].filter(Boolean);
  function choose(override, existing, fallback, label) {
    if (override !== undefined) return override;
    const values = [...new Set(existing.filter((value) => value !== undefined))];
    if (values.length > 1)
      throw new Error(`Existing ${label} settings disagree; provide an explicit override`);
    return values[0] ?? fallback;
  }
  const rawOrigin = choose(
    origin,
    configs.map((c) => c.EnvironmentVariables?.SYNARA_MOBILE_ORIGIN),
    undefined,
    "origin",
  );
  if (!rawOrigin) throw new Error("--origin is required for a new installation");
  const parsed = new URL(rawOrigin);
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Expected HTTPS origin");
  const args = backend?.ProgramArguments ?? [];
  const index = args.indexOf("--home-dir");
  const oldHome = index >= 0 ? args[index + 1] : undefined;
  return {
    origin: parsed.origin,
    synaraHome: resolve(choose(synaraHome, [oldHome], defaultSynaraHome, "Synara home")),
    mobileHome: resolve(
      choose(
        mobileHome,
        configs.map((c) => c.EnvironmentVariables?.SYNARA_MOBILE_HOME),
        defaultMobileHome,
        "mobile home",
      ),
    ),
  };
}
