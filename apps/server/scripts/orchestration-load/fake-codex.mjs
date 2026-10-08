#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

if (process.env.CODEX_HOME)
  appendFileSync(
    path.join(process.env.CODEX_HOME, "fixture-launches.txt"),
    `${process.pid} ${process.argv.includes("--version") ? "version" : process.argv.includes("app-server") ? "app-server" : "probe"}\n`,
  );

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.153.0");
  process.exit(0);
}
if (process.argv.includes("login")) {
  console.log("Logged in using an API key");
  process.exit(0);
}
if (!process.argv.includes("app-server")) process.exit(1);

const config = JSON.parse(
  readFileSync(path.join(process.env.CODEX_HOME, "load-fixture.json"), "utf8"),
);
const lifecyclePath = path.join(process.env.CODEX_HOME, `stream-${process.pid}.json`);
let lifecycle = {};
const record = (stage) => {
  lifecycle = {
    ...lifecycle,
    [stage]: Date.now(),
    [`${stage}RssBytes`]: process.memoryUsage().rss,
  };
  writeFileSync(lifecyclePath, JSON.stringify(lifecycle));
};
const threadId = `fake-thread-${process.pid}`;
let cwd = process.cwd();
let turnNumber = 0;
const timers = new Set();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params: { threadId, ...params } });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const respond = (result) => send({ id: request.id, result });
  switch (request.method) {
    case "account/read":
      respond({ account: { type: "apiKey" }, requiresOpenaiAuth: false });
      break;
    case "model/list":
      respond({
        data: [
          {
            id: "gpt-5.5",
            model: "gpt-5.5",
            displayName: "Load fixture",
            isDefault: true,
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      });
      break;
    case "thread/start":
    case "thread/resume":
      cwd = request.params?.cwd ?? cwd;
      respond({ thread: { id: threadId, turns: [] }, model: "gpt-5.5" });
      break;
    case "turn/start": {
      const turnId = `fake-turn-${process.pid}-${++turnNumber}`;
      const messageId = `${turnId}-message`;
      const commandId = `${turnId}-command`;
      const fileId = `${turnId}-file`;
      respond({ turn: { id: turnId, status: "inProgress", items: [] } });
      record("ready");
      const start = setInterval(() => {
        if (config.barrier && !existsSync(path.join(process.env.CODEX_HOME, "stream-go"))) return;
        clearInterval(start);
        timers.delete(start);
        record("started");
        notify("turn/started", { turn: { id: turnId, status: "inProgress" } });
        notify("item/started", { turnId, item: { id: messageId, type: "agentMessage", text: "" } });
        notify("item/started", {
          turnId,
          item: {
            id: commandId,
            type: "commandExecution",
            command: "bun run typecheck",
            cwd,
            status: "inProgress",
            commandActions: [],
          },
        });
        let tick = 0;
        let text = "";
        let output = "";
        const timer = setInterval(() => {
          const delta = `token-${tick} `;
          text += delta;
          notify("item/agentMessage/delta", { turnId, itemId: messageId, delta });
          if (tick % 4 === 0) {
            const delta = `checked module ${tick}: ${"source.ts ".repeat(8)}\n`;
            output += delta;
            notify("item/commandExecution/outputDelta", { turnId, itemId: commandId, delta });
          }
          if (tick === Math.floor(config.ticks / 2)) {
            const filePath = path.join(cwd, `load-${process.pid}.ts`);
            const diff = "+export const loadResult = true;\n";
            notify("item/started", {
              turnId,
              item: {
                id: fileId,
                type: "fileChange",
                status: "inProgress",
                changes: [{ path: filePath, kind: { type: "add" }, diff }],
              },
            });
            writeFileSync(filePath, "export const loadResult = true;\n");
            notify("item/fileChange/outputDelta", { turnId, itemId: fileId, delta: diff });
            notify("item/completed", {
              turnId,
              item: {
                id: fileId,
                type: "fileChange",
                status: "completed",
                changes: [{ path: filePath, kind: { type: "add" }, diff }],
              },
            });
          }
          tick += 1;
          if (tick < config.ticks) return;
          clearInterval(timer);
          timers.delete(timer);
          notify("item/completed", {
            turnId,
            item: {
              id: commandId,
              type: "commandExecution",
              command: "bun run typecheck",
              cwd,
              status: "completed",
              exitCode: 0,
              durationMs: config.ticks * config.intervalMs,
              aggregatedOutput: output,
              commandActions: [],
            },
          });
          notify("item/completed", { turnId, item: { id: messageId, type: "agentMessage", text } });
          notify("turn/completed", { turn: { id: turnId, status: "completed", items: [] } });
          record("ended");
        }, config.intervalMs);
        timers.add(timer);
      }, 10);
      timers.add(start);
      break;
    }
    case "turn/interrupt":
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      respond({});
      break;
    default:
      respond({});
  }
});
