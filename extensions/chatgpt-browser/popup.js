const status = document.getElementById("status");
const clear = document.getElementById("clear");
const version = document.getElementById("version");

version.textContent = `Synara ChatGPT bridge v${chrome.runtime.getManifest().version}`;

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (value) => {
    if (chrome.runtime.lastError || !value?.paired) {
      status.textContent = "Not paired. Click Sign in to ChatGPT in Synara.";
      return;
    }
    status.textContent = value.connected
      ? "Connected to local Synara."
      : "Paired; waiting for local Synara.";
  });
}

clear.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clear" }, () => {
    status.textContent = "Pairing forgotten.";
  });
});

refresh();
