import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, Stream } from "effect";
import { ThreadId } from "@synara/contracts";

import { ServerConfig } from "./src/config.ts";
import { ChatGptConnector } from "./src/provider/chatgptConnector/Services/ChatGptConnector.ts";
import { ChatGptRuntimeRegistry } from "./src/provider/chatgptConnector/runtime.ts";
import { ChatGptExternalBrowser } from "./src/provider/chatgptConnector/Services/ChatGptExternalBrowser.ts";
import { makeChatGptAdapter } from "./src/provider/Layers/ChatGptAdapter.ts";
import { ChatGptWebDriver } from "./src/provider/chatgptWeb/driver.ts";

const endpoint = "http://127.0.0.1:58090/provider/chatgpt/browser/debug";
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

const threadId = ThreadId.makeUnsafe(`chatgpt-adapter-e2e-${Date.now()}`);
const layer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "chatgpt-adapter-e2e-" }),
  Layer.succeed(ChatGptConnector, connector),
  Layer.succeed(ChatGptExternalBrowser, external),
).pipe(Layer.provide(NodeServices.layer));

const program = Effect.gen(function* () {
  const adapter = yield* makeChatGptAdapter({
    createDriver: () =>
      new ChatGptWebDriver({ rpc, pollMs: 300, settleMs: 500, completionTimeoutMs: 120_000 }),
    resolveMaxWorkers: () => Effect.succeed(0),
  });
  const eventsFiber = yield* adapter.streamEvents.pipe(
    Stream.takeUntil((event) => event.type === "turn.completed" && event.threadId === threadId),
    Stream.map((event) => ({ at: Date.now(), event })),
    Stream.runCollect,
    Effect.forkChild,
  );
  const session = yield* adapter.startSession({
    provider: "chatgpt",
    threadId,
    runtimeMode: "full-access",
    cwd: process.cwd(),
  });
  const turn = yield* adapter.sendTurn({
    threadId,
    input:
      "Responda com exatamente 25 linhas numeradas de 1 a 25, uma palavra ADAPTER_STREAM em cada linha.",
  });
  const events = yield* Fiber.join(eventsFiber);
  yield* adapter.stopSession(threadId);
  const list = Array.from(events);
  const deltas = list.filter((entry) => entry.event.type === "content.delta");
  const firstDeltaAt = deltas[0]?.at ?? 0;
  const terminal = list.find((entry) => entry.event.type === "turn.completed");
  const completedItems = list.filter((entry) => entry.event.type === "item.completed");
  const lastData = completedItems.at(-1)?.event.payload as { data?: { text?: string } } | undefined;
  const finalText = lastData?.data?.text ?? "";
  const finalLines = finalText.split("\n").filter((line) => line.trim().length > 0);
  return {
    session: { status: session.status, url: session.resumeCursor },
    turn: { turnId: turn.turnId },
    eventCount: list.length,
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
    types: list.map((entry) => entry.event.type),
    payloads: list.map((entry) => ({ type: entry.event.type, payload: entry.event.payload })),
  };
}).pipe(Effect.scoped, Effect.provide(layer));

console.log(JSON.stringify(await Effect.runPromise(program), null, 2));
