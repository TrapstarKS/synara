# Orchestration load fixture

Run from the repository root with the pinned Bun version in `.mise.toml`, Node
and Git installed, and the workspace dependencies already installed:

```sh
bun apps/server/scripts/orchestration-load.ts --threads 1 --rate 100 --seconds 10 --baseline --output /tmp/load-before-1.json
bun apps/server/scripts/orchestration-load.ts --threads 20 --rate 100 --seconds 10 --baseline --output /tmp/load-before-20.json
bun apps/server/scripts/orchestration-load.ts --threads 1 --rate 100 --seconds 10 --output /tmp/load-after-1.json
bun apps/server/scripts/orchestration-load.ts --threads 20 --rate 100 --seconds 10 --output /tmp/load-after-20.json
```

Run the four cases sequentially on an otherwise idle machine. `--rate 20` is a
lower-rate workload; `--rate 100` stresses ingestion with 2,000 assistant deltas
and 500 command-output deltas per second across 20 threads. `--seconds` controls
emission duration, not startup or drain time. The fixture fails if exact assistant
text, turn completion, stream delivery, file changes, or server exit cannot be
verified. Use `--keep-home` to retain the fixture's temporary home for debugging.
An unproven process-tree exit always retains that home and records its location
in the failure report, even without the flag.

`--baseline` substitutes changed, tracked runtime TypeScript files from
`--baseline-ref e31ce661d` using a Bun preload hook. It never resets or edits the
checkout. That reference includes `b4cfd502c` (delta coalescing/auth lookup fixes)
and `199928caf` (bounded maintenance/thread deletion), so the comparison keeps
those improvements. The JSON records the substituted files and source revision.
The dependencies and unchanged files come from the current checkout; this is a
source comparison, not a historical packaged binary benchmark. Select another
baseline explicitly when comparing later changes.

The fixture starts the real Synara CLI server with a fresh temporary Synara home,
Codex home, Git repository and authenticated loopback endpoint. It checks IPv4
and IPv6 port availability and prints the dev-runner dry run before starting.
The child receives an explicit environment, without inherited provider credentials,
production auth tokens or production homes. All other providers are disabled.
Existing platform process creation and verified tree teardown own the child.

The fake Codex executable implements the app-server JSONL boundary. Every thread
streams assistant text, runs a synthetic command with incremental output, creates
a real fixture file, emits item completions and completes its turn. Providers wait
at a file barrier until every provider has accepted `turn/start`, then begin
streaming together. Per-process timestamps verify that all requested emission
intervals overlap; a lower measured overlap fails the fixture. The barrier separates
the startup burst from the guaranteed concurrent streaming burst.
Twenty threads use three WebSocket connections because the existing server permits eight thread
subscriptions per connection; requests also stay within its control admission
limit. A shell subscription observes all thread completions. Navigation loads one
thread detail every 100 ms, and final validation loads each completed thread once.
The fake provider does not execute the displayed command or contact OpenAI.

The JSON contains:

| Measurement                       | Meaning                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `server.lagMs`                    | Timer drift above 10 ms, sampled inside the server process throughout startup, streaming and drain. |
| `server.rssBytes`                 | Initial, peak and final server RSS; excludes fake-provider child RSS.                               |
| `server.phaseLagMs`               | The same timer drift separated into provider startup and streaming/drain phases.                    |
| `fakeProviders`                   | Verified emission overlap, emission duration and sampled fake-process RSS.                          |
| `wsLatencyMs.loadThread`          | Actual thread-detail RPC round-trip during the workload.                                            |
| `wsLatencyMs.sendMessageReceipt`  | Turn-start command receipt latency; acceptance precedes provider delivery.                          |
| `wsLatencyMs.firstAssistantText`  | Time from the shared dispatch start to the first assistant text seen on each thread subscription.   |
| `wsLatencyMs.completion`          | Time from dispatch start to completed turn seen on the shell subscription.                          |
| `storageBytes`                    | Initial, peak and final live DB/WAL sizes, plus durable row counts read after verified shutdown.    |
| `rawProviderDeltas` / `transport` | Requested raw delta count and actual received WebSocket bytes, frames and stream frames.            |

The sampler checks one marker and reads RSS every 10 ms, and sorts/writes a small
metrics snapshot every 250 ms. Its overhead is included equally in both cases.
WAL growth is sampled during the workload, before shutdown truncation; SQLite's
normal checkpoints can leave the WAL size flat while the main database grows.
Final journal row counts reflect retention, not total lifetime writes.
Only validated runs should be compared. CLI receipt, first text and completion
measure different user-visible stages and should remain separate.

Add `--staggered-start` to let each provider emit immediately as its session starts.
This tests startup overlapping ingestion and reports the measured overlap without
requiring 20-way simultaneous emission. Its streaming phase includes startup.
Exact text, all turn completions and file changes remain required. Compare this
case separately from barrier cases; a staggered failure is useful evidence of
startup/ingestion contention and must not be reported as a successful load run.

## Measured results

These six sequential runs used Bun 1.4.2 on macOS arm64, 100 assistant deltas per
second per thread, 10 seconds requested emission, and the same final fake fixture.
Every run verified exact assistant text, all completions, one file per thread,
the stated peak overlap, and graceful server/descendant exit without escalation.
The baseline restores `e31ce661d`; candidate measurements used the runtime changes
described in [the findings](orchestration-load-findings.md), before their commit.
Reports below retain their original source revision and remove transient homes.

