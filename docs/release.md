# Release Checklist

This document covers build-only native validation and publishing desktop releases from one tag.

## What the workflow does

- Triggers:
  - Manual dispatch defaults to build-only validation and uploads workflow artifacts without publishing anything.
  - Pushing a tag alone does not start this workflow.
  - Publication requires dispatching against the exact release tag with `publish_release=true`.
- Verifies source provenance first, then runs static verification, five test partitions,
  and shared compilation in parallel. Every verification and test partition gates publication.
- Builds two native targets from the shared desktop/server/web bundle:
  - macOS `arm64` DMG
  - Windows `x64` NSIS installer
- Packs the server tarball in the shared bundle job, including in build-only runs.
  The optional npm publication job consumes the same compiled server instead of rebuilding it.
- Publishes one versioned GitHub Release with all produced files.
  - Versions with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Stable clean-lane releases are GitHub Latest; the 0.4.x compatibility release remains historical.
- Publishes default `latest*.yml` metadata plus byte-identical `synara*.yml` aliases on every stable release so existing packaged binaries keep working.
- Keeps the historical 0.4.x compatibility release unchanged; current stable payloads stay on their own GitHub Latest release.
- Publishes prerelease installers only on their versioned GitHub prerelease; prereleases never replace the stable `synara` update manifests.
- Optionally publishes the CLI package (`apps/server`, npm package `@synara/cli`) with npm trusted publishing.
- Published macOS artifacts must be signed. Windows publication currently uses
  an explicit version-scoped unsigned exception; otherwise Azure signing is
  required. Build-only runs may produce unsigned artifacts when signing secrets
  are unavailable.

## Release latency

