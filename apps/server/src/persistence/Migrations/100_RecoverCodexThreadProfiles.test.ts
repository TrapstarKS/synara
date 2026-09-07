import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("100_RecoverCodexThreadProfiles", (it) => {
  it.effect("restores the account that actually handled a Codex thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 99 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, model_selection_json
        ) VALUES (
          'thread-profile', 'project-1', 'Profile thread',
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
          '{"provider":"codex","model":"gpt-5.6-luna"}'
        )
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, status, runtime_payload_json, last_seen_at
        ) VALUES (
          'thread-profile', 'codex', 'codex', 'stopped',
          '{"providerOptions":{"codex":{"profileId":"679c91a5-a4f8-4f19-b2ca-2744bc779d89"}}}',
          '2026-01-01T00:00:00Z'
        )
      `;

      yield* runMigrations();

      const [thread] = yield* sql<{ readonly profileId: string }>`
        SELECT json_extract(model_selection_json, '$.profileId') AS "profileId"
        FROM projection_threads WHERE thread_id = 'thread-profile'
      `;
      assert.strictEqual(thread?.profileId, "679c91a5-a4f8-4f19-b2ca-2744bc779d89");
    }),
  );
});
