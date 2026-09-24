import http from "node:http";
import https from "node:https";
import { readFileSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, hostname } from "node:os";
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
import { adminAddress } from "./lib/admin.mjs";
import { acquireProcessLock } from "./lib/process-lock.mjs";
import {
  hostCookieName,
  hostUrl,
  pairWithPeer,
  pairWithTailnetPeer,
  peerEvent,
  safeTarget,
} from "./lib/peers.mjs";
import { ensureServe, tailnetStatus } from "./lib/tailscale.mjs";

const root = dirname(fileURLToPath(import.meta.url));
// Without an explicit origin, serve this computer's own MagicDNS name on :8443.
const automaticOrigin = !process.env.SYNARA_MOBILE_ORIGIN;
const startupTailnet = automaticOrigin
  ? await tailnetStatus().catch((error) => {
      console.error(`Tailscale unavailable: ${error.message}`);
      return null;
    })
  : null;
const publicUrl = new URL(
  process.env.SYNARA_MOBILE_ORIGIN ??
    (startupTailnet ? `https://${startupTailnet.dnsName}:8443` : "https://localhost:8443"),
);
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
const processLock = acquireProcessLock(lock, { entryPath: fileURLToPath(import.meta.url) });
process.on("exit", processLock.release);
const { state, save } = store;
state.peers ??= [];
const localName = (process.env.SYNARA_MOBILE_NAME || startupTailnet?.name || hostname()).slice(
  0,
  40,
);
if (process.platform === "win32") state.adminToken ??= secret();
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
const eventClients = new Set();
const stopMonitor = watchSynara({
  resolveUpstream: () => upstreamResolver.resolve(),
  scope: configuredUpstream ? new URL(configuredUpstream).origin : "synara-desktop",
  onDisconnect: () => upstreamResolver.invalidate(),
  checkpoint: state.checkpoint,
  saveCheckpoint(checkpoint) {
    state.checkpoint = checkpoint;
    save();
  },
  onEvent: (event) => {
    // With peers configured, a local alert must also switch the phone back here.
    push.enqueue(state.peers.length ? { ...event, url: hostUrl("local", event.url) } : event);
    const message = JSON.stringify(event);
    for (const client of eventClients)
      if (client.readyState === WebSocket.OPEN) client.send(message);
  },
  onStatus: (status) => {
    monitor = status;
  },
});

