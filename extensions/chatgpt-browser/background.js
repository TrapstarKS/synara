// Synara ChatGPT Browser Bridge.
//
// Deliberately does not use the cookies, webRequest, or storage APIs for
// ChatGPT data. It only attaches Chrome DevTools Protocol to ChatGPT/auth tabs
// and forwards the small browser actions requested by the local Synara server.

const CHATGPT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]);

const LOGIN_HOSTS = new Set([
  "auth.openai.com",
  "auth0.openai.com",
  "auth.chatgpt.com",
  "accounts.google.com",
]);

const BRIDGE_PATH = "/provider/chatgpt/browser";
const PAIRING_STORAGE_KEY = "synaraChatGptPairing";
const RECONNECT_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
// Chrome keeps an MV3 service worker alive while its WebSocket exchanges
// traffic, but an idle socket can otherwise be suspended between Synara turns.
const KEEPALIVE_INTERVAL_MS = 20_000;
const TAB_NAVIGATION_WAIT_MS = 10_000;

let pairing = null;
let socket = null;
let socketGeneration = 0;
let reconnectTimer = null;
let reconnectAttempt = 0;
let keepaliveTimer = null;
const attachedTabIds = new Set();

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLocalOrigin(origin) {
  try {
    const url = new URL(origin);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      return null;
    }
    // Synara's loopback server is always plaintext. Chrome can retain or
    // upgrade a pairing-page origin to https, but carrying that scheme into
    // the socket produces wss:// against a ws:// server (Invalid frame header).
    return `http://${url.host}`;
  } catch {
    return null;
  }
}

function isBrowserActionUrl(value) {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      (CHATGPT_HOSTS.has(url.hostname) || LOGIN_HOSTS.has(url.hostname))
    );
  } catch {
    return false;
  }
}

function isAllowedTabUrl(value) {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      (CHATGPT_HOSTS.has(url.hostname) || LOGIN_HOSTS.has(url.hostname))
    );
  } catch {
    return false;
  }
}

function tabIdFromArgs(args) {
  const value = args && args.tabId;
  const tabId = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("A valid ChatGPT tab id is required.");
  return tabId;
}

async function attachTab(tabId) {
  if (attachedTabIds.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabIds.add(tabId);
  } catch (error) {
    const message = errorMessage(error);
    // The service worker can restart while Chrome keeps the debugger attached.
    // Reusing the extension-owned attachment is safe; a DevTools-owned tab
    // still fails on the first command with a useful error.
    if (message.includes("already attached") || message.includes("Another debugger")) {
      attachedTabIds.add(tabId);
      return;
    }
    throw new Error(`Could not attach to the ChatGPT tab: ${message}`);
  }
}

function allowedUrlFromTab(tab) {
  const committed = typeof tab?.url === "string" ? tab.url : "";
  if (isAllowedTabUrl(committed)) return committed;
  const pending = typeof tab?.pendingUrl === "string" ? tab.pendingUrl : "";
  return isAllowedTabUrl(pending) ? pending : "";
}

async function getAllowedTab(tabId, activate = false) {
  const deadline = Date.now() + TAB_NAVIGATION_WAIT_MS;
  let tab = await chrome.tabs.get(tabId);
  // A freshly created Chrome tab commonly exposes the destination only as
  // pendingUrl while tab.url is still chrome://newtab or blank. Wait for the
  // allowed destination to commit before attaching the debugger; rejecting
  // that transient state made session startup fail even though ChatGPT loaded
  // successfully a moment later.
  while (!isAllowedTabUrl(tab.url || "") && isAllowedTabUrl(tab.pendingUrl || "")) {
    if (Date.now() >= deadline) {
      throw new Error("The ChatGPT tab did not finish loading in time.");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    tab = await chrome.tabs.get(tabId);
  }
  if (!isAllowedTabUrl(tab.url || "")) {
    throw new Error("The bridge can only control ChatGPT and its sign-in tabs.");
  }
  if (activate) await chrome.tabs.update(tabId, { active: true });
  await attachTab(tabId);
  return tab;
}

async function sendCommand(tabId, method, params = {}) {
  await getAllowedTab(tabId);
  return await chrome.debugger.sendCommand({ tabId }, method, params);
}

async function evaluate(tabId, expression) {
  const response = await sendCommand(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    generatePreview: false,
    userGesture: true,
  });
  if (response && response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description || "page evaluation failed";
    throw new Error(description);
  }
  return { value: response?.result?.value ?? null };
}

function selectorFromArgs(args) {
  const target = args && args.target;
  const selector = target && target.selector;
  if (typeof selector !== "string" || selector.length === 0 || selector.length > 2_000) {
    throw new Error("A CSS selector is required.");
  }
  return selector;
}

