import { test } from "node:test";
import assert from "node:assert/strict";
import { createPush } from "./push.mjs";

const NOW = 1800000000000;
const subscription = (endpoint = "https://web.push.apple.com/old") => ({
  endpoint,
  keys: { p256dh: "key", auth: "auth" },
});
const device = () => ({
  id: "phone",
  expiresAt: NOW + 86400000,
  subscription: subscription(),
  preferences: { completed: true, failed: true, approval: true, input: true },
});
const event = (id, kind = "completed") => ({
  id,
  kind,
  title: "Synara",
  body: "Open task",
  url: "/task",
});
const queued = (id, kind = "completed") => ({
  id: `phone:${id}`,
  deviceId: "phone",
  kind,
  attempts: 0,
  nextAttempt: 0,
  expiresAt: NOW + 3600000,
  payload: { tag: id },
});
const fixture = (outbox = []) => {
  const state = {
    devices: [device()],
    outbox,
    vapid: { publicKey: "public", privateKey: "private" },
  };
  const saves = [];
  return {
    state,
    saves,
    save() {
      saves.push(structuredClone(state));
    },
  };
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const wait = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Timed out");
};

test("rich alerts keep their preview and group by thread and kind without merging other tasks", () => {
  const store = fixture();
  const push = createPush(store, "https://synara.example", { now: () => NOW });
  push.stop();
  for (const [id, threadId, kind] of [["one", "task-a", "input"], ["two", "task-a", "input"], ["three", "task-b", "input"], ["four", "task-a", "approval"]])
    push.enqueue({ ...event(id, kind), threadId, body: "Qual conta devo usar?", actionTitle: "Responder" });
  const payloads = store.state.outbox.map((item) => item.payload);
  assert.equal(payloads[0].tag, payloads[1].tag);
  assert.notEqual(payloads[0].tag, payloads[2].tag);
  assert.notEqual(payloads[0].tag, payloads[3].tag);
  assert.equal(payloads[0].body, "Qual conta devo usar?");
  assert.equal(payloads[0].actionTitle, "Responder");
});

test("bounded concurrency re-selects new approvals ahead of a durable completion backlog", async (t) => {
  const store = fixture(Array.from({ length: 100 }, (_, i) => queued(`old-${i}`)));
  const calls = [];
  const push = createPush(store, "https://synara.example", {
    now: () => NOW,
    sendNotification: (_sub, payload) => {
      const d = deferred();
      calls.push({ tag: JSON.parse(payload).tag, ...d });
      return d.promise;
    },
  });
  t.after(() => {
    push.stop();
    calls.forEach((call) => call.resolve());
  });
  await wait(() => calls.length === 4);
  push.enqueue(event("approval-now", "approval"));
  assert.equal(calls.length, 4);
  calls[0].resolve();
  await wait(() => calls.length === 5);
  assert.equal(calls[4].tag, "approval-now");
  assert.ok(store.saves.some((s) => s.outbox.some((item) => item.id === "phone:approval-now")));
});

test("priority does not starve normal work; backing-off and expired records do not block readiness", async (t) => {
  const store = fixture([
    { ...queued("expired", "approval"), expiresAt: NOW - 1 },
    { ...queued("backoff", "approval"), nextAttempt: NOW + 100000 },
    ...Array.from({ length: 20 }, (_, i) => queued(`urgent-${i}`, "approval")),
    queued("normal"),
  ]);
  const calls = [];
  const push = createPush(store, "https://synara.example", {
    now: () => NOW,
    sendNotification: (_s, payload) => {
      const d = deferred();
      calls.push({ tag: JSON.parse(payload).tag, ...d });
      return d.promise;
    },
  });
  t.after(() => {
    push.stop();
    calls.forEach((call) => call.resolve());
  });
  await wait(() => calls.length === 4);
  assert.deepEqual(
    calls.map((c) => c.tag),
    ["urgent-0", "urgent-1", "urgent-2", "normal"],
  );
  assert.equal(
    store.state.outbox.some((item) => item.id === "phone:expired"),
    false,
  );
});

