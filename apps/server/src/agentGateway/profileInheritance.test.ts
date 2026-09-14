import { CodexProfileId, type ModelSelection } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { inheritCodexProfile } from "./profileInheritance.ts";

const parentProfile = CodexProfileId.makeUnsafe("4ae646ed-62ad-4e45-965a-d11cd459a853");

describe("inheritCodexProfile", () => {
  it("inherits the parent Codex profile when the child omits one", () => {
    const target = { provider: "codex", model: "gpt-5.5" } satisfies ModelSelection;
    const parent = { ...target, profileId: parentProfile } satisfies ModelSelection;

    expect(inheritCodexProfile({ target, parentModelSelection: parent })).toEqual({
      ...target,
      profileId: parentProfile,
    });
  });

  it("keeps an explicit child profile", () => {
    const childProfile = CodexProfileId.makeUnsafe("679c91a5-a4f8-4f19-b2ca-2744bc779d89");
    const target = {
      provider: "codex",
      model: "gpt-5.5",
      profileId: childProfile,
    } satisfies ModelSelection;
    const parent = {
      provider: "codex",
      model: "gpt-5.5",
      profileId: parentProfile,
    } satisfies ModelSelection;

    expect(inheritCodexProfile({ target, parentModelSelection: parent })).toBe(target);
  });

  it("does not copy a Codex profile to another provider", () => {
    const target = { provider: "claudeAgent", model: "sonnet" } satisfies ModelSelection;
    const parent = {
      provider: "codex",
      model: "gpt-5.5",
      profileId: parentProfile,
    } satisfies ModelSelection;

    expect(inheritCodexProfile({ target, parentModelSelection: parent })).toBe(target);
  });
});
