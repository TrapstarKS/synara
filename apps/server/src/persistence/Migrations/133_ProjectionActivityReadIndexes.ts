import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_activities_detail_rank_covering
    ON projection_thread_activities (
      thread_id,
      (CASE WHEN sequence IS NULL THEN 0 ELSE 1 END) DESC,
      sequence DESC,
      created_at DESC,
      activity_id DESC,
      turn_id,
      kind
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_activities_task_evidence
    ON projection_thread_activities (
      thread_id,
      activity_id,
      kind,
      json_extract(payload_json, '$.taskId'),
      json_extract(payload_json, '$.toolUseId'),
      json_extract(payload_json, '$.status'),
      json_type(payload_json, '$.status'),
      json_type(payload_json, '$.isBackgrounded'),
      COALESCE(json_extract(payload_json, '$.data.toolCallId'),
        json_extract(payload_json, '$.data.toolUseId'))
    )
    WHERE kind IN (
      'task.started', 'task.updated', 'task.completed', 'provider.session.boundary',
      'tool.started', 'tool.updated', 'tool.completed'
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_activities_interaction_resolution
    ON projection_thread_activities (
      thread_id,
      json_extract(payload_json, '$.requestId'),
      kind,
      sequence,
      created_at,
      activity_id
    )
    WHERE kind IN (
      'approval.resolved', 'provider.approval.respond.failed',
      'user-input.resolved', 'provider.user-input.respond.failed'
    )
  `;
});
