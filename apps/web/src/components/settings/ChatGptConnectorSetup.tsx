// FILE: ChatGptConnectorSetup.tsx
// Purpose: Guided setup for the ChatGPT (Web) tool connector: tunnel state,
//          the connector URL with copy, rotation, and the exact steps to add
//          the connector in ChatGPT.
// Layer: Settings panel

import type { ChatGptConnectorState, ChatGptTunnelMode } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useState } from "react";

import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { ExternalLinkIcon, Loader2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { SETTINGS_INSET_RADIUS_CLASS_NAME } from "~/settingsPanelStyles";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export const CHATGPT_CONNECTOR_QUERY_KEY = ["provider", "chatgpt", "connector"] as const;
export const CHATGPT_CONNECTOR_SETTINGS_URL = "https://chatgpt.com/#settings/Connectors";

const TUNNEL_MODE_LABELS: Record<ChatGptTunnelMode, string> = {
  off: "Off",
  manual: "Manual tunnel",
  cloudflared: "Cloudflare quick tunnel",
  openai: "OpenAI Secure MCP Tunnel",
};

function StatusDot(props: { readonly tone: "ok" | "warn" | "error" | "idle" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        props.tone === "ok" && "bg-emerald-500",
        props.tone === "warn" && "bg-amber-500",
        props.tone === "error" && "bg-destructive",
        props.tone === "idle" && "bg-muted-foreground/50",
      )}
    />
  );
}

function Step(props: {
  readonly index: number;
  readonly title: string;
  readonly tone: "ok" | "warn" | "error" | "idle";
  readonly children: ReactNode;
}) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-medium text-muted-foreground">
        {props.index}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <StatusDot tone={props.tone} />
          <span className="text-xs font-medium text-foreground">{props.title}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{props.children}</div>
      </div>
    </li>
  );
}

function tunnelTone(state: ChatGptConnectorState["tunnelState"]): "ok" | "warn" | "error" | "idle" {
  if (state === "connected") return "ok";
  if (state === "error") return "error";
  if (state === "starting" || state === "manual") return "warn";
  return "idle";
}

const MAX_WORKERS_MIN = 1;
const MAX_WORKERS_MAX = 8;

/** Commits the worker count on blur so partial typing never clamps mid-edit. */
function WorkerCountInput(props: {
  readonly value: number;
  readonly onValueChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => {
    setDraft(String(props.value));
  }, [props.value]);
  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(props.value));
      return;
    }
    const next = Math.min(MAX_WORKERS_MAX, Math.max(MAX_WORKERS_MIN, parsed));
    setDraft(String(next));
    if (next !== props.value) props.onValueChange(next);
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      min={MAX_WORKERS_MIN}
      max={MAX_WORKERS_MAX}
      aria-label="Simultaneous worker chats"
      className="h-6 w-12 rounded-md border border-border bg-muted/40 px-1 text-center text-[11px] text-foreground"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

