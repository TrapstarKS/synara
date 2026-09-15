// Purpose: Contract for the local bridge between the ChatGPT web provider and
//          an already-authenticated browser extension.
// Layer: Server provider connector

import type { ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";

import type { ChatGptBrowserToolName } from "../../chatgptWeb/types.ts";

export const CHATGPT_EXTERNAL_BROWSER_PAIR_PATH = "/provider/chatgpt/browser/pair";
export const CHATGPT_EXTERNAL_BROWSER_WS_PATH = "/provider/chatgpt/browser";
/** Loopback-only diagnostic route used by the debug companion extension. */
export const CHATGPT_EXTERNAL_BROWSER_DEBUG_PATH = "/provider/chatgpt/browser/debug";

export interface ChatGptExternalBrowserPairing {
  /** Local-only URL that the extension content script uses to pair. */
  readonly pairingUrl: string;
  /** URL opened in the user's default browser after the pairing page. */
  readonly chatgptUrl: string;
  readonly expiresAt: string;
}

export interface ChatGptExternalBrowserExecuteInput {
  readonly threadId: ThreadId;
  readonly name: ChatGptBrowserToolName;
  readonly args: Record<string, unknown>;
  readonly timeoutMs: number;
}

export interface ChatGptExternalBrowserAttachInput {
  readonly token: string;
  readonly send: (payload: string) => Promise<void>;
}

export interface ChatGptExternalBrowserShape {
  /** False when Synara is not bound to a local-only endpoint. */
  readonly available: boolean;
  readonly createPairing: (threadId: ThreadId) => ChatGptExternalBrowserPairing;
  readonly hasPairing: (token: string) => boolean;
  /** Returns a static pairing page, or null for an expired/unknown token. */
  readonly renderPairingPage: (token: string) => string | null;
  /** Attaches exactly one extension connection to a thread's pairing. */
  readonly attachClient: (
    input: ChatGptExternalBrowserAttachInput,
  ) => { readonly clientId: string; readonly threadId: ThreadId } | null;
  readonly handleClientMessage: (clientId: string, message: string | Uint8Array) => void;
  readonly detachClient: (clientId: string) => void;
  readonly waitForClient: (threadId: ThreadId, timeoutMs: number) => Promise<boolean>;
  /** Sends one scoped browser action to the extension. */
  readonly execute: (input: ChatGptExternalBrowserExecuteInput) => Promise<unknown>;
}

export class ChatGptExternalBrowser extends ServiceMap.Service<
  ChatGptExternalBrowser,
  ChatGptExternalBrowserShape
>()("synara/provider/chatgptConnector/Services/ChatGptExternalBrowser") {}
