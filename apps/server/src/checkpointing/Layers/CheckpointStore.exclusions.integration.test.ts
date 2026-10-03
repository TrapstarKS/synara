// Real Git coverage for checkpoint exclusions and preservation of files/indexes.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef } from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore, type ExecuteGitInput } from "../../git/Services/GitCore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { parseCheckpointPolicyMessage } from "../checkpointPathPolicy.ts";

const CONFIG_KEY = "synara.checkpointExcludePath";
const ref = (name: string) =>
  CheckpointRef.makeUnsafe(`refs/synara-checkpoints/exclusions/${name}`);
const fixtures: {
  root: string;
  runtime: ManagedRuntime.ManagedRuntime<CheckpointStore, unknown>;
}[] = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(cwd: string, relative: string, contents: string): void {
  const file = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synara-checkpoint-exclusions-"));
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  git(cwd, ["init", "--initial-branch=main", "--object-format=sha1"]);
  git(cwd, ["config", "user.name", "Checkpoint Test"]);
  git(cwd, ["config", "user.email", "checkpoint@example.invalid"]);
  git(cwd, ["config", "commit.gpgSign", "false"]);
  git(cwd, ["config", "core.autocrlf", "false"]);
  write(root, "excludes", "");
  fs.mkdirSync(path.join(root, "hooks"));
  git(cwd, ["config", "core.excludesFile", path.join(root, "excludes")]);
  git(cwd, ["config", "core.hooksPath", path.join(root, "hooks")]);
  git(cwd, ["config", "core.fsmonitor", "false"]);
  write(cwd, "source.txt", "before\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "Initial"]);
  const commands: ExecuteGitInput[] = [];
  const recordedGit = Layer.effect(
    GitCore,
    Effect.gen(function* () {
      const core = yield* GitCore;
      return {
        ...core,
        execute: (input: ExecuteGitInput) => {
          commands.push(input);
          return core.execute(input);
        },
      };
    }),
  ).pipe(Layer.provide(GitCoreLive));
  const runtime = ManagedRuntime.make(
    CheckpointStoreLive.pipe(
      Layer.provide(recordedGit),
      Layer.provide(ServerConfig.layerTest(cwd, path.join(root, "state"))),
      Layer.provide(NodeServices.layer),
    ),
  );
  fixtures.push({ root, runtime });
  const store = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* CheckpointStore;
    }),
  );
  const capture = (name: string, captureCwd = cwd) =>
    runtime.runPromise(store.captureCheckpoint({ cwd: captureCwd, checkpointRef: ref(name) }));
  const restore = (name: string, restoreCwd = cwd) =>
    runtime.runPromise(store.restoreCheckpoint({ cwd: restoreCwd, checkpointRef: ref(name) }));
  const diff = (from: string, to: string) =>
    runtime.runPromise(
      store.diffCheckpoints({
        cwd,
        fromCheckpointRef: ref(from),
        toCheckpointRef: ref(to),
        ignoreWhitespace: false,
      }),
    );
  const undo = (from: string, to: string, undoCwd = cwd) =>
    runtime.runPromise(
      store.reverseCheckpointDiff({
        cwd: undoCwd,
        fromCheckpointRef: ref(from),
        toCheckpointRef: ref(to),
      }),
    );
  const tree = (name: string) =>
    git(cwd, ["ls-tree", "-r", "--name-only", ref(name)])
      .trim()
      .split("\n");
  const index = () => fs.readFileSync(path.join(cwd, ".git", "index"));
  return { root, cwd, runtime, store, commands, capture, restore, diff, undo, tree, index };
}

