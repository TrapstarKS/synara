#!/bin/zsh

emulate -L zsh
set -euo pipefail

readonly script_dir="${0:A:h}"
readonly temp_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/synara-luna-test.XXXXXX")"
cleanup() {
  /bin/rm -rf "${temp_dir}"
}
trap cleanup EXIT INT TERM

payload="${temp_dir}/stage/payload"
/bin/mkdir -p \
  "${payload}/bin" \
  "${payload}/codex-path" \
  "${payload}/codex-resources/zsh/bin" \
  "${temp_dir}/release" \
  "${temp_dir}/home/userdata"

/bin/cat >"${payload}/bin/codex-luna-max-fast.real" <<'EOF'
#!/bin/zsh
if [[ "$1" == "--version" ]]; then print 'codex-cli 9.9.9'; fi
EOF
for relative_path in \
  bin/codex-code-mode-host \
  codex-path/rg \
  codex-resources/zsh/bin/zsh; do
  print '#!/bin/zsh' >"${payload}/${relative_path}"
done
/bin/cp "${script_dir}/codex-luna-max-fast" "${payload}/bin/"
/bin/cp "${script_dir}/update-codex-luna-max-fast" "${payload}/bin/"
/bin/cp "${script_dir}/OPENAI_CODEX_LICENSE" "${payload}/"
/bin/cp "${script_dir}/OPENAI_CODEX_NOTICE" "${payload}/"
print '9.9.9' >"${payload}/VERSION"
/bin/chmod 755 \
  "${payload}/bin/"* \
  "${payload}/codex-path/rg" \
  "${payload}/codex-resources/zsh/bin/zsh"

asset="codex-luna-max-fast-aarch64-apple-darwin.tar.gz"
/usr/bin/tar -czf "${temp_dir}/release/${asset}" -C "${temp_dir}/stage" payload
(
  cd "${temp_dir}/release"
  /usr/bin/shasum -a 256 "${asset}" >"${asset}.sha256"
)

/bin/cat >"${temp_dir}/home/userdata/settings.json" <<'EOF'
{"settings":{"providers":{"codex":{"binaryPath":"codex"}}}}
EOF

SYNARA_LUNA_HOME="${temp_dir}/home" \
  SYNARA_LUNA_RELEASE_BASE_URL="file://${temp_dir}/release" \
  "${script_dir}/update-codex-luna-max-fast" --force >/dev/null

[[ "$("${temp_dir}/home/bin/codex-luna-max-fast.real" --version)" == 'codex-cli 9.9.9' ]]
[[ -x "${temp_dir}/home/bin/codex-code-mode-host" ]]
[[ -x "${temp_dir}/home/codex-path/rg" ]]
[[ -x "${temp_dir}/home/codex-resources/zsh/bin/zsh" ]]
[[ "$(<"${temp_dir}/home/codex-luna-max-fast/version")" == '9.9.9' ]]

SYNARA_LUNA_HOME="${temp_dir}/home" \
  SYNARA_LUNA_RELEASE_BASE_URL="file://${temp_dir}/release" \
  SYNARA_LUNA_UPDATER_URL="file://${script_dir}/update-codex-luna-max-fast" \
  SYNARA_LUNA_ASSUME_SYNARA_STOPPED=1 \
  "${script_dir}/install.sh" >/dev/null
[[ "$(/usr/bin/plutil -extract settings.providers.codex.binaryPath raw \
  "${temp_dir}/home/userdata/settings.json")" == "${temp_dir}/home/bin/codex-luna-max-fast" ]]

# Build leftovers from the retired local-build updater are reclaimed even when
# the installed release is already current.
/bin/mkdir -p "${temp_dir}/home/codex-luna-max-fast/target/debug" \
  "${temp_dir}/home/codex-luna-max-fast/source" "${temp_dir}/home/bin/__pycache__"
SYNARA_LUNA_HOME="${temp_dir}/home" \
  SYNARA_LUNA_RELEASE_BASE_URL="file://${temp_dir}/release" \
  "${script_dir}/update-codex-luna-max-fast" >/dev/null
[[ ! -e "${temp_dir}/home/codex-luna-max-fast/target" && \
  ! -e "${temp_dir}/home/codex-luna-max-fast/source" && \
  ! -e "${temp_dir}/home/bin/__pycache__" ]]

# A directory left by the old updater must not permanently disable updates.
/bin/mkdir "${temp_dir}/home/codex-luna-max-fast/update.lock.d"
SYNARA_LUNA_HOME="${temp_dir}/home" \
  SYNARA_LUNA_RELEASE_BASE_URL="file://${temp_dir}/release" \
  "${script_dir}/update-codex-luna-max-fast" --force >/dev/null

