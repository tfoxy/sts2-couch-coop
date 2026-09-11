#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/upload-workshop-release.sh [--visibility private|public|unlisted|friends_only] [--dist <directory>]

Downloads, verifies, and uploads the latest published CouchCoop GitHub Release.
--dist instead uses the newest couchcoop-vMAJOR.MINOR.PATCH archive in a local
release directory, with its matching contents manifest and checksums.
The first successful upload creates the Workshop item and writes its ID to
.sts2/uploader/Workspace/mod_id.txt. Later uploads update that same item.

Environment:
  COUCHCOOP_WORKSHOP_UPLOADER_DIR    uploader directory (default: <repo>/.sts2/uploader)
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
visibility="private"
dist_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --visibility)
      visibility="${2:-}"
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
workspace="$uploader_dir/Workspace"
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
    --pattern "couchcoop-${tag}.SHA256SUMS" \
    --dir "$stage_dir"
  archive_path="$stage_dir/$archive_name"
fi

contents_name="couchcoop-${tag}.contents.json"
checksums_name="couchcoop-${tag}.SHA256SUMS"
if [[ -n "$dist_dir" ]]; then
  contents_path="$dist_dir/$contents_name"
  checksums_path="$dist_dir/$checksums_name"
else
  contents_path="$stage_dir/$contents_name"
  checksums_path="$stage_dir/$checksums_name"
fi

for asset in "$archive_path" "$contents_path" "$checksums_path"; do
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
jq --arg visibility "$visibility" --arg change_note "$change_note" \
  '.visibility = $visibility | .changeNote = $change_note' \
  "$config_source" > "$stage_dir/workshop.json"

# Gallery previews are intentionally managed manually in Workspace/previews/.
rm -rf -- "$workspace/content"
mkdir -p "$workspace/content"
cp -a "$extract_dir/couchcoop/." "$workspace/content/"
cp "$stage_dir/workshop.json" "$workspace/workshop.json"

printf 'Uploading %s to Steam Workshop with visibility %s...\n' "$tag" "$visibility"
(cd "$uploader_dir" && ./ModUploader upload -w "$workspace")
