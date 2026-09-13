#!/usr/bin/env bash
# Print the body of a GitHub Release: the version's CHANGELOG section, then a table saying which
# download is for which game.
#
#   scripts/release-body.sh v0.1.2
#
# Used by .github/workflows/release.yml as BOTH the release body and the gate that a tag cannot be
# cut without notes -- scripts/changelog-section.sh exits non-zero on a missing or empty section and
# that status is propagated here, so the workflow step keeps failing the release exactly as before.
#
# The table is generated from the lane list rather than written out, so adding a game branch does not
# mean editing release prose. Its wording draws a distinction that matters: a lane with a manifest
# floor REQUIRES that game version and refuses to load below it, while a lane without one is merely
# BUILT AGAINST the version its references were pinned from and keeps working on newer builds of the
# same branch. Saying "requires" for both would tell players the normal download stops working the
# next time the game updates, which is not true.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/release-lanes.sh
source "$repo_root/scripts/lib/release-lanes.sh"

tag="${1:?usage: scripts/release-body.sh <tag>}"
[[ "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "release-body: tag must be vMAJOR.MINOR.PATCH: $tag" >&2
  exit 2
}
[[ "$tag" == v* ]] || tag="v$tag"

# The gate. A missing section must fail the release, not produce a body without notes.
bash "$repo_root/scripts/changelog-section.sh" "$tag"

archive_base="couchcoop-$tag"
mapfile -t lanes < <(release_lane_discover "$repo_root/eng/Sts2.ReferenceSdk")

printf '\n## Which download\n\n'
printf '| File | Game |\n| --- | --- |\n'
for lane in "${lanes[@]}"; do
  archive="$(release_lane_archive_name "$archive_base" "$lane")"
  branch="$(release_lane_steam_branch "$lane")"
  minimum="$(release_lane_min_game_version "$lane")"
  if [[ "$lane" == "$RELEASE_LANE_DEFAULT" ]]; then
    where="the default branch"
  else
    where="the \`$branch\` branch"
  fi
  if [[ -n "$minimum" ]]; then
    printf '| `%s` | requires **%s** — %s |\n' "$archive" "$minimum" "$where"
  else
    printf '| `%s` | built against **%s** — %s |\n' \
      "$archive" "$(release_lane_game_build "$lane")" "$where"
  fi
done

printf '\nTake the first unless you have opted Slay the Spire 2 into its `public-beta` branch on Steam.\n'
printf 'On the Steam Workshop this is one item and Steam gives you the build matching your branch\n'
printf 'automatically.\n'
