import http from "node:http";
import { readFileSync, openSync, closeSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  openStore,
  hash,
  secret,
  defaults,
  validatePreferences,
  validateSubscription,
} from "./lib/store.mjs";
import { createPush } from "./lib/push.mjs";
import { watchSynara } from "./lib/synara-events.mjs";
import { createUpstreamResolver } from "./lib/desktop-upstream.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const publicUrl = new URL(process.env.SYNARA_MOBILE_ORIGIN ?? "https://localhost:8443");
const configuredUpstream = process.env.SYNARA_MOBILE_UPSTREAM?.trim() || undefined;
const upstreamResolver = createUpstreamResolver({
  upstream: configuredUpstream,
  token: process.env.SYNARA_MOBILE_UPSTREAM_TOKEN,
});
const port = Number(process.env.SYNARA_MOBILE_PORT ?? 58091);
if (
  publicUrl.protocol !== "https:" ||
  publicUrl.pathname !== "/" ||
  publicUrl.search ||
  publicUrl.hash ||
  publicUrl.username
) {
  throw new Error("SYNARA_MOBILE_ORIGIN must be an HTTPS origin");
}
const directory = resolve(process.env.SYNARA_MOBILE_HOME ?? join(homedir(), ".synara-mobile"));
const store = openStore(directory);
const lock = join(directory, "server.lock");
try {
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  const pid = Number(readFileSync(lock, "utf8"));
  try {
    process.kill(pid, 0);
    throw new Error(`Mobile service already running (PID ${pid})`);
  } catch (probe) {
    if (probe.code !== "ESRCH") throw probe;
  }
  unlinkSync(lock);
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
}
process.on("exit", () => {
  try {
    unlinkSync(lock);
  } catch {}
});
const { state, save } = store;
function newPairing() {
  const code = secret();
  state.pairing = { hash: hash(code), expiresAt: Date.now() + 15 * 60_000 };
  save();
  return `${publicUrl.origin}/mobile#pair=${code}`;
}
state.devices = state.devices.filter((device) => device.expiresAt > Date.now());
save();
const push = createPush(store, publicUrl.origin);
let monitor = { state: "connecting" };
const stopMonitor = watchSynara({
  resolveUpstream: () => upstreamResolver.resolve(),
  scope: configuredUpstream ? new URL(configuredUpstream).origin : "synara-desktop",
  onDisconnect: () => upstreamResolver.invalidate(),
  checkpoint: state.checkpoint,
  saveCheckpoint(checkpoint) {
    state.checkpoint = checkpoint;
    save();
  },
  onEvent: (event) => push.enqueue(event),
  onStatus: (status) => {
    monitor = status;
  },
});

