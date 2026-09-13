import { createHash } from "node:crypto";
import WebSocket from "ws";
import {
  hasLiveBackgroundTasks,
  notificationCopy,
  preview,
  readNotificationThread,
} from "./notification-copy.mjs";

// Deliberately pinned to contracts/wsCompatibility.ts and orchestration.ts.
// This read-only client never falls back to an unnegotiated or provider socket.
const REQUIRED = ["orchestration.cursor-safe-streams", "rpc.typed-errors"];
const MAX_THREADS = 2000;
const MAX_SEEN = 1000;
const MAX_RECOVERY_EVENTS = 20;
const DAY = 86400000;
const STATES = new Set(["running", "interrupted", "completed", "error"]);
const LIVE_SESSION_STATES = new Set(["starting", "connecting", "running", "waiting"]);
export const COMPLETION_SETTLE_DELAY_MS = 30000;
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.length > 0 && v.length <= 512;
const date = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
const hash = (value) => createHash("sha256").update(value).digest("hex");
class Incompatible extends Error {}
const isSubagentThread = (thread) =>
  thread.parentThreadId != null || thread.subagentAgentId != null ||
  thread.creationSource === "provider_native" || thread.id.startsWith("subagent:");

function summary(thread) {
  if (
    !record(thread) ||
    !text(thread.id) ||
    !date(thread.updatedAt) ||
    (thread.hasPendingApprovals !== undefined && typeof thread.hasPendingApprovals !== "boolean") ||
    (thread.hasPendingUserInput !== undefined && typeof thread.hasPendingUserInput !== "boolean")
  ) {
    throw new Incompatible("Unsupported Synara thread shell.");
  }
  const turn = thread.latestTurn;
  if (turn !== null && (!record(turn) || !text(turn.turnId) || !STATES.has(turn.state))) {
    throw new Incompatible("Unsupported Synara latest-turn schema.");
  }
  const session = thread.session;
  if (
    session !== null &&
    session !== undefined &&
    (!record(session) ||
      !text(session.status) ||
      (session.activeTurnId !== null &&
        session.activeTurnId !== undefined &&
        !text(session.activeTurnId)))
  ) {
    throw new Incompatible("Unsupported Synara session schema.");
  }
  if (thread.goal !== undefined && typeof thread.goal !== "string") {
    throw new Incompatible("Unsupported Synara goal schema.");
  }
  for (const key of ["parentThreadId", "subagentAgentId", "creationSource"]) {
    if (thread[key] != null && !text(thread[key]))
      throw new Incompatible("Unsupported Synara subagent metadata.");
  }
  if (
    thread.goalPausedAt !== undefined &&
    thread.goalPausedAt !== null &&
    !date(thread.goalPausedAt)
  ) {
    throw new Incompatible("Unsupported Synara goal state.");
  }
  return {
    id: thread.id,
    title: preview(thread.title, 72),
    turn: turn?.turnId ?? null,
    state: turn?.state ?? null,
    approval: thread.hasPendingApprovals === true,
    input: thread.hasPendingUserInput === true,
    updatedAt: thread.updatedAt,
    archived: !!thread.archivedAt,
    isSubagent: isSubagentThread(thread),
    goalActive:
      typeof thread.goal === "string" &&
      thread.goal.trim().length > 0 &&
      thread.goalPausedAt == null,
    sessionStatus: session?.status ?? null,
    activeTurn: session?.activeTurnId ?? null,
  };
}

function eventFor(current, id, kind) {
  const event = {
    id,
    kind,
    threadId: current.id,
    turnId: current.turn,
    taskTitle: current.title,
    url: `/${encodeURIComponent(current.id)}`,
    createdAt: current.updatedAt,
  };
  return { ...event, ...notificationCopy(event) };
}

