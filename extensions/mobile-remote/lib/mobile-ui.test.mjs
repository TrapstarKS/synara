import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
async function uiScenario({
  subscribed,
  subscription,
  permission = "granted",
  userAgent = "iPhone",
  standalone = true,
  initialStatus = {},
  statusReader,
  subscriptionReader,
  subscribeResponse,
}) {
  const elements = new Map();
  const writes = [];
  const reads = [];
  const timers = new Map();
  let nextTimer = 0;
  let remoteStatus = {
    paired: true,
    name: "iPhone",
    subscribed,
    preferences: { completed: true, failed: true, approval: true, input: true },
    monitor: { state: "connected" },
    ...initialStatus,
  };
  let permissionRequests = 0;
  const handlers = {};
  const clicks = {};
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: "",
        hidden: false,
        disabled: false,
        value: "",
        replaceChildren(...children) {
          this.children = children;
        },
        setAttribute() {},
        elements: Object.fromEntries(
          ["completed", "failed", "approval", "input"].map((key) => [key, { checked: false }]),
        ),
        addEventListener(event, handler) {
          clicks[`${id}:${event}`] = handler;
        },
      });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {
      hidden: false,
      getElementById: element,
      createElement: () => ({ setAttribute() {} }),
      addEventListener(name, handler) {
        handlers[name] = handler;
      },
    },
    window: {
      addEventListener(name, handler) {
        handlers[name] = handler;
      },
    },
    URLSearchParams,
    URL,
    Uint8Array,
    AbortController,
    matchMedia: () => ({ matches: standalone }),
    location: { hash: "", origin: "https://mobile.test" },
    history: { replaceState() {} },
    navigator: {
      userAgent,
      serviceWorker: {
        register: async () => ({}),
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () => (subscriptionReader ? subscriptionReader() : subscription),
          },
        }),
      },
    },
    Notification: {
      permission,
      requestPermission() {
        permissionRequests++;
      },
    },
    fetch: async (url, options) => {
      if (url.endsWith("/subscribe")) {
        writes.push(JSON.parse(options.body));
        if (subscribeResponse) await subscribeResponse();
      }
      if (url.endsWith("/status")) {
        reads.push(options);
        const value = statusReader ? await statusReader(options) : structuredClone(remoteStatus);
        return { ok: true, json: async () => value };
      }
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  context.window.Notification = context.Notification;
  vm.runInContext(source, context);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  return {
    elements,
    writes,
    reads,
    timers,
    permissionRequests,
    handlers,
    clicks,
    context,
    flush,
    setStatus(value) {
      remoteStatus = { ...remoteStatus, ...value };
    },
    setStatusReader(value) {
      statusReader = value;
    },
    async poll() {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === 5000);
      assert.ok(entry, "availability must schedule another bounded status read");
      timers.delete(entry[0]);
      entry[1].callback();
      await flush();
    },
  };
}

test("an open computer selector recovers without rewriting preferences or resubscribing", async () => {
  const hosts = [
    { id: "local", name: "Mac", online: true },
    { id: "windows", name: "Windows", online: false },
  ];
  const result = await uiScenario({
    subscribed: true,
    subscription: { toJSON: () => ({ endpoint: "https://web.push.apple.com/current" }) },
    initialStatus: { hosts, host: "windows" },
  });
  assert.equal(result.elements.get("connection").textContent, "Windows indisponível");
  result.elements.get("preferences").elements.completed.checked = false;
  const writes = result.writes.length;
  result.setStatus({ hosts: hosts.map((host) => ({ ...host, online: true })) });
  await result.poll();
  assert.equal(result.elements.get("connection").textContent, "Windows conectado");
  assert.equal(result.elements.get("preferences").elements.completed.checked, false);
  assert.equal(result.writes.length, writes, "availability reads must never renew push endpoints");
  assert.equal(result.reads.length, 2);
});

test("status refresh is single-flight and pauses when the page is hidden", async () => {
  const result = await uiScenario({});
  let release;
  result.setStatusReader(
    ({ signal }) =>
      new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  await result.poll();
  result.handlers.online();
  await result.flush();
  assert.equal(result.reads.length, 2);
  result.context.document.hidden = true;
  result.handlers.visibilitychange();
  await result.flush();
  assert.equal(result.reads.at(-1).signal.aborted, true);
  assert.equal(result.timers.size, 0);
  release({ paired: false });
  result.setStatusReader(undefined);
  result.context.document.hidden = false;
  result.handlers.visibilitychange();
  await result.flush();
  assert.equal(result.reads.length, 3);
  assert.equal(result.elements.get("paired").hidden, false);
});

test("a failed first request recovers and initializes controls without reopening the page", async () => {
  const result = await uiScenario({
    statusReader: async () => {
      throw new Error("offline");
    },
  });
  result.setStatusReader(undefined);
  await result.poll();
  assert.equal(result.elements.get("connection").textContent, "Computador conectado");
  assert.equal(result.elements.get("device-name").textContent, "iPhone");
  assert.equal(result.elements.get("preferences").elements.completed.checked, true);
  assert.equal(result.elements.get("message").textContent, "");
});

test("an unresponsive status request times out and allows the next recovery check", async () => {
  const result = await uiScenario({});
  result.setStatusReader(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
      }),
  );
  await result.poll();
  await result.poll();
  assert.equal(result.reads.at(-1).signal.aborted, true);
  assert.equal(result.elements.get("connection").textContent, "Reconectando…");
  result.setStatusReader(undefined);
  await result.poll();
  assert.equal(result.elements.get("connection").textContent, "Computador conectado");
  assert.equal(result.reads.length, 3);
});

