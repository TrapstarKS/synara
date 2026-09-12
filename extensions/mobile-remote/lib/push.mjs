import webpush from "web-push";

const urgent = (kind) => ["approval", "input", "failed"].includes(kind);
const CONCURRENCY = 4;
const MAX_OUTBOX = 512;
const MAX_ENQUEUED_EVENT_IDS = 1000;

export function createPush(store, publicOrigin, dependencies = {}) {
  const { state, save } = store;
  const now = dependencies.now ?? Date.now;
  const sendNotification = dependencies.sendNotification ?? webpush.sendNotification.bind(webpush);
  const onError =
    dependencies.onError ?? (() => console.error("Mobile push queue could not be saved."));
  state.enqueuedEventIds = Array.isArray(state.enqueuedEventIds)
    ? state.enqueuedEventIds.filter((id) => typeof id === "string" && id.length <= 1024)
    : [];
  if (!state.vapid) {
    state.vapid = webpush.generateVAPIDKeys();
    save();
  }
  // Per-request VAPID avoids changing global web-push credentials for another instance.
  const vapidDetails = {
    subject: publicOrigin,
    publicKey: state.vapid.publicKey,
    privateKey: state.vapid.privateKey,
  };
  const active = new Set();
  let stopped = false,
    scheduled,
    urgentStreak = 0;
  function deviceFor(item) {
    const device = state.devices.find((entry) => entry.id === item.deviceId);
    return device?.subscription &&
      device.expiresAt > now() &&
      item.expiresAt > now() &&
      (item.kind === "test" || device.preferences[item.kind])
      ? device
      : undefined;
  }
  function remove(item) {
    state.outbox = state.outbox.filter((entry) => entry !== item);
    save();
  }
  function schedule() {
    if (stopped || scheduled !== undefined) return;
    // Yield between batches, including synchronous/mock failures.
    scheduled = setTimeout(() => {
      scheduled = undefined;
      pump();
    }, 0);
  }
  async function deliver(item, device) {
    const subscription = structuredClone(device.subscription);
    let failure;
    try {
      await sendNotification(subscription, JSON.stringify(item.payload), {
        TTL: Math.max(1, Math.min(3600, Math.ceil((item.expiresAt - now()) / 1000))),
        timeout: 8000,
        urgency: urgent(item.kind) ? "high" : "normal",
        vapidDetails,
      });
    } catch (error) {
      failure = error;
    }
    // Revocation, unsubscribe, expiry and eviction can happen while a request is in flight.
    // Never resurrect removed work or write delivery metadata onto a detached device.
    if (!state.outbox.includes(item)) return;
    if (deviceFor(item) !== device) {
      remove(item);
      return;
    }
    const sameSubscription =
      device.subscription.endpoint === subscription.endpoint &&
      device.subscription.keys.p256dh === subscription.keys.p256dh &&
      device.subscription.keys.auth === subscription.keys.auth;
    if (!sameSubscription) {
      if (!failure) {
        remove(item);
        return;
      }
      item.nextAttempt = 0; // The new subscription has not been tried yet.
      item.attempts = 0;
      save();
      return;
    }
    if (!failure) {
      device.lastPushAt = new Date(now()).toISOString();
      delete device.pushError;
      remove(item);
      return;
    }
    device.pushError = `Push service: ${failure.statusCode ?? "unavailable"}`;
    if (failure.statusCode === 404 || failure.statusCode === 410) {
      delete device.subscription;
      remove(item);
    } else {
      item.attempts += 1;
      item.nextAttempt = now() + Math.min(300_000, 5000 * 2 ** Math.min(item.attempts, 6));
      save();
    }
  }
  function pump() {
    if (stopped) return;
    try {
      const retained = state.outbox.filter((item) => deviceFor(item));
      if (retained.length !== state.outbox.length) {
        state.outbox = retained;
        save();
      }
      while (active.size < CONCURRENCY) {
        const ready = state.outbox.filter((item) => !active.has(item) && item.nextAttempt <= now());
        if (!ready.length) break;
        // Re-select after every completion. Reserve one in four selections for normal work
        // when present, so a continuous approval stream cannot starve completions.
        const high = ready.find((item) => urgent(item.kind));
        const normal = ready.find((item) => !urgent(item.kind));
        const item = normal && (!high || urgentStreak >= 3) ? normal : (high ?? normal);
        urgentStreak = urgent(item.kind) ? urgentStreak + 1 : 0;
        const device = deviceFor(item);
        active.add(item);
        void deliver(item, device)
          .catch(onError)
          .finally(() => {
            active.delete(item);
            schedule();
          });
      }
    } catch (error) {
      onError(error);
    }
  }
  function enqueue(event, onlyDevice) {
    const enqueueId = `${onlyDevice ?? "*"}:${event.id}`;
    if (state.enqueuedEventIds.includes(enqueueId)) return;
    for (const device of state.devices) {
      if (
        !device.subscription ||
        device.expiresAt <= now() ||
        (onlyDevice && onlyDevice !== device.id) ||
        (event.kind !== "test" && !device.preferences[event.kind])
      )
        continue;
      const id = `${device.id}:${event.id}`;
      if (state.outbox.some((item) => item.id === id)) continue;
      state.outbox.push({
        id,
        deviceId: device.id,
        kind: event.kind,
        attempts: 0,
        nextAttempt: 0,
        expiresAt: now() + 3600_000,
        payload: {
          title: event.title, body: event.body, url: event.url,
          actionTitle: event.actionTitle,
          tag: event.threadId ? `synara:${event.threadId}:${event.kind}` : event.id,
        },
      });
    }
    while (state.outbox.length > MAX_OUTBOX) {
      // Prefer retaining actionable notifications and already-running sends.
      let index = state.outbox.findIndex((item) => !active.has(item) && !urgent(item.kind));
      if (index < 0) index = state.outbox.findIndex((item) => !active.has(item));
      state.outbox.splice(index < 0 ? 0 : index, 1);
    }
    state.enqueuedEventIds.push(enqueueId);
    state.enqueuedEventIds = state.enqueuedEventIds.slice(-MAX_ENQUEUED_EVENT_IDS);
    save();
    schedule();
  }
  const timer = setInterval(pump, 5000);
  timer.unref();
  schedule(); // Resume a durable queue immediately after restart.
  return {
    enqueue,
    publicKey: state.vapid.publicKey,
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(scheduled);
      scheduled = undefined;
    },
  };
}
