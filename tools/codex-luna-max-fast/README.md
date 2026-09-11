# Codex Luna Max Fast

This optional Codex build sends spawned `gpt-5.6-luna` agents at `max` reasoning effort through
Fast routing. Root tasks and every other model/effort combination keep their selected routing tier.

It is distributed separately from Synara so desktop releases stay small. The installer downloads
the current Apple Silicon bundle, verifies its SHA-256 checksum, installs it under `~/.synara`, and
configures an existing stopped Synara installation to use the launcher.

```sh
curl -fsSL https://raw.githubusercontent.com/TrapstarKS/synara/codex/mobile-remote/tools/codex-luna-max-fast/install.sh | zsh
```

If Synara is running, the installer leaves its settings untouched and prints the custom binary path
to paste into **Settings → Agent providers → Codex**. The launcher checks the fixed prerelease feed
in the background at most once every six hours and keeps the last working build if an update fails.

The published binary is rebuilt from the matching `openai/codex` `rust-v*` tag using
[`luna-max-fast.patch`](./luna-max-fast.patch). It includes the matching official
`codex-code-mode-host`, `rg`, and zsh runtime from OpenAI's npm package.

Run the portable installer smoke test with:

```sh
tools/codex-luna-max-fast/test.sh
```
