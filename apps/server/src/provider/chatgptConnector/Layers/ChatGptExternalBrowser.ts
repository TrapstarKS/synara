// Purpose: Implements the loopback WebSocket bridge used by the ChatGPT web
//          provider to drive the user's default browser without importing its
//          cookies or session tokens.
// Layer: Server provider connector

import { randomBytes, randomUUID } from "node:crypto";

import type { ThreadId } from "@synara/contracts";
import { Effect, FileSystem, Layer, Path } from "effect";

import { AgentGatewayCredentials } from "../../../agentGateway/Services/AgentGatewayCredentials.ts";
import { ServerConfig } from "../../../config.ts";
import { isLoopbackHost } from "../../../startupAccess.ts";
import type { ChatGptBrowserToolName } from "../../chatgptWeb/types.ts";
import {
  CHATGPT_EXTERNAL_BROWSER_PAIR_PATH,
  ChatGptExternalBrowser,
  CHATGPT_EXTERNAL_BROWSER_WS_PATH,
  type ChatGptExternalBrowserAttachInput,
  type ChatGptExternalBrowserExecuteInput,
  type ChatGptExternalBrowserPairing,
  type ChatGptExternalBrowserShape,
} from "../Services/ChatGptExternalBrowser.ts";

const CHATGPT_URL = "https://chatgpt.com/";
const DEFAULT_PAIRING_TTL_MS = 15 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_BRIDGE_MESSAGE_BYTES = 2 * 1024 * 1024;

