#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/upload-workshop-release.sh [--lane stable|public-beta]
                                          [--visibility private|public|unlisted|friends_only]
                                          [--workspace <directory>] [--dist <directory>]

Downloads, verifies, and uploads the latest published CouchCoop GitHub Release.
--dist instead uses a local release directory's archive for the selected lane,
with its matching checksums file.
The first successful upload creates the Workshop item and writes its ID to
<workspace>/mod_id.txt. Later uploads update that same item.

--lane selects which game-branch archive to publish: `stable` (the default) is
couchcoop-<tag>.zip, every other lane is couchcoop-<tag>-<lane>.zip. It is never
inferred from what happens to be newest in a directory -- a release publishes one
archive per lane, so guessing would hand the wrong payload to the wrong item. The
gate re-checks the chosen archive's own build-info.txt against the lane.

--workspace selects which workspace to publish, so one uploader binary can serve
several items (the public listing and a standing unlisted DEV item, say). Every
workspace precondition applies to the selected workspace.

--visibility is applied only on a first publish (no <workspace>/mod_id.txt yet)
or when the flag is passed explicitly. A run that omits it leaves the published
item's visibility exactly as the workspace already declares it.

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
lane="$RELEASE_LANE_DEFAULT"
lane_explicit=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lane)
      [[ "$lane_explicit" == false ]] || {
        echo "--lane may be specified only once" >&2
        exit 2
      }
      lane="${2:-}"
      release_lane_is_known "$lane" || {
        echo "unknown release lane '$lane'; see scripts/lib/release-lanes.sh" >&2
        exit 2
      }
      lane_explicit=true
      shift 2
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
[[ $(stat -c %s "$workspace/image.png") -lt 1048576 ]] || {
  echo "Workshop primary preview must be smaller than 1 MiB: $workspace/image.png" >&2
  exit 1
}
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-workshop-upload.XXXXXX")"
trap 'rm -rf "$stage_dir"' EXIT

if [[ -n "$dist_dir" ]]; then
  [[ -d "$dist_dir" ]] || {
    echo "local release directory does not exist: $dist_dir" >&2
    exit 1
  }
  # Anchored on the lane, so a dist directory holding both lanes' archives cannot resolve to the
  # other one. Only the release VERSION is picked by sort -V, never the lane.
  mapfile -t archives < <(
    find "$dist_dir" -maxdepth 1 -type f -printf '%f\n' \
      | grep -E "$(release_lane_release_archive_regex "$lane")" \
      | sort -V
  )
  if [[ ${#archives[@]} -eq 0 ]]; then
    # A --snapshot build is deliberately not publishable: a Workshop item is a copy of an archive
    # that already exists as a GitHub Release, and a snapshot has no release and no tag.
    if find "$dist_dir" -maxdepth 1 -type f -printf '%f\n' \
      | grep -qE "$(release_lane_snapshot_archive_regex "$lane")"; then
      echo "$dist_dir holds only a snapshot archive for lane $lane; the Workshop publishes tagged releases" >&2
    else
      echo "no lane $lane release archive found in: $dist_dir" >&2
    fi
    exit 1
  fi
  archive_name="${archives[${#archives[@]} - 1]}"
  tag="${archive_name#couchcoop-}"
  tag="${tag%.zip}"
  # A suffixed lane archive carries the lane in its filename; the tag is what is left.
  [[ "$lane" == "$RELEASE_LANE_DEFAULT" ]] || tag="${tag%-$lane}"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "archive name does not carry a vMAJOR.MINOR.PATCH tag: $archive_name" >&2
    exit 1
  }
  archive_path="$dist_dir/$archive_name"
else
  release_json="$(gh release view --repo tfoxy/sts2-couch-coop --json tagName)"
  tag="$(jq -er '.tagName | strings | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))' <<<"$release_json")" || {
    echo "latest GitHub Release must have a vMAJOR.MINOR.PATCH tag" >&2
    exit 1
  }
  archive_name="$(release_lane_archive_name "couchcoop-${tag}" "$lane")"
  gh release download "$tag" --repo tfoxy/sts2-couch-coop \
    --pattern "$archive_name" \
    --pattern "${archive_name%.zip}.SHA256SUMS" \
    --dir "$stage_dir"
  archive_path="$stage_dir/$archive_name"
fi

# Two published assets per lane: the archive and its checksums. The per-file contents manifest is
# recomputed by the gate, and the build metadata rides inside the payload as build-info.txt.
checksums_name="${archive_name%.zip}.SHA256SUMS"
if [[ -n "$dist_dir" ]]; then
  checksums_path="$dist_dir/$checksums_name"
else
  checksums_path="$stage_dir/$checksums_name"
fi

for asset in "$archive_path" "$checksums_path"; do
  [[ -f "$asset" ]] || {
    echo "release is missing a required asset: $asset" >&2
    exit 1
  }
done

# --lane here is not a formality: the gate reads the archive's own couchcoop/build-info.txt and
# fails when the payload was built for another game branch, so a mislabelled file cannot reach an item.
"$repo_root/scripts/verify-release-archive.sh" \
  --archive "$archive_path" \
  --checksums "$checksums_path" \
  --lane "$lane" \
  --version "${tag#v}"

extract_dir="$stage_dir/extract"
unzip -q "$archive_path" -d "$extract_dir"
[[ -d "$extract_dir/couchcoop" ]] || {
  echo "release archive has no couchcoop payload directory" >&2
  exit 1
}

if [[ "$lane" == "$RELEASE_LANE_DEFAULT" ]]; then
  change_note="Release $tag"
else
  # Two items now differ by which game branch they target, so the note says which one this is.
  change_note="Release $tag ($lane)"
fi
# A published item's visibility lives in the workspace and is the maintainer's setting, not this
# script's: a release upload writes the change note and nothing else. mod_id.txt is what proves the
# item exists — workshop.json is required above, so its presence would prove nothing.
if [[ "$visibility_explicit" == true || ! -f "$workspace/mod_id.txt" ]]; then
  jq --arg visibility "$visibility" --arg change_note "$change_note" \
    '.visibility = $visibility | .changeNote = $change_note' \
    "$config_source" > "$stage_dir/workshop.json"
  visibility_report="$visibility"
else
  jq --arg change_note "$change_note" '.changeNote = $change_note' \
    "$config_source" > "$stage_dir/workshop.json"
  visibility_report="$(jq -r '.visibility // "unset"' "$config_source") (left as the workspace declares it)"
fi

# Gallery previews are intentionally managed manually: with no previews/ directory in the
# workspace, the uploader leaves the item's existing gallery untouched.
rm -rf -- "$workspace/content"
mkdir -p "$workspace/content"
cp -a "$extract_dir/couchcoop/." "$workspace/content/"
cp "$stage_dir/workshop.json" "$workspace/workshop.json"

printf 'Uploading %s (lane %s) from %s to Steam Workshop with visibility %s...\n' \
  "$tag" "$lane" "$workspace" "$visibility_report"
(cd "$uploader_dir" && ./ModUploader upload -w "$workspace")
