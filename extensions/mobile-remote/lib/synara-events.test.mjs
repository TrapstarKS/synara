import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createShellMonitor, watchSynara } from "./synara-events.mjs";

const time = "2026-09-07T15:00:00.000Z";
const thread = (state = "running", extra = {}) => ({
  id: "thread-a",
  title: "Ajustar notificações",
  messages: [{ role: "user", text: "PRIVATE PROMPT" }],
  updatedAt: time,
  latestTurn: { turnId: "turn-a", state },
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...extra,
});
const snapshot = (...threads) => ({ kind: "snapshot", snapshot: { threads } });
const upsert = (value) => ({ kind: "thread-upserted", thread: value });
const wait = async (predicate) => {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out");
};

test("subagent lifecycle stays silent while main and forked conversations still notify", async (t) => {
  const events = [];
  const monitor = createShellMonitor({ completionDelayMs: 0, onEvent: (event) => events.push(event) });
  t.after(() => monitor.stop());
  const children = [
    { id: "child", parentThreadId: "thread-a" },
    { id: "nested-child", parentThreadId: "child" },
    { id: "native-child", creationSource: "provider_native" },
    { id: "agent-child", subagentAgentId: "agent-1" },
    { id: "subagent:parent:legacy" },
  ];
  const fork = { id: "fork", forkSourceThreadId: "thread-a", parentThreadId: null };
  await monitor.accept(snapshot(thread(), thread("running", fork), ...children.map((extra) => thread("running", extra))));
  for (const state of ["completed", "interrupted", "error"])
    for (const extra of children) await monitor.accept(upsert(thread(state, extra)));
  await monitor.accept(upsert(thread("completed")));
  await monitor.accept(upsert(thread("completed", fork)));
  await wait(() => events.some((event) => event.threadId === "fork"));
  assert.deepEqual(events.map((event) => [event.threadId, event.kind]), [
    ["thread-a", "completed"], ["fork", "completed"],
  ]);
});

test("subagents in old checkpoints do not spam or consume main-task recovery slots", async (t) => {
  const events = [];
  const options = { completionDelayMs: 0, scope: "test", now: () => Date.parse(time),
    onEvent: (event) => events.push(event) };
  const before = createShellMonitor(options);
  const children = Array.from({ length: 30 }, (_, index) => ({ id: `subagent:parent:${index}` }));
  await before.accept(snapshot(...children.map((extra) => thread("running", extra)), thread()));
  const checkpoint = before.checkpoint();
  for (const entry of checkpoint.threads) delete entry.isSubagent;
  before.stop();
  const resumed = createShellMonitor({ ...options, checkpoint });
  t.after(() => resumed.stop());
  await resumed.accept(snapshot(...children.map((extra) => thread("completed", extra)), thread("completed")));
  await wait(() => events.some((event) => event.threadId === "thread-a"));
  assert.deepEqual(events.map((event) => event.threadId), ["thread-a"]);
  assert.equal(resumed.checkpoint().threads.filter((entry) => entry.isSubagent).length, 30);
});

test("late child metadata cancels a pending completion but preserves actionable alerts", async (t) => {
  const events = [];
  const monitor = createShellMonitor({ completionDelayMs: 20, onEvent: (event) => events.push(event) });
  t.after(() => monitor.stop());
  await monitor.accept(snapshot(thread()));
  await monitor.accept(upsert(thread("completed")));
  await monitor.accept(upsert(thread("completed", { parentThreadId: "parent" })));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(events, []);
  await monitor.accept(upsert(thread("error", {
    parentThreadId: "parent", hasPendingApprovals: true, hasPendingUserInput: true,
  })));
  assert.deepEqual(events.map((event) => event.kind), ["approval", "input"]);
});

test("initial history is silent, transitions and prompt-free completion are durable and deduplicated", async () => {
  const events = [];
  let checkpoint;
  const monitor = createShellMonitor({
    completionDelayMs: 0,
    onEvent: async (e) => events.push(e),
    saveCheckpoint: async (c) => {
      checkpoint = c;
    },
  });
  await monitor.accept(snapshot(thread("completed")));
  assert.equal(events.length, 0);
  await monitor.accept(upsert(thread("completed", { id: "previously-untracked" })));
  assert.equal(events.length, 0);
  await monitor.accept(
    upsert(thread("running", { latestTurn: { turnId: "turn-b", state: "running" } })),
  );
  await monitor.accept(
    upsert(
      thread("running", {
        latestTurn: { turnId: "turn-b", state: "running" },
        hasPendingApprovals: true,
      }),
    ),
  );
  await monitor.accept(
    upsert(
      thread("running", {
        latestTurn: { turnId: "turn-b", state: "running" },
        hasPendingApprovals: true,
      }),
    ),
  );
  await monitor.accept(
    upsert(thread("completed", { latestTurn: { turnId: "turn-b", state: "completed" } })),
  );
  await wait(() => events.length === 2);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["approval", "completed"],
  );
  assert.equal(JSON.stringify([events, checkpoint]).includes("PRIVATE PROMPT"), false);
  const resumed = createShellMonitor({ checkpoint, onEvent: async (e) => events.push(e) });
  await resumed.accept(
    snapshot(thread("completed", { latestTurn: { turnId: "turn-b", state: "completed" } })),
  );
  assert.equal(events.length, 2);
});

