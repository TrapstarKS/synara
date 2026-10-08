# Orchestration concurrency findings

The fixture compares the runtime at `e31ce661d` (including `b4cfd502c` and
`199928caf`) with the area-5 changes. See [the run instructions](orchestration-load.md).
All homes, repositories and ports are disposable; no installed user's data was read
or changed. These measurements use fake Codex JSONL processes, real server services,
SQLite and subscribed WebSockets on macOS arm64 with Bun 1.4.2 and Node 24.13.1.
The six final baseline and patched runs passed. They establish resource-burst and
correctness regressions, but do not reproduce the original complete app outage.
The [measured ranking](orchestration-load.md) separates startup, emission and drain;
the changes lower peak lag but do not improve total streaming throughput.

## Confirmed mechanisms and fixes

| Mechanism                                                                                   | Evidence                                                                                                                                                                    | Change                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkpoint single-flight only joins the same ref; different threads still hash concurrently | Distinct-ref burst test covers 20 captures; existing turn delivery has eight lanes                                                                                          | Two capture slots across repositories, inside the existing timeout; duplicates do not take another slot                                     |
| Unbounded Codex startup and missing pre-spawn ownership                                     | New regression tests failed on the baseline: 20 simultaneous preparations; two same-thread starts overwrote one live context; stop, shutdown and abort allowed a late spawn | Four shared startup slots, existing per-key lock, tracked starts, adapter cancellation signal and discovery shutdown fence                  |
| Stdio MCP EOF exits before stdout flushes                                                   | Slow reader received only 131,072 of 1,048,628 response bytes with exit code zero                                                                                           | Await write completion in the existing output queue; all 1,048,628 bytes verified on Node and Bun                                           |
| Each unresolved durable wait loads running targets individually                             | 20 pinned running targets caused 20 shell reads per scan                                                                                                                    | Existing batched wait snapshot: one batch, no shell/turn/detail reads until eligible; terminal and missing targets retain settlement checks |
| Auto-arm builds child arrays by repeatedly copying them                                     | 10,000 children copy 49,995,000 entries; isolated Node p50 55.086 ms                                                                                                        | Append in place; p50 0.153 ms, preserving order                                                                                             |
| Failed POSIX process-table capture falls back for every terminal                            | 20-terminal regression exercises one shared failed capture and per-terminal fallback                                                                                        | Preserve activity until a successful shared capture; zero extra fallback calls                                                              |

The capture and startup limits bound resource bursts rather than total live sessions.
Each top-level Codex thread still owns a process. Pooling processes would change
account, permission, transport and teardown ownership; this change preserves those
contracts. A queued capture still consumes its existing deadline. Provider starts
retain the service's 60-second deadline, and canceled starts cannot launch later.

## Scope and remaining findings

- Area 1: `apps/server/src/provider/providerRuntimeEventPump.ts:361` still processes
  merged runtime events sequentially and then sleeps for its existing coalescing
  window. The barrier cases emit for about 11.3 seconds, but completion p99 is
  31.8–34.2 seconds. The resulting drain ranks above area-5 startup cost; this
  does not isolate ingestion CPU from persistence, projections or transport.
  A lower journal row count after shutdown does not prove lost events because
  acknowledged rows can be pruned.
- Areas 2 and 3: `apps/server/src/wsRpc.ts:1384` loads the projection detail through
  `getThreadDetailSnapshotById` while the journal and
  projection pipeline write. One active detail load at 10 Hz is the reported
  workload. An earlier observer that read all 20 details every 250 ms overloaded
  the server and is excluded from the comparison; it is not normal chat usage.
  All 20 thread streams are subscribed in this fixture; its transport volume is
  heavier than a client displaying only one thread and the shell.
- Hubs: `apps/server/src/agentGateway/hubWorkGateway.ts:178` calls reconciliation
  before checking paused/disabled configuration; its tick scans all configurations
  at `:203`. `apps/server/src/projectAgent/hubWorkService.ts:375` reads
  historical mapped workers every tick, including completed and canceled tasks.
  Their later human follow-ups still occupy slots, so filtering them changes
  behavior. An event-driven invalidation or bounded incremental reconciliation
  needs its own lifecycle design and measurements.
- Area 4: the fresh-database growth here measures streaming amplification, not
  pruning of multi-GB databases, backups or Codex transcript retention.

No live Codex authentication, live tool execution, browser rendering or packaged
Windows process cleanup is established by these measurements. The Windows boundary
check and installed-runtime process tests are separate checks.