test("an old availability result cannot restore pairing after logout", async () => {
  const result = await uiScenario({});
  let release;
  result.setStatusReader(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await result.poll();
  result.setStatusReader(undefined);
  result.setStatus({ paired: false });
  await result.clicks["logout:click"]({ preventDefault() {}, currentTarget: {} });
  release({ paired: true, monitor: { state: "connected" } });
  await result.flush();
  assert.equal(result.elements.get("paired").hidden, true);
  assert.equal(result.elements.get("connection").textContent, "Não conectado");
});

for (const blocked of ["browser subscription", "subscription POST"]) {
  test(`availability recovers while ${blocked} is pending`, async () => {
    const hosts = [
      { id: "local", name: "Mac", online: true },
      { id: "windows", name: "Windows", online: false },
    ];
    const pending = () => new Promise(() => {});
    const result = await uiScenario({
      subscribed: true,
      subscription: { toJSON: () => ({ endpoint: "https://web.push.apple.com/current" }) },
      initialStatus: { hosts, host: "windows" },
      ...(blocked === "browser subscription"
        ? { subscriptionReader: pending }
        : { subscribeResponse: pending }),
    });
    result.elements.get("preferences").elements.completed.checked = false;
    const writes = result.writes.length;
    result.setStatus({ hosts: hosts.map((host) => ({ ...host, online: true })) });
    await result.poll();
    assert.equal(result.reads.length, 2);
    assert.equal(result.elements.get("connection").textContent, "Windows conectado");
    assert.equal(result.elements.get("preferences").elements.completed.checked, false);
    assert.equal(result.writes.length, writes);
  });
}

test("Samsung Android offers installation only on a tap and hides it after installation", async () => {
  const result = await uiScenario({ userAgent: "Android SamsungBrowser", standalone: false });
  assert.equal(result.elements.get("install-ios").hidden, true);
  assert.equal(result.elements.get("install-android").hidden, false);
  assert.equal(result.elements.get("name").value, "Meu Android");
  let prompts = 0,
    prevented = 0;
  result.handlers.beforeinstallprompt({
    preventDefault() {
      prevented++;
    },
    async prompt() {
      prompts++;
    },
    userChoice: Promise.resolve({ outcome: "accepted" }),
  });
  assert.equal(prevented, 1);
  assert.equal(prompts, 0);
  assert.equal(result.elements.get("install-app").hidden, false);
  await result.clicks["install-app:click"]({ preventDefault() {}, currentTarget: {} });
  assert.equal(prompts, 1);
  result.handlers.appinstalled();
  assert.equal(result.elements.get("install").hidden, true);
});

test("a missing browser subscription exposes reactivation even if server still has one", async () => {
  const result = await uiScenario({ subscribed: true, subscription: null });
  assert.equal(result.elements.get("enable").hidden, false);
  assert.equal(result.elements.get("test").disabled, true);
  assert.equal(result.elements.get("push-state").textContent, "Reativar neste aparelho");
  assert.equal(result.permissionRequests, 0);
});

test("an already-granted rotated endpoint is synchronized without another permission prompt", async () => {
  const payload = { endpoint: "https://web.push.apple.com/renewed", keys: {} };
  const result = await uiScenario({ subscribed: true, subscription: { toJSON: () => payload } });
  assert.deepEqual(result.writes[0], payload);
  assert.equal(result.elements.get("enable").hidden, true);
  assert.equal(result.elements.get("test").disabled, false);
  assert.equal(result.permissionRequests, 0);
});

test("revoked permission does not claim the phone can receive notifications", async () => {
  const result = await uiScenario({
    subscribed: true,
    subscription: { toJSON: () => ({}) },
    permission: "denied",
  });
  assert.equal(result.elements.get("enable").hidden, false);
  assert.equal(result.writes.length, 0);
});

test("server opt-out wins over a residual browser subscription after failed cleanup", async () => {
  const result = await uiScenario({
    subscribed: false,
    subscription: { toJSON: () => ({ endpoint: "https://web.push.apple.com/residual" }) },
  });
  assert.equal(result.writes.length, 0);
  assert.equal(result.elements.get("enable").hidden, false);
  assert.equal(result.elements.get("test").disabled, true);
  assert.equal(result.elements.get("push-state").textContent, "Desativadas");
});

test("notification click follows only same-origin links and focuses an existing app", async () => {
  const handlers = {};
  const navigated = [];
  let focused = 0;
  const notifications = [];
  const context = vm.createContext({
    URL,
    self: {
      location: { origin: "https://mobile.test" },
      registration: {
        showNotification: async (title, options) => notifications.push({ title, ...options }),
      },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
      clients: {
        matchAll: async () => [
          {
            url: "https://mobile.test/mobile",
            navigate: async (path) => navigated.push(path),
            focus: async () => focused++,
          },
        ],
      },
    },
  });
  vm.runInContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), context);
  let delivery;
  handlers.push({
    data: {
      json: () => ({
        title: "Resposta necessária · Login",
        body: "Qual conta?",
        url: "/task-123",
        actionTitle: "Responder",
        tag: "synara:task-123:input",
      }),
    },
    waitUntil: (promise) => {
      delivery = promise;
    },
  });
  await delivery;
  assert.equal(notifications[0].title, "Resposta necessária · Login");
  assert.equal(notifications[0].body, "Qual conta?");
  assert.equal(notifications[0].actions[0].title, "Responder");
  async function click(url) {
    let work;
    handlers.notificationclick({
      notification: { data: { url }, close() {} },
      waitUntil: (promise) => {
        work = promise;
      },
    });
    await work;
  }
  await click("/task-123");
  await click("https://evil.test/steal");
  assert.deepEqual(navigated, ["/task-123", "/mobile"]);
  assert.equal(focused, 2);
});