test("recovery compares known tasks, bounds catch-up, ignores unknown history and respects scope", async () => {
  let checkpoint;
  const events = [];
  const baseline = Array.from({ length: 30 }, (_, i) => thread("running", { id: `t${i}` }));
  const opts = {
    completionDelayMs: 0,
    scope: "local",
    now: () => Date.parse(time),
    onEvent: async (e) => events.push(e),
    saveCheckpoint: async (c) => {
      checkpoint = c;
    },
  };
  await createShellMonitor(opts).accept(snapshot(...baseline));
  const resumed = createShellMonitor({ ...opts, checkpoint });
  const completed = baseline.map((t) => ({
    ...t,
    latestTurn: { turnId: "turn-a", state: "completed" },
  }));
  await resumed.accept(snapshot(...completed, thread("error", { id: "unknown" })));
  await wait(() => events.length === 20);
  assert.equal(events.length, 20);
  await resumed.accept(snapshot(...completed));
  assert.equal(events.length, 20);
  await createShellMonitor({ ...opts, scope: "different", checkpoint }).accept(
    snapshot(thread("error")),
  );
  assert.equal(events.length, 20);
});

test("callback failure leaves checkpoint retryable; input and failed transitions are distinct", async () => {
  let reject = true;
  const events = [];
  const monitor = createShellMonitor({
    onEvent: async (e) => {
      if (reject) throw new Error("storage unavailable");
      events.push(e);
    },
  });
  await monitor.accept(snapshot(thread()));
  await assert.rejects(monitor.accept(upsert(thread("error"))));
  assert.equal(monitor.checkpoint().threads[0].state, "running");
  reject = false;
  await monitor.accept(upsert(thread("error")));
  await monitor.accept(upsert(thread("error", { hasPendingUserInput: true })));
  assert.deepEqual(
    events.map((e) => e.kind),
    ["failed", "input"],
  );
  await assert.rejects(monitor.accept(upsert({ id: "bad" })), /Unsupported/);
});

test("a deferred completion is retried instead of being marked seen", async (t) => {
  const events = [];
  let attempts = 0;
  const monitor = createShellMonitor({
    completionDelayMs: 0,
    onEvent: async (event) => {
      attempts++;
      if (attempts === 1) return false;
      events.push(event);
    },
  });
  t.after(() => monitor.stop());
  await monitor.accept(snapshot(thread()));
  await monitor.accept(upsert(thread("completed")));
  await wait(() => events.length === 1);
  assert.equal(attempts, 2);
  assert.equal(events[0].kind, "completed");
});

test("negotiated Effect socket acknowledges chunks, reconnects, recovers latest change, and stops", async (t) => {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        protocolEpoch: 1,
        negotiatedRevision: 1,
        serverInstanceId: "fake",
        capabilities: ["orchestration.cursor-safe-streams", "rpc.typed-errors"],
      }),
    );
  });
  const sockets = new WebSocketServer({ server });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let connections = 0,
    acknowledgements = 0;
  const events = [],
    statuses = [];
  sockets.on("connection", (ws, req) => {
    connections++;
    assert.equal(new URL(req.url, "http://local").searchParams.get("token"), "desktop-secret");
    assert.equal(
      new URL(req.url, "http://local").searchParams.get("x-synara-server-instance"),
      "fake",
    );
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw);
      if (frame._tag === "Request") {
        if (frame.tag === "orchestration.getThreadDetailSnapshot") {
          ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: {
            _tag: "Success", value: { thread: thread("completed", {
              messages: [{ role: "assistant", turnId: "turn-a", streaming: false,
                text: "Corrigi o filtro dos subagentes. Os testes passaram." }],
            }) },
          } }));
          return;
        }
        assert.equal(frame.tag, "orchestration.subscribeShell");
        const value = thread(connections === 1 ? "running" : "completed", {
          updatedAt: new Date().toISOString(),
        });
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: "1", values: [snapshot(value)] }));
      } else if (frame._tag === "Ack") {
        acknowledgements++;
        if (connections === 1) ws.close();
      } else if (frame._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
    });
  });
  const stop = watchSynara({
    resolveUpstream: () => ({
      origin: `http://127.0.0.1:${server.address().port}`,
      token: "desktop-secret",
    }),
    scope: "desktop",
    completionDelayMs: 0,
    onEvent: async (e) => events.push(e),
    onStatus: (s) => statuses.push(s.state),
  });
  t.after(() => {
    stop();
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.close();
  });
  await wait(() => events.length === 1 && acknowledgements >= 2);
  assert.equal(events[0].kind, "completed");
  assert.equal(events[0].title, "Concluída · Ajustar notificações");
  assert.equal(events[0].body, "Corrigi o filtro dos subagentes. Os testes passaram.");
  assert.ok(statuses.includes("reconnecting"));
  stop();
  const count = connections;
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(connections, count);
});

