// FILE: threadModelSummary.ts
// Purpose: Summarize a thread's model selection (provider + model name + reasoning
//          effort) for read-only surfaces such as the sidebar hover card.
// Layer: Web presentation helpers
// Exports: ThreadModelSummary, resolveThreadModelSummary
// Why: Reuses the composer's trait resolution so a thread's model reads exactly
//      the same wherever it is displayed.

import type { ModelSelection, ProviderKind, ProviderModelDescriptor } from "@synara/contracts";

import { getModelSelectionStringOptionValue, trimOrNull } from "@synara/shared/model";

import {
  getComposerTraitSelection,
  resolveComposerTraitStatusLabel,
  showsComposerFastModeBadge,
} from "~/components/chat/composerTraits";
import { runtimeEffortLabel } from "~/components/chat/runtimeModelCapabilities";
import { formatProviderModelOptionName, type ProviderOptions } from "~/providerModelOptions";

export interface ThreadModelSummary {
  provider: ProviderKind;
  /** Display name of the selected model, e.g. "Sonnet 4.5". */
  modelLabel: string;
  /** Reasoning effort / thinking label, e.g. "High"; null when the model has none. */
  statusLabel: string | null;
  fastMode: boolean;
}

export function resolveThreadModelSummary(
  modelSelection: ModelSelection | null | undefined,
  runtimeModel?: ProviderModelDescriptor,
): ThreadModelSummary | null {
  if (!modelSelection) {
    return null;
  }
  // Deliberately the selection's provider, not `resolveThreadDisplayProvider`:
  // the glyph and the model name must describe the same selection, and a live
  // session can briefly report a different provider than the stored selection.
  const provider = modelSelection.provider;
  const modelLabel = formatProviderModelOptionName({ provider, slug: modelSelection.model });
  if (modelLabel.length === 0) {
    return null;
  }
  // The prompt only matters for prompt-injected efforts (Claude's ultrathink),
  // which a stored selection never carries, so an empty draft is correct here.
  const traits = getComposerTraitSelection(
    provider,
    modelSelection.model,
    "",
    modelSelection.options as ProviderOptions | undefined,
    runtimeModel,
  );
  const storedCodexEffort =
    provider === "codex"
      ? trimOrNull(getModelSelectionStringOptionValue(modelSelection, "reasoningEffort"))
      : null;
  return {
    provider,
    modelLabel,
    statusLabel:
      resolveComposerTraitStatusLabel(traits) ??
      (storedCodexEffort ? runtimeEffortLabel(storedCodexEffort) : null),
    fastMode: showsComposerFastModeBadge(traits),
  };
}
