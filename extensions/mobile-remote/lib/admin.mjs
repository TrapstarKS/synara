import { createHash } from "node:crypto";
import { join, resolve, win32 } from "node:path";

export function adminAddress(directory, platform = process.platform) {
  if (platform !== "win32") return join(directory, "admin.sock");
  const identity = createHash("sha256")
    .update(win32.resolve(directory).toLowerCase()).digest("hex").slice(0, 32);
  return `\\\\.\\pipe\\synara-mobile-${identity}`;
}

export function mobileDirectory(environment = process.env, home) {
  return resolve(environment.SYNARA_MOBILE_HOME || join(home, ".synara-mobile"));
}
