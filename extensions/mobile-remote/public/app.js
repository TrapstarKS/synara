const $ = (id) => document.getElementById(id);
let status;
let statusRequest;
let refreshGeneration = 0;
let initialized = false;
let availabilityTimer;
let pageActive = true;
const connectionError = "Não foi possível conectar. Tentando reconectar…";
let standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
$("install-ios").hidden = !ios;
$("install-android").hidden = ios;
$("name").value = ios
  ? "Meu iPhone"
  : /Android/.test(navigator.userAgent)
    ? "Meu Android"
    : "Meu aparelho";
let installPrompt;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("install-app").hidden = Boolean(standalone);
});
window.addEventListener("appinstalled", () => {
  standalone = true;
  installPrompt = null;
  $("install").hidden = true;
  $("install-app").hidden = true;
});
const code = new URLSearchParams(location.hash.slice(1)).get("pair");
if (code) {
  $("code").value = code;
  history.replaceState(null, "", "/mobile");
}
const message = (value) => {
  $("message").textContent = value;
};
async function api(path, value, signal) {
  const response = await fetch(
    "/mobile/api/" + path,
    value === undefined
      ? { signal, cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Não foi possível salvar. Tente novamente.");
  return result;
}
function renderHosts() {
  const host = status.hosts.find((entry) => entry.id === status.host) ?? status.hosts[0];
  $("connection").textContent = host.name + (host.online ? " conectado" : " indisponível");
  $("hosts-section").hidden = false;
  $("hosts").replaceChildren(
    ...status.hosts.map((entry) => {
      const link = document.createElement("a");
      link.className = entry.id === status.host ? "button" : "button secondary";
      link.href = "/mobile/host/" + encodeURIComponent(entry.id) + "?to=/";
      if (entry.id === status.host) link.setAttribute("aria-current", "true");
      link.textContent =
        entry.name + (entry.online ? "" : entry.error ? " · " + entry.error : " · offline");
      return link;
    }),
  );
}
async function refresh({ availabilityOnly = false } = {}) {
  if (availabilityOnly && statusRequest) return;
  const generation = availabilityOnly ? refreshGeneration : ++refreshGeneration;
  statusRequest?.controller.abort();
  const request = { controller: new AbortController(), availabilityOnly };
  statusRequest = request;
  let statusReadComplete = false;
  const timeout = setTimeout(() => request.controller.abort(), 5000);
  try {
    const nextStatus = await api("status", undefined, request.controller.signal);
    clearTimeout(timeout);
    if (statusRequest !== request || request.controller.signal.aborted) return;
    status = nextStatus;
    // Notification reconciliation can wait on the browser or a POST. Only the
    // status GET owns the polling slot, so those waits cannot freeze availability.
    statusReadComplete = true;
    statusRequest = undefined;
    scheduleAvailability();
    if ($("message").textContent === connectionError) message("");
    $("pair").hidden = status.paired;
    $("paired").hidden = !status.paired;
    $("install").hidden = Boolean(standalone);
    $("hosts-section").hidden = true;
    $("connection").textContent = !status.paired
      ? "Não conectado"
      : status.monitor.state === "connected"
        ? "Computador conectado"
        : "Computador indisponível";
    if (!status.paired) {
      initialized = false;
      refreshGeneration += 1;
      return;
    }
    if (status.hosts?.length > 1) renderHosts();
    // Availability polling must not reset unsaved preferences or renew push endpoints.
    if (availabilityOnly && initialized) return;
    $("device-name").textContent = status.name;
    for (const key of Object.keys(status.preferences))
      $("preferences").elements[key].checked = status.preferences[key];
    initialized = true;
    let browserSubscription = null;
    if (
      "serviceWorker" in navigator &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      const registration = await navigator.serviceWorker.getRegistration("/");
      browserSubscription = await registration?.pushManager?.getSubscription();
      if (generation !== refreshGeneration || request.controller.signal.aborted) return;
      // Reconcile a rotated endpoint without asking for permission outside a tap.
      if (browserSubscription && status.subscribed)
        await api("subscribe", browserSubscription.toJSON());
    }
    if (generation !== refreshGeneration || request.controller.signal.aborted) return;
    const active = status.subscribed && Boolean(browserSubscription);
    $("push-state").textContent = active
      ? "Ativadas"
      : status.subscribed
        ? "Reativar neste aparelho"
        : "Desativadas";
    $("test").disabled = !active;
    $("disable").hidden = !status.subscribed && !browserSubscription;
    $("enable").hidden = active;
    $("push-detail").textContent = status.pushError
      ? "A entrega falhou. Confira a internet do computador e envie um novo teste."
      : status.lastPushAt
        ? "Último envio: " + new Date(status.lastPushAt).toLocaleString("pt-BR")
        : "";
  } catch (error) {
    if (statusRequest === request || (statusReadComplete && generation === refreshGeneration))
      throw error;
  } finally {
    clearTimeout(timeout);
    if (statusRequest === request) statusRequest = undefined;
  }
}
function scheduleAvailability() {
  clearTimeout(availabilityTimer);
  if (pageActive && !document.hidden)
    availabilityTimer = setTimeout(() => void refreshAvailability(), 5000);
}
async function refreshAvailability() {
  clearTimeout(availabilityTimer);
  if (!pageActive || document.hidden) return;
  try {
    await refresh({ availabilityOnly: true });
  } catch {
    if (pageActive && !document.hidden) $("connection").textContent = "Reconectando…";
  } finally {
    scheduleAvailability();
  }
}
function pauseAvailability() {
  clearTimeout(availabilityTimer);
  if (statusRequest?.availabilityOnly) statusRequest.controller.abort();
}
function action(id, fn, event = "click") {
  $(id).addEventListener(event, async (e) => {
    e.preventDefault();
    const button = e.submitter || e.currentTarget;
    button.disabled = true;
    try {
      await fn();
    } catch (error) {
      message(error.message);
    } finally {
      button.disabled = false;
    }
  });
}
action("install-app", async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  $("install-app").hidden = true;
  await prompt.prompt();
  await prompt.userChoice;
});
action(
  "pair-form",
  async () => {
    let pairingCode = $("code").value.trim();
    if (pairingCode.startsWith("https://")) {
      const link = new URL(pairingCode);
      if (link.origin !== location.origin)
        throw new Error("Use o link de conexão deste computador.");
      pairingCode = new URLSearchParams(link.hash.slice(1)).get("pair") ?? "";
    }
    await api("pair", { code: pairingCode, name: $("name").value.trim() });
    $("code").value = "";
    message("Aparelho conectado.");
    await refresh();
  },
  "submit",
);
action(
  "preferences",
  async () => {
    const preferences = Object.fromEntries(
      ["completed", "failed", "approval", "input"].map((key) => [
        key,
        $("preferences").elements[key].checked,
      ]),
    );
    await api("preferences", preferences);
    message("Preferências salvas para este aparelho.");
  },
  "submit",
);
action("enable", async () => {
  if (ios && !standalone)
    throw new Error("Adicione o Synara à Tela de Início e abra pelo ícone antes de ativar.");
  if (!("Notification" in window) || !("PushManager" in window))
    throw new Error(
      "Use Chrome ou Samsung Internet atualizado no Android, ou o app da Tela de Início no iOS 16.4 ou mais recente.",
    );
  // Request directly from the user's tap; iOS requires this gesture.
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(
      "Permita notificações do Synara nas configurações do aparelho ou navegador e tente novamente.",
    );
  await navigator.serviceWorker.register("/mobile/sw.js", { scope: "/" });
  const registration = await navigator.serviceWorker.ready;
  const raw = atob(status.publicKey.replace(/-/g, "+").replace(/_/g, "/"));
  const applicationServerKey = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  let existing = await registration.pushManager.getSubscription();
  if (existing && !status.subscribed) {
    await existing.unsubscribe();
    existing = await registration.pushManager.getSubscription();
    if (existing)
      throw new Error(
        "Não foi possível renovar a inscrição. Feche o app e tente ativar novamente.",
      );
  }
  const subscription =
    existing ||
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));
  await api("subscribe", subscription.toJSON());
  message("Notificações ativadas. Envie um teste para conferir.");
  await refresh();
});
action("test", async () => {
  await api("test", {});
  message("Teste na fila de envio. Confira a Central de Notificações.");
  setTimeout(() => refresh().catch(() => {}), 2500);
});
action("disable", async () => {
  await api("unsubscribe", {});
  // Server opt-out is authoritative even if browser cleanup fails offline.
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {}
  message("Notificações desativadas neste aparelho.");
  await refresh();
});
action("logout", async () => {
  await api("logout", {});
  message("Aparelho desconectado.");
  await refresh();
});
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/mobile/sw.js", { scope: "/" }).catch(() => {});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseAvailability();
  else void refreshAvailability();
});
window.addEventListener("online", () => void refreshAvailability());
window.addEventListener("pagehide", () => {
  pageActive = false;
  pauseAvailability();
});
window.addEventListener("pageshow", () => {
  pageActive = true;
  void refreshAvailability();
});
refresh()
  .catch(() => message(connectionError))
  .finally(scheduleAvailability);
