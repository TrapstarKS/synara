# Provider ingestion load test

This investigation covers provider event ingestion after `b4cfd502c` (delta
coalescing/auth lookup) and `199928caf` (batched storage maintenance), on base
`e31ce661d`. It does not attribute the entire reported application outage to one
subsystem.

## Confirmed causes

The envelope is emitted by `CodexAppServerManager.handleServerNotification` in
[codexAppServerManager.ts](../apps/server/src/codexAppServerManager.ts), preserved
by `runtimeEventBase` in [CodexAdapter.ts](../apps/server/src/provider/Layers/CodexAdapter.ts),
and batched by `coalesceQueuedContentDeltas` in
[providerRuntimeEventPump.ts](../apps/server/src/provider/providerRuntimeEventPump.ts).
`ensureSubagentThread` in
[ProviderRuntimeIngestion.ts](../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts)
resolves the child only after that pump boundary.

- Native Codex children retain their parent's canonical Synara `threadId`.
  Their distinct conversation IDs live in `providerRefs.providerThreadId`.
  The pump previously grouped and counted only the canonical parent. Interleaved
  children therefore defeated both coalescing and adaptive pacing.
- The old merge predicate also omitted the child route and parent turn. Two
  siblings with overlapping turn/item IDs merged into one child's text in a
  regression fixture.
- An event batch could monopolize the event loop even when each event was small.
  With 100 synchronous one-millisecond events, a zero-delay request timer first
  ran after event 100. Effect's operation-count scheduling did not provide a
  wall-clock limit. The same failure reproduced with single-event stream chunks.

The fix groups deltas by canonical parent and native child route, checks parent
identity before merging, and counts actual conversations for adaptive pacing.
Child lifecycle events fence their own conversation. Parent lifecycle/output
and collaboration events fence the family, because nested collaboration can
append a parent activity when child materialization reaches its cap.

The pump yields through a timer after eight milliseconds between completed
events, carrying the budget across stream chunks. It preserves serial processing,
in-place retry, quarantine, and health tracking. A single expensive event can
still exceed this budget.

## Workload and verification

The opt-in test uses the production runtime event pump, runtime event repository,
orchestration engine, and projection pipeline with a disposable SQLite database.
It reuses these services rather than duplicating persistence behavior. The small
route helper is local to the pump; no existing shared conversation-key helper
covered the native-child envelope.

- Paced: 20 conversations, 100 deltas/second each for three seconds, 6,000 deltas.
- Burst: 2,000 queued deltas alternating item IDs, preventing coalescing.
- Both direct Synara threads and native children sharing one canonical parent.
- Ten user-initiated metadata commands and shell reads per second; a 10 ms timer
  records delay. The production 100 ms coalescing window is enabled.
- Every completed case checks exact final text/order, journal row counts, and all
  20 completions. Focused tests also cover route collisions, parent turns,
  lifecycle/output/collaboration fences, retries, quarantine, and timer admission.

Run from the repository root:

```sh
SYNARA_PROVIDER_PUMP_BENCHMARK_OUTPUT=/tmp/synara-provider-pump.json \
  bun run --cwd apps/server test src/provider/providerRuntimeEventPump.benchmark.test.ts
```

For one case, add `SYNARA_PROVIDER_PUMP_BENCHMARK_CASES=native-child/paced`.
Supported names are `direct/paced`, `native-child/paced`,
`direct/prequeued-mixed`, and `native-child/prequeued-mixed`; comma-separated names
select multiple cases. The JSON includes source hashes, counts, CPU, event-loop
delay, command/read latency, text hashes, and completion/failure status. Completed
cases are written before the next measurement so later failures retain evidence.
Normal test runs skip this benchmark.

No server listener or provider process is started. Temporary homes/databases are
created beneath the operating system's temporary directory and removed after
each case. The test does not open the user's Synara or Beta data.

## Measurements

Captured on 2026-10-08, Apple M4 Pro, macOS/Darwin 25.3.0, Node 24.13.1.
The command runner was Bun 1.3.14; the repository requests Bun 1.4.2. The baseline
pump source hash was
`ea9c03c8c2663b5475274a115a8ea6050c3bf364ae49ed1d8e36a59ba4572fc4`.

Baseline paced native children processed 6,000 canonical deltas, consumed 14.532 s
CPU, and drained in 36.154 s. Equivalent direct streams processed 60 deltas,
consumed 1.114 s CPU, and drained in 5.782 s. This is a confirmed workload
multiplier; absolute timings vary with host contention.

The focused after-run used the same workload and unchanged engine/projection/
repository source hashes. Its pump hash was
`1edf8837a7b5b098b3985f50f74b92955775d6949154924413697d9ade3b8f0d`.

