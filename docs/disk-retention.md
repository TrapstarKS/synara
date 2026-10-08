# Disk retention

The new backup, Codex artifact, and server-log policies use the configured data
home. They do not inspect the other release channel's home. Development and
tests use isolated temporary homes; none of the measurements below involved
deleting production data.

| Data                              | Automatic policy                                                                                                                                                                                     | Protected data                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database backups                  | At startup, after successful migrations, and during daily SQLite maintenance: newest migration snapshot; at most two recognized manual snapshots, with older manual snapshots expiring after 30 days | Active/failed migration marker, completed migration provenance, newly created snapshot, and newest manual snapshot regardless of age. Invalid recovery records stop finished-backup cleanup.                                |
| Deleted Codex rollouts and images | Capture a bounded private manifest before provider teardown; after seven days, reclaim captured regular files when teardown succeeded and the thread was permanently purged                          | Every surviving resume binding, archived threads, native subagent references, recent files, and images referenced by surviving messages/chunks/activities. Unknown provenance, ambiguous homes, and symlinks are preserved. |
| SQLite journal                    | Seven-day provider receipt and completed-message delta retention, in short batches                                                                                                                   | Final message events, incomplete/empty-final messages, unapplied final events, and inflight/retry/uncertain deliveries                                                                                                      |
| SQLite free pages                 | Incremental vacuum in bounded steps; older databases can switch mode with a space-checked full vacuum before startup                                                                                 | Live SQLite ownership and migration recovery requirements                                                                                                                                                                   |
| Managed worktrees                 | Existing retention keeps active worktrees and the 15 most recently archived; deleted worktrees are eligible for safe cleanup                                                                         | Shared/active owners and dirty checkouts; recovery snapshots expire after 30 days                                                                                                                                           |
| Server logs                       | 10 MiB per file plus three rotated backups                                                                                                                                                           | An oversized log from an older version survives rotation until it ages out after subsequent rotations                                                                                                                       |

Manual snapshot names recognized by retention are
`manual-pre-cleanup-YYYYMMDD.sqlite` and
`state.sqlite.manual-backup-<timestamp>[-<UUID>].sqlite`. Unknown names are kept.
The backup policy accepts internal options in `pruneDatabaseBackups`; no new
user-facing settings or migrations are required.

Codex cleanup uses the persisted launch home/continuation identity, not current
account selection. Only literal `codex-home-overlays/<profile UUID>` and
`codex-home-overlay[/accounts/<account>]` homes inside the configured Synara
home qualify. It never follows a `sessions` link into `~/.codex`, touches an
external dedicated home, or edits Codex's SQLite continuation indexes. A
manifest with no recorded home, an unconfirmed stop, an invalid path, or a
missing launch identity remains inert. A crash after binding removal but before
stop confirmation can leave files retained for manual inspection.

Archive means a conversation can be restored. Archived rollouts are retained
indefinitely because Codex resume needs them. Deleted images in their native
thread directory are captured; provider-supplied paths elsewhere remain
unmanaged. Before each unlink, cleanup checks thread/runtime ownership, journal
revision and projector progress again. Image reference reads use bounded pages
and yield between pages, so maintenance does not scan the entire history in one
synchronous SQL statement. Busy or lagging projections defer cleanup.

