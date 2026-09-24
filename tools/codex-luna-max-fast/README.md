# Codex Luna Max Fast

This Codex build sends spawned `gpt-5.6-luna` and `gpt-6-luna` agents at every reasoning effort
through Fast routing. Root tasks and every other model keep their selected routing tier.

GPT-6 Luna keeps Fast routing even when an older bundled model catalog does not list its priority
service tier yet.

Apple Silicon Synara desktop releases include a pinned copy of this runtime. Synara verifies and
installs it automatically when Codex still uses its default command; an explicitly configured
custom binary is left alone. The installed launcher checks the fixed prerelease feed in the
background at most once every six hours and keeps the last working build if an update fails.

The six-hour interval starts after a successful check or install. Failed downloads
and checksum failures leave that timestamp unchanged, so a later launch can retry.
Concurrent updaters use a process-owned file lock; an abandoned directory from the
older updater no longer blocks progress. Network operations have bounded connection
and transfer timeouts. A newer installed stable version is preserved when the
published feed temporarily contains an older version, including with `--force`.

The updater never compiles locally; Cargo builds happen only on the ephemeral CI runner. Each
run also deletes the `source/`, `target/` and `bin/__pycache__` leftovers of the retired
local-build updater, which could reach 20 GB.

Updates apply to new Codex processes. Existing conversations keep their running
provider process until it exits normally; the updater does not restart active work.

The standalone installer remains available for source builds, web-server installs, and older
Synara desktop releases:

```sh
curl -fsSL https://raw.githubusercontent.com/TrapstarKS/synara/codex/mobile-remote/tools/codex-luna-max-fast/install.sh | zsh
```

If Synara is running, the standalone installer leaves its settings untouched and prints the custom
binary path to paste into **Settings → Agent providers → Codex**.

The published binary is rebuilt from the matching `openai/codex` `rust-v*` tag using
[`luna-max-fast.patch`](./luna-max-fast.patch). It includes the matching official
`codex-code-mode-host`, `rg`, and zsh runtime from OpenAI's npm package.

The publishing workflow checks upstream every six hours and rebuilds when either
the upstream version or the patch/packaging source fingerprint changes. Before
locked Cargo tests and compilation, `cargo update --workspace` reconciles release
tags whose workspace version was bumped without updating their source-less lockfile
entries. External dependency versions remain pinned by `Cargo.lock`.
The behavior tests use Cargo's ordinary test profile with debug information disabled;
the distributed executable is still compiled with `--release --locked`.

The manifest in `packages/shared/src/managedCodexRuntime.ts` pins the bootstrap
archive embedded in desktop releases. It is not the latest-version selector; a
usable newer installed runtime is retained. Update that manifest only alongside
a verified, published archive and its checksum.

Before replacing the automatic-update feed, the publishing workflow verifies and
retains its previous archive under a filename containing its SHA-256. The new
archive receives the same content-addressed copy. Desktop builds try the pinned
copy first, with a checksum-verified fallback to the original URL while older
feeds migrate. Advancing the update feed therefore does not invalidate a desktop
build's bootstrap digest.

Run the portable installer smoke test with:

```sh
tools/codex-luna-max-fast/test.sh
```

The smoke test uses a local file feed and covers installation, simultaneous updates,
an abandoned legacy lock, missing/corrupt archives, retry timestamps, and prevention
of stable-version downgrades. It also checks immutable bundle retention and rejects
corrupt copies. It does not call a model or publish a release.
