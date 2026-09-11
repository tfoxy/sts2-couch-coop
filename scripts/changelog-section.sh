#!/usr/bin/env bash
# Print one version's section of CHANGELOG.md, without its heading.
#
#   scripts/changelog-section.sh 0.1.2       # or v0.1.2 — the leading v is optional
#
# Used twice in the release path: as the gate that a tag cannot be cut without notes
# (a missing or empty section exits non-zero), and as the body of the GitHub Release
# (`gh release create --notes-file`). Keep those two uses reading the same bytes.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

version="${1:?usage: scripts/changelog-section.sh <version>}"
version="${version#v}"
file="${CHANGELOG_FILE:-CHANGELOG.md}"

if [ ! -f "$file" ]; then
  echo "$file does not exist — the release notes live there" >&2
  exit 1
fi

section="$(awk -v want="$version" '
  /^## / {
    if (found) exit
    # Matches "## [0.1.2] - 2026-09-11" and "## 0.1.2".
    line = $0
    gsub(/[][]/, "", line)
    split(line, parts, / +/)
    if (parts[2] == want) { found = 1; next }
  }
  # The link-reference block at the foot of the file belongs to no section.
  found && /^\[[^]]+\]:[[:space:]]/ { exit }
  found { print }
' "$file")"

# Trim leading and trailing blank lines.
section="$(printf '%s\n' "$section" | sed -e '/./,$!d' | tac | sed -e '/./,$!d' | tac)"

if [ -z "${section//[[:space:]]/}" ]; then
  {
    echo "no notes for $version in $file"
    echo
    echo "Add a section before tagging:"
    echo "  ## [$version] - $(date +%F)"
    echo "  ### Fixed"
    echo "  - …"
    echo
    echo "scripts/collect-changelog.sh drafts it from the Changelog trailers."
  } >&2
  exit 1
fi

printf '%s\n' "$section"
