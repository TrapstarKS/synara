import {
  PROVIDER_DISPLAY_NAMES,
  type CodexProfile,
  type CodexProfileId,
  type ProviderKind,
} from "@synara/contracts";
import { HandoffIcon, LoaderCircleIcon, MessageCircleIcon } from "~/lib/icons";
import { ProviderIcon } from "../ProviderIcon";
import { Menu, MenuItem, MenuSub, MenuSubTrigger, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import { ChatHeaderButton } from "./chatHeaderControls";

export type ProviderHandoffMode = "continue" | "new-thread";

export function ChatHandoffMenu({
  compact,
  handoffActionLabel,
  handoffPending,
  handoffDisabled,
  handoffActionTargetProviders,
  handoffActionTargetCodexProfiles,
  continuousHandoffEnabled,
  onCreateHandoff,
}: {
  compact: boolean;
  handoffActionLabel: string;
  handoffPending: boolean;
  handoffDisabled: boolean;
  handoffActionTargetProviders: ReadonlyArray<ProviderKind>;
  handoffActionTargetCodexProfiles: ReadonlyArray<CodexProfile>;
  continuousHandoffEnabled: boolean;
  onCreateHandoff: (
    provider: ProviderKind,
    mode: ProviderHandoffMode,
    codexProfileId?: CodexProfileId,
  ) => void;
}) {
  const renderHandoffTargetItems = (mode: ProviderHandoffMode) => [
    ...handoffActionTargetProviders.map((provider) => (
      <MenuItem key={provider} onClick={() => onCreateHandoff(provider, mode)}>
        {/* opacity-100 opts brand icons out of the option row's 80% icon dim. */}
        <ProviderIcon provider={provider} className="size-3.5 shrink-0 opacity-100" />
        <span>{PROVIDER_DISPLAY_NAMES[provider]}</span>
      </MenuItem>
    )),
    ...(handoffActionTargetCodexProfiles.length > 0
      ? [
          <MenuSub key="codex-profiles">
            <MenuSubTrigger>
              <ProviderIcon provider="codex" className="size-3.5 shrink-0 opacity-100" />
              <span>Codex profile</span>
            </MenuSubTrigger>
            <ComposerPickerMenuSubPopup className="w-56 min-w-56">
              {handoffActionTargetCodexProfiles.map((profile) => (
                <MenuItem
                  key={profile.id}
                  onClick={() => onCreateHandoff("codex", mode, profile.id)}
                >
                  <ProviderIcon provider="codex" className="size-3.5 shrink-0 opacity-100" />
                  <span className="truncate">{profile.name}</span>
                </MenuItem>
              ))}
            </ComposerPickerMenuSubPopup>
          </MenuSub>,
        ]
      : []),
  ];

  return (
    <Menu modal={false}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ChatHeaderButton
                  type="button"
                  tone="outline"
                  className={compact ? "gap-1" : "gap-1.5"}
                  aria-label={handoffActionLabel}
                  disabled={
                    handoffDisabled ||
                    (handoffActionTargetProviders.length === 0 &&
                      handoffActionTargetCodexProfiles.length === 0)
                  }
                />
              }
            >
              {handoffPending ? (
                <LoaderCircleIcon className="size-[1em] shrink-0 animate-spin opacity-80" />
              ) : (
                <HandoffIcon className="size-[1em] shrink-0 opacity-80" />
              )}
              {!compact ? (
                <span className="truncate font-normal">
                  {handoffPending ? "Switching…" : "Hand off"}
                </span>
              ) : null}
            </MenuTrigger>
          }
        />
        <TooltipPopup side="bottom">{handoffActionLabel}</TooltipPopup>
      </Tooltip>
      <ComposerPickerMenuPopup align="end" side="bottom" className="w-52 min-w-52">
        {continuousHandoffEnabled ? (
          <>
            <MenuSub>
              <MenuSubTrigger>
                <MessageCircleIcon className="size-3.5 shrink-0" />
                <span>Continue here</span>
              </MenuSubTrigger>
              <ComposerPickerMenuSubPopup className="w-48 min-w-48">
                {renderHandoffTargetItems("continue")}
              </ComposerPickerMenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>
                <HandoffIcon className="size-3.5 shrink-0" />
                <span>New conversation</span>
              </MenuSubTrigger>
              <ComposerPickerMenuSubPopup className="w-48 min-w-48">
                {renderHandoffTargetItems("new-thread")}
              </ComposerPickerMenuSubPopup>
            </MenuSub>
          </>
        ) : (
          renderHandoffTargetItems("new-thread")
        )}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
