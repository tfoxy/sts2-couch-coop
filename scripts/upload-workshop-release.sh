#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/upload-workshop-release.sh [--lane stable|public-beta] [--dist <directory>]
                                          [--workspace <directory>] [--visibility private|public|unlisted|friends_only]
                                          [--yes]

Publishes a CouchCoop release to a Steam Workshop item. With no arguments it takes
the latest published GitHub Release and uploads EVERY lane to the public listing,
one revision per lane, each linked to the game branch its payload was built for --
which is how one item serves both the normal game and its public-beta branch.

--lane narrows the run to a single lane. --dist reads a locally built release
directory instead of the GitHub Release; it must hold exactly one version.

--workspace selects which item to publish, so one uploader binary can serve several
(the public listing and a standing unlisted DEV item, say). A workspace may declare
the lanes it is allowed to carry, one per line, in <workspace>/lane.txt.

--visibility is applied only on a first publish (no <workspace>/mod_id.txt yet) or
when passed explicitly; otherwise the item keeps the visibility it has.

Publishing to the public listing asks for confirmation first. --yes skips that, and
is the only way to do it non-interactively.

Change notes come from CHANGELOG.md, the same section the GitHub Release body uses.
The default lane's revision carries the list; other lanes' revisions point at it,
because Steam shows one change note per revision and the list should not be duplicated.

Environment:
  COUCHCOOP_WORKSHOP_UPLOADER_DIR    uploader directory (default: <repo>/.sts2/uploader)
  COUCHCOOP_WORKSHOP_WORKSPACE_DIR   workspace directory (default: <uploader dir>/Workspace)
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/release-lanes.sh
source "$repo_root/scripts/lib/release-lanes.sh"
# An unset --visibility must stay distinguishable from one passed with the default value,
# because only an explicit flag may rewrite an already-published item's visibility.
visibility_default="private"
visibility=""
visibility_explicit=false
workspace_arg=""
dist_dir=""
lane_filter=""
assume_yes=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lane)
      [[ -z "$lane_filter" ]] || {
        echo "--lane may be specified only once" >&2
        exit 2
      }
      lane_filter="${2:-}"
      release_lane_is_known "$lane_filter" || {
        echo "unknown release lane '$lane_filter'; see scripts/lib/release-lanes.sh" >&2
        exit 2
      }
      shift 2
      ;;
    --yes)
      assume_yes=true
      shift
      ;;
    --visibility)
      visibility="${2:-}"
      visibility_explicit=true
      shift 2
      ;;
    --workspace)
      [[ -z "$workspace_arg" ]] || {
        echo "--workspace may be specified only once" >&2
        exit 2
      }
      workspace_arg="${2:-}"
      [[ -n "$workspace_arg" ]] || {
        echo "--workspace requires a directory" >&2
        exit 2
      }
      shift 2
      ;;
    --dist)
      [[ -z "$dist_dir" ]] || {
        echo "--dist may be specified only once" >&2
        exit 2
      }
      dist_dir="${2:-}"
      [[ -n "$dist_dir" ]] || {
        echo "--dist requires a directory" >&2
        exit 2
      }
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[[ "$visibility_explicit" == true ]] || visibility="$visibility_default"

case "$visibility" in
  private|public|unlisted|friends_only) ;;
  *)
    echo "invalid visibility '$visibility'; expected private, public, unlisted, or friends_only" >&2
    exit 2
    ;;
esac

for command in jq unzip sha256sum; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done
if [[ -z "$dist_dir" ]]; then
  command -v gh >/dev/null || {
    echo "missing required command: gh" >&2
    exit 1
  }
fi

uploader_dir="${COUCHCOOP_WORKSHOP_UPLOADER_DIR:-$repo_root/.sts2/uploader}"
# The uploader binary needs libsteam_api.so and steam_appid.txt beside it, so it stays where it
# is and the workspace travels instead: flag, then environment, then the uploader's own default.
workspace="${workspace_arg:-${COUCHCOOP_WORKSHOP_WORKSPACE_DIR:-$uploader_dir/Workspace}}"
uploader="$uploader_dir/ModUploader"
config_source="$workspace/workshop.json"

