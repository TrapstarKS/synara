# Codex Luna Max Fast

This Codex build sends spawned `gpt-5.6-luna` agents at every reasoning effort through Fast
routing. Root tasks and every other model keep their selected routing tier.

Apple Silicon Synara desktop releases include a pinned copy of this runtime. Synara verifies and
installs it automatically when Codex still uses its default command; an explicitly configured
custom binary is left alone. The installed launcher checks the fixed prerelease feed in the
background at most once every six hours and keeps the last working build if an update fails.

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

Run the portable installer smoke test with:

```sh
tools/codex-luna-max-fast/test.sh
```
