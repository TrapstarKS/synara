// Purpose: Bounds state.sqlite growth. Without it every streamed assistant chunk
// stays forever as its own `thread.message-sent` event plus a command receipt,
// which grew one install from 279 MB to 4 GB in two weeks.
import * as fs from "node:fs/promises";

import { Duration, Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { pruneDatabaseBackups } from "./MigrationBackup";

/** Receipts and finished-message stream deltas older than this are reclaimed. */
export const STORAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Rows per maintenance statement. bun:sqlite runs each statement synchronously,
 * so one pass over the whole history used to stall the server — sockets,
 * terminals and every command — for a minute or more on a multi-GB database.
 */
const MAINTENANCE_BATCH_ROWS = 500;
/** Lets queued commands and socket traffic run between batches. */
const MAINTENANCE_BATCH_PAUSE = Duration.millis(5);
/** Pages released per incremental_vacuum step (8 MB at the default page size). */
const VACUUM_BATCH_PAGES = 2_048;
const VACUUM_STATEMENTS_PER_BATCH = 64;

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
 *
 * Works in short batches outside a transaction so it can run while the app is
 * busy. Each batch is safe on its own: it only removes rows that stay
 * unreadable whatever commits in between.
 */
export const pruneStorageHistory = (now: Date, options: { readonly batchRows?: number } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const batchRows = options.batchRows ?? MAINTENANCE_BATCH_ROWS;
    const pause = Effect.sleep(MAINTENANCE_BATCH_PAUSE);
    const cutoff = new Date(now.getTime() - STORAGE_RETENTION_MS).toISOString();

    // Walk the provider key range one primary-key page at a time.
    let after = "provider:";
    while (true) {
      const page = yield* sql<{ readonly last: string | null }>`
        SELECT MAX(command_id) AS last FROM (
          SELECT command_id FROM orchestration_command_receipts
          WHERE command_id > ${after} AND command_id < 'provider;'
          ORDER BY command_id
          LIMIT ${batchRows}
        )
      `;
      const last = page[0]?.last ?? null;
      if (last === null) break;
      yield* sql`
        DELETE FROM orchestration_command_receipts
        WHERE command_id > ${after} AND command_id <= ${last}
          AND accepted_at < ${cutoff}
      `;
      after = last;
      yield* pause;
    }

    const applied = yield* sql<{ readonly through: number | null }>`
      SELECT MIN(sequence) AS through FROM (
        SELECT last_applied_sequence AS sequence FROM projection_state
        UNION ALL
        SELECT last_acked_sequence FROM orchestration_consumer_state
      )
    `;
    const appliedThrough = applied[0]?.through ?? 0;
    if (appliedThrough <= 0) return;
    const range = yield* sql<{ readonly first: number | null; readonly last: number | null }>`
      SELECT MIN(sequence) AS first, MAX(sequence) AS last FROM orchestration_events
    `;
    const first = range[0]?.first ?? null;
    const last = range[0]?.last ?? null;
    if (first === null || last === null) return;

    // Batches walk the primary key; `+event_type` keeps the planner off the
    // event_type index, which would scan every message event per batch.
    // Final events only ever follow their deltas, so collecting them up to the
    // current last sequence covers every delta this pass may delete.
    yield* sql`DROP TABLE IF EXISTS temp.finished_assistant_messages`;
    yield* sql`
      CREATE TEMP TABLE finished_assistant_messages (
        stream_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        final_sequence INTEGER NOT NULL,
        PRIMARY KEY (stream_id, message_id)
      )
    `;
    yield* Effect.gen(function* () {
      for (let from = first; from <= last; from += batchRows) {
        yield* sql`
          INSERT INTO finished_assistant_messages (stream_id, message_id, final_sequence)
          SELECT stream_id, json_extract(payload_json, '$.messageId'), sequence
          FROM orchestration_events
          WHERE sequence >= ${from} AND sequence < ${from + batchRows}
            AND +event_type = 'thread.message-sent'
            AND json_extract(payload_json, '$.role') = 'assistant'
            AND json_extract(payload_json, '$.streaming') = 0
            AND length(json_extract(payload_json, '$.text')) > 0
            AND json_extract(payload_json, '$.messageId') IS NOT NULL
            AND sequence <= ${appliedThrough}
          ON CONFLICT (stream_id, message_id) DO UPDATE
          SET final_sequence = MAX(final_sequence, excluded.final_sequence)
        `;
        yield* pause;
      }
      for (let from = first; from <= Math.min(last, appliedThrough); from += batchRows) {
        yield* sql`
          DELETE FROM orchestration_events
          WHERE sequence >= ${from} AND sequence < ${from + batchRows}
            AND sequence <= ${appliedThrough}
            AND +event_type = 'thread.message-sent'
            AND occurred_at < ${cutoff}
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
        yield* pause;
      }
    }).pipe(
      Effect.ensuring(
        sql`DROP TABLE IF EXISTS temp.finished_assistant_messages`.pipe(Effect.ignore),
      ),
    );
  });

/**
 * Returns freed pages to the filesystem. Deleting rows alone never shrinks a
 * SQLite file. Databases created before this existed use `auto_vacuum = NONE`,
 * which only a full VACUUM can switch; that one-time rewrite needs free space
 * about the size of the database and is skipped (and retried next start) when
 * it is missing. Afterwards `incremental_vacuum` is cheap and runs in steps.
 */
export const reclaimFreePages = (dbPath: string, options: { readonly allowFullVacuum: boolean }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (yield* usesIncrementalVacuum) {
      const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      let remaining = free[0]?.freelist_count ?? 0;
      while (remaining > 0) {
        let released = 0;
        for (let statement = 0; statement < VACUUM_STATEMENTS_PER_BATCH; statement += 1) {
          yield* sql.unsafe(`PRAGMA incremental_vacuum(${VACUUM_BATCH_PAGES})`);
          const after = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
          const next = after[0]?.freelist_count ?? remaining;
          // Some drivers step this no-column PRAGMA only once, freeing one
          // page rather than N. Measure progress; a fixed step count left most
          // free pages allocated. No progress means retry on the next sweep.
          if (next >= remaining) return;
          released += remaining - next;
          remaining = next;
          if (remaining === 0 || released >= VACUUM_BATCH_PAGES) break;
        }
        yield* Effect.sleep(MAINTENANCE_BATCH_PAUSE);
      }
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

export const usesIncrementalVacuum = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
  return mode[0]?.auto_vacuum === 2;
});

export const runStorageMaintenance = (
  dbPath: string,
  options: { readonly allowFullVacuum: boolean },
) =>
  pruneDatabaseBackups(dbPath).pipe(
    Effect.catch((error) => Effect.logWarning("database backup retention failed", { error })),
    Effect.andThen(pruneStorageHistory(new Date())),
    Effect.andThen(reclaimFreePages(dbPath, options)),
    Effect.catchCause((cause) => Effect.logWarning("sqlite storage maintenance failed", { cause })),
  );
