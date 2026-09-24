import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

// A peer is another computer's companion. This hub pairs with it like a phone
// would, then proxies the selected host's UI and relays its lifecycle alerts.
export const hostCookieName = "synara-host";
const kinds = new Set(["completed", "failed", "approval", "input"]);

/** Parses a peer's `/mobile#pair=CODE` link from its `cli.mjs pair`. */
export function parsePairingLink(value) {
  const link = new URL(String(value));
  const loopback = ["127.0.0.1", "localhost"].includes(link.hostname);
  if (
    (link.protocol !== "https:" && !(loopback && link.protocol === "http:")) ||
    link.username ||
    link.password ||
    link.pathname !== "/mobile"
  )
    throw new Error("Use the peer's https://…/mobile#pair=… link.");
  const code = new URLSearchParams(link.hash.slice(1)).get("pair");
  if (!code || code.length > 128) throw new Error("The pairing link has no code.");
  return { origin: link.origin, code };
}

async function requestSession(origin, path, input, name, fetch) {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ ...input, name: `Hub ${hostname()}`.slice(0, 80) }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Peer refused pairing (${response.status}).`);
  const token = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .find((entry) => entry.startsWith("synara-mobile="))
    ?.slice("synara-mobile=".length);
  if (!token) throw new Error("Peer did not return a session.");
  return { id: randomUUID(), name: String(name).trim().slice(0, 40) || origin, origin, token };
}

export function pairWithPeer(link, name, { fetch = globalThis.fetch } = {}) {
  const { origin, code } = parsePairingLink(link);
  return requestSession(origin, "/mobile/api/pair", { code }, name, fetch);
}

/**
 * Pairs through Tailscale identity instead of a code. The peer calls back
 * `hubOrigin` to confirm the nonce, so only this hub can redeem the request.
 */
export function pairWithTailnetPeer(
  origin,
  hubOrigin,
  nonce,
  name,
  { fetch = globalThis.fetch } = {},
) {
  return requestSession(origin, "/mobile/api/peer-pair", { origin: hubOrigin, nonce }, name, fetch);
}

/** Same-origin relative path only; anything else falls back to the root. */
export function safeTarget(value) {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) && value.length <= 2048
    ? value
    : "/";
}

export function hostUrl(id, to) {
  return `/mobile/host/${encodeURIComponent(id)}?to=${encodeURIComponent(safeTarget(to))}`;
}

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);

/** Validates a relayed peer alert and rewrites it to switch host on open. */
export function peerEvent(peer, raw) {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!event || !kinds.has(event.kind) || typeof event.id !== "string" || event.id.length > 512)
    return null;
  return {
    id: `${peer.id}:${event.id}`,
    kind: event.kind,
    threadId: text(event.threadId, 256) && `${peer.id}:${event.threadId}`,
    title: `${peer.name} · ${text(event.title, 160) ?? "Synara"}`,
    body: text(event.body, 400) ?? "",
    actionTitle: text(event.actionTitle, 40),
    url: hostUrl(peer.id, event.url),
  };
}
