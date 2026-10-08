import http from "node:http";
import type { Socket } from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { WsRpcError } from "@synara/contracts";
import { Deferred, Effect, Exit, Layer, Schedule, Schema, Scope, Stream } from "effect";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";

import { makeBoundedNodeHttpServer } from "./nodeHttpServer";
import { bufferLiveUiStream, failLiveUiStreamForSnapshotResync } from "./wsStreamBackpressure";

const THREAD_COUNT = 20;
const DELTAS_PER_THREAD = 100;
const SLOW_BUFFER_CAPACITY = 16;
const Delta = Schema.Struct({
  threadId: Schema.String,
  sequence: Schema.Number,
  delta: Schema.String,
});
type Delta = typeof Delta.Type;

const LoadRpcGroup = RpcGroup.make(
  Rpc.make("test.subscribeThread", {
    payload: Schema.Struct({ threadId: Schema.String, slow: Schema.Boolean }),
    success: Delta,
    error: WsRpcError,
    stream: true,
  }),
  Rpc.make("test.read", {
    payload: Schema.Struct({ threadId: Schema.String }),
    success: Schema.Struct({ threadId: Schema.String, version: Schema.Number }),
  }),
  Rpc.make("test.send", {
    payload: Schema.Struct({ threadId: Schema.String, text: Schema.String }),
    success: Schema.Struct({ accepted: Schema.Boolean }),
  }),
);

interface RpcFrame {
  readonly _tag: string;
  readonly requestId?: string;
  readonly values?: readonly Delta[];
  readonly exit?: unknown;
}

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function startLoadServer() {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const start = await Effect.runPromise(Deferred.make<void>());
  const subscribed = pending<void>();
  const overflow = pending<void>();
  const tcpSockets: Socket[] = [];
  const versions = new Map<string, number>();
  let subscriptionCount = 0;
  let producedDeltas = 0;
  let overflowCount = 0;
  let nodeServer: http.Server | null = null;
  const handlers = LoadRpcGroup.toLayer(
    LoadRpcGroup.of({
      "test.subscribeThread": ({ threadId, slow }) => {
        subscriptionCount += 1;
        if (subscriptionCount === THREAD_COUNT) subscribed.resolve();
        return Stream.unwrap(
          Deferred.await(start).pipe(
            Effect.as(
              bufferLiveUiStream(
                Stream.fromIterable(
                  Array.from({ length: DELTAS_PER_THREAD }, (_, index) => index),
                ).pipe(
                  Stream.schedule(Schedule.spaced("20 millis")),
                  Stream.map((sequence) => ({ threadId, sequence, delta: "delta ".repeat(16) })),
                  Stream.tap((delta) =>
                    Effect.sync(() => {
                      producedDeltas += 1;
                      versions.set(threadId, delta.sequence + 1);
                    }),
                  ),
                ),
                {
                  ...(slow ? { capacity: SLOW_BUFFER_CAPACITY } : {}),
                  label: threadId,
                  onDroppedEvents: (report) => {
                    overflowCount += 1;
                    overflow.resolve();
                    return failLiveUiStreamForSnapshotResync(report);
                  },
                },
              ),
            ),
          ),
        );
      },
      "test.read": ({ threadId }) =>
        Effect.succeed({ threadId, version: versions.get(threadId) ?? 0 }),
      "test.send": () => Effect.succeed({ accepted: true }),
    }),
  ).pipe(Layer.provideMerge(RpcSerialization.layerJson));

  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* makeBoundedNodeHttpServer(
            () => {
              nodeServer = http.createServer();
              nodeServer.on("connection", (socket) => tcpSockets.push(socket));
              return nodeServer;
            },
            { host: "127.0.0.1", port: 0 },
          );
          const context = yield* Layer.buildWithScope(handlers, scope);
          const httpApp = yield* RpcServer.toHttpEffectWebsocket(LoadRpcGroup).pipe(
            Effect.provide(context),
          );
          yield* httpServer.serve(httpApp);
        }).pipe(Effect.provide(NodeServices.layer)),
        scope,
      ),
    );
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
  const address = (nodeServer as http.Server | null)?.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    tcpSockets,
    subscribed: subscribed.promise,
    overflow: overflow.promise,
    start: () => Effect.runPromise(Deferred.succeed(start, undefined)),
    counts: () => ({ producedDeltas, overflowCount }),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