export function ChatGptConnectorSetup(props: {
  readonly tunnelMode: ChatGptTunnelMode;
  readonly maxWorkers: number;
  readonly onEnableCloudflaredTunnel: () => void;
  readonly onMaxWorkersChange: (value: number) => void;
}) {
  const queryClient = useQueryClient();
  const connectorId = useId();
  const connectorQuery = useQuery({
    queryKey: [...CHATGPT_CONNECTOR_QUERY_KEY, props.tunnelMode],
    queryFn: () => ensureNativeApi().provider.chatGptConnector(),
    refetchInterval: 4_000,
    staleTime: 1_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: CHATGPT_CONNECTOR_QUERY_KEY });

  const restartTunnel = useMutation({
    mutationFn: () => ensureNativeApi().provider.restartChatGptTunnel(),
    onSuccess: (state: ChatGptConnectorState) => {
      queryClient.setQueryData([...CHATGPT_CONNECTOR_QUERY_KEY, props.tunnelMode], state);
      toastManager.add({
        type: "success",
        title: "ChatGPT tunnel restarted",
        description:
          state.tunnelMessage ?? "The connector is applying the current tunnel mode from settings.",
      });
    },
    onError: () => {
      toastManager.add({ type: "error", title: "Could not restart the ChatGPT tunnel" });
    },
  });

  const rotateSecret = useMutation({
    mutationFn: () => ensureNativeApi().provider.rotateChatGptSecret(),
    onSuccess: () => {
      void refresh();
      toastManager.add({
        type: "success",
        title: "Connector secret rotated",
        description: "Update the connector URL in ChatGPT; the previous URL no longer works.",
      });
    },
    onError: () => {
      toastManager.add({ type: "error", title: "Could not rotate the connector secret" });
    },
  });

  const copyConnectorUrl = async () => {
    const url = connectorQuery.data?.connectorUrl;
    if (!url) return;
    try {
      await copyTextToClipboard(url);
      toastManager.add({
        type: "success",
        title: "Connector URL copied",
        description: "Paste it while creating the ChatGPT app.",
      });
    } catch {
      toastManager.add({ type: "error", title: "Could not copy the connector URL" });
    }
  };

  const state = connectorQuery.data;
  const tunnelOk = state?.tunnelState === "connected";
  const busy = restartTunnel.isPending || rotateSecret.isPending;
  const toolCalls = state?.toolCallCount ?? 0;

  return (
    <div
      className={cn(
        "border border-border/70 bg-background/60 px-3 py-3",
        SETTINGS_INSET_RADIUS_CLASS_NAME,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
          <StatusDot tone={state ? tunnelTone(state.tunnelState) : "idle"} />
          Tool connector
          <span className="truncate font-normal text-muted-foreground">
            {TUNNEL_MODE_LABELS[props.tunnelMode]}
            {state?.tunnelState === "connected" ? " · connected" : ""}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy || props.tunnelMode === "off"}
            onClick={() => restartTunnel.mutate()}
            title="Re-apply the tunnel mode from the settings above"
          >
            {restartTunnel.isPending ? <Loader2Icon className="size-3 animate-spin" /> : null}
            Restart tunnel
          </Button>
        </div>
      </div>

      <ol className="mt-3 space-y-3">
        <Step
          index={1}
          title="Connect a tunnel"
          tone={props.tunnelMode === "off" ? "idle" : tunnelTone(state?.tunnelState ?? "starting")}
        >
          {props.tunnelMode === "off" ? (
            <div className="space-y-2">
              <p>
                ChatGPT reaches local tools over MCP, so the connector needs a tunnel. Choose a mode
                above, or start the Cloudflare quick tunnel now if <code>cloudflared</code> is
                installed.
              </p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={props.onEnableCloudflaredTunnel}
              >
                Start Cloudflare quick tunnel
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <p>
                {state?.tunnelMessage ??
                  (tunnelOk
                    ? "The tunnel is connected."
                    : "The tunnel starts automatically and keeps running in the background.")}
              </p>
              {!tunnelOk && props.tunnelMode !== "manual" ? (
                <p>
                  If it stays red, check the tunnel binary path and that the binary is installed.
                </p>
              ) : null}
            </div>
          )}
        </Step>

        <Step
          index={2}
          title="Copy the connector URL"
          tone={tunnelOk || props.tunnelMode === "manual" ? (tunnelOk ? "ok" : "warn") : "idle"}
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor={connectorId} className="sr-only">
                Connector URL
              </label>
              <input
                id={connectorId}
                readOnly
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-2 font-mono text-[11px] text-foreground"
                value={state?.connectorUrl ?? "Connecting…"}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!state?.connectorUrl}
                onClick={() => void copyConnectorUrl()}
              >
                Copy
              </Button>
            </div>
            {props.tunnelMode === "manual" ? (
              <p>
                This URL is local to your machine. Expose it with your own tunnel and use the public
                URL, secret path included.
              </p>
            ) : null}
            {props.tunnelMode === "openai" ? (
              <p>
                The OpenAI tunnel forwards this loopback URL; use the tunnel app in ChatGPT (type
                Tunnel) rather than the URL itself.
              </p>
            ) : null}
          </div>
        </Step>

        <Step index={3} title="Add it in ChatGPT" tone="idle">
          <div className="space-y-2">
            <p>
              In ChatGPT: Settings → Apps → Developer mode → Create app, paste the connector URL and
              enable it. Tool lists refresh per conversation.
            </p>
            <a
              href={CHATGPT_CONNECTOR_SETTINGS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline"
            >
              Open ChatGPT connector settings
              <ExternalLinkIcon className="size-3" />
            </a>
          </div>
        </Step>

        <Step index={4} title="Sign in and send your first task" tone="idle">
          <p>
            Sign in to chatgpt.com inside the Synara browser (the tab opens automatically with your
            first task in this provider), then send a message. Tool calls ChatGPT makes are
            attributed to that thread.
          </p>
        </Step>
      </ol>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-2">
          <span>
            {toolCalls === 1 ? "1 tool call served" : `${toolCalls} tool calls served`}
            {state?.lastToolCallAt
              ? ` · last ${new Date(state.lastToolCallAt).toLocaleTimeString()}`
              : ""}
          </span>
        </span>
        <span className="flex items-center gap-3">
          <label
            className="flex items-center gap-1.5"
            title="Simultaneous worker chats the agents tool may keep active"
          >
            Workers
            <WorkerCountInput value={props.maxWorkers} onValueChange={props.onMaxWorkersChange} />
          </label>
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            disabled={rotateSecret.isPending}
            title="Generates a new secret path; update the connector URL in ChatGPT afterwards"
            onClick={() => rotateSecret.mutate()}
          >
            Rotate secret
          </button>
        </span>
      </div>
    </div>
  );
}
