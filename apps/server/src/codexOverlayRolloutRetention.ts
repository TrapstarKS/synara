// FILE: codexOverlayRolloutRetention.ts
// Purpose: Bounds `$SYNARA_HOME/codex-home-overlays/<profile>/sessions`. Each Codex
//          profile runs with its own CODEX_HOME, so these rollouts are the only
//          copy (not duplicates of ~/.codex/sessions) and Codex never deletes them.
//          Rollouts no active Synara thread can resume are reclaimed once idle.
import * as fs from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** An unreferenced rollout must be idle this long before it is deleted. */
export const CODEX_OVERLAY_ROLLOUT_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;

const ROLLOUT_NAME =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u;
const PARENT_THREAD_ID = /"parent_thread_id"\s*:\s*"([^"]+)"/u;

async function readParentThreadId(filePath: string): Promise<string | null> {
  const handle = await fs.open(filePath, "r");
  try {
    // session_meta is the first line; its parent id precedes the long instructions.
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
    return PARENT_THREAD_ID.exec(firstLine)?.[1] ?? null;
  } finally {
    await handle.close();
  }
}

/**
 * Deletes rollouts under each profile's `sessions`/`archived_sessions` that are
 * idle past the retention window and belong neither to an active thread nor to
 * a subagent of one. Symlinked session directories (the default overlay links
 * the user's own ~/.codex) are never entered. A deleted rollout only costs the
 * thread its provider context: resume falls back to a fresh Codex thread.
 */
export async function pruneCodexOverlayRollouts(input: {
  readonly overlaysRoot: string;
  readonly activeCodexThreadIds: ReadonlySet<string>;
  readonly nowMs: number;
}): Promise<{ readonly deletedFiles: number; readonly deletedBytes: number }> {
  let deletedFiles = 0;
  let deletedBytes = 0;
  const profiles = await fs.readdir(input.overlaysRoot).catch(() => [] as string[]);
  for (const profile of profiles) {
    for (const sessionsName of ["sessions", "archived_sessions"]) {
      const sessionsDir = path.join(input.overlaysRoot, profile, sessionsName);
      const dirStat = await fs.lstat(sessionsDir).catch(() => null);
      if (!dirStat?.isDirectory()) continue;
      const entries = await fs.readdir(sessionsDir, { recursive: true });
      for (const relative of entries) {
        const id = ROLLOUT_NAME.exec(path.basename(relative))?.[1];
        if (!id || input.activeCodexThreadIds.has(id)) continue;
        const filePath = path.join(sessionsDir, relative);
        try {
          const stat = await fs.lstat(filePath);
          if (!stat.isFile()) continue;
          if (input.nowMs - stat.mtimeMs < CODEX_OVERLAY_ROLLOUT_RETENTION_MS) continue;
          const parent = await readParentThreadId(filePath);
          if (parent && input.activeCodexThreadIds.has(parent)) continue;
          await fs.unlink(filePath);
          deletedFiles += 1;
          deletedBytes += stat.size;
        } catch {
          // Raced with Codex or already gone; the next sweep retries.
        }
      }
    }
  }
  return { deletedFiles, deletedBytes };
}

/** Codex thread ids bound to non-archived, non-deleted Synara threads. */
const readActiveCodexThreadIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly id: string | null }>`
    SELECT json_extract(runtime.resume_cursor_json, '$.threadId') AS id
    FROM provider_session_runtime AS runtime
    JOIN projection_threads AS thread ON thread.thread_id = runtime.thread_id
    WHERE runtime.provider_name = 'codex'
      AND thread.archived_at IS NULL
      AND thread.deleted_at IS NULL
  `;
  return new Set(rows.flatMap((row) => (row.id ? [row.id] : [])));
});

export const sweepCodexOverlayRollouts = (synaraHome: string | undefined) =>
  Effect.gen(function* () {
    if (!synaraHome?.trim()) return;
    const activeCodexThreadIds = yield* readActiveCodexThreadIds;
    const result = yield* Effect.promise(() =>
      pruneCodexOverlayRollouts({
        overlaysRoot: path.join(synaraHome.trim(), "codex-home-overlays"),
        activeCodexThreadIds,
        nowMs: Date.now(),
      }),
    );
    if (result.deletedFiles > 0) {
      yield* Effect.logInfo("reclaimed idle Codex overlay rollouts", result);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("codex overlay rollout retention failed", { cause }),
    ),
  );
