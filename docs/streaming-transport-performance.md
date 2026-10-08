# Streaming transport recovery

The transport and renderer fixes address three sources of extra work under concurrent streams:

- A snapshot-backed stream overflow previously returned an uncoded RPC error. The browser treated it as a socket failure, reconnecting every subscription and interrupting pending requests. It now returns `ORCHESTRATION_STREAM_OVERFLOW`; only that stream restarts, with delays from 250 ms to 10 seconds. Thread cursors survive, so durable gap replay recovers dropped events. A partial delivery does not reset the backoff; ten seconds of stream stability does. Unsubscribe and disposal cancel retries.
- Desktop project recovery subscribed to complete thread details. When project rows were missing, streaming updates repeatedly abandoned pending snapshot replies and started additional reads. It now selects only the recovery boolean. Failed reads retry independently from one to 30 seconds, with stale-owner and cleanup guards.
- Completion notifications rescanned unchanged completed histories on every streaming flush. The existing immutable thread identity now skips those histories. Changed lifecycle/background-task state still follows the existing notification rules.

## Before and after

Measured against the parent revision, with synthetic data and no provider processes or user profile data:

| Case                                                                                            |    Before |   After |
| ----------------------------------------------------------------------------------------------- | --------: | ------: |
| One overflow: socket reconnect calls                                                            |         1 |       0 |
| Recovery subscription invalidations, 200 message updates + 20 session updates across 20 threads |       220 |       0 |
| React recovery subscriber renders, 100 batches of 20 deltas                                     |       100 |       0 |
| Sidebar subscriber renders in the same Chromium test                                            |         0 |       0 |
| Unchanged history reads, 200 completed threads + 20 streams, 100 flushes                        |   100,000 |       0 |
| Notification candidate work, 200 completed histories of 500 activities, 100 flushes             | 672.07 ms | 2.31 ms |
| Same notification benchmark, p99 per flush                                                      |  37.76 ms | 0.11 ms |

Render counts exclude initial mounting. Notification timings came from an ad hoc same-process comparison with the parent implementation, not a CI timing threshold. The committed tests assert the work counts and lifecycle behavior.

## Reproduce

```sh
bun run --cwd apps/server test src/wsStreamBackpressure.test.ts src/wsSnapshotLiveStream.test.ts src/wsStreamingLoad.test.ts --silent=false
bun run --cwd apps/web test src/wsTransport.test.ts src/lib/desktopProjectRecovery.test.ts src/notifications/taskCompletion.logic.test.ts src/notifications/taskCompletion.streaming.test.ts
bun run --cwd apps/web test:browser src/lib/desktopProjectRecovery.streaming.browser.tsx
bun run --cwd apps/web test:browser src/components/EventRouter.browser.tsx -t 'desktop project recovery'
```

The wire fixture uses the production Node HTTP/WebSocket adapter and Effect RPC, port zero, compression, and three clients with 8/8/4 streams. Each stream offers 100 deltas at 50 Hz; read/send/Ping probes run concurrently. The slow-consumer case holds one ACK and uses capacity 16 to accelerate overflow, then releases the ACK so its typed failure can be delivered. The fixture verifies all 19 other streams finish without gaps and all three sockets remain open. Its JSON metrics include delivered rate, frame counts, payload bytes, TCP bytes, sampled queues and RPC latency percentiles.

A local run on 2026-10-08, with 150 probes of each kind per case:

| Metric                                    |         Healthy | One stream overflow |
| ----------------------------------------- | --------------: | ------------------: |
| Delivered deltas / second while streaming |          927.32 |              930.62 |
| Received JSON bytes                       |         408,569 |             393,206 |
| Server TCP bytes after handshake          |          25,717 |              24,951 |
| Read RTT p50 / p99                        | 3.03 / 32.03 ms |     2.31 / 16.12 ms |
| Send RTT p50 / p99                        | 3.72 / 34.23 ms |     2.68 / 17.59 ms |
| Ping RTT p99                              |        35.60 ms |            23.10 ms |
| Maximum RTT across all probes             |        35.62 ms |            23.32 ms |
| Sampled server TCP queued bytes           |               0 |                   0 |

These are separate synthetic cases, not a before/after latency comparison. Queue sampling runs every 5 ms and can miss peaks. The transport's existing ACKs bound outstanding chunks; they do not establish a hard byte budget for large snapshots or pending compression writes.

This does not reproduce provider ingestion, SQLite contention, checkpoints, process spawning, mobile networks, or large historical snapshots. Existing production detail subscriptions remain capped at eight per client; the shell sends summaries for other threads. Existing client delta batching and sidebar summary isolation are retained.
