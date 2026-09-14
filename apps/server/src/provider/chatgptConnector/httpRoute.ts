// FILE: httpRoute.ts
// Purpose: The authenticated HTTP endpoint ChatGPT's developer-mode connector
//          posts MCP traffic to, plus the loopback URL shown in settings.
// Layer: Server provider connector / HTTP
//
// Security model: the path carries a 256-bit secret (see credentials.ts) and
// that secret is the only credential — ChatGPT cannot present a Synara session
// or bearer token. The route therefore ignores Origin/Host and never confirms
// which tokens exist (unknown paths answer 404). Bodies are read with the same
// bounded, semaphore-gated reader the external MCP route uses.

import { Effect, Layer, Option, Semaphore } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { readMcpJsonBody, type McpBodyReadResult } from "../../agentGateway/httpRoute.ts";
import { isValidConnectorToken } from "./credentials.ts";
import { ChatGptConnector } from "./Services/ChatGptConnector.ts";

export const CHATGPT_CONNECTOR_PATH_PREFIX = "/mcp/chatgpt";
// A maximal patch or read result stays well under 1 MiB; larger bodies are
// rejected before they can occupy memory. Only a few bodies buffer at once.
export const CHATGPT_CONNECTOR_MAX_BODY_BYTES = 1024 * 1024;
export const CHATGPT_CONNECTOR_BODY_TIMEOUT_MS = 15_000;
const CHATGPT_CONNECTOR_BODY_BUFFER_SLOTS = 4;
const bodyBufferSlots = Effect.runSync(Semaphore.make(CHATGPT_CONNECTOR_BODY_BUFFER_SLOTS));

type BodyReadResult = McpBodyReadResult | { readonly kind: "timeout" };

const readBoundedBody = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<BodyReadResult> =>
  bodyBufferSlots.withPermit(readMcpJsonBody(request, CHATGPT_CONNECTOR_MAX_BODY_BYTES)).pipe(
    Effect.timeoutOption(CHATGPT_CONNECTOR_BODY_TIMEOUT_MS),
    Effect.map(
      Option.match({
        onNone: () => ({ kind: "timeout" as const }),
        onSome: (result) => result,
      }),
    ),
  );

const notFound = () =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Unknown connector endpoint." },
    },
    { status: 404 },
  );

const postRoute = HttpRouter.add(
  "POST",
  `${CHATGPT_CONNECTOR_PATH_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const connector = yield* ChatGptConnector;
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });
    const rawToken = url.pathname.slice(CHATGPT_CONNECTOR_PATH_PREFIX.length);
    // Exactly one path segment carrying a well-formed token.
    if (!rawToken.startsWith("/") || rawToken.slice(1).includes("/")) return notFound();
    const token = rawToken.slice(1);
    if (!isValidConnectorToken(token)) return notFound();

    const body = yield* readBoundedBody(request);
    if (body.kind === "timeout") {
      return HttpServerResponse.jsonUnsafe(
        { error: "Request body read timed out." },
        { status: 408, headers: { Connection: "close" } },
      );
    }
    if (body.kind === "too-large") {
      return HttpServerResponse.jsonUnsafe(
        { error: "Request body exceeds the 1 MiB limit." },
        { status: 413 },
      );
    }
    if (body.kind === "invalid") {
      return HttpServerResponse.jsonUnsafe({ error: "Invalid JSON body." }, { status: 400 });
    }

    const result = yield* connector
      .handlePost({ token, body: body.body })
      .pipe(Effect.catch(() => Effect.succeed({ status: 503 } as const)));
    if (result.status === 404) return notFound();
    const responseBody = "body" in result ? result.body : undefined;
    return responseBody === undefined
      ? HttpServerResponse.empty({ status: result.status })
      : HttpServerResponse.jsonUnsafe(responseBody, { status: result.status });
  }),
);

const methodNotAllowed = (method: "GET" | "DELETE") =>
  HttpRouter.add(
    method,
    `${CHATGPT_CONNECTOR_PATH_PREFIX}/*`,
    HttpServerResponse.text("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    }),
  );

export const chatGptConnectorRouteLayer = Layer.mergeAll(
  postRoute,
  methodNotAllowed("GET"),
  methodNotAllowed("DELETE"),
);
