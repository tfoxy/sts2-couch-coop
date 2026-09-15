#!/usr/bin/env bash
# Print the body of a GitHub Release: the version's CHANGELOG section, then a short note saying what
# the download is and what it runs on.
#
#   scripts/release-body.sh v0.1.2
#
# Used by .github/workflows/release.yml as BOTH the release body and the gate that a tag cannot be
# cut without notes -- scripts/changelog-section.sh exits non-zero on a missing or empty section and
# that status is propagated here, so the workflow step keeps failing the release exactly as before.
#
# A release is ONE archive carrying every lane, so there is nothing for a player to pick and no
# download table to generate. The game versions the note names are still read from the lane list, so
# adding a game branch does not mean editing release prose.
#
# Two things in the wording are load-bearing:
#
#   * The payload REQUIRES the lowest lane floor -- the game itself refuses to load it below that --
#     while the newer builds it carries lanes for are ones it is BUILT FOR, not limited to. Saying
#     "requires" of the newest would tell players the download stops working at the next game update.
#   * Never say Steam hands a subscriber the build matching their game branch. It does not: the
#     client's periodic refresh takes an item's newest revision branch-blind, which is the whole
#     reason one payload carries every lane. See scripts/lib/release-lanes.sh and
#     docs/commit-and-release.md, "One payload, one revision".

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

archive="$(release_archive_name "couchcoop-$tag")"
checksums="$(release_checksums_name "$archive").SHA256SUMS"
mapfile -t lanes < <(release_lane_discover "$repo_root/eng/Sts2.ReferenceSdk")

# The list joiner and the lane facts below both come from scripts/lib/release-lanes.sh, which is also
# what the Steam Workshop change note renders its compatibility line from. Same table, two media: this
# body is Markdown, a Steam change note is BBCode and would print backticks literally.
join_with_and() { release_join_with_and "$@"; }

where=()
builds=()
for lane in "${lanes[@]}"; do
  if [[ "$lane" == "$RELEASE_LANE_DEFAULT" ]]; then
    where+=("the normal game")
  else
    where+=("its \`$(release_lane_steam_branch "$lane")\` branch")
  fi
  builds+=("$(release_lane_game_build "$lane")")
done

printf '\n## Download\n\n'
printf '`%s` is the whole release: one download, whichever version of the game you play.\n' "$archive"
printf "Extract it into the game's \`mods\` folder.\n\n"
printf 'It needs Slay the Spire 2 **%s** or newer, and runs on %s.\n' \
  "$(release_payload_min_game_version "${lanes[@]}")" "$(join_with_and "${where[@]}")"
printf 'The download carries a build for each of those (%s), and the mod picks the one that fits\n' \
  "$(join_with_and "${builds[@]}")"
printf 'the game it is loaded into, so there is nothing to choose.\n\n'
printf 'On the Steam Workshop it is the same single build, published as one item.\n\n'
printf '`%s` is published beside it. To check a download:\n\n' "$checksums"
printf '```sh\nsha256sum -c %s\ngh attestation verify %s -R tfoxy/sts2-couch-coop\n```\n' \
  "$checksums" "$archive"
