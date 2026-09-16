// Purpose: Loopback HTTP/WebSocket routes for the ChatGPT default-browser
//          extension bridge.
// Layer: Server provider connector / HTTP

import { Effect, FileSystem, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { ThreadId } from "@synara/contracts";
import { ServerConfig } from "../../config.ts";
import { isLoopbackHost } from "../../startupAccess.ts";
import {
  CHATGPT_EXTERNAL_BROWSER_DEBUG_PATH,
  CHATGPT_EXTERNAL_BROWSER_PAIR_PATH,
  CHATGPT_EXTERNAL_BROWSER_WS_PATH,
  ChatGptExternalBrowser,
} from "./Services/ChatGptExternalBrowser.ts";
import type { ChatGptBrowserToolName } from "../chatgptWeb/types.ts";

const unavailableResponse = () =>
  HttpServerResponse.text("The local ChatGPT browser bridge is unavailable.", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });

const invalidPairingResponse = () =>
  HttpServerResponse.text("Invalid or expired browser pairing.", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });

const debugTools = new Set<ChatGptBrowserToolName>([
  "browser_tabs",
  "browser_open",
  "browser_navigate",
  "browser_wait",
  "browser_evaluate",
  "browser_debug",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_screenshot",
  "browser_tab_state",
  "browser_reload_tab",
  "browser_close",
]);

const debugRoute = HttpRouter.add(
  "POST",
  CHATGPT_EXTERNAL_BROWSER_DEBUG_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const bridge = yield* ChatGptExternalBrowser;
    // This is intentionally not part of the public connector surface. It is
    // a loopback diagnostic escape hatch for a locally loaded debug extension,
    // and the explicit header prevents accidental browser-origin calls.
    if (
      !bridge.available ||
      !isLoopbackHost(config.host) ||
      config.publicUrl !== undefined ||
      request.headers["x-synara-debug-bridge"] !== "1"
    ) {
      return unavailableResponse();
    }
    const parsedBody = yield* request.json.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(256 * 1024)),
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!parsedBody.ok) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Invalid or oversized debug JSON." },
        { status: 400 },
      );
    }
    const payload: unknown = parsedBody.value;
    const record =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const name = typeof record?.name === "string" ? record.name : "";
    if (!debugTools.has(name as ChatGptBrowserToolName)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Unsupported browser debug action." },
        { status: 400 },
      );
    }
    const rawArgs = record?.args;
    const args =
      rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const threadId =
      typeof record?.threadId === "string" && record.threadId.trim().length > 0
        ? record.threadId.trim()
        : "debug-browser";
    const requestedTimeout = Number(record?.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.max(100, Math.min(120_000, requestedTimeout))
      : 30_000;
    try {
      const result = yield* Effect.tryPromise(() =>
        bridge.execute({
          threadId: threadId as ThreadId,
          name: name as ChatGptBrowserToolName,
          args,
          timeoutMs,
        }),
      );
      return HttpServerResponse.jsonUnsafe({ ok: true, result });
    } catch (error) {
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 502 },
      );
    }
  }),
);

const pairingRoute = HttpRouter.add(
  "GET",
  CHATGPT_EXTERNAL_BROWSER_PAIR_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const bridge = yield* ChatGptExternalBrowser;
    if (!bridge.available || !isLoopbackHost(config.host) || config.publicUrl !== undefined) {
      return unavailableResponse();
    }
    const url = HttpServerRequest.toURL(request);
    const token = url?.searchParams.get("token") ?? "";
    const page = bridge.renderPairingPage(token);
    return page === null
      ? invalidPairingResponse()
      : HttpServerResponse.text(page, {
          contentType: "text/html; charset=utf-8",
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
  }),
);

const websocketRoute = HttpRouter.add(
  "GET",
  CHATGPT_EXTERNAL_BROWSER_WS_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const bridge = yield* ChatGptExternalBrowser;
    if (!bridge.available || !isLoopbackHost(config.host) || config.publicUrl !== undefined) {
      return unavailableResponse();
    }
    const url = HttpServerRequest.toURL(request);
    const token = url?.searchParams.get("token") ?? "";
    if (!bridge.hasPairing(token)) return invalidPairingResponse();

    const socket = yield* request.upgrade;
    const writer = yield* socket.writer;
    const client = bridge.attachClient({
      token,
      send: (payload) => Effect.runPromise(writer(payload)),
    });
    if (client === null) return HttpServerResponse.empty();

    yield* Effect.addFinalizer(() => Effect.sync(() => bridge.detachClient(client.clientId)));
    yield* socket.runRaw((message) =>
      Effect.sync(() => bridge.handleClientMessage(client.clientId, message)),
    );
    return HttpServerResponse.empty();
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logDebug("ChatGPT external browser socket closed", { cause: String(cause) }),
        HttpServerResponse.empty(),
      ),
    ),
  ),
);

export const chatGptExternalBrowserRouteLayer = Layer.mergeAll(
  pairingRoute,
  websocketRoute,
  debugRoute,
);
