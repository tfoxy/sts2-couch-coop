#!/usr/bin/env bash
# Collect `Changelog:` trailers into a draft CHANGELOG.md section.
#
#   scripts/collect-changelog.sh                 since the most recent tag, up to HEAD
#   scripts/collect-changelog.sh v0.1.1          since that tag
#   scripts/collect-changelog.sh v0.1.0 v0.1.1   between two tags
#
# The output is a DRAFT, not the final section: it groups the trailers people wrote at commit time
# under Keep a Changelog headings, and then lists every feat/fix/perf commit that carries no
# trailer. That second list is the point — it is how a user-visible change avoids disappearing
# from the release notes because nobody wrote a line for it.
#
# Rewrite the draft in the reader's voice before it goes into CHANGELOG.md. The release-notes skill
# (skills/release-notes/) does that step.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

from="${1:-}"
to="${2:-HEAD}"

if [ -z "$from" ]; then
  from="$(git describe --tags --abbrev=0 "$to" 2>/dev/null || true)"
fi
if [ -n "$from" ]; then range="$from..$to"; else range="$to"; fi

echo "# draft changelog for $range"
echo

heading_for() { # heading_for <type>
  case "$1" in
    feat) echo "Added" ;;
    fix)  echo "Fixed" ;;
    perf) echo "Changed" ;;
    *)    echo "Other" ;;
  esac
}

emitted=0
for want in feat fix perf; do
  section=""
  while IFS=$'\t' read -r sha subject; do
    [ -n "$sha" ] || continue
    printf '%s' "$subject" | grep -Eq "^$want(\(|!|:)" || continue
    entry="$(git log -1 --format='%(trailers:key=Changelog,valueonly,separator=%x0A)' "$sha" \
             | sed -e 's/[[:space:]]\{1,\}/ /g' -e 's/^ //' -e 's/ $//' | grep -v '^$' | head -1)"
    [ -n "$entry" ] || continue
    [ "$entry" = "none" ] && continue
    section+="- $entry"$'\n'
  done < <(git log --no-merges --reverse --format='%H%x09%s' "$range")

  if [ -n "$section" ]; then
    emitted=1
    printf '### %s\n%s\n' "$(heading_for "$want")" "$section"
  fi
done

[ "$emitted" -eq 1 ] || echo "(no Changelog trailers in this range)"
echo

# Anything user-visible that nobody wrote a line for.
missing=""
while IFS=$'\t' read -r sha subject; do
  [ -n "$sha" ] || continue
  printf '%s' "$subject" | grep -Eq '^(feat|fix|perf)(\(|!|:)' || continue
  git log -1 --format='%(trailers:key=Changelog,valueonly)' "$sha" | grep -q '[^[:space:]]' && continue
  missing+="  ${sha:0:9}  $subject"$'\n'
done < <(git log --no-merges --reverse --format='%H%x09%s' "$range")

if [ -n "$missing" ]; then
  printf '# NO Changelog trailer — decide whether each of these belongs in the notes:\n%s' "$missing"
else
  echo "# every feat/fix/perf commit in this range carries a Changelog trailer"
fi
