# Synara Mobile

An optional companion for this fork: the existing Synara UI, installed on Android/Samsung or iPhone, with per-device Web Push preferences. It runs alongside the desktop on Windows or macOS. The Windows bridge uses the desktop credential in the private server runtime file; build scripts, workspace manifests and Actions are unchanged.

## Architecture

```text
Android / iPhone / another computer
  └─ Tailscale HTTPS :8443 (tailnet only)
       └─ Mobile companion 127.0.0.1:58091
            ├─ pairing, device preferences, Web Push queue
            ├─ authenticated HTTP/WebSocket proxy → live Synara.app backend
            └─ read-only negotiated shell stream → lifecycle notifications
```

The companion serves `/mobile` and injects a manifest, service worker registration, theme-token bridge, and a preferences link into the proxied HTML. On macOS it discovers the installed `Synara.app` process and verifies its listener. On Windows it reads `%USERPROFILE%\.synara\userdata\server-runtime.json`, verifies owner-only ACLs, and challenges the live server with its existing runtime proof before supplying the desktop credential on the local hop. Windows requires a Synara version containing this runtime-file change; older binaries cannot advertise the credential. Port and credential changes are picked up after an app restart. Conversation rendering, sending messages, tool approvals, interruption, and provider behavior remain owned by that same Synara instance.

The installed app opens the original Synara conversation surface. A bell beside the existing sidebar trigger opens mobile preferences; it adopts the trigger's classes and occupies normal header space. The one optional DOM hook is `[data-slot="sidebar-trigger"]`. If upstream removes it, `/mobile` remains directly available. Preferences reuse Synara's official logo/icons, neutral colors, and system UI font. After visiting Synara, the page follows its active color tokens via a local theme snapshot; a first visit follows the OS light/dark preference.

Web Push is the same approach used by Colmeia. The host computer sends encrypted notifications to the browser's push service; the phone need not keep the app open. Push delivery needs internet. Opening and controlling a conversation requires Tailscale connectivity and an awake computer with Synara running. iPhone users need iOS 16.4 or later and must open the installed Home Screen app to grant notification permission. This is a PWA, not an App Store binary.

## Run

Prerequisites: Node 24.13.1+, Synara desktop installed and open, Tailscale on both devices, tailnet HTTPS enabled.

From the repository root:

```sh
npm ci --prefix extensions/mobile-remote
SYNARA_MOBILE_ORIGIN=https://your-mac.your-tailnet.ts.net:8443 \
  node extensions/mobile-remote/server.mjs
tailscale serve --bg --https=8443 http://127.0.0.1:58091
node extensions/mobile-remote/cli.mjs pair
```

Do not replace an existing Tailscale Serve configuration. Check `tailscale serve status` first. A separate HTTPS port preserves Colmeia on port 443. Never enable Funnel for this service.

The printed pairing URL contains a secret valid once for 15 minutes. Open `/mobile` on iPhone Safari, add it to the Home Screen, open the new app, and paste the code from the pairing link. A code consumed in Safari may not carry into the installed app's cookie storage; generate another with `pair` if necessary. Codes are submitted as JSON, never as a query parameter or request-log entry.

Select the notification categories, press **Salvar preferências**, then **Ativar notificações** and **Enviar teste**. Tap a task notification to open its conversation. iOS does not offer the Android-style approval buttons on the notification itself; approve within the opened conversation.

If you installed an earlier preview with the temporary icon/start page, iOS may retain that installation metadata. Re-add the app from Safari for the official icon and conversation start page, and generate a fresh pairing code if its browser storage was cleared.

### Windows (PowerShell)

Run these from the checkout on **each Windows computer**, as the same user who runs Synara:

```powershell
npm ci --prefix extensions/mobile-remote
tailscale serve status
node extensions/mobile-remote/service.mjs install --origin https://your-pc.your-tailnet.ts.net:8443
tailscale serve --bg --https=8443 http://127.0.0.1:58091
node extensions/mobile-remote/service.mjs status
node extensions/mobile-remote/cli.mjs pair
```

Use that computer's actual MagicDNS name. The scheduled task **Synara Mobile Remote** starts immediately and at that user's login, with bounded crash retries. It runs without elevation, does not start/restart Synara, and follows the desktop's port/token after later restarts. Keep Windows awake and logged in with Synara open; locking the screen is fine. If policy requires elevation to register tasks, use PowerShell elevated as the **same user**, not another administrator account. Uninstall stops only the companion task; devices/data and Tailscale configuration remain.

For a foreground run instead of a login task:

```powershell
$env:SYNARA_MOBILE_ORIGIN = 'https://your-pc.your-tailnet.ts.net:8443'
node extensions/mobile-remote/server.mjs
```

