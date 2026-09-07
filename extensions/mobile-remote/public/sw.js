self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
// Do not cache chats, credentials, API responses, or upstream bundles.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || "Synara", {
      body: data.body || "Há uma atualização no seu trabalho.",
      icon: "/mobile/icon.png",
      tag: data.tag || "synara",
      data: { url: safePath(data.url) },
    }),
  );
});
function safePath(value) {
  try {
    const url = new URL(value || "/mobile", self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : "/mobile";
  } catch {
    return "/mobile";
  }
}
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safePath(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows)
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(url);
          await client.focus();
          return;
        }
      await self.clients.openWindow(url);
    })(),
  );
});
