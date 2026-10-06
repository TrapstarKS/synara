import type { ModelSelection } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { inheritCodexInstance } from "./codexInstanceInheritance.ts";

const parent = {
  provider: "codex",
  instanceId: "codex_work",
  model: "gpt-5.5",
} satisfies ModelSelection;

describe("inheritCodexInstance", () => {
  it("inherits the parent Codex account when the child names the default instance", () => {
    for (const target of [
      { provider: "codex", model: "gpt-5.5" },
      { provider: "codex", instanceId: "codex", model: "gpt-5.5" },
    ] satisfies ModelSelection[]) {
      expect(inheritCodexInstance({ target, parentModelSelection: parent })).toEqual({
        ...target,
        instanceId: "codex_work",
      });
    }
  });

  it("keeps an explicit child account and never crosses providers", () => {
    const explicit = {
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5.5",
    } satisfies ModelSelection;
    const claude = { provider: "claudeAgent", model: "sonnet" } satisfies ModelSelection;
    expect(inheritCodexInstance({ target: explicit, parentModelSelection: parent })).toBe(explicit);
    expect(inheritCodexInstance({ target: claude, parentModelSelection: parent })).toBe(claude);
  });
});
