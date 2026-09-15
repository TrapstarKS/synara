import type {
  ProviderAddMcpServerInput,
  ProviderKind,
  ProviderMcpRuntimeStatus,
  ProviderMcpServerStatus,
  ThreadId,
} from "@synara/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  DevicePowerIcon,
  McpIcon,
  PlayOutlineIcon,
  PlusIcon,
  RefreshCwIcon,
} from "../../lib/icons";
import { readNativeApi } from "../../nativeApi";
import { cn } from "../../lib/utils";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

type McpBadgeVariant =
  | "default"
  | "destructive"
  | "error"
  | "info"
  | "outline"
  | "secondary"
  | "success"
  | "warning";
type McpTransport = ProviderAddMcpServerInput["transport"];

type McpFormState = {
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  bearerTokenEnvVar: string;
};

const EMPTY_FORM: McpFormState = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  cwd: "",
  url: "",
  bearerTokenEnvVar: "",
};

function runtimeStatusLabel(status: ProviderMcpRuntimeStatus | null): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "starting":
      return "Starting";
    case "authenticationRequired":
      return "Authentication required";
    case "failed":
      return "Failed";
    case "disabled":
      return "Disabled";
    case "cancelled":
      return "Cancelled";
    case "notStarted":
      return "Not started";
    default:
      return "Unknown";
  }
}

function runtimeStatusVariant(status: ProviderMcpRuntimeStatus | null): McpBadgeVariant {
  switch (status) {
    case "connected":
      return "success";
    case "starting":
      return "info";
    case "failed":
      return "error";
    case "authenticationRequired":
      return "warning";
    default:
      return "outline";
  }
}

