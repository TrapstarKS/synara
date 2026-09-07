const $ = (id) => document.getElementById(id);
let status;
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
const code = new URLSearchParams(location.hash.slice(1)).get("pair");
if (code) {
  $("code").value = code;
  history.replaceState(null, "", "/mobile");
}
const message = (value) => {
  $("message").textContent = value;
};
async function api(path, value) {
  const response = await fetch(
    "/mobile/api/" + path,
    value === undefined
      ? {}
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
async function refresh() {
  status = await api("status");
  $("pair").hidden = status.paired;
  $("paired").hidden = !status.paired;
  $("install").hidden = Boolean(standalone);
  $("connection").textContent = !status.paired
    ? "Não conectado"
    : status.monitor.state === "connected"
      ? "Mac conectado"
      : "Mac indisponível";
  if (!status.paired) return;
  $("device-name").textContent = status.name;
  for (const key of Object.keys(status.preferences))
    $("preferences").elements[key].checked = status.preferences[key];
  let browserSubscription = null;
  if (
    "serviceWorker" in navigator &&
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    const registration = await navigator.serviceWorker.getRegistration("/");
    browserSubscription = await registration?.pushManager?.getSubscription();
    // Reconcile a rotated endpoint without asking for permission outside a tap.
    if (browserSubscription && status.subscribed)
      await api("subscribe", browserSubscription.toJSON());
  }
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
    ? "A entrega falhou. Confira a internet do Mac e envie um novo teste."
    : status.lastPushAt
      ? "Último envio: " + new Date(status.lastPushAt).toLocaleString("pt-BR")
      : "";
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
action(
  "pair-form",
  async () => {
    let pairingCode = $("code").value.trim();
    if (pairingCode.startsWith("https://")) {
      const link = new URL(pairingCode);
      if (link.origin !== location.origin) throw new Error("Use o link de conexão deste Mac.");
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
      "Este navegador não oferece notificações. Use o app da Tela de Início com iOS 16.4 ou mais recente.",
    );
  // Request directly from the user's tap; iOS requires this gesture.
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error("Permita notificações do Synara nos Ajustes do iPhone e tente novamente.");
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
refresh().catch(() =>
  message("Não foi possível conectar. Confira o Tailscale e tente abrir novamente."),
);
