#!/bin/zsh

emulate -L zsh
set -euo pipefail
umask 077

readonly default_updater_url="https://raw.githubusercontent.com/TrapstarKS/synara/codex/mobile-remote/tools/codex-luna-max-fast/update-codex-luna-max-fast"
readonly updater_url="${SYNARA_LUNA_UPDATER_URL:-${default_updater_url}}"
readonly synara_home="${SYNARA_LUNA_HOME:-${HOME}/.synara}"
readonly launcher="${synara_home}/bin/codex-luna-max-fast"
readonly settings_file="${synara_home}/userdata/settings.json"

temp_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/synara-luna-install.XXXXXX")"
cleanup() {
  /bin/rm -rf "${temp_dir}"
}
trap cleanup EXIT INT TERM

bootstrap_updater="${temp_dir}/update-codex-luna-max-fast"
/usr/bin/curl --fail --silent --show-error --location --retry 3 \
  --output "${bootstrap_updater}" "${updater_url}"
/bin/chmod 755 "${bootstrap_updater}"
SYNARA_LUNA_HOME="${synara_home}" \
  SYNARA_LUNA_RELEASE_BASE_URL="${SYNARA_LUNA_RELEASE_BASE_URL:-}" \
  "${bootstrap_updater}"

configured=0
if [[ -f "${settings_file}" ]]; then
  if [[ "${SYNARA_LUNA_ASSUME_SYNARA_STOPPED:-0}" != "1" ]] && \
    /usr/bin/pgrep -x Synara >/dev/null 2>&1; then
    print "Synara is running, so its settings were left untouched."
  else
    backup="${settings_file}.backup.$(/bin/date +%Y%m%d-%H%M%S)"
    /bin/cp -p "${settings_file}" "${backup}"
    if /usr/bin/plutil -replace settings.providers.codex.binaryPath \
      -string "${launcher}" "${settings_file}" && \
      [[ "$(/usr/bin/plutil -extract settings.providers.codex.binaryPath raw "${settings_file}")" == "${launcher}" ]]; then
      configured=1
      print "Synara now uses ${launcher}."
    else
      /bin/cp -p "${backup}" "${settings_file}"
      print -u2 "Could not update Synara settings; the original file was restored."
    fi
  fi
fi

if (( ! configured )); then
  print "In Synara Settings > Agent providers > Codex, set Custom binary to:"
  print "  ${launcher}"
fi

print "Installation complete."
