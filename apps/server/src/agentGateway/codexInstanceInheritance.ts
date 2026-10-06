import type { ModelSelection } from "@synara/contracts";

/**
 * Keep a child Codex thread on its parent's account when the child target only
 * names the default instance. An explicit non-default child instance always
 * wins, and non-Codex targets never inherit a Codex account.
 */
export function inheritCodexInstance(input: {
  readonly target: ModelSelection;
  readonly parentModelSelection?: ModelSelection;
}): ModelSelection {
  const parent = input.parentModelSelection;
  if (input.target.provider !== "codex" || parent?.provider !== "codex") return input.target;
  if ((input.target.instanceId ?? "codex") !== "codex") return input.target;
  if ((parent.instanceId ?? "codex") === "codex") return input.target;
  return { ...input.target, instanceId: parent.instanceId };
}