async function click(tabId, args) {
  const selector = selectorFromArgs(args);
  const expression = `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`;
  const result = await evaluate(tabId, expression);
  if (result.value !== true) throw new Error("The requested ChatGPT control was not found.");
  return { clicked: true };
}

async function typeText(tabId, args) {
  const selector = selectorFromArgs(args);
  const text = typeof args?.text === "string" ? args.text : "";
  if (text.length > 100_000) throw new Error("The prompt is too large.");
  const append = args?.append === true;
  const expression = `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.focus();
    const hasValue = "value" in element;
    const previous = hasValue ? String(element.value || "") : String(element.textContent || "");
    const next = ${JSON.stringify(text)};
    const value = ${append ? "previous + next" : "next"};
    if (!${append ? "true" : "false"}) {
      try { document.execCommand("selectAll", false); } catch {}
      try { document.execCommand("delete", false); } catch {}
    }
    if (hasValue) {
      const prototype = Object.getPrototypeOf(element);
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
    } else {
      try { document.execCommand("insertText", false, next); } catch {}
      if (String(element.textContent || "") !== value) element.textContent = value;
    }
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: next,
    }));
    return true;
  })()`;
  const result = await evaluate(tabId, expression);
  if (result.value !== true) throw new Error("The ChatGPT composer was not found.");
  return { typed: true };
}

const KEY_DATA = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27, text: "" },
  Tab: { code: "Tab", keyCode: 9, text: "" },
  Backspace: { code: "Backspace", keyCode: 8, text: "" },
  ArrowUp: { code: "ArrowUp", keyCode: 38, text: "" },
  ArrowDown: { code: "ArrowDown", keyCode: 40, text: "" },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37, text: "" },
  ArrowRight: { code: "ArrowRight", keyCode: 39, text: "" },
};

async function press(tabId, args) {
  const keys = Array.isArray(args?.keys) ? args.keys : [];
  if (keys.length === 0 || keys.length > 8) throw new Error("A short key sequence is required.");
  await getAllowedTab(tabId, true);
  for (const rawKey of keys) {
    const key = String(rawKey);
    const data = KEY_DATA[key] || { code: key, keyCode: 0, text: "" };
    const base = {
      key,
      code: data.code,
      windowsVirtualKeyCode: data.keyCode,
      nativeVirtualKeyCode: data.keyCode,
      text: data.text,
      unmodifiedText: data.text,
    };
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
    });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyUp",
      ...base,
    });
  }
  return { pressed: true };
}

async function browserTabs() {
  const tabs = await chrome.tabs.query({});
  const allowed = tabs.filter((tab) => allowedUrlFromTab(tab));
  const activeTab = allowed.find((tab) => tab.active);
  return {
    tabs: allowed.map((tab) => ({
      tabId: String(tab.id),
      url: allowedUrlFromTab(tab),
      active: tab.active === true,
    })),
    activeTabId: activeTab?.id === undefined ? null : String(activeTab.id),
    assignedTabId: null,
  };
}

async function browserOpen(args) {
  const url = String(args?.url || "");
  if (!isBrowserActionUrl(url) || !CHATGPT_HOSTS.has(new URL(url).hostname)) {
    throw new Error("The bridge can only open chatgpt.com.");
  }
  const tab = await chrome.tabs.create({ url, active: true });
  return { tabId: String(tab.id), finalUrl: allowedUrlFromTab(tab) || url };
}

async function browserNavigate(tabId, args) {
  const url = String(args?.url || "");
  if (!isBrowserActionUrl(url) || !CHATGPT_HOSTS.has(new URL(url).hostname)) {
    throw new Error("The bridge can only navigate ChatGPT tabs to chatgpt.com.");
  }
  await getAllowedTab(tabId, true);
  const tab = await chrome.tabs.update(tabId, { url, active: true });
  return { tabId: String(tab.id), finalUrl: allowedUrlFromTab(tab) || url };
}

async function browserWait(args) {
  const requested = Number(args?.timeMs ?? args?.milliseconds ?? 100);
  const milliseconds = Math.max(0, Math.min(Number.isFinite(requested) ? requested : 100, 5_000));
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return { waitedMs: milliseconds };
}

async function browserClose(tabId) {
  await getAllowedTab(tabId);
  await chrome.tabs.remove(tabId);
  attachedTabIds.delete(tabId);
  return { closed: true };
}

async function browserScreenshot(tabId) {
  const response = await sendCommand(tabId, "Page.captureScreenshot", { format: "png" });
  return { data: response?.data || "", mimeType: "image/png" };
}

