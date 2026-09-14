// Purpose: Loopback HTTP/WebSocket routes for the ChatGPT default-browser
//          extension bridge.
// Layer: Server provider connector / HTTP

import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { isLoopbackHost } from "../../startupAccess.ts";
import {
  CHATGPT_EXTERNAL_BROWSER_PAIR_PATH,
  CHATGPT_EXTERNAL_BROWSER_WS_PATH,
  ChatGptExternalBrowser,
} from "./Services/ChatGptExternalBrowser.ts";

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

export const chatGptExternalBrowserRouteLayer = Layer.merge(pairingRoute, websocketRoute);
