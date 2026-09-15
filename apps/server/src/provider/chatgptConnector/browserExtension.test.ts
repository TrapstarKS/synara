// FILE: browserExtension.test.ts
// Purpose: Exercise the unpacked Chromium extension service worker against a
//          small Chrome/WebSocket harness so bridge regressions are tested with
//          the exact shipped JavaScript.
// Layer: Server provider / ChatGPT external-browser integration tests

import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

const BACKGROUND_PATH = new URL(
  "../../../../../extensions/chatgpt-browser/background.js",
  import.meta.url,
);
const BACKGROUND_SOURCE = readFileSync(BACKGROUND_PATH, "utf8");
const TOKEN = "a-valid-pairing-token-with-enough-characters";

type Listener = (event?: unknown) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: string[] = [];
  readyState = 0;

  constructor(readonly url: string) {}

  addEventListener(name: string, listener: Listener): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  emit(name: string, event?: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
  }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 3; index++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function loadBackground(input?: {
  readonly origin?: string;
  readonly tabs?: Record<string, unknown>[];
  readonly getTab?: () => Promise<Record<string, unknown>>;
}) {
  const sockets: FakeWebSocket[] = [];
  const WebSocket = class extends FakeWebSocket {
    static override readonly OPEN = FakeWebSocket.OPEN;
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  };
  const attach = vi.fn(async () => undefined);
  const sendCommand = vi.fn(async () => ({ result: { value: { ready: true } } }));
  const chrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({
          synaraChatGptPairing: {
            origin: input?.origin ?? "http://127.0.0.1:3773",
            token: TOKEN,
          },
        })),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
    runtime: {
      onMessage: { addListener: vi.fn() },
    },
    debugger: {
      attach,
      sendCommand,
      onDetach: { addListener: vi.fn() },
    },
    tabs: {
      query: vi.fn(async () => input?.tabs ?? []),
      get: vi.fn(input?.getTab ?? (async () => input?.tabs?.[0] ?? {})),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
      remove: vi.fn(async () => undefined),
    },
  };
  const immediateTimeout = (callback: () => void): number => {
    queueMicrotask(callback);
    return 1;
  };
  vm.runInNewContext(BACKGROUND_SOURCE, {
    URL,
    WebSocket,
    chrome,
    clearInterval: vi.fn(),
    clearTimeout: vi.fn(),
    console,
    setInterval: vi.fn(() => 1),
    setTimeout: immediateTimeout,
  });
  return { attach, chrome, sendCommand, sockets };
}

describe("ChatGPT browser extension background", () => {
  it("canonicalizes an upgraded loopback origin to a plaintext WebSocket", async () => {
    const harness = loadBackground({ origin: "https://127.0.0.1:50362" });
    await flush();

    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0]?.url).toBe(
      `ws://127.0.0.1:50362/provider/chatgpt/browser?token=${TOKEN}`,
    );
  });

  it("reports a ChatGPT pendingUrl while a new tab is still committing", async () => {
    const harness = loadBackground({
      tabs: [
        {
          id: 7,
          url: "chrome://newtab/",
          pendingUrl: "https://chatgpt.com/",
          active: true,
        },
      ],
    });
    await flush();
    const socket = harness.sockets[0]!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({ type: "request", id: 1, name: "browser_tabs", args: {} }),
    });
    await flush();

    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "response",
      id: 1,
      ok: true,
      result: {
        activeTabId: "7",
        tabs: [{ tabId: "7", url: "https://chatgpt.com/", active: true }],
      },
    });
  });

  it("waits for a pending ChatGPT navigation before evaluating the page", async () => {
    let reads = 0;
    const harness = loadBackground({
      getTab: async () => {
        reads++;
        return reads === 1
          ? {
              id: 7,
              url: "chrome://newtab/",
              pendingUrl: "https://chatgpt.com/",
            }
          : { id: 7, url: "https://chatgpt.com/", pendingUrl: "" };
      },
    });
    await flush();
    const socket = harness.sockets[0]!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({
        type: "request",
        id: 2,
        name: "browser_evaluate",
        args: { tabId: "7", expression: "location.href" },
      }),
    });
    await flush();

    expect(reads).toBe(2);
    expect(harness.attach).toHaveBeenCalledWith({ tabId: 7 }, "1.3");
    expect(harness.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      "Runtime.evaluate",
      expect.objectContaining({ expression: "location.href" }),
    );
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "response",
      id: 2,
      ok: true,
      result: { value: { ready: true } },
    });
  });
});
