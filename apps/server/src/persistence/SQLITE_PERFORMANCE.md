# SQLite contention investigation

Measured on 2026-10-08 with Node 24.13.1 / SQLite 3.51.2. This investigation
covers persistence and projection queries; it does not establish the cause of
the entire application outage or validate twenty live providers.

## Confirmed blocking paths

- `NodeSqliteClient` calls `DatabaseSync` statements on the server event loop.
  The Bun adapter also executes SQLite synchronously. An Effect fiber does not
  move statement execution to another thread. Slow reads therefore delay
  unrelated requests and writes.
- The thread-title high-water query used the broad stream index and inspected
  each event payload. Sending to a long thread invokes this fence even when
  title generation will subsequently be skipped. The copied database had
  1,119,979 events, with up to 53,159 in one thread; the sparse title index
  contained only 780 entries. Adding that index alone did not change SQLite's
  plan without statistics, so the query explicitly selects it.
- Activity readers ranked historical payloads before applying the display
  limit. The full snapshot ranked history twice. Task lifecycle checks repeated
  JSON extraction from large historical tool outputs, and old unresolved
  interaction checks searched a thread's activities repeatedly. The new path
  ranks metadata once, reads task fields from a partial expression index,
  finds resolutions by request ID, and joins bodies only for retained IDs.

These changes preserve existing caps, split-turn handling, active-turn
selection, task evidence, handoffs, pending interactions, ordering and complete
retained payloads. The new migrations are additive and apply to both channels.

## Measurements

All database mutations were confined to a disposable APFS clone of the
4,025,151,488-byte database and its WAL. Source size and modification timestamps
were stable during the 35 ms clone. No production database or server was changed.
The snapshot initially contained 262,996 activities, 12,672 messages and 400
threads. Repeated synthetic runs added small test threads; the final full
snapshot had 560 threads. Other workers were active on the same machine, so
separate runs are sensitive to CPU load and filesystem cache.

| Measurement                                                              |                                        Before |           After | Interpretation                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------: | --------------: | -------------------------------------------------------------------------------- |
| Title SQL, 60 reads of 20 busiest event histories, p99                   |                                      5,655 ms |        0.444 ms | Separate runs; query plan changed from broad stream scan to sparse title lookup. |
| Activity SQL, 60 alternating before/after reads on the same copy, median |                                      126.9 ms |         53.0 ms | Production cache/mmap budget; identical rows in all 60 comparisons.              |
| Same paired activity SQL, p99                                            |                                      740.9 ms |        653.1 ms | Large retained bodies still dominate the worst reads.                            |
| Full snapshot                                                            | Original benchmark exceeded its 180 s timeout |       21,947 ms | Separate runs; final full snapshot remains an event-loop stall.                  |
| Final concurrent workload, deep-read p99                                 |                                             — |        266.0 ms | Twenty writes and one read queued per round; 25 reads.                           |
| Final concurrent workload, write p99                                     |                                             — |        361.5 ms | 500 engine deltas, including queueing; 3,063 ms overall.                         |
| Final concurrent workload, event-loop delay p99 / maximum                |                                             — | 46.3 / 219.9 ms | No providers, transport or consumer reactors.                                    |

These are small diagnostic samples; with 25 or 60 reads the reported p99 is
the observed maximum, not a reliable long-run percentile estimate. The final
idle deep-read p99 was 612.7 ms; title reads through Effect had a 0.803 ms p99.

In a separate instrumented run of 500 deltas with reads between write bursts,
610 COMMIT statements had a 0.085 ms median, 14.8 ms p99 and 32.8 ms maximum.
This run showed slow reads rather than multi-second individual commits; it
does not rule out contention from the additional provider/consumer writes.

Persisted assistant streaming events contain the delta fragment, not the
accumulated message. A 10,000-event recent-history sample (skipping the newest
10,000 rows to exclude synthetic writes) contained 8,564 assistant streaming
events: mean JSON payload 327 bytes, maximum 425; mean text 5 characters,
maximum 28. Tiny fragments have substantial per-event overhead. The existing
delta coalescer addresses this ingestion issue; this change does not redo it.
The largest activity payload on the copy was 32,839 bytes, so retaining thousands
of activities still requires materializing substantial output.

The four indexes occupy 87,986,176 bytes (about 84 MiB) on this copy: 81,920
for titles, 52,977,664 for activity ordering, 34,922,496 for task evidence, and
4,096 for interaction resolution. Index creation and the existing pre-migration
backup can make first startup expensive on a large database.

**The less-than-50-ms p99 goal is not met for deep histories.** Returning and
decoding retained payloads remains expensive even after the historical scans
are removed. A full snapshot also materializes every live thread's retained
history. These results are improvements, not proof that the outage is resolved.

## Reproduce the isolated workload

Prepare a disposable, consistent database snapshot under the system temporary
directory. Include the WAL when copying an active database; an arbitrary copy
of the database alone is insufficient. Do not pass production data directly.
The opt-in benchmark resolves the path and rejects inputs outside `tmpdir()`.
It runs migrations and adds synthetic projects, threads and events to its input.

```sh
SYNARA_SQLITE_BENCHMARK_DB=/absolute/system/tmp/snapshot/state.sqlite \
SYNARA_SQLITE_BENCHMARK_OUTPUT=/absolute/system/tmp/metrics.json \
bun run --cwd apps/server test src/persistence/Layers/SqliteStreaming.benchmark.test.ts
```

Set `SYNARA_SQLITE_BENCHMARK_FULL=1` to also time the full snapshot. The harness
uses production cache/mmap, WAL, NORMAL synchronous and busy-timeout settings,
queues twenty real engine/projection delta writes and one deep-history read
concurrently per round, and records latency and event-loop delay. It excludes
provider ingestion/journaling, consumer reactors, transport, rendering, process
startup, checkpoints/git and migration backup maintenance. It is skipped in
ordinary tests. Output contains only versions, settings and aggregate timings.

## Remaining work and boundaries

- Provider ingestion: each surviving coalesced delta still has a runtime-journal
  write and engine transaction. `ProviderCommandReactor` also advances its
  consumer cursor per event through a separate transaction. Its batching belongs
  in the reactor/ingestion area; this change does not alter delivery semantics.
- Sending: `ProviderCommandReactor.resolveThread` loads full thread detail.
  Callers that need only metadata should consider the existing shell reader.
- Transport/client: `orchestration.getSnapshot` returns full retained histories;
  shell hydration plus focused thread loading avoids a large synchronous read.
  Reconnects and fan-out can amplify repeated reads.
- Retention: runtime-journal accepted-history deletion is unbounded on settlement;
  maintenance's final TRUNCATE checkpoint is synchronous. Neither was demonstrated
  to be the leading stall in this snapshot (only 4,201 journal rows initially).
- WAL already uses NORMAL synchronous, a 5 s busy timeout, a 64 MiB journal-size
  limit and SQLite's 1,000-page auto-checkpoint. No checkpoint starvation from a
  long reader was demonstrated on the single owned connection, so these settings
  were not changed. The journal-size limit is not an active-WAL size cap.
- Expression indexes assume valid JSON, as repository writes already do. They
  add storage and activity-write work. Live provider load and the packaged Bun
  runtime were not validated by the Node-only benchmark.