/** Bounded task titles and lifecycle metadata; no transcripts or provider payloads. */
export function createShellMonitor({
  checkpoint,
  scope = "",
  onEvent,
  saveCheckpoint = async () => {},
  now = Date.now,
  completionDelayMs = COMPLETION_SETTLE_DELAY_MS,
}) {
  let state = {
    version: 1,
    scope,
    initialized: false,
    startedAt: new Date(now()).toISOString(),
    threads: [],
    seen: [],
  };
  if (
    checkpoint?.version === 1 &&
    checkpoint.scope === scope &&
    checkpoint.initialized === true &&
    date(checkpoint.startedAt) &&
    Array.isArray(checkpoint.threads) &&
    checkpoint.threads.length <= MAX_THREADS &&
    Array.isArray(checkpoint.seen) &&
    checkpoint.seen.length <= MAX_SEEN &&
    checkpoint.seen.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) &&
    checkpoint.threads.every(
      (t) =>
        record(t) &&
        text(t.id) &&
        date(t.updatedAt) &&
        (t.turn === null || text(t.turn)) &&
        (t.state === null || STATES.has(t.state)) &&
        typeof t.approval === "boolean" &&
        typeof t.input === "boolean" &&
        typeof t.archived === "boolean" &&
        (t.isSubagent === undefined || typeof t.isSubagent === "boolean") &&
        (t.goalActive === undefined || typeof t.goalActive === "boolean") &&
        (t.sessionStatus === undefined || t.sessionStatus === null || text(t.sessionStatus)) &&
        (t.activeTurn === undefined || t.activeTurn === null || text(t.activeTurn)),
    )
  ) {
    state = structuredClone(checkpoint);
    state.threads = state.threads.map((thread) => ({
      ...thread,
      goalActive: thread.goalActive === true,
      sessionStatus: thread.sessionStatus ?? null,
      activeTurn: thread.activeTurn ?? null,
      title: preview(thread.title, 72),
      isSubagent: thread.isSubagent === true || thread.id.startsWith("subagent:"),
    }));
  }
  const pendingCompletions = new Map();
  let stopped = false;
  let serialized = Promise.resolve();
  const serialize = (task) => {
    const result = serialized.then(task, task);
    serialized = result.catch(() => {});
    return result;
  };

  const completionIsStable = (current, candidate) =>
    current?.turn === candidate.turn &&
    current.state === "completed" &&
    !current.isSubagent &&
    !current.goalActive &&
    current.activeTurn === null &&
    !LIVE_SESSION_STATES.has(current.sessionStatus);
  const cancelCompletion = (threadId) => {
    const pending = pendingCompletions.get(threadId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingCompletions.delete(threadId);
  };
  const scheduleCompletion = (current, id, delivered = false, delayMs = completionDelayMs) => {
    const existing = pendingCompletions.get(current.id);
    if (existing?.id === id) return;
    cancelCompletion(current.id);
    const candidate = { id, turn: current.turn, delivered, timer: undefined };
    candidate.timer = setTimeout(() => {
      void serialize(async () => {
        if (stopped || pendingCompletions.get(current.id) !== candidate) return;
        const latest = state.threads.find((thread) => thread.id === current.id);
        if (!completionIsStable(latest, candidate)) {
          pendingCompletions.delete(current.id);
          return;
        }
        try {
          if (!candidate.delivered) {
            const accepted = await onEvent(eventFor(latest, id, "completed"));
            if (accepted === false) {
              if (!stopped && pendingCompletions.get(current.id) === candidate) {
                pendingCompletions.delete(current.id);
                scheduleCompletion(
                  latest,
                  id,
                  candidate.delivered,
                  Math.max(50, Math.min(completionDelayMs, 1000)),
                );
              }
              return;
            }
            candidate.delivered = true;
          }
          if (stopped || pendingCompletions.get(current.id) !== candidate) return;
          const updated = {
            ...state,
            seen: [...new Set([...state.seen, id])].slice(-MAX_SEEN),
          };
          await saveCheckpoint(updated);
          state = updated;
          pendingCompletions.delete(current.id);
        } catch {
          if (!stopped && pendingCompletions.get(current.id) === candidate) {
            pendingCompletions.delete(current.id);
            scheduleCompletion(latest, id, candidate.delivered);
          }
        }
      });
    }, delayMs);
    candidate.timer.unref?.();
    pendingCompletions.set(current.id, candidate);
  };
  return {
    checkpoint: () => structuredClone(state),
    stop() {
      stopped = true;
      for (const threadId of pendingCompletions.keys()) cancelCompletion(threadId);
    },
    accept(item) {
      return serialize(async () => {
        if (stopped) return;
        if (!record(item)) throw new Incompatible("Invalid Synara shell stream.");
        const snapshot = item.kind === "snapshot";
        if (snapshot && (!record(item.snapshot) || !Array.isArray(item.snapshot.threads)))
          throw new Incompatible("Invalid Synara shell snapshot.");
        if (!snapshot && !state.initialized)
          throw new Incompatible("Synara stream did not start with a snapshot.");
        const incoming = snapshot
          ? item.snapshot.threads
          : item.kind === "thread-upserted"
            ? [item.thread]
            : [];
        if (incoming.length > 10000)
          throw new Incompatible("Synara shell exceeds monitor capacity.");
        const summaries = incoming.map(summary); // Validate the complete chunk before delivering anything.
        const previous = new Map(state.threads.map((t) => [t.id, t]));
        const next = snapshot ? new Map() : new Map(previous);
        const seen = new Set(state.seen);
        const completionCandidates = [];
        let recoveryCount = 0;
        for (const current of summaries) {
          const old = previous.get(current.id);
          next.delete(current.id);
          next.set(current.id, current);
          const pendingCompletion = pendingCompletions.get(current.id);
          if (pendingCompletion && !completionIsStable(current, pendingCompletion)) {
            cancelCompletion(current.id);
          }
          if (!state.initialized || current.archived || !old) continue;
          // Older/untracked threads in recovery are baseline, never a history notification storm.
          if (snapshot && Date.parse(current.updatedAt) < now() - DAY) continue;
          const kinds = [];
          const completedEdge =
            current.state === "completed" &&
            (old?.turn !== current.turn || old?.state !== "completed");
          const completedBecameStable =
            current.state === "completed" &&
            old?.state === "completed" &&
            !completionIsStable(old, { turn: current.turn }) &&
            completionIsStable(current, { turn: current.turn });
          if (completedEdge || completedBecameStable) kinds.push("completed");
          if (current.state === "error" && (old?.turn !== current.turn || old?.state !== "error"))
            kinds.push("failed");
          if (current.approval && (!old?.approval || old.turn !== current.turn))
            kinds.push("approval");
          if (current.input && (!old?.input || old.turn !== current.turn)) kinds.push("input");
          for (const kind of kinds) {
            // Child lifecycle is internal work; requests needing the user still notify.
            if (current.isSubagent && (kind === "completed" || kind === "failed")) continue;
            // Boolean request flags do not expose request IDs. Use their rising-edge timestamp.
            const edge = kind === "approval" || kind === "input" ? current.updatedAt : "";
            const id = hash(JSON.stringify([scope, current.id, current.turn, kind, edge]));
            if (seen.has(id)) continue;
            if (snapshot && recoveryCount++ >= MAX_RECOVERY_EVENTS) {
              seen.add(id);
              continue;
            }
            if (kind === "completed") {
              if (completionIsStable(current, { turn: current.turn })) {
                completionCandidates.push({ current, id });
              }
              continue;
            }
            seen.add(id);
            await onEvent(eventFor(current, id, kind));
          }
        }
        if (item.kind === "thread-removed" && text(item.threadId)) {
          next.delete(item.threadId);
          cancelCompletion(item.threadId);
        }
        if (
          !snapshot &&
          ![
            "thread-upserted",
            "thread-removed",
            "space-upserted",
            "space-removed",
            "space-order-updated",
            "project-upserted",
            "project-removed",
          ].includes(item.kind)
        ) {
          throw new Incompatible("Unsupported Synara shell event.");
        }
        const updated = {
          ...state,
          initialized: true,
          threads: [...next.values()].slice(-MAX_THREADS),
          seen: [...seen].slice(-MAX_SEEN),
        };
        await saveCheckpoint(updated);
        state = updated;
        for (const candidate of completionCandidates) {
          scheduleCompletion(candidate.current, candidate.id);
        }
      });
    },
  };
}