async function connectLoadClient(url: string, holdSlowAck: boolean) {
  const socket = new WebSocket(url, { perMessageDeflate: true });
  const waiters = new Map<string, ReturnType<typeof pending<RpcFrame>>>();
  const received = new Map<string, Delta[]>();
  let requestId = 0;
  let slowRequestId: string | undefined;
  let releaseSlowAck = !holdSlowAck;
  let receivedFrames = 0;
  let receivedJsonBytes = 0;
  let sentFrames = 0;
  let sentJsonBytes = 0;

  const send = (frame: unknown) => {
    const json = JSON.stringify(frame);
    sentFrames += 1;
    sentJsonBytes += Buffer.byteLength(json);
    socket.send(json);
  };
  socket.on("message", (data: RawData) => {
    const json = data.toString();
    receivedFrames += 1;
    receivedJsonBytes += Buffer.byteLength(json);
    const frame = JSON.parse(json) as RpcFrame;
    if (frame._tag === "Chunk") {
      const id = String(frame.requestId);
      const deltas = received.get(id)!;
      deltas.push(...frame.values!);
      if (id !== slowRequestId || releaseSlowAck) send({ _tag: "Ack", requestId: id });
      return;
    }
    const key = frame._tag === "Pong" ? "ping" : String(frame.requestId);
    const waiter = waiters.get(key);
    if (!waiter) return;
    waiters.delete(key);
    waiter.resolve(frame);
  });
  socket.on("error", (error) => {
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  });
  socket.on("close", () => {
    for (const waiter of waiters.values()) waiter.reject(new Error("Load socket closed"));
    waiters.clear();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const request = (tag: string, payload: unknown, stream = false) => {
    const id = String(++requestId);
    const response = pending<RpcFrame>();
    waiters.set(id, response);
    if (stream) received.set(id, []);
    send({ _tag: "Request", id, tag, payload, headers: [] });
    return { id, exit: response.promise };
  };
  return {
    socket,
    received,
    request,
    subscribe: (threadId: string, slow: boolean) => {
      const subscription = request("test.subscribeThread", { threadId, slow }, true);
      if (slow) slowRequestId = subscription.id;
      return subscription;
    },
    ping: () => {
      const response = pending<RpcFrame>();
      waiters.set("ping", response);
      send({ _tag: "Ping" });
      return response.promise;
    },
    releaseAck: () => {
      releaseSlowAck = true;
      send({ _tag: "Ack", requestId: slowRequestId });
    },
    metrics: () => ({ receivedFrames, receivedJsonBytes, sentFrames, sentJsonBytes }),
  };
}

function latencySummary(samples: readonly number[]) {
  const sorted = samples.toSorted((left, right) => left - right);
  const percentile = (fraction: number) =>
    Number(
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!.toFixed(2),
    );
  return {
    count: sorted.length,
    p50Ms: percentile(0.5),
    p99Ms: percentile(0.99),
    maxMs: percentile(1),
  };
}

describe("real websocket streaming load", () => {
  it.each([false, true])(
    "preserves concurrent RPC traffic with slow ACK = %s",
    async (holdSlowAck) => {
      const server = await startLoadServer();
      const clients: Awaited<ReturnType<typeof connectLoadClient>>[] = [];
      let queueSampler: ReturnType<typeof setInterval> | undefined;
      try {
        for (let index = 0; index < 3; index += 1) {
          clients.push(await connectLoadClient(server.url, holdSlowAck && index === 0));
        }
        expect(clients.map((client) => client.socket.extensions)).toEqual([
          "permessage-deflate",
          "permessage-deflate",
          "permessage-deflate",
        ]);
        const subscriptions = Array.from({ length: THREAD_COUNT }, (_, index) => {
          const client = clients[Math.floor(index / 8)]!;
          return {
            client,
            slow: holdSlowAck && index === 0,
            ...client.subscribe(`thread-${index}`, holdSlowAck && index === 0),
          };
        });
        await server.subscribed;
        const tcpBytesBefore = server.tcpSockets.reduce(
          (sum, socket) => sum + socket.bytesWritten,
          0,
        );
        let sampledMaxServerQueuedBytes = 0;
        let sampledMaxClientBufferedBytes = 0;
        queueSampler = setInterval(() => {
          sampledMaxServerQueuedBytes = Math.max(
            sampledMaxServerQueuedBytes,
            server.tcpSockets.reduce((sum, socket) => sum + socket.writableLength, 0),
          );
          sampledMaxClientBufferedBytes = Math.max(
            sampledMaxClientBufferedBytes,
            clients.reduce((sum, client) => sum + client.socket.bufferedAmount, 0),
          );
        }, 5);
        const latencies = { read: [] as number[], send: [] as number[], ping: [] as number[] };
        const startedAt = performance.now();
        await server.start();
        const recovered = holdSlowAck
          ? server.overflow.then(() => clients[0]!.releaseAck())
          : Promise.resolve();
        const probes = Promise.all(
          clients.map(async (client, index) => {
            for (let sample = 0; sample < 50; sample += 1) {
              await Promise.all(
                (["read", "send", "ping"] as const).map(async (kind) => {
                  const start = performance.now();
                  const frame = await (kind === "ping"
                    ? client.ping()
                    : client.request(`test.${kind}`, {
                        threadId: `thread-${index * 8}`,
                        ...(kind === "send" ? { text: "send while streaming" } : {}),
                      }).exit);
                  latencies[kind].push(performance.now() - start);
                  if (kind === "ping") expect(frame._tag).toBe("Pong");
                  else
                    expect(frame.exit).toMatchObject({
                      _tag: "Success",
                      value:
                        kind === "send" ? { accepted: true } : { threadId: `thread-${index * 8}` },
                    });
                }),
              );
              await new Promise((resolve) => setTimeout(resolve, 40));
            }
          }),
        );
        let streamingDurationMs = 0;
        const [exits] = await Promise.all([
          Promise.all(subscriptions.map((subscription) => subscription.exit)).then((exits) => {
            streamingDurationMs = performance.now() - startedAt;
            return exits;
          }),
          recovered,
          probes,
        ]);
        const durationMs = performance.now() - startedAt;
        for (let index = 0; index < subscriptions.length; index += 1) {
          const subscription = subscriptions[index]!;
          if (subscription.slow) {
            expect(exits[index]!.exit).toMatchObject({
              _tag: "Failure",
              cause: expect.arrayContaining([
                expect.objectContaining({
                  _tag: "Fail",
                  error: expect.objectContaining({
                    code: "ORCHESTRATION_STREAM_OVERFLOW",
                    retryable: true,
                  }),
                }),
              ]),
            });
            continue;
          }
          expect(exits[index]!.exit).toMatchObject({ _tag: "Success" });
          expect(
            subscription.client.received.get(subscription.id)?.map((delta) => delta.sequence),
          ).toEqual(Array.from({ length: DELTAS_PER_THREAD }, (_, sequence) => sequence));
        }
        expect(server.counts().overflowCount).toBe(holdSlowAck ? 1 : 0);
        expect(clients.every((client) => client.socket.readyState === WebSocket.OPEN)).toBe(true);
        const totals = clients.reduce(
          (sum, client) => {
            const metrics = client.metrics();
            return {
              receivedFrames: sum.receivedFrames + metrics.receivedFrames,
              receivedJsonBytes: sum.receivedJsonBytes + metrics.receivedJsonBytes,
              sentFrames: sum.sentFrames + metrics.sentFrames,
              sentJsonBytes: sum.sentJsonBytes + metrics.sentJsonBytes,
            };
          },
          { receivedFrames: 0, receivedJsonBytes: 0, sentFrames: 0, sentJsonBytes: 0 },
        );
        const deliveredDeltas = clients.reduce(
          (sum, client) =>
            sum + Array.from(client.received.values()).reduce((n, values) => n + values.length, 0),
          0,
        );
        console.info(
          "ws-streaming-load",
          JSON.stringify({
            case: holdSlowAck ? "slow-ack-recovery" : "healthy",
            threadsPerConnection: [8, 8, 4],
            offeredDeltasPerSecond: 1_000,
            durationMs: Number(durationMs.toFixed(2)),
            streamingDurationMs: Number(streamingDurationMs.toFixed(2)),
            slowBufferCapacity: holdSlowAck ? SLOW_BUFFER_CAPACITY : null,
            ...server.counts(),
            deliveredDeltas,
            deliveredDeltasPerSecond: Number(
              ((deliveredDeltas * 1_000) / streamingDurationMs).toFixed(2),
            ),
            ...totals,
            tcpServerWrittenBytes:
              server.tcpSockets.reduce((sum, socket) => sum + socket.bytesWritten, 0) -
              tcpBytesBefore,
            sampledMaxServerQueuedBytes,
            sampledMaxClientBufferedBytes,
            queueSampleIntervalMs: 5,
            latency: {
              read: latencySummary(latencies.read),
              send: latencySummary(latencies.send),
              ping: latencySummary(latencies.ping),
            },
          }),
        );
      } finally {
        clearInterval(queueSampler);
        for (const client of clients) client.socket.terminate();
        await server.close();
      }
    },
    30_000,
  );
});
