import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("goal blocker streak migration", (it) => {
  it.effect("adds durable blocker state with a safe zero default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 122 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
        WHERE name IN ('goal_block_count', 'goal_block_last_turn_id')
      `;
      assert.deepStrictEqual(before, []);

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 123 }), [
        [123, "ProjectionThreadsGoalBlockStreak"],
      ]);
      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly defaultValue: string | null;
      }>`
        SELECT name, "notnull", dflt_value AS "defaultValue"
        FROM pragma_table_info('projection_threads')
        WHERE name IN ('goal_block_count', 'goal_block_last_turn_id')
        ORDER BY cid ASC
      `;
      assert.deepStrictEqual(columns, [
        { name: "goal_block_count", notnull: 1, defaultValue: "0" },
        { name: "goal_block_last_turn_id", notnull: 0, defaultValue: null },
      ]);
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 123 }), []);
    }),
  );
});
