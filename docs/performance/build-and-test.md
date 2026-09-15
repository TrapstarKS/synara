# Build and test iteration

Use focused tests while editing:

```sh
bun run test --filter=@synara/cli -- src/restoreMigrationBackup.test.ts
bun run test --filter=@synara/web -- src/lib/disclosureMotion.test.ts
bun run test:changed
bun run test:changed HEAD~1
```

`test:changed` uses Vitest's dependency graph to select tests affected by uncommitted
changes, or changes since the supplied Git reference. It is an iteration shortcut;
`bun run test` and the CI gate still run the complete suites. Unit tests import
workspace source, so they no longer trigger production builds. Process/integration
test results remain uncached so changes to the host runtime still get exercised.

React Compiler transforms and compiler coverage events have their own file-level
cache in `apps/web/node_modules/.cache/react-compiler`. Entries track source bytes,
module path, compiler configuration, installed compiler code, lockfile, Node,
platform, and build context. A changed module is recompiled; unchanged modules
retain their generated code and source maps. Coverage assertions still execute on
every test run. Thrown compiler failures are never cached; cached bailout events
still fail their coverage assertions. Invalid/unwritable cache entries fall back
to compilation. Development and watch transforms are unchanged.

To explicitly bypass compiler reuse:

```sh
SYNARA_COMPILER_CACHE=0 bun run test
SYNARA_COMPILER_CACHE=0 bun run build:desktop --force
```

`bun run build:desktop` continues to use Turbo's output cache. Runtime ports, homes,
and authentication settings pass through to tasks without invalidating compiled
bundles. Build-time URLs, source-map settings, the Windows signing publisher,
patches, and shared build inputs still invalidate the cache. Desktop's migration
source fingerprint remains an explicit build input.

CI runs the server suite in four shards, preserving serial execution inside each
shard and requiring all shards to pass. Windows regression jobs use the shared
dependency cache. Native caches are separated by operating system and architecture;
installed dependencies additionally track the root tool versions, lockfile, and
patches. Frozen installs still run after cache restoration.

The Codex release workflow caches Cargo dependencies and workspace artifacts under
the checkout's pinned Rust toolchain. It also uses [sccache](https://github.com/Mozilla-Actions/sccache-action)
to reuse identical library compilations despite fresh checkout timestamps. It still
executes both regression tests and builds the optimized `codex` binary. Explicit
`--lib`, `--test all`, and `--bin codex`
selectors avoid unrelated test targets and the unused CLI binary. Cargo validates
source freshness on every invocation. See [Cargo target selection](https://doc.rust-lang.org/cargo/commands/cargo-test.html)
and [rust-cache's fingerprint and restore policy](https://github.com/Swatinem/rust-cache).

## Measurements on this checkout

Local Node 24.13.1 / Bun 1.3.14, September 12, 2026:

| Check                                                               | Result                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| Production web build before changes                                 | 77.88 s total                                        |
| Production web rebuild with populated compiler cache, without Turbo | 6.75 s total; Vite 3.88 s                            |
| Focused server test through Turbo                                   | 2.80 s total; 3 tests passed, no prerequisite builds |
| Scripts suite through Turbo                                         | 1.75 s total; 97 tests passed                        |
| Full web unit suite before changes                                  | 88.56 s total; 4,317 passed, 3 skipped               |
| Full web unit suite with populated compiler cache                   | 31.63 s total; 4,320 passed, 3 skipped               |
| Both compiler coverage files with populated cache                   | 1.25 s total; Vitest 296 ms; 15 tests passed         |
| Brotli over the same 1,499 build assets, old levels 9/11            | 4,214 ms; 4,688,523 bytes                            |
| Brotli over those assets, level 5                                   | 127 ms; 5,106,420 bytes                              |

The repeated web build is about 11.5 times faster; the complete web test command
is about 2.8 times faster. These warm runs reuse compiler work, while rebuilding
the bundle or executing every test assertion. They are not Turbo output-cache
hits. New cache regression tests account for the three additional passing tests.

Brotli took about 33 times less time for roughly 9% more compressed bytes. Gzip
sidecars remain available. The warm build's 2,998 compressed sidecars were
decompressed and compared with their sources; all matched. Its 2,896 uncompressed
output files matched both the baseline and the final cold build byte-for-byte.

Reproduce the web timings without Turbo's output cache, using a temporary output
directory twice (the first run fills the compiler cache):

```sh
bun run --cwd apps/web build --outDir /tmp/synara-web-build-benchmark --emptyOutDir
bun run --cwd apps/web build --outDir /tmp/synara-web-build-benchmark --emptyOutDir
bun run --cwd apps/web test
```

These are measured stages, not a promise that a complete release takes milliseconds.
The final cold web build took 103.90 seconds on the shared machine; there was no
measured end-to-end cold-build speedup. First Rust compilation, native dependency installation,
installer generation, signing, and notarization can still take minutes. The new
Actions cache and shard timings require a subsequent hosted run to measure. No
release was dispatched or published, and the dormant desktop release workflow
remains disabled.

The complete web suite passed after an earlier cold run under concurrent build
load hit an existing five-second dynamic-import timeout. The timeout was not
raised. Cache regression tests cover source/config/context changes, persistent
source maps, damaged entries, compiler exceptions, bypass, and unavailable storage.
The changed workflows passed actionlint and YAML parsing. Repository-wide
`bun fmt`, `bun lint`, and `bun typecheck` were not run: this repository requires
an explicit user request for those commands.
