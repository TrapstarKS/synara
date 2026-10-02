# Computer-use reference continuity

This work follows the revision 40 file-dialog and revision 41 background-control
changes. It targets a reproducible interruption in multi-step work: observing the
same window could invalidate the handles the next step needed, even while the
controls themselves remained unchanged.

## Reproduced failures

Two integration regressions were first run against the existing server behavior.
A button changing its label from Next to Continue received a new public ref even
when its native token stayed identical. An identical-looking replacement with a
different token produced no added entry in a diff, so the response supplied no
usable current ref. Both tests failed before the changes and pass afterward.
The logs are `.tmp/cua-continuity-regressions-baseline.log` and
`.tmp/cua-continuity-server-final.log`.

The native cache had an additional source of churn: publishing an AX tree replaced
the prior snapshot for the same process/window. The gateway used the snapshot
token as native identity, so a fresh observation inside a wait or condition could
invalidate the reference it was checking. Screenshot-only captures do not publish
AX snapshots and were not the cause.

## Corrected observation behavior

The server identifies native refs by window, role and backend-owned identity,
independently of their changing label. A new observation of that identity updates
the retained node and its supported actions. Repeated observations of known
controls do not consume new slots in the 512-ref table. Eviction still never
recycles a number the model might retain.

Native diffs distinguish an actual replacement from the original control even
when label, value and geometry are identical. The private identity survives
internal object spreads and never appears in JSON. When a limited post-action
diff would omit new native refs, the response also includes the current bounded
listing of at most 60 controls before advancing its baseline.

Batch condition failures are recorded on their individual step. Earlier results
remain visible, and continuation requires that step's explicit
`continue_on_error`. Cancellation and ended turns still abort dispatch. Missing
identity in an incomplete observation is not proof of absence and never silently
permits an `unless_element` action.

## Native reconciliation

Reconciliation is opt-in for the macOS observation path. The portable cache's
ordinary publication remains snapshot-scoped. A reconciled token names a current
element whose native identity is proven equal to the previous one; it is not an
index into an old tree. Numeric `snapshot_id` plus `element_index` continues to
refer to one specific publication. Redundant token, index and window claims must
agree with the current target.

Only current elements are retained. Replacement, process lifetime change,
ambiguous identity and eviction must retire the old token. The native matching
uses Core Foundation equality, with hash buckets only to bound candidate lookup;
labels or geometry alone cannot establish identity. Collection content is part
of the eligibility check because a virtualized row can reuse its UI object for
a different item. Reads publishing the same window are serialized independently
of screenshot-only previews and actions.

## Automated validation

The final server suites passed 607 tests across the backend, manager, gateway,
targeting and help. Both initially failing integration regressions pass. The
macOS library passed 491 tests with 4 existing ignored cases. Desktop host,
ownership, socket, provenance and cache-key suites passed 220 tests; the shared
protocol suite passed 33. The workspace typecheck passed all 7 packages and lint
reported no errors. The Windows runtime boundary check passed across 308 source
files.

The broader core-library run initially found an outdated test vocabulary: runtime
already advertised Space listing and app/window visibility capabilities, but the
test's canonical list omitted those three names. The test list was aligned with
the existing runtime declarations without changing input authorization or
advertising new operations. The core suite then passed all 674 tests.

Across these suites, 2,025 distinct tests passed; 4 native cases remain ignored.
Focused worker reruns are not added to that total. Both native and server changes
received a separate read-only review.

Changed formatter-supported files were checked separately. The repository-wide
format check also found the same 9 generated release-0.9.21 artifacts reported
in earlier work; those artifacts are outside this change and remain untouched.

## Local build

The normal provisioning script rebuilt native revision 42 for macOS arm64 from
the pinned upstream archive plus the checked-in cumulative patch. The output is
`.tmp/cua-continuity-release/cua-driver`, with its provenance and license beside
it. The artifact passed provenance validation, exact source-delta comparison,
SHA-256 checks, local signature verification, architecture inspection and the
version command. No installed application was replaced and no release published.

Patch SHA-256:
`5e046b89be509fcb1162a265b17ad425d1dab6ca65ea3a9beda7a1c66e0f2a35`.
Staged binary SHA-256:
`df21f49d551766cf1aa3102406cd1347c3fd840186860f8e07b676635be8191e`.
Verification output is `.tmp/cua-continuity-build-verification.json`. The local
signature is ad-hoc and is not a notarized distribution certificate.

## Owned UI regression and permission boundary

The existing AppKit fixture now has a `reference-continuity` case. It observes
twice, writes through an original field token, observes again, clicks through an
original button token and checks field value and counter through the fixture's
independent state channel. It then replaces the actual text-field object while
preserving its appearance, verifies the old token refuses, and verifies the new
token can write. The sibling window must remain unchanged throughout.

The updated Swift fixture compiled and the runner passed its JavaScript syntax
check. The live baseline attempt stopped at the passive observer preflight:
`axTrusted:false`, `axWindowSymbol:true`, `slsSpace:true`. No fixture window,
driver or native input started. The observer exited with code 0 and no remaining
child. Its report is
`.tmp/cua-continuity-evidence/baseline/native-file-dialog-1NOaaZ/report.json`.
This is evidence about the separate observer executable, not the installed
Synara application's permissions.

The runner requires macOS Accessibility authorization for its observation and
driver processes. Its checks are not disabled when authorization is absent.
After the operating system grants access, select the new build and explicit
observer/fixture paths with the existing runner:

```sh
node scripts/computer-use-fixtures/native-file-dialog-regression.mjs \
  --driver /absolute/path/cua-driver \
  --fixture /absolute/path/native-file-dialog-fixture \
  --focus-probe /absolute/path/focus-probe \
  --out /absolute/path/evidence \
  --case reference-continuity
```

The complete suite also includes Open as a sheet, standalone Open, Save, Cancel
and refusal of controls behind a modal. Automated cache and gateway tests do
not certify real application task completion, latency, absence of focus changes
or parity with another computer-use product.