An isolated synthetic Codex 0.161.0 `thread/read` probe succeeded with a plain
`.jsonl` rollout, then failed with `thread not loaded` after only `.jsonl.gz`
remained. Automatic compression is therefore disabled. This is a local
compatibility observation, not a promise about other Codex versions. The
[official app-server documentation](https://developers.openai.com/codex/app-server/)
describes thread read/resume but does not establish gzip rollout compatibility.

The default launch without a Codex home override uses the user's native
`~/.codex`. Account/shadow homes can instead store their continuation data in
Synara's private profile directory. The old plural overlays remain allowlisted
for historical image links, but thread deletion previously erased the resume
binding without recording artifact ownership. Neither native CLI history nor
unattributed legacy history can be safely reclaimed by the new automatic sweep.

## Incident measurements, October 8, 2026

Measurements use file sizes, not allocated blocks. SQLite inspection used an
immutable read of the main database; it excludes changes still in the live WAL.

| Category                     |                                       Measured size | Expected recovery with conservative defaults                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two database snapshots       |     10.081 GB: manual 6.288 GB + migration 3.793 GB | 0 now: both are the newest recovery points. Prevents accumulating further unreferenced snapshots. An operator may remove the manual snapshot after deciding it is no longer needed.          |
| Legacy overlay rollouts      |                                            7.902 GB | 0 from historical unknown provenance. None of their native IDs matched the 85 current Codex bindings. Future explicitly deleted, attributable sessions are reclaimed after the grace period. |
| Legacy generated images      |                              Approximately 0.399 GB | Only captured images of deleted sessions without surviving references; historical savings cannot be safely inferred.                                                                         |
| Account profile data         |                                            1.636 GB | 0: includes 1.168 GB of `thread_history_1.sqlite` and 0.181 GB of `logs_2.sqlite`. These are provider-owned databases, not disposable credentials or caches.                                 |
| `state.sqlite`               |               4.023 GB; 982,153 pages × 4,096 bytes | Already `auto_vacuum=2` with zero free pages in the inspected main file. Vacuum alone reclaims effectively zero. Further savings depend on eligible completed history and consumer progress. |
| Logs                         | 0.161 GB, including 0.073 GB unbounded `server.log` | About 31 MB less server-log storage once the oversized legacy log ages out; future normal server-log allocation is bounded to 40 MiB. Other desktop/provider log bounds already exist.       |
| Worktrees                    |              Operator reported approximately 1.1 GB | Existing safe retention applies; active/dirty/unattributed checkouts cannot be counted as reclaimable.                                                                                       |
| User CLI `~/.codex/sessions` |            7.182 GB, including existing `.gz` files | 0 automatic; the user's CLI home is outside Synara retention ownership.                                                                                                                      |

The largest three legacy rollouts contain 4.919 GB. The largest alone is
3.170 GB: 1.751 GB custom tool outputs, 0.961 GB repeated compacted context,
0.345 GB completed-item records, and 2,335 embedded `data:image/` occurrences.
Its largest line is approximately 20.6 million characters. The other two contain
0.613 GB and 0.579 GB custom tool outputs. These are full native continuation
records; reducing Synara's streaming event count does not shrink them.

Coalescing in `providerRuntimeEventPump` happens before its persistence hook, so
Synara journals the merged delta once, not every original chunk plus the merged
one. The separate orchestration message journal still keeps both merged deltas
and the completed full text until retention makes the deltas redundant. Query
and write-path performance remain the persistence worker's responsibility.

The inspected journal contains 1,123,730 events with 1.125 GB of payload text.
Of those, 738,559 streaming message events contain 245 MB of payload text;
none predate the October 1 cutoff in that snapshot. Activity events account for
814.6 MB across 325,938 records. Final message events contain another 9.6 MB.
The current seven-day policy therefore cannot immediately remove that recent
streaming history. These counts exclude the live WAL.

A focused test also found a Node runtime reclamation bug: the driver's `.run()`
steps the no-column incremental-vacuum PRAGMA once, freeing one page rather
than the requested 2,048. Maintenance previously assumed the requested progress
and exited early (520 free pages became 519 in the fixture). Maintenance now
measures actual free-page progress, yields between bounded groups, and stops
when the driver makes no progress. This fixes reclamation without changing the
persistence worker's SQLite driver or write path.

Existing worktree recovery snapshots use the OS user home (`config.homeDir`),
producing a shared `~/worktree-snapshots` directory. Automatic expiry now requires
a readable manifest whose canonical `sourceWorktree` belongs strictly inside
the current channel's worktree root. Foreign sources, escaping aliases, linked
snapshot roots, and unidentified staging directories are retained. Snapshot
creation and explicit cleanup keep their existing paths; no old recovery data
is moved or discarded to change the layout.

## Verification

131 focused retention/recovery/worktree/logging tests pass. Formatting, lint,
workspace type checking, migration lineage, and the Windows runtime boundary
checks pass. Lint reports 894 existing warnings. Actual Node and Bun vacuum
probes reclaim all free pages; Codex's isolated plain/gzip read probe is
described above. The local toolchain used Node 24.13.1 and Bun 1.3.14 (the
repository pins Bun 1.4.2).

Broader tests report 16,562 passing cases across the workspace. Two Git
integration cases fail: `GitCore`'s slow-push test times out, and `GitManager`'s
observer-disconnected push test reports that its hook did not start. Those
Git/process files are unchanged and belong to area 5. The default build-pipeline
test exceeded its five-second timeout; all 290 scripts tests pass with a
30-second test timeout. No live 15-thread provider load or native Windows run
was performed, and profile history database integrity was not established from
the immutable main-file inspection.

## Optional one-time operator cleanup

These commands were **not run**. Stop Synara before removing snapshots/logs,
verify that no migration recovery marker exists, and retain the migration
snapshot. Substitute the Beta home only when intentionally maintaining Beta;
do not run a combined glob across homes.

Inspect current sizes and recovery files:

```sh
du -sh "$HOME/.synara/userdata/state.sqlite.backups" "$HOME/.synara/codex-home-overlays" "$HOME/.synara/userdata/secrets/codex-profiles" "$HOME/.codex/sessions"
ls -l "$HOME/.synara/userdata/state.sqlite.migration-backup.json" "$HOME/.synara/userdata/state.sqlite.backups"
sqlite3 -readonly "$HOME/.synara/userdata/state.sqlite.backups/state.sqlite.pre-migration-v145-to-v146-20261007T213014848Z-0004c834-ec50-4539-89c0-7d356bbf9eb8.sqlite" 'PRAGMA quick_check;'
```

If the successful migration snapshot is verified and the manual pre-cleanup
snapshot is no longer wanted, this explicit interactive removal can recover
6.288 GB. It preserves the migration snapshot and refuses a present marker or
linked backup directory:

```sh
test ! -e "$HOME/.synara/userdata/state.sqlite.migration-recovery.json" &&
test ! -L "$HOME/.synara/userdata/state.sqlite.migration-recovery.json" &&
test ! -L "$HOME/.synara/userdata/state.sqlite.backups" &&
rm -i "$HOME/.synara/userdata/state.sqlite.backups/manual-pre-cleanup-20261007.sqlite"
```

After stopping Synara, discard the 73 MB legacy server log if its diagnostic
history is no longer wanted. The new logger recreates it on startup:

```sh
rm -i "$HOME/.synara/userdata/logs/server.log"
```

There is no safe blanket `rm`, gzip, or SQLite vacuum command for the historical
overlay rollouts, generated images, profile history databases, active worktrees,
or `~/.codex`. For legacy rollouts, identify the exact native thread/home and
decide that its resume history and image references can be discarded before
removing individual files. Missing Synara bindings alone do not prove this.
