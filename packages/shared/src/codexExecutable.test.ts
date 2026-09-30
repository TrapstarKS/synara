import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isRetiredCodexExecutable,
  resolveCodexExecutable,
  removeRetiredCodexEnvironment,
} from "./codexExecutable";
import { localPathsEqual } from "./path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "synara-codex-executable-"));
  roots.push(root);
  const bin = path.join(root, "official");
  const old = path.join(root, "retired");
  mkdirSync(bin);
  mkdirSync(old);
  const official = path.join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
  writeFileSync(official, "test fixture");
  chmodSync(official, 0o755);
  return { root, bin, old, official, env: { PATH: [old, bin].join(path.delimiter) } };
}

describe("Codex executable selection", () => {
  it("removes an inherited desktop PATH injection without changing unrelated entries", () => {
    const env = {
      PATH: "/retired/bin:/normal/bin:/retired/bin-other",
      SYNARA_MANAGED_CODEX_BIN_DIR: "/retired/bin",
      SYNARA_LUNA_HOME: "/retired",
    };
    expect(removeRetiredCodexEnvironment(env, "darwin")).toEqual({
      PATH: "/normal/bin:/retired/bin-other",
    });
    expect(env.PATH).toBe("/retired/bin:/normal/bin:/retired/bin-other");
    expect(removeRetiredCodexEnvironment({ PATH: "/retired/bin:/normal/bin" }, "darwin")).toEqual({
      PATH: "/retired/bin:/normal/bin",
    });
    expect(
      removeRetiredCodexEnvironment(
        {
          Path: '"C:\\Retired\\bin";C:\\Normal\\bin',
          SYNARA_MANAGED_CODEX_BIN_DIR: "c:/retired/bin/",
        },
        "win32",
      ),
    ).toEqual({ Path: "C:\\Normal\\bin" });
  });
  it.each([
    "codex-luna-max-fast",
    "/Users/me/.synara/bin/codex-luna-max-fast.real",
    String.raw`C:\Users\me\.synara\bin\codex-luna-max-fast.exe`,
  ])("replaces the retired executable %s with normal PATH lookup", (retired) => {
    const f = fixture();
    expect(isRetiredCodexExecutable(retired)).toBe(true);
    const resolved = resolveCodexExecutable(retired, { env: f.env });
    expect(resolved).not.toBeNull();
    // PATHEXT may produce .CMD while the fixture is named .cmd on Windows;
    // fs.realpath also retains that spelling on Windows.
    expect(localPathsEqual(resolved!, f.official)).toBe(true);
  });

  it("preserves an explicitly selected unrelated binary", () => {
    const f = fixture();
    expect(resolveCodexExecutable(f.official, { env: {} })).toBe(f.official);
    expect(resolveCodexExecutable("codex", { env: { PATH: "" } })).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "skips old default aliases, including dangling aliases, without deleting them",
    () => {
      const f = fixture();
      const retired = path.join(f.old, "codex-luna-max-fast");
      const alias = path.join(f.old, "codex");
      symlinkSync("codex-luna-max-fast", alias);
      expect(isRetiredCodexExecutable(alias)).toBe(true);
      expect(resolveCodexExecutable(alias, { env: f.env })).toBe(f.official);
      writeFileSync(retired, "test fixture");
      chmodSync(retired, 0o755);
      expect(resolveCodexExecutable("codex", { env: f.env })).toBe(f.official);
      expect(resolveCodexExecutable("codex", { env: { PATH: f.old } })).toBeNull();
      expect(resolveCodexExecutable("./retired/codex", { cwd: f.root, env: f.env })).toBe(
        f.official,
      );
    },
  );
});
