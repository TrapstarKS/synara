import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const turbo = fileURLToPath(new URL("../node_modules/turbo/bin/turbo", import.meta.url));

function taskGraph(task: string, filter: string, env: NodeJS.ProcessEnv = process.env) {
  return JSON.parse(
    execFileSync(process.execPath, [turbo, "run", task, `--filter=${filter}`, "--dry=json"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as { tasks: Array<{ taskId: string; hash: string; inputs: Record<string, string> }> };
}

describe("build pipeline", () => {
  it("runs source tests without compiling the production web/desktop bundles", () => {
    expect(taskGraph("test", "@synara/cli").tasks.map((task) => task.taskId)).toEqual([
      "@synara/cli#test",
    ]);
  });

  it("still builds the web client before packaging the server", () => {
    expect(taskGraph("build", "@synara/cli").tasks.map((task) => task.taskId)).toContain(
      "@synara/web#build",
    );
  });

  it("reuses builds across runtime port changes but invalidates the embedded publisher", () => {
    const hash = (port: string, publisher: string) =>
      taskGraph("build", "@synara/desktop", {
        ...process.env,
        PORT: port,
        AZURE_TRUSTED_SIGNING_SUBJECT_DN: publisher,
      }).tasks.find((task) => task.taskId === "@synara/desktop#build")?.hash;

    const original = hash("5733", "CN=Synara");
    expect(original).toBeTruthy();
    expect(hash("5734", "CN=Synara")).toBe(original);
    expect(hash("5733", "CN=Changed Publisher")).not.toBe(original);
  });
});
