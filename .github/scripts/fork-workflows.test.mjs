import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const workflows = JSON.parse(
  execFileSync(
    "bun",
    [
      "--eval",
      String.raw`
        import { readdirSync, readFileSync } from "node:fs";
        const directory = ".github/workflows";
        const files = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
        console.log(JSON.stringify(Object.fromEntries(files.map((name) =>
          [name, Bun.YAML.parse(readFileSync(directory + "/" + name, "utf8"))]))));
      `,
    ],
    { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
  ),
);
const prWorkflows = new Set([
  "ci.yml",
  "cua-native-check.yml",
  "cua-linux-check.yml",
  "validate-marketing.yml",
]);

test("fork workflows are manual except the four retained PR checks", () => {
  for (const name of prWorkflows) assert.ok(workflows[name], `Missing PR check: ${name}`);
  for (const [name, workflow] of Object.entries(workflows)) {
    const expected = prWorkflows.has(name)
      ? ["pull_request", "workflow_dispatch"]
      : ["workflow_dispatch"];
    assert.deepEqual(Object.keys(workflow.on).toSorted(), expected, name);
  }
});

const sync = workflows["fork-upstream-sync.yml"].jobs.sync;
test("upstream sync is restricted to the personal fork", () => {
  assert.equal(sync.if, "github.repository == 'TrapstarKS/synara'");
});

// Emulate Git responses only; the decision to push stays in the workflow's actual shell.
const gitStub = String.raw`
git() {
  printf 'git:%s\n' "$*" >&2
  case "$1" in
    rev-parse) printf 'fixture-before\n' ;;
    diff) if [[ "$2" == --quiet ]]; then return "$SYNARA_TEST_DIFF_EXIT"; fi ;;
    config|merge|push) return 0 ;;
    *) return 99 ;;
  esac
}
`;

for (const [scenario, diffExit, canPush] of [
  ["application changes", 0, true],
  ["workflow changes", 1, false],
  ["comparison failure", 2, false],
]) {
  test(`actual upstream sync shell handles ${scenario} before push`, () => {
    const step = sync.steps.find(
      (entry) => entry.name === "Merge and push the exact upstream release",
    );
    assert.ok(step?.run, "The actual merge and push shell must be covered");
    const code = step.run.replace(
      /\$\{\{\s*steps\.upstream\.outputs\.sha\s*\}\}/g,
      "fixture-upstream",
    );
    const result = spawnSync("bash", ["-e", "-c", `${gitStub}\n${code}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        FORK_BRANCH: "fixture-branch",
        SYNARA_TEST_DIFF_EXIT: String(diffExit),
      },
      timeout: 10_000,
    });
    const calls = result.stderr.split("\n");
    const before = calls.indexOf("git:rev-parse HEAD");
    const merge = calls.indexOf("git:merge --no-edit --no-ff fixture-upstream");
    const comparison = calls.indexOf("git:diff --quiet fixture-before HEAD -- .github/workflows");
    const push = calls.indexOf("git:push origin HEAD:fixture-branch");
    assert.ok(before >= 0 && before < merge && merge < comparison, result.stderr);
    assert.equal(result.status === 0, canPush, result.stderr);
    assert.equal(push !== -1, canPush, result.stderr);
    if (canPush) assert.ok(comparison < push);
    else assert.match(result.stdout, /Review and integrate these workflow changes locally/);
  });
}
