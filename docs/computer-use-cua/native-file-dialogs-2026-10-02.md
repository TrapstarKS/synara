# Native macOS file-dialog corrections

The changes address file-picker control discovery and exact keyboard delivery in
native Open/Save dialogs. They ship as native revision 40 plus server observation
and guidance updates. This is not a signed release or a live-provider certificate.

## Corrected paths

The native keyboard gate previously lost the addressed control before modal
validation. A shared-window sheet could therefore reject a shortcut despite the
control having passed an earlier focus check. The keyboard-only gate now retains
and rechecks the focused control, modal ancestry and exact PID/window through the
key-down admission. Pointer and generic input rules remain independent.

An AXSheet with its own native window id is a window-scoped surface. Admission
and observation now consult the same application-level window sources; an
unmapped sheet never becomes an arbitrary parent or sibling window.

The server's bounded element list now retains unnamed native fields and native
collection entries, including file rows. It publishes supported AX actions and
preserves the original token behind each public ref. Static text without actions
does not occupy these control slots. Canonical action names such as AXOpen map to
the existing native action and still require the element to advertise support.

The file-dialog help chapter covers discovering the actual owner (which can be
Open and Save Panel Service), Go to Folder, literal paths with spaces and Unicode,
and independent confirmation of the selected file. A clean modal refusal explains
how to observe the dialog; an uncertain dispatch does not invite replay.

## Automated validation

The macOS arm64 native library suite passed 479 tests with 4 ignored. Server
backend, targeting and help passed 213 tests; the final gateway suite passed 212.
Desktop host, ownership, socket and Linux-host checks passed 180 tests, shared
protocol passed 33, and provenance/cache-key validation passed 40 under Vitest.
These checks cover admission, cancellation, retained refs, canonical actions,
path values and bounded discovery; they do not prove a real Open panel accepted
the input.

The workspace typecheck passed all 7 packages. Lint completed with 0 errors and
766 warnings. The Windows runtime boundary check passed across 308 application
files. Formatting passed for all 13 changed formatter-supported files. The root
formatting check reported 9 pre-existing generated files under
`Artifacts/release-0.9.21`; these artifacts were left unchanged. Source diff
whitespace checks passed; context-only blank lines inside the generated native
patch are patch syntax and were excluded from the outer repository whitespace
check.

The normal provisioning script rebuilt revision 40 offline from an archive of
the pinned upstream commit plus the checked-in patch, rather than the modified
scratch checkout. The local macOS arm64 output is
`.tmp/cua-file-dialog-release/`. Its patch SHA-256 is
`db52cb19223a902a1033b031ddb46a08c8952026b4532623f261b33c6ff1fe34`.
The build uses a local ad-hoc signature; it is not a notarized application release
and does not replace the installed application.

Native refs used for batch conditions and waits are checked by their private
identity rather than an empty label or ordinal. Native tokens may rotate between
snapshots: a token not reidentified by a fresh read produces an explicit refusal,
not proof that the original control disappeared. These tests qualify that
refusal behavior, not cross-snapshot wait completion on the live driver.

Both the AppKit fixture and passive focus observer compiled locally. The fixture
uses its own temporary directory and generated files, reports selected URLs from
AppKit's completion callback and never opens their contents. Save verifies the
chosen URL without creating a document. Parent and sibling controls provide an
independent check against input arriving at the wrong window.

## Live attempt and remaining qualification

The baseline run stopped at the passive observer's permission preflight:
`axTrusted:false`, `axWindowSymbol:true`, `slsSpace:true`. No fixture application,
driver, file dialog or native input was started. The observer exited successfully.
This is the permission state of the separately compiled observer, not evidence
about the installed Synara application's permissions or the original incident.

The retained local report is
`.tmp/cua-file-dialog-evidence/baseline/native-file-dialog-SnHNLc/report.json`.
Its calls, observations and cases are empty; `open-sheet` is explicitly not run.
Live Open/Save, Go to Folder consumption, provider behavior and signed distribution
remain unqualified. Cross-process panels not independently declared by this
fixture are outside its runtime coverage.

## Reproduction

Build the fixture and existing observer separately, with output paths suitable for
the local checkout:

```sh
xcrun swiftc scripts/computer-use-fixtures/NativeFileDialogFixture.swift -o /absolute/path/native-file-dialog-fixture
clang -fobjc-arc -O2 scripts/computer-use-fixtures/focus_probe.m -o /absolute/path/focus-probe -framework AppKit -framework ApplicationServices -framework CoreGraphics
```

Run the driver fixture with explicit executable paths and existing macOS grants:

```sh
node scripts/computer-use-fixtures/native-file-dialog-regression.mjs \
  --driver /absolute/path/cua-driver \
  --fixture /absolute/path/native-file-dialog-fixture \
  --focus-probe /absolute/path/focus-probe \
  --out /absolute/path/evidence \
  --case open-sheet
```

Omitting `--case` runs open-sheet, open-standalone, save-sheet, cancel-sheet and
parent-refusal in order. The runner stops input at the first failure, never grants
permissions, never activates applications, and does not retry uncertain input.
