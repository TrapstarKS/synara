// Live adapter harness for the ChatGPT (Web) provider against the browser
// bridge. It reproduces the app's dispatch shape exactly: the provider call
// runs inside a fiber that completes as soon as `sendTurn` returns, which is
// what the provider command reactor does.
//
// Run:
//   SYNARA_BRIDGE_ENDPOINT=http://127.0.0.1:63601/provider/chatgpt/browser/debug \
//     bun run .tmp-chatgpt-adapter-e2e.ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, Ref, Stream } from "effect";
import { ThreadId } from "@synara/contracts";

import { ServerConfig } from "./src/config.ts";
import { ChatGptConnector } from "./src/provider/chatgptConnector/Services/ChatGptConnector.ts";
import { ChatGptRuntimeRegistry } from "./src/provider/chatgptConnector/runtime.ts";
import { ChatGptExternalBrowser } from "./src/provider/chatgptConnector/Services/ChatGptExternalBrowser.ts";
import { makeChatGptAdapter } from "./src/provider/Layers/ChatGptAdapter.ts";
import { ChatGptWebDriver } from "./src/provider/chatgptWeb/driver.ts";

const endpoint =
  process.env.SYNARA_BRIDGE_ENDPOINT ?? "http://127.0.0.1:63601/provider/chatgpt/browser/debug";
const rpc = {
  call: async (input: any) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-synara-debug-bridge": "1" },
      body: JSON.stringify({
        name: input.name,
        threadId: "debug-browser",
        args: input.args,
        timeoutMs: input.timeoutMs,
      }),
    });
    const payload = (await response.json()) as any;
    if (!payload.ok) throw new Error(payload.error || `debug route ${response.status}`);
    return payload.result;
  },
};

const registry = new ChatGptRuntimeRegistry();
const connector = {
  registry,
  getInfo: Effect.succeed({
    localUrl: "",
    publicUrl: null,
    connectorUrl: "",
    tunnelState: "disabled",
    tunnelMessage: null,
    secretCreatedAt: new Date().toISOString(),
    activeThreadId: null,
    registeredThreadIds: [],
    toolCallCount: 0,
    lastToolCallAt: null,
  }),
  rotateSecret: Effect.succeed({} as any),
  restartTunnel: Effect.succeed({} as any),
  handlePost: () => Effect.succeed({ status: 404 } as const),
} as any;

const external = {
  available: true,
  createPairing: () => ({ pairingUrl: "", chatgptUrl: "", expiresAt: new Date().toISOString() }),
  hasPairing: () => true,
  renderPairingPage: () => null,
  attachClient: () => null,
  handleClientMessage: () => undefined,
  detachClient: () => undefined,
  waitForClient: async () => true,
  execute: async () => undefined,
} as any;

const PAGE_PROBE = `(() => {
  var TURN = 'section[data-testid^="conversation-turn"], article[data-testid^="conversation-turn"]';
  var turns = Array.from(document.querySelectorAll(TURN));
  var last = function (role) {
    for (var i = turns.length - 1; i >= 0; i--) {
      var t = turns[i];
      var a = t.querySelector('[data-message-author-role]');
      var r = a ? a.getAttribute('data-message-author-role') : t.getAttribute('data-turn');
      if (r !== role) continue;
      var md = t.querySelector('.markdown');
      return ((md ? md.textContent : t.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 220);
    }
    return null;
  };
  var stops = Array.from(document.querySelectorAll('button[data-testid="stop-button"], button[data-testid="composer-stop-button"]')).filter(function (b) { return b.getClientRects().length > 0; });
  return { url: location.href, lastUser: last('user'), lastAssistant: last('assistant'), visibleStops: stops.length };
})()`;

const pageSnapshot = Effect.tryPromise(async () => {
  const out: Array<Record<string, unknown>> = [];
  try {
    const tabs = (await rpc.call({ name: "browser_tabs", args: {}, timeoutMs: 10_000 })) as any;
    for (const tab of tabs?.tabs ?? []) {
      try {
        const result = (await rpc.call({
          name: "browser_evaluate",
          args: { tabId: Number(tab.tabId), expression: PAGE_PROBE },
          timeoutMs: 15_000,
        })) as any;
        out.push({ tabId: tab.tabId, active: tab.active === true, ...(result?.value ?? {}) });
      } catch (error) {
        out.push({ tabId: tab.tabId, error: String(error) });
      }
    }
  } catch (error) {
    out.push({ error: String(error) });
  }
  return out;
});

