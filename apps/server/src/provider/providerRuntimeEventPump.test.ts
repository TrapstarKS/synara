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
): ProviderRuntimeEvent {
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

describe("coalesceQueuedContentDeltas", () => {
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
