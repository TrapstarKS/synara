# Background native controls — revision 41

This change builds on revision 40's native file-dialog corrections. It improves
the existing computer-use path through exact Accessibility controls; it does not
add an unrestricted AppleScript executor or silently activate applications.

## Behavior

Native collection entries can expose a writable `AXSelected` without any
`AXActionNames` or writable `AXValue`. The tree previously excluded those entries
from its indexed controls, so server-side support for file rows alone was not
enough. Such entries now publish a retained token, `selectable:true` and their
observed selection state. The server offers `select` only for supported collection
roles on a driver reporting revision 41 or newer.

A single click on an eligible ref uses an exact selection write, even when the
item also advertises AXPress. This keeps selection distinct from opening. Double
clicks can use advertised AXOpen, and right clicks can use advertised AXShowMenu.
These routes preserve the original element token and never fall through to
coordinates after dispatch. A missing action on a retained ref is a refusal,
not a guessed physical click. Modified gestures retain their existing rules.
Explicit foreground single clicks keep their former action rather than selecting
the background-only AXSelected route.

Exact selection writes use the cancellation and modal gate, check writability
and read back AXSelected on the same item. They never try a parent, another
control or a pointer route. An error after submission remains uncertain.

Native exact text insertion now accepts `atomic:true` together with
`semantic_only:true`. It submits the complete string in one AXSelectedText write
at the existing caret or selection, instead of one write per character. Atomic
requests reject desktop, foreground and physical-input forms before dispatch.
The prior character-paced mode remains available. The server opts into atomic
delivery only on revision 41 or newer; web-content fields retain their separate
existing route. An uncertain exact write never triggers physical key synthesis.

Structured values now preserve actual empty strings, whitespace, newlines and
Unicode. Presentation placeholders remain separate from raw AXValue. A missing
value means unreadable/unknown rather than blank. Observations and diffs also
carry selected:true/false; a diff uses selected:null when that fact becomes
unknown.

## Validation and limits

The native macOS library suite passed 485 tests, with 4 ignored. Backend,
manager, targeting, gateway and guidance passed 588 distinct tests (the final
backend/manager pass contains 323). Desktop host, ownership, sockets and artifact
checks passed 220 tests; shared protocol checks passed 33. Coverage includes
revision-gated features, exact selection, one-request Unicode text insertion,
native errors, cancellation, unsupported gestures and no coordinate fallback.
The atomic helper test confirms one setter invocation for the entire payload;
it is not a measurement of real application latency or end-to-end task success.

Workspace typechecking passed all 7 packages, and the final server typecheck
also passed. Lint completed with 0 errors and 766 warnings; the Windows runtime
boundary check passed across 308 application files. The root formatting check
reported only 9 pre-existing generated artifacts under `Artifacts/release-0.9.21`;
those artifacts were preserved. Build/provenance and host protocol checks are
recorded in the task's local logs under `.tmp/cua-background-*`.

The passive observer was checked again on October 2, 2026 and reported
`axTrusted:false`, `axWindowSymbol:true`, `slsSpace:true`. The report is
`.tmp/cua-background-permission-probe.json`. No native input was attempted in
that permission check. This is the permission status of the independently built
observer, not proof about the installed Synara application's grants. Live
application behavior and freedom from focus changes remain unqualified until a
trusted, independently observed UI run is completed.

This revision does not solve native token rotation between snapshots, add
background support to every custom-drawn control, or certify parity with a
different computer-use product. The revision 40 picker fixture and its recorded
limits remain documented in `native-file-dialogs-2026-10-02.md`.

## Local build

The manifest pins native revision 41 and patch SHA-256
`050015302a14cd2e1e39bdbada9b09136d9e87c5acd172d3d02d8ccefaa7d1aa`.
The normal provisioning script reconstructs the source from pinned upstream
commit `7fe7c33f741ee2dd5961ba80044d59f93b48ba47` plus that patch. Local output is
`.tmp/cua-background-release/`; it is an ad-hoc-signed macOS arm64 driver, not a
notarized application release. The installed application is not replaced.

The release build, strict local signature verification and provenance checks
passed. Its executable SHA-256 is
`9c8cbe7c5757f4ae070426d15f497e43fce6b17287d60dbc6af067a25979cc3d`.