export function watchSynara({
  upstream,
  resolveUpstream,
  scope,
  onDisconnect = () => {},
  onEvent,
  onStatus = () => {},
  checkpoint,
  saveCheckpoint,
  completionDelayMs,
}) {
  if (!upstream && typeof resolveUpstream !== "function")
    throw new Error("upstream or resolveUpstream is required.");
  const fixedTarget = upstream ? { origin: upstream } : null;
  const target = async () => {
    const resolved = fixedTarget ?? (await resolveUpstream());
    const base = new URL(typeof resolved === "string" ? resolved : resolved.origin);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
      throw new Error("upstream must be an HTTP(S) URL without embedded credentials.");
    return {
      base,
      token: typeof resolved === "object" && resolved ? resolved.token : undefined,
    };
  };
  const lifetime = new AbortController();
  let stopped = false,
    socket,
    notificationUrl,
    retry,
    heartbeat,
    attempt = 0;
  const status = (state, message) => {
    try {
      onStatus({ state, ...(message ? { message } : {}) });
    } catch {}
  };
  const monitor = createShellMonitor({
    checkpoint,
    scope: scope ?? (upstream ? new URL(upstream).origin : "desktop"),
    onEvent: async (event) => {
      const detail = await readNotificationThread(notificationUrl, event.threadId).catch(() => null);
      if (stopped) return;
      if (detail && isSubagentThread(detail) && ["completed", "failed"].includes(event.kind)) return;
      // Don't describe a later turn or notify about work that already resumed.
      if (detail && (detail.latestTurn?.turnId !== event.turnId ||
          (event.kind === "completed" && detail.latestTurn?.state !== "completed") ||
          (event.kind === "approval" && detail.hasPendingApprovals === false) ||
          (event.kind === "input" && detail.hasPendingUserInput === false))) return;
      if (event.kind === "completed" && detail && hasLiveBackgroundTasks(detail, event.turnId)) {
        return false;
      }
      await onEvent({ ...event, ...notificationCopy(event, detail) });
    },
    saveCheckpoint,
    ...(completionDelayMs === undefined ? {} : { completionDelayMs }),
  });
  let work = Promise.resolve();
  const clearHeartbeat = () => {
    clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const schedule = () => {
    if (stopped || retry) return;
    status("reconnecting", "Synara unavailable; retrying.");
    retry = setTimeout(
      () => {
        retry = undefined;
        void connect();
      },
      Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)),
    );
  };
  const failClosed = () => {
    stopped = true;
    lifetime.abort();
    clearTimeout(retry);
    clearHeartbeat();
    monitor.stop();
    socket?.terminate();
    status("incompatible", "Synara protocol is unsupported. Update the mobile adapter.");
  };
  async function connect() {
    status("connecting");
    try {
      const { base, token } = await target();
      const url = new URL("/ws/negotiate", base);
      url.search = base.search;
      for (const [key, value] of Object.entries({
        "client-build": "mobile-remote-1",
        "protocol-epoch": "1",
        "protocol-min-revision": "1",
        "protocol-max-revision": "1",
      }))
        url.searchParams.set(`x-synara-${key}`, value);
      for (const capability of REQUIRED)
        url.searchParams.append("x-synara-required-capability", capability);
      const response = await fetch(url, {
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
        redirect: "error",
      });
      if ([404, 426].includes(response.status)) throw new Incompatible();
      if (!response.ok) throw new Error("Negotiation unavailable");
      const body = await response.json();
      if (
        body.protocolEpoch !== 1 ||
        body.negotiatedRevision !== 1 ||
        !text(body.serverInstanceId) ||
        !Array.isArray(body.capabilities) ||
        !REQUIRED.every((c) => body.capabilities.includes(c))
      )
        throw new Incompatible();
      if (stopped) return;
      const wsUrl = new URL("/ws", base);
      wsUrl.search = base.search;
      wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      if (token) wsUrl.searchParams.set("token", token);
      for (const [key, value] of Object.entries({
        "client-build": "mobile-remote-1",
        "protocol-epoch": "1",
        "protocol-revision": "1",
        "server-instance": body.serverInstanceId,
      }))
        wsUrl.searchParams.set(`x-synara-${key}`, value);
      const ws = new WebSocket(wsUrl, { handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
      notificationUrl = wsUrl;
      socket = ws;
      let pong = true,
        pending = 0,
        snapshotReceived = false;
      ws.on("open", () => {
        if (stopped) return ws.terminate();
        ws.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "orchestration.subscribeShell",
            payload: {},
            headers: [],
          }),
        );
        heartbeat = setInterval(() => {
          if (!pong || !snapshotReceived) {
            ws.terminate();
            return;
          }
          pong = false;
          ws.send(JSON.stringify({ _tag: "Ping" }));
        }, 20000);
      });
      ws.on("message", (raw) => {
        if (stopped || socket !== ws) return;
        let frame;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          failClosed();
          return;
        }
        if (frame?._tag === "Pong") {
          pong = true;
          return;
        }
        if (frame?._tag === "Exit") {
          ws.terminate();
          return;
        }
        if (
          frame?._tag !== "Chunk" ||
          frame.requestId !== "1" ||
          !Array.isArray(frame.values) ||
          frame.values.length > 1000
        ) {
          failClosed();
          return;
        }
        if (++pending > 32) {
          ws.terminate();
          return;
        }
        work = work
          .then(async () => {
            if (stopped || socket !== ws) return;
            for (const value of frame.values) {
              if (!snapshotReceived && value?.kind !== "snapshot") throw new Incompatible();
              await monitor.accept(value);
              if (!snapshotReceived) {
                snapshotReceived = true;
                attempt = 0;
                status("connected");
              }
            }
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ _tag: "Ack", requestId: "1" }));
          })
          .catch((error) => {
            if (error instanceof Incompatible) failClosed();
            else ws.terminate();
          })
          .finally(() => {
            pending--;
          });
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        if (socket === ws) {
          clearHeartbeat();
          try {
            onDisconnect();
          } catch {}
          schedule();
        }
      });
    } catch (error) {
      if (!stopped) {
        if (error instanceof Incompatible) failClosed();
        else {
          try {
            onDisconnect();
          } catch {}
          schedule();
        }
      }
    }
  }
  void connect();
  return () => {
    stopped = true;
    lifetime.abort();
    clearTimeout(retry);
    clearHeartbeat();
    monitor.stop();
    socket?.terminate();
    status("stopped");
  };
}
