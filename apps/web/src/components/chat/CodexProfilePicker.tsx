import type { CodexProfile, CodexProfileId } from "@synara/contracts";

import { CheckIcon, ChevronDownIcon, UsersIcon } from "~/lib/icons";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";

export function CodexProfilePicker(props: {
  profiles: ReadonlyArray<CodexProfile>;
  profileId: CodexProfileId | undefined;
  disabled?: boolean;
  onChange: (profileId: CodexProfileId | undefined) => void;
}) {
  if (props.profiles.length === 0 && !props.profileId) return null;
  const selected = props.profiles.find((profile) => profile.id === props.profileId);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="chrome"
            disabled={props.disabled}
            className="min-w-0 max-w-32 shrink-0 gap-1.5 px-2"
            aria-label="Choose Codex account"
            title={
              props.disabled ? "The Codex account is fixed after the first message" : undefined
            }
          />
        }
      >
        <UsersIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {selected?.name ?? (props.profileId ? "Account unavailable" : "Current account")}
        </span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" aria-hidden="true" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" side="top" fixedWidth>
        <MenuItem onClick={() => props.onChange(undefined)}>
          <span className="min-w-0 flex-1 truncate">Current account</span>
          {!props.profileId ? <CheckIcon className="size-3.5" /> : null}
        </MenuItem>
        {props.profiles.map((profile) => (
          <MenuItem key={profile.id} onClick={() => props.onChange(profile.id)}>
            <span className="min-w-0 flex-1 truncate">{profile.name}</span>
            {profile.id === props.profileId ? <CheckIcon className="size-3.5" /> : null}
          </MenuItem>
        ))}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
