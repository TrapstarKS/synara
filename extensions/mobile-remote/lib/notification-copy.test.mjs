import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import {
  hasLiveBackgroundTasks,
  notificationCopy,
  preview,
  readNotificationThread,
} from "./notification-copy.mjs";

const event = (kind) => ({ kind, threadId: "task", turnId: "turn", taskTitle: "Corrigir login" });

test("notifications explain the pending action or question, with task title and an open action", () => {
  const thread = { title: "Corrigir login", activities: [
    { kind: "approval.requested", turnId: "old", payload: { detail: "Wrong action" } },
    { kind: "approval.requested", turnId: "turn", payload: { requestId: "approve", requestKind: "command", detail: "bun run test" } },
    { kind: "user-input.requested", turnId: "turn", payload: { requestId: "question", questions: [{ question: "Qual conta devo usar para testar o login?" }] } },
  ], pendingInteractions: [
    { requestId: "approve", interactionKind: "approval", status: "pending" },
    { requestId: "question", interactionKind: "userInput", status: "retryable" },
  ] };
  assert.deepEqual(notificationCopy(event("approval"), thread), {
    title: "Aprovação · Corrigir login", body: "Executar comando: bun run test", actionTitle: "Revisar ação",
  });
  assert.equal(notificationCopy(event("input"), thread).body, "Qual conta devo usar para testar o login?");
  thread.pendingInteractions[0].status = "confirmed";
  assert.doesNotMatch(notificationCopy(event("approval"), thread).body, /bun run test/);
});

test("completion previews use only the final assistant message from the matching turn", () => {
  const copy = notificationCopy(event("completed"), { messages: [
    { role: "assistant", turnId: "old", text: "Wrong turn" },
    { role: "assistant", turnId: "turn", text: "**Login corrigido.** [Testes](https://example.test) passaram.", streaming: false },
    { role: "user", turnId: "turn", text: "Do not preview my prompt" },
    { role: "assistant", turnId: "turn", text: "Still streaming", streaming: true },
  ] });
  assert.equal(copy.body, "Login corrigido. Testes passaram.");
  assert.equal(copy.title, "Concluída · Corrigir login");
  assert.equal(notificationCopy(event("failed"), { session: { lastError: "Conexão com o provedor expirou." } }).body,
    "Conexão com o provedor expirou.");
  assert.match(notificationCopy(event("input"), null).body, /pergunta/);
  assert.equal(preview("x".repeat(500)).length, 200);
  assert.doesNotMatch(preview("token=private-value Authorization: Bearer private-value"), /private-value/);
  assert.equal(preview("Executar my_task --pattern '*.ts'"), "Executar my_task --pattern '*.ts'");
  assert.equal(notificationCopy(event("completed"), { latestTurn: { assistantMessageId: "final" }, messages: [
    { id: "final", role: "assistant", turnId: "turn", text: "Final answer" },
    { id: "late", role: "assistant", turnId: "turn", text: "Later transcript bookkeeping" },
  ] }).body, "Final answer");
});

test("background task detection ignores plans and completed tasks", () => {
  const activities = [
    { kind: "task.started", turnId: "turn", payload: { taskId: "plan", taskType: "plan" } },
    { kind: "task.started", turnId: "turn", payload: { taskId: "child", taskType: "subagent" } },
    { kind: "task.completed", turnId: "turn", payload: { taskId: "child" } },
  ];
  assert.equal(hasLiveBackgroundTasks({ activities }, "turn"), false);
  assert.equal(
    hasLiveBackgroundTasks(
      { activities: [...activities.slice(0, 2), { kind: "task.started", turnId: "turn", payload: { taskId: "worker" } }] },
      "turn",
    ),
    true,
  );
});

test("detail reads are bounded, read-only and fall back when unavailable", async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const url = `ws://127.0.0.1:${server.address().port}`;
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const request = JSON.parse(raw);
    assert.equal(request.tag, "orchestration.getThreadDetailSnapshot");
    if (request.payload.threadId === "timeout") return;
    if (request.payload.threadId === "unsupported") {
      socket.send(JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Failure" } }));
      return;
    }
    socket.send(JSON.stringify({ _tag: "Exit", requestId: request.id, exit: {
      _tag: "Success", value: { thread: { id: "task", title: "Result" } },
    } }));
  }));
  assert.equal((await readNotificationThread(url, "task")).title, "Result");
  assert.equal(await readNotificationThread(url, "wrong-id"), null);
  assert.equal(await readNotificationThread(url, "unsupported"), null);
  assert.equal(await readNotificationThread(url, "timeout", { timeoutMs: 20 }), null);
});
