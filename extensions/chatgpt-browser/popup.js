const status = document.getElementById("status");
const clear = document.getElementById("clear");

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
