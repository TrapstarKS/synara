import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import {
  confirmDeletedCodexRuntimeStopped,
  DELETED_CODEX_ARTIFACT_RETENTION_MS,
  pruneDeletedCodexArtifacts,
  rememberDeletedCodexArtifacts,
} from "./codexArtifactRetention";
import { ServerConfig, type ServerConfigShape } from "./config";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";

const nativeId = "01a09c5e-7435-7253-9234-186ac7f3d5e4";
const profileId = "8de6c075-eab9-4a10-aa8b-d31004113c0b";
const now = new Date("2026-10-08T12:00:00.000Z");
const old = new Date(now.getTime() - DELETED_CODEX_ARTIFACT_RETENTION_MS - 60_000);
const temporaryHomes: string[] = [];

afterEach(async () => {
  for (const home of temporaryHomes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});

async function fixture() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-codex-retention-"));
  temporaryHomes.push(baseDir);
  const stateDir = path.join(baseDir, "userdata");
  await fs.mkdir(stateDir);
  const overlay = path.join(baseDir, "codex-home-overlays", profileId);
  const rollout = path.join(
    overlay,
    "sessions",
    "2026",
    "09",
    "13",
    `rollout-2026-09-13T17-03-51-${nativeId}.jsonl`,
  );
  const image = path.join(overlay, "generated_images", nativeId, "image.png");
  for (const file of [rollout, image]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "retained data");
    await fs.utimes(file, old, old);
  }
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | ServerConfig>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(ServerConfig, { baseDir, stateDir } as ServerConfigShape),
        Effect.provide(SqlitePersistenceMemory),
      ),
    );
  return { baseDir, stateDir, rollout, image, run };
}

const insertDeletedThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { baseDir } = yield* ServerConfig;
  yield* sql`
    INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
      runtime_mode, interaction_mode, env_mode, created_at, updated_at, deleted_at)
    VALUES ('deleted', 'project', 'Deleted', '{"provider":"codex","model":"gpt-6.1-sol"}',
      'full-access', 'default', 'local', ${old.toISOString()}, ${old.toISOString()}, ${old.toISOString()})
  `;
  yield* sql`
    INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, runtime_mode,
      status, lifecycle_generation, last_seen_at, resume_cursor_json, runtime_payload_json)
    VALUES ('deleted', 'codex', 'codex', 'full-access', 'running', 'g', ${old.toISOString()},
      ${JSON.stringify({ threadId: nativeId })},
      ${JSON.stringify({ providerOptions: { codex: { homePath: path.join(baseDir, "codex-home-overlays", profileId) } } })})
  `;
});

