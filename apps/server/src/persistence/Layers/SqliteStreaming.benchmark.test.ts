import { randomUUID } from "node:crypto";
import { writeFile, realpath } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { dirname, join, sep } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { resolveSqliteMemoryBudget } from "../sqliteMemoryBudget.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import {
  OrchestrationEventStoreLive,
  buildThreadTitleHighWaterSequenceQuery,
} from "./OrchestrationEventStore.ts";

const summarize = (samples: number[]) => {
  samples.sort((a, b) => a - b);
  return {
    count: samples.length,
    p50: samples[Math.floor(samples.length * 0.5)],
    p99: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))],
    max: samples.at(-1),
  };
};

// Opt-in, Node SQLite only. Input must be an already isolated snapshot under tmpdir.
// Uses real engine/projection writes; excludes providers, transport and migration backups.
it.skipIf(!process.env.SYNARA_SQLITE_BENCHMARK_DB)(
  "measures reads during twenty streaming threads",
  async () => {
    const dbPath = await realpath(process.env.SYNARA_SQLITE_BENCHMARK_DB!);
    expect(dbPath.startsWith(`${await realpath(tmpdir())}${sep}`)).toBe(true);
    const home = dirname(dbPath);
    const budget = resolveSqliteMemoryBudget(totalmem());
    const persistence = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA busy_timeout = 5000`;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`PRAGMA synchronous = NORMAL`;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* sql`PRAGMA journal_size_limit = 67108864`;
        yield* sql`PRAGMA cache_size = ${sql.literal(String(budget.cacheSizePragma))}`;
        yield* sql`PRAGMA mmap_size = ${sql.literal(String(budget.mmapSizeBytes))}`;
        yield* runMigrations();
      }),
    ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })));
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provideMerge(
          OrchestrationProjectionSnapshotQueryLive.pipe(
            Layer.provide(ServerSettingsService.layerTest()),
          ),
        ),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(persistence),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), home)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const delay = monitorEventLoopDelay({ resolution: 1 });
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
      let start = performance.now();
      await runtime.runPromise(snapshots.getShellSnapshot());
      const shellSnapshotMs = performance.now() - start;
      let fullSnapshotMs: number | undefined;
      if (process.env.SYNARA_SQLITE_BENCHMARK_FULL === "1") {
        start = performance.now();
        await runtime.runPromise(snapshots.getSnapshot());
        fullSnapshotMs = performance.now() - start;
      }
      const busiest = await runtime.runPromise(sql<{ threadId: string }>`
      SELECT activities.thread_id AS "threadId"
      FROM projection_thread_activities AS activities
      JOIN projection_threads USING (thread_id)
      WHERE projection_threads.deleted_at IS NULL
      GROUP BY activities.thread_id ORDER BY COUNT(*) DESC LIMIT 20
    `);
      expect(busiest.length).toBeGreaterThan(0);
      const reads: number[] = [];
      const titles: number[] = [];
      for (let round = 0; round < 3; round++) {
        for (const row of busiest) {
          const threadId = ThreadId.makeUnsafe(row.threadId);
          let start = performance.now();
          await runtime.runPromise(snapshots.getThreadDetailById(threadId));
          reads.push(performance.now() - start);
          start = performance.now();
          await runtime.runPromise(buildThreadTitleHighWaterSequenceQuery(sql, threadId));
          titles.push(performance.now() - start);
        }
      }
      const runId = randomUUID();
      const projectId = ProjectId.makeUnsafe(`sqlite-benchmark-${runId}`);
      const createdAt = "2026-10-08T00:00:00.000Z";
      await runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(projectId),
          projectId,
          title: "Benchmark",
          workspaceRoot: join(home, runId),
          defaultModelSelection: null,
          createdAt,
        }),
      );
      const threads = Array.from({ length: 20 }, (_, index) =>
        ThreadId.makeUnsafe(`${runId}-${index}`),
      );
      for (const threadId of threads) {
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(threadId),
            threadId,
            projectId,
            title: "Benchmark",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        );
      }
      const writes: number[] = [];
      const concurrentReads: number[] = [];
      delay.enable();
      await setImmediate();
      start = performance.now();
      for (let round = 0; round < 25; round++) {
        await Promise.all([
          ...threads.map(async (threadId) => {
            const writeStart = performance.now();
            await runtime.runPromise(
              engine.dispatch({
                type: "thread.message.assistant.delta",
                commandId: CommandId.makeUnsafe(`${threadId}-${round}`),
                threadId,
                messageId: MessageId.makeUnsafe("benchmark-message"),
                delta: "x".repeat(200),
                createdAt,
              }),
            );
            writes.push(performance.now() - writeStart);
          }),
          (async () => {
            const readStart = performance.now();
            await runtime.runPromise(
              snapshots.getThreadDetailById(
                ThreadId.makeUnsafe(busiest[round % busiest.length]!.threadId),
              ),
            );
            concurrentReads.push(performance.now() - readStart);
          })(),
        ]);
        await setImmediate();
      }
      await setImmediate();
      delay.disable();
      const streamMs = performance.now() - start;
      await writeFile(
        process.env.SYNARA_SQLITE_BENCHMARK_OUTPUT ?? join(home, "streaming-metrics.json"),
        JSON.stringify(
          {
            node: process.version,
            sqlite: await runtime.runPromise(sql`SELECT sqlite_version() AS version`),
            workload: {
              streamingThreads: 20,
              writes: 500,
              deltaCharacters: 200,
              reads: 25,
              cacheBudget: budget,
              walAutocheckpoint: await runtime.runPromise(sql`PRAGMA wal_autocheckpoint`),
            },
            shellSnapshotMs,
            fullSnapshotMs,
            streamMs,
            readsMs: summarize(reads),
            titleReadsMs: summarize(titles),
            writesMs: summarize(writes),
            concurrentReadsMs: summarize(concurrentReads),
            eventLoopDelayMs: { max: delay.max / 1e6, p99: delay.percentile(99) / 1e6 },
          },
          null,
          2,
        ),
      );
    } finally {
      delay.disable();
      await runtime.dispose();
    }
  },
  180_000,
);
