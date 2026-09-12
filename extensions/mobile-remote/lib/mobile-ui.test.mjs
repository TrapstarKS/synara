import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
async function uiScenario({ subscribed, subscription, permission = "granted", userAgent = "iPhone", standalone = true }) {
  const elements = new Map();
  const writes = [];
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
        elements: Object.fromEntries(
          ["completed", "failed", "approval", "input"].map((key) => [key, { checked: false }]),
        ),
        addEventListener(event, handler) { clicks[`${id}:${event}`] = handler; },
      });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element },
    window: { addEventListener(name, handler) { handlers[name] = handler; } },
    URLSearchParams,
    URL,
    Uint8Array,
    matchMedia: () => ({ matches: standalone }),
    location: { hash: "", origin: "https://mobile.test" },
    history: { replaceState() {} },
    navigator: {
      userAgent,
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
  return { elements, writes, permissionRequests, handlers, clicks };
}

test("Samsung Android offers installation only on a tap and hides it after installation", async () => {
  const result = await uiScenario({ userAgent: "Android SamsungBrowser", standalone: false });
  assert.equal(result.elements.get("install-ios").hidden, true);
  assert.equal(result.elements.get("install-android").hidden, false);
  assert.equal(result.elements.get("name").value, "Meu Android");
  let prompts = 0, prevented = 0;
  result.handlers.beforeinstallprompt({ preventDefault() { prevented++; },
    async prompt() { prompts++; }, userChoice: Promise.resolve({ outcome: "accepted" }) });
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
      registration: { showNotification: async (title, options) => notifications.push({ title, ...options }) },
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
  handlers.push({ data: { json: () => ({ title: "Resposta necessária · Login", body: "Qual conta?",
    url: "/task-123", actionTitle: "Responder", tag: "synara:task-123:input" }) },
    waitUntil: (promise) => { delivery = promise; } });
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
