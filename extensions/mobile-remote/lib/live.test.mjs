import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const enabled = process.env.SYNARA_MOBILE_LIVE_TEST === "1";
const execute = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  assert.notEqual(port, 58090, "Never reuse the user instance");
  try {
    const { stdout } = await execute("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    assert.equal(stdout.trim(), "", `Port ${port} must be free on every interface`);
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  return port;
}
function admin(home, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: join(home, "admin.sock"), path, method: "POST" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            assert.equal(res.statusCode, 200);
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("Admin timeout")));
    req.end("{}");
  });
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(force);
}

// Explicit opt-in: metadata mutations are confined to a fresh real Synara home.
// No prompts, provider turns, Web Push subscription, or Tailscale configuration.
test(
  "real isolated Synara supports paired HTTP negotiation and metadata RPC/streams through companion",
  { skip: !enabled, timeout: 45000 },
  async (t) => {
    const repository = fileURLToPath(new URL("../../../", import.meta.url));
    const build = join(repository, "apps/server/dist/index.mjs");
    await stat(build); // Never trigger a workspace build from this opt-in smoke test.
    const directory = await mkdtemp(join(tmpdir(), "synara-mobile-live-"));
    const synaraHome = join(directory, "synara");
    const mobileHome = join(directory, "mobile");
    const workspace = join(directory, "project");
    await mkdir(workspace);
    const children = [];
    let socket;
    t.after(async () => {
      socket?.terminate();
      for (const child of children.toReversed()) await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    });
    const serverPort = await freePort();
    let mobilePort = await freePort();
    while (mobilePort === serverPort) mobilePort = await freePort();
    const authToken = "a".repeat(48);
    // An allowlisted environment prevents inherited auth/dev URLs/state from reaching these instances.
    const environment = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      SYNARA_NO_BROWSER: "1",
    };
    function launch(path, args, env) {
      const child = spawn(process.execPath, [path, ...args], {
        cwd: workspace,
        env: { ...environment, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      child.output = "";
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (data) => {
          child.output = (child.output + data).slice(-6000);
        });
      return child;
    }
    const synara = launch(
      build,
      [
        "--home-dir",
        synaraHome,
        "--host",
        "127.0.0.1",
        "--port",
        String(serverPort),
        "--no-browser",
      ],
      {
        SYNARA_AUTH_TOKEN: authToken,
        SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      },
    );
    const upstream = `http://127.0.0.1:${serverPort}`;
    const negotiateQuery =
      "?x-synara-client-build=mobile-live-test&x-synara-protocol-epoch=1&x-synara-protocol-min-revision=1&x-synara-protocol-max-revision=1";
    await waitFor(async () => {
      if (synara.exitCode !== null) throw new Error(synara.output);
      try {
        return (
          await fetch(upstream + "/ws/negotiate" + negotiateQuery, {
            signal: AbortSignal.timeout(500),
          })
        ).ok;
      } catch {
        return false;
      }
    }, "real Synara startup");
    const publicOrigin = "https://mobile.test:8443";
    const companion = launch(fileURLToPath(new URL("../server.mjs", import.meta.url)), [], {
      SYNARA_MOBILE_HOME: mobileHome,
      SYNARA_MOBILE_PORT: String(mobilePort),
      SYNARA_MOBILE_ORIGIN: publicOrigin,
      SYNARA_MOBILE_UPSTREAM: upstream,
      SYNARA_MOBILE_UPSTREAM_TOKEN: authToken,
    });
    await waitFor(async () => {
      if (companion.exitCode !== null) throw new Error(companion.output);
      try {
        await stat(join(mobileHome, "admin.sock"));
        return true;
      } catch {
        return false;
      }
    }, "companion startup");
    const { url } = await admin(mobileHome, "/pair");
    const code = new URLSearchParams(new URL(url).hash.slice(1)).get("pair");
    const base = `http://127.0.0.1:${mobilePort}`;
    const paired = await fetch(base + "/mobile/api/pair", {
      method: "POST",
      headers: { Origin: publicOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "Isolated live test" }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie").split(";")[0];
    const response = await fetch(base + "/ws/negotiate" + negotiateQuery, {
      headers: { Cookie: cookie, Origin: publicOrigin },
    });
    assert.equal(response.status, 200);
    const negotiation = await response.json();
    assert.equal(negotiation.protocolEpoch, 1);
    const wsUrl = new URL("/ws", base.replace("http:", "ws:"));
    for (const [key, value] of Object.entries({
      "client-build": "mobile-live-test",
      "protocol-epoch": "1",
      "protocol-revision": negotiation.negotiatedRevision,
      "server-instance": negotiation.serverInstanceId,
    }))
      wsUrl.searchParams.set(`x-synara-${key}`, value);
    socket = new WebSocket(wsUrl, {
      headers: { Cookie: cookie, Origin: publicOrigin, Host: new URL(publicOrigin).host },
    });
    const pending = new Map(),
      shell = [];
    let id = 0;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw);
      if (frame._tag === "Chunk" && frame.requestId === "0") {
        shell.push(...frame.values);
        socket.send(JSON.stringify({ _tag: "Ack", requestId: "0" }));
      } else if (frame._tag === "Exit") {
        const request = pending.get(frame.requestId);
        if (request) {
          pending.delete(frame.requestId);
          clearTimeout(request.timer);
          frame.exit._tag === "Success"
            ? request.resolve(frame.exit.value)
            : request.reject(new Error(JSON.stringify(frame.exit)));
        }
      }
    });
    socket.on("close", () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("RPC socket closed"));
      }
      pending.clear();
    });
    await once(socket, "open");
    function rpc(tag, payload = {}) {
      const requestId = String(++id);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`RPC timeout: ${tag}`));
        }, 10000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
      });
    }
    const dispatch = (command) =>
      rpc("orchestration.dispatchCommand", { commandId: randomUUID(), ...command });
    socket.send(
      JSON.stringify({
        _tag: "Request",
        id: "0",
        tag: "orchestration.subscribeShell",
        payload: {},
        headers: [],
      }),
    );
    await waitFor(() => shell.some((item) => item.kind === "snapshot"), "initial shell");
    const initial = await rpc("orchestration.getSnapshot");
    assert.equal(
      initial.threads.length,
      0,
      "Fresh isolated database must have no user conversations",
    );
    const projectId = randomUUID(),
      threadId = randomUUID(),
      createdAt = new Date().toISOString();
    await dispatch({
      type: "project.create",
      projectId,
      title: "Mobile live fixture",
      workspaceRoot: workspace,
      createdAt,
    });
    await dispatch({
      type: "thread.create",
      projectId,
      threadId,
      title: "Before rename",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    await waitFor(
      () => shell.some((item) => item.kind === "thread-upserted" && item.thread.id === threadId),
      "created thread stream",
    );
    let snapshot = await rpc("orchestration.getSnapshot");
    const created = snapshot.threads.find((thread) => thread.id === threadId);
    assert.equal(created.title, "Before rename");
    assert.equal(created.session, null);
    assert.equal(created.latestTurn, null);
    const upload = await fetch(
      `${base}/api/attachments/upload?${new URLSearchParams({
        threadId,
        type: "image",
        name: "mobile.png",
        mimeType: "image/png",
      })}`,
      {
        method: "POST",
        headers: { Cookie: cookie, Origin: publicOrigin },
        body: Buffer.from("89504e470d0a1a0a", "hex"),
      },
    );
    const uploadBody = await upload.text();
    assert.equal(upload.status, 201, uploadBody);
    const uploadedAttachment = JSON.parse(uploadBody);
    assert.match(uploadedAttachment.id, /^att_v2_/);

    const localPreviewPath = join(workspace, "mobile-preview.png");
    const localPreviewBytes = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(localPreviewPath, localPreviewBytes);
    const preview = await fetch(
      `${base}/api/local-image?${new URLSearchParams({ path: localPreviewPath, cwd: workspace })}`,
      { headers: { Cookie: cookie } },
    );
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    assert.equal(preview.status, 200, previewBytes.toString("utf8"));
    assert.deepEqual(previewBytes, localPreviewBytes);

    const cancelled = await fetch(`${base}/api/attachments/cancel`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ attachmentId: uploadedAttachment.id }),
    });
    assert.equal(cancelled.status, 200, await cancelled.text());
    await dispatch({ type: "thread.meta.update", threadId, title: "Renamed over mobile proxy" });
    await waitFor(
      () =>
        shell.some(
          (item) =>
            item.kind === "thread-upserted" &&
            item.thread.id === threadId &&
            item.thread.title === "Renamed over mobile proxy",
        ),
      "renamed thread stream",
    );
    await dispatch({ type: "thread.archive", threadId });
    await waitFor(
      () =>
        shell.some(
          (item) =>
            item.kind === "thread-upserted" &&
            item.thread.id === threadId &&
            item.thread.archivedAt,
        ),
      "archived thread stream",
    );
    snapshot = await rpc("orchestration.getSnapshot");
    const archived = snapshot.threads.find((thread) => thread.id === threadId);
    assert.equal(archived.title, "Renamed over mobile proxy");
    assert.ok(archived.archivedAt);
    assert.equal(archived.session?.providerName ?? null, null);
    assert.equal(archived.session?.activeTurnId ?? null, null);
    assert.ok(archived.session === null || archived.session.status === "stopped");
    assert.equal(archived.latestTurn, null);
    const state = JSON.parse(await readFile(join(mobileHome, "state.json"), "utf8"));
    assert.equal(state.devices[0].subscription, undefined);
    assert.deepEqual(state.outbox, []);
    t.diagnostic(
      "Real isolated server: paired → negotiated → shell streamed → project/thread created → authenticated upload and local preview → renamed → archived; no provider turn or push subscription.",
    );
  },
);