The [v0.8.61 publication run](https://github.com/TrapstarKS/synara/actions/runs/35436163991)
on September 19, 2026 took 21m16s before these changes. Its shared bundle job took
2m05s, macOS Intel took 16m01s, the subsequent server tarball job took 1m48s,
and publication took 55s. Verification ran concurrently and took 11m02s, including
9m38s in tests. These overlapping job durations must not be added together.

The release now packs the server from existing output, removes the serial server
rebuild after native packaging, and distributes tests across core, web and three
server shards. The core filter owns all other workspaces, including future ones;
`.github/scripts/release-contracts.test.mjs` checks the actual Turbo task graph for
omissions and duplicate ownership. Test results remain uncached.

Verification reuses the existing workspace setup caches. Shared compilation has
an OS/architecture/toolchain-input-scoped Turbo and React compiler cache; Turbo
still validates task inputs. Cache availability follows GitHub's branch/tag
scope: a new tag cannot reuse a different tag's cache, but can reuse the default
branch's cache. Build-only validation on the default branch can populate it.
See the [cache access restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).

Windows uses `RUNNER_TEMP` for both the Bun cache and temporary staging, matching
the hosted checkout volume. Already-compressed installers and tarballs use
`compression-level: 0` when uploaded as workflow artifacts. These changes remove
repeated work; the before-run timings are not a measured after-run speedup or a
two-minute end-to-end guarantee.

On macOS, staging uses Bun 1.4.2's frozen production install for the CLI and
desktop workspaces. It verifies the source and staging lockfile hashes, follows
all required runtime dependencies and peers inside the stage, and checks every
reachable copy of patched dependencies. Windows keeps its existing temporary
lockfile workaround; Linux keeps its original frozen install. A local macOS
probe installed 363 packages instead of the 1,622 logged by the old Intel stage,
then verified 20 runtime roots, 341 reachable packages, isolated imports, and
rejection of a deliberately damaged dependency patch. Package counts are not
elapsed-time measurements.

`SYNARA_APPSNAP_CACHE_DIR` enables the release helper cache. Its key includes
architecture, Swift/SDK identity, build script and Swift sources. The original
helper still checks its source fingerprint and signature before reusing a cached
binary; publication signs a separate staging copy. A local Apple Silicon probe
measured 98.08s for a cold build and 0.69s for a cache hit, with byte-identical
outputs. Corrupt-cache recovery rebuilt and verified the helper. These are local
observations, not hosted-runner timing guarantees. The macOS runtime archive is
also excluded from the redundant `prod-resources` copy while remaining in its
existing packaged runtime location; production icon copies remain available.

### Verification record: September 19, 2026

The [previous build-only run](https://github.com/TrapstarKS/synara/actions/runs/35435489024)
on application commit `790f4897` took 13m38s. The
[first candidate](https://github.com/TrapstarKS/synara/actions/runs/35464852806)
passed in 11m48s, including the newly added server-tarball validation. Every test
partition, native build, provenance check and packaged-startup smoke passed.
The [final-code confirmation](https://github.com/TrapstarKS/synara/actions/runs/35465779116)
on `be33f6981` passed in **9m00s**, with the first candidate's caches available.
This is 4m38s (34.0%) less elapsed time than the earlier build-only run.
This is the like-for-like workflow comparison; the earlier 21m16s publication
also included a serial server rebuild and public release upload.

| Job / workflow                 | Earlier build-only | First candidate | Final-code confirmation |
| ------------------------------ | -----------------: | --------------: | ----------------------: |
| Entire workflow                |             13m38s |          11m48s |                   9m00s |
| Shared bundle                  |              2m03s |           1m52s |                     38s |
| Slowest verification/test lane |              9m25s |           4m47s |                   3m23s |
| macOS Intel                    |             11m19s |           9m30s |                   8m05s |
| macOS ARM64                    |              8m20s |           4m24s |                   5m04s |
| Windows x64                    |              9m34s |           6m08s |                   6m31s |

The new shared-bundle job includes packing the server tarball; the old one did
not. Verification/test rows compare the slowest blocking lane after partitioning,
not summed runner time. ARM64 and Windows varied between the two candidates,
despite reusable caches. The confirmation also includes the final ZIP identity
check, so this is not an isolated cache benchmark or a guaranteed percentage for
future tags. No production publication time has been measured for the candidate.

The first candidate's Windows installs took 16.42s in the checkout and 13.38s
in staging, versus 100.21s and 103.66s in the previous publication run. macOS
staging took 1.16s on ARM64 and 3.32s on Intel. The already-generated ZIP was
reused on both architectures. These are observed samples; runner variability
and cache scope still affect subsequent releases.

The final-code run confirmed both macOS architectures reused their validated ZIPs
and cached AppSnap helpers. Windows dependency installs took 16.95s and 13.81s
(30.76s combined), consistent with the first candidate's reduced installation
cost. The native Intel packaging job remained the longest lane.

Local validation used the pinned Bun 1.4.2. Typechecking all seven workspaces,
lint, workflow contract tests, actionlint, release smoke, the desktop build and
packing/inspecting the existing server output passed. The final ZIP regression
suite passed 15 tests using the real builder, ZIP utilities and macOS signing
tools, including rejecting a validly signed ZIP from another build.

The complete local test run was also attempted; it was not fully green. Its
remaining failures were in the unchanged `ProviderRuntimeIngestion.test.ts` and
`chatgptConnector/tools/execSessions.test.ts`; a focused repeat passed the former
and retained two command-completion failures in the latter. The corresponding
Linux release partitions passed. Global formatting reported 16 unchanged files
from the baseline, and the Windows boundary scanner reported existing ChatGPT
connector violations. The release files themselves passed formatting and diff
checks. These unrelated failures were not hidden by weakening checks or editing
the application. No production release or notarization-service run was performed
for this optimization.

## Desktop auto-update notes

- Runtime updater: `electron-updater` in `apps/desktop/src/main.ts`.
- Update UX:
  - Background checks run on startup delay + interval.
  - New updates are prepared/downloaded in the background after detection; install/restart stays manual.
  - The desktop UI shows a rocket update button while preparing and switches to an install action once the update is ready.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository visibility: public. The authenticated private-repository provider does not honor custom channel filenames.
- Runtime channel: `synara`. Stable clean-lane releases publish both `latest` and `synara` metadata; the 0.4.x compatibility release remains available for historical migration.
- Repository slug source:
  - `SYNARA_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Required Synara release assets for updater:
  - platform installers (`.exe`, `.dmg`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - `synara-mac.yml` and `synara.yml` metadata
  - the current macOS/Windows matrix includes `synara-mac.yml`, `synara.yml`, `latest-mac.yml`, and `latest.yml`; Linux publication is not enabled in this workflow
  - `*.blockmap` files, except the macOS update `.zip.blockmap` removed during zip finalization
- Enforced upgrade path:
  - Stable clean Synara releases are created with `make_latest=true` and carry both manifest names for each published platform in the versioned release.
  - The historical 0.4.x compatibility release remains available for predecessor migration and is never overwritten by a clean-lane release.
  - Clean releases do not mirror payloads onto the historical compatibility release, so the 0.4.x line remains immutable.
  - Clean-release publication fails closed if either the default Latest manifests or the dedicated `synara` aliases are missing.
- Production desktop builds omit web/server/desktop source maps by default to keep update payloads small. Set `SYNARA_WEB_SOURCEMAP=1`, `SYNARA_SERVER_SOURCEMAP=1`, or `SYNARA_DESKTOP_SOURCEMAP=1` only for a diagnostic release that needs them.
- macOS metadata note:
  - Installed macOS apps persist alternate icon choices using `NSWorkspace` custom-icon metadata, and reapply the saved choice on launch after an update. Default removes the override so the bundled icon follows system appearance. This requires a writable app bundle; development Electron bundles are not customized.
  - Custom icons leave signed `Contents` unchanged, but add Finder metadata that `codesign --verify --strict` rejects on a customized installation. Validate pristine distribution artifacts with the strict checks below. A local notarized app copy retained normal signature verification and Gatekeeper acceptance after customization; signed release/update testing must still cover this path.
  - The build initially emits `latest-mac.yml` for both Intel and Apple Silicon.
  - The workflow merges the per-arch macOS metadata, then keeps the merged manifest as `latest-mac.yml` and copies it to `synara-mac.yml` for stable releases.
  - The desktop build script reuses the builder's `.zip` when its Electron framework symlinks are intact and both the original and extracted app signatures are valid. Matching the resource seal, signed executable, and plist also rejects a validly signed ZIP from another build. It patches the matching `latest-mac*.yml` hash/size and removes `.zip.blockmap` to retain full-archive updates. Legacy ZIPs with missing or flattened framework symlinks are rebuilt with `ditto` and pass the same checks. Unsealed build-only apps retain the previous rebuild-from-source behavior. Archive read/extraction errors and invalid or mismatched signatures otherwise fail the build.
  - macOS updater downloads intentionally use the full zip payload so Squirrel.Mac installs the exact signed archive validated by release build.
- Local smoke test:
  - Run `bun run release:smoke:mac-update -- --skip-build --build-version 0.1.5` on macOS after local desktop/server/web dist files exist.
  - The smoke builds a mock update artifact, validates manifest hash/size, serves a HEAD-only local endpoint, confirms the manifest and zip are addressable without downloading the zip body, then cleans up its temp output.
  - Boolean env flags for release scripts accept `true/false`, `1/0`, `yes/no`, and `on/off`; CLI flags are still preferred for repeatable local commands.

## 0) npm OIDC trusted publishing setup (CLI)

When `SYNARA_PUBLISH_CLI=1`, the workflow restores the shared compiled bundle and
publishes with `npm publish` from an isolated distribution stage. Source package
versions must already match the release tag; publication does not rewrite them.

Checklist:

1. Confirm the npm account controls the `@synara` scope and can publish `@synara/cli`.
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create and push release tag `vX.Y.Z`, then dispatch `release.yml` against that
   tag with `version=X.Y.Z` and `publish_release=true`. After successful validation
   and builds, the optional job runs `npm publish --access public --tag latest`
   from its isolated stage.

## Synara notes

- Every stable versioned release must include both the default `latest` updater metadata and the dedicated `synara` aliases alongside its installers.
- The published release title should read `Synara vX.Y.Z`.
- By default, the first-party desktop release path does not require CLI publish or post-release version-bump automation.
- Optional jobs stay disabled unless repository variables enable them:
  - `SYNARA_PUBLISH_CLI=1`
  - `SYNARA_FINALIZE_RELEASE=1`

## 1) Build-only native CI validation

Use this before publication to validate macOS ARM64 and Windows.
Build-only mode uploads installers, updater metadata, provenance, and the server
tarball as workflow artifacts. It does not create a tag, publish a GitHub Release
or npm package, expose a public updater feed, or make a version-bump commit.

1. Push the release-candidate branch so GitHub Actions can check it out.
2. Start the workflow in build-only mode:
   - `gh workflow run release.yml --ref BRANCH -f version=X.Y.Z -f publish_release=false`
3. Wait for `.github/workflows/release.yml` to finish.
4. Confirm preflight, static verification, all five test partitions, shared bundle/server tarball, and both native builds pass.
5. Download the workflow artifacts and sanity-check the macOS and Windows installers.

To publish, select the exact release tag for the dispatch and pass `publish_release=true`. This is intentionally opt-in.

### macOS release toolchains

The native macOS release runner uses macOS 15. Native helpers and the pinned
Cua apple-metal bridge build with Xcode 16.4's macOS 15 SDK. A separate macOS 26
job compiles the architecture-independent Icon Composer catalog with Xcode 26.3
from the same release checkout and passes it through a required workflow artifact.
`SYNARA_MAC_ICON_CATALOG` points packaging at that catalog; a missing file fails
the build. This avoids Apple's AssetRuntime framework crash on macOS 15 without
changing the native SDK. Local builds without that variable compile icons with
the selected Xcode on the local host.

An older `actool` can exit successfully without creating `Assets.car`; that is a
packaging failure, not permission to silently omit the Liquid Glass icon.

### Linux native build dependencies

The release job installs the Cua driver's OpenSSL, X11, XCB, xkbcommon and
Wayland development libraries before provisioning. This matches the build
prerequisites in `cua-linux-check.yml`; it does not qualify Linux Computer Use
as a supported 0.9.0 feature.

### Local DMG appearance validation

On an Apple Silicon Mac, build the DMG and macOS update ZIP in `release/` with:

```bash
SYNARA_DESKTOP_UPDATE_REPOSITORY=Emanuele-web04/synara bun run dist:desktop:dmg:arm64
```

Use `dist:desktop:dmg:x64` on Intel. The updater repository setting is needed for
ZIP manifest finalization outside GitHub Actions. The build passes
`--publish never` to electron-builder and defaults to unsigned; release signing,
notarization, and updater settings remain controlled by the existing release flow.

The Dmgly layout lives in `scripts/lib/desktop-platform-build-config.ts` and uses
`apps/desktop/resources/dmgly/assets/dmg-background.png`. The packaging script
copies this resources directory into its staging app, keeping the background path
valid there. `scripts/lib/desktop-runtime-resources.ts` excludes the `dmgly`
directory from the runtime resource copy on every platform, so installer artwork
and the reference icon stay out of the installed app and update ZIP. The supplied
642×406 PNG is a 1× background with its text and arrow
already baked in. Do not add duplicate text or arrows. It has no baked label
backgrounds. The exported `app-icon.png` is retained alongside it as a reference;
the app continues to use the existing production ICNS generation pipeline.

Mount the resulting DMG in Finder and check the 642×406 window, 128px icons,
and icon centers at (172, 135) for `Synara.app` and (514, 241) for `Applications`.
Verify both real filename labels remain readable and unclipped. Finder renders
the app icon and Applications link, so their appearance can differ from Dmgly's
preview; Retina displays also scale the supplied 1× background. Local Finder
preferences can override the DMG's saved hidden path/status bars, reducing the
visible background and requiring scrolling to reveal the Applications label.

## 2) Apple signing + notarization setup (macOS)

The fork can use the persistent `MAC_CERT_P12` / `MAC_CERT_PASSWORD` identity
validated by the workflow. That signing mode does not perform Apple notarization.
Without that pair, the Developer ID path requires the following secrets:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create `Developer ID Application` certificate.
3. Export certificate + private key as `.p12` from Keychain.
4. Base64-encode the `.p12` and store as `CSC_LINK`.
5. Store the `.p12` export password as `CSC_KEY_PASSWORD`.
6. In App Store Connect, create an API key (Team key).
7. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
   - `APPLE_TEAM_ID`: Developer Team ID embedded in the signed application
8. Re-run a tag release and confirm macOS artifacts are signed/notarized.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.

## 3) Azure Trusted Signing setup (Windows)

The current Windows release policy publishes x64 installers unsigned under an
explicit version-scoped exception. Before pushing the release tag, set the
repository Actions variable `SYNARA_ALLOW_UNSIGNED_WINDOWS_RELEASE` to the exact
version without the `v` prefix (for example, `0.8.4`). The workflow checks equality
with the resolved release version before packaging; do not use a permanent broad
opt-out. Packaging, source provenance, startup smoke, and artifact upload must
still pass. Missing Azure credentials are expected for this unsigned path.

Without the matching exception, published Windows installers must be signed with
Azure Trusted Signing, and the workflow fails closed when a required signing
value is absent. A requested signed release requires all of the following secrets:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`
- `AZURE_TRUSTED_SIGNING_SUBJECT_DN`

Signing checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
   - Full certificate subject distinguished name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a build-only workflow and confirm the Windows installer is signed.

For a signed release, run a build-only workflow and verify the generated
installer's Authenticode identity matches both the configured publisher name and
full subject distinguished name.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Run the build-only native CI validation for the release-candidate branch and version.
3. Bump app version as needed.
4. Run `node scripts/resolve-release-update-policy.ts X.Y.Z` and confirm it reports the expected lane, `make_latest`, and `mirror_to_stable_channel` values before creating the tag.
5. Create release tag: `vX.Y.Z`.
6. Push the tag, then dispatch `release.yml` against it with `version=X.Y.Z` and `publish_release=true`.
7. Verify workflow steps:
   - preflight passes
   - static verification and every test partition pass
   - all matrix builds pass
   - release job uploads expected files
8. For a stable clean-lane release, confirm the new versioned release is GitHub Latest, contains the default `latest` manifests plus their `synara` aliases for macOS and Windows, and left the historical compatibility release unchanged.
9. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets are populated and non-empty.
- Published Windows build rejected before packaging:
  - For the unsigned release policy, check that `SYNARA_ALLOW_UNSIGNED_WINDOWS_RELEASE` matches the exact version without `v`.
  - For a signed release, check all eight Azure ATS, identity, and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Re-check certificate/profile names and tenant/client credentials.