const threadId = ThreadId.makeUnsafe(`chatgpt-adapter-e2e-${Date.now()}`);
const layer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "chatgpt-adapter-e2e-" }),
  Layer.succeed(ChatGptConnector, connector),
  Layer.succeed(ChatGptExternalBrowser, external),
).pipe(Layer.provide(NodeServices.layer));

const program = Effect.gen(function* () {
  const log = yield* Ref.make<Array<{ at: number; event: any }>>([]);
  const adapter = yield* makeChatGptAdapter({
    createDriver: () =>
      new ChatGptWebDriver({ rpc, completionTimeoutMs: 90_000, onLoginRequired: () => {} }),
    resolveMaxWorkers: () => Effect.succeed(0),
  });
  const startedAt = Date.now();
  const collector = yield* adapter.streamEvents.pipe(
    Stream.tap((event) => Ref.update(log, (entries) => [...entries, { at: Date.now(), event }])),
    Stream.takeUntil((event) => event.type === "turn.completed" && event.threadId === threadId),
    Stream.runDrain,
    Effect.forkChild,
  );

  // App-faithful dispatch: the provider call runs in a fiber that completes as
  // soon as it returns, so any child fiber forked inside `sendTurn` must not
  // depend on that fiber staying alive.
  const handlerFiber = yield* Effect.gen(function* () {
    yield* adapter.startSession({
      provider: 'chatgpt',
      threadId,
      runtimeMode: 'full-access',
      cwd: process.cwd(),
      ...(process.env.SYNARA_RESUME_URL ? { resumeCursor: process.env.SYNARA_RESUME_URL } : {}),
    });
    return yield* adapter.sendTurn({
      threadId,
      input:
        "Responda com exatamente 25 linhas numeradas de 1 a 25, uma palavra ADAPTER_STREAM em cada linha.",
    });
  }).pipe(Effect.forkChild({ startImmediately: true }));
  const dispatch = yield* Fiber.join(handlerFiber);

  const waitOutcome = yield* Effect.raceFirst(
    Fiber.join(collector).pipe(Effect.as("terminal" as const)),
    Effect.sleep("45 seconds").pipe(Effect.as("timeout" as const)),
  );
  if (waitOutcome === "timeout") {
    yield* Fiber.interrupt(collector);
  }

  const entries = Array.from(yield* Ref.get(log));
  const deltas = entries.filter((entry) => entry.event.type === "content.delta");
  const firstDeltaAt = deltas[0]?.at ?? startedAt;
  const terminal = entries.find((entry) => entry.event.type === "turn.completed");
  const completedItems = entries.filter((entry) => entry.event.type === "item.completed");
  const lastData = completedItems.at(-1)?.event.payload as { data?: { text?: string } } | undefined;
  const finalText = lastData?.data?.text ?? "";
  const finalLines = finalText.split("\n").filter((line: string) => line.trim().length > 0);

  yield* adapter.stopSession(threadId).pipe(Effect.catchCause(() => Effect.void));
  const pages = yield* pageSnapshot;

  return {
    endpoint,
    threadId: String(threadId),
    turnId: String(dispatch.turnId),
    waitOutcome,
    eventCount: entries.length,
    eventTypes: entries.map((entry) => entry.event.type),
    deltaCount: deltas.length,
    deltaLengths: deltas.map(
      (entry) => String((entry.event.payload as { delta?: string }).delta || "").length,
    ),
    deltaOffsetsMs: deltas.map((entry) => entry.at - firstDeltaAt),
    finalTextLength: finalText.length,
    finalTextLines: finalLines.length,
    finalFirstLine: finalLines[0] ?? "",
    finalLastLine: finalLines.at(-1) ?? "",
    terminal: terminal
      ? {
          state: (terminal.event.payload as { state?: string }).state,
          stopReason: (terminal.event.payload as { stopReason?: string }).stopReason,
          errorMessage: (terminal.event.payload as { errorMessage?: string }).errorMessage,
        }
      : null,
    pages,
  };
}).pipe(Effect.scoped, Effect.provide(layer));

console.log(JSON.stringify(await Effect.runPromise(program), null, 2));
