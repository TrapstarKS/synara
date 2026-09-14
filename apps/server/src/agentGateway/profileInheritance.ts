import type { ModelSelection } from "@synara/contracts";

/**
 * Preserve a Codex profile when a child target leaves it unspecified. An
 * explicit child profile always wins, and non-Codex targets never inherit a
 * Codex-only setting.
 */
export function inheritCodexProfile(input: {
  readonly target: ModelSelection;
  readonly parentModelSelection?: ModelSelection;
}): ModelSelection {
  if (input.target.provider !== "codex") {
    return input.target;
  }
  if (input.target.profileId !== undefined) return input.target;

  const parentModelSelection = input.parentModelSelection;
  if (parentModelSelection?.provider !== "codex") return input.target;
  if (parentModelSelection.profileId === undefined) return input.target;

  return {
    ...input.target,
    profileId: parentModelSelection.profileId,
  };
}
