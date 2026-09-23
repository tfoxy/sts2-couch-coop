#!/usr/bin/env bash
# Self-test for scripts/collect-changelog.sh.
#
# The script decides what a release's notes say, so a trailer it mangles is published: to
# CHANGELOG.md, to the GitHub Release body, and to the Workshop change note, where a revision's
# note cannot be edited afterwards. v0.3.0 shipped a sentence that stopped mid-clause because a
# WRAPPED trailer was read as two trailers and only the first line survived -- that case is the
# first fixture below, and the reason this file exists.
#
# Nothing here touches the real repository: every case is a commit in a throwaway git repo built
# in $TMP, so the fixtures are exact and no history has to contain them.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
COLLECT="$PWD/scripts/collect-changelog.sh"

pass=0; fail=0
TMP="$(mktemp -d)" || { echo "mktemp failed" >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repo"
git init -q --initial-branch=main "$REPO"
git -C "$REPO" config user.name "Fixture"
git -C "$REPO" config user.email "fixture@example.invalid"
git -C "$REPO" config commit.gpgsign false

# commit <message> -- an empty commit carrying exactly this message.
commit() {
  git -C "$REPO" commit -q --allow-empty --no-verify --cleanup=verbatim -m "$1"
}

# The collector reads the repo it lives in, so run it with its own checkout swapped for the
# fixture's. It resolves its root from BASH_SOURCE, hence the copy rather than a cd.
collect() { # collect <from> [to]
  mkdir -p "$REPO/scripts"
  cp "$COLLECT" "$REPO/scripts/collect-changelog.sh"
  bash "$REPO/scripts/collect-changelog.sh" "$@" 2>&1
}

# Every pattern here begins with "- ", so each grep needs `--` to stop option parsing.

# emits <desc> <expected line> -- the draft must contain this line, exactly.
emits() {
  if printf '%s\n' "$OUT" | grep -qxF -- "$2"; then pass=$((pass+1))
  else
    fail=$((fail+1))
    printf 'FAIL  %s\n      wanted line: %s\n' "$1" "$2" >&2
    printf '%s\n' "$OUT" | sed 's/^/        /' >&2
  fi
}

# omits <desc> <unwanted substring>
omits() {
  if printf '%s\n' "$OUT" | grep -qF -- "$2"; then
    fail=$((fail+1)); printf 'FAIL  %s\n      should not contain: %s\n' "$1" "$2" >&2
  else pass=$((pass+1)); fi
}

# omits_line <desc> <line that must not appear whole> -- the truncation assertion. A prefix of a
# correct entry is a substring of it, so only a WHOLE-line match distinguishes the two.
omits_line() {
  if printf '%s\n' "$OUT" | grep -qxF -- "$2"; then
    fail=$((fail+1)); printf 'FAIL  %s\n      truncated line present: %s\n' "$1" "$2" >&2
  else pass=$((pass+1)); fi
}

base="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
commit 'chore: root'
base="$(git -C "$REPO" rev-parse HEAD)"

# 1. THE REGRESSION. A wrapped trailer is one sentence, not two trailers.
commit 'feat(hostui): put the join QR in the pause menu

Body.

Changelog: The join QR code is now in the pause menu, so a player whose phone dropped out can
  scan back in without abandoning the run.'

# 2. A trailer wrapped across three lines still reads as one sentence.
commit 'fix(seat): widen the silent-seat deadline

Changelog: A seat that goes quiet is now given longer to come back
  before the host is told anything is wrong,
  which is most of a slow phone'"'"'s first join.'

# 3. Several trailers on one commit: the first still wins, as before.
commit 'perf(canvas): cache the retained subtree

Changelog: Smoother card animations on slower phones.
Changelog: This one is not the first and must not appear.'

# 4. A one-line trailer is untouched by the folding.
commit 'fix(cache): keep two version folders

Changelog: Cached art no longer survives a game update.'

# 5. `none` is still a complete answer, and still emits nothing.
commit 'fix(validation): scan tracked blobs reliably

Changelog: none'

# 6. A user-visible commit with no trailer is still reported as missing.
commit 'feat(mirror): add a display-space stage layout'

# 7. A non-user-facing type is not collected even when it carries a trailer.
commit 'docs(agents): describe the aim guard

Changelog: This should never reach the notes.'

OUT="$(collect "$base")"

echo "== a wrapped trailer keeps its continuation =="
emits "two-line trailer is rejoined" \
  "- The join QR code is now in the pause menu, so a player whose phone dropped out can scan back in without abandoning the run."
omits_line "the truncated half v0.3.0 published is gone" \
  "- The join QR code is now in the pause menu, so a player whose phone dropped out can"

echo "== three lines fold too =="
emits "three-line trailer is rejoined" \
  "- A seat that goes quiet is now given longer to come back before the host is told anything is wrong, which is most of a slow phone's first join."

echo "== multiple trailers: first wins =="
emits "the first trailer is kept" "- Smoother card animations on slower phones."
omits "the second trailer is dropped" "must not appear"

echo "== the unwrapped cases are unchanged =="
emits "a one-line trailer"        "- Cached art no longer survives a game update."
omits "none is not a line"        "- none"
emits "an untrailered feat is flagged" \
  "$(printf '  %s  feat(mirror): add a display-space stage layout' "$(git -C "$REPO" log --format=%H --grep='display-space stage' | cut -c1-9)")"
omits "a docs trailer is ignored" "This should never reach the notes."

echo "== headings land under Keep a Changelog names =="
emits "feat -> Added"   "### Added"
emits "fix -> Fixed"    "### Fixed"
emits "perf -> Changed" "### Changed"

echo "== a range with no trailers says so =="
git -C "$REPO" checkout -q -b empty-range
commit 'chore: nothing user-visible'
OUT="$(collect HEAD~1 HEAD)"
emits "the empty-range notice" "(no Changelog trailers in this range)"

echo
if [ "$fail" -eq 0 ]; then
  echo "collect-changelog self-test: $pass checks passed, 0 failures"
else
  echo "collect-changelog self-test: $pass passed, $fail FAILED" >&2
  exit 1
fi
