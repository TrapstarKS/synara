import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import {
  resolveActiveCodexHomeWritePath,
  resolveBaseCodexHomePath,
  resolveCodexHomeAllowlistCandidates,
  resolveSynaraCodexHomeOverlayPath,
} from "./codexHomePaths.ts";
import { CodexProfileId } from "@synara/contracts";

describe("Codex home paths", () => {
  it("resolves the source home using explicit, environment, then default precedence", () => {
    assert.equal(
      resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }, "/explicit/codex"),
      "/explicit/codex",
    );
    assert.equal(resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }), "/env/codex");
    assert.ok(resolveBaseCodexHomePath({}).endsWith(`${path.sep}.codex`));
  });

  it("anchors the overlay under SYNARA_HOME", () => {
    assert.equal(
      resolveSynaraCodexHomeOverlayPath({ SYNARA_HOME: "/synara/runtime" }, "/users/me/.codex"),
      path.join("/synara/runtime", "codex-home-overlay"),
    );
  });

  it("derives a default overlay beside the source home", () => {
    assert.equal(
      resolveSynaraCodexHomeOverlayPath({}, "/users/me/.codex"),
      path.join("/users/me", ".synara", "runtime", "codex-home-overlay"),
    );
  });

  it("isolates managed profile overlays by profile id", () => {
    const profileId = CodexProfileId.makeUnsafe("0a5e2de9-c0f9-40e6-acf6-580ac0072fc0");
    assert.equal(
      resolveSynaraCodexHomeOverlayPath(
        { SYNARA_HOME: "/synara/runtime" },
        "/private/profile",
        profileId,
      ),
      path.join("/synara/runtime", "codex-home-overlays", profileId),
    );
  });

  it("uses the isolated overlay as Codex's write home", () => {
    assert.equal(
      resolveActiveCodexHomeWritePath({
        env: { SYNARA_HOME: "/synara/runtime" },
        homePath: "/users/me/.codex",
      }),
      path.join("/synara/runtime", "codex-home-overlay"),
    );
  });

  it("allowlists source and overlay homes when distinct", () => {
    assert.deepEqual(
      resolveCodexHomeAllowlistCandidates({
        env: { SYNARA_HOME: "/synara/runtime" },
        homePath: "/users/me/.codex",
      }),
      ["/users/me/.codex", path.join("/synara/runtime", "codex-home-overlay")],
    );
  });
});
