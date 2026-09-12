import WebSocket from "ws";

export function preview(value, limit = 200) {
  if (typeof value !== "string") return "";
  const clean = value.slice(0, 4000)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(?:Bearer\s+)[\w.+/-]+/gi, "Bearer [oculto]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[oculto]")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*(?:#{1,6}|>)\s+/gm, "")
    .replace(/`+/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit - 1).trimEnd() + "…" : clean;
}

const labels = {
  completed: "Concluída", failed: "Falhou", approval: "Aprovação", input: "Resposta necessária",
};
const fallback = {
  completed: "O agente terminou esta tarefa. Toque para ver o resultado.",
  failed: "A execução parou com erro. Toque para revisar e retomar.",
  approval: "O agente aguarda sua autorização para continuar. Toque para revisar a ação.",
  input: "Há uma pergunta aguardando sua resposta. Toque para responder.",
};

export function notificationCopy(event, thread) {
  const title = preview(thread?.title || event.taskTitle, 72);
  let detail = "";
  if (event.kind === "completed") {
    const messages = Array.isArray(thread?.messages) ? thread.messages : [];
    const matches = (message) => message.role === "assistant" &&
      message.turnId === event.turnId && message.streaming !== true && preview(message.text);
    const finalId = thread?.latestTurn?.assistantMessageId;
    const last = (finalId && messages.find((message) => message.id === finalId && matches(message))) ||
      messages.findLast(matches);
    detail = preview(last?.text);
  } else if (event.kind === "failed") {
    detail = preview(thread?.session?.lastError);
  } else {
    const kind = event.kind === "approval" ? "approval.requested" : "user-input.requested";
    const interactions = Array.isArray(thread?.pendingInteractions) ? thread.pendingInteractions : null;
    const activities = Array.isArray(thread?.activities) ? thread.activities : [];
    const activity = activities.findLast((entry) => entry.kind === kind &&
      (entry.turnId === event.turnId || entry.turnId == null) && (!interactions || interactions.some((pending) =>
        pending.requestId === entry.payload?.requestId &&
        pending.interactionKind === (event.kind === "approval" ? "approval" : "userInput") &&
        ["pending", "retryable", "uncertain"].includes(pending.status))));
    if (event.kind === "input") {
      detail = preview(activity?.payload?.questions?.[0]?.question);
    } else if (activity) {
      const request = activity.payload;
      const action = { command: "Executar comando", "file-read": "Ler arquivos",
        "file-change": "Alterar arquivos", permissions: "Conceder permissão" }[request?.requestKind];
      const description = preview(request?.detail, 150);
      detail = description ? `${action || "Revisar ação"}: ${description}` : action || "";
    }
  }
  return {
    title: title ? `${labels[event.kind]} · ${title}` : labels[event.kind],
    body: detail || fallback[event.kind],
    actionTitle: event.kind === "input" ? "Responder" : event.kind === "approval" ? "Revisar ação" : "Ver conversa",
  };
}

// One bounded read on notification, using the already negotiated local endpoint.
// A missing/older RPC or large transcript falls back to the shell's task title.
export function readNotificationThread(url, threadId, { timeoutMs = 2000 } = {}) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: 8 * 1024 * 1024 });
    const finish = (thread = null) => {
      clearTimeout(timer);
      socket.terminate();
      resolve(thread);
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on("error", () => finish());
    socket.on("close", () => { clearTimeout(timer); resolve(null); });
    socket.on("open", () => socket.send(JSON.stringify({
      _tag: "Request", id: "1", tag: "orchestration.getThreadDetailSnapshot",
      payload: { threadId }, headers: [],
    })));
    socket.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame._tag === "Exit" && frame.requestId === "1") {
          const thread = frame.exit?._tag === "Success" ? frame.exit.value?.thread : null;
          finish(thread?.id === threadId ? thread : null);
        }
      } catch { finish(); }
    });
  });
}