const purge = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = 'deleted'`;
  yield* sql`DELETE FROM projection_threads WHERE thread_id = 'deleted'`;
});

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

describe("deleted Codex artifacts", () => {
  it("requires proven teardown and permanent purge; keeps active and archived resume files", async () => {
    const f = await fixture();
    await f.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertDeletedThread;
        yield* rememberDeletedCodexArtifacts("deleted");
        yield* confirmDeletedCodexRuntimeStopped("deleted");
        yield* pruneDeletedCodexArtifacts(now);
        expect(yield* Effect.promise(() => exists(f.rollout))).toBe(true);
        yield* purge;
        // Any surviving binding, even stopped/archived, protects the native rollout.
        yield* sql`
        INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, runtime_mode,
          status, lifecycle_generation, last_seen_at, resume_cursor_json)
        VALUES ('archived', 'codex', 'codex', 'full-access', 'stopped', 'g', ${old.toISOString()},
          ${JSON.stringify({ threadId: nativeId })})
      `;
        yield* pruneDeletedCodexArtifacts(now);
        expect(yield* Effect.promise(() => exists(f.rollout))).toBe(true);
        yield* sql`UPDATE provider_session_runtime SET status = 'running'`;
        yield* pruneDeletedCodexArtifacts(now);
        expect(yield* Effect.promise(() => exists(f.rollout))).toBe(true);
        yield* sql`DELETE FROM provider_session_runtime`;
        yield* pruneDeletedCodexArtifacts(now);
      }),
    );
    expect(await exists(f.rollout)).toBe(false);
    expect(await exists(f.image)).toBe(false);
  });

  it("keeps files if teardown was interrupted or the file was modified recently", async () => {
    const f = await fixture();
    await f.run(
      Effect.gen(function* () {
        yield* insertDeletedThread;
        yield* rememberDeletedCodexArtifacts("deleted");
        yield* purge;
        yield* pruneDeletedCodexArtifacts(now);
        expect(yield* Effect.promise(() => exists(f.rollout))).toBe(true);
        yield* confirmDeletedCodexRuntimeStopped("deleted");
        yield* Effect.promise(() => fs.utimes(f.rollout, now, now));
        yield* pruneDeletedCodexArtifacts(now);
      }),
    );
    expect(await exists(f.rollout)).toBe(true);
  });

  it("retains images referenced by surviving fork messages until the reference is gone", async () => {
    const f = await fixture();
    await f.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertDeletedThread;
        yield* rememberDeletedCodexArtifacts("deleted");
        yield* confirmDeletedCodexRuntimeStopped("deleted");
        yield* purge;
        yield* sql`
        INSERT INTO projection_thread_messages (thread_id, message_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('fork', 'image', 'assistant', ${`![image](${f.image})`}, 0, ${old.toISOString()}, ${old.toISOString()})
      `;
        yield* pruneDeletedCodexArtifacts(now);
        expect(yield* Effect.promise(() => exists(f.rollout))).toBe(false);
        expect(yield* Effect.promise(() => exists(f.image))).toBe(true);
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* pruneDeletedCodexArtifacts(now);
      }),
    );
    expect(await exists(f.image)).toBe(false);
  });

  it("never follows an overlay sessions symlink into a CLI or another channel home", async () => {
    const f = await fixture();
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cli-home-"));
    temporaryHomes.push(external);
    const externalRollout = path.join(external, `rollout-${nativeId}.jsonl`);
    await fs.writeFile(externalRollout, "CLI data");
    await fs.utimes(externalRollout, old, old);
    const sessions = path.join(f.baseDir, "codex-home-overlays", profileId, "sessions");
    await fs.rm(sessions, { recursive: true });
    await fs.symlink(external, sessions, "dir");
    await f.run(
      Effect.gen(function* () {
        yield* insertDeletedThread;
        yield* rememberDeletedCodexArtifacts("deleted");
        yield* confirmDeletedCodexRuntimeStopped("deleted");
        yield* purge;
        yield* pruneDeletedCodexArtifacts(now);
      }),
    );
    expect(await fs.readFile(externalRollout, "utf8")).toBe("CLI data");
  });

  it("rejects tampered manifests and preserves unknown orphan rollouts", async () => {
    const f = await fixture();
    await f.run(
      Effect.gen(function* () {
        yield* insertDeletedThread;
        yield* rememberDeletedCodexArtifacts("deleted");
        yield* confirmDeletedCodexRuntimeStopped("deleted");
        yield* purge;
        yield* Effect.promise(async () => {
          const directory = path.join(f.stateDir, "deleted-codex-artifacts");
          const [name] = await fs.readdir(directory);
          const file = path.join(directory, name!);
          const record = JSON.parse(await fs.readFile(file, "utf8"));
          record.files.push("../codex/sessions/external.jsonl");
          await fs.writeFile(file, JSON.stringify(record));
        });
        yield* pruneDeletedCodexArtifacts(now);
      }),
    );
    expect(await exists(f.rollout)).toBe(true);
    const unknown = await fixture();
    await unknown.run(pruneDeletedCodexArtifacts(now));
    expect(await exists(unknown.rollout)).toBe(true);
  });

  it("keeps matching rollouts in a different profile and rejects a Beta home launch", async () => {
    const f = await fixture();
    const otherProfile = path.join(
      f.baseDir,
      "codex-home-overlays",
      "4ae646ed-62ad-4e45-965a-d11cd459a853",
      "sessions",
      `rollout-${nativeId}.jsonl`,
    );
    await fs.mkdir(path.dirname(otherProfile), { recursive: true });
    await fs.writeFile(otherProfile, "other profile");
    await fs.utimes(otherProfile, old, old);
    await f.run(
      Effect.gen(function* () {
        yield* insertDeletedThread;
        yield* rememberDeletedCodexArtifacts("deleted");
        yield* confirmDeletedCodexRuntimeStopped("deleted");
        yield* purge;
        yield* pruneDeletedCodexArtifacts(now);
      }),
    );
    expect(await exists(f.rollout)).toBe(false);
    expect(await exists(otherProfile)).toBe(true);
    const beta = await fixture();
    await beta.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertDeletedThread;
        yield* sql`UPDATE provider_session_runtime SET runtime_payload_json = ${JSON.stringify({ providerOptions: { codex: { homePath: path.dirname(path.dirname(otherProfile)) } } })}`;
        expect(yield* rememberDeletedCodexArtifacts("deleted")).toBe(false);
        yield* purge;
        yield* pruneDeletedCodexArtifacts(now);
      }),
    );
    expect(await exists(otherProfile)).toBe(true);
  });

  it("captures files produced during teardown, and respects a recent deletion timestamp", async () => {
    const f = await fixture();
    const lateImage = path.join(path.dirname(f.image), "during-stop.png");
    await f.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertDeletedThread;
        yield* sql`UPDATE projection_threads SET deleted_at = ${now.toISOString()}`;
        yield* rememberDeletedCodexArtifacts("deleted");
        yield* Effect.promise(async () => {
          await fs.writeFile(lateImage, "late image");
          await fs.utimes(lateImage, old, old);
        });
        yield* confirmDeletedCodexRuntimeStopped("deleted");
        yield* purge;
        yield* pruneDeletedCodexArtifacts(now);
        expect(yield* Effect.promise(() => exists(lateImage))).toBe(true);
        yield* pruneDeletedCodexArtifacts(
          new Date(now.getTime() + DELETED_CODEX_ARTIFACT_RETENTION_MS + 1),
        );
      }),
    );
    expect(await exists(lateImage)).toBe(false);
  });
});
