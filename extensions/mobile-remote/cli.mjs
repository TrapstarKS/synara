import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { adminAddress, mobileDirectory } from "./lib/admin.mjs";
import { assertPrivateWindowsPath } from "./lib/windows.mjs";
const [command, id, extra] = process.argv.slice(2);
const routes = {
  pair: ["POST", "/pair", {}],
  devices: ["GET", "/devices"],
  revoke: ["POST", "/revoke", { id }],
  peers: ["GET", "/peers"],
  "peer-add": ["POST", "/peers", { name: id, link: extra }],
  "peer-remove": ["POST", "/peers/remove", { id }],
};
if (
  !routes[command] ||
  (["revoke", "peer-remove"].includes(command) && !id) ||
  (command === "peer-add" && !extra)
) {
  console.error(
    "Usage: node cli.mjs pair | devices | revoke <device-id> | peers | peer-add <name> <pairing-link> | peer-remove <peer-id>",
  );
  process.exit(1);
}
const [method, path, payload] = routes[command];
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
    path,
    method,
    headers: {
      "Content-Type": "application/json",
      ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
    },
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
request.setTimeout(15_000, () => request.destroy(new Error("Timed out")));
request.end(payload && JSON.stringify(payload));
