#!/usr/bin/env bash
# Cut a CouchCoop release end to end: verify siblings are pushed, re-pin
# release-dependencies.json, draft the CHANGELOG.md section, bump the mod manifest, commit,
# tag, build-verify locally, push, wait for the release workflow, then publish to the Steam
# Workshop. See docs/commit-and-release.md, "Cutting a release" and "Publishing to the Steam
# Workshop" -- this script is the automation of that runbook.
#
# Two points still need you:
#   - reviewing/editing the drafted CHANGELOG.md section before it is committed
#   - the public-listing confirmation inside scripts/upload-workshop-release.sh
#
# usage: scripts/cut-release.sh major|minor|patch

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/cut-release.sh major|minor|patch

Runs the full CouchCoop release: verifies spirectl and godot-scene-web have pushed main,
re-pins release-dependencies.json to their tips, drafts the CHANGELOG.md section (pausing for
your review), bumps src/CouchCoop.Mod.Loader/couchcoop.json, commits, tags, builds and
verifies the release archive locally, pushes, waits for the release workflow, and finally runs
scripts/upload-workshop-release.sh (which asks its own confirmation before publishing to the
public Steam Workshop listing).

See docs/commit-and-release.md, "Cutting a release".
EOF
}

bump_kind="${1:-}"
case "$bump_kind" in
  major|minor|patch) ;;
  *) usage; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

readonly REPO_SLUG="tfoxy/sts2-couch-coop"
readonly MANIFEST="src/CouchCoop.Mod.Loader/couchcoop.json"

for command in git jq gh; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }
done

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-cut-release.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

# ---- 1. preconditions ---------------------------------------------------------------------
# A dirty tree is only tolerated in the three release files -- a re-run after an aborted
# CHANGELOG.md review may have already touched them. Anything else uncommitted is refused, the
# same way package-release.sh itself refuses to package a dirty tree later.
dirty="$(git status --porcelain -- . \
  ':(exclude)CHANGELOG.md' ':(exclude)'"$MANIFEST" ':(exclude)release-dependencies.json')"
[[ -z "$dirty" ]] || {
  echo "working tree has uncommitted changes outside the release files:" >&2
  echo "$dirty" >&2
  exit 1
}

# ---- 2. verify sibling repos are pushed ----------------------------------------------------
# Reads each sibling's `main` branch tip directly, not HEAD -- a sibling checkout may currently
# have a different branch checked out, and it is main that release-dependencies.json pins.
verify_sibling_pushed() {
  local name="$1" path="$2" local_sha remote_sha
  [[ -d "$path/.git" ]] || { echo "no sibling checkout at $path" >&2; exit 1; }
  git -C "$path" fetch origin main --quiet
  local_sha="$(git -C "$path" rev-parse refs/heads/main)"
  remote_sha="$(git -C "$path" rev-parse origin/main)"
  [[ "$local_sha" == "$remote_sha" ]] || {
    echo "$name's local main ($local_sha) is not pushed to origin/main ($remote_sha)" >&2
    echo "Push $name's main branch before cutting a release." >&2
    exit 1
  }
  printf '%s' "$local_sha"
}

echo "Verifying spirectl and godot-scene-web have pushed main..."
spirectl_commit="$(verify_sibling_pushed spirectl "$repo_root/../spirectl")"
godot_scene_web_commit="$(verify_sibling_pushed godot-scene-web "$repo_root/../godot-scene-web")"

# ---- 3. compute the new version ------------------------------------------------------------
current_version="$(jq -er '.version' "$MANIFEST")"
IFS='.' read -r cur_major cur_minor cur_patch <<< "$current_version"
case "$bump_kind" in
  major) version="$((cur_major + 1)).0.0" ;;
  minor) version="$cur_major.$((cur_minor + 1)).0" ;;
  patch) version="$cur_major.$cur_minor.$((cur_patch + 1))" ;;
esac
tag="v$version"

git rev-parse -q --verify "refs/tags/$tag" >/dev/null && {
  echo "tag $tag already exists locally" >&2
  exit 1
}
[[ -z "$(git ls-remote --tags origin "$tag")" ]] || {
  echo "tag $tag already exists on origin" >&2
  exit 1
}
echo "Cutting $tag (bump: $bump_kind, from $current_version)"

# ---- 4. re-pin release-dependencies.json ---------------------------------------------------
deps_tmp="$work_dir/release-dependencies.json"
jq --arg s "$spirectl_commit" --arg g "$godot_scene_web_commit" \
  '.dependencies.spirectl.commit = $s | .dependencies["godot-scene-web"].commit = $g' \
  release-dependencies.json > "$deps_tmp"
mv "$deps_tmp" release-dependencies.json

# ---- 5 & 6. draft the CHANGELOG.md section and its footer links ---------------------------
draft_output="$(bash "$repo_root/scripts/collect-changelog.sh")"

trim_blank_lines() {
  sed -e '/./,$!d' | tac | sed -e '/./,$!d' | tac
}

version_heading="## [$version] -"
if grep -qF "$version_heading" CHANGELOG.md; then
  echo "CHANGELOG.md already has a $tag section (resuming a previous attempt) -- leaving it as-is."