const cookieName = "synara-mobile";
function deviceFor(req) {
  const token = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  return (
    token &&
    state.devices.find(
      (device) => device.tokenHash === hash(token) && device.expiresAt > Date.now(),
    )
  );
}
function cookie(token, age = 90 * 86400) {
  return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
}
function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
}
function safeOrigin(req) {
  return req.headers.origin === publicUrl.origin;
}
async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 16_384) throw new Error("Request too large");
  }
  return JSON.parse(raw || "{}");
}
const sockets = new Map();
const attempts = new Map();
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
const assetMap = {
  "/mobile": ["index.html", "text/html; charset=utf-8"],
  "/mobile/": ["index.html", "text/html; charset=utf-8"],
  "/mobile/app.js": ["app.js", "text/javascript"],
  "/mobile/style.css": ["style.css", "text/css"],
  "/mobile/install.js": ["install.js", "text/javascript"],
  "/mobile/theme.js": ["theme.js", "text/javascript"],
  "/mobile/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
  "/mobile/icon.svg": ["icon.svg", "image/svg+xml"],
  "/mobile/icon.png": ["icon.png", "image/png"],
  "/mobile/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
  "/mobile/sw.js": ["sw.js", "text/javascript"],
};
function proxyHeaders(req, target) {
  const upstream = new URL(target.origin);
  const headers = {
    ...req.headers,
    host: upstream.host,
    origin: upstream.origin,
    "accept-encoding": "identity",
  };
  // Proxy only the target's cookies. Pairing credentials never reach Synara.
  if (headers.cookie)
    headers.cookie = headers.cookie
      .split(";")
      .filter((s) => !s.trim().startsWith(cookieName + "="))
      .join(";");
  delete headers.forwarded;
  for (const key of Object.keys(headers))
    if (key.startsWith("x-forwarded-") || key.startsWith("tailscale-")) delete headers[key];
  return headers;
}
function offline(req, res) {
  if (req.method === "GET" && String(req.headers.accept).includes("text/html")) {
    res.writeHead(503, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "2",
    });
    return res.end(
      '<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="2"><title>Synara</title><style>html{color-scheme:light dark;font:16px system-ui}body{display:grid;min-height:90vh;place-items:center;margin:0;background:#101010;color:#ededed}main{max-width:28rem;padding:2rem;text-align:center}p{color:#a1a1a1}</style><main><h1>Synara está iniciando</h1><p>Abra o Synara no Mac. Esta tela reconecta automaticamente.</p></main></html>',
    );
  }
  return json(res, 503, { error: "Synara.app is not running" }, { "Retry-After": "2" });
}
async function proxy(req, res) {
  let targetConfig;
  try {
    targetConfig = upstreamResolver.resolve();
  } catch {
    return offline(req, res);
  }
  const upstream = new URL(targetConfig.origin);
  const target = http.request(
    upstream.origin + req.url,
    { method: req.method, headers: proxyHeaders(req, targetConfig) },
    (response) => {
      const headers = { ...response.headers, "cache-control": "no-store" };
      const isHtml =
        String(headers["content-type"]).includes("text/html") && response.statusCode === 200;
      if (!isHtml) {
        res.writeHead(response.statusCode, headers);
        response.pipe(res);
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          response.destroy();
          if (!res.headersSent) json(res, 502, { error: "Upstream HTML exceeds limit" });
        } else chunks.push(chunk);
      });
      response.on("end", () => {
        if (res.writableEnded) return;
        const html = Buffer.concat(chunks)
          .toString()
          .replace(
            "</head>",
            '<link rel="manifest" href="/mobile/manifest.webmanifest"><link rel="apple-touch-icon" href="/mobile/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><script defer src="/mobile/theme.js"></script><script defer src="/mobile/install.js"></script></head>',
          );
        delete headers["content-length"];
        delete headers["content-encoding"];
        delete headers.etag;
        res.writeHead(response.statusCode, headers);
        res.end(html);
      });
      response.on("error", () => {
        if (!res.headersSent) json(res, 502, { error: "Synara connection interrupted" });
        else res.destroy();
      });
    },
  );
  target.on("error", () => {
    upstreamResolver.invalidate();
    if (!res.headersSent)
      json(res, 502, { error: "Synara is offline. Start it on the Mac and retry." });
    else res.destroy();
  });
  target.setTimeout(120_000, () => target.destroy());
  req.on("aborted", () => target.destroy());
  req.pipe(target);
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== publicUrl.host && req.headers.host !== `127.0.0.1:${port}`)
      return json(res, 403, { error: "Invalid host" });
    const url = new URL(req.url, publicUrl);
    if (url.origin !== publicUrl.origin) return json(res, 400, { error: "Invalid URL" });
    if (!["GET", "HEAD"].includes(req.method) && !safeOrigin(req))
      return json(res, 403, { error: "Invalid origin" });
    if (assetMap[url.pathname] && ["GET", "HEAD"].includes(req.method)) {
      const [file, type] = assetMap[url.pathname];
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(file === "sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
      });
      return res.end(req.method === "HEAD" ? undefined : readFileSync(join(root, "public", file)));
    }
    // These fixed assets are public. Origin enforcement applies to data and actions.
    if (req.headers.origin && !safeOrigin(req)) return json(res, 403, { error: "Invalid origin" });
    if (url.pathname === "/mobile/api/pair" && req.method === "POST") {
      const key = req.headers["tailscale-user-login"] ?? req.socket.remoteAddress;
      const current = attempts.get(key) ?? { count: 0, until: Date.now() + 60_000 };
      if (current.until < Date.now()) {
        current.count = 0;
        current.until = Date.now() + 60_000;
      }
      attempts.set(key, current);
      if (++current.count > 10)
        return json(res, 429, { error: "Espere um minuto e tente novamente." });
      const input = await body(req);
      if (
        typeof input.code !== "string" ||
        input.code.length > 128 ||
        !state.pairing ||
        state.pairing.expiresAt < Date.now() ||
        hash(input.code) !== state.pairing.hash
      ) {
        return json(res, 401, { error: "Link expirado ou já usado. Gere outro link no Mac." });
      }
      if (state.devices.length >= 32)
        return json(res, 409, { error: "Limite de aparelhos atingido." });
      const token = secret();
      const device = {
        id: randomUUID(),
        tokenHash: hash(token),
        name: String(input.name || "Meu iPhone").slice(0, 80),
        expiresAt: Date.now() + 90 * 86400_000,
        preferences: { ...defaults },
      };
      state.devices.push(device);
      delete state.pairing;
      save();
      return json(res, 200, { ok: true }, { "Set-Cookie": cookie(token) });
    }
    const device = deviceFor(req);
    if (url.pathname === "/mobile/api/status" && req.method === "GET") {
      return json(
        res,
        200,
        device
          ? {
              paired: true,
              name: device.name,
              preferences: device.preferences,
              subscribed: Boolean(device.subscription),
              publicKey: push.publicKey,
              monitor,
              lastPushAt: device.lastPushAt,
              pushError: device.pushError,
            }
          : { paired: false },
      );
    }
    if (!device) {
      if (
        req.method === "GET" &&
        !url.pathname.startsWith("/api/") &&
        !url.pathname.startsWith("/mobile/api/")
      ) {
        res.writeHead(302, { Location: "/mobile", "Cache-Control": "no-store" });
        return res.end();
      }
      return json(res, 401, { error: "Conecte este aparelho primeiro." });
    }
    if (url.pathname === "/mobile/api/preferences" && req.method === "POST") {
      device.preferences = validatePreferences(await body(req));
      save();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/mobile/api/subscribe" && req.method === "POST") {
      const subscription = validateSubscription(await body(req));
      if (
        state.devices.some(
          (other) =>
            other.id !== device.id && other.subscription?.endpoint === subscription.endpoint,
        )
      ) {
        return json(res, 409, {
          error: "Esta inscrição pertence a outro pareamento. Desconecte-o primeiro.",
        });
      }
      device.subscription = subscription;
      delete device.pushError;
      save();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/mobile/api/unsubscribe" && req.method === "POST") {
      delete device.subscription;
      save();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/mobile/api/test" && req.method === "POST") {
      if (!device.subscription) return json(res, 409, { error: "Ative as notificações primeiro." });
      if (Date.now() - (device.lastTestAt ?? 0) < 10_000)
        return json(res, 429, { error: "Espere alguns segundos." });
      device.lastTestAt = Date.now();
      push.enqueue(
        {
          id: randomUUID(),
          kind: "test",
          title: "Synara conectado",
          body: "As notificações deste iPhone estão prontas.",
          url: "/mobile",
        },
        device.id,
      );
      return json(res, 202, { ok: true });
    }
    if (url.pathname === "/mobile/api/logout" && req.method === "POST") {
      state.devices = state.devices.filter((entry) => entry.id !== device.id);
      state.outbox = state.outbox.filter((entry) => entry.deviceId !== device.id);
      save();
      for (const ws of sockets.get(device.id) ?? []) ws.close(1008, "Device disconnected");
      return json(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0) });
    }
    if (url.pathname.startsWith("/mobile/")) return json(res, 404, { error: "Not found" });
    await proxy(req, res);
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: error.message });
    else res.destroy();
  }
});
server.on("upgrade", async (req, socket, head) => {
  const device = deviceFor(req);
  if (
    req.headers.host !== publicUrl.host ||
    !safeOrigin(req) ||
    !device ||
    !req.url.startsWith("/ws")
  ) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  let targetConfig;
  try {
    targetConfig = upstreamResolver.resolve();
  } catch {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = new URL(targetConfig.origin);
  const targetUrl = new URL(req.url, upstream);
  targetUrl.protocol = "ws:";
  if (targetConfig.token) targetUrl.searchParams.set("token", targetConfig.token);
  const target = new WebSocket(targetUrl, {
    headers: proxyHeaders(req, targetConfig),
    maxPayload: 16 * 1024 * 1024,
    handshakeTimeout: 10_000,
  });
  target.on("error", () => {
    upstreamResolver.invalidate();
    socket.destroy();
  });
  target.once("unexpected-response", (_request, response) => {
    response.resume();
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  socket.once("close", () => target.terminate());
  target.once("open", () => {
    if (socket.destroyed) {
      target.terminate();
      return;
    }
    // Revocation/expiry may have happened during the upstream handshake.
    if (deviceFor(req)?.id !== device.id) {
      target.terminate();
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const set = sockets.get(device.id) ?? new Set();
      set.add(client);
      sockets.set(device.id, set);
      const relay = (from, to) =>
        from.on("message", (data, binary) => {
          if (to.readyState !== WebSocket.OPEN || to.bufferedAmount > 16 * 1024 * 1024) {
            from.close(1013, "Reconnect");
            to.terminate();
            return;
          }
          to.send(data, { binary });
        });
      relay(client, target);
      relay(target, client);
      client.on("error", () => target.terminate());
      target.on("error", () => client.terminate());
      client.on("close", () => {
        set.delete(client);
        if (!set.size) sockets.delete(device.id);
        target.terminate();
      });
      target.on("close", () => {
        upstreamResolver.invalidate();
        client.close(1012, "Synara disconnected");
      });
    });
  });
});
const expiryTimer = setInterval(() => {
  for (const [id, clients] of sockets)
    if (!state.devices.some((device) => device.id === id && device.expiresAt > Date.now())) {
      for (const client of clients) client.close(1008, "Pair again");
    }
  for (const [key, value] of attempts) if (value.until < Date.now()) attempts.delete(key);
}, 30_000);
server.listen(port, "127.0.0.1", () => {
  console.log(`Synara Mobile listening on 127.0.0.1:${port}`);
  console.log(`Open ${publicUrl.origin}/mobile; run node cli.mjs pair for a private pairing link.`);
});
// Local administration uses a private Unix socket, never a remotely reachable endpoint.
const adminPath = join(directory, "admin.sock");
try {
  unlinkSync(adminPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const admin = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/pair")
      return json(res, 200, { url: newPairing(), expiresInMinutes: 15 });
    if (req.method === "GET" && req.url === "/devices")
      return json(res, 200, {
        devices: state.devices.map(({ id, name, expiresAt, subscription }) => ({
          id,
          name,
          expiresAt,
          push: Boolean(subscription),
        })),
      });
    if (req.method === "POST" && req.url === "/revoke") {
      const { id } = await body(req);
      state.devices = state.devices.filter((device) => device.id !== id);
      state.outbox = state.outbox.filter((item) => item.deviceId !== id);
      save();
      for (const ws of sockets.get(id) ?? []) ws.close(1008, "Device revoked");
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "Unknown command" });
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
});
admin.listen(adminPath, () => chmodSync(adminPath, 0o600));
function shutdown() {
  clearInterval(expiryTimer);
  stopMonitor();
  push.stop();
  admin.close();
  for (const clients of sockets.values()) for (const client of clients) client.terminate();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
