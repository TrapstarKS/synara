// FILE: CheckpointStore.test.ts
// Purpose: Verifies filesystem checkpoint store behavior around expensive Git capture work.
// Layer: Checkpointing tests.
// Exports: Vitest coverage for CheckpointStoreLive.
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { CheckpointRef } from "@synara/contracts";

const REMOVE_ARTIFACTS_COMMAND =
  "rm --cached --quiet --force -r --ignore-unmatch -- :(top,icase)Artifacts";
const ADD_CHECKPOINT_PATHS_COMMAND = "add -A -- . :(exclude,top,icase)Artifacts";
let policyRoot = "";

function mockGit(implementation: GitCoreShape["execute"]) {
  return vi.fn<GitCoreShape["execute"]>((input) => {
    if (input.operation === "CheckpointStore.pathPolicy.root")
      return Effect.succeed({ code: 0, stdout: `${policyRoot}\n`, stderr: "" });
    if (input.operation === "CheckpointStore.pathPolicy.config")
      return Effect.succeed({ code: 1, stdout: "", stderr: "" });
    if (input.operation === "CheckpointStore.pathPolicy.commit")
      return Effect.succeed({ code: 0, stdout: "Legacy checkpoint\n", stderr: "" });
    return implementation(input);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("CheckpointStoreLive", () => {
  let runtime: ManagedRuntime.ManagedRuntime<CheckpointStore, unknown> | null = null;
  beforeEach(() => {
    policyRoot = mkdtempSync(join(tmpdir(), "synara-checkpoint-policy-test-"));
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    rmSync(policyRoot, { recursive: true, force: true });
  });

  it("does not classify an uninitialized Git directory as checkpointable", async () => {
    const execute = mockGit((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --is-inside-work-tree") {
        return Effect.succeed({ code: 0, stdout: "true\n", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const checkpointable = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store.isGitRepository("/repo");
      }),
    );

    expect(checkpointable).toBe(false);
  });

  it("deduplicates concurrent captures for the same checkpoint ref", async () => {
    let releaseAdd: (() => void) | undefined;
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const execute = mockGit((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: "/repo/.git/index\n", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 0, stdout: "head-oid\n", stderr: "" });
      }
      if (args === "read-tree HEAD") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === REMOVE_ARTIFACTS_COMMAND) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === ADD_CHECKPOINT_PATHS_COMMAND) {
        return Effect.promise(() => addGate).pipe(Effect.as({ code: 0, stdout: "", stderr: "" }));
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          waitFor(() =>
            execute.mock.calls.some(
              ([call]) => call.args.join(" ") === ADD_CHECKPOINT_PATHS_COMMAND,
            ),
          ),
        );
        const second = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        expect(
          execute.mock.calls.filter(
            ([call]) => call.args.join(" ") === ADD_CHECKPOINT_PATHS_COMMAND,
          ),
        ).toHaveLength(1);

        releaseAdd?.();
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }),
    );
  });

  it("bounds expensive captures across distinct threads and repositories", async () => {
    let active = 0;
    let peak = 0;
    let completed = 0;
    const execute = mockGit((input) => {
      if (input.args[0] === "add") {
        return Effect.acquireUseRelease(
          Effect.sync(() => {
            active += 1;
            peak = Math.max(peak, active);
          }),
          () => Effect.sleep("10 millis").pipe(Effect.as({ code: 0, stdout: "", stderr: "" })),
          () =>
            Effect.sync(() => {
              active -= 1;
              completed += 1;
            }),
        );
      }
      return Effect.succeed({ code: 0, stdout: "oid\n", stderr: "" });
    });
    runtime = ManagedRuntime.make(
      CheckpointStoreLive.pipe(
        Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
        Layer.provide(NodeServices.layer),
      ),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        yield* Effect.forEach(
          Array.from({ length: 20 }, (_, index) => index),
          (index) =>
            store.captureCheckpoint({
              cwd: `/repo-${index % 3}`,
              checkpointRef: CheckpointRef.makeUnsafe(
                `refs/synara-checkpoints/thread-${index}/turn`,
              ),
            }),
          { concurrency: "unbounded" },
        );
      }),
    );
    expect(completed).toBe(20);
    expect(active).toBe(0);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("expires queued captures and permits a retry after the holders finish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let adds = 0;
    const execute = mockGit((input) => {
      if (input.args[0] === "add") {
        return Effect.acquireUseRelease(
          Effect.sync(() => {
            active += 1;
            adds += 1;
          }),
          () => Effect.promise(() => gate).pipe(Effect.as({ code: 0, stdout: "", stderr: "" })),
          () =>
            Effect.sync(() => {
              active -= 1;
            }),
        );
      }
      return Effect.succeed({ code: 0, stdout: "oid\n", stderr: "" });
    });
    runtime = ManagedRuntime.make(
      CheckpointStoreLive.pipe(
        Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
        Layer.provide(NodeServices.layer),
      ),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = (index: number) => ({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(`refs/synara-checkpoints/thread-${index}/turn`),
        });
        const holders = yield* Effect.forEach(
          [0, 1],
          (index) => store.captureCheckpoint(input(index)),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* Effect.promise(() => waitFor(() => active === 2));
        const queued = yield* store
          .captureCheckpoint({ ...input(2), timeoutMs: 10 })
          .pipe(Effect.flip);
        expect(queued.detail).toContain("timed out");
        expect(adds).toBe(2);
        release();
        yield* Fiber.join(holders);
        yield* store.captureCheckpoint({ ...input(2), timeoutMs: 1_000 });
        expect(adds).toBe(3);
        expect(active).toBe(0);
      }),
    );
  });

  it("seeds a capture from the working index so Git can reuse its stat cache", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "synara-checkpoint-index-test-"));
    const workingIndexPath = join(tempDir, "index");
    writeFileSync(workingIndexPath, "working-index-stat-cache");
    const workingIndexTime = new Date("2020-01-02T03:04:05.000Z");
    utimesSync(workingIndexPath, workingIndexTime, workingIndexTime);
    let capturedSeed = "";
    let capturedIndexMtimeMs = 0;

    const execute = mockGit((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: `${workingIndexPath}\n`, stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 0, stdout: "head-oid\n", stderr: "" });
      }
      if (args === "update-index --really-refresh") {
        const captureIndexPath = input.env?.GIT_INDEX_FILE ?? "";
        const refreshTime = new Date("2025-01-02T03:04:05.000Z");
        utimesSync(captureIndexPath, refreshTime, refreshTime);
        return Effect.succeed({ code: 1, stdout: "", stderr: "README.md: needs update\n" });
      }
      if (args === REMOVE_ARTIFACTS_COMMAND) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === ADD_CHECKPOINT_PATHS_COMMAND) {
        const captureIndexPath = input.env?.GIT_INDEX_FILE ?? "";
        capturedSeed = readFileSync(captureIndexPath, "utf8");
        capturedIndexMtimeMs = statSync(captureIndexPath).mtimeMs;
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* CheckpointStore;
          yield* store.captureCheckpoint({
            cwd: tempDir,
            checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/stat-cache"),
          });
        }),
      );

      expect(capturedSeed).toBe("working-index-stat-cache");
      expect(capturedIndexMtimeMs).toBe(workingIndexTime.getTime());
      expect(
        execute.mock.calls.some(
          ([call]) => call.args.join(" ") === "update-index --really-refresh",
        ),
      ).toBe(true);
      expect(
        execute.mock.calls.some(([call]) => call.args.join(" ") === "rev-parse --verify HEAD"),
      ).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clears in-flight capture state when the owner is interrupted", async () => {
    let addCalls = 0;
    const execute = mockGit((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: "/repo/.git/index\n", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 0, stdout: "head-oid\n", stderr: "" });
      }
      if (args === "read-tree HEAD") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === REMOVE_ARTIFACTS_COMMAND) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === ADD_CHECKPOINT_PATHS_COMMAND) {
        addCalls += 1;
        if (addCalls === 1) {
          return Effect.never;
        }
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => waitFor(() => addCalls === 1));
        const waiter = yield* store.captureCheckpoint(input).pipe(
          Effect.map(() => "completed" as const),
          Effect.catch((error) => Effect.succeed(error._tag)),
          Effect.forkChild,
        );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        yield* Fiber.interrupt(first);
        // The owner's interruption must surface to waiters as a typed store
        // error, not replay as the waiter's own fiber being interrupted.
        const waiterResult = yield* Fiber.join(waiter);
        expect(waiterResult).toBe("CheckpointInvariantError");

        const thirdResult = yield* store
          .captureCheckpoint(input)
          .pipe(Effect.timeoutOption("100 millis"));
        expect(Option.isSome(thirdResult)).toBe(true);
        expect(addCalls).toBe(2);
      }),
    );
  });

  it("skips every capture when a repository has no HEAD commit", async () => {
    const missingRef = "refs/synara-checkpoints/thread/missing";
    const execute = mockGit((input) => {
      const args = input.args.join(" ");
      if (args === `rev-parse --verify --quiet ${missingRef}^{commit}`) {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: "/repo/.git/index\n", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        yield* store.captureCheckpoint({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(missingRef),
        });
      }),
    );

    expect(
      execute.mock.calls.some(([call]) => call.args.join(" ") === ADD_CHECKPOINT_PATHS_COMMAND),
    ).toBe(false);
  });

  it("skips the capture when skipIfExists is set and the ref already exists", async () => {
    const existingRef = "refs/synara-checkpoints/thread/existing";
    const missingRef = "refs/synara-checkpoints/thread/missing";
    const execute = mockGit((input) => {
      const args = input.args.join(" ");
      if (args === `rev-parse --verify --quiet ${existingRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "existing-commit\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${missingRef}^{commit}`) {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: "/repo/.git/index\n", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 0, stdout: "head-oid\n", stderr: "" });
      }
      if (args === "read-tree HEAD") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === REMOVE_ARTIFACTS_COMMAND) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === ADD_CHECKPOINT_PATHS_COMMAND) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const captureArgs = (args: string) =>
          execute.mock.calls.filter(([call]) => call.args.join(" ") === args);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(existingRef),
          skipIfExists: true,
        });
        expect(captureArgs(ADD_CHECKPOINT_PATHS_COMMAND)).toHaveLength(0);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(missingRef),
          skipIfExists: true,
        });
        expect(captureArgs(ADD_CHECKPOINT_PATHS_COMMAND)).toHaveLength(1);
        expect(captureArgs(`update-ref ${missingRef} commit-oid`)).toHaveLength(1);
      }),
    );
  });

  it("restores the worktree patch when resetting the index fails during file undo", async () => {
    const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/start");
    const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/end");
    const commands: string[] = [];
    const execute = mockGit((input) => {
      const args = input.args.join(" ");
      commands.push(args);
      if (args === `rev-parse --verify --quiet ${fromRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "from-oid\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${toRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "to-oid\n", stderr: "" });
      }
      if (args.startsWith("diff --patch --binary --full-index")) {
        return Effect.succeed({ code: 0, stdout: "turn patch", stderr: "" });
      }
      if (
        args ===
        "diff --name-only --no-renames --no-relative -z from-oid to-oid -- . :(exclude,top,icase)Artifacts"
      ) {
        return Effect.succeed({ code: 0, stdout: "src/file.ts\0", stderr: "" });
      }
      if (input.args[0] === "apply" && input.args[1] === "--reverse") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "reset --quiet from-oid -- :(top,literal)src/file.ts") {
        return Effect.fail(
          new GitCommandError({
            operation: input.operation,
            command: args,
            cwd: input.cwd,
            detail: "reset failed",
          }),
        );
      }
      if (input.args[0] === "apply" && input.args[1] === "--whitespace=nowarn") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .reverseCheckpointDiff({
            cwd: "/repo",
            fromCheckpointRef: fromRef,
            toCheckpointRef: toRef,
          })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
      }),
    );

    expect(result).toBe("GitCommandError");
    expect(commands.filter((command) => command.startsWith("apply "))).toHaveLength(2);
    expect(commands.at(-1)).toMatch(/^apply --whitespace=nowarn -- /);
  });

  it("fails when a checkpoint ref cannot be deleted", async () => {
    const lockedRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/locked");
    const deletableRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/ok");
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === `update-ref -d ${lockedRef}`) {
        return Effect.succeed({ code: 1, stdout: "", stderr: "cannot lock ref\n" });
      }
      if (args === `update-ref -d ${deletableRef}`) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .deleteCheckpointRefs({ cwd: "/repo", checkpointRefs: [deletableRef, lockedRef] })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
      }),
    );

    // Every ref is still attempted; one loser must not abandon the batch.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).not.toBe("success");
    expect(result).toContain(lockedRef);
    expect(result).toContain("cannot lock ref");
    expect(result).not.toContain(deletableRef);
  });

  it.each([
    { code: 1, stdout: "", stderr: "listing failed" },
    { code: 0, stdout: "", stderr: "", stdoutTruncated: true },
  ])(
    "does not delete affected files when the rollback tree listing fails or truncates (%j)",
    async (listing) => {
      const file = join(policyRoot, "source.txt");
      writeFileSync(file, "keep these bytes\n");
      const execute = mockGit((input) => {
        const args = input.args.join(" ");
        if (args.includes("^{commit}"))
          return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
        if (args.startsWith("diff --patch"))
          return Effect.succeed({ code: 0, stdout: "fixture patch", stderr: "" });
        if (args.startsWith("diff --name-only"))
          return Effect.succeed({ code: 0, stdout: "source.txt\0", stderr: "" });
        if (input.args[0] === "apply")
          return Effect.succeed({ code: 1, stdout: "", stderr: "conflict" });
        if (args === "rev-parse --verify HEAD")
          return Effect.succeed({ code: 0, stdout: "head\n", stderr: "" });
        if (args === "rev-parse --git-path index")
          return Effect.succeed({
            code: 0,
            stdout: `${join(policyRoot, "absent-index")}\n`,
            stderr: "",
          });
        if (args === "read-tree HEAD" || input.args[0] === "rm" || input.args[0] === "add")
          return Effect.succeed({ code: 0, stdout: "", stderr: "" });
        if (args === "write-tree")
          return Effect.succeed({ code: 0, stdout: "before-tree\n", stderr: "" });
        if (input.args.includes("ls-tree")) {
          expect(input.cwd).toBe(policyRoot);
          expect(input.args).toContain("--literal-pathspecs");
          expect(input.args).toContain("--full-tree");
          expect(input.allowNonZeroExit).not.toBe(true);
          return Effect.succeed(listing);
        }
        throw new Error(`Unexpected git args: ${args}`);
      });
      runtime = ManagedRuntime.make(
        CheckpointStoreLive.pipe(
          Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
          Layer.provide(NodeServices.layer),
        ),
      );
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* CheckpointStore;
          return yield* store
            .reverseCheckpointDiff({
              cwd: policyRoot,
              fromCheckpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/test/start"),
              toCheckpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/test/end"),
            })
            .pipe(Effect.result);
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(readFileSync(file, "utf8")).toBe("keep these bytes\n");
      expect(
        execute.mock.calls.some(
          ([input]) => input.args[0] === "restore" || input.args[0] === "reset",
        ),
      ).toBe(false);
    },
  );

  it("tolerates deleting checkpoint refs that are already absent", async () => {
    // `git update-ref -d` exits 0 for a ref that does not exist, so the
    // exit-code check must not turn best-effort cleanup into a hard failure.
    const missingRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/gone");
    const execute = vi.fn<GitCoreShape["execute"]>(() =>
      Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    );
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .deleteCheckpointRefs({ cwd: "/repo", checkpointRefs: [missingRef] })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
      }),
    );

    expect(result).toBe("success");
  });
});