else
  draft_body="$(printf '%s\n' "$draft_output" | awk '
    NR==1 && /^# / { next }
    /^# / { exit }
    { print }
  ' | trim_blank_lines)"
  [[ "$draft_body" == "(no Changelog trailers in this range)" ]] && draft_body=""

  unreleased_body="$(awk '
    /^## \[Unreleased\]/ { found=1; next }
    found && /^## / { exit }
    found { print }
  ' CHANGELOG.md | trim_blank_lines)"

  combined_body="$unreleased_body"
  if [[ -n "$draft_body" ]]; then
    if [[ -n "$combined_body" ]]; then
      combined_body="$combined_body"$'\n\n'"$draft_body"
    else
      combined_body="$draft_body"
    fi
  fi

  unreleased_line="$(grep -n '^## \[Unreleased\]' CHANGELOG.md | head -1 | cut -d: -f1)"
  [[ -n "$unreleased_line" ]] || { echo "CHANGELOG.md has no '## [Unreleased]' heading" >&2; exit 1; }
  next_heading_line="$(awk -v start="$unreleased_line" 'NR>start && /^## /{print NR; exit}' CHANGELOG.md)"
  [[ -n "$next_heading_line" ]] || { echo "CHANGELOG.md has no release heading after [Unreleased]" >&2; exit 1; }

  changelog_tmp="$work_dir/CHANGELOG.md"
  {
    head -n "$unreleased_line" CHANGELOG.md
    echo
    echo "## [$version] - $(date +%F)"
    if [[ -n "$combined_body" ]]; then
      echo
      printf '%s\n' "$combined_body"
    fi
    echo
    tail -n +"$next_heading_line" CHANGELOG.md
  } > "$changelog_tmp"
  mv "$changelog_tmp" CHANGELOG.md

  # The Unreleased compare link always points at the new tag; the new version's own link is
  # inserted right after it, ahead of the previously-newest release's link.
  new_unreleased_line="[Unreleased]: https://github.com/$REPO_SLUG/compare/$tag...HEAD"
  new_version_line="[$version]: https://github.com/$REPO_SLUG/releases/tag/$tag"
  changelog_tmp="$work_dir/CHANGELOG.md"
  awk -v newurl="$new_unreleased_line" -v newver="$new_version_line" '
    /^\[Unreleased\]:/ { print newurl; print newver; next }
    { print }
  ' CHANGELOG.md > "$changelog_tmp"
  mv "$changelog_tmp" CHANGELOG.md

  echo "Drafted CHANGELOG.md section for $tag."
fi

echo
echo "---- scripts/collect-changelog.sh output ----"
printf '%s\n' "$draft_output"
echo "----------------------------------------------"
echo

while true; do
  read -r -p "Review/edit CHANGELOG.md now, then continue? [y/N] " reply
  if [[ "$reply" == [yY] || "$reply" == [yY][eE][sS] ]]; then
    changelog_err="$work_dir/changelog-section.err"
    bash "$repo_root/scripts/changelog-section.sh" "$version" >/dev/null 2>"$changelog_err" && break
    cat "$changelog_err" >&2
    continue
  fi
  echo "Aborted. CHANGELOG.md and release-dependencies.json may already hold this release's draft;" >&2
  echo "fix and re-run 'scripts/cut-release.sh $bump_kind' to pick up where you left off." >&2
  exit 1
done

# ---- 7. bump the mod manifest --------------------------------------------------------------
manifest_tmp="$work_dir/couchcoop.json"
jq --arg version "$version" '.version = $version' "$MANIFEST" > "$manifest_tmp"
mv "$manifest_tmp" "$MANIFEST"

# ---- 8. commit ------------------------------------------------------------------------------
git add CHANGELOG.md "$MANIFEST" release-dependencies.json
git commit -m "chore(release): $tag"

# ---- 9. tag ----------------------------------------------------------------------------------
# Annotated and signed via this repo's tag.gpgsign; -m is required non-interactively, and it is
# just the version -- "CouchCoop" is implied by the repo it is already tagged in.
git tag -m "$version" "$tag"

# ---- 10. build-verify locally before pushing anything --------------------------------------
echo "Building the release archive locally to verify it before pushing..."
if ! "$repo_root/scripts/package-release.sh"; then
  echo "package-release.sh failed. Nothing has been pushed." >&2
  echo "The commit and tag $tag exist locally. Fix the issue, then either:" >&2
  echo "  - continue by hand from here (git push, etc.), or" >&2
  echo "  - undo and retry: git tag -d $tag && git reset --hard HEAD~1" >&2
  exit 1
fi

# ---- 11. push --------------------------------------------------------------------------------
git push origin main
git push origin "$tag"

# ---- 12. wait for the release workflow ------------------------------------------------------
echo "Waiting for the release workflow run for $tag..."
run_id=""
deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  run_id="$(gh run list --workflow=release.yml --repo "$REPO_SLUG" \
    --json databaseId,headBranch,event \
    -q ".[] | select(.event == \"push\" and .headBranch == \"$tag\") | .databaseId" \
    | head -1)"
  [[ -n "$run_id" ]] && break
  sleep 5
done
[[ -n "$run_id" ]] || {
  echo "no release workflow run appeared for $tag within 3 minutes;" >&2
  echo "check https://github.com/$REPO_SLUG/actions" >&2
  exit 1
}

echo "Watching run $run_id..."
if ! gh run watch "$run_id" --repo "$REPO_SLUG" --exit-status; then
  echo "release workflow failed: https://github.com/$REPO_SLUG/actions/runs/$run_id" >&2
  echo "$tag is already pushed and public -- diagnose and fix forward with a new commit and a new" >&2
  echo "patch tag; do not try to unwind the push." >&2
  exit 1
fi

gh release view "$tag" --repo "$REPO_SLUG" >/dev/null || {
  echo "the workflow succeeded but no GitHub Release was found for $tag" >&2
  exit 1
}
echo "GitHub Release $tag is published."

# ---- 13. publish to the Steam Workshop -------------------------------------------------------
# Unmodified: pulls the release just published, and keeps its own confirmation before touching
# the public listing.
"$repo_root/scripts/upload-workshop-release.sh"

echo "$tag is done: committed, tagged, pushed, released, and published to the Workshop."
