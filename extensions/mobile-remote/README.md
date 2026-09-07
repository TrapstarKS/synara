# Synara Mobile

An optional companion for this fork: the existing Synara UI, installed on an iPhone Home Screen, with per-device Web Push preferences. It runs alongside Synara and requires **no modifications to upstream application files, contracts, package manifests, or lockfiles**.

## Architecture

```text
iPhone Home Screen app
  └─ Tailscale HTTPS :8443 (tailnet only)
       └─ Mobile companion 127.0.0.1:58091
            ├─ pairing, device preferences, Web Push queue
            ├─ authenticated HTTP/WebSocket proxy → Synara 127.0.0.1:58090
            └─ read-only negotiated shell stream → lifecycle notifications
```

The companion serves `/mobile` and injects a manifest, service worker registration, theme-token bridge, and a preferences link into the proxied HTML. Conversation rendering, sending messages, tool approvals, interruption, and provider behavior remain owned by Synara. Local access to Synara keeps working independently.

The installed app opens the original Synara conversation surface. A bell beside the existing sidebar trigger opens mobile preferences; it adopts the trigger's classes and occupies normal header space. The one optional DOM hook is `[data-slot="sidebar-trigger"]`. If upstream removes it, `/mobile` remains directly available. Preferences reuse Synara's official logo/icons, neutral colors, and system UI font. After visiting Synara, the page follows its active color tokens via a local theme snapshot; a first visit follows the OS light/dark preference.

Web Push is the same approach used by Colmeia. The Mac sends encrypted notifications to the browser's push service; the phone need not keep the app open. Push delivery needs internet. Opening and controlling a conversation requires Tailscale connectivity and a running Mac/Synara. iPhone users need iOS 16.4 or later and must open the installed Home Screen app to grant notification permission. This is a PWA, not an App Store binary.

## Run

Prerequisites: Node 24.13.1+, built Synara, Tailscale on both devices, tailnet HTTPS enabled.

From the repository root:

```sh
npm ci --prefix extensions/mobile-remote
# Build the unchanged upstream app if needed:
bun run build --filter=@synara/cli
# A dedicated home avoids altering another running Synara instance:
env -u SYNARA_AUTH_TOKEN -u VITE_DEV_SERVER_URL node apps/server/dist/index.mjs \
  --home-dir "$HOME/.synara-preview-synara" --host 127.0.0.1 --port 58090 --no-browser
```

In another terminal, substitute your own Tailscale DNS name:

```sh
SYNARA_MOBILE_ORIGIN=https://your-mac.your-tailnet.ts.net:8443 \
  node extensions/mobile-remote/server.mjs
tailscale serve --bg --https=8443 http://127.0.0.1:58091
node extensions/mobile-remote/cli.mjs pair
```

Do not replace an existing Tailscale Serve configuration. Check `tailscale serve status` first. A separate HTTPS port preserves Colmeia on port 443. Never enable Funnel for this service.

The printed pairing URL contains a secret valid once for 15 minutes. Open `/mobile` on iPhone Safari, add it to the Home Screen, open the new app, and paste the code from the pairing link. A code consumed in Safari may not carry into the installed app's cookie storage; generate another with `pair` if necessary. Codes are submitted as JSON, never as a query parameter or request-log entry.

Select the notification categories, press **Salvar preferências**, then **Ativar notificações** and **Enviar teste**. Tap a task notification to open its conversation. iOS does not offer the Android-style approval buttons on the notification itself; approve within the opened conversation.

If you installed an earlier preview with the temporary icon/start page, iOS may retain that installation metadata. Re-add the app from Safari for the official icon and conversation start page, and generate a fresh pairing code if its browser storage was cleared.

### Keep it running on this Mac

Stop the terminal previews you started above, then install the two login services:

```sh
node extensions/mobile-remote/service.mjs install --origin https://your-mac.your-tailnet.ts.net:8443
node extensions/mobile-remote/service.mjs status
```

This uses ports 58090/58091 and preserves `~/.synara-preview-synara` by default. Set `--synara-home /absolute/path` if you deliberately chose another home. It refuses to compete with unmanaged listeners. Both services start at login and restart after a crash. Keep this checkout and its built files at the installed path; rerun installation after moving it or changing the Node runtime. The Mac must remain awake and online for remote work.

To remove the login services, run `node extensions/mobile-remote/service.mjs uninstall`. Saved data and Tailscale configuration are preserved. Disable only this HTTPS listener with `tailscale serve --https=8443 off` if you also want to remove remote access.

## Configuration

| Environment variable     | Default                  | Meaning                                                              |
| ------------------------ | ------------------------ | -------------------------------------------------------------------- |
| `SYNARA_MOBILE_ORIGIN`   | `https://localhost:8443` | Exact HTTPS origin used by the phone.                                |
| `SYNARA_MOBILE_UPSTREAM` | `http://127.0.0.1:58090` | Existing Synara loopback HTTP origin.                                |
| `SYNARA_MOBILE_PORT`     | `58091`                  | Companion loopback port.                                             |
| `SYNARA_MOBILE_HOME`     | `~/.synara-mobile`       | Private keys, sessions, preferences, checkpoint, and pending pushes. |

The upstream must accept the read-only companion connection from loopback. The browser proxy preserves Synara's own cookies and authentication; it does not disable the upstream authentication policy. This initial setup uses an isolated loopback Synara instance. Do not point it at a server whose authentication setup has not been verified.

## Devices and recovery

```sh
node extensions/mobile-remote/cli.mjs devices
node extensions/mobile-remote/cli.mjs revoke DEVICE_ID
node extensions/mobile-remote/cli.mjs pair
```

Administration uses a mode-0600 Unix socket in a mode-0700 data directory. Sessions expire after 90 days. Revoke a lost phone on the Mac; its browser and sockets lose access. Each device controls its own preferences. Tokens are stored as hashes. Web Push subscriptions and VAPID keys stay in the private data directory; do not commit or share it.

Notification defaults: task completed, task failed, approval needed, user input needed. Notification text is generic and does not contain task titles, prompts, code, or answers. Delivery has a one-hour expiry and bounded retries; invalid subscriptions are removed. Web Push is best effort, not a guaranteed paging system.

The monitor negotiates Synara protocol epoch/revision 1 and stops on incompatibility instead of guessing a new protocol. First connection establishes a silent baseline. After reconnect it compares known tasks' latest state with a bounded checkpoint, recovering at most 20 recent changes from the last 24 hours. The shell protocol is a state stream, not a full event history: intermediate states, tasks first seen during downtime, or consecutive approval requests with an unchanged boolean flag can be missed. Do not treat a lack of notification as proof no work needs attention.

If the Mac cannot resolve the `ts.net` name, check `tailscale dns status`. MagicDNS may be disabled locally even while it is enabled for the tailnet. Configure Tailscale DNS on the device used to open the app. Do not bypass a certificate warning.

## Desktop consumer signature

The fork's desktop release workflow uses the persistent ad-hoc `TrapRAM Signing` certificate so an update keeps the same macOS code-signing identity. Add the existing `MAC_CERT_P12` and `MAC_CERT_PASSWORD` secrets from the TrapRAM repository to the fork's **Settings → Secrets and variables → Actions** page. The workflow pins the current leaf fingerprint and stops if a different certificate is supplied. This certificate is not notarized; macOS may require `xattr -cr /Applications/Synara.app` once after the first DMG download, just as with TrapRAM. Subsequent signed updates use the same certificate automatically.

## Update the fork

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
- [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)