test("transient completion is cancelled when compaction continues with a new turn", async () => {
  const events = [];
  const monitor = createShellMonitor({
    completionDelayMs: 25,
    onEvent: async (event) => events.push(event),
  });
  await monitor.accept(snapshot(thread("running")));
  await monitor.accept(upsert(thread("completed")));
  await monitor.accept(
    upsert(
      thread("running", {
        latestTurn: { turnId: "turn-b", state: "running" },
        session: { status: "running", activeTurnId: "turn-b" },
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, []);

  await monitor.accept(
    upsert(
      thread("completed", {
        latestTurn: { turnId: "turn-b", state: "completed" },
        session: { status: "ready", activeTurnId: null },
      }),
    ),
  );
  await wait(() => events.length === 1);
  assert.equal(events[0].kind, "completed");
  monitor.stop();
});

test("active goals defer completion until the goal clears", async () => {
  const events = [];
  const monitor = createShellMonitor({
    completionDelayMs: 20,
    onEvent: async (event) => events.push(event),
  });
  await monitor.accept(
    snapshot(
      thread("running", {
        goal: "Finish the complete task",
        goalPausedAt: null,
        session: { status: "running", activeTurnId: "turn-a" },
      }),
    ),
  );
  await monitor.accept(
    upsert(
      thread("completed", {
        goal: "Finish the complete task",
        goalPausedAt: null,
        session: { status: "ready", activeTurnId: null },
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(events, []);

  await monitor.accept(
    upsert(
      thread("completed", {
        goal: "",
        goalPausedAt: null,
        session: { status: "ready", activeTurnId: null },
      }),
    ),
  );
  await wait(() => events.length === 1);
  assert.equal(events[0].kind, "completed");
  monitor.stop();
});

test("pending completions are not checkpointed as delivered and stop cancels them", async () => {
  const events = [];
  const monitor = createShellMonitor({
    completionDelayMs: 25,
    onEvent: async (event) => events.push(event),
  });
  await monitor.accept(snapshot(thread("running")));
  await monitor.accept(upsert(thread("completed")));
  await monitor.accept(upsert(thread("completed")));
  assert.deepEqual(monitor.checkpoint().seen, []);
  monitor.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, []);
});

test("checkpoint retry does not deliver the same completion callback twice", async () => {
  const events = [];
  let failedCompletionCheckpoint = false;
  const monitor = createShellMonitor({
    completionDelayMs: 0,
    onEvent: async (event) => events.push(event),
    saveCheckpoint: async (checkpoint) => {
      if (checkpoint.seen.length > 0 && !failedCompletionCheckpoint) {
        failedCompletionCheckpoint = true;
        throw new Error("temporary checkpoint failure");
      }
    },
  });
  await monitor.accept(snapshot(thread("running")));
  await monitor.accept(upsert(thread("completed")));
  await wait(() => monitor.checkpoint().seen.length === 1);

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "completed");
  monitor.stop();
});

test("incompatible negotiation never opens a feature socket", async (t) => {
  let requests = 0;
  const statuses = [];
  const server = createServer((_req, res) => {
    requests++;
    res.end(JSON.stringify({ protocolEpoch: 2 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const stop = watchSynara({
    upstream: `http://127.0.0.1:${server.address().port}`,
    onEvent: async () => assert.fail(),
    onStatus: (s) => statuses.push(s.state),
  });
  t.after(() => {
    stop();
    server.close();
  });
  await wait(() => statuses.includes("incompatible"));
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(requests, 1);
});

test("missing Effect Pong terminates a stalled socket", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const server = createServer((_req, res) =>
    res.end(
      JSON.stringify({
        protocolEpoch: 1,
        negotiatedRevision: 1,
        serverInstanceId: "fake",
        capabilities: ["orchestration.cursor-safe-streams", "rpc.typed-errors"],
      }),
    ),
  );
  const sockets = new WebSocketServer({ server });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let connected = false,
    closed = false,
    pings = 0;
  sockets.on("connection", (ws) => {
    ws.on("close", () => {
      closed = true;
    });
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw);
      if (frame._tag === "Request")
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: "1", values: [snapshot(thread())] }));
      if (frame._tag === "Ping") pings++;
    });
  });
  const stop = watchSynara({
    upstream: `http://127.0.0.1:${server.address().port}`,
    onEvent: async () => {},
    onStatus: (s) => {
      if (s.state === "connected") connected = true;
    },
  });
  t.after(() => {
    stop();
    for (const c of sockets.clients) c.terminate();
    sockets.close();
    server.close();
  });
  await wait(() => connected);
  t.mock.timers.tick(20000);
  await wait(() => pings === 1);
  t.mock.timers.tick(20000);
  await wait(() => closed);
});
