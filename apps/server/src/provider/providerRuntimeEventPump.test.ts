import { Cause, Deferred, Effect, Fiber, Option, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@synara/contracts";

import {
  coalesceQueuedContentDeltas,
  makeProviderRuntimeEventPumpHealthRegistry,
  runProviderRuntimeEventPump,
} from "./providerRuntimeEventPump.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-runtime-pump");
const TURN_ID = TurnId.makeUnsafe("turn-runtime-pump");
type ContentDeltaEvent = Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }>;

function completedEvent(eventId: string): ProviderRuntimeEvent {
  return {
    type: "turn.completed",
    eventId: EventId.makeUnsafe(eventId),
    provider: "codex",
    createdAt: "2026-07-23T20:00:00.000Z",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: { state: "completed" },
  };
}

function deltaEvent(
  eventId: string,
  delta: string,
  overrides: { threadId?: string; itemId?: string } = {},
): ContentDeltaEvent {
  return {
    type: "content.delta",
    eventId: EventId.makeUnsafe(eventId),
    provider: "codex",
    createdAt: "2026-07-23T20:00:00.000Z",
    threadId: ThreadId.makeUnsafe(overrides.threadId ?? THREAD_ID),
    turnId: TURN_ID,
    itemId: RuntimeItemId.makeUnsafe(overrides.itemId ?? "item-1"),
    raw: {
      source: "codex.app-server.notification",
      method: "item/agentMessage/delta",
      payload: {},
    },
    payload: { streamKind: "assistant_text", delta },
  };
}

function childDeltaEvent(eventId: string, delta: string, childId: string): ContentDeltaEvent {
  return {
    ...deltaEvent(eventId, delta),
    turnId: TurnId.makeUnsafe(`turn-${childId}`),
    parentTurnId: TURN_ID,
    providerRefs: { providerThreadId: childId, providerParentThreadId: "native-parent" },
  };
}

