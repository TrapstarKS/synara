// Two-thread live check: one ChatGPT adapter, two Synara threads, both turns
// dispatched at the same time. Verifies concurrent streaming, one conversation
// per thread (never a shared tab) and that nothing steals the active tab.
//
// Run:
//   SYNARA_BRIDGE_ENDPOINT=http://127.0.0.1:58090/provider/chatgpt/browser/debug \
//     bun run .tmp-chatgpt-two-thread-e2e.ts
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Fiber, Layer, Ref, Stream } from 'effect';
import { ThreadId } from '@synara/contracts';

import { ServerConfig } from './src/config.ts';
import { ChatGptConnector } from './src/provider/chatgptConnector/Services/ChatGptConnector.ts';
import { ChatGptRuntimeRegistry } from './src/provider/chatgptConnector/runtime.ts';
import { ChatGptExternalBrowser } from './src/provider/chatgptConnector/Services/ChatGptExternalBrowser.ts';
import { makeChatGptAdapter } from './src/provider/Layers/ChatGptAdapter.ts';
import { ChatGptWebDriver } from './src/provider/chatgptWeb/driver.ts';

const endpoint =
  process.env.SYNARA_BRIDGE_ENDPOINT ?? 'http://127.0.0.1:58090/provider/chatgpt/browser/debug';
const rpc = {
  call: async (input: any) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-synara-debug-bridge': '1' },
      body: JSON.stringify({
        name: input.name,
        threadId: 'debug-browser',
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
    localUrl: '', publicUrl: null, connectorUrl: '', tunnelState: 'disabled',
    tunnelMessage: null, secretCreatedAt: new Date().toISOString(),
    activeThreadId: null, registeredThreadIds: [], toolCallCount: 0, lastToolCallAt: null,
  }),
  rotateSecret: Effect.succeed({} as any),
  restartTunnel: Effect.succeed({} as any),
  handlePost: () => Effect.succeed({ status: 404 } as const),
} as any;

const external = {
  available: true,
  createPairing: () => ({ pairingUrl: '', chatgptUrl: '', expiresAt: new Date().toISOString() }),
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
      return ((md ? md.textContent : t.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
    }
    return null;
  };
  return { url: location.href, lastUser: last('user'), lastAssistant: last('assistant') };
})()`;

const pageSnapshot = Effect.tryPromise(async () => {
  const out: Array<Record<string, unknown>> = [];
  try {
    const tabs = (await rpc.call({ name: 'browser_tabs', args: {}, timeoutMs: 10_000 })) as any;
    for (const tab of tabs?.tabs ?? []) {
      try {
        const result = (await rpc.call({
          name: 'browser_evaluate',
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

const threadA = ThreadId.makeUnsafe(`chatgpt-two-a-${Date.now()}`);
const threadB = ThreadId.makeUnsafe(`chatgpt-two-b-${Date.now()}`);
const layer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: 'chatgpt-two-thread-' }),
  Layer.succeed(ChatGptConnector, connector),
  Layer.succeed(ChatGptExternalBrowser, external),
).pipe(Layer.provide(NodeServices.layer));

const program = Effect.gen(function* () {
  const startedAt = Date.now();
  const log = yield* Ref.make<Array<{ at: number; threadId: string; type: string; delta?: string }>>(
    [],
  );
  const adapter = yield* makeChatGptAdapter({
    createDriver: () => new ChatGptWebDriver({ rpc, completionTimeoutMs: 120_000 }),
    resolveMaxWorkers: () => Effect.succeed(0),
  });
  const terminals = new Set<string>();
  const collector = yield* adapter.streamEvents.pipe(
    Stream.tap((event) =>
      Ref.update(log, (entries) => [
        ...entries,
        {
          at: Date.now(),
          threadId: String(event.threadId),
          type: event.type,
          delta: (event.payload as { delta?: string }).delta,
        },
      ]),
    ),
    Stream.takeUntil((event) => {
      if (event.type === 'turn.completed') terminals.add(String(event.threadId));
      return terminals.size === 2;
    }),
    Stream.runDrain,
    Effect.forkChild,
  );

  const sessionA = yield* adapter.startSession({
    provider: 'chatgpt',
    threadId: threadA,
    runtimeMode: 'full-access',
    cwd: process.cwd(),
  });
  const sessionB = yield* adapter.startSession({
    provider: 'chatgpt',
    threadId: threadB,
    runtimeMode: 'full-access',
    cwd: process.cwd(),
  });

  const prompt = (marker: string) =>
    `Responda com exatamente 20 linhas numeradas de 1 a 20, cada linha contendo a palavra ${marker}.`;
  const dispatchA = yield* Effect.exit(
    Effect.gen(function* () {
      return yield* adapter.sendTurn({ threadId: threadA, input: prompt('CONC_A') });
    }),
  ).pipe(Effect.forkChild({ startImmediately: true }));
  const dispatchB = yield* Effect.exit(
    Effect.gen(function* () {
      return yield* adapter.sendTurn({ threadId: threadB, input: prompt('CONC_B') });
    }),
  ).pipe(Effect.forkChild({ startImmediately: true }));
  const exitA = yield* Fiber.join(dispatchA);
  const exitB = yield* Fiber.join(dispatchB);

  const outcome = yield* Effect.raceFirst(
    Fiber.join(collector).pipe(Effect.as('done' as const)),
    Effect.sleep('90 seconds').pipe(Effect.as('timeout' as const)),
  );
  if (outcome === 'timeout') {
    yield* Fiber.interrupt(collector);
  }

  const entries = Array.from(yield* Ref.get(log));
  const perThread = (threadId: ThreadId) => {
    const mine = entries.filter((entry) => entry.threadId === String(threadId));
    const deltas = mine.filter((entry) => entry.type === 'content.delta');
    const terminal = mine.find((entry) => entry.type === 'turn.completed');
    return {
      events: mine.map((entry) => entry.type),
      deltaCount: deltas.length,
      deltaLengths: deltas.map((entry) => String(entry.delta ?? '').length),
      firstDeltaAt: deltas[0]?.at ?? null,
      terminalAt: terminal?.at ?? null,
      terminalType: terminal ? 'turn.completed' : null,
    };
  };
  const a = perThread(threadA);
  const b = perThread(threadB);

  yield* adapter.stopSession(threadA).pipe(Effect.catchCause(() => Effect.void));
  yield* adapter.stopSession(threadB).pipe(Effect.catchCause(() => Effect.void));
  const pages = yield* pageSnapshot;

  return {
    endpoint,
    outcome,
    elapsedMs: Date.now() - startedAt,
    sessionA: { resumeCursor: sessionA.resumeCursor },
    sessionB: { resumeCursor: sessionB.resumeCursor },
    distinctConversations:
      sessionA.resumeCursor !== undefined &&
      sessionB.resumeCursor !== undefined &&
      sessionA.resumeCursor !== sessionB.resumeCursor,
    dispatchA: exitA._tag === 'Success' ? 'accepted' : String((exitA as any).cause),
    dispatchB: exitB._tag === 'Success' ? 'accepted' : String((exitB as any).cause),
    threadA: a,
    threadB: b,
    overlap:
      a.firstDeltaAt !== null && b.firstDeltaAt !== null
        ? {
            bothStreamingWindowMs:
              Math.min(a.terminalAt ?? 0, b.terminalAt ?? 0) - Math.max(a.firstDeltaAt, b.firstDeltaAt),
          }
        : null,
    pages,
  };
}).pipe(Effect.scoped, Effect.provide(layer));

console.log(JSON.stringify(await Effect.runPromise(program), null, 2));