# Failed downloads and corrupt archives keep both the working binary and the
# last successful check unchanged, so the next launch can retry immediately.
readonly success_stamp="${temp_dir}/home/codex-luna-max-fast/last-check"
/usr/bin/touch -t 202001010000 "${success_stamp}"
checked_at="$(/usr/bin/stat -f %m "${success_stamp}")"
/bin/mv "${temp_dir}/release/${asset}" "${temp_dir}/release/archive.saved"
if SYNARA_LUNA_HOME="${temp_dir}/home" \
  SYNARA_LUNA_RELEASE_BASE_URL="file://${temp_dir}/release" \
  "${script_dir}/update-codex-luna-max-fast" --force >"${temp_dir}/failure.log" 2>&1; then
  print -u2 "Missing archive unexpectedly succeeded."
  exit 1
fi
[[ "$(/usr/bin/stat -f %m "${success_stamp}")" == "${checked_at}" ]]
print 'corrupt archive' >"${temp_dir}/release/${asset}"
if SYNARA_LUNA_HOME="${temp_dir}/home" \
  SYNARA_LUNA_RELEASE_BASE_URL="file://${temp_dir}/release" \
  "${script_dir}/update-codex-luna-max-fast" --force >"${temp_dir}/failure.log" 2>&1; then
  print -u2 "Corrupt archive unexpectedly succeeded."
  exit 1
fi
[[ "$(/usr/bin/stat -f %m "${success_stamp}")" == "${checked_at}" ]]
[[ "$("${temp_dir}/home/bin/codex-luna-max-fast.real" --version)" == 'codex-cli 9.9.9' ]]
/bin/mv -f "${temp_dir}/release/archive.saved" "${temp_dir}/release/${asset}"

# An active lock excludes a second updater; releasing it permits a fresh check.
zmodload zsh/system
zsystem flock -t 0 -f test_lock_fd "${temp_dir}/home/codex-luna-max-fast/update.lock"
SYNARA_LUNA_HOME="${temp_dir}/home" \
  SYNARA_LUNA_RELEASE_BASE_URL="file://${temp_dir}/release" \
  "${script_dir}/update-codex-luna-max-fast" --force >/dev/null
[[ "$(/usr/bin/stat -f %m "${success_stamp}")" == "${checked_at}" ]]
zsystem flock -u "${test_lock_fd}"
SYNARA_LUNA_HOME="${temp_dir}/home" \
  SYNARA_LUNA_RELEASE_BASE_URL="file://${temp_dir}/release" \
  "${script_dir}/update-codex-luna-max-fast" >/dev/null
[[ "$(/usr/bin/stat -f %m "${success_stamp}")" != "${checked_at}" ]]

# An older published stable bundle must not downgrade a newer local install.
retained="$("${script_dir}/retain-bundle.sh" "${temp_dir}/release/${asset}")"
retained_checksum="$(/usr/bin/shasum -a 256 "${retained}" | /usr/bin/awk '{ print $1 }')"
[[ "${retained}" == *"-${retained_checksum}.tar.gz" ]]
print -r -- '9.9.8' >"${payload}/VERSION"
print '#!/bin/zsh\nprint "codex-cli 9.9.8"' >"${payload}/bin/codex-luna-max-fast.real"
/usr/bin/tar -czf "${temp_dir}/release/${asset}" -C "${temp_dir}/stage" payload
(
  cd "${temp_dir}/release"
  /usr/bin/shasum -a 256 "${asset}" >"${asset}.sha256"
)
SYNARA_LUNA_HOME="${temp_dir}/home" \
  SYNARA_LUNA_RELEASE_BASE_URL="file://${temp_dir}/release" \
  "${script_dir}/update-codex-luna-max-fast" --force >/dev/null
[[ "$("${temp_dir}/home/bin/codex-luna-max-fast.real" --version)" == 'codex-cli 9.9.9' ]]
[[ "$(/bin/cat "${temp_dir}/home/codex-luna-max-fast/version")" == '9.9.9' ]]
[[ "$(/usr/bin/shasum -a 256 "${retained}" | /usr/bin/awk '{ print $1 }')" == "${retained_checksum}" ]]
print 'corrupt replacement' >"${temp_dir}/release/${asset}"
if "${script_dir}/retain-bundle.sh" "${temp_dir}/release/${asset}" >"${temp_dir}/retention.log" 2>&1; then
  print -u2 'Corrupt archive was retained.'
  exit 1
fi

print "portable installer smoke test passed"