| Native child paced workload            |             Before |            After |
| -------------------------------------- | -----------------: | ---------------: |
| Canonical deltas / 6,000 raw           |              6,000 |              200 |
| Journal rows, including 20 completions |              6,020 |              220 |
| CPU, user + system                     |           14.532 s |          0.944 s |
| Input + drain time                     |           36.154 s |          3.404 s |
| Event-loop delay p99 / max             | 106.69 / 227.93 ms | 48.76 / 90.51 ms |
| User command dispatch p99              |          134.04 ms |         42.07 ms |
| User command arrival + dispatch p99    |          250.36 ms |        161.59 ms |

Canonical work fell 96.7% and CPU fell 93.5% in this pair of runs. All 20
conversations retained exact final text/order. These are synthetic pipeline
measurements, not a guarantee for a live provider or a multi-gigabyte user DB.

| Direct thread paced workload        |             Before |              After |
| ----------------------------------- | -----------------: | -----------------: |
| Canonical deltas / 6,000 raw        |                 60 |                200 |
| CPU, user + system                  |            1.114 s |            1.064 s |
| Input + drain time                  |            5.782 s |            3.487 s |
| Event-loop delay p99 / max          | 243.14 / 301.73 ms | 120.46 / 162.79 ms |
| User command dispatch p99           |          775.72 ms |          175.22 ms |
| User command arrival + dispatch p99 |          886.97 ms |          191.19 ms |

The higher direct canonical count reflects smaller queued batches as callbacks
arrive more promptly; input text is identical. The event-count fixture separately
confirms 800 interleaved native child deltas reduce to 20 without losing text.
The timer regressions confirm request admission within 20 one-millisecond events
instead of after all 100, for both queued batches and single-event chunks.

The full baseline and the final mixed rerun each preserved all 2,000 deltas,
2,020 journal rows, exact text/order, and 20 completions in both burst cases.

| Mixed burst workload                |              Direct before → after |        Native child before → after |
| ----------------------------------- | ---------------------------------: | ---------------------------------: |
| Canonical deltas                    |                      2,000 → 2,000 |                      2,000 → 2,000 |
| CPU, user + system                  |                    8.304 → 1.816 s |                    5.333 → 1.742 s |
| Drain time                          |                   31.074 → 2.119 s |                   14.227 → 1.894 s |
| Event-loop delay p99 / max          | 273.94 / 474.74 → 21.66 / 23.02 ms | 134.61 / 263.19 → 11.70 / 22.30 ms |
| User command dispatch p99           |                1,264.63 → 17.27 ms |                   187.44 → 6.14 ms |
| User command arrival + dispatch p99 |                1,391.59 → 32.14 ms |                 397.58 → 105.05 ms |

One earlier mixed after-run timed out during the host contention described below.
The paired paced reruns and final mixed attempt completed with the previously
observed heavy test/typecheck processes gone. All four after scenarios passed;
absolute timing still depends on the machine's other work.

## Final code checks

- `bun run fmt:check`: passed.
- `bun run lint`: passed with 894 repository warnings and zero errors.
- `bun run typecheck`: all seven workspace packages passed.
- `bun run --cwd apps/server test` with the pump, Codex adapter, ProviderService,
  ingestion/buffering, engine, and command admission test paths: 391 passed; the
  opt-in benchmark was skipped in the normal suite.
- The separate benchmark invocations verify their own exact text/order, journal
  counts, and completion assertions. Initial regression tests failed on the old
  pump; one fixture typing error found by typecheck was corrected before this pass.
- Documentation local links and `git diff --check`: passed.

## Limits and owner leads

- The synthetic mapper bypasses Codex stdout parsing, callback ingress,
  `ProviderService`, and `ProviderRuntimeIngestion`; no WebSocket/client or live
  provider is exercised. All synthetic item IDs project into one message per
  conversation. SQLite auto-checkpointing is disabled during measurement.
- During a concurrent multi-worktree full-test/typecheck storm, one after-run's
  mixed burst hit the 45 s engine timeout and 120 s harness watchdog. That run
  is not evidence of either a latency improvement or a regression. The final quiet
  attempt passed both mixed cases.
- Transient retries still hold the provider pump's head event. Durable ingestion
  still uses one journal cursor/worker; the engine still executes one command at
  a time. Existing control/user priority lanes choose the next command, but do
  not preempt an active command or synchronous SQL statement.
- Persistence owner: each native child delta additionally loads parent and child
  shells (three SQL reads each) in real ingestion. The single SQLite connection,
  transaction/write cost, and heavyweight terminal detail loads remain separate
  scaling leads. Coalescing reduces their event count, not their per-event cost.
- Transport owner: `ProviderService`'s bounded lossless fan-out can pause pumps
  behind a slow subscriber; check subscription consumers and recovery behavior.
- Process/load owner: concurrent test/typecheck processes produced observable
  machine-wide contention during validation. These checks must be accounted for
  separately from provider ingestion CPU and Git/checkpoint work.
- Disk retention, migrations, checkpoint/process code, and UI behavior are outside
  this change. These fixes ship in both Stable and Beta and add no diagnostics.