async function executeRequest(request) {
  const args = request.args && typeof request.args === "object" ? request.args : {};
  switch (request.name) {
    case "browser_tabs":
      return await browserTabs();
    case "browser_open":
      return await browserOpen(args);
    case "browser_navigate":
      return await browserNavigate(tabIdFromArgs(args), args);
    case "browser_wait":
      return await browserWait(args);
    case "browser_evaluate":
      return await evaluate(tabIdFromArgs(args), String(args.expression || ""));
    case "browser_click":
      return await click(tabIdFromArgs(args), args);
    case "browser_type":
      return await typeText(tabIdFromArgs(args), args);
    case "browser_press":
      return await press(tabIdFromArgs(args), args);
    case "browser_close":
      return await browserClose(tabIdFromArgs(args));
    case "browser_screenshot":
      return await browserScreenshot(tabIdFromArgs(args));
    default:
      throw new Error(`Unsupported browser action: ${String(request.name)}.`);
  }
}

function sendResponse(id, ok, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const message = ok
    ? { type: "response", id, ok: true, result: payload }
    : { type: "response", id, ok: false, error: errorMessage(payload) };
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The server will reject pending actions when the socket closes.
  }
}

async function handleRequest(request) {
  if (!request || request.type !== "request" || !Number.isSafeInteger(request.id)) return;
  try {
    const result = await executeRequest(request);
    sendResponse(request.id, true, result);
  } catch (error) {
    sendResponse(request.id, false, error);
  }
}

function scheduleReconnect(generation) {
  if (reconnectTimer !== null || !pairing) return;
  const delay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_DELAY_MS * 2 ** Math.min(reconnectAttempt, 5),
  );
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (generation === socketGeneration) void connect();
  }, delay);
}

function stopKeepalive() {
  if (keepaliveTimer === null) return;
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

function startKeepalive(generation, target) {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (
      generation !== socketGeneration ||
      socket !== target ||
      target.readyState !== WebSocket.OPEN
    ) {
      stopKeepalive();
      return;
    }
    try {
      target.send(JSON.stringify({ type: "ping", protocol: 1 }));
    } catch {
      // The close/error path owns reconnection.
    }
  }, KEEPALIVE_INTERVAL_MS);
}

async function connect() {
  const localOrigin = pairing ? normalizeLocalOrigin(pairing.origin) : null;
  if (!pairing || !localOrigin || !pairing.token) return;
  const generation = ++socketGeneration;
  if (socket) {
    try {
      socket.close();
    } catch {}
    socket = null;
  }
  stopKeepalive();
  const wsOrigin = localOrigin.replace(/^http:/, "ws:");
  const next = new WebSocket(
    `${wsOrigin}${BRIDGE_PATH}?token=${encodeURIComponent(pairing.token)}`,
  );
  socket = next;
  next.addEventListener("open", () => {
    if (generation !== socketGeneration || socket !== next) return;
    reconnectAttempt = 0;
    try {
      next.send(JSON.stringify({ type: "hello", protocol: 1 }));
    } catch {}
    startKeepalive(generation, next);
  });
  next.addEventListener("message", (event) => {
    if (generation !== socketGeneration || socket !== next) return;
    let request;
    try {
      request = JSON.parse(String(event.data));
    } catch {
      return;
    }
    void handleRequest(request);
  });
  next.addEventListener("close", () => {
    if (generation !== socketGeneration || socket !== next) return;
    socket = null;
    stopKeepalive();
    scheduleReconnect(generation);
  });
  next.addEventListener("error", () => {
    // close follows in normal WebSocket implementations; reconnect is also
    // scheduled here for browsers that only emit an error event.
    if (generation === socketGeneration) scheduleReconnect(generation);
  });
}

async function loadPairing() {
  const stored = await chrome.storage.local.get(PAIRING_STORAGE_KEY);
  const value = stored[PAIRING_STORAGE_KEY];
  const localOrigin = value ? normalizeLocalOrigin(value.origin) : null;
  pairing =
    value && localOrigin && typeof value.token === "string"
      ? { origin: localOrigin, token: value.token }
      : null;
  if (pairing) void connect();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (message.type === "pair") {
    const localOrigin = normalizeLocalOrigin(message.origin);
    if (!localOrigin || typeof message.token !== "string" || message.token.length < 20) {
      sendResponse({ ok: false, error: "Pairing is only allowed with a local Synara server." });
      return false;
    }
    reconnectAttempt = 0;
    pairing = { origin: localOrigin, token: message.token };
    void chrome.storage.local
      .set({ [PAIRING_STORAGE_KEY]: pairing })
      .then(() => connect())
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }
  if (message.type === "clear") {
    pairing = null;
    reconnectAttempt = 0;
    ++socketGeneration;
    stopKeepalive();
    if (socket) {
      try {
        socket.close();
      } catch {}
      socket = null;
    }
    void chrome.storage.local.remove(PAIRING_STORAGE_KEY).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "status") {
    sendResponse({
      paired: pairing !== null,
      connected: socket?.readyState === WebSocket.OPEN,
      origin: pairing?.origin || null,
    });
    return false;
  }
  return false;
});

chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (typeof tabId === "number") attachedTabIds.delete(tabId);
});

void loadPairing();
