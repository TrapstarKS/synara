import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLoadedJob,
  listenerPids,
  verifyServiceOwnership,
  resolveServiceSettings,
} from "./service-config.mjs";

const job = {
  label: "com.synara.mobile.backend",
  port: 58090,
  file: "/repo with spaces/apps/server/dist/index.mjs",
};
const path = "/Users/test/Library/LaunchAgents/com.synara.mobile.backend.plist";
const backend = () => ({
  Label: job.label,
  WorkingDirectory: "/repo with spaces",
  ProgramArguments: [
    "/usr/bin/env",
    "-u",
    "SYNARA_AUTH_TOKEN",
    "-u",
    "VITE_DEV_SERVER_URL",
    "/runtime/bin/node",
    job.file,
    "--home-dir",
    "/data/custom synara",
    "--host",
    "127.0.0.1",
    "--port",
    "58090",
    "--no-browser",
  ],
  EnvironmentVariables: {
    SYNARA_MOBILE_HOME: "/data/custom mobile",
    SYNARA_MOBILE_ORIGIN: "https://test.ts.net:8443",
    PATH: "/runtime/bin:/usr/bin",
  },
});
const loaded = (installed = backend()) => ({
  path,
  program: installed.ProgramArguments[0],
  args: installed.ProgramArguments,
  pid: 1234,
  cwd: installed.WorkingDirectory,
  environment: { ...installed.EnvironmentVariables, XPC_SERVICE_NAME: job.label },
});
const settings = (extra = {}) =>
  resolveServiceSettings({
    backend: backend(),
    companion: { EnvironmentVariables: backend().EnvironmentVariables },
    defaultSynaraHome: "/default/synara",
    defaultMobileHome: "/default/mobile",
    ...extra,
  });

test("reinstall preserves custom homes and origin unless explicitly overridden", () => {
  assert.deepEqual(settings(), {
    synaraHome: "/data/custom synara",
    mobileHome: "/data/custom mobile",
    origin: "https://test.ts.net:8443",
  });
  assert.deepEqual(
    settings({
      origin: "https://new.ts.net:8443",
      synaraHome: "/new/synara",
      mobileHome: "/new/mobile",
    }),
    { synaraHome: "/new/synara", mobileHome: "/new/mobile", origin: "https://new.ts.net:8443" },
  );
});

test("new install requires origin and inconsistent persisted settings fail closed", () => {
  assert.throws(() => settings({ backend: null, companion: null }), /origin is required/);
  assert.deepEqual(settings({ backend: null, companion: null, origin: "https://new.ts.net" }), {
    synaraHome: "/default/synara",
    mobileHome: "/default/mobile",
    origin: "https://new.ts.net",
  });
  assert.throws(
    () => settings({ companion: { EnvironmentVariables: { SYNARA_MOBILE_HOME: "/other" } } }),
    /disagree/,
  );
  assert.equal(
    settings({
      companion: { EnvironmentVariables: { SYNARA_MOBILE_HOME: "/other" } },
      mobileHome: "/explicit",
    }).mobileHome,
    "/explicit",
  );
  for (const origin of [
    "http://test.ts.net",
    "https://test.ts.net/path",
    "https://user:pass@test.ts.net",
    "https://test.ts.net/#x",
  ])
    assert.throws(() => settings({ origin }));
});

test("launchctl parser extracts exact argument boundaries, environment and exec-preserved PID", () => {
  const installed = backend();
  const output = `gui/501/${job.label} = {\n\tpath = ${path}\n\tprogram = /usr/bin/env\n\targuments = {\n${installed.ProgramArguments.map((arg) => "\t\t" + arg).join("\n")}\n\t}\n\tworking directory = /repo with spaces\n\tenvironment = {\n${Object.entries(
    installed.EnvironmentVariables,
  )
    .map(([key, value]) => "\t\t" + key + " => " + value)
    .join("\n")}\n\t}\n\tpid = 1234\n}\n`;
  const parsed = parseLoadedJob(output);
  assert.deepEqual(parsed.args, installed.ProgramArguments);
  assert.equal(parsed.pid, 1234);
  verifyServiceOwnership({ job, path, installed, loaded: parsed, pids: [1234] });
  assert.throws(() => parseLoadedJob("unexpected launchctl format"), /Cannot verify/);
});

test("loaded job must match owned plist, exact program and actual listener PID", () => {
  const installed = backend(),
    running = loaded(installed);
  verifyServiceOwnership({ job, path, installed, loaded: running, pids: [1234] });
  verifyServiceOwnership({ job, path, installed, loaded: { ...running, pid: null }, pids: [] });
  for (const patch of [
    { pids: [4321] },
    { pids: [1234, 4321] },
    { installed: null },
    { loaded: { ...running, path: "/other.plist" } },
    { loaded: { ...running, program: "/unowned" } },
    { loaded: { ...running, args: ["/runtime/bin/node", "/other/repo/server.mjs"] } },
    {
      loaded: {
        ...running,
        environment: { ...running.environment, SYNARA_MOBILE_HOME: "/changed" },
      },
    },
    { loaded: null, pids: [1234] },
  ]) {
    assert.throws(() =>
      verifyServiceOwnership({ job, path, installed, loaded: running, pids: [1234], ...patch }),
    );
  }
});

test("substring paths and executable overrides cannot impersonate an owned service", () => {
  for (const installed of [
    { ...backend(), Program: "/bin/sh" },
    { ...backend(), Label: "another.label" },
    { ...backend(), ProgramArguments: ["/runtime/bin/node", "-e", job.file] },
    { ...backend(), ProgramArguments: ["/bin/sh", "-c", `echo ${job.file}`] },
    {
      ...backend(),
      ProgramArguments: backend().ProgramArguments.map((arg) =>
        arg === job.file ? job.file + ".other" : arg,
      ),
    },
  ])
    assert.throws(() => verifyServiceOwnership({ job, path, installed, loaded: null }));
});

test("listener inspection rejects errors or ambiguous output instead of assuming free ports", () => {
  assert.deepEqual(listenerPids({ status: 1, stdout: "", stderr: "" }), []);
  assert.deepEqual(listenerPids({ status: 0, stdout: "1234\n1234\n", stderr: "" }), [1234]);
  for (const result of [
    { status: 2, stdout: "" },
    { status: 0, stdout: "bad" },
    { status: 1, stdout: "123" },
    { status: 0, stdout: "", stderr: "inspection warning" },
    { error: new Error("no lsof"), status: null },
  ])
    assert.throws(() => listenerPids(result));
});