Run `cli.mjs pair` from another terminal. The login task uses `%USERPROFILE%\.synara-mobile`; a foreground process can use `SYNARA_MOBILE_HOME`. If your desktop uses another home, set `SYNARA_MOBILE_DESKTOP_HOME` before installation. The Windows bridge rejects shared state directories: keep credentials under your private user profile.

### Install on Samsung / Android

1. Connect the phone to the same Tailscale network and open the pairing link in Chrome or Samsung Internet.
2. Use **Instalar Synara** when offered. Chrome also has **⋮ → Adicionar à tela inicial → Instalar**; Samsung Internet offers its install icon or **☰ → Adicionar página a → Tela inicial** (labels vary by version).
3. Open Synara from its new icon, pair there, and optionally enable/test notifications. If pairing was already consumed in a separate browser context, generate a new link.
4. Open the conversations page to create threads, send prompts, approve tools, interrupt or resume work on that computer.

Each computer has a separate HTTPS origin, pairing and project/thread history. Open or install each host's address to choose where work runs. Tailscale connects the devices; the companion does not merge histories or move processes between machines. The computer still needs its provider CLI installed and signed in. Nothing needs a public inbound port or Funnel.

### Keep it running on this Mac

Stop the terminal companion started above, then install the login service:

```sh
node extensions/mobile-remote/service.mjs install --origin https://your-mac.your-tailnet.ts.net:8443
node extensions/mobile-remote/service.mjs status
```

This keeps one companion on port 58091. It starts at login and restarts after a crash while following the canonical `~/.synara` data opened by `Synara.app`; it never starts a second Synara database. If the desktop app is closed, the phone shows a reconnecting page instead of a blank response and resumes when Synara opens. Keep this checkout at the installed path and rerun installation after moving it or changing the Node runtime. The Mac must remain awake, logged in, and online for remote work.

To remove the login services, run `node extensions/mobile-remote/service.mjs uninstall`. Saved data and Tailscale configuration are preserved. Disable only this HTTPS listener with `tailscale serve --https=8443 off` if you also want to remove remote access.

## Configuration

| Environment variable     | Default                  | Meaning                                                              |
| ------------------------ | ------------------------ | -------------------------------------------------------------------- |
| `SYNARA_MOBILE_ORIGIN`   | `https://localhost:8443` | Exact HTTPS origin used by the phone.                                |
| `SYNARA_MOBILE_UPSTREAM` | auto-discovered          | Explicit loopback origin override for development and tests.         |
| `SYNARA_MOBILE_DESKTOP_HOME` | `~/.synara` | Desktop data home used for discovery. |
| `SYNARA_MOBILE_UPSTREAM_TOKEN` | unset | Token for an explicit development upstream. |
| `SYNARA_MOBILE_PORT`     | `58091`                  | Companion loopback port.                                             |
| `SYNARA_MOBILE_HOME`     | `~/.synara-mobile`       | Private keys, sessions, preferences, checkpoint, and pending pushes. |

Automatic discovery supports macOS and Windows. An explicit upstream override must accept the read-only companion connection from loopback; use it only for development or tests. The browser proxy preserves Synara's authentication policy and never sends the desktop credential to the phone.

## Devices and recovery

```sh
node extensions/mobile-remote/cli.mjs devices
node extensions/mobile-remote/cli.mjs revoke DEVICE_ID
node extensions/mobile-remote/cli.mjs pair
```

Administration uses a private Unix socket on macOS; Windows uses a per-home named pipe plus a bearer credential from the owner-private data store. Sessions expire after 90 days. Revoke a lost phone on its host computer; its browser and sockets lose access. Each device controls its own preferences. Tokens are stored as hashes. Web Push subscriptions and VAPID keys stay in the private data directory; do not commit or share it.

Notification defaults: main task completed/failed, approval needed, user input needed. Subagent completion, stop and failure do not produce lifecycle alerts; subagent requests that need your approval or answer still link to that child conversation. The filter applies to live updates, delayed completions and reconnect recovery, including older checkpoints.

Alerts now show the task title and up to 200 characters of context: the final assistant result, failure reason, approval action or pending question. Common credential formats are redacted and Markdown is reduced to plain text. These previews can appear on the phone's lock screen. An eligible alert makes one read-only `orchestration.getThreadDetailSnapshot` request using the negotiated local connection settings, limited to two seconds and 8 MiB; unavailable/oversized details fall back to the task title and a description of the required action. Full transcripts are not retained by the companion. Its checkpoint retains bounded task titles and lifecycle metadata; the durable push queue retains the short notification preview until delivery or expiry.

Android supports a **Responder**, **Revisar ação** or **Ver conversa** button when the browser offers notification actions. Buttons and notification taps open the conversation; they never approve or execute work directly. Alerts of the same kind for one thread replace their previous notification instead of stacking. Event deduplication and per-device preferences still apply.

