import test from "node:test";
import assert from "node:assert/strict";
import { hostUrl, pairWithPeer, parsePairingLink, peerEvent, safeTarget } from "./peers.mjs";

test("peer pairing links must be HTTPS companion links", () => {
  assert.deepEqual(parsePairingLink("https://pc.tail.ts.net:8443/mobile#pair=abc"), {
    origin: "https://pc.tail.ts.net:8443",
    code: "abc",
  });
  for (const link of [
    "http://pc.tail.ts.net:8443/mobile#pair=abc",
    "https://pc.tail.ts.net:8443/other#pair=abc",
    "https://pc.tail.ts.net:8443/mobile",
    "https://u:p@pc.tail.ts.net:8443/mobile#pair=abc",
  ])
    assert.throws(() => parsePairingLink(link), link);
});

test("host switches only redirect to same-origin paths", () => {
  for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "", undefined])
    assert.equal(safeTarget(bad), "/");
  assert.equal(hostUrl("abc", "/t%201"), "/mobile/host/abc?to=%2Ft%25201");
});

test("peer alerts are validated, prefixed and routed through the host switch", () => {
  const peer = { id: "p1", name: "Windows" };
  assert.equal(peerEvent(peer, "nope"), null);
  assert.equal(peerEvent(peer, JSON.stringify({ id: "x", kind: "test" })), null);
  const event = peerEvent(
    peer,
    JSON.stringify({ id: "e", kind: "approval", threadId: "t", title: "Fix", url: "//evil" }),
  );
  assert.equal(event.id, "p1:e");
  assert.equal(event.threadId, "p1:t");
  assert.equal(event.title, "Windows · Fix");
  assert.equal(event.url, "/mobile/host/p1?to=%2F");
});

test("pairing with a peer keeps only its session cookie", async () => {
  const calls = [];
  const peer = await pairWithPeer("https://pc.test:8443/mobile#pair=code", "Windows", {
    fetch: async (url, options) => {
      calls.push([String(url), options.headers.Origin, JSON.parse(options.body).code]);
      return new Response("{}", {
        headers: { "Set-Cookie": "synara-mobile=tok; Path=/; HttpOnly" },
      });
    },
  });
  assert.deepEqual(calls, [
    ["https://pc.test:8443/mobile/api/pair", "https://pc.test:8443", "code"],
  ]);
  assert.equal(peer.token, "tok");
  assert.equal(peer.origin, "https://pc.test:8443");
  assert.equal(peer.name, "Windows");
});
