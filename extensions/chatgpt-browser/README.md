# Synara ChatGPT Browser Bridge

This small Chromium extension lets Synara use an existing ChatGPT session in
the user's normal browser profile.

It does not request the `cookies` permission and does not read or export
cookies, local storage, access tokens, or session tokens. The extension only
connects to a loopback Synara server and uses the DevTools Protocol on tabs
whose URL is ChatGPT or its sign-in flow. It drives those tabs in place with
CDP input and never brings one to the foreground or changes which tab is
active, so Synara can send and stream while you keep working in another tab.

## One-time setup

1. In Chrome, Brave, or Arc, open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `extensions/chatgpt-browser` directory.
5. In Synara's ChatGPT (Web) settings, click **Sign in to ChatGPT**.

Synara opens a local pairing page and then `chatgpt.com` in the system-default
browser. The pairing page connects the extension automatically. Sign in there
if necessary; no login happens in Synara's embedded browser.

## After updating or restarting

- After pulling a newer Synara checkout, click **Reload** for this unpacked
  extension on `chrome://extensions` so its service worker uses the new bridge
  code.
- If the popup says **Paired; waiting for local Synara** after Synara restarted
  on a different local port, click **Sign in to ChatGPT** in Synara once to
  issue a fresh one-time pairing. You do not need to sign in to ChatGPT again.
