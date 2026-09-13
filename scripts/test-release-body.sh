#!/usr/bin/env bash
# Self-test for scripts/release-body.sh: the GitHub Release body is the changelog section plus a
# table saying which download is for which game. No network, no Steam, no build.

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

# One row per lane, naming that lane's archive.
mapfile -t lanes < <(release_lane_discover "$repo_root/eng/Sts2.ReferenceSdk")
[[ ${#lanes[@]} -ge 2 ]] || fail "expected at least two lanes to test against, got ${#lanes[@]}"
rows="$(grep -c '^| `couchcoop-' <<<"$body")"
assert_eq "${#lanes[@]}" "$rows"
for lane in "${lanes[@]}"; do
  assert_contains "$body" "\`$(release_lane_archive_name couchcoop-v0.1.2 "$lane")\`" "lane $lane row"
done

# The distinction that matters: a lane with a manifest floor REQUIRES that game version, one without
# is only BUILT AGAINST the version its references came from and still loads on newer builds of the
# same branch. Telling players the normal download stops working on the next game update is worse
# than saying nothing.
for lane in "${lanes[@]}"; do
  row="$(grep -F "\`$(release_lane_archive_name couchcoop-v0.1.2 "$lane")\`" <<<"$body")"
  if [[ -n "$(release_lane_min_game_version "$lane")" ]]; then
    assert_contains "$row" "requires **$(release_lane_min_game_version "$lane")**" "lane $lane"
    grep -qF 'built against' <<<"$row" && fail "lane $lane has a floor but says 'built against'"
  else
    assert_contains "$row" "built against **$(release_lane_game_build "$lane")**" "lane $lane"
    grep -qF 'requires' <<<"$row" && fail "lane $lane has no floor but says 'requires'"
  fi
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
