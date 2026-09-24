import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { pruneStorageHistory, STORAGE_RETENTION_MS } from "./StorageMaintenance.ts";

const layer = it.layer(SqlitePersistenceMemory);

const now = new Date("2026-09-24T00:00:00.000Z");
const old = new Date(now.getTime() - STORAGE_RETENTION_MS - 60_000).toISOString();
const recent = new Date(now.getTime() - 60_000).toISOString();

layer("pruneStorageHistory", (it) => {
  it.effect("drops old provider receipts and deltas of finished messages only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_events`;
      yield* sql`DELETE FROM orchestration_command_receipts`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM orchestration_consumer_state`;

      const receipt = (commandId: string, acceptedAt: string) => sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status
        ) VALUES (${commandId}, 'thread', 't', ${acceptedAt}, 1, 'accepted')
      `;
      yield* receipt("provider:old", old);
      yield* receipt("provider:recent", recent);
      yield* receipt("user-command-old", old);

      let version = 0;
      const event = (messageId: string, text: string, streaming: boolean, at: string) => {
        version += 1;
        return sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`event-${version}`}, 'thread', 't', ${version}, 'thread.message-sent', ${at},
            'provider', ${JSON.stringify({ messageId, role: "assistant", text, streaming })}, '{}'
          )
        `;
      };
      // Finished message: deltas go, the final full-text event stays.
      yield* event("done", "Hel", true, old);
      yield* event("done", "lo", true, old);
      yield* event("done", "Hello", false, old);
      // Final event without text: the deltas are still the only copy.
      yield* event("empty-final", "kept", true, old);
      yield* event("empty-final", "", false, old);
      // Still streaming: nothing to replace the deltas yet.
      yield* event("streaming", "kept", true, old);
      // Finished but inside the retention window.
      yield* event("fresh", "kept", true, recent);
      yield* event("fresh", "kept", false, recent);

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('p', 1000000, ${recent})
      `;
      yield* pruneStorageHistory(now);

      const receipts = yield* sql<{ readonly id: string }>`
        SELECT command_id AS id FROM orchestration_command_receipts ORDER BY command_id
      `;
      assert.deepStrictEqual(
        receipts.map((row) => row.id),
        ["provider:recent", "user-command-old"],
      );
      const events = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM orchestration_events ORDER BY sequence
      `;
      assert.deepStrictEqual(
        events.map((row) => JSON.parse(row.payload).text),
        ["Hello", "kept", "", "kept", "kept", "kept"],
      );
    }),
  );

  it.effect("keeps deltas that projectors have not applied yet", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_events`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM orchestration_consumer_state`;
      for (const [index, [text, streaming]] of (
        [
          ["a", true],
          ["a", false],
        ] as const
      ).entries()) {
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`lag-${index}`}, 'thread', 't', ${index + 1}, 'thread.message-sent', ${old},
            'provider', ${JSON.stringify({ messageId: "m", role: "assistant", text, streaming })}, '{}'
          )
        `;
      }
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('behind', 0, ${recent})
      `;
      yield* pruneStorageHistory(now);
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
      `;
      assert.strictEqual(rows[0]?.count, 2);
    }),
  );
});
