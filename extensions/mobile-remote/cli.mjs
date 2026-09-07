import http from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const [command, id] = process.argv.slice(2);
if (!["pair", "devices", "revoke"].includes(command) || (command === "revoke" && !id)) {
  console.error("Usage: node cli.mjs pair | devices | revoke <device-id>");
  process.exit(1);
}
const request = http.request(
  {
    socketPath: join(
      resolve(process.env.SYNARA_MOBILE_HOME ?? join(homedir(), ".synara-mobile")),
      "admin.sock",
    ),
    path: "/" + command,
    method: command === "devices" ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
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
