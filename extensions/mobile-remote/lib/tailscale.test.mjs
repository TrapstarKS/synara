import test from "node:test";
import assert from "node:assert/strict";
import { ensureServe, parseStatus } from "./tailscale.mjs";

test("only the owner's online computers are discovery candidates", () => {
  const status = {
    Self: { DNSName: "mac.tail.ts.net.", HostName: "mac", UserID: 1 },
    User: { 1: { LoginName: "me@example.com" } },
    Peer: {
      a: { Online: true, UserID: 1, OS: "windows", HostName: "PC", DNSName: "pc.tail.ts.net." },
      b: { Online: true, UserID: 1, OS: "iOS", HostName: "phone", DNSName: "p.tail.ts.net." },
      c: { Online: false, UserID: 1, OS: "linux", HostName: "off", DNSName: "o.tail.ts.net." },
      d: { Online: true, UserID: 2, OS: "macOS", HostName: "other", DNSName: "x.tail.ts.net." },
    },
  };
  assert.deepEqual(parseStatus(status), {
    dnsName: "mac.tail.ts.net",
    name: "mac",
    login: "me@example.com",
    computers: [{ name: "PC", dnsName: "pc.tail.ts.net" }],
  });
  assert.throws(() => parseStatus({}));
});

test("serve is added only when the HTTPS port is free", async () => {
  const fake = (serveStatus) => {
    const calls = [];
    const run = (_command, args, _options, done) => {
      calls.push(args.join(" "));
      done(null, args.includes("status") ? JSON.stringify(serveStatus) : "");
    };
    return { calls, run };
  };
  const free = fake({});
  assert.equal(await ensureServe(58091, "8443", free.run), "configured");
  assert.deepEqual(free.calls.at(-1), "serve --bg --https=8443 http://127.0.0.1:58091");
  const ours = fake({
    TCP: { 8443: { HTTPS: true } },
    Web: { "m.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:58091" } } } },
  });
  assert.equal(await ensureServe(58091, "8443", ours.run), "ready");
  const other = fake({ TCP: { 8443: { HTTPS: true } }, Web: {} });
  assert.equal(await ensureServe(58091, "8443", other.run), "occupied");
  assert.equal(other.calls.length, 1);
});