| Measurement                       | [Base 1](evidence/orchestration-load/barrier-baseline1.json) | [Candidate 1](evidence/orchestration-load/barrier-patched1.json) | [Base 20](evidence/orchestration-load/barrier-baseline20.json) | [Candidate 20](evidence/orchestration-load/barrier-patched20.json) | [Base 20 staggered](evidence/orchestration-load/staggered-baseline20.json) | [Candidate 20 staggered](evidence/orchestration-load/staggered-patched20.json) |
| --------------------------------- | -----------------------------------------------------------: | ---------------------------------------------------------------: | -------------------------------------------------------------: | -----------------------------------------------------------------: | -------------------------------------------------------------------------: | -----------------------------------------------------------------------------: |
| All providers ready, seconds      |                                                         0.72 |                                                             0.66 |                                                           4.40 |                                                               4.09 |                                                                       3.13 |                                                                           5.15 |
| Event-loop lag p99 / max, ms      |                                               29.62 / 256.45 |                                                    12.28 / 85.86 |                                                 29.40 / 867.07 |                                                     22.67 / 234.62 |                                                             15.91 / 184.57 |                                                                  21.88 / 83.51 |
| Load-thread RPC p99 / max, ms     |                                              187.99 / 298.63 |                                                  121.59 / 127.63 |                                                112.10 / 802.39 |                                                    288.93 / 358.46 |                                                             32.72 / 145.34 |                                                                  52.95 / 81.12 |
| Send-message receipt p99, ms      |                                                        28.25 |                                                            25.13 |                                                         527.05 |                                                             291.98 |                                                                     328.03 |                                                                         335.20 |
| First assistant text p99, seconds |                                                         0.77 |                                                             0.72 |                                                           5.11 |                                                               4.53 |                                                                       4.76 |                                                                           6.90 |
| Turn completion p99, seconds      |                                                        12.34 |                                                            12.20 |                                                          31.80 |                                                              34.22 |                                                                      22.06 |                                                                          26.24 |
| Server peak RSS, MB               |                                                       363.84 |                                                           416.58 |                                                         680.39 |                                                             650.02 |                                                                     755.15 |                                                                         747.88 |
| Live DB / WAL peak, MB            |                                                  2.65 / 4.18 |                                                      2.84 / 4.18 |                                                   30.96 / 5.81 |                                                       31.23 / 8.29 |                                                              30.38 / 10.45 |                                                                   28.52 / 7.61 |
| Verified peak stream overlap      |                                                            1 |                                                                1 |                                                             20 |                                                                 20 |                                                                         20 |                                                                             20 |

MB means decimal bytes. These are single samples, not statistically established
speedups; with 20 requests, the request p99 is the maximum. Startup limits reduced
the longest observed event-loop stalls and barrier-case receipt latency, while
completion and several RPC percentiles worsened. The staggered candidate took
longer to admit all providers. Do not claim an overall throughput improvement.

The measured remaining costs rank as follows; source attribution is an inference,
not a CPU profile:

1. **Streaming ingestion and drain.** Twenty threads emit 20,000 assistant deltas,
   5,000 command-output deltas and 20 file-output deltas. They finished emitting
   in about 11.3 seconds, but the last barrier-case completion arrived roughly
   16.1 seconds later on baseline and 18.8 seconds later on candidate. Durable
   engine rows were 6,333 and 6,387, and the DB grew from about 1.3 MB to 31 MB.
   Post-shutdown inspection counted 5,544 / 5,596 `thread.message-sent` events
   and 604 / 605 activity events. The existing
   [delta coalescer](../apps/server/src/provider/providerRuntimeEventPump.ts)
   merges only consecutive compatible deltas within a thread; the interleaved
   command-output stream interrupts assistant merging. Profile journal writes,
   engine dispatch and projection work before changing ordering guarantees.
2. **Full thread snapshots and transport volume.** The 20-thread barrier runs
   delivered 57.0 / 95.8 MB through WebSocket, including subscriptions and repeated
   detail snapshots. Candidate navigation p99 rose to 289 ms while its maximum
   fell to 358 ms. An earlier experiment loading all 20 complete snapshots every
   250 ms failed to drain within 90 seconds; that observer overload is separate
   navigation stress, not evidence of normal one-active-chat behavior. Incremental
   query/broadcast profiling is the next measurement.
3. **Provider process admission and memory.** Startup-phase lag p99 fell from
   45.45 to 12.44 ms in the 20-thread barrier run, consistent with bounding the
   startup burst. Staggered readiness slowed from 3.13 to 5.15 seconds. Each fake
   Node provider sampled about 43–46 MB RSS at its lifecycle endpoints, separate
   from server RSS. These subprocess measurements do not predict real Codex memory
   or authentication cost, and summed RSS is not unique physical memory.

An [earlier staggered baseline failure](evidence/orchestration-load/legacy-staggered-baseline20-failed.json)
validated only 5 of 20 threads before timeout. That older fake fixture used a
100 ms start delay and did not record overlap. **The identical final-fixture
staggered baseline passed all 20 threads; the old failure remains unreproduced.**
Retained journal row counts cannot prove event loss, and this failure cannot
support a claim that the candidate repaired it.

```sh
bun run --cwd apps/server test scripts/orchestration-load.test.ts
```

The focused test checks parameter bounds, percentile calculation and overlap; every full
fixture run additionally checks real server, process, persistence and transport
behavior. This does not prove live Codex authentication or startup, live tool
execution, packaged Windows behavior, browser rendering, or existing multi-GB
database maintenance.
