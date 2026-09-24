// Purpose: Bounds state.sqlite growth. Without it every streamed assistant chunk
// stays forever as its own `thread.message-sent` event plus a command receipt,
// which grew one install from 279 MB to 4 GB in two weeks.
import * as fs from "node:fs/promises";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Receipts and finished-message stream deltas older than this are reclaimed. */
export const STORAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Deletes history that nothing can read back any more:
 *
 * - `provider:*` command receipts. Their command ids are derived from provider
 *   runtime events, which are themselves dropped once their turn settles, so a
 *   week-old receipt can never deduplicate a retry again.
 * - Streaming `thread.message-sent` deltas of an assistant message that already
 *   has a later non-streaming event with non-empty text. Both projectors replace
 *   the message text with that final event's text, so replay is unchanged; only
 *   the per-segment start times of old messages are lost on a from-scratch
 *   rebuild. Deltas every projector and consumer has not applied are kept.
 */
export const pruneStorageHistory = (now: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cutoff = new Date(now.getTime() - STORAGE_RETENTION_MS).toISOString();
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // Range form so the primary-key index is used instead of a LIKE scan.
        yield* sql`
          DELETE FROM orchestration_command_receipts
          WHERE command_id >= 'provider:' AND command_id < 'provider;'
            AND accepted_at < ${cutoff}
        `;
        const applied = yield* sql<{ readonly through: number | null }>`
          SELECT MIN(sequence) AS through FROM (
            SELECT last_applied_sequence AS sequence FROM projection_state
            UNION ALL
            SELECT last_acked_sequence FROM orchestration_consumer_state
          )
        `;
        const appliedThrough = applied[0]?.through ?? 0;
        if (appliedThrough <= 0) return;
        yield* sql`DROP TABLE IF EXISTS temp.finished_assistant_messages`;
        yield* sql`
          CREATE TEMP TABLE finished_assistant_messages AS
          SELECT stream_id, json_extract(payload_json, '$.messageId') AS message_id,
            MAX(sequence) AS final_sequence
          FROM orchestration_events
          WHERE event_type = 'thread.message-sent'
            AND json_extract(payload_json, '$.role') = 'assistant'
            AND json_extract(payload_json, '$.streaming') = 0
            AND length(json_extract(payload_json, '$.text')) > 0
          GROUP BY stream_id, message_id
        `;
        yield* sql`
          CREATE INDEX temp.finished_assistant_messages_key
          ON finished_assistant_messages(stream_id, message_id)
        `;
        yield* sql`
          DELETE FROM orchestration_events
          WHERE event_type = 'thread.message-sent'
            AND occurred_at < ${cutoff}
            AND sequence <= ${appliedThrough}
            AND json_extract(payload_json, '$.streaming') = 1
            AND sequence < (
              SELECT final_sequence FROM finished_assistant_messages AS finished
              WHERE finished.stream_id = orchestration_events.stream_id
                AND finished.message_id = json_extract(orchestration_events.payload_json, '$.messageId')
            )
            AND sequence NOT IN (
              SELECT event_sequence FROM orchestration_event_deliveries
              WHERE state IN ('inflight', 'retry', 'uncertain')
            )
        `;
        yield* sql`DROP TABLE temp.finished_assistant_messages`;
      }),
    );
  });

/**
 * Returns freed pages to the filesystem. Deleting rows alone never shrinks a
 * SQLite file. Databases created before this existed use `auto_vacuum = NONE`,
 * which only a full VACUUM can switch; that one-time rewrite needs free space
 * about the size of the database and is skipped (and retried next start) when
 * it is missing. Afterwards `incremental_vacuum` is cheap.
 */
export const reclaimFreePages = (dbPath: string, options: { readonly allowFullVacuum: boolean }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    if (mode[0]?.auto_vacuum === 2) {
      yield* sql`PRAGMA incremental_vacuum`;
    } else if (options.allowFullVacuum) {
      const hasRoom = yield* Effect.promise(async () => {
        try {
          const [stats, filesystem] = await Promise.all([fs.stat(dbPath), fs.statfs(dbPath)]);
          return Number(filesystem.bavail) * Number(filesystem.bsize) > stats.size * 1.2;
        } catch {
          return false;
        }
      });
      if (!hasRoom) return;
      yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
      yield* sql`VACUUM`;
    }
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
  });

export const runStorageMaintenance = (
  dbPath: string,
  options: { readonly allowFullVacuum: boolean },
) =>
  pruneStorageHistory(new Date()).pipe(
    Effect.andThen(reclaimFreePages(dbPath, options)),
    Effect.catchCause((cause) => Effect.logWarning("sqlite storage maintenance failed", { cause })),
  );
