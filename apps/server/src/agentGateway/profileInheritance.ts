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
  if (
    input.target.provider !== "codex" ||
    input.target.profileId !== undefined ||
    input.parentModelSelection?.provider !== "codex" ||
    input.parentModelSelection.profileId === undefined
  ) {
    return input.target;
  }
  return {
    ...input.target,
    profileId: input.parentModelSelection.profileId,
  };
}
