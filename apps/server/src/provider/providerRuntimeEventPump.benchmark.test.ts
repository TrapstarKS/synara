import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { Effect, Fiber, Layer, ManagedRuntime, Queue, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProviderRuntimeEventRepositoryLive } from "../persistence/Layers/ProviderRuntimeEvents.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ProviderRuntimeEventRepository } from "../persistence/Services/ProviderRuntimeEvents.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { runProviderRuntimeEventPump } from "./providerRuntimeEventPump.ts";

const THREAD_COUNT = 20;
const TICK_MS = 10;
const CREATED_AT = "2026-10-08T12:00:00.000Z";
const ROOT_THREAD_ID = ThreadId.makeUnsafe("benchmark-native-parent");
type Topology = "direct" | "native-child";
type Arrival = "paced" | "prequeued-mixed";

function summary(samples: ReadonlyArray<number>) {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return {
    count: sorted.length,
    mean: sorted.length ? sorted.reduce((sum, n) => sum + n, 0) / sorted.length : null,
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  };
}

async function measure(topology: Topology, arrival: Arrival, ticks: number) {
  const dir = await mkdtemp(join(tmpdir(), "synara-pump-benchmark-"));
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
      Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
      Layer.provideMerge(makeSqlitePersistenceLive(join(dir, "state.sqlite"))),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), dir)),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  const delay = monitorEventLoopDelay({ resolution: TICK_MS });
  let pump: Fiber.Fiber<void, never> | undefined;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const journal = await runtime.runPromise(Effect.service(ProviderRuntimeEventRepository));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const queue = await Effect.runPromise(Queue.unbounded<ProviderRuntimeEvent>());
    const projectId = ProjectId.makeUnsafe("benchmark-project");
    const threads = Array.from({ length: THREAD_COUNT }, (_, index) =>
      ThreadId.makeUnsafe(`benchmark-thread-${index}`),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("project"),
        projectId,
        title: "Benchmark",
        workspaceRoot: dir,
        defaultModelSelection: null,
        createdAt: CREATED_AT,
      }),
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
          createdAt: CREATED_AT,
        }),
      );
    }
    await runtime.runPromise(sql`PRAGMA wal_autocheckpoint = 0`);
    await runtime.runPromise(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
    const expectedText = Array.from(
      { length: ticks },
      (_, tick) => `[${String(tick).padStart(5, "0")}]`,
    ).join("");
    const eventsForTick = (tick: number): Array<ProviderRuntimeEvent> =>
      threads.map((threadId) => ({
        type: "content.delta",
        eventId: EventId.makeUnsafe(`${threadId}-${tick}`),
        provider: "codex",
        createdAt: CREATED_AT,
        threadId: topology === "native-child" ? ROOT_THREAD_ID : threadId,
        turnId: TurnId.makeUnsafe(`${threadId}-turn`),
        itemId: RuntimeItemId.makeUnsafe(`${threadId}-item-${arrival === "paced" ? 0 : tick % 2}`),
        ...(topology === "native-child"
          ? {
              providerRefs: {
                providerThreadId: threadId,
                providerParentThreadId: ROOT_THREAD_ID,
              },
            }
          : {}),
        raw: {
          source: "codex.app-server.notification",
          method: "item/agentMessage/delta",
          payload: { threadId, delta: `[${String(tick).padStart(5, "0")}]` },
        },
        payload: { streamKind: "assistant_text", delta: `[${String(tick).padStart(5, "0")}]` },
      }));
    const completions: Array<ProviderRuntimeEvent> = threads.map((threadId) => ({
      type: "turn.completed",
      eventId: EventId.makeUnsafe(`${threadId}-completed`),
      provider: "codex",
      createdAt: CREATED_AT,
      threadId: topology === "native-child" ? ROOT_THREAD_ID : threadId,
      turnId: TurnId.makeUnsafe(`${threadId}-turn`),
      ...(topology === "native-child"
        ? { providerRefs: { providerThreadId: threadId, providerParentThreadId: ROOT_THREAD_ID } }
        : {}),
      payload: { state: "completed" },
    }));
    if (arrival === "prequeued-mixed") {
      await Effect.runPromise(
        Queue.offerAll(queue, [
          ...Array.from({ length: ticks }, (_, tick) => eventsForTick(tick)).flat(),
          ...completions,
        ]),
      );
    }

    const timerDriftMs: Array<number> = [];
    const requestArrivalDelayMs: Array<number> = [];
    const userDispatchLatencyMs: Array<number> = [];
    const userEndToEndLatencyMs: Array<number> = [];
    const shellReadLatencyMs: Array<number> = [];
    const pending = new Set<Promise<void>>();
    const errors: Array<unknown> = [];
    const track = (work: Promise<void>) => {
      const tracked = work
        .catch((error) => {
          errors.push(error);
        })
        .finally(() => pending.delete(tracked));
      pending.add(tracked);
    };
    let processedDeltas = 0;
    let processedEvents = 0;
    let completedThreads = 0;
    let finish!: () => void;
    const drained = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let healthStatus = "starting";
    delay.enable();
    await sleep(30);
    delay.reset();
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    let timerDue = started + TICK_MS;
    timers.push(
      setInterval(() => {
        const now = performance.now();
        while (timerDue <= now) {
          timerDriftMs.push(now - timerDue);
          timerDue += TICK_MS;
        }
      }, TICK_MS),
    );
    let requestDue = started;
    let requestIndex = 0;
    const sendRequests = () => {
      const now = performance.now();
      while (requestDue <= now) {
        const due = requestDue;
        const index = requestIndex++;
        const threadId = threads[index % threads.length]!;
        requestArrivalDelayMs.push(now - due);
        const dispatched = performance.now();
        track(
          runtime
            .runPromise(
              engine.dispatch(
                {
                  type: "thread.meta.update",
                  commandId: CommandId.makeUnsafe(`user-${index}`),
                  threadId,
                  title: `Benchmark ${index}`,
                },
                { userInitiated: true },
              ),
            )
            .then(() => {
              userDispatchLatencyMs.push(performance.now() - dispatched);
              userEndToEndLatencyMs.push(performance.now() - due);
            }),
        );
        const readStarted = performance.now();
        track(
          runtime.runPromise(snapshots.getThreadShellsByIds(threads)).then((shells) => {
            expect(shells).toHaveLength(THREAD_COUNT);
            shellReadLatencyMs.push(performance.now() - readStarted);
          }),
        );
        requestDue += 100;
      }
    };
    timers.push(setInterval(sendRequests, 100));
    sendRequests();
    pump = Effect.runFork(
      runProviderRuntimeEventPump({
        provider: "codex",
        stream: Stream.fromQueue(queue),
        deltaCoalesceWindowMs: 100,
        updateHealth: (health) => {
          healthStatus = health.status;
        },
        // Direct mapper deliberately bypasses ProviderRuntimeIngestion; journal/engine/projections are real.
        processEvent: (event) =>
          Effect.gen(function* () {
            yield* journal.append(event);
            const threadId =
              topology === "native-child"
                ? ThreadId.makeUnsafe(event.providerRefs!.providerThreadId!)
                : event.threadId;
            if (event.type === "content.delta") {
              yield* engine.dispatch({
                type: "thread.message.assistant.delta",
                commandId: CommandId.makeUnsafe(event.eventId),
                threadId,
                messageId: MessageId.makeUnsafe("benchmark-message"),
                delta: event.payload.delta,
                createdAt: event.createdAt,
              });
              processedDeltas += 1;
            } else if (event.type === "turn.completed") {
              yield* engine.dispatch({
                type: "thread.message.assistant.complete",
                commandId: CommandId.makeUnsafe(event.eventId),
                threadId,
                messageId: MessageId.makeUnsafe("benchmark-message"),
                createdAt: event.createdAt,
              });
              completedThreads += 1;
            }
            processedEvents += 1;
            if (completedThreads === THREAD_COUNT) finish();
          }),
      }),
    );
    if (arrival === "paced") {
      for (let tick = 0; tick < ticks; tick += 1) {
        const waitMs = started + tick * TICK_MS - performance.now();
        if (waitMs > 0) await sleep(waitMs);
        await Effect.runPromise(Queue.offerAll(queue, eventsForTick(tick)));
      }
      await Effect.runPromise(Queue.offerAll(queue, completions));
    }
    await Promise.race([
      drained,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("Provider pump benchmark did not drain")),
          120_000,
        );
      }),
    ]);
    const drainMs = performance.now() - started;
    // Allow delayed callbacks to run so a stall at the end cannot disappear from the samples.
    await sleep(25);
    for (const timer of timers) clearInterval(timer);
    await Promise.all(pending);
    const cpu = process.cpuUsage(cpuBefore);
    delay.disable();
    expect(errors).toEqual([]);
    expect(healthStatus).toBe("healthy");
    const actual = await runtime.runPromise(snapshots.getSnapshot());
    expect(actual.threads).toHaveLength(THREAD_COUNT);
    const actualTexts = actual.threads.map((thread) => thread.messages[0]?.text);
    for (const text of actualTexts) expect(text).toBe(expectedText);
    const journalRows = await runtime.runPromise(
      sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM provider_runtime_events`,
    );
    expect(journalRows[0]?.count).toBe(processedEvents);
    expect(completedThreads).toBe(THREAD_COUNT);
    expect(userDispatchLatencyMs.length).toBeGreaterThan(0);
    expect(shellReadLatencyMs.length).toBeGreaterThan(0);
    return {
      topology,
      arrival,
      threadCount: THREAD_COUNT,
      targetDeltasPerSecondPerThread: 100,
      rawDeltas: ticks * THREAD_COUNT,
      processedDeltas,
      processedEvents,
      journalRows: journalRows[0]?.count,
      drainMs,
      rawDeltasPerSecond: (ticks * THREAD_COUNT) / (drainMs / 1_000),
      processedDeltasPerSecond: processedDeltas / (drainMs / 1_000),
      cpuMs: { user: cpu.user / 1_000, system: cpu.system / 1_000 },
      eventLoopDelayMs: { p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 },
      timerDriftMs: summary(timerDriftMs),
      requestArrivalDelayMs: summary(requestArrivalDelayMs),
      userDispatchLatencyMs: summary(userDispatchLatencyMs),
      userEndToEndLatencyMs: summary(userEndToEndLatencyMs),
      shellReadLatencyMs: summary(shellReadLatencyMs),
      correctness: {
        exactTextAndOrder: true,
        completedThreads,
        expectedTextBytesPerThread: Buffer.byteLength(expectedText),
        actualTextBytes: actualTexts.map((text) => Buffer.byteLength(text!)),
        expectedTextSha256: createHash("sha256").update(expectedText).digest("hex"),
        actualTextSha256: actualTexts.map((text) =>
          createHash("sha256").update(text!).digest("hex"),
        ),
      },
    };
  } finally {
    for (const timer of timers) clearInterval(timer);
    if (watchdog) clearTimeout(watchdog);
    delay.disable();
    if (pump) await Effect.runPromise(Fiber.interrupt(pump));
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

it.skipIf(!process.env.SYNARA_PROVIDER_PUMP_BENCHMARK_OUTPUT)(
  "measures production runtime pump fairness with persisted synthetic Codex streams",
  async () => {
    const output = process.env.SYNARA_PROVIDER_PUMP_BENCHMARK_OUTPUT!;
    const hashes: Record<string, string> = {};
    for (const path of [
      "src/provider/providerRuntimeEventPump.ts",
      "src/orchestration/Layers/OrchestrationEngine.ts",
      "src/orchestration/Layers/ProjectionPipeline.ts",
      "src/persistence/Layers/ProviderRuntimeEvents.ts",
    ])
      hashes[path] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    const results: Array<Awaited<ReturnType<typeof measure>>> = [];
    const cases = [
      { name: "direct/paced", topology: "direct", arrival: "paced", ticks: 300 },
      {
        name: "direct/prequeued-mixed",
        topology: "direct",
        arrival: "prequeued-mixed",
        ticks: 100,
      },
      { name: "native-child/paced", topology: "native-child", arrival: "paced", ticks: 300 },
      {
        name: "native-child/prequeued-mixed",
        topology: "native-child",
        arrival: "prequeued-mixed",
        ticks: 100,
      },
    ] as const;
    const selectedNames =
      process.env.SYNARA_PROVIDER_PUMP_BENCHMARK_CASES?.split(",") ?? cases.map(({ name }) => name);
    for (const name of selectedNames) {
      if (!cases.some((entry) => entry.name === name))
        throw new Error(`Unknown provider pump benchmark case: ${name}`);
    }
    const selectedCases = cases.filter(({ name }) => selectedNames.includes(name));
    let activeCase: string | undefined;
    const record = (status: "running" | "complete" | "failed", error?: string) =>
      writeFile(
        output,
        JSON.stringify(
          {
            environment: {
              node: process.version,
              os: `${platform()} ${release()}`,
              cpu: cpus()[0]?.model,
            },
            pipeline:
              "runProviderRuntimeEventPump -> ProviderRuntimeEventRepository.append -> direct synthetic mapper -> OrchestrationEngineLive -> production projection pipeline -> isolated temporary SQLite",
            limitations: [
              "ProviderRuntimeIngestion and Codex app-server parsing are bypassed",
              "No provider process or WebSocket transport",
              "All synthetic item IDs project into one assistant message per thread",
            ],
            workload: {
              threadCount: THREAD_COUNT,
              deltasPerSecondPerThread: 100,
              pacedMs: 3_000,
              prequeuedMixedTicks: 100,
              deltaCoalesceWindowMs: 100,
              userCommandsAndShellReadsPerSecond: 10,
              timerMs: TICK_MS,
              checkpoint: "disabled during measurement; setup WAL truncated",
            },
            hashes,
            results,
            selectedCases: selectedCases.map(({ name }) => name),
            status,
            ...(error === undefined ? {} : { error, failedCase: activeCase }),
          },
          null,
          2,
        ),
      );
    await record("running");
    try {
      for (const entry of selectedCases) {
        activeCase = entry.name;
        results.push(await measure(entry.topology, entry.arrival, entry.ticks));
        await record("running");
      }
      await record("complete");
    } catch (error) {
      await record("failed", String(error));
      throw error;
    }
  },
  600_000,
);