interface PairingState {
  readonly token: string;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly expiresAtMs: number;
  /** True after the one-time token completed its first authenticated attach. */
  claimed: boolean;
  clientId: string | null;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ClientState {
  readonly clientId: string;
  readonly token: string;
  readonly pairedThreadId: ThreadId;
  readonly threadKeys: Set<string>;
  readonly send: (payload: string) => Promise<void>;
  readonly pending: Map<number, PendingRequest>;
}

interface ChatGptBrowserRequest {
  readonly type: "request";
  readonly id: number;
  readonly name: ChatGptBrowserToolName;
  readonly args: Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const threadKeyFor = (threadId: ThreadId): string => String(threadId);

const normalizeOrigin = (origin: string): string => origin.replace(/\/$/u, "");

const errorFor = (value: unknown, fallback: string): Error =>
  value instanceof Error && value.message.trim().length > 0 ? value : new Error(fallback);

function pairingPage(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Synara browser pairing</title></head>
  <body style="font:16px system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1.5rem;line-height:1.5">
    <h1>Synara browser bridge</h1>
    <p id="status">Connecting the Synara extension…</p>
    <p>You can close this tab after the extension reports that it is connected.</p>
  </body>
</html>`;
}

export function makeChatGptExternalBrowser(input: {
  readonly available: boolean;
  readonly origin: string | (() => string);
  readonly now?: () => number;
  readonly randomToken?: () => string;
  readonly randomClientId?: () => string;
  readonly pairingTtlMs?: number;
  readonly requestTimeoutMs?: number;
}): ChatGptExternalBrowserShape {
  const now = input.now ?? Date.now;
  const randomToken = input.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const randomClientId = input.randomClientId ?? randomUUID;
  const pairingTtlMs = Math.max(1_000, input.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS);
  const requestTimeoutMs = Math.max(100, input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const originForPairing = () =>
    normalizeOrigin(typeof input.origin === "function" ? input.origin() : input.origin);
  const pairings = new Map<string, PairingState>();
  const pairingsByThread = new Map<string, PairingState>();
  const clients = new Map<string, ClientState>();
  const clientsByThread = new Map<string, ClientState>();
  const waitersByThread = new Map<string, Set<(connected: boolean) => void>>();
  let nextRequestId = 1;

  const resolvePairing = (token: string): PairingState | null => {
    const pairing = pairings.get(token);
    if (!pairing) return null;
    // TTL protects the first claim. Once the extension proves possession, the
    // same in-memory token may reconnect after a transient socket loss for the
    // lifetime of this server process. A restart still forgets every token.
    if (pairing.claimed || pairing.expiresAtMs > now()) return pairing;
    pairings.delete(pairing.token);
    if (pairingsByThread.get(pairing.threadKey) === pairing) {
      pairingsByThread.delete(pairing.threadKey);
    }
    return null;
  };

  const rejectPending = (client: ClientState, error: Error): void => {
    for (const pending of client.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    client.pending.clear();
  };

  const removeClient = (client: ClientState, reason: string): void => {
    if (clients.get(client.clientId) !== client) return;
    clients.delete(client.clientId);
    for (const threadKey of client.threadKeys) {
      if (clientsByThread.get(threadKey) === client) {
        clientsByThread.delete(threadKey);
      }
    }
    client.threadKeys.clear();
    const pairing = pairings.get(client.token);
    if (pairing?.clientId === client.clientId) pairing.clientId = null;
    rejectPending(client, new Error(reason));
  };

  const detachClient = (clientId: string): void => {
    const client = clients.get(clientId);
    if (client) removeClient(client, "The browser extension disconnected.");
  };

  const notifyConnected = (threadKey: string): void => {
    const waiters = waitersByThread.get(threadKey);
    if (!waiters) return;
    waitersByThread.delete(threadKey);
    for (const resolve of waiters) resolve(true);
  };

  const createPairing = (threadId: ThreadId): ChatGptExternalBrowserPairing => {
    const threadKey = threadKeyFor(threadId);
    const previous = pairingsByThread.get(threadKey);
    if (previous) {
      pairings.delete(previous.token);
      if (previous.clientId !== null) detachClient(previous.clientId);
    }

    const token = randomToken();
    const expiresAtMs = now() + pairingTtlMs;
    const pairing: PairingState = {
      token,
      threadId,
      threadKey,
      expiresAtMs,
      claimed: false,
      clientId: null,
    };
    pairings.set(token, pairing);
    pairingsByThread.set(threadKey, pairing);
    return {
      pairingUrl: `${originForPairing()}${CHATGPT_EXTERNAL_BROWSER_PAIR_PATH}?token=${encodeURIComponent(token)}`,
      chatgptUrl: CHATGPT_URL,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  };

  const hasPairing = (token: string): boolean => resolvePairing(token) !== null;

  const renderPairingPage = (token: string): string | null =>
    resolvePairing(token) ? pairingPage() : null;

  const attachClient = (
    attach: ChatGptExternalBrowserAttachInput,
  ): { readonly clientId: string; readonly threadId: ThreadId } | null => {
    const pairing = resolvePairing(attach.token);
    if (!pairing) return null;

    const previous = clientsByThread.get(pairing.threadKey);
    if (previous) removeClient(previous, "The browser bridge was replaced by a new pairing.");

    const client: ClientState = {
      clientId: randomClientId(),
      token: pairing.token,
      pairedThreadId: pairing.threadId,
      threadKeys: new Set([pairing.threadKey]),
      send: attach.send,
      pending: new Map(),
    };
    clients.set(client.clientId, client);
    clientsByThread.set(pairing.threadKey, client);
    pairing.claimed = true;
    pairing.clientId = client.clientId;
    notifyConnected(pairing.threadKey);
    void client
      .send(
        JSON.stringify({
          type: "connected",
          protocol: 1,
          threadId: String(client.pairedThreadId),
        }),
      )
      .catch(() => detachClient(client.clientId));
    return { clientId: client.clientId, threadId: client.pairedThreadId };
  };

  /**
   * The extension keeps one local WebSocket alive while the user switches
   * Synara conversations. Pairing starts from whichever conversation was
   * visible in Settings, so later provider sessions can legitimately arrive
   * with different thread ids. One extension socket multiplexes requests by
   * request id and each browser action still names its own tab; sharing that
   * single unambiguous client also lets multiple ChatGPT threads run at once.
   * Multiple connected extensions remain fail-closed because there is no
   * trustworthy way to elect one for an unseen thread.
   */
  const clientForThread = (threadId: ThreadId): ClientState | null => {
    const threadKey = threadKeyFor(threadId);
    const exact = clientsByThread.get(threadKey);
    // Pairing expiry limits how long an untrusted page can first claim the
    // one-time token. Once the extension has attached, the live WebSocket is
    // the capability: expiring that already-authenticated client here used to
    // disconnect healthy browser sessions after 15 minutes, often in the
    // middle of a long turn.
    if (exact && clients.get(exact.clientId) === exact) return exact;
    if (exact) clientsByThread.delete(threadKey);

    const candidates = [...clients.values()];
    if (candidates.length !== 1) return null;
    const candidate = candidates[0];
    if (!candidate) return null;

    candidate.threadKeys.add(threadKey);
    clientsByThread.set(threadKey, candidate);
    return candidate;
  };

  const execute = (request: ChatGptExternalBrowserExecuteInput): Promise<unknown> => {
    if (!input.available) {
      return Promise.reject(
        new Error("The external browser bridge is only available on a local Synara server."),
      );
    }
    const client = clientForThread(request.threadId);
    if (!client) {
      return Promise.reject(
        new Error(
          "The external browser bridge is not connected to this Synara session. Load extensions/chatgpt-browser in Chrome, Brave, or Arc, then click Sign in to ChatGPT again.",
        ),
      );
    }

    const id = nextRequestId++;
    const requestedTimeout = Number.isFinite(request.timeoutMs)
      ? request.timeoutMs
      : requestTimeoutMs;
    const timeoutMs = Math.max(100, Math.min(requestedTimeout, 120_000));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.pending.delete(id);
        reject(new Error(`The external browser action timed out: ${request.name}.`));
      }, timeoutMs);
      client.pending.set(id, { resolve, reject, timer });
      const message: ChatGptBrowserRequest = {
        type: "request",
        id,
        name: request.name,
        args: request.args,
      };
      void client.send(JSON.stringify(message)).catch((error) => {
        if (!client.pending.has(id)) return;
        clearTimeout(timer);
        client.pending.delete(id);
        reject(errorFor(error, "The browser extension could not receive the action."));
        detachClient(client.clientId);
      });
    });
  };

  const handleClientMessage = (clientId: string, message: string | Uint8Array): void => {
    const client = clients.get(clientId);
    if (!client) return;
    const byteLength =
      typeof message === "string" ? Buffer.byteLength(message, "utf8") : message.byteLength;
    if (byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
      detachClient(clientId);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof message === "string" ? message : Buffer.from(message).toString("utf8"),
      );
    } catch {
      return;
    }
    const response = asRecord(parsed);
    if (response?.type !== "response") return;
    const id = response.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
    const pending = client.pending.get(id);
    if (!pending) return;
    client.pending.delete(id);
    clearTimeout(pending.timer);
    if (response.ok === true) {
      pending.resolve(response.result);
    } else {
      const detail = typeof response.error === "string" ? response.error : "Browser action failed.";
      pending.reject(new Error(detail));
    }
  };

  const waitForClient = (threadId: ThreadId, timeoutMs: number): Promise<boolean> => {
    const threadKey = threadKeyFor(threadId);
    if (clientForThread(threadId)) return Promise.resolve(true);
    const boundedTimeout = Math.max(0, timeoutMs);
    if (boundedTimeout === 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiters = waitersByThread.get(threadKey) ?? new Set<(connected: boolean) => void>();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (connected: boolean) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) waitersByThread.delete(threadKey);
        resolve(connected);
      };
      waiters.add(finish);
      waitersByThread.set(threadKey, waiters);
      timer = setTimeout(() => finish(false), boundedTimeout);
    });
  };

  return {
    available: input.available,
    createPairing,
    hasPairing,
    renderPairingPage,
    attachClient,
    handleClientMessage,
    detachClient,
    waitForClient,
    execute,
  } satisfies ChatGptExternalBrowserShape;
}

export const ChatGptExternalBrowserLive = Layer.effect(
  ChatGptExternalBrowser,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const credentials = yield* AgentGatewayCredentials;
    return makeChatGptExternalBrowser({
      available: isLoopbackHost(config.host) && config.publicUrl === undefined,
      origin: () => new URL(credentials.mcpEndpointUrl).origin,
    });
  }),
);

export type ChatGptExternalBrowserLayer = Layer.Layer<
  ChatGptExternalBrowser,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig
>;
