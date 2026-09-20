import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("profile token pricing archive migration", (it) => {
  it.effect("adds a durable raw-pricing archive and remains replay-safe", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 112 });

      const before = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'profile_stats_deleted_token_pricing'
      `;
      assert.equal(before[0]?.count, 0);

      yield* runMigrations({ toMigrationInclusive: 113 });
      yield* sql`
        INSERT INTO profile_stats_deleted_token_pricing (
          thread_id, row_index, provider, model, input_tokens,
          cached_input_tokens, cache_write_input_tokens, output_tokens,
          fast_mode, last_input_tokens
        ) VALUES (
          'purged-thread', 0, 'codex', 'gpt-5.6-sol', 300000,
          250000, 10000, 10000, NULL, 300000
        )
      `;

      yield* runMigrations();
      assert.deepEqual(
        yield* sql`
          SELECT thread_id, row_index, provider, model, input_tokens,
            cached_input_tokens, cache_write_input_tokens, output_tokens,
            fast_mode, last_input_tokens
          FROM profile_stats_deleted_token_pricing
        `,
        [
          {
            thread_id: "purged-thread",
            row_index: 0,
            provider: "codex",
            model: "gpt-5.6-sol",
            input_tokens: 300000,
            cached_input_tokens: 250000,
            cache_write_input_tokens: 10000,
            output_tokens: 10000,
            fast_mode: null,
            last_input_tokens: 300000,
          },
        ],
      );
    }),
  );
});
