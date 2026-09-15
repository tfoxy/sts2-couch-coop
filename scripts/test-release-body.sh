#!/usr/bin/env bash
# Self-test for scripts/release-body.sh: the GitHub Release body is the changelog section plus a
# short note about the one download a release publishes. No network, no Steam, no build.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/release-body.sh"
# shellcheck source=lib/release-lanes.sh
source "$repo_root/scripts/lib/release-lanes.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-release-body-tests.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

fail() {
  echo "test-release-body: $*" >&2
  exit 1
}

assert_eq() {
  [[ "$1" == "$2" ]] || fail "expected '$1', got '$2'"
}

assert_contains() {
  grep -qF -- "$2" <<<"$1" || fail "$3: expected to find '$2' in:"$'\n'"$1"
}

# A fixture changelog, so these assertions do not move when the repo's real release history does.
changelog="$test_root/CHANGELOG.md"
cat > "$changelog" <<'EOF'
# Changelog

## [0.1.2] - 2026-02-02

### Changed

- A fixture change a player would read.

## [0.1.1] - 2026-01-01

### Fixed

- An older fixture change nobody asked about.
EOF
export CHANGELOG_FILE="$changelog"

body="$(bash "$script" v0.1.2)"

# The changelog section, and only the requested version's.
assert_contains "$body" 'A fixture change a player would read.' 'changelog section'
grep -qF 'An older fixture change' <<<"$body" && fail "body leaked another version's section"

mapfile -t lanes < <(release_lane_discover "$repo_root/eng/Sts2.ReferenceSdk")
[[ ${#lanes[@]} -ge 2 ]] || fail "expected at least two lanes to test against, got ${#lanes[@]}"

# ONE DOWNLOAD. The body may name exactly one .zip, and it is the unsuffixed archive whose name is a
# published contract (the README's `gh attestation verify <zip>` block and every existing download
# link point at it). Reading every zip name out of the body rather than asserting one is present is
# what makes a re-introduced second archive fail here instead of passing unnoticed.
mapfile -t archives < <(grep -oE 'couchcoop-[A-Za-z0-9.+-]*\.zip' <<<"$body" | LC_ALL=C sort -u)
assert_eq 1 "${#archives[@]}"
assert_eq "$(release_archive_name couchcoop-v0.1.2)" "${archives[0]}"
# ...and one checksums file beside it. A release publishes exactly these two assets.
assert_contains "$body" "$(release_checksums_name "${archives[0]}").SHA256SUMS" 'checksums asset'
assert_contains "$body" 'gh attestation verify' 'attestation guidance'

# REGRESSION: the retired two-archive shape must not come back by name. `-public-beta.zip` is
# spelled out as well as derived, because that is the literal every stale link and doc still carries.
grep -qF -- '-public-beta.zip' <<<"$body" && fail 'the body names the retired per-lane beta archive'
for lane in "${lanes[@]}"; do
  grep -qF -- "couchcoop-v0.1.2-$lane.zip" <<<"$body" && fail "the body names a per-lane archive for $lane"
done

# REGRESSION: the body must never claim Steam hands a subscriber the build matching their game
# branch. It does not -- the client's periodic refresh takes an item's newest revision branch-blind,
# which is the reason one payload carries every lane -- and this sentence shipped as release prose.
grep -qiE 'matching your branch|build matching|gives you the build|(steam|workshop)[^.]{0,40}(picks|selects|chooses)' <<<"$body" \
  && fail "the body claims Steam selects a build by game branch:"$'\n'"$body"
grep -qiE 'minBranch|maxBranch|branch-linked|one revision per' <<<"$body" \
  && fail "the body describes Workshop branch linking:"$'\n'"$body"

# The distinction that matters: the payload REQUIRES the lowest lane floor and the game refuses to
# load it below that, while the newer builds it carries lanes for are ones it is BUILT FOR, not
# limited to. Telling players the download stops working on the next game update is worse than
# saying nothing, so a requirement is stated of the floor and of nothing else.
#
# Checked SENTENCE BY SENTENCE, not over the whole body and not line by line: the two versions
# appear one sentence apart and the line breaks between them are just wrapping. A sentence ends at a
# period followed by whitespace, which no version string does -- `v0.107.1` is dot-then-digit.
floor="$(release_payload_min_game_version "${lanes[@]}")"
assert_contains "$body" "**$floor**" 'the payload floor'
mapfile -t sentences < <(tr '\n' ' ' <<<"$body" | sed 's/\. /.\n/g')
required_floor=0
for sentence in "${sentences[@]}"; do
  grep -qiE 'require|needs' <<<"$sentence" || continue
  grep -qF "$floor" <<<"$sentence" && required_floor=1
  for lane in "${lanes[@]}"; do
    build="$(release_lane_game_build "$lane")"
    [[ "$build" == "$floor" ]] && continue
    grep -qF "$build" <<<"$sentence" \
      && fail "lane $lane is only built for $build, but the body states it as a requirement:"$'\n'"$sentence"
  done
done
[[ "$required_floor" == 1 ]] || fail "the body never says the download requires $floor:"$'\n'"$body"

# Every lane's game build is still named, so a player can see what the one download carries.
for lane in "${lanes[@]}"; do
  assert_contains "$body" "$(release_lane_game_build "$lane")" "lane $lane game build"
done

# A tag with no changelog section must still fail the release rather than publish a body with no
# notes -- this script replaced that gate in the workflow and has to keep being it.
status=0
bash "$script" v9.9.9 >/dev/null 2>&1 || status=$?
assert_eq 1 "$status"

# A leading v is optional, and nonsense is a usage error rather than a body.
assert_eq "$body" "$(bash "$script" 0.1.2)"
status=0
bash "$script" 'not-a-tag' >/dev/null 2>&1 || status=$?
assert_eq 2 "$status"

echo "test-release-body: ok"
