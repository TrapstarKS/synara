#!/bin/zsh

emulate -L zsh
set -euo pipefail

if (( $# != 4 )); then
  print -u2 "usage: package.sh <version> <patched-codex> <official-vendor-root> <output-dir>"
  exit 2
fi

readonly version="$1"
readonly patched_codex="${2:A}"
readonly vendor_root="${3:A}"
readonly output_dir="${4:A}"
readonly script_dir="${0:A:h}"
readonly target="aarch64-apple-darwin"
readonly asset="codex-luna-max-fast-${target}.tar.gz"

if [[ "$("${patched_codex}" --version)" != "codex-cli ${version}" ]]; then
  print -u2 "Patched binary does not report codex-cli ${version}."
  exit 1
fi
if ! /usr/bin/file "${patched_codex}" | /usr/bin/grep -q 'arm64'; then
  print -u2 "Patched binary is not arm64."
  exit 1
fi

required_vendor_files=(
  "bin/codex-code-mode-host"
  "codex-path/rg"
  "codex-resources/zsh/bin/zsh"
)
for relative_path in "${required_vendor_files[@]}"; do
  if [[ ! -f "${vendor_root}/${relative_path}" ]]; then
    print -u2 "Official Codex package is missing ${relative_path}."
    exit 1
  fi
done

stage="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/synara-luna-package.XXXXXX")"
cleanup() {
  /bin/rm -rf "${stage}"
}
trap cleanup EXIT INT TERM

payload="${stage}/payload"
/bin/mkdir -p \
  "${payload}/bin" \
  "${payload}/codex-path" \
  "${payload}/codex-resources/zsh/bin"
/bin/cp "${patched_codex}" "${payload}/bin/codex-luna-max-fast.real"
/usr/bin/strip -S "${payload}/bin/codex-luna-max-fast.real"
/usr/bin/codesign --force --sign - "${payload}/bin/codex-luna-max-fast.real"
/bin/cp "${vendor_root}/bin/codex-code-mode-host" "${payload}/bin/"
/bin/cp "${vendor_root}/codex-path/rg" "${payload}/codex-path/"
/bin/cp "${vendor_root}/codex-resources/zsh/bin/zsh" \
  "${payload}/codex-resources/zsh/bin/"
/bin/cp "${script_dir}/codex-luna-max-fast" "${payload}/bin/"
/bin/cp "${script_dir}/update-codex-luna-max-fast" "${payload}/bin/"
/bin/cp "${script_dir}/OPENAI_CODEX_LICENSE" "${payload}/"
/bin/cp "${script_dir}/OPENAI_CODEX_NOTICE" "${payload}/"
print -r -- "${version}" >"${payload}/VERSION"
/bin/chmod 755 \
  "${payload}/bin/"* \
  "${payload}/codex-path/rg" \
  "${payload}/codex-resources/zsh/bin/zsh"

/usr/bin/codesign --verify --strict "${payload}/bin/codex-luna-max-fast.real"
/usr/bin/codesign --verify --strict "${payload}/bin/codex-code-mode-host"
/bin/mkdir -p "${output_dir}"
/usr/bin/tar -czf "${output_dir}/${asset}" -C "${stage}" payload
(
  cd "${output_dir}"
  /usr/bin/shasum -a 256 "${asset}" >"${asset}.sha256"
)
print "${output_dir}/${asset}"
