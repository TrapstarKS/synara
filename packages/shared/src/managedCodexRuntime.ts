// FILE: managedCodexRuntime.ts
// Purpose: Defines the pinned Luna Max Fast runtime shipped by Apple Silicon desktop releases.

export const SYNARA_MANAGED_CODEX_BIN_DIR_ENV = "SYNARA_MANAGED_CODEX_BIN_DIR";

export interface ManagedCodexRuntimeManifest {
  readonly version: string;
  readonly assetFileName: string;
  readonly sha256: string;
  readonly supersededSha256s?: readonly string[];
  readonly downloadUrl: string;
}

export const MANAGED_CODEX_RUNTIME_MANIFEST: ManagedCodexRuntimeManifest = {
  version: "0.154.0",
  assetFileName: "codex-luna-max-fast-aarch64-apple-darwin.tar.gz",
  sha256: "2ba4aec433d9b6ce9f6f3402e93e427d1e73145dfb846c081f7ed27531d05d00",
  supersededSha256s: [
    "7e3242e277170b750cac2f451f190892d33e1e3c5cf517b7cc2150d69f17175f",
    "a9651d715a221aea2c5577648b11b48d020f0e9aa76e1d580d89db31db08774f",
  ],
  downloadUrl:
    "https://github.com/TrapstarKS/synara/releases/download/codex-luna-max-fast-latest/codex-luna-max-fast-aarch64-apple-darwin.tar.gz",
};