test("old endpoint 410 cannot delete replacement; retry uses the new subscription", async (t) => {
  const store = fixture([queued("one")]);
  const calls = [];
  const push = createPush(store, "https://synara.example", {
    now: () => NOW,
    sendNotification: (sub) => {
      const d = deferred();
      calls.push({ sub, ...d });
      return d.promise;
    },
  });
  t.after(() => {
    push.stop();
    calls.forEach((call) => call.resolve());
  });
  await wait(() => calls.length === 1);
  store.state.devices[0].subscription = subscription("https://web.push.apple.com/new");
  calls[0].reject({ statusCode: 410 });
  await wait(() => calls.length === 2);
  assert.equal(calls[1].sub.endpoint, "https://web.push.apple.com/new");
  assert.equal(store.state.devices[0].subscription.endpoint, calls[1].sub.endpoint);
  assert.equal(store.state.devices[0].pushError, undefined);
  calls[1].resolve();
  await wait(() => store.state.outbox.length === 0);
});

test("revocation during await neither changes detached device nor resurrects cancelled queue", async (t) => {
  const store = fixture([queued("one")]);
  const held = deferred();
  let started = false;
  const oldDevice = store.state.devices[0];
  const push = createPush(store, "https://synara.example", {
    now: () => NOW,
    sendNotification: () => {
      started = true;
      return held.promise;
    },
  });
  t.after(() => push.stop());
  await wait(() => started);
  store.state.devices = [];
  store.state.outbox = [];
  store.save();
  const saved = store.saves.length;
  held.reject({ statusCode: 503 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(oldDevice.pushError, undefined);
  assert.equal(store.state.outbox.length, 0);
  assert.equal(store.saves.length, saved);
});

test("transient errors back off durably, then retry; permanent endpoint failure unsubscribes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let time = NOW,
    calls = 0;
  const store = fixture([queued("one")]);
  const push = createPush(store, "https://synara.example", {
    now: () => time,
    sendNotification: async () => {
      calls++;
      throw { statusCode: calls === 1 ? 503 : 410 };
    },
  });
  t.after(() => push.stop());
  await wait(() => store.state.outbox[0]?.attempts === 1);
  assert.equal(store.state.outbox[0].nextAttempt, NOW + 10000);
  t.mock.timers.tick(5000);
  assert.equal(calls, 1);
  time += 10000;
  t.mock.timers.tick(5000);
  await wait(() => store.state.outbox.length === 0);
  assert.equal(calls, 2);
  assert.equal(store.state.devices[0].subscription, undefined);
});

test("stop prevents further sends while retaining unsent work for restart", async (t) => {
  const store = fixture(Array.from({ length: 8 }, (_, i) => queued(String(i))));
  const calls = [];
  const push = createPush(store, "https://synara.example", {
    now: () => NOW,
    sendNotification: () => {
      const d = deferred();
      calls.push(d);
      return d.promise;
    },
  });
  t.after(() => push.stop());
  await wait(() => calls.length === 4);
  push.stop();
  calls.forEach((c) => c.resolve());
  await wait(() => store.state.outbox.length === 4);
  push.enqueue(event("after-stop", "approval"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 4);
  assert.equal(store.state.outbox.length, 5);
});

test("bounded durable outbox preserves actionable work over normal backlog and deduplicates pending IDs", () => {
  const store = fixture([
    queued("keep", "approval"),
    ...Array.from({ length: 511 }, (_, i) => queued(String(i))),
  ]);
  const push = createPush(store, "https://synara.example", {
    now: () => NOW,
    sendNotification: async () => assert.fail("must stay stopped"),
  });
  push.stop();
  push.enqueue(event("new", "input"));
  push.enqueue(event("new", "input"));
  assert.equal(store.state.outbox.length, 512);
  assert.equal(store.state.outbox.filter((item) => item.id === "phone:new").length, 1);
  assert.ok(store.state.outbox.some((item) => item.id === "phone:keep"));
  assert.equal(store.saves.at(-1).outbox.length, 512);
});

test("durable event ids prevent a delivered notification from being enqueued twice", () => {
  const store = fixture();
  const push = createPush(store, "https://synara.example", {
    now: () => NOW,
    sendNotification: async () => assert.fail("must stay stopped"),
  });
  push.stop();
  push.enqueue(event("completion-once"));
  store.state.outbox = [];
  push.enqueue(event("completion-once"));

  assert.deepEqual(store.state.outbox, []);
  assert.deepEqual(store.state.enqueuedEventIds, ["*:completion-once"]);
});
