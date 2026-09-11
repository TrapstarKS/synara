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
for path in \
  bin/codex-code-mode-host \
  codex-path/rg \
  codex-resources/zsh/bin/zsh; do
  print '#!/bin/zsh' >"${payload}/${path}"
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

print "portable installer smoke test passed"
