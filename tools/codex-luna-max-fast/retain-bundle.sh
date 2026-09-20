#!/bin/zsh

emulate -L zsh
set -euo pipefail

if (( $# != 1 )); then
  print -u2 'usage: retain-bundle.sh <archive.tar.gz>'
  exit 2
fi
readonly archive="${1:A}"
readonly expected="$(/usr/bin/awk 'NR == 1 { print $1 }' "${archive}.sha256")"
readonly actual="$(/usr/bin/shasum -a 256 "${archive}" | /usr/bin/awk '{ print $1 }')"
if [[ ! "${expected}" =~ '^[0-9A-Fa-f]{64}$' || "${actual}" != "${expected:l}" ]]; then
  print -u2 'Cannot retain a bundle with a missing or mismatched checksum.'
  exit 1
fi
readonly retained="${archive%.tar.gz}-${actual}.tar.gz"
/bin/cp "${archive}" "${retained}"
print -r -- "${retained}"