describe("coalesceQueuedContentDeltas", () => {
  it("coalesces interleaved native children routed through the same parent", () => {
    const events = Array.from({ length: 40 }, (_, tick) =>
      Array.from({ length: 20 }, (_, index) =>
        childDeltaEvent(`child-${index}-${tick}`, `${tick},`, `child-${index}`),
      ),
    ).flat();
    const merged = coalesceQueuedContentDeltas(events);

    expect(merged).toHaveLength(20);
    const expected = Array.from({ length: 40 }, (_, tick) => `${tick},`).join("");
    for (const event of merged) {
      expect(event.type === "content.delta" && event.payload.delta).toBe(expected);
    }
  });

  it("keeps child identities distinct even when turn and item ids overlap", () => {
    const first = childDeltaEvent("child-a-1", "a", "child-a");
    const second = { ...childDeltaEvent("child-b-1", "b", "child-b"), turnId: first.turnId };
    const merged = coalesceQueuedContentDeltas([first, second]);

    expect(merged).toEqual([first, second]);
  });

  it("keeps child lifecycle boundaries and parent session fences", () => {
    const childA = childDeltaEvent("child-a-1", "a", "child-a");
    const childB = childDeltaEvent("child-b-1", "b", "child-b");
    const childCompleted = {
      ...completedEvent("child-a-completed"),
      turnId: childA.turnId,
      providerRefs: childA.providerRefs,
    };
    const parentExited: ProviderRuntimeEvent = {
      ...completedEvent("parent-exited"),
      type: "session.exited",
      payload: {},
    };
    const events = [
      childA,
      childB,
      childCompleted,
      childDeltaEvent("child-a-2", "after-completion", "child-a"),
      parentExited,
      childDeltaEvent("child-b-2", "after-exit", "child-b"),
    ];

    expect(coalesceQueuedContentDeltas(events)).toEqual(events);
  });

  it("fences only the child whose lifecycle changed", () => {
    const childA = childDeltaEvent("child-a-1", "a", "child-a");
    const childB = childDeltaEvent("child-b-1", "b", "child-b");
    const merged = coalesceQueuedContentDeltas([
      childA,
      childB,
      { ...completedEvent("child-a-completed"), providerRefs: childA.providerRefs },
      childDeltaEvent("child-a-2", "c", "child-a"),
      childDeltaEvent("child-b-2", "d", "child-b"),
    ]);

    expect(merged.map((event) => event.eventId)).toEqual([
      "child-a-1",
      "child-b-1",
      "child-a-completed",
      "child-a-2",
    ]);
    expect(merged[1]?.type === "content.delta" && merged[1].payload.delta).toBe("bd");
  });

  it.each(["command-output", "nested-collaboration"])("keeps the %s family fence", (kind) => {
    const first = childDeltaEvent("child-a-1", "a", "child-a");
    const fence: ProviderRuntimeEvent =
      kind === "command-output"
        ? {
            ...deltaEvent("parent-output", "output"),
            payload: { streamKind: "command_output", delta: "output" },
          }
        : {
            ...childDeltaEvent("nested-collaboration", "", "child-b"),
            type: "item.started",
            payload: { itemType: "collab_agent_tool_call", status: "inProgress" },
          };
    const events = [first, fence, childDeltaEvent("child-a-2", "b", "child-a")];

    expect(coalesceQueuedContentDeltas(events)).toEqual(events);
  });

  it("keeps parent turn and provider parent changes separate", () => {
    const first = childDeltaEvent("child-a-1", "a", "child-a");
    const nextTurn = {
      ...childDeltaEvent("child-a-2", "b", "child-a"),
      parentTurnId: TurnId.makeUnsafe("new-parent-turn"),
    };
    const nextParent = {
      ...childDeltaEvent("child-a-3", "c", "child-a"),
      parentTurnId: nextTurn.parentTurnId,
      providerRefs: { providerThreadId: "child-a", providerParentThreadId: "new-native-parent" },
    };

    expect(coalesceQueuedContentDeltas([first, nextTurn, nextParent])).toEqual([
      first,
      nextTurn,
      nextParent,
    ]);
  });

  it("merges queued deltas per thread without reordering any thread's events", () => {
    const merged = coalesceQueuedContentDeltas([
      deltaEvent("a1", "Hel"),
      deltaEvent("b1", "x", { threadId: "thread-b" }),
      deltaEvent("a2", "lo"),
      deltaEvent("a3", "!", { itemId: "item-2" }),
      deltaEvent("a4", "?", { itemId: "item-2" }),
      completedEvent("a5"),
      deltaEvent("a6", "late", { itemId: "item-2" }),
      deltaEvent("b2", "y", { threadId: "thread-b" }),
    ]);

    expect(
      merged.map((event) => [
        event.eventId,
        event.type === "content.delta" ? event.payload.delta : event.type,
      ]),
    ).toEqual([
      ["a1", "Hello"],
      ["b1", "xy"],
      ["a3", "!?"],
      ["a5", "turn.completed"],
      ["a6", "late"],
    ]);
    expect(merged[0]?.raw).toBeUndefined();
    expect(merged[4]?.raw).toBeDefined();
  });
});

