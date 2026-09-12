import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { adminAddress, mobileDirectory } from "./lib/admin.mjs";
import { assertPrivateWindowsPath } from "./lib/windows.mjs";
const [command, id] = process.argv.slice(2);
if (!["pair", "devices", "revoke"].includes(command) || (command === "revoke" && !id)) {
  console.error("Usage: node cli.mjs pair | devices | revoke <device-id>");
  process.exit(1);
}
const directory = mobileDirectory(process.env, homedir());
let adminToken;
if (process.platform === "win32") {
  assertPrivateWindowsPath(directory);
  const path = join(directory, "state.json");
  assertPrivateWindowsPath(path);
  adminToken = JSON.parse(readFileSync(path, "utf8")).adminToken;
  if (!adminToken) throw new Error("Start the mobile companion before pairing");
}
const request = http.request(
  {
    socketPath: adminAddress(directory),
    path: "/" + command,
    method: command === "devices" ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}) },
  },
  (response) => {
    let raw = "";
    response.on("data", (chunk) => (raw += chunk));
    response.on("end", () => {
      if (response.statusCode !== 200) {
        console.error(raw);
        process.exitCode = 1;
        return;
      }
      const data = JSON.parse(raw);
      console.log(command === "pair" ? data.url : JSON.stringify(data, null, 2));
    });
  },
);
request.on("error", (error) => {
  console.error(`Mobile service unavailable: ${error.message}`);
  process.exitCode = 1;
});
request.setTimeout(5000, () => request.destroy(new Error("Timed out")));
request.end(
  command === "devices" ? undefined : command === "revoke" ? JSON.stringify({ id }) : "{}",
);
