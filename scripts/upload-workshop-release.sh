#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/upload-workshop-release.sh [--dist <directory>]
                                          [--workspace <directory>] [--visibility private|public|unlisted|friends_only]
                                          [--yes]

Publishes a CouchCoop release to a Steam Workshop item. A release is ONE archive
carrying every reference lane, so this is ONE revision -- linked to no game branch,
because the Steam client's periodic refresh picks an item's newest revision without
looking at branch links. See docs/commit-and-release.md, "One payload, one revision".

With no arguments it takes the latest published GitHub Release and publishes it to
the public listing. --dist reads a locally built release directory instead; it must
hold exactly one release archive.

--workspace selects which item to publish, so one uploader binary can serve several
(the public listing and a standing unlisted DEV item, say). A workspace may declare
the lanes it is allowed to carry, one per line, in <workspace>/lane.txt; since one
payload carries them all, a workspace must allow every lane of the release.

--visibility is applied only on a first publish (no <workspace>/mod_id.txt yet) or
when passed explicitly; otherwise the item keeps the visibility it has.

Publishing to the public listing asks for confirmation first. --yes skips that, and
is the only way to do it non-interactively.

The change note is the CHANGELOG.md section, the same bytes the GitHub Release body
uses, under a heading naming the payload's version.

Environment:
  COUCHCOOP_WORKSHOP_UPLOADER_DIR    uploader directory (default: <repo>/.sts2/uploader)
  COUCHCOOP_WORKSHOP_WORKSPACE_DIR   workspace directory (default: <uploader dir>/Workspace)
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/release-lanes.sh
source "$repo_root/scripts/lib/release-lanes.sh"
readonly LOCALIZED_UPLOADER_COMMIT="84e755cea6bcfa014df3165c882f1824259245c6"
readonly LOCALIZED_UPLOADER_VERSION="1.0.0+84e755cea6bcfa014df3165c882f1824259245c6"
# An unset --visibility must stay distinguishable from one passed with the default value,
# because only an explicit flag may rewrite an already-published item's visibility.
visibility_default="private"
visibility=""
visibility_explicit=false
workspace_arg=""
dist_dir=""
assume_yes=false

