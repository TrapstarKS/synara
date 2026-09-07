if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/mobile/sw.js", { scope: "/" }).catch(() => {});

// A single optional DOM integration point, outside the upstream source tree.
// Follow the existing trigger's styling and let the header allocate space.
const link = document.createElement("a");
link.href = "/mobile";
link.setAttribute("aria-label", "Notificações no celular");
link.title = "Notificações no celular";
link.dataset.synaraMobile = "settings";
link.innerHTML =
  '<span data-slot="central-icon" aria-hidden="true" style="display:inline-block;width:16px;height:16px;background:currentColor;mask:url(/central-icons-reversed/bell.svg) center/contain no-repeat;-webkit-mask:url(/central-icons-reversed/bell.svg) center/contain no-repeat"></span>';
let scheduled = false;
function attach() {
  scheduled = false;
  if (link.isConnected) return;
  const trigger = document.querySelector('[data-slot="sidebar-trigger"]');
  if (!trigger?.parentElement) return;
  link.className = trigger.className;
  trigger.after(link);
}
const observer = new MutationObserver(() => {
  if (!link.isConnected && !scheduled) {
    scheduled = true;
    requestAnimationFrame(attach);
  }
});
observer.observe(document.body, { childList: true, subtree: true });
attach();