afterEach(async () => {
  for (const { root, runtime } of fixtures.splice(0)) {
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("checkpoint exclusion policy with real Git", () => {
  it("omits generated root variants without hashing their blobs or changing the real index", async () => {
    const h = await fixture();
    const outputs = ["artefacts/report.txt", ".artifacts/output.txt", "artifacts-qa/log.txt"];
    const payloads = outputs.map((file) => `${file}: unique excluded bytes\n`);
    outputs.forEach((file, i) => write(h.cwd, file, payloads[i]!));
    write(h.cwd, "src/artifacts.ts", "export const code = true;\n");
    git(h.cwd, ["add", "src/artifacts.ts"]);
    write(h.cwd, "source.txt", "after\n");
    const before = h.index();
    await h.capture("variants");
    expect(h.tree("variants")).toEqual(["source.txt", "src/artifacts.ts"]);
    expect(h.index()).toEqual(before);
    for (const contents of payloads) {
      const object = createHash("sha1")
        .update(`blob ${Buffer.byteLength(contents)}\0`)
        .update(contents)
        .digest("hex");
      expect(spawnSync("git", ["cat-file", "-e", object], { cwd: h.cwd }).status).toBe(1);
    }
    expect(git(h.cwd, ["show", `${ref("variants")}:source.txt`])).toBe("after\n");
  });

  it.each(["Artifacts", "artifacts", "ARTIFACTS"])(
    "preserves the reserved root %s even with indexed files",
    async (directory) => {
      const h = await fixture();
      write(h.cwd, `${directory}/report.txt`, "old output\n");
      git(h.cwd, ["add", "--", `${directory}/report.txt`]);
      const before = h.index();
      await h.capture("reserved");
      expect(h.tree("reserved")).toEqual(["source.txt"]);
      expect(h.index()).toEqual(before);
      write(h.cwd, `${directory}/report.txt`, "keep current output\n");
      write(h.cwd, `${directory}/new.txt`, "new output\n");
      await h.restore("reserved");
      expect(fs.readFileSync(path.join(h.cwd, directory, "report.txt"), "utf8")).toBe(
        "keep current output\n",
      );
      expect(fs.existsSync(path.join(h.cwd, directory, "new.txt"))).toBe(true);
      expect(git(h.cwd, ["show", `:${directory}/report.txt`])).toBe("old output\n");
    },
  );

  it("keeps tracked source roots, ordinary files and nested artifact names checkpointed", async () => {
    const h = await fixture();
    write(h.cwd, "artifacts-client/index.ts", "before source\n");
    write(h.cwd, "artefacts", "an ordinary file\n");
    write(h.cwd, "src/.artifacts/example.ts", "nested source\n");
    write(h.cwd, ".gitignore", "cache-custom/\n");
    write(h.cwd, "cache-custom/forced.ts", "explicitly tracked\n");
    git(h.cwd, ["add", "-f", "."]);
    git(h.cwd, ["commit", "-m", "source roots"]);
    write(h.cwd, "artifacts-client/index.ts", "modified source\n");
    write(h.cwd, "artifacts-client/new.ts", "new source\n");
    write(h.cwd, "cache-custom/untracked.bin", "ignored output\n");
    await h.capture("source-roots");
    expect(h.tree("source-roots")).toEqual([
      ".gitignore",
      "artefacts",
      "artifacts-client/index.ts",
      "artifacts-client/new.ts",
      "cache-custom/forced.ts",
      "source.txt",
      "src/.artifacts/example.ts",
    ]);
    expect(git(h.cwd, ["show", `${ref("source-roots")}:artifacts-client/index.ts`])).toBe(
      "modified source\n",
    );
  });

  it("uses literal custom paths and preserves historical exclusions after local config is removed", async () => {
    const h = await fixture();
    const excluded = "reports [1]";
    write(h.cwd, `${excluded}/tracked.txt`, "staged output\n");
    git(h.cwd, ["add", "--", `:(literal)${excluded}`]);
    git(h.cwd, ["config", "--local", "--add", CONFIG_KEY, excluded]);
    git(h.cwd, ["config", "--local", "--add", CONFIG_KEY, "custom outputs"]);
    write(h.cwd, "custom outputs/log.txt", "output\n");
    write(h.cwd, "reports 1/code.ts", "legitimate source\n");
    const before = h.index();
    await h.capture("custom");
    expect(h.tree("custom")).toEqual(["reports 1/code.ts", "source.txt"]);
    expect(h.index()).toEqual(before);
    git(h.cwd, ["config", "--local", "--unset-all", CONFIG_KEY]);
    write(h.cwd, `${excluded}/tracked.txt`, "current output\n");
    write(h.cwd, `${excluded}/new.txt`, "new output\n");
    write(h.cwd, "custom outputs/log.txt", "current custom output\n");
    write(h.cwd, "source.txt", "later\n");
    expect(await h.restore("custom")).toBe(true);
    expect(fs.readFileSync(path.join(h.cwd, excluded, "tracked.txt"), "utf8")).toBe(
      "current output\n",
    );
    expect(fs.existsSync(path.join(h.cwd, excluded, "new.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(h.cwd, "custom outputs/log.txt"), "utf8")).toBe(
      "current custom output\n",
    );
    expect(git(h.cwd, ["show", `:${excluded}/tracked.txt`])).toBe("staged output\n");
    expect(fs.readFileSync(path.join(h.cwd, "source.txt"), "utf8")).toBe("before\n");
  });

  it("unions both checkpoint policies for diff and undo when a custom rule changes", async () => {
    const h = await fixture();
    git(h.cwd, ["config", "--local", "--add", CONFIG_KEY, "rendered"]);
    write(h.cwd, "rendered/result.txt", "excluded baseline output\n");
    await h.capture("start");
    git(h.cwd, ["config", "--local", "--unset-all", CONFIG_KEY]);
    write(h.cwd, "source.txt", "after\n");
    write(h.cwd, "rendered/result.txt", "new output\n");
    await h.capture("end");
    expect(await h.diff("start", "end")).not.toContain("rendered");
    expect(await h.undo("start", "end")).toBe(true);
    expect(fs.readFileSync(path.join(h.cwd, "source.txt"), "utf8")).toBe("before\n");
    expect(fs.readFileSync(path.join(h.cwd, "rendered/result.txt"), "utf8")).toBe("new output\n");
  });

  it("isolates concurrent capture indexes while preserving staged and unstaged changes", async () => {
    const h = await fixture();
    write(h.cwd, "source.txt", "staged\n");
    git(h.cwd, ["add", "source.txt"]);
    write(h.cwd, "source.txt", "unstaged\n");
    write(h.cwd, "artifacts-qa/log.txt", "exclude\n");
    const before = h.index();
    await Promise.all([h.capture("parallel-a"), h.capture("parallel-b"), h.capture("parallel-a")]);
    expect(h.tree("parallel-a")).toEqual(["source.txt"]);
    expect(h.tree("parallel-b")).toEqual(["source.txt"]);
    expect(h.index()).toEqual(before);
    expect(git(h.cwd, ["show", ":source.txt"])).toBe("staged\n");
    expect(git(h.cwd, ["show", `${ref("parallel-a")}:source.txt`])).toBe("unstaged\n");
    const indexes = new Set(
      h.commands
        .filter((command) => command.args[0] === "add")
        .map((command) => command.env?.GIT_INDEX_FILE),
    );
    expect(indexes.size).toBe(2);
    for (const file of indexes) {
      expect(file).toBeDefined();
      expect(file).not.toBe(path.join(h.cwd, ".git", "index"));
      expect(fs.existsSync(file!)).toBe(false);
    }
  });

  it("does not infer an output after all source entries are staged for removal", async () => {
    const h = await fixture();
    write(h.cwd, "artifacts-client/index.ts", "tracked in HEAD\n");
    git(h.cwd, ["add", "."]);
    git(h.cwd, ["commit", "-m", "tracked artifact client"]);
    git(h.cwd, ["rm", "--cached", "artifacts-client/index.ts"]);
    write(h.cwd, "artifacts-client/new.ts", "still source\n");
    const before = h.index();
    await h.capture("staged-deletion");
    expect(h.tree("staged-deletion")).toContain("artifacts-client/index.ts");
    expect(h.tree("staged-deletion")).toContain("artifacts-client/new.ts");
    expect(h.index()).toEqual(before);
  });

  it.skipIf(process.platform === "win32")(
    "captures a generated-looking symlink itself without following or inferring its target",
    async () => {
      const h = await fixture();
      write(h.root, "outside/keep.txt", "outside content\n");
      fs.symlinkSync(path.join(h.root, "outside"), path.join(h.cwd, "artifacts-link"), "dir");
      await h.capture("symlink");
      expect(h.tree("symlink")).toContain("artifacts-link");
      expect(git(h.cwd, ["ls-tree", ref("symlink"), "--", "artifacts-link"])).toMatch(
        /^120000 blob /,
      );
      const policy = parseCheckpointPolicyMessage(
        git(h.cwd, ["show", "--no-patch", "--format=%B", ref("symlink")]),
      );
      expect(policy.excludedPaths).not.toContain("artifacts-link");
      expect(fs.readFileSync(path.join(h.root, "outside/keep.txt"), "utf8")).toBe(
        "outside content\n",
      );
    },
  );

  it("rejects invalid configuration before capture or restore can write to Git or the worktree", async () => {
    const h = await fixture();
    await h.capture("valid");
    write(h.cwd, "source.txt", "keep current\n");
    const before = h.index();
    for (const value of [
      "../outside",
      "/absolute",
      ".",
      ".git/config",
      "nested/../source",
      "",
      "bad\npath",
    ]) {
      git(h.cwd, ["config", "--local", "--replace-all", CONFIG_KEY, value]);
      h.commands.length = 0;
      const capture = await h.runtime.runPromise(
        h.store
          .captureCheckpoint({ cwd: h.cwd, checkpointRef: ref("invalid") })
          .pipe(Effect.result),
      );
      const restore = await h.runtime.runPromise(
        h.store.restoreCheckpoint({ cwd: h.cwd, checkpointRef: ref("valid") }).pipe(Effect.result),
      );
      expect(capture._tag).toBe("Failure");
      expect(restore._tag).toBe("Failure");
      expect(
        h.commands.some((command) =>
          ["add", "rm", "restore", "clean", "reset", "update-ref"].includes(command.args[0] ?? ""),
        ),
      ).toBe(false);
      expect(h.index()).toEqual(before);
      expect(fs.readFileSync(path.join(h.cwd, "source.txt"), "utf8")).toBe("keep current\n");
    }
  });

  it("refuses malformed or future historical policy instead of dropping protection", async () => {
    const h = await fixture();
    await h.capture("valid");
    const tree = git(h.cwd, ["rev-parse", `${ref("valid")}^{tree}`]).trim();
    write(h.cwd, "source.txt", "keep current\n");
    for (const trailer of [
      'Synara-Checkpoint-Policy: {"version":2,"excludedPaths":["rendered"]}',
      'Synara-Checkpoint-Policy: {"version":1,"excludedPaths":["../outside"]}',
      "Synara-Checkpoint-Policy: broken",
    ]) {
      const commit = git(h.cwd, ["commit-tree", tree, "-m", `fixture\n\n${trailer}`]).trim();
      git(h.cwd, ["update-ref", ref("invalid-policy"), commit]);
      h.commands.length = 0;
      const result = await h.runtime.runPromise(
        h.store
          .restoreCheckpoint({ cwd: h.cwd, checkpointRef: ref("invalid-policy") })
          .pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expect(
        h.commands.some((command) => ["restore", "clean", "reset"].includes(command.args[0] ?? "")),
      ).toBe(false);
      expect(fs.readFileSync(path.join(h.cwd, "source.txt"), "utf8")).toBe("keep current\n");
    }
  });

  it("honors new exclusions when restoring a legacy checkpoint from a nested cwd", async () => {
    const h = await fixture();
    write(h.cwd, "module/code.ts", "before module\n");
    write(h.cwd, "module/rendered/out.txt", "old output\n");
    git(h.cwd, ["add", "."]);
    git(h.cwd, ["commit", "-m", "legacy baseline"]);
    git(h.cwd, ["update-ref", ref("legacy"), "HEAD"]);
    git(h.cwd, ["config", "--local", "--add", CONFIG_KEY, "module/rendered"]);
    write(h.cwd, "source.txt", "outside current scope\n");
    write(h.cwd, "module/code.ts", "after module\n");
    write(h.cwd, "module/rendered/out.txt", "keep output\n");
    write(h.cwd, "module/rendered/new.txt", "keep new output\n");
    const before = h.index();
    await h.capture("nested", path.join(h.cwd, "module"));
    expect(h.index()).toEqual(before);
    expect(git(h.cwd, ["show", `${ref("nested")}:source.txt`])).toBe("before\n");
    await h.restore("legacy", path.join(h.cwd, "module"));
    expect(fs.readFileSync(path.join(h.cwd, "source.txt"), "utf8")).toBe("outside current scope\n");
    expect(fs.readFileSync(path.join(h.cwd, "module/code.ts"), "utf8")).toBe("before module\n");
    expect(fs.readFileSync(path.join(h.cwd, "module/rendered/out.txt"), "utf8")).toBe(
      "keep output\n",
    );
    expect(fs.existsSync(path.join(h.cwd, "module/rendered/new.txt"))).toBe(true);
  });

  it("uses a temporary three-way index and leaves excluded tracked output and unrelated staging untouched", async () => {
    const h = await fixture();
    const before = "header\nline two\nline three\ntarget before\nline five\nline six\nfooter\n";
    const after = before.replace("target before", "target after");
    const current = after.replace("header", "edited header");
    write(h.cwd, "source.txt", before);
    write(h.cwd, "outputs/result.txt", "committed output\n");
    write(h.cwd, "unrelated.txt", "before unrelated\n");
    git(h.cwd, ["add", "."]);
    git(h.cwd, ["commit", "-m", "three-way base"]);
    git(h.cwd, ["config", "--local", "--add", CONFIG_KEY, "outputs"]);
    await h.capture("merge-start");
    write(h.cwd, "source.txt", after);
    await h.capture("merge-end");
    git(h.cwd, ["config", "--local", "--unset-all", CONFIG_KEY]);
    write(h.cwd, "outputs/result.txt", "staged output\n");
    write(h.cwd, "unrelated.txt", "staged unrelated\n");
    git(h.cwd, ["add", "outputs/result.txt", "unrelated.txt"]);
    write(h.cwd, "outputs/result.txt", "keep current output\n");
    write(h.cwd, "source.txt", current);
    h.commands.length = 0;
    expect(await h.undo("merge-start", "merge-end")).toBe(true);
    expect(h.commands.some((command) => command.args.includes("--3way"))).toBe(true);
    const temporary = h.commands.find((command) => command.args.includes("--3way"))?.env
      ?.GIT_INDEX_FILE;
    expect(temporary).toBeDefined();
    expect(temporary).not.toBe(path.join(h.cwd, ".git", "index"));
    expect(
      h.commands
        .filter((command) => command.args[0] === "rm")
        .every((command) => command.env?.GIT_INDEX_FILE === temporary),
    ).toBe(true);
    expect(fs.readFileSync(path.join(h.cwd, "source.txt"), "utf8")).toBe(
      before.replace("header", "edited header"),
    );
    expect(fs.readFileSync(path.join(h.cwd, "outputs/result.txt"), "utf8")).toBe(
      "keep current output\n",
    );
    expect(git(h.cwd, ["show", ":outputs/result.txt"])).toBe("staged output\n");
    expect(git(h.cwd, ["show", ":unrelated.txt"])).toBe("staged unrelated\n");
  });

  it("rolls a conflicting three-way undo back using literal paths from a nested cwd", async () => {
    const h = await fixture();
    const source = "module/code [1].ts";
    write(h.cwd, source, "before\n");
    write(h.cwd, "module/code 1.ts", "unrelated source\n");
    write(h.cwd, "code [1].ts", "root before\n");
    git(h.cwd, ["add", "."]);
    git(h.cwd, ["commit", "-m", "nested conflict base"]);
    git(h.cwd, ["config", "--local", "--add", CONFIG_KEY, "outputs"]);
    await h.capture("conflict-start");
    write(h.cwd, source, "after\n");
    await h.capture("conflict-end");
    git(h.cwd, ["config", "diff.relative", "true"]);
    write(h.cwd, "code [1].ts", "root staged\n");
    git(h.cwd, ["add", "--", ":(literal)code [1].ts"]);
    write(h.cwd, "code [1].ts", "root unstaged\n");
    write(h.cwd, source, "conflicting local edit\n");
    write(h.cwd, "outputs/keep.txt", "excluded current output\n");
    const indexBefore = h.index();
    h.commands.length = 0;
    const result = await h.runtime.runPromise(
      h.store
        .reverseCheckpointDiff({
          cwd: path.join(h.cwd, "module"),
          fromCheckpointRef: ref("conflict-start"),
          toCheckpointRef: ref("conflict-end"),
        })
        .pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(h.commands.some((command) => command.args.includes("--3way"))).toBe(true);
    expect(fs.readFileSync(path.join(h.cwd, source), "utf8")).toBe("conflicting local edit\n");
    expect(fs.readFileSync(path.join(h.cwd, "module/code 1.ts"), "utf8")).toBe(
      "unrelated source\n",
    );
    expect(fs.readFileSync(path.join(h.cwd, "outputs/keep.txt"), "utf8")).toBe(
      "excluded current output\n",
    );
    expect(fs.readFileSync(path.join(h.cwd, "code [1].ts"), "utf8")).toBe("root unstaged\n");
    expect(git(h.cwd, ["show", ":code [1].ts"])).toBe("root staged\n");
    expect(h.index()).toEqual(indexBefore);
  });

  it("undoes only the selected subdirectory even when diff.relative is enabled", async () => {
    const h = await fixture();
    write(h.cwd, "module/source.txt", "module before\n");
    git(h.cwd, ["add", "."]);
    git(h.cwd, ["commit", "-m", "relative diff base"]);
    await h.capture("relative-start");
    write(h.cwd, "module/source.txt", "module after\n");
    write(h.cwd, "source.txt", "root after\n");
    await h.capture("relative-end");
    git(h.cwd, ["add", "source.txt"]);
    git(h.cwd, ["config", "diff.relative", "true"]);
    expect(await h.undo("relative-start", "relative-end", path.join(h.cwd, "module"))).toBe(true);
    expect(fs.readFileSync(path.join(h.cwd, "module/source.txt"), "utf8")).toBe("module before\n");
    expect(fs.readFileSync(path.join(h.cwd, "source.txt"), "utf8")).toBe("root after\n");
    expect(git(h.cwd, ["show", ":source.txt"])).toBe("root after\n");
  });

  it.each(["force-staged", "newly ignored"])(
    "keeps %s affected content and the real index after a conflicting undo",
    async (kind) => {
      const h = await fixture();
      write(h.cwd, ".gitignore", kind === "force-staged" ? "*.log\n" : "");
      git(h.cwd, ["add", ".gitignore"]);
      git(h.cwd, ["commit", "-m", "ignore fixture"]);
      write(h.cwd, "source.log", "before\n");
      if (kind === "force-staged") git(h.cwd, ["add", "-f", "source.log"]);
      await h.capture("ignored-start");
      write(h.cwd, "source.log", "after\n");
      await h.capture("ignored-end");
      write(h.cwd, ".gitignore", "*.log\n");
      write(h.cwd, "source.log", "conflicting local content\n");
      const indexBefore = h.index();
      h.commands.length = 0;
      const result = await h.runtime.runPromise(
        h.store
          .reverseCheckpointDiff({
            cwd: h.cwd,
            fromCheckpointRef: ref("ignored-start"),
            toCheckpointRef: ref("ignored-end"),
          })
          .pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expect(h.commands.some((command) => command.args.includes("--3way"))).toBe(true);
      expect(fs.readFileSync(path.join(h.cwd, "source.log"), "utf8")).toBe(
        "conflicting local content\n",
      );
      expect(h.index()).toEqual(indexBefore);
    },
  );
});
