#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/upload-workshop-release.sh [--visibility private|public|unlisted|friends_only]
                                          [--workspace <directory>] [--dist <directory>]

Downloads, verifies, and uploads the latest published CouchCoop GitHub Release.
--dist instead uses the newest couchcoop-vMAJOR.MINOR.PATCH archive in a local
release directory, with its matching contents manifest and checksums.
The first successful upload creates the Workshop item and writes its ID to
<workspace>/mod_id.txt. Later uploads update that same item.

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
# An unset --visibility must stay distinguishable from one passed with the default value,
# because only an explicit flag may rewrite an already-published item's visibility.
visibility_default="private"
visibility=""
visibility_explicit=false
workspace_arg=""
dist_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
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
  mapfile -t archives < <(
    find "$dist_dir" -maxdepth 1 -type f -printf '%f\n' \
      | grep -E '^couchcoop-v[0-9]+\.[0-9]+\.[0-9]+\.zip$' \
      | sort -V
  )
  [[ ${#archives[@]} -gt 0 ]] || {
    echo "no couchcoop-vMAJOR.MINOR.PATCH.zip archive found in: $dist_dir" >&2
    exit 1
  }
  archive_name="${archives[${#archives[@]} - 1]}"
  tag="${archive_name#couchcoop-}"
  tag="${tag%.zip}"
  archive_path="$dist_dir/$archive_name"
else
  release_json="$(gh release view --repo tfoxy/sts2-couch-coop --json tagName)"
  tag="$(jq -er '.tagName | strings | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))' <<<"$release_json")" || {
    echo "latest GitHub Release must have a vMAJOR.MINOR.PATCH tag" >&2
    exit 1
  }
  archive_name="couchcoop-${tag}.zip"
  gh release download "$tag" --repo tfoxy/sts2-couch-coop \
    --pattern "$archive_name" \
    --pattern "couchcoop-${tag}.contents.json" \
    --pattern "couchcoop-${tag}.build-info.json" \
    --pattern "couchcoop-${tag}.SHA256SUMS" \
    --dir "$stage_dir"
  archive_path="$stage_dir/$archive_name"
fi

contents_name="couchcoop-${tag}.contents.json"
build_info_name="couchcoop-${tag}.build-info.json"
checksums_name="couchcoop-${tag}.SHA256SUMS"
if [[ -n "$dist_dir" ]]; then
  contents_path="$dist_dir/$contents_name"
  build_info_path="$dist_dir/$build_info_name"
  checksums_path="$dist_dir/$checksums_name"
else
  contents_path="$stage_dir/$contents_name"
  build_info_path="$stage_dir/$build_info_name"
  checksums_path="$stage_dir/$checksums_name"
fi

for asset in "$archive_path" "$contents_path" "$build_info_path" "$checksums_path"; do
  [[ -f "$asset" ]] || {
    echo "release is missing a required asset: $asset" >&2
    exit 1
  }
done

"$repo_root/scripts/verify-release-archive.sh" \
  --archive "$archive_path" \
  --contents "$contents_path" \
  --checksums "$checksums_path"

extract_dir="$stage_dir/extract"
unzip -q "$archive_path" -d "$extract_dir"
[[ -d "$extract_dir/couchcoop" ]] || {
  echo "release archive has no couchcoop payload directory" >&2
  exit 1
}

change_note="Release $tag"
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

printf 'Uploading %s from %s to Steam Workshop with visibility %s...\n' \
  "$tag" "$workspace" "$visibility_report"
(cd "$uploader_dir" && ./ModUploader upload -w "$workspace")