describe("providerRuntimeEventPump", () => {
  it.each([false, true])(
    "admits request timers between busy events (single-event chunks=%s)",
    async (singleEventChunks) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
            const completed = yield* Deferred.make<void>();
            let processed = 0;
            let processedAtRequestArrival: number | undefined;
            let timer: ReturnType<typeof setTimeout> | undefined;
            yield* Effect.addFinalizer(() => Effect.sync(() => clearTimeout(timer)));
            yield* Queue.offerAll(
              queue,
              Array.from({ length: 100 }, (_, index) =>
                deltaEvent(`busy-${index}`, "x", { itemId: `item-${index}` }),
              ),
            );
            yield* runProviderRuntimeEventPump({
              provider: "codex",
              stream: singleEventChunks
                ? Stream.fromQueue(queue).pipe(Stream.rechunk(1))
                : Stream.fromQueue(queue),
              processEvent: () =>
                Effect.sync(() => {
                  processed += 1;
                  if (processed === 1) {
                    timer = setTimeout(() => {
                      processedAtRequestArrival = processed;
                    }, 0);
                  }
                  // Small synchronous event work must not accumulate into one long batch stall.
                  const end = performance.now() + 1;
                  while (performance.now() < end) {}
                }).pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      processed === 100 ? Deferred.succeed(completed, undefined) : Effect.void,
                    ),
                  ),
                ),
              updateHealth: makeProviderRuntimeEventPumpHealthRegistry(["codex"]).update,
            }).pipe(Effect.forkScoped);
            yield* Deferred.await(completed);
            yield* Effect.sleep(10);

            expect(processed).toBe(100);
            expect(processedAtRequestArrival).toBeDefined();
            expect(processedAtRequestArrival).toBeLessThanOrEqual(20);
          }),
        ),
      );
    },
  );

  it("paces native child streams independently of their shared parent", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const children = Array.from({ length: 20 }, (_, index) => `child-load-${index}`);
          const textByChild = new Map<string, string>();
          let processed = 0;

          yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromQueue(queue),
            processEvent: (event) =>
              Effect.sync(() => {
                processed += 1;
                if (event.type === "content.delta") {
                  const childId = event.providerRefs?.providerThreadId ?? "";
                  textByChild.set(childId, (textByChild.get(childId) ?? "") + event.payload.delta);
                }
              }),
            updateHealth: makeProviderRuntimeEventPumpHealthRegistry(["codex"]).update,
            deltaCoalesceWindowMs: 50,
          }).pipe(Effect.forkScoped);

          for (let tick = 0; tick < 40; tick += 1) {
            for (const childId of children) {
              yield* Queue.offer(queue, childDeltaEvent(`${childId}-${tick}`, `${tick},`, childId));
            }
            yield* Effect.sleep(10);
          }
          yield* Effect.sleep(400);

          const expected = Array.from({ length: 40 }, (_, tick) => `${tick},`).join("");
          for (const childId of children) expect(textByChild.get(childId)).toBe(expected);
          expect(processed).toBeLessThan(200);
        }),
      ),
    );
  });

  it("bounds per-item processing under many concurrent delta streams", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const threads = Array.from({ length: 15 }, (_, index) => `thread-load-${index}`);
          const textByThread = new Map<string, string>();
          let processed = 0;

          yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromQueue(queue),
            processEvent: (event) =>
              Effect.sync(() => {
                processed += 1;
                if (event.type === "content.delta") {
                  const previous = textByThread.get(event.threadId) ?? "";
                  textByThread.set(event.threadId, previous + event.payload.delta);
                }
              }),
            updateHealth: makeProviderRuntimeEventPumpHealthRegistry(["codex"]).update,
            deltaCoalesceWindowMs: 50,
          }).pipe(Effect.forkScoped);

          // 15 threads x 40 deltas, one token per thread every 10 ms (~100 tokens/s each).
          for (let tick = 0; tick < 40; tick += 1) {
            for (const threadId of threads) {
              yield* Queue.offer(
                queue,
                deltaEvent(`${threadId}-${tick}`, `${tick},`, { threadId }),
              );
            }
            yield* Effect.sleep(10);
          }
          yield* Effect.sleep(400);

          const expected = Array.from({ length: 40 }, (_, tick) => `${tick},`).join("");
          for (const threadId of threads) expect(textByThread.get(threadId)).toBe(expected);
          // 600 raw deltas over ~400 ms become roughly one event per thread per window.
          expect(processed).toBeLessThan(200);
        }),
      ),
    );
  });

  it("retries the current event before consuming the next queue item", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          const processed: string[] = [];
          let attempts = 0;

          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromQueue(queue),
            processEvent: (event) =>
              Effect.gen(function* () {
                attempts += 1;
                if (attempts === 1) {
                  return yield* Effect.fail(new Error("sqlite busy"));
                }
                processed.push(event.eventId);
                yield* Deferred.succeed(completed, undefined);
              }),
            updateHealth: health.update,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
          }).pipe(Effect.forkScoped);

          yield* Queue.offer(queue, completedEvent("event-retried"));
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(attempts).toBe(2);
          expect(processed).toEqual(["event-retried"]);
          expect(health.snapshot()[0]).toMatchObject({
            provider: "codex",
            status: "healthy",
            consecutiveFailures: 0,
          });
        }),
      ),
    );
  });

  it("restarts an Adapter stream that dies unexpectedly", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          let subscriptions = 0;

          const stream = Stream.unwrap(
            Effect.sync(() => {
              subscriptions += 1;
              return subscriptions === 1
                ? Stream.die(new Error("adapter stream defect"))
                : Stream.fromQueue(queue);
            }),
          );
          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream,
            processEvent: () => Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
            updateHealth: health.update,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
          }).pipe(Effect.forkScoped);

          yield* Queue.offer(queue, completedEvent("event-after-restart"));
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(subscriptions).toBeGreaterThanOrEqual(2);
          expect(health.snapshot()[0]?.status).toBe("healthy");
        }),
      ),
    );
  });

  it("quarantines a permanent event failure and continues with later events", async () => {
    class PermanentEventError extends Error {}

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          const processed: string[] = [];
          const quarantined: string[] = [];

          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromQueue(queue),
            processEvent: (event) =>
              event.eventId === "event-poison"
                ? Effect.fail(new PermanentEventError("invalid canonical event"))
                : Effect.sync(() => processed.push(event.eventId)).pipe(
                    Effect.andThen(Deferred.succeed(completed, undefined)),
                    Effect.asVoid,
                  ),
            updateHealth: health.update,
            isPermanentFailure: (cause) =>
              Option.match(Cause.findErrorOption(cause), {
                onNone: () => false,
                onSome: (error) => error instanceof PermanentEventError,
              }),
            quarantineEvent: (event) =>
              Effect.sync(() => {
                quarantined.push(event.eventId);
              }),
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
          }).pipe(Effect.forkScoped);

          yield* Queue.offerAll(queue, [
            completedEvent("event-poison"),
            completedEvent("event-after-poison"),
          ]);
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(processed).toEqual(["event-after-poison"]);
          expect(quarantined).toEqual(["event-poison"]);
          expect(health.snapshot()[0]).toMatchObject({
            status: "degraded",
            quarantinedEvents: 1,
            lastQuarantinedEventId: "event-poison",
          });
        }),
      ),
    );
  });

  it("heals a degraded pump after sustained successful processing", async () => {
    class PermanentEventError extends Error {}

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const completed = yield* Deferred.make<void>();
          const health = makeProviderRuntimeEventPumpHealthRegistry(["codex"]);
          const processed: string[] = [];

          const fiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromQueue(queue),
            processEvent: (event) =>
              event.eventId === "event-poison"
                ? Effect.fail(new PermanentEventError("invalid canonical event"))
                : Effect.sync(() => {
                    processed.push(event.eventId);
                  }).pipe(
                    Effect.andThen(
                      event.eventId === "event-heal-3"
                        ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  ),
            updateHealth: health.update,
            isPermanentFailure: (cause) =>
              Option.match(Cause.findErrorOption(cause), {
                onNone: () => false,
                onSome: (error) => error instanceof PermanentEventError,
              }),
            quarantineEvent: () => Effect.void,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
            degradedHealAfterSuccesses: 3,
          }).pipe(Effect.forkScoped);

          yield* Queue.offerAll(queue, [
            completedEvent("event-poison"),
            completedEvent("event-heal-1"),
            completedEvent("event-heal-2"),
            completedEvent("event-heal-3"),
          ]);
          yield* Deferred.await(completed);
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(fiber);

          expect(processed).toEqual(["event-heal-1", "event-heal-2", "event-heal-3"]);
          // Healed: no longer degraded, but the quarantine forensics survive.
          expect(health.snapshot()[0]).toMatchObject({
            status: "healthy",
            quarantinedEvents: 0,
            lastQuarantinedEventId: "event-poison",
          });
        }),
      ),
    );
  });
});
