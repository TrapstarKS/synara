// FILE: login.ts
// Purpose: Signs the ChatGPT web tab in on demand: opens (or reuses) the
//          chatgpt.com tab in a thread's Synara browser and waits for the
//          composer, so the user can log in from the connector panel instead
//          of discovering the sign-in page through a failed turn.
// Layer: Server provider connector

import type { ThreadId } from "@synara/contracts";
import { Effect } from "effect";

import type { BrowserAutomationHostShape } from "../../browserAutomation/Services/BrowserAutomationHost.ts";
import { ChatGptDriverFailure, ChatGptWebDriver } from "../chatgptWeb/driver.ts";
import type { ChatGptBrowserRpc } from "../chatgptWeb/types.ts";

/** How long the login request waits for the user to finish signing in. */
export const CHATGPT_LOGIN_WAIT_MS = 3 * 60_000;

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
  readonly browserHost: BrowserAutomationHostShape;
  readonly threadId: ThreadId;
  readonly waitMs?: number;
}): Promise<ChatGptLoginOutcome> {
  if (!input.browserHost.available) {
    return {
      status: "unavailable",
      message:
        "The Synara browser is only available in the desktop app. Open Synara desktop to sign in to ChatGPT.",
    };
  }

  const rpc: ChatGptBrowserRpc = {
    call: ({ name, args, timeoutMs }) =>
      Effect.runPromise(
        input.browserHost.execute({
          sessionKey: `chatgpt-login:${input.threadId}`,
          provider: "chatgpt",
          threadId: input.threadId,
          name,
          arguments: args,
          timeoutMs: Math.max(100, Math.min(30_000, timeoutMs ?? 20_000)),
        }),
      ),
  };

  const driver = new ChatGptWebDriver({
    rpc,
    loginWaitMs: input.waitMs ?? CHATGPT_LOGIN_WAIT_MS,
  });

  try {
    const conversation = await driver.ensureConversation();
    return {
      status: "signed-in",
      message: "Signed in to ChatGPT in the Synara browser.",
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
