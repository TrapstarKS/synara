// Purpose: Verify pairing, scoped browser requests, responses, and expiry for
//          the ChatGPT default-browser bridge.
// Layer: Server provider connector tests

import { describe, expect, it } from "vitest";

import { makeChatGptExternalBrowser } from "./ChatGptExternalBrowser.ts";

describe("ChatGptExternalBrowser", () => {
  it("pairs one thread and resolves an extension response", async () => {
    const sent: string[] = [];
    const browser = makeChatGptExternalBrowser({
      available: true,
      origin: "http://127.0.0.1:3773",
      randomToken: () => "pair-token",
      randomClientId: () => "client-1",
    });
    const pairing = browser.createPairing("thread-1" as never);
    expect(pairing.pairingUrl).toContain("token=pair-token");
    expect(browser.renderPairingPage("pair-token")).toContain("Synara browser bridge");

    const client = browser.attachClient({
      token: "pair-token",
      send: async (payload) => {
        sent.push(payload);
      },
    });
    expect(client).toEqual({ clientId: "client-1", threadId: "thread-1" });
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({ type: "connected", protocol: 1 });

    const resultPromise = browser.execute({
      threadId: "thread-1" as never,
      name: "browser_tabs",
      args: {},
      timeoutMs: 1_000,
    });
    const request = JSON.parse(sent[1] ?? "{}");
    expect(request).toMatchObject({ type: "request", name: "browser_tabs", args: {} });
    browser.handleClientMessage(
      "client-1",
      JSON.stringify({ type: "response", id: request.id, ok: true, result: { tabs: [] } }),
    );

    await expect(resultPromise).resolves.toEqual({ tabs: [] });
  });

  it("does not keep an expired pairing alive", async () => {
    let currentTime = 100;
    const browser = makeChatGptExternalBrowser({
      available: true,
      origin: "http://127.0.0.1:3773",
      now: () => currentTime,
      pairingTtlMs: 1_000,
      randomToken: () => "pair-token",
      randomClientId: () => "client-1",
    });
    browser.createPairing("thread-1" as never);
    currentTime += 1_001;

    expect(browser.hasPairing("pair-token")).toBe(false);
    await expect(
      browser.execute({
        threadId: "thread-1" as never,
        name: "browser_tabs",
        args: {},
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("not connected");
  });

  it("wakes a login wait as soon as the extension pairs", async () => {
    const browser = makeChatGptExternalBrowser({
      available: true,
      origin: "http://127.0.0.1:3773",
      randomToken: () => "pair-token",
      randomClientId: () => "client-1",
    });
    browser.createPairing("thread-1" as never);
    const waiting = browser.waitForClient("thread-1" as never, 1_000);
    browser.attachClient({ token: "pair-token", send: async () => undefined });

    await expect(waiting).resolves.toBe(true);
  });
});
