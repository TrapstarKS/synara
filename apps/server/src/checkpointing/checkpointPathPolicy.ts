// Checkpoint-only exclusions. Git's normal tracked/ignored behavior is otherwise
// unchanged. Policies travel with commits so removing a local setting cannot
// turn an intentionally omitted output into a deletion during restore/undo.
import { readdir } from "node:fs/promises";
import { Effect } from "effect";
import { isWorkspaceRelativePathSafe } from "@synara/shared/path";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { CheckpointInvariantError } from "./Errors.ts";

export const CHECKPOINT_EXCLUDE_CONFIG = "synara.checkpointExcludePath";
export const CHECKPOINT_POLICY_TRAILER = "Synara-Checkpoint-Policy: ";
const MAX_POLICY_BYTES = 16 * 1024;
const MAX_POLICY_PATHS = 128;

export interface CheckpointPathPolicy {
  readonly version: 1;
  readonly excludedPaths: readonly string[];
}

export interface ResolvedCheckpointPathPolicy {
  readonly repositoryRoot: string;
  readonly policy: CheckpointPathPolicy;
}

function invalidPolicy(detail: string, cause?: unknown): CheckpointInvariantError {
  return new CheckpointInvariantError({
    operation: "CheckpointStore.pathPolicy",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function makeCheckpointPathPolicy(values: readonly unknown[]): CheckpointPathPolicy {
  if (values.length > MAX_POLICY_PATHS) throw new Error("Too many checkpoint exclusion paths.");
  const paths = values.map((value) => {
    if (typeof value !== "string") throw new Error("Checkpoint exclusion paths must be strings.");
    const normalized = value.replace(/\/+$/, "");
    if (
      normalized.length > 1024 ||
      !isWorkspaceRelativePathSafe(normalized) ||
      normalized.includes("\\") ||
      [...normalized].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      normalized.split("/").some((part) => !part || part.toLowerCase() === ".git")
    )
      throw new Error("Checkpoint exclusions must be safe repository-relative literal paths.");
    return normalized;
  });
  const excludedPaths = [...new Set(paths)].toSorted();
  if (Buffer.byteLength(JSON.stringify(excludedPaths)) > MAX_POLICY_BYTES)
    throw new Error("Checkpoint exclusion policy is too large.");
  return { version: 1, excludedPaths };
}

export function mergeCheckpointPathPolicies(
  ...policies: readonly CheckpointPathPolicy[]
): CheckpointPathPolicy {
  return makeCheckpointPathPolicy([...new Set(policies.flatMap((policy) => policy.excludedPaths))]);
}

export function checkpointExcludedPathspecs(policy: CheckpointPathPolicy): string[] {
  return [
    ":(exclude,top,icase)Artifacts",
    ...policy.excludedPaths.map((file) => `:(exclude,top,literal)${file}`),
  ];
}

export function checkpointRemovalPathspecs(policy: CheckpointPathPolicy): string[] {
  return [":(top,icase)Artifacts", ...policy.excludedPaths.map((file) => `:(top,literal)${file}`)];
}

export function checkpointPolicyTrailer(policy: CheckpointPathPolicy): string {
  return `${CHECKPOINT_POLICY_TRAILER}${JSON.stringify(policy)}`;
}

export function parseCheckpointPolicyMessage(message: string): CheckpointPathPolicy {
  const records = message
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Synara-Checkpoint-Policy:"));
  if (records.length === 0) return makeCheckpointPathPolicy([]); // Legacy reserved Artifacts policy.
  if (records.length !== 1 || !records[0]!.startsWith(CHECKPOINT_POLICY_TRAILER))
    throw new Error("Ambiguous checkpoint exclusion policy.");
  const raw = records[0]!.slice(CHECKPOINT_POLICY_TRAILER.length);
  if (Buffer.byteLength(raw) > MAX_POLICY_BYTES + 512)
    throw new Error("Checkpoint exclusion policy is too large.");
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("excludedPaths" in value) ||
    !Array.isArray(value.excludedPaths)
  )
    throw new Error("Unsupported checkpoint exclusion policy.");
  return makeCheckpointPathPolicy(value.excludedPaths);
}

/** Only names of root directories are inferred; tracked source and symlinks are
 * never inferred to be outputs. Other names require an explicit local setting. */
export function isCheckpointGeneratedDirectoryName(name: string): boolean {
  return /^(?:artefacts|\.artifacts|\.artefacts|(?:artifacts|artefacts)-[a-z0-9][a-z0-9._-]*)$/i.test(
    name,
  );
}

export function makeCheckpointPathPolicyResolver(git: GitCoreShape) {
  const current = (cwd: string, indexEnv?: NodeJS.ProcessEnv) =>
    Effect.gen(function* () {
      const rootResult = yield* git.execute({
        operation: "CheckpointStore.pathPolicy.root",
        cwd,
        args: ["rev-parse", "--show-toplevel"],
      });
      const repositoryRoot = rootResult.stdout.replace(/\r?\n$/, "");
      if (!repositoryRoot) return yield* invalidPolicy("Git returned no repository root.");
      const configured = yield* git.execute({
        operation: "CheckpointStore.pathPolicy.config",
        cwd: repositoryRoot,
        args: ["config", "--local", "--null", "--get-all", CHECKPOINT_EXCLUDE_CONFIG],
        allowNonZeroExit: true,
        maxOutputBytes: MAX_POLICY_BYTES + 512,
      });
      if (configured.code !== 0 && !(configured.code === 1 && configured.stdout === ""))
        return yield* invalidPolicy("Could not read checkpoint exclusion configuration.");
      const explicit = yield* Effect.try({
        try: () => {
          if (configured.stdout && !configured.stdout.endsWith("\0"))
            throw new Error("Incomplete Git config output.");
          return makeCheckpointPathPolicy(
            configured.stdout ? configured.stdout.slice(0, -1).split("\0") : [],
          );
        },
        catch: (cause) => invalidPolicy("Invalid checkpoint exclusion configuration.", cause),
      });
      const entries = yield* Effect.tryPromise({
        try: () => readdir(repositoryRoot, { withFileTypes: true }),
        catch: (cause) => invalidPolicy("Could not inspect checkpoint root directories.", cause),
      });
      const candidates = entries
        .filter((entry) => entry.isDirectory() && isCheckpointGeneratedDirectoryName(entry.name))
        .map((entry) => entry.name)
        .toSorted();
      if (candidates.length > MAX_POLICY_PATHS)
        return yield* invalidPolicy("Too many generated checkpoint directories.");
      const inferred: string[] = [];
      if (candidates.length) {
        const head = yield* git.execute({
          operation: "CheckpointStore.pathPolicy.head",
          cwd: repositoryRoot,
          args: ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"],
          allowNonZeroExit: true,
        });
        if (head.code !== 0 && head.code !== 1)
          return yield* invalidPolicy("Could not inspect the checkpoint HEAD tree.");
        // --with-tree also protects HEAD paths removed from the copied index. Probe
        // only candidate roots, and use the exit code, so a large tracked source
        // directory cannot overflow a full-index listing or be mistaken for output.
        for (const name of candidates) {
          const tracked = yield* git.execute({
            operation: "CheckpointStore.pathPolicy.tracked",
            cwd: repositoryRoot,
            args: [
              "ls-files",
              "--cached",
              "--error-unmatch",
              ...(head.code === 0 ? [`--with-tree=${head.stdout.trim()}`] : []),
              "-z",
              "--",
              `:(top,icase,literal)${name}`,
            ],
            env: { ...indexEnv, GIT_OPTIONAL_LOCKS: "0" },
            allowNonZeroExit: true,
            maxOutputBytes: 4096,
            outputMode: "truncate",
          });
          if (tracked.code === 1) inferred.push(name);
          else if (tracked.code !== 0)
            return yield* invalidPolicy(
              "Could not verify whether a generated directory contains tracked source.",
            );
        }
      }
      const policy = yield* Effect.try({
        try: () => mergeCheckpointPathPolicies(explicit, makeCheckpointPathPolicy(inferred)),
        catch: (cause) => invalidPolicy("Invalid combined checkpoint exclusion policy.", cause),
      });
      return { repositoryRoot, policy } satisfies ResolvedCheckpointPathPolicy;
    });

  const forCommits = (cwd: string, commits: readonly string[]) =>
    Effect.gen(function* () {
      const resolved = yield* current(cwd);
      const policies = [resolved.policy];
      for (const commit of new Set(commits)) {
        const message = yield* git.execute({
          operation: "CheckpointStore.pathPolicy.commit",
          cwd,
          args: ["show", "--no-patch", "--format=%B", commit, "--"],
          maxOutputBytes: 64 * 1024,
        });
        policies.push(
          yield* Effect.try({
            try: () => parseCheckpointPolicyMessage(message.stdout),
            catch: (cause) =>
              invalidPolicy(
                "Invalid historical checkpoint exclusion policy; restore was refused.",
                cause,
              ),
          }),
        );
      }
      const policy = yield* Effect.try({
        try: () => mergeCheckpointPathPolicies(...policies),
        catch: (cause) =>
          invalidPolicy("Combined checkpoint exclusion policy exceeds its safe limits.", cause),
      });
      return { ...resolved, policy };
    });
  return { current, forCommits };
}
