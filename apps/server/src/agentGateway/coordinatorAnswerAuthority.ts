import { RuntimeMode } from "@synara/contracts";
import { runtimeModeEscalatesPrivilege } from "@synara/shared/runtimeMode";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const makeCoordinatorAnswerAuthority = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (coordinatorThreadId: string, executorThreadId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        callerMode: unknown;
        targetMode: unknown;
        callerEnv: string | null;
        targetEnv: string | null;
      }>`SELECT caller.runtime_mode AS "callerMode", target.runtime_mode AS "targetMode",
      caller.env_mode AS "callerEnv", target.env_mode AS "targetEnv"
      FROM projection_threads AS caller JOIN projection_threads AS target ON target.thread_id = ${executorThreadId}
      WHERE caller.thread_id = ${coordinatorThreadId}
        AND caller.deleted_at IS NULL AND caller.archived_at IS NULL
        AND target.deleted_at IS NULL AND target.archived_at IS NULL`;
      const row = rows[0];
      return (
        row !== undefined &&
        Schema.is(RuntimeMode)(row.callerMode) &&
        Schema.is(RuntimeMode)(row.targetMode) &&
        !runtimeModeEscalatesPrivilege(row.callerMode, row.targetMode) &&
        !(row.callerEnv === "worktree" && (row.targetEnv ?? "local") === "local")
      );
    });
});