while [[ $# -gt 0 ]]; do
  case "$1" in
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

[[ -d "$workspace" ]] || {
  echo "Workshop workspace does not exist: $workspace" >&2
  echo "Create it with the official ModUploader before running this script." >&2
  exit 1
}
# Resolved AFTER the existence check (so a bad path is reported as the user typed it) but BEFORE
# any other use: ModUploader itself is invoked as `cd "$uploader_dir" && ./ModUploader -w
# "$workspace"`, so a relative workspace would be re-interpreted against $uploader_dir instead of
# the directory this script was run from -- doubling e.g. .sts2/uploader/Workspace.dev into
# .sts2/uploader/.sts2/uploader/Workspace.dev, which ModUploader then reports missing.
workspace="$(cd "$workspace" && pwd)"
config_source="$workspace/workshop.json"
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

# The public item carries the tracked multilingual metadata. Other workspaces deliberately keep
# their own copy -- in particular Workspace.dev is an English-only tester warning.
canonical_public_workspace="$uploader_dir/Workspace"
is_public_workspace=false
if [[ -d "$canonical_public_workspace" ]] && [[ "$workspace" == "$(cd "$canonical_public_workspace" && pwd)" ]]; then
  is_public_workspace=true
fi

require_localized_uploader() {
  local marker actual_version actual_sha
  marker="$uploader_dir/.couchcoop-localized-uploader.json"
  [[ -f "$marker" ]] || {
    echo "The public Workshop item needs the PR #12-capable uploader." >&2
    echo "Run scripts/install-localized-workshop-uploader.sh first." >&2
    exit 1
  }
  jq -e --arg commit "$LOCALIZED_UPLOADER_COMMIT" --arg version "$LOCALIZED_UPLOADER_VERSION" \
    '.commit == $commit and .version == $version and (.modUploaderSha256 | strings | length == 64)' \
    "$marker" >/dev/null || {
    echo "Localized uploader marker is invalid: $marker" >&2
    echo "Run scripts/install-localized-workshop-uploader.sh again." >&2
    exit 1
  }
  actual_version="$($uploader --version)"
  [[ "$actual_version" == "$LOCALIZED_UPLOADER_VERSION" ]] || {
    echo "Localized uploader version mismatch: expected $LOCALIZED_UPLOADER_VERSION, got $actual_version" >&2
    echo "Run scripts/install-localized-workshop-uploader.sh again." >&2
    exit 1
  }
  actual_sha="$(sha256sum "$uploader" | awk '{print $1}')"
  [[ "$actual_sha" == "$(jq -r '.modUploaderSha256' "$marker")" ]] || {
    echo "Localized uploader binary does not match its marker: $uploader" >&2
    echo "Run scripts/install-localized-workshop-uploader.sh again." >&2
    exit 1
  }
}

[[ "$is_public_workspace" == true ]] && require_localized_uploader

# The lanes this release carries. A release is ONE archive whose payload holds every lane, so this
# is no longer a selection -- it is the list a workspace has to be allowed to carry.
mapfile -t lanes < <(release_lane_discover "$repo_root/eng/Sts2.ReferenceSdk")
[[ ${#lanes[@]} -gt 0 ]] || { echo "no release lane to publish" >&2; exit 1; }

# A workspace may declare which lanes it is allowed to carry, one per line in lane.txt. Getting this
# wrong is the worst outcome this script has: publishing a payload a workspace is not meant to carry
# reaches every subscriber of that item. It is a LIST, not a single pin, and because one payload now
# carries every lane, a workspace must allow ALL of them -- a workspace pinned to a single lane can
# no longer publish a release, which is correct, because no single-lane payload exists any more.
# Checked before anything is uploaded. The uploader ignores workspace files it does not know, so
# lane.txt is never sent to Steam.
if [[ -f "$workspace/lane.txt" ]]; then
  mapfile -t allowed_lanes < <(grep -vE '^\s*(#|$)' "$workspace/lane.txt" | tr -d '[:blank:]')
  for lane in ${lanes[@]+"${lanes[@]}"}; do
    lane_allowed=false
    for allowed in ${allowed_lanes[@]+"${allowed_lanes[@]}"}; do
      [[ "$allowed" == "$lane" ]] && lane_allowed=true
    done
    [[ "$lane_allowed" == true ]] || {
      echo "workspace $workspace may publish lane(s) [${allowed_lanes[*]}], but this release carries '$lane'" >&2
      echo "One payload carries every lane, so the workspace has to allow them all: add it to lane.txt." >&2
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

localized_config=""
if [[ "$is_public_workspace" == true ]]; then
  localized_config="$stage_dir/workshop-localizations.json"
  "$repo_root/scripts/render-workshop-localizations.sh" --base "$config_source" --output "$localized_config"
fi

# ---- resolve the release this run publishes ---------------------------------------------------
# One release, one archive. A directory holding more than one is refused rather than resolved by
# "newest wins": a stale archive from an earlier build is exactly how the wrong payload reaches an
# item, and the newest name is not evidence of what anyone meant to publish. This also catches a
# leftover from the retired two-archive shape -- `couchcoop-<tag>-public-beta.zip` is a second name,
# so a directory still holding one is refused instead of publishing half of an old release.
if [[ -n "$dist_dir" ]]; then
  [[ -d "$dist_dir" ]] || { echo "local release directory does not exist: $dist_dir" >&2; exit 1; }
  mapfile -t bases < <(
    find "$dist_dir" -maxdepth 1 -type f -name 'couchcoop-*.zip' -printf '%f\n' \
      | sed -E 's/\.zip$//' \
      | sort -u
  )
  [[ ${#bases[@]} -ne 0 ]] || { echo "no couchcoop release archive found in: $dist_dir" >&2; exit 1; }
  [[ ${#bases[@]} -eq 1 ]] || {
    echo "$dist_dir holds ${#bases[@]} different release archives: ${bases[*]}" >&2
    echo "A release publishes exactly one couchcoop-<tag>.zip. Keep the one you mean to publish," >&2
    echo "or point --dist at a directory that holds only it." >&2
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
  gh release download "$tag" --repo tfoxy/sts2-couch-coop \
    --pattern "$archive_base.zip" --pattern "$archive_base.SHA256SUMS" --dir "$stage_dir"
  dist_dir="$stage_dir"
fi

[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ || "$tag" =~ ^snapshot-[0-9a-f]+$ ]] || {
  echo "release archives do not carry a vMAJOR.MINOR.PATCH tag: $archive_base" >&2
  exit 1
}
archive_path="$dist_dir/$archive_base.zip"
checksums_path="$dist_dir/$archive_base.SHA256SUMS"
[[ -f "$archive_path" ]] || { echo "release is missing its archive: $archive_path" >&2; exit 1; }
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
# One revision, one note: the CHANGELOG section, the same content the GitHub Release body uses --
# rendered as BBCode, because that is what a Steam change note is. Shipped verbatim, the section's
# own Markdown appeared literally on the item page ("### Fixed", "- item"), which made the release
# notes the one place the project's formatting did not survive contact with its reader.
if [[ "$tag" == snapshot-* ]]; then
  release_notes="Test build of an unreleased commit. Not a release; see the GitHub repository for what is in it."
else
  release_notes="$(bash "$repo_root/scripts/changelog-section.sh" "$tag" | release_markdown_to_bbcode)" || {
    echo "CHANGELOG.md has no section for $tag; a release cannot be published without notes" >&2
    exit 1
  }
fi

# ---- confirm before touching the public listing --------------------------------------------------
# The default workspace is the public listing. Publishing to it is the one action here that reaches
# every subscriber, so it is never the by-product of a command someone half-typed.
is_default_workspace=false
[[ -z "$workspace_arg" && -z "${COUCHCOOP_WORKSHOP_WORKSPACE_DIR:-}" ]] && is_default_workspace=true
if [[ "$is_default_workspace" == true && "$assume_yes" != true ]]; then
  printf 'About to publish to the PUBLIC Workshop listing:\n' >&2
  printf '  item      %s\n' "$(cat "$workspace/mod_id.txt" 2>/dev/null || echo '(new item)')" >&2
  printf '  release   %s\n' "$tag" >&2
  printf '  payload   %s  (lanes: %s)\n' "$archive_base.zip" "${lanes[*]}" >&2
  [[ -t 0 ]] || {
    echo "Refusing: stdin is not a terminal and --yes was not passed." >&2
    exit 1
  }
  read -r -p "Publish to the public listing? [y/N] " reply
  [[ "$reply" == [yY] || "$reply" == [yY][eE][sS] ]] || { echo "Aborted." >&2; exit 1; }
fi

# ---- publish one revision --------------------------------------------------------------------
# The gate reads the archive's own couchcoop/build-info.txt. A tagged release's payload version is
# the tag without its v; a snapshot's is stamped from the mod manifest and is not derivable from the
# filename, so the gate checks the payload's internal consistency instead of an expected string.
version_args=()
[[ "$tag" == snapshot-* ]] || version_args=(--version "${tag#v}")
"$repo_root/scripts/verify-release-archive.sh" \
  --archive "$archive_path" --checksums "$checksums_path" ${version_args[@]+"${version_args[@]}"}

extract_dir="$stage_dir/extract"
rm -rf "$extract_dir"
unzip -q "$archive_path" -d "$extract_dir"
[[ -d "$extract_dir/couchcoop" ]] || { echo "release archive has no couchcoop payload directory" >&2; exit 1; }

# The heading names the VERSION, because a Steam revision otherwise says nothing about what it is,
# and the tag is not the version for a snapshot -- a snapshot's filename carries only a commit sha
# while its payload carries `<base version>+snapshot.<sha>`. Taking the version from the payload
# covers both cases with one rule, and for a tagged release the gate has already held the two equal.
payload_version="$(jq -er '.version' "$extract_dir/couchcoop/build-info.txt")"
if [[ "$tag" == snapshot-* ]]; then heading="Test build $payload_version"; else heading="Release v$payload_version"; fi

# Which games this revision runs on, stated on the revision itself. A subscriber cannot see the
# payload, and the branch chip that used to answer this is gone with the branch links -- so without
# this line a Steam revision says nothing about whether it is for the game the reader is playing.
# Generated from the lanes the archive actually carries, not from the reviewed table, so a payload
# built without a lane cannot advertise it. Plain text: Steam renders BBCode, not Markdown.
mapfile -t payload_lanes < <(
  jq -er '.dependencies.sts2References | keys_unsorted[]' "$extract_dir/couchcoop/build-info.txt")
[[ ${#payload_lanes[@]} -gt 0 ]] || { echo "release payload declares no lanes" >&2; exit 1; }
compatibility="$(release_compatibility_summary "${payload_lanes[@]}")"

change_note="$(printf '%s\n\n%s\n\n%s\n' "$heading" "$compatibility" "$release_notes")"

config_for_upload="$config_source"
[[ "$is_public_workspace" != true ]] || config_for_upload="$localized_config"

# minBranch/maxBranch are DELETED, never written -- including out of whatever a workspace's own
# workshop.json still declares from the retired branch-linked shape. A branch-linked revision is
# only served to the branch it is linked to by the client's SUBSCRIBE path; the periodic refresh
# that runs every ~45 minutes takes an item's NEWEST revision regardless of branch, so branch links
# cannot keep two lanes apart on one item. See docs/commit-and-release.md, "One payload, one
# revision". Deleting them also retires the multi-minute CommittingChanges/k_EResultTimeout commit
# that only ever happened to uploads carrying these keys.
#
# A published item's visibility is the maintainer's setting, not this script's: it is applied only
# on a first publish, or when --visibility was passed explicitly. mod_id.txt is what proves the item
# exists -- workshop.json is required above, so its presence would prove nothing.
if [[ "$visibility_explicit" == true || ! -f "$workspace/mod_id.txt" ]]; then
  jq --arg visibility "$visibility" --arg change_note "$change_note" \
    'del(.minBranch, .maxBranch) | .visibility = $visibility | .changeNote = $change_note' \
    "$config_for_upload" > "$stage_dir/workshop.json"
  visibility_report="$visibility"
else
  jq --arg change_note "$change_note" \
    'del(.minBranch, .maxBranch) | .changeNote = $change_note' \
    "$config_for_upload" > "$stage_dir/workshop.json"
  visibility_report="$(jq -r '.visibility // "unset"' "$config_for_upload") (left as the workspace declares it)"
fi

# Gallery previews are intentionally managed manually: with no previews/ directory in the
# workspace, the uploader leaves the item's existing gallery untouched.
rm -rf -- "$workspace/content"
mkdir -p "$workspace/content"
cp -a "$extract_dir/couchcoop/." "$workspace/content/"
cp "$stage_dir/workshop.json" "$workspace/workshop.json"

printf 'Uploading %s from %s with visibility %s...\n' "$tag" "$workspace" "$visibility_report"
# `set -e` would abort on the failing pipeline before the status could be read, and PIPESTATUS does
# not survive an `|| var=$?`. Disable the trap for exactly this call and read PIPESTATUS on the very
# next line, which is the only place it is still the uploader's.
set +e
(cd "$uploader_dir" && ./ModUploader upload -w "$workspace") 2>&1 | tee "$stage_dir/upload.log"
upload_status=${PIPESTATUS[0]}
set -e
if [[ "$upload_status" -ne 0 ]]; then
  echo "the upload failed" >&2
  # An uploader's non-zero exit is a claim about the CLIENT, not about server state: this is how a
  # slow commit was once read as a rejection, and the change had landed. Look at the item page
  # before running anything again.
  echo "Check the item page before retrying: a non-zero exit says the client gave up, not that" >&2
  echo "Steam rejected the update, and a blind retry republishes the same content." >&2
  exit 1
fi
