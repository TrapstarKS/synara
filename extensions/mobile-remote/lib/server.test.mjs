import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { validatePreferences, validateSubscription } from "./store.mjs";

test("preferences and outbound push URLs reject untrusted payloads", () => {
  assert.throws(() => validatePreferences({ completed: true }));
  assert.throws(() =>
    validatePreferences({
      completed: true,
      failed: true,
      approval: true,
      input: true,
      extra: true,
    }),
  );
  const keys = { p256dh: "A".repeat(87), auth: "A".repeat(22) };
  for (const endpoint of [
    "http://web.push.apple.com/x",
    "https://127.0.0.1/x",
    "https://web.push.apple.com.evil.test/x",
    "https://web.push.apple.com:444/x",
    "https://user@web.push.apple.com/x",
  ]) {
    assert.throws(() => validateSubscription({ endpoint, keys }));
  }
  assert.equal(
    validateSubscription({ endpoint: "https://web.push.apple.com/test", keys }).endpoint,
    "https://web.push.apple.com/test",
  );
});

test(
  "pairing is one-use; proxy and mutations require a live device; logout cuts its websocket",
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "synara-mobile-test-"));
    const upstream = http.createServer((req, res) => {
      if (req.url.startsWith("/ws/negotiate")) {
        res.writeHead(503);
        res.end();
        return;
      }
      if (req.url === "/headers") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.headers));
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end("<html><head></head><body>Synara fixture</body></html>");
    });
    const wsServer = new WebSocketServer({ noServer: true });
    let releaseUpgrade;
    let handshakeSeen;
    const upgradeUrls = [];
    upstream.on("upgrade", (req, socket, head) => {
      upgradeUrls.push(req.url);
      const accept = () =>
        wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit("connection", ws));
      if (req.url.includes("delay")) {
        releaseUpgrade = accept;
        handshakeSeen?.();
      } else accept();
    });
    wsServer.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const reservation = http.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    const origin = "https://mobile.test:8443";
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../server.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          SYNARA_MOBILE_HOME: directory,
          SYNARA_MOBILE_ORIGIN: origin,
          SYNARA_MOBILE_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
          SYNARA_MOBILE_UPSTREAM_TOKEN: "desktop-secret",
          SYNARA_MOBILE_PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    t.after(async () => {
      child.kill("SIGTERM");
      if (child.exitCode === null) await once(child, "exit");
      for (const ws of wsServer.clients) ws.terminate();
      wsServer.close();
      await new Promise((r) => upstream.close(r));
      await rm(directory, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) assert.fail(output);
      try {
        await stat(join(directory, "admin.sock"));
        ready = (await fetch(base + "/mobile/api/status")).ok;
        if (ready) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(ready, true, output);
    assert.equal((await fetch(base + "/", { redirect: "manual" })).status, 302);
    assert.equal(
      (await fetch(base + "/api/private", { method: "POST", headers: { Origin: origin } })).status,
      401,
    );
    assert.equal((await fetch(base + "/mobile")).status, 200);
    assert.equal(
      (await fetch(base + "/mobile/icon.svg", { headers: { Origin: base } })).status,
      200,
    );
    function admin(path, method = "POST", data = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          { socketPath: join(directory, "admin.sock"), path, method },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve(JSON.parse(body)));
          },
        );
        req.on("error", reject);
        req.end(method === "GET" ? undefined : JSON.stringify(data));
      });
    }
    const { url } = await admin("/pair");
    const code = new URLSearchParams(new URL(url).hash.slice(1)).get("pair");
    const post = (path, data, cookie, requestOrigin = origin) =>
      fetch(base + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: requestOrigin,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(data),
      });
    assert.equal((await post("/mobile/api/pair", { code }, null, "https://evil.test")).status, 403);
    const paired = await post("/mobile/api/pair", { code, name: "Test phone" });
    assert.equal(paired.status, 200);
    const rawCookie = paired.headers.get("set-cookie");
    assert.match(rawCookie, /HttpOnly; Secure; SameSite=Strict/);
    const cookie = rawCookie.split(";")[0];
    assert.equal((await post("/mobile/api/pair", { code })).status, 401);
    const status = await (
      await fetch(base + "/mobile/api/status", { headers: { Cookie: cookie } })
    ).json();
    assert.equal(status.paired, true);
    assert.equal(status.name, "Test phone");
    const preferences = { completed: false, failed: true, approval: true, input: false };
    assert.equal((await post("/mobile/api/preferences", preferences, cookie)).status, 200);
    const saved = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    assert.deepEqual(saved.devices[0].preferences, preferences);
    assert.equal((await stat(join(directory, "state.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "admin.sock"))).mode & 0o777, 0o600);
    const proxied = await fetch(base + "/", { headers: { Cookie: cookie } });
    assert.equal(proxied.status, 200);
    assert.match(await proxied.text(), /mobile\/manifest.webmanifest/);
    const headers = await (
      await fetch(base + "/headers", {
        headers: { Cookie: cookie + "; synara-session=target", Origin: origin },
      })
    ).json();
    assert.equal(headers.cookie, "synara-session=target");
    assert.equal(headers.origin, `http://127.0.0.1:${upstream.address().port}`);
    assert.equal(
      (await post("/mobile/api/subscribe", { endpoint: "https://localhost/push" }, cookie)).status,
      400,
    );
    assert.equal((await post("/mobile/api/test", {}, cookie)).status, 409);
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", {
      headers: { Cookie: cookie, Origin: origin, Host: "mobile.test:8443" },
    });
    await once(ws, "open");
    const echoed = once(ws, "message");
    ws.send("hello");
    assert.equal(String((await echoed)[0]), "hello");
    assert.equal(
      new URL(upgradeUrls.at(-1), "http://local").searchParams.get("token"),
      "desktop-secret",
    );
    const closed = once(ws, "close");
    assert.equal((await post("/mobile/api/logout", {}, cookie)).status, 200);
    await closed;
    assert.equal(
      (await (await fetch(base + "/mobile/api/status", { headers: { Cookie: cookie } })).json())
        .paired,
      false,
    );
    assert.equal((await admin("/devices", "GET")).devices.length, 0);
    const nextPair = await admin("/pair");
    const nextCode = new URLSearchParams(new URL(nextPair.url).hash.slice(1)).get("pair");
    const nextResponse = await post("/mobile/api/pair", {
      code: nextCode,
      name: "Pending handshake",
    });
    const nextCookie = nextResponse.headers.get("set-cookie").split(";")[0];
    const enteredHandshake = new Promise((r) => {
      handshakeSeen = r;
    });
    const pending = new WebSocket(base.replace("http:", "ws:") + "/ws?delay", {
      headers: { Cookie: nextCookie, Origin: origin, Host: "mobile.test:8443" },
    });
    pending.on("error", () => {});
    const rejected = new Promise((resolve) =>
      pending.on("unexpected-response", (_req, response) => {
        response.resume();
        pending.terminate();
        resolve(response.statusCode);
      }),
    );
    await enteredHandshake;
    const [{ id: nextId }] = (await admin("/devices", "GET")).devices;
    await admin("/revoke", "POST", { id: nextId });
    releaseUpgrade();
    assert.equal(await rejected, 403, "revocation wins over an in-flight upstream handshake");
  },
);
