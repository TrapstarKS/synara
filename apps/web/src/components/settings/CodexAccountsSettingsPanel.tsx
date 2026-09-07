import {
  CodexProfileId,
  type CodexAccountLoginTarget,
  type CodexProfile,
  type ServerCodexAccountState,
  type ServerListCodexAccountStatesResult,
  type ServerSettingsView,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { CopyIcon, ExternalLinkIcon, Loader2Icon, PlayIcon, StarIcon, StopIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { SettingsCard, SettingsSectionShell } from "./SettingsPanelPrimitives";
import { DebouncedSettingTextInput } from "./DebouncedSettingTextInput";

const authLabel = (status: ServerCodexAccountState["codexAuth"]): string => {
  switch (status) {
    case "signed-in":
      return "Signed in";
    case "signing-in":
      return "Waiting for sign-in";
    case "error":
      return "Sign-in failed";
    default:
      return "Not signed in";
  }
};

function CodexAccountCard(props: {
  profile: CodexProfile;
  isDefault: boolean;
  proxyBinaryPath: string;
  state: ServerCodexAccountState | undefined;
  statePending: boolean;
  busy: boolean;
  onStateChange: (state: ServerCodexAccountState) => void;
  onRename: (name: string) => void;
  onDefault: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const state = props.state;
  const run = async (action: () => Promise<ServerCodexAccountState>) => {
    setActionBusy(true);
    setActionError(null);
    try {
      const next = await action();
      props.onStateChange(next);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(false);
    }
  };
  const startLogin = (target: CodexAccountLoginTarget) =>
    run(() =>
      ensureNativeApi().server.startCodexAccountLogin({ profileId: props.profile.id, target }),
    );
  const logout = (target: CodexAccountLoginTarget) =>
    run(() => ensureNativeApi().server.logoutCodexAccount({ profileId: props.profile.id, target }));
  const pendingLogin = state?.loginTarget;
  const disabled = props.busy || actionBusy;

  return (
    <SettingsCard divided={false}>
      <div className="space-y-4 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <DebouncedSettingTextInput
            value={props.profile.name}
            onCommit={props.onRename}
            maxLength={64}
            aria-label={`Rename Codex account ${props.profile.name}`}
            className="max-w-64"
          />
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant={props.isDefault ? "secondary" : "outline"}
              disabled={disabled || props.isDefault}
              onClick={props.onDefault}
              aria-label={
                props.isDefault
                  ? `${props.profile.name} is the new chat default`
                  : `Use ${props.profile.name} for new chats`
              }
            >
              <StarIcon className={cn("size-3.5", props.isDefault && "fill-current")} />
              {props.isDefault ? "New chat default" : "Use for new chats"}
            </Button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-medium text-foreground">Synara / Codex</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {props.statePending ? "Checking…" : authLabel(state?.codexAuth ?? "signed-out")}
                </div>
              </div>
              {state?.codexAuth === "signed-in" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled || pendingLogin !== undefined}
                  onClick={() => void logout("codex")}
                  aria-label={`Sign out ${props.profile.name} from Codex`}
                >
                  Sign out
                </Button>
              ) : (
                <Button
                  size="xs"
                  disabled={disabled || pendingLogin !== undefined}
                  onClick={() => void startLogin("codex")}
                  aria-label={`Sign in ${props.profile.name} to Codex`}
                >
                  Sign in
                </Button>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-medium text-foreground">Claude Code bridge</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {props.statePending
                    ? "Checking…"
                    : !state?.proxyInstalled
                      ? `Proxy not found (${props.proxyBinaryPath})`
                      : authLabel(state.claudeCodeAuth)}
                </div>
              </div>
              {state?.claudeCodeAuth === "signed-in" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled || pendingLogin !== undefined}
                  onClick={() => void logout("claude-code")}
                  aria-label={`Sign out ${props.profile.name} from the Claude Code bridge`}
                >
                  Sign out
                </Button>
              ) : (
                <Button
                  size="xs"
                  disabled={disabled || !state?.proxyInstalled || pendingLogin !== undefined}
                  onClick={() => void startLogin("claude-code")}
                  aria-label={`Sign in ${props.profile.name} to the Claude Code bridge`}
                >
                  Sign in
                </Button>
              )}
            </div>
            {state?.claudeCodeAuth === "signed-in" ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled || pendingLogin !== undefined}
                  aria-label={`${state.bridgeStatus === "running" ? "Stop" : "Start"} the Claude Code bridge for ${props.profile.name}`}
                  onClick={() =>
                    void run(() =>
                      ensureNativeApi().server.setCodexAccountBridge({
                        profileId: props.profile.id,
                        action: state.bridgeStatus === "running" ? "stop" : "start",
                      }),
                    )
                  }
                >
                  {state.bridgeStatus === "running" ? (
                    <StopIcon className="size-3.5" />
                  ) : actionBusy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <PlayIcon className="size-3.5" />
                  )}
                  {state.bridgeStatus === "running" ? "Stop bridge" : "Start bridge"}
                </Button>
                {state.launchCommand ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void copyTextToClipboard(state.launchCommand ?? "")}
                    aria-label={`Copy the Claude command for ${props.profile.name}`}
                  >
                    <CopyIcon className="size-3.5" /> Copy Claude command
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {pendingLogin && state?.userCode && state.verificationUrl ? (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 p-3 text-xs">
            <div className="font-medium text-foreground">Enter code {state.userCode}</div>
            <div className="mt-1 text-muted-foreground">
              Open {state.verificationUrl} and finish signing in to this account.
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                size="xs"
                onClick={() => window.open(state.verificationUrl, "_blank", "noopener,noreferrer")}
                aria-label={`Open ${pendingLogin === "codex" ? "Codex" : "Claude Code bridge"} sign-in for ${props.profile.name}`}
              >
                Open sign-in
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                aria-label={`Cancel sign-in for ${props.profile.name}`}
                onClick={() =>
                  void run(() =>
                    ensureNativeApi().server.cancelCodexAccountLogin({
                      profileId: props.profile.id,
                    }),
                  )
                }
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {actionError || state?.detail ? (
          <p className="text-xs text-destructive">{actionError ?? state?.detail}</p>
        ) : null}
      </div>
    </SettingsCard>
  );
}

export function CodexAccountsSettingsPanel({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codex = settingsQuery.data?.providers.codex;
  const profiles = codex?.profiles ?? [];
  const accountStatesQuery = useQuery({
    queryKey: serverQueryKeys.codexAccounts(),
    queryFn: () => ensureNativeApi().server.listCodexAccountStates(),
    enabled: active && profiles.length > 0,
    staleTime: 1_000,
    refetchInterval: (query) => {
      const states = query.state.data;
      return states?.some(
        (state) => state.codexAuth === "signing-in" || state.claudeCodeAuth === "signing-in",
      )
        ? 1_500
        : states?.some((state) => state.bridgeStatus === "running")
          ? 5_000
          : false;
    },
    retry: false,
  });
  const updateAccountState = (next: ServerCodexAccountState) => {
    queryClient.setQueryData<ServerListCodexAccountStatesResult>(
      serverQueryKeys.codexAccounts(),
      (current) => {
        if (!current) return [next];
        const index = current.findIndex((state) => state.profileId === next.profileId);
        return index < 0
          ? [...current, next]
          : current.map((state) => (state.profileId === next.profileId ? next : state));
      },
    );
  };

  const updateProfiles = async (
    profiles: ReadonlyArray<CodexProfile>,
    defaultProfileId: CodexProfileId | null,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const next = await ensureNativeApi().server.updateSettings({
        providers: { codex: { profiles, defaultProfileId } },
      });
      queryClient.setQueryData<ServerSettingsView>(serverQueryKeys.settings(), next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: serverQueryKeys.allProviderUsage() }),
        queryClient.invalidateQueries({ queryKey: serverQueryKeys.codexAccounts() }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!active) return null;
  return (
    <div className="mt-8 space-y-6">
      <SettingsSectionShell title="Codex accounts">
        <SettingsCard divided={false}>
          <div className="space-y-3 p-4">
            <div className="text-xs leading-relaxed text-muted-foreground">
              Each account has isolated Codex credentials. Choose an account before the first
              message; Synara keeps that account attached to the thread afterward.
            </div>
            <div className="text-xs leading-relaxed text-muted-foreground">
              The Claude Code bridge uses a separate login for safe token refresh. It runs the
              open-source MIT-licensed proxy on this computer and only listens on localhost.
            </div>
            <div className="flex gap-2">
              <Input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                maxLength={64}
                placeholder="Account name"
                aria-label="New Codex account name"
              />
              <Button
                size="sm"
                disabled={busy || !newName.trim() || profiles.length >= 20}
                onClick={() => {
                  const name = newName.trim();
                  if (!name) return;
                  const profile = {
                    id: CodexProfileId.makeUnsafe(globalThis.crypto.randomUUID()),
                    name,
                  } satisfies CodexProfile;
                  setNewName("");
                  void updateProfiles(
                    [...profiles, profile],
                    codex?.defaultProfileId ?? profile.id,
                  );
                }}
              >
                Add account
              </Button>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                Claude Code proxy binary
              </div>
              <DebouncedSettingTextInput
                value={codex?.proxyBinaryPath ?? "claude-code-proxy"}
                onCommit={(proxyBinaryPath) => {
                  const normalized = proxyBinaryPath.trim() || "claude-code-proxy";
                  void ensureNativeApi()
                    .server.updateSettings({
                      providers: { codex: { proxyBinaryPath: normalized } },
                    })
                    .then(async (next) => {
                      queryClient.setQueryData(serverQueryKeys.settings(), next);
                      await queryClient.invalidateQueries({
                        queryKey: serverQueryKeys.codexAccounts(),
                      });
                    })
                    .catch((cause: unknown) =>
                      setError(cause instanceof Error ? cause.message : String(cause)),
                    );
                }}
                aria-label="Claude Code proxy binary"
              />
              <Button
                className="mt-2"
                size="xs"
                variant="outline"
                render={
                  <a
                    href="https://github.com/raine/claude-code-proxy#quick-start-with-codex"
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                Install guide
                <ExternalLinkIcon className="size-3" />
              </Button>
            </div>
          </div>
        </SettingsCard>

        {profiles.map((profile) => (
          <CodexAccountCard
            key={profile.id}
            profile={profile}
            isDefault={codex?.defaultProfileId === profile.id}
            proxyBinaryPath={codex?.proxyBinaryPath ?? "claude-code-proxy"}
            state={accountStatesQuery.data?.find((state) => state.profileId === profile.id)}
            statePending={accountStatesQuery.isPending}
            busy={busy}
            onStateChange={updateAccountState}
            onRename={(name) => {
              const trimmed = name.trim();
              if (!trimmed || trimmed === profile.name) return;
              void updateProfiles(
                profiles.map((candidate) =>
                  candidate.id === profile.id ? { ...candidate, name: trimmed } : candidate,
                ),
                codex?.defaultProfileId ?? null,
              );
            }}
            onDefault={() => void updateProfiles(profiles, profile.id)}
          />
        ))}

        {profiles.length === 0 ? (
          <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
            Add an account to enable per-thread account selection and per-account usage.
          </p>
        ) : null}
        {error || accountStatesQuery.error ? (
          <p className="px-2 text-xs text-destructive">
            {error ??
              (accountStatesQuery.error instanceof Error
                ? accountStatesQuery.error.message
                : String(accountStatesQuery.error))}
          </p>
        ) : null}
      </SettingsSectionShell>
    </div>
  );
}
