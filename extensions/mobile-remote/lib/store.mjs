import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { assertPrivateWindowsPath } from "./windows.mjs";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export const defaults = { completed: true, failed: true, approval: true, input: true };

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (process.platform === "win32") assertPrivateWindowsPath(directory);
  const path = join(directory, "state.json");
  let state;
  try {
    if (process.platform === "win32" && existsSync(path)) assertPrivateWindowsPath(path);
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  state ??= { version: 1, devices: [], outbox: [], checkpoint: null };
  if (state.version !== 1 || !Array.isArray(state.devices) || !Array.isArray(state.outbox)) {
    throw new Error("Unsupported mobile state format");
  }
  const save = () => {
    const temp = path + ".tmp";
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  };
  return { state, save };
}

export function validatePreferences(value) {
  if (
    !value ||
    Object.keys(value).some((key) => !(key in defaults)) ||
    Object.keys(defaults).some((key) => typeof value[key] !== "boolean")
  ) {
    throw new Error("Invalid notification preferences");
  }
  return Object.fromEntries(Object.keys(defaults).map((key) => [key, value[key]]));
}

export function validateSubscription(value) {
  const url = new URL(value?.endpoint);
  // Web Push is an outbound request: never accept arbitrary URLs from a client.
  const allowed =
    url.hostname === "web.push.apple.com" ||
    url.hostname.endsWith(".push.apple.com") ||
    url.hostname === "fcm.googleapis.com" ||
    url.hostname === "updates.push.services.mozilla.com";
  if (
    url.protocol !== "https:" ||
    !allowed ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.length > 4096 ||
    !/^[A-Za-z0-9_-]{80,100}$/.test(value?.keys?.p256dh ?? "") ||
    !/^[A-Za-z0-9_-]{20,30}$/.test(value?.keys?.auth ?? "")
  ) {
    throw new Error("Invalid Web Push subscription");
  }
  return { endpoint: url.href, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}
