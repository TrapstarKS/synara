import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("preferences entry waits for the native header, adopts its classes, and survives remount without an overlay", () => {
  let trigger = null,
    notify,
    inserts = 0;
  const link = { isConnected: false, dataset: {}, setAttribute() {} };
  const context = vm.createContext({
    navigator: {},
    document: {
      body: {},
      createElement: () => link,
      querySelector: (selector) => {
        assert.equal(selector, '[data-slot="sidebar-trigger"]');
        return trigger;
      },
    },
    MutationObserver: class {
      constructor(callback) {
        notify = callback;
      }
      observe() {}
    },
    requestAnimationFrame: (fn) => fn(),
  });
  vm.runInContext(readFileSync(new URL("../public/install.js", import.meta.url), "utf8"), context);
  assert.equal(inserts, 0);
  trigger = {
    parentElement: {},
    className: "native-ghost-button",
    after(element) {
      assert.equal(element, link);
      link.isConnected = true;
      inserts++;
    },
  };
  notify();
  notify();
  assert.equal(inserts, 1);
  assert.equal(link.className, trigger.className);
  assert.equal(link.href, "/mobile");
  assert.equal(link.style, undefined);
  link.isConnected = false;
  trigger.className = "native-updated-button";
  notify();
  assert.equal(inserts, 2);
  assert.equal(link.className, trigger.className);
});

test("theme bridge saves only color tokens and applies them to mobile preferences", () => {
  const source = readFileSync(new URL("../public/theme.js", import.meta.url), "utf8");
  let stored;
  const applied = {};
  const style = {
    colorScheme: "dark",
    getPropertyValue: (name) => (name === "--background" ? "#101010" : "#fcfcfc"),
  };
  const root = {
    style: {
      setProperty: (name, value) => {
        applied[name] = value;
      },
    },
  };
  const common = {
    document: { documentElement: root, querySelector: () => ({ setAttribute() {} }) },
    localStorage: {
      setItem: (_key, value) => {
        stored = value;
      },
      getItem: () => stored,
    },
    getComputedStyle: () => style,
    CSS: { supports: (_kind, value) => /^#[a-f0-9]+$/.test(value) },
    requestAnimationFrame: (fn) => fn(),
    MutationObserver: class {
      observe() {}
    },
  };
  vm.runInNewContext(source, { ...common, location: { pathname: "/task-123" } });
  const saved = JSON.parse(stored);
  assert.equal(saved.scheme, "dark");
  assert.equal(saved["--background"], "#101010");
  assert.equal(Object.keys(saved).length, 12);
  saved["--unexpected"] = "url(https://evil.test)";
  stored = JSON.stringify(saved);
  vm.runInNewContext(source, { ...common, location: { pathname: "/mobile" } });
  assert.equal(applied["--background"], "#101010");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(applied["--unexpected"], undefined);
});

test("the Home Screen app starts in Synara and uses the original icon at its real size", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
  );
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  const icon = readFileSync(new URL("../public/icon.png", import.meta.url));
  assert.equal(manifest.icons[0].sizes, `${icon.readUInt32BE(16)}x${icon.readUInt32BE(20)}`);
  assert.deepEqual(
    icon,
    readFileSync(new URL("../../../apps/web/public/app-icons/default.png", import.meta.url)),
  );
});
