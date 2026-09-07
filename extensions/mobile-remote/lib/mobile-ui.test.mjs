import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
async function uiScenario({ subscribed, subscription, permission = "granted" }) {
  const elements = new Map();
  const writes = [];
  let permissionRequests = 0;
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: "",
        hidden: false,
        disabled: false,
        value: "",
        elements: Object.fromEntries(
          ["completed", "failed", "approval", "input"].map((key) => [key, { checked: false }]),
        ),
        addEventListener() {},
      });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element },
    window: {},
    URLSearchParams,
    URL,
    Uint8Array,
    matchMedia: () => ({ matches: true }),
    location: { hash: "", origin: "https://mobile.test" },
    history: { replaceState() {} },
    navigator: {
      userAgent: "iPhone",
      serviceWorker: {
        register: async () => ({}),
        getRegistration: async () => ({
          pushManager: { getSubscription: async () => subscription },
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
      if (url.endsWith("/subscribe")) writes.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () =>
          url.endsWith("/status")
            ? {
                paired: true,
                name: "iPhone",
                subscribed,
                preferences: { completed: true, failed: true, approval: true, input: true },
                monitor: { state: "connected" },
              }
            : { ok: true },
      };
    },
    setTimeout,
  });
  context.window.Notification = context.Notification;
  vm.runInContext(source, context);
  await vm.runInContext("refresh()", context);
  return { elements, writes, permissionRequests };
}

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
  const context = vm.createContext({
    URL,
    self: {
      location: { origin: "https://mobile.test" },
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