const cookieName = "synara-mobile";
function readCookie(req, name) {
  return req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1);
}
function selectedPeer(req) {
  const id = readCookie(req, hostCookieName);
  return id && state.peers.find((peer) => peer.id === id);
}
function deviceFor(req) {
  const token = readCookie(req, cookieName);
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
const pendingNonces = new Set();
function limited(req) {
  const key = req.headers["tailscale-user-login"] ?? req.socket.remoteAddress;
  const current = attempts.get(key) ?? { count: 0, until: Date.now() + 60_000 };
  if (current.until < Date.now()) {
    current.count = 0;
    current.until = Date.now() + 60_000;
  }
  attempts.set(key, current);
  return ++current.count > 10;
}
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
  "/mobile/app-icon.svg": ["app-icon.svg", "image/svg+xml"],
  "/mobile/icon-192.png": ["icon-192.png", "image/png"],
  "/mobile/icon-512.png": ["icon-512.png", "image/png"],
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
      .filter((s) => ![cookieName, hostCookieName].some((name) => s.trim().startsWith(name + "=")))
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
      '<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="2"><title>Synara</title><style>html{color-scheme:light dark;font:16px system-ui}body{display:grid;min-height:90vh;place-items:center;margin:0;background:#101010;color:#ededed}main{max-width:28rem;padding:2rem;text-align:center}p{color:#a1a1a1}</style><main><h1>Synara está iniciando</h1><p>Abra o Synara no computador. Esta tela reconecta automaticamente.</p></main></html>',
    );
  }
  return json(res, 503, { error: "Synara desktop is not running" }, { "Retry-After": "2" });
}
function peerHeaders(req, peer) {
  const headers = proxyHeaders(req, peer);
  headers.cookie = [headers.cookie, `${cookieName}=${peer.token}`].filter(Boolean).join("; ");
  return headers;
}
// The peer companion already injects the mobile shell into its HTML.
function proxyPeer(req, res, peer) {
  const targetUrl = new URL(req.url, peer.origin);
  const target = (targetUrl.protocol === "https:" ? https : http).request(
    targetUrl,
    { method: req.method, headers: peerHeaders(req, peer) },
    (response) => {
      res.writeHead(response.statusCode, { ...response.headers, "cache-control": "no-store" });
      response.pipe(res);
    },
  );
  target.on("error", () => {
    if (!res.headersSent) offline(req, res);
    else res.destroy();
  });
  target.setTimeout(120_000, () => target.destroy());
  req.on("aborted", () => target.destroy());
  req.pipe(target);
}
async function proxy(req, res) {
  const peer = selectedPeer(req);
  if (peer) return proxyPeer(req, res, peer);
  let targetConfig;
  try {
    targetConfig = await upstreamResolver.resolve();
  } catch {
    return offline(req, res);
  }
  const upstream = new URL(targetConfig.origin);
  const requestUrl = new URL(req.url, "http://mobile.invalid");
  const targetUrl = new URL(upstream);
  targetUrl.pathname = requestUrl.pathname;
  targetUrl.search = requestUrl.search;
  // The browser only knows the companion's device cookie. Keep the desktop
  // startup token on this loopback hop so authenticated HTTP routes (uploads,
  // attachments and local previews) receive the same credential as the WS.
  if (targetConfig.token) targetUrl.searchParams.set("token", targetConfig.token);
  const target = http.request(
    targetUrl,
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
            '<link rel="manifest" href="/mobile/manifest.webmanifest"><link rel="apple-touch-icon" href="/mobile/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="synara-mobile-remote" content="true"><script defer src="/mobile/theme.js"></script><script defer src="/mobile/install.js"></script></head>',
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
      json(res, 502, { error: "Synara is offline. Start it on the computer and retry." });
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
      if (limited(req)) return json(res, 429, { error: "Espere um minuto e tente novamente." });
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
    if (url.pathname === "/mobile/api/peer-verify" && req.method === "POST") {
      const { nonce } = await body(req);
      return json(res, pendingNonces.delete(nonce) ? 200 : 404, {});
    }
    if (url.pathname === "/mobile/api/peer-pair" && req.method === "POST") {
      if (limited(req)) return json(res, 429, { error: "Try again in a minute." });
      const input = await body(req);
      const hub = new URL(input.origin);
      const tailnet = await tailnetStatus();
      // Same Tailscale owner, a computer on this tailnet, and the hub itself
      // confirms the nonce over its own HTTPS name.
      if (
        !tailnet.login ||
        req.headers["tailscale-user-login"] !== tailnet.login ||
        hub.protocol !== "https:" ||
        hub.pathname !== "/" ||
        !tailnet.computers.some((computer) => computer.dnsName === hub.hostname) ||
        typeof input.nonce !== "string" ||
        input.nonce.length > 128
      )
        return json(res, 403, { error: "Not a computer of this Tailscale owner." });
      const verified = await fetch(new URL("/mobile/api/peer-verify", hub.origin), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: hub.origin },
        body: JSON.stringify({ nonce: input.nonce }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!verified.ok) return json(res, 403, { error: "Hub did not confirm the request." });
      const token = secret();
      state.devices = state.devices.filter((entry) => entry.hubOrigin !== hub.origin);
      state.devices.push({
        id: randomUUID(),
        tokenHash: hash(token),
        name: String(input.name || "Hub").slice(0, 80),
        hubOrigin: hub.origin,
        expiresAt: Date.now() + 90 * 86400_000,
        preferences: { ...defaults },
      });
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
              host: selectedPeer(req)?.id ?? "local",
              hosts: [
                { id: "local", name: localName, online: monitor.state === "connected" },
                ...state.peers.map((peer) => ({
                  id: peer.id,
                  name: peer.name,
                  online: Boolean(peerLinks.get(peer.id)?.online),
                  error: peerLinks.get(peer.id)?.error,
                })),
              ],
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
    const hostMatch = /^\/mobile\/host\/([\w-]{1,64})$/.exec(url.pathname);
    if (hostMatch && req.method === "GET") {
      const id = hostMatch[1];
      if (id !== "local" && !state.peers.some((peer) => peer.id === id))
        return json(res, 404, { error: "Computador não encontrado." });
      res.writeHead(302, {
        Location: safeTarget(url.searchParams.get("to")),
        "Cache-Control": "no-store",
        "Set-Cookie": `${hostCookieName}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${id === "local" ? 0 : 400 * 86400}`,
      });
      return res.end();
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
  const events = req.url === "/mobile/events";
  if (
    req.headers.host !== publicUrl.host ||
    !safeOrigin(req) ||
    !device ||
    !(events || req.url.startsWith("/ws"))
  ) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  if (events) {
    // A hub companion paired as a device relays these alerts to its phones.
    wss.handleUpgrade(req, socket, head, (client) => {
      const set = sockets.get(device.id) ?? new Set();
      set.add(client);
      sockets.set(device.id, set);
      eventClients.add(client);
      client.on("error", () => client.terminate());
      client.on("close", () => {
        eventClients.delete(client);
        set.delete(client);
        if (!set.size) sockets.delete(device.id);
      });
    });
    return;
  }
  const peer = selectedPeer(req);
  let targetUrl, headers;
  if (peer) {
    targetUrl = new URL(req.url, peer.origin);
    targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
    headers = peerHeaders(req, peer);
  } else {
    let targetConfig;
    try {
      targetConfig = await upstreamResolver.resolve();
    } catch {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    targetUrl = new URL(req.url, targetConfig.origin);
    targetUrl.protocol = "ws:";
    if (targetConfig.token) targetUrl.searchParams.set("token", targetConfig.token);
    headers = proxyHeaders(req, targetConfig);
  }
  const target = new WebSocket(targetUrl, {
    headers,
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
const peerLinks = new Map();
function watchPeer(peer) {
  const link = { online: false, stopped: false };
  peerLinks.set(peer.id, link);
  const connect = () => {
    if (link.stopped) return;
    const url = new URL("/mobile/events", peer.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {
      headers: { origin: peer.origin, cookie: `${cookieName}=${peer.token}` },
      handshakeTimeout: 10_000,
      maxPayload: 64 * 1024,
    });
    link.ws = ws;
    let ping;
    // ponytail: alerts raised while this link is down are not replayed.
    const retry = () => {
      clearInterval(ping);
      link.online = false;
      if (link.stopped || link.timer) return;
      link.timer = setTimeout(() => {
        link.timer = undefined;
        connect();
      }, 5000);
    };
    ws.on("open", () => {
      link.online = true;
      delete link.error;
      ping = setInterval(() => ws.ping(), 30_000);
    });
    ws.on("message", (data) => {
      const event = peerEvent(peer, String(data));
      if (event) push.enqueue(event);
    });
    ws.on("unexpected-response", (request, response) => {
      link.unauthorized = [401, 403].includes(response.statusCode);
      link.error =
        response.statusCode === 403
          ? "Pareie este computador de novo."
          : `HTTP ${response.statusCode}`;
      response.resume();
      request.destroy();
      retry();
    });
    ws.on("error", retry);
    ws.on("close", retry);
  };
  connect();
}
function upsertPeer(paired) {
  // Re-pairing the same computer keeps its id, so phones stay on it.
  const existing = state.peers.find((peer) => peer.origin === paired.origin);
  if (existing) stopPeer(existing.id);
  const peer = existing
    ? Object.assign(existing, { name: paired.name, token: paired.token })
    : paired;
  if (!existing) state.peers.push(peer);
  save();
  watchPeer(peer);
  return peer;
}
const discoveryBackoff = new Map();
async function discoverPeers() {
  let tailnet;
  try {
    tailnet = await tailnetStatus();
  } catch {
    return;
  }
  for (const computer of tailnet.computers) {
    const origin = `https://${computer.dnsName}:${publicUrl.port || 443}`;
    const known = state.peers.find((peer) => peer.origin === origin);
    if (known && !peerLinks.get(known.id)?.unauthorized) continue;
    if ((discoveryBackoff.get(origin) ?? 0) > Date.now()) continue;
    discoveryBackoff.set(origin, Date.now() + 10 * 60_000);
    const nonce = secret();
    pendingNonces.add(nonce);
    try {
      upsertPeer(await pairWithTailnetPeer(origin, publicUrl.origin, nonce, computer.name));
      discoveryBackoff.delete(origin);
    } catch {
      // No companion there yet, or an older one; retry after the backoff.
    } finally {
      pendingNonces.delete(nonce);
    }
  }
}
function stopPeer(id) {
  const link = peerLinks.get(id);
  if (!link) return;
  link.stopped = true;
  clearTimeout(link.timer);
  link.ws?.terminate();
  peerLinks.delete(id);
}
for (const peer of state.peers) watchPeer(peer);
// Discovery only makes sense on a real tailnet name, never in local fixtures.
const discoveryTimer = publicUrl.hostname.endsWith(".ts.net")
  ? setInterval(() => void discoverPeers(), 60_000)
  : undefined;
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
  if (automaticOrigin && startupTailnet)
    ensureServe(port, publicUrl.port || "443")
      .then((result) => {
        if (result === "occupied")
          console.error(`Tailscale HTTPS ${publicUrl.port} is used by another service.`);
      })
      .catch((error) => console.error(`Tailscale Serve failed: ${error.message}`));
  if (discoveryTimer) void discoverPeers();
});
// Windows named pipes additionally require a credential held in the private store.
const adminPath = adminAddress(directory);
if (process.platform !== "win32") {
  try {
    unlinkSync(adminPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const admin = http.createServer(async (req, res) => {
  try {
    if (
      process.platform === "win32" &&
      hash(req.headers.authorization ?? "") !== hash(`Bearer ${state.adminToken}`)
    )
      return json(res, 403, { error: "Local administration credential required" });
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
    if (req.method === "GET" && req.url === "/peers")
      return json(res, 200, {
        peers: state.peers.map(({ id, name, origin }) => ({
          id,
          name,
          origin,
          online: Boolean(peerLinks.get(id)?.online),
        })),
      });
    if (req.method === "POST" && req.url === "/peers") {
      const input = await body(req);
      const paired = await pairWithPeer(input.link, input.name);
      if (paired.origin === publicUrl.origin) throw new Error("This is the hub itself.");
      const peer = upsertPeer(paired);
      return json(res, 200, { id: peer.id, name: peer.name, origin: peer.origin });
    }
    if (req.method === "POST" && req.url === "/peers/remove") {
      const { id } = await body(req);
      stopPeer(id);
      state.peers = state.peers.filter((peer) => peer.id !== id);
      save();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "Unknown command" });
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
});
admin.listen(adminPath, () => {
  if (process.platform !== "win32") chmodSync(adminPath, 0o600);
});
function shutdown() {
  clearInterval(expiryTimer);
  clearInterval(discoveryTimer);
  stopMonitor();
  for (const id of peerLinks.keys()) stopPeer(id);
  push.stop();
  admin.close();
  for (const clients of sockets.values()) for (const client of clients) client.terminate();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
// When the desktop app owns this process, its exit closes our stdin.
if (process.env.SYNARA_MOBILE_PARENT_STDIN === "1") {
  process.stdin.on("end", shutdown);
  process.stdin.resume();
}
process.on("SIGINT", shutdown);
