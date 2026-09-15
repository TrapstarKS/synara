const token = new URL(location.href).searchParams.get("token");
const status = document.getElementById("status");

if (token && status) {
  chrome.runtime.sendMessage({ type: "pair", origin: location.origin, token }, (response) => {
    if (chrome.runtime.lastError) {
      status.textContent = "Could not reach the Synara extension. Check that it is loaded.";
      return;
    }
    status.textContent = response?.ok
      ? "Connected. You can close this tab and use ChatGPT normally."
      : `Could not connect: ${response?.error || "unknown error"}`;
  });
}