function parseEnvironment(value: string): Record<string, string> | undefined {
  const entries = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (entries.length === 0) return undefined;

  const environment: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const key = separator === -1 ? entry : entry.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid environment key "${key}".`);
    }
    environment[key] = separator === -1 ? "" : entry.slice(separator + 1);
  }
  return environment;
}

function parseArguments(value: string): string[] | undefined {
  const args = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return args.length > 0 ? args : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDisabled(status: ProviderMcpServerStatus): boolean {
  return status.runtimeStatus === "disabled";
}

export function McpServersDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderKind;
  threadId: ThreadId;
}) {
  const { open, onOpenChange, provider, threadId } = props;
  const [servers, setServers] = useState<ReadonlyArray<ProviderMcpServerStatus>>([]);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState<McpFormState>(EMPTY_FORM);

  const loadServers = useCallback(async () => {
    const api = readNativeApi();
    if (!api?.provider?.listMcpServers) {
      setError("MCP management is unavailable in this client.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.provider.listMcpServers({ provider, threadId });
      setServers(result.servers);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [provider, threadId]);

  useEffect(() => {
    if (open) void loadServers();
  }, [loadServers, open]);

  const runAction = useCallback(
    async (action: "reload" | "connect" | "disconnect" | "restart", name?: string) => {
      const api = readNativeApi();
      if (!api?.provider) {
        setError("MCP management is unavailable in this client.");
        return;
      }
      const actionKey = name ? `${action}:${name}` : action;
      setBusyAction(actionKey);
      setError(null);
      try {
        const result =
          action === "reload"
            ? await api.provider.reloadMcpServers({ provider, threadId })
            : action === "restart"
              ? await api.provider.restartMcpServer({ provider, threadId, name: name! })
              : action === "connect"
                ? await api.provider.connectMcpServer({ provider, threadId, name: name! })
                : await api.provider.disconnectMcpServer({ provider, threadId, name: name! });
        setServers(result.servers);
      } catch (actionError) {
        setError(errorMessage(actionError));
      } finally {
        setBusyAction(null);
      }
    },
    [provider, threadId],
  );

  const handleAdd = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const api = readNativeApi();
      if (!api?.provider) {
        setError("MCP management is unavailable in this client.");
        return;
      }
      const name = form.name.trim();
      if (!name) {
        setError("Enter an MCP server name.");
        return;
      }
      const command = form.command.trim();
      const url = form.url.trim();
      if (form.transport === "stdio" && !command) {
        setError("Enter the command used to start the stdio server.");
        return;
      }
      if (form.transport === "streamable-http" && !url) {
        setError("Enter the MCP server URL.");
        return;
      }

      let env: Record<string, string> | undefined;
      try {
        env = parseEnvironment(form.env);
      } catch (parseError) {
        setError(errorMessage(parseError));
        return;
      }
      const args = parseArguments(form.args);
      const input: ProviderAddMcpServerInput = {
        provider,
        threadId,
        name,
        transport: form.transport,
        ...(command ? { command } : {}),
        ...(args ? { args } : {}),
        ...(env ? { env } : {}),
        ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
        ...(url ? { url } : {}),
        ...(form.bearerTokenEnvVar.trim()
          ? { bearerTokenEnvVar: form.bearerTokenEnvVar.trim() }
          : {}),
      };

      setBusyAction("add");
      setError(null);
      try {
        const result = await api.provider.addMcpServer(input);
        setServers(result.servers);
        setForm(EMPTY_FORM);
        setShowAddForm(false);
      } catch (addError) {
        setError(errorMessage(addError));
      } finally {
        setBusyAction(null);
      }
    },
    [form, provider, threadId],
  );

  const updateForm = useCallback(
    <Key extends keyof McpFormState>(key: Key, value: McpFormState[Key]) => {
      setForm((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <McpIcon className="size-4" />
            MCP servers
          </DialogTitle>
          <DialogDescription>
            See what this Codex session has loaded, enable or disable individual servers, or restart
            one to renegotiate its tools without restarting the whole session.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="flex flex-col gap-4">
          {error ? (
            <Alert variant="error" size="sm">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">Active servers</p>
              <p className="text-xs text-muted-foreground">
                {servers.length === 1 ? "1 server" : `${servers.length} servers`} reported by Codex.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loading || busyAction !== null}
              onClick={() => void runAction("reload")}
            >
              <RefreshCwIcon
                className={cn("size-3.5", (loading || busyAction === "reload") && "animate-spin")}
              />
              Reload all
            </Button>
          </div>

          {loading && servers.length === 0 ? (
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-5 text-center text-sm text-muted-foreground">
              Reading MCP status…
            </div>
          ) : servers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 px-3 py-5 text-center text-sm text-muted-foreground">
              No MCP servers were reported for this session.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {servers.map((server) => {
                const builtIn = server.name === "synara";
                const serverDisabled = isDisabled(server);
                const action = serverDisabled ? "connect" : "disconnect";
                const actionKey = `${action}:${server.name}`;
                const restartActionKey = `restart:${server.name}`;
                return (
                  <div
                    key={server.name}
                    className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {server.name}
                        </span>
                        <Badge variant={runtimeStatusVariant(server.runtimeStatus)} size="sm">
                          {runtimeStatusLabel(server.runtimeStatus)}
                        </Badge>
                        {builtIn ? (
                          <span className="text-[11px] text-muted-foreground">Built-in</span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {server.toolNames.length} {server.toolNames.length === 1 ? "tool" : "tools"}
                        {server.resourceCount > 0
                          ? ` · ${server.resourceCount} resource${server.resourceCount === 1 ? "" : "s"}`
                          : ""}
                        {server.authStatus !== "unknown" ? ` · auth: ${server.authStatus}` : ""}
                      </p>
                      {server.toolsError ? (
                        <p className="mt-1 break-words text-xs text-destructive">
                          {server.toolsError}
                        </p>
                      ) : null}
                    </div>
                    {builtIn ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        Managed by Synara
                      </span>
                    ) : (
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busyAction !== null || !serverDisabled}
                          onClick={() => void runAction("connect", server.name)}
                        >
                          {busyAction === actionKey && action === "connect" ? (
                            <RefreshCwIcon className="size-3.5 animate-spin" />
                          ) : (
                            <PlayOutlineIcon className="size-3.5" />
                          )}
                          Enable
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busyAction !== null || serverDisabled}
                          onClick={() => void runAction("disconnect", server.name)}
                        >
                          {busyAction === actionKey && action === "disconnect" ? (
                            <RefreshCwIcon className="size-3.5 animate-spin" />
                          ) : (
                            <DevicePowerIcon className="size-3.5" />
                          )}
                          Disable
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          disabled={busyAction !== null}
                          title="Disable and enable this MCP server to refresh its tools"
                          onClick={() => void runAction("restart", server.name)}
                        >
                          {busyAction === restartActionKey ? (
                            <RefreshCwIcon className="size-3.5 animate-spin" />
                          ) : (
                            <RefreshCwIcon className="size-3.5" />
                          )}
                          Restart
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/15 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Add MCP server</p>
                <p className="text-xs text-muted-foreground">
                  Configuration is written to Codex and queued for the next turn.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={showAddForm ? "secondary" : "outline"}
                disabled={busyAction !== null}
                onClick={() => {
                  setShowAddForm((current) => !current);
                  setError(null);
                }}
              >
                <PlusIcon className="size-3.5" />
                {showAddForm ? "Hide" : "Add"}
              </Button>
            </div>

            {showAddForm ? (
              <form className="flex flex-col gap-3" onSubmit={handleAdd}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                    Name
                    <Input
                      value={form.name}
                      onChange={(event) => updateForm("name", event.target.value)}
                      placeholder="roblox"
                      autoComplete="off"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                    Transport
                    <Select
                      value={form.transport}
                      onValueChange={(value) => {
                        if (value === "stdio" || value === "streamable-http") {
                          updateForm("transport", value);
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue>
                          {form.transport === "stdio" ? "Local command (stdio)" : "Remote URL"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup surface="settings">
                        <SelectItem value="stdio">Local command (stdio)</SelectItem>
                        <SelectItem value="streamable-http">Remote URL</SelectItem>
                      </SelectPopup>
                    </Select>
                  </label>
                </div>

                {form.transport === "stdio" ? (
                  <>
                    <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                      Command
                      <Input
                        value={form.command}
                        onChange={(event) => updateForm("command", event.target.value)}
                        placeholder="node"
                        autoComplete="off"
                      />
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                        Arguments (one per line)
                        <Textarea
                          value={form.args}
                          onChange={(event) => updateForm("args", event.target.value)}
                          placeholder={"server.js\n--workspace\n/path"}
                          size="sm"
                        />
                      </label>
                      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                        Environment (KEY=VALUE per line)
                        <Textarea
                          value={form.env}
                          onChange={(event) => updateForm("env", event.target.value)}
                          placeholder={"ROBLOX_TOKEN=…\nMCP_MODE=local"}
                          size="sm"
                        />
                      </label>
                    </div>
                    <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                      Working directory (optional)
                      <Input
                        value={form.cwd}
                        onChange={(event) => updateForm("cwd", event.target.value)}
                        placeholder="/path/to/project"
                        autoComplete="off"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                      MCP URL
                      <Input
                        type="url"
                        value={form.url}
                        onChange={(event) => updateForm("url", event.target.value)}
                        placeholder="https://example.com/mcp"
                        autoComplete="url"
                      />
                    </label>
                    <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                      Bearer token environment variable (optional)
                      <Input
                        value={form.bearerTokenEnvVar}
                        onChange={(event) => updateForm("bearerTokenEnvVar", event.target.value)}
                        placeholder="MCP_TOKEN"
                        autoComplete="off"
                      />
                    </label>
                  </>
                )}

                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={busyAction !== null}>
                    {busyAction === "add" ? (
                      <RefreshCwIcon className="size-3.5 animate-spin" />
                    ) : null}
                    Save and reload
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter variant="bare">
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