[[ -d "$workspace" ]] || {
  echo "Workshop workspace does not exist: $workspace" >&2
  echo "Create it with the official ModUploader before running this script." >&2
  exit 1
}
[[ -x "$uploader" ]] || {
  echo "official ModUploader is missing or not executable: $uploader" >&2
  exit 1
}
[[ -f "$config_source" ]] || {
  echo "Workshop config is missing: $config_source" >&2
  echo "Create it from the official uploader template before running this script." >&2
  exit 1
}
[[ -f "$workspace/image.png" ]] || {
  echo "Workshop primary preview is missing: $workspace/image.png" >&2
  exit 1
}
# Which lanes this run publishes. Default is every lane the release has, because one Workshop item
# serves both game branches through one revision each; --lane narrows it.
mapfile -t all_lanes < <(release_lane_discover "$repo_root/eng/Sts2.ReferenceSdk")
lanes=()
if [[ -n "$lane_filter" ]]; then
  lanes=("$lane_filter")
else
  lanes=(${all_lanes[@]+"${all_lanes[@]}"})
fi
[[ ${#lanes[@]} -gt 0 ]] || { echo "no release lane to publish" >&2; exit 1; }

# A workspace may declare which lanes it is allowed to carry, one per line in lane.txt. Getting this
# wrong is the worst outcome this script has: publishing the public-beta payload as the public
# listing's only content breaks the mod for every subscriber on the normal game branch. It is a LIST,
# not a single pin, because one item legitimately carries both. Checked for EVERY lane before
# anything is uploaded, so a two-lane run cannot publish one and then refuse the other. The uploader
# ignores workspace files it does not know, so lane.txt is never sent to Steam.
if [[ -f "$workspace/lane.txt" ]]; then
  mapfile -t allowed_lanes < <(grep -vE '^\s*(#|$)' "$workspace/lane.txt" | tr -d '[:blank:]')
  for lane in ${lanes[@]+"${lanes[@]}"}; do
    lane_allowed=false
    for allowed in ${allowed_lanes[@]+"${allowed_lanes[@]}"}; do
      [[ "$allowed" == "$lane" ]] && lane_allowed=true
    done
    [[ "$lane_allowed" == true ]] || {
      echo "workspace $workspace may publish lane(s) [${allowed_lanes[*]}], but this run publishes '$lane'" >&2
      echo "Publish a lane that workspace is for, or add the lane to its lane.txt." >&2
      exit 1
    }
  done
fi
[[ $(stat -c %s "$workspace/image.png") -lt 1048576 ]] || {
  echo "Workshop primary preview must be smaller than 1 MiB: $workspace/image.png" >&2
  exit 1
}

stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-workshop-upload.XXXXXX")"
trap 'rm -rf "$stage_dir"' EXIT

# ---- resolve the release this run publishes ---------------------------------------------------
# One release, one version, every lane. A directory holding two versions is refused rather than
# resolved by "newest wins": a stale archive from an earlier build is exactly how the wrong payload
# reaches an item, and the newest name is not evidence of what anyone meant to publish.
if [[ -n "$dist_dir" ]]; then
  [[ -d "$dist_dir" ]] || { echo "local release directory does not exist: $dist_dir" >&2; exit 1; }
  lane_alternation="$(IFS='|'; echo "${all_lanes[*]}")"
  mapfile -t bases < <(
    find "$dist_dir" -maxdepth 1 -type f -name 'couchcoop-*.zip' -printf '%f\n' \
      | sed -E "s/\.zip\$//; s/-($lane_alternation)\$//" \
      | sort -u
  )
  [[ ${#bases[@]} -ne 0 ]] || { echo "no couchcoop release archive found in: $dist_dir" >&2; exit 1; }
  [[ ${#bases[@]} -eq 1 ]] || {
    echo "$dist_dir holds ${#bases[@]} different releases: ${bases[*]}" >&2
    echo "Keep one, or point --dist at a directory that holds only the release you mean to publish." >&2
    exit 1
  }
  archive_base="${bases[0]}"
  tag="${archive_base#couchcoop-}"
else
  release_json="$(gh release view --repo tfoxy/sts2-couch-coop --json tagName)"
  tag="$(jq -er '.tagName | strings | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))' <<<"$release_json")" || {
    echo "latest GitHub Release must have a vMAJOR.MINOR.PATCH tag" >&2
    exit 1
  }
  archive_base="couchcoop-${tag}"
  patterns=()
  for lane in ${lanes[@]+"${lanes[@]}"}; do
    patterns+=(--pattern "$(release_lane_archive_name "$archive_base" "$lane")")
  done
  gh release download "$tag" --repo tfoxy/sts2-couch-coop \
    "${patterns[@]}" --pattern "$archive_base.SHA256SUMS" --dir "$stage_dir"
  dist_dir="$stage_dir"
fi

[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ || "$tag" =~ ^snapshot-[0-9a-f]+$ ]] || {
  echo "release archives do not carry a vMAJOR.MINOR.PATCH tag: $archive_base" >&2
  exit 1
}
checksums_path="$dist_dir/$archive_base.SHA256SUMS"
[[ -f "$checksums_path" ]] || { echo "release is missing its checksums: $checksums_path" >&2; exit 1; }

# A snapshot is not a release, so the public listing will not take one; the DEV channel exists
# precisely to publish builds that are not releases yet, and opts in with a marker file.
if [[ "$tag" == snapshot-* && ! -f "$workspace/dev-channel" ]]; then
  echo "$dist_dir holds a snapshot build, and $workspace is not a dev channel" >&2
  echo "The Workshop publishes tagged releases. To publish pre-release builds to a DEV item," >&2
  echo "create an empty '$workspace/dev-channel' marker file." >&2
  exit 1
fi

# ---- change notes ------------------------------------------------------------------------------
# Steam shows one change note per revision, and a release publishes one revision per lane. Repeating
# the whole list on each would be noise, so the default lane's revision carries it and the others
# point at that one. The list itself is the same bytes the GitHub Release body uses.
if [[ "$tag" == snapshot-* ]]; then
  release_notes="Test build of an unreleased commit. Not a release; see the GitHub repository for what is in it."
else
  release_notes="$(bash "$repo_root/scripts/changelog-section.sh" "$tag")" || {
    echo "CHANGELOG.md has no section for $tag; a release cannot be published without notes" >&2
    exit 1
  }
fi

lane_change_note() {
  local lane="$1" heading
  if [[ "$tag" == snapshot-* ]]; then heading="Test build $tag"; else heading="Release $tag"; fi
  if [[ "$lane" == "$RELEASE_LANE_DEFAULT" ]]; then
    printf '%s\n\n%s\n' "$heading" "$release_notes"
  else
    printf '%s (%s)\n\nBuilt for the %s branch of the game. The list of changes is on this update'"'"'s %s revision.\n' \
      "$heading" "$lane" "$lane" "$RELEASE_LANE_DEFAULT"
  fi
}

# ---- confirm before touching the public listing --------------------------------------------------
# The default workspace is the public listing. Publishing to it is the one action here that reaches
# every subscriber, so it is never the by-product of a command someone half-typed.
is_default_workspace=false
[[ -z "$workspace_arg" && -z "${COUCHCOOP_WORKSHOP_WORKSPACE_DIR:-}" ]] && is_default_workspace=true
if [[ "$is_default_workspace" == true && "$assume_yes" != true ]]; then
  printf 'About to publish to the PUBLIC Workshop listing:\n' >&2
  printf '  item      %s\n' "$(cat "$workspace/mod_id.txt" 2>/dev/null || echo '(new item)')" >&2
  printf '  release   %s\n' "$tag" >&2
  for lane in ${lanes[@]+"${lanes[@]}"}; do
    printf '  revision  %-12s -> game branch %s\n' "$lane" "$(release_lane_steam_branch "$lane")" >&2
  done
  [[ -t 0 ]] || {
    echo "Refusing: stdin is not a terminal and --yes was not passed." >&2
    exit 1
  }
  read -r -p "Publish to the public listing? [y/N] " reply
  [[ "$reply" == [yY] || "$reply" == [yY][eE][sS] ]] || { echo "Aborted." >&2; exit 1; }
fi

# ---- publish, one revision per lane ---------------------------------------------------------------
timed_out_lanes=()
for lane in ${lanes[@]+"${lanes[@]}"}; do
  archive_name="$(release_lane_archive_name "$archive_base" "$lane")"
  archive_path="$dist_dir/$archive_name"
  [[ -f "$archive_path" ]] || { echo "release is missing lane $lane's archive: $archive_path" >&2; exit 1; }

  # The gate reads the archive's own couchcoop/build-info.txt, so a payload built for another game
  # branch cannot reach the revision meant for this one. A tagged release's payload version is the
  # tag without its v; a snapshot's is stamped from the mod manifest and is not derivable from the
  # filename, so the gate checks the payload's internal consistency instead of an expected string.
  version_args=()
  [[ "$tag" == snapshot-* ]] || version_args=(--version "${tag#v}")
  "$repo_root/scripts/verify-release-archive.sh" \
    --archive "$archive_path" --checksums "$checksums_path" --lane "$lane" ${version_args[@]+"${version_args[@]}"}

  extract_dir="$stage_dir/extract-$lane"
  rm -rf "$extract_dir"
  unzip -q "$archive_path" -d "$extract_dir"
  [[ -d "$extract_dir/couchcoop" ]] || { echo "release archive has no couchcoop payload directory" >&2; exit 1; }

  # minBranch/maxBranch are what make one item serve two game branches: Steam gives a subscriber the
  # revision whose linked range covers the game version they are running. They are derived from the
  # lane rather than read from the workspace, because the lane is the thing being published.
  steam_branch="$(release_lane_steam_branch "$lane")"
  change_note="$(lane_change_note "$lane")"
  # A published item's visibility is the maintainer's setting, not this script's: it is applied only
  # on a first publish, or when --visibility was passed explicitly. mod_id.txt is what proves the item
  # exists -- workshop.json is required above, so its presence would prove nothing.
  if [[ "$visibility_explicit" == true || ! -f "$workspace/mod_id.txt" ]]; then
    jq --arg visibility "$visibility" --arg change_note "$change_note" --arg branch "$steam_branch" \
      '.visibility = $visibility | .changeNote = $change_note | .minBranch = $branch | .maxBranch = $branch' \
      "$config_source" > "$stage_dir/workshop.json"
    visibility_report="$visibility"
  else
    jq --arg change_note "$change_note" --arg branch "$steam_branch" \
      '.changeNote = $change_note | .minBranch = $branch | .maxBranch = $branch' \
      "$config_source" > "$stage_dir/workshop.json"
    visibility_report="$(jq -r '.visibility // "unset"' "$config_source") (left as the workspace declares it)"
  fi

  # Gallery previews are intentionally managed manually: with no previews/ directory in the
  # workspace, the uploader leaves the item's existing gallery untouched.
  rm -rf -- "$workspace/content"
  mkdir -p "$workspace/content"
  cp -a "$extract_dir/couchcoop/." "$workspace/content/"
  cp "$stage_dir/workshop.json" "$workspace/workshop.json"

  printf 'Uploading %s (lane %s -> game branch %s) from %s with visibility %s...\n' \
    "$tag" "$lane" "$steam_branch" "$workspace" "$visibility_report"
  upload_status=0
  (cd "$uploader_dir" && ./ModUploader upload -w "$workspace") 2>&1 | tee "$stage_dir/upload-$lane.log" || upload_status=$?
  if [[ ${PIPESTATUS[0]:-$upload_status} -ne 0 ]]; then
    # MEASURED: an upload whose workshop.json carries a branch range sits in CommittingChanges for
    # minutes and then the uploader gives up with k_EResultTimeout -- while the change commits
    # anyway. That is the client running out of patience, not Steam rejecting the update, so it is
    # reported and the run continues rather than aborting a half-published release.
    if grep -qF 'k_EResultTimeout' "$stage_dir/upload-$lane.log"; then
      timed_out_lanes+=("$lane")
      echo "note: lane $lane reported k_EResultTimeout; that usually still commits -- verify below." >&2
    else
      echo "lane $lane failed to upload" >&2
      exit 1
    fi
  fi
done

if [[ ${#timed_out_lanes[@]} -gt 0 ]]; then
  echo >&2
  echo "Uploaded ${#lanes[@]} revision(s); lane(s) [${timed_out_lanes[*]}] reported k_EResultTimeout." >&2
  echo "That is the uploader giving up on a slow commit, not a rejection. VERIFY on the item page" >&2
  echo "that each revision is linked to the game branch it should be, and do not blindly retry --" >&2
  echo "a retry republishes the same content and waits out the same timeout." >&2
  exit 3
fi