Delivery has a one-hour expiry and bounded retries; invalid subscriptions are removed. Web Push is best effort, not a guaranteed paging system.

The monitor negotiates Synara protocol epoch/revision 1 and stops on incompatibility instead of guessing a new protocol. First connection establishes a silent baseline. After reconnect it compares known tasks' latest state with a bounded checkpoint, recovering at most 20 recent changes from the last 24 hours. The shell protocol is a state stream, not a full event history: intermediate states, tasks first seen during downtime, or consecutive approval requests with an unchanged boolean flag can be missed. Do not treat a lack of notification as proof no work needs attention.

If a device cannot resolve the `ts.net` name, check `tailscale dns status`. MagicDNS may be disabled locally even while it is enabled for the tailnet. Configure Tailscale DNS on the device used to open the app. Do not bypass a certificate warning.

## Desktop consumer signature

macOS releases use the persistent ad-hoc `TrapRAM Signing` identity so updates keep the same code-signing identity. Before local publication, verify leaf SHA-1 `0a15f0539b0f02a8d880e637b0c2744f1f0b5dfb`, select the identity explicitly with `CSC_NAME=TrapRAM Signing`, and use `SYNARA_MAC_SIGNING_MODE=adhoc`. The manually dispatched **Release Desktop** workflow uses this same identity from repository secrets, publishes macOS and Windows artifacts, and includes both updater channels. The companion remains a separate installation; a desktop release does not restart or deploy it. This certificate is not notarized, so macOS may require `xattr -cr /Applications/Synara.app` once after the first DMG download, just as with TrapRAM.

## Update the fork

### Windows compatibility audit (2026-09-12)

- The Effect Node patch forwards Windows quoting and hidden-process flags. Remote turns use the same orchestration/provider launch path as local turns. The Windows integration test now exercises the shared Effect launcher; actual Win32 execution must be checked on Windows.
- The Legend List scroll patch is browser JavaScript without an OS-specific branch; no Windows-only dependency was found in that patch.
- **The bundled Luna/Fast Codex is not available on Windows.** Its Rust patch is platform-neutral, but the release, updater and desktop bundle only provide `aarch64-apple-darwin`. Windows uses the configured external Codex. Supporting the managed patch there needs a Windows artifact and build/Actions work, intentionally left to the separate build task.
- The mobile companion has Windows discovery, an authenticated admin pipe and a per-user login task. Tests on macOS cover discovery/proof/rotation, proxy authentication, pairing/revocation and Android installation UI. A Windows machine is still required to verify Task Scheduler, ACLs, named pipes and an actual provider turn end to end.

Run the extension suite on Windows with `node --test extensions/mobile-remote/lib/*.test.mjs`. The optional `SYNARA_MOBILE_LIVE_TEST=1` test still expects macOS tools and an existing server build; leave it disabled on Windows. No active Synara instance needs to be restarted to run the default isolated fixtures.

`origin` is your fork; `upstream` is the original Synara repository. Keep `main` as the upstream baseline and this feature on `codex/mobile-remote` until you choose to merge it.

```sh
git fetch upstream
git merge upstream/main
npm ci --prefix extensions/mobile-remote
node --test extensions/mobile-remote/lib/*.test.mjs
```

All custom source lives under `extensions/mobile-remote`. This minimizes textual merge conflicts, but no integration can promise permanent compatibility: protocol and HTML changes still require running the adapter/proxy tests and a real conversation smoke check. If upstream adds the same directory, resolve that naming collision explicitly.

## Validation

```sh
node --test extensions/mobile-remote/lib/*.test.mjs
```

Tests cover pairing, session revocation, preferences, proxy transport, URL restrictions, lifecycle baseline/deduplication, reconnection, and compatibility failure. A real iPhone acceptance check is still necessary: install, pair, allow push, receive test with the app closed, change categories, and open/respond to a real task from its notification.

The root repository requires explicit user authorization before running its `bun fmt`, `bun lint`, and `bun typecheck` gates. These standalone tests do not replace those gates.

## References

- Synara's logo and PNG icons are copied unchanged from `apps/web/public`; the header bell references the upstream-served Central Icons asset instead of redistributing a separate copy. Their original notices and provenance remain with the upstream repository.
- Colmeia (the user's local checkout): reference for PWA, Tailscale Serve, and Web Push architecture; this implementation does not import its runtime.
- [Apple/WebKit: Web Push for iOS Home Screen apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Android installability requirements](https://web.dev/articles/install-criteria)
- [Samsung Internet PWA support](https://developer.samsung.com/internet/android/web-developer-guide.html)
- [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)
