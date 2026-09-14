// FILE: login.ts
// Purpose: Starts ChatGPT sign-in in the user's default browser and waits for
//          the local extension bridge to expose its existing browser session.
// Layer: Server provider connector

import type { ThreadId } from "@synara/contracts";

import { ChatGptDriverFailure, ChatGptWebDriver } from "../chatgptWeb/driver.ts";
import type { ChatGptBrowserRpc } from "../chatgptWeb/types.ts";
import type { ChatGptExternalBrowserShape } from "./Services/ChatGptExternalBrowser.ts";

/** How long the login request waits for the user to finish signing in. */
export const CHATGPT_LOGIN_WAIT_MS = 3 * 60_000;
/** How long the default-browser extension has to connect after pairing. */
export const CHATGPT_EXTERNAL_BROWSER_CONNECT_WAIT_MS = 15_000;

export interface ChatGptLoginOutcome {
  readonly status: "signed-in" | "sign-in-required" | "unavailable" | "error";
  readonly message: string;
  readonly url?: string;
}

/**
 * Opens the ChatGPT tab for `threadId` and waits for a signed-in composer.
 * Never throws: every failure is reported as a status the UI can act on.
 */
export async function openChatGptLogin(input: {
  readonly externalBrowser: ChatGptExternalBrowserShape;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly threadId: ThreadId;
  readonly waitMs?: number;
  readonly connectWaitMs?: number;
}): Promise<ChatGptLoginOutcome> {
  if (!input.externalBrowser.available) {
    return {
      status: "unavailable",
      message:
        "The default-browser bridge is only available when Synara runs locally. Open Synara on this Mac and try again.",
    };
  }

  const pairing = input.externalBrowser.createPairing(input.threadId);
  try {
    // The first page gives the extension a one-time local pairing token. The
    // second page is the real ChatGPT tab, which stays in the user's browser
    // profile and therefore keeps its existing Google/ChatGPT session.
    await input.openBrowser(pairing.pairingUrl);
    await input.openBrowser(pairing.chatgptUrl);
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const connected = await input.externalBrowser.waitForClient(
    input.threadId,
    input.connectWaitMs ?? CHATGPT_EXTERNAL_BROWSER_CONNECT_WAIT_MS,
  );
  if (!connected) {
    return {
      status: "unavailable",
      message:
        "Synara opened your default browser, but the extension did not connect. Load extensions/chatgpt-browser in Chrome, Brave, or Arc, then click Sign in to ChatGPT again.",
      url: pairing.chatgptUrl,
    };
  }

  const rpc: ChatGptBrowserRpc = {
    call: ({ name, args, timeoutMs }) =>
      input.externalBrowser.execute({
        threadId: input.threadId,
        name,
        args,
        timeoutMs: Math.max(100, Math.min(30_000, timeoutMs ?? 20_000)),
      }),
  };

  const driver = new ChatGptWebDriver({
    rpc,
    loginWaitMs: input.waitMs ?? CHATGPT_LOGIN_WAIT_MS,
  });

  try {
    const conversation = await driver.ensureConversation();
    return {
      status: "signed-in",
      message: "ChatGPT is ready in your default browser. Synara did not import its cookies.",
      ...(conversation.url ? { url: conversation.url } : {}),
    };
  } catch (error) {
    if (error instanceof ChatGptDriverFailure) {
      if (error.code === "login-required") {
        return { status: "sign-in-required", message: error.message };
      }
      if (error.code === "browser-unavailable") {
        return { status: "unavailable", message: error.message };
      }
      return { status: "error", message: error.message };
    }
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
