import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
const setupWorkspace = readFileSync(
  join(repoRoot, ".github/actions/setup-workspace/action.yml"),
  "utf8",
);

function job(name) {
  const source = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"),
  )?.[1];
  assert.ok(source, `Missing release job: ${name}`);
  return source;
}

function needs(name) {
  const value = job(name).match(/^    needs: (.+)$/m)?.[1];
  assert.ok(value, `${name} must have dependencies`);
  return value
    .replaceAll("[", "")
    .replaceAll("]", "")
    .split(",")
    .map((item) => item.trim())
    .toSorted();
}

function step(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Missing release step: ${name}`);
  const tail = source.slice(start + marker.length);
  const end = tail.search(/^      - /m);
  return end === -1 ? tail : tail.slice(0, end);
}

test("GitHub and npm publication require every test partition and native build", () => {
  for (const name of ["release", "publish_cli"]) {
    assert.deepEqual(needs(name), ["build", "preflight", "test", "verify"]);
    assert.ok(job(name).includes("needs.preflight.outputs.publish_release == 'true'"));
    assert.ok(!job(name).includes("always()"));
  }
  assert.deepEqual(needs("build"), ["build_mac_icon", "bundle", "preflight"]);
  for (const name of ["build_mac_icon", "bundle", "test", "verify"]) {
    assert.deepEqual(needs(name), ["preflight"]);
    assert.match(job(name), /permissions:\n      contents: read/);
  }
  assert.ok(!workflow.includes("continue-on-error"));
  assert.match(job("test"), /fail-fast: false/);
  assert.match(
    job("test"),
    /run: bun run test \$\{\{ matrix.filters \}\} -- \$\{\{ matrix.test-args \}\}/,
  );
});

test("the actual Turbo test graph is covered by the release matrix", () => {
  const partitions = [
    ...job("test").matchAll(/filters: "([^"]+)"\n            test-args: "([^"]*)"/g),
  ];
  assert.equal(partitions.length, 5);
  const turboPath = join(repoRoot, "node_modules/turbo/bin/turbo");
  const testTasks = (args) => {
    const graph = JSON.parse(
      execFileSync(process.execPath, [turboPath, "run", "test", "--dry=json", ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    return graph.tasks
      .filter((task) => task.task === "test" && task.command !== "<NONEXISTENT>")
      .map((task) => task.taskId)
      .toSorted();
  };
  const expected = testTasks([]);
  assert.ok(expected.length > 0);
  const owners = new Map();
  for (const [, filters, testArgs] of partitions) {
    const args = filters.split(/\s+/);
    if (testArgs) args.push("--", testArgs);
    for (const taskId of testTasks(args)) {
      const entries = owners.get(taskId) ?? [];
      entries.push(testArgs);
      owners.set(taskId, entries);
    }
  }
  assert.deepEqual(
    [...owners.keys()].toSorted(),
    expected,
    "No package may disappear or be introduced by partitioning",
  );
  for (const [taskId, args] of owners) {
    assert.deepEqual(
      args.toSorted(),
      taskId === "@synara/cli#test" ? ["--shard=1/3", "--shard=2/3", "--shard=3/3"] : [""],
      taskId,
    );
  }
});

test("server distribution consumes the shared compilation before native builds start", () => {
  const bundle = job("bundle");
  assert.ok(!workflow.includes("  build_server_tarball:"));
  const buildOffset = bundle.indexOf("run: bun run build:desktop");
  const packOffset = bundle.indexOf("node apps/server/scripts/cli.ts pack");
  assert.ok(buildOffset >= 0 && packOffset > buildOffset);
  assert.ok(packOffset < bundle.indexOf("- name: Upload server tarball"));
  assert.ok(
    !step(bundle, "Pack server tarball").includes("if:"),
    "Build-only runs must validate the server package too",
  );
  assert.ok(!job("publish_cli").includes("run: bun run build"));
  assert.match(
    step(job("publish_cli"), "Download shared desktop bundle"),
    /name: shared-desktop-bundle/,
  );
  assert.match(step(job("release"), "Download server tarball"), /name: server-tarball/);
});

test("all artifact consumers check out the verified source and download from this run", () => {
  for (const name of ["verify", "test", "bundle", "build", "publish_cli", "release"]) {
    const source = job(name);
    assert.match(step(source, "Checkout"), /ref: \$\{\{ needs.preflight.outputs.ref \}\}/);
    assert.ok(!source.includes("run-id:"), `${name} must not reuse an unverified external run`);
  }
});

test("Windows dependency cache and temporary staging use the runner volume", () => {
  const configuration = step(job("build"), "Configure Electron packaging cache");
  const script = configuration.split("        run: |\n")[1];
  assert.ok(script);
  const command = script
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
  const root = mkdtempSync(join(tmpdir(), "synara-release-env-"));
  try {
    for (const os of ["Windows", "macOS", "Linux"]) {
      const envFile = join(root, `${os} env`);
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", command], {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, RUNNER_OS: os, RUNNER_TEMP: "D:/runner temp", GITHUB_ENV: envFile },
      });
      assert.equal(result.status, 0, result.stderr);
      const entries = readFileSync(envFile, "utf8").trim().split("\n");
      assert.ok(entries.includes("ELECTRON_CACHE=D:/runner temp/electron-cache"));
      for (const expected of [
        "BUN_INSTALL_CACHE_DIR=D:/runner temp/bun-install-cache",
        "TEMP=D:/runner temp",
        "TMP=D:/runner temp",
      ]) {
        assert.equal(entries.includes(expected), os === "Windows", `${os}: ${expected}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace lifecycle scripts are serialized during dependency installation", () => {
  const installCommands = setupWorkspace.match(/bun install --frozen-lockfile[^\n]*/g) ?? [];
  assert.equal(installCommands.length, 3);
  for (const command of installCommands) {
    assert.match(command, /--concurrent-scripts=1/);
  }
});
