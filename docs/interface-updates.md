# Updating the interface while agents keep running

The macOS desktop app can apply a compatible interface update from **View → Update
interface and reload** or the secondary option beside the sidebar update button.
This replaces only the web interface. The same desktop window, backend process,
provider sessions and native computer/browser hosts remain running.

The first installation containing this feature must use the normal app updater.
Earlier desktop versions do not have its preparation, verification or activation
handlers, so reloading an older installation cannot add the feature.

## What can be applied

A packaged release contains a `live-ui-manifest.json` next to the web entry point.
It records the interface version and a conservative fingerprint of runtime and
build inputs. An interface update is permitted only when its fingerprint matches
the running installation. Changes to the backend, preload, native code, shared
contracts, runtime dependencies or persisted client-state formats require a normal
full update. Preserving the storage format lets an older interface recover its
drafts if the replacement fails during startup. This also means
that some otherwise compatible releases are deliberately not eligible.

The interface version is displayed separately from the installed native version.
The ordinary full-update action remains available and still restarts the app and
backend. Downloading an update, preparing its assets, or finishing an HTML load
does not by itself mean that the interface update has been applied.

This path currently supports macOS packaged builds with a verifiable signing
certificate. Windows and Linux continue to use the normal app update. Remote HTTP
clients retain the web assets served by the running backend; a desktop interface
update does not change their version.

## Preparation and reload

Preparation joins the normal updater's download. It copies the pinned ZIP into a
private staging directory, checks its bytes and archive entries, and validates the
extracted app's signature against the installed app's startup signing certificate
and bundle identity. The candidate's manifest and package version must match the
selected update. Only verified web assets are copied into a separate generation;
the installed `.app`, executable, preload and `app.asar` are not overwritten.

Immediately before applying, the renderer checks for pending sends, uploads,
mutations and unsaved attachments. Editor buffers are flushed through the existing
writer, drafts and navigation state are persisted, and the final handoff briefly
blocks new renderer writes. A failed save or an uncertain pending operation leaves
the current interface in place.

A page hosted by a renderer-owned embedded browser depends on the document being
reloaded. The native application therefore defers this update while such a page
exists, including a page temporarily idle between agent tools. It never closes the
page to make the update proceed. Native browser views and an external ChatGPT
browser are separate from that document.

After activation, the replacement interface must confirm the exact attempt and
version, a connection to the same server instance, and a hydrated shell. Home can
confirm without loading any conversation detail. The app does not wait for every
open conversation to hydrate. Failed loads or a missing confirmation restore the
previous interface with one reload; they never escalate into stopping the backend.
Recovery also defers if an embedded browser page needs the current document.

Applied interface generations belong to the current app session. A later full
restart loads the interface shipped with the installed app unless the normal
updater has installed the newer release. Complete the full update when a restart
is convenient to make the new native and interface versions the installed baseline.

## Release verification

Build the web, server and desktop from one unchanged source checkout. The web build
emits the manifest. Native JavaScript build stamps record the same source identity
and hashes of their generated outputs. Packaging checks all three rather than
relabeling old `--skipBuild` artifacts with a new compatibility identity.

Release-version fields are normalized for compatibility comparisons, but dependency
versions are not. A UI-only change can keep the same runtime fingerprint; a runtime
change cannot obtain compatibility merely by retaining a protocol version.

Tests cover identity mismatch, unsafe archive entries, signer failure, coalesced
preparation, stale attempts, the same-server confirmation, rollback, browser-page
deferral and renderer-owned work. The isolated Electron smoke test used during
development verifies generation changes and rollback while a synthetic agent
process keeps the same PID and continues making progress. It is not a claim that
all provider-specific live workflows were exercised.
