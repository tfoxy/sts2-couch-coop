#!/usr/bin/env bash
set -euo pipefail

# Stamp a DEV deploy's identity into the mod directory `scripts/build-local-mod.sh` just published.
#
# WHY THIS EXISTS. Game v0.111.0 changed how a mod id present BOTH as a Steam Workshop subscription and
# in the install's `mods/` directory is resolved. Stable v0.107.1 always kept the local copy; the beta
# keeps the HIGHER version and only falls back to the local copy on a tie or an unparseable version. A
# dev deploy that carries the source manifest's release version therefore loses to any Workshop item
# that has moved ahead of it, and the game says so with one `[WARN]` nobody reads — so a whole QA
# session measures the published build while you believe you are testing the working tree.
#
# So a dev deploy declares a version no published item can beat. The comparison is SemVer over
# MAJOR/MINOR/PATCH with build metadata ignored, so `9999.0.0+dev.<sha>` wins on the first component
# and still carries the commit for a human. This is the deployed copy ONLY: the source manifest at
# src/CouchCoop.Mod.Loader/couchcoop.json is never touched, and scripts/package-release.sh stamps its
# own payload from the source manifest, so nothing here can reach a release archive.
#
# EVERY OTHER FIELD IS PRESERVED. In particular `affects_gameplay: false`, which keeps the mod out of
# the game's gameplay-relevant mod list and is the only reason a vanilla Steam friend can join a
# couch-coop host at all (tests/CouchCoop.Mod.Tests/ModManifestGameplayRelevanceTests.cs). `jq` edits
# the two fields it is given and copies the rest verbatim, which is also how package-release.sh:281
# stamps the release payload.
#
# build-info.txt is written beside it, in the same shape scripts/package-release.sh emits for a
# release payload, so one reader answers "what is installed here" for both. It declares its own
# schema, `couchcoop-local-build-info/v1`: a dev deploy is not a release payload, and
# scripts/verify-release-archive.sh must keep rejecting it rather than checking it as one.
#
#   scripts/stamp-local-mod.sh --output <deployed mod dir> [--configuration Debug|Release]
#
# Self-test: scripts/test-stamp-local-mod.sh

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir=""
configuration="${COUCHCOOP_CONFIGURATION:-Debug}"

usage() {
  cat >&2 <<'EOF'
usage: scripts/stamp-local-mod.sh --output <dir> [--configuration Debug|Release]

Stamps a dev version into <dir>/couchcoop.json and writes <dir>/build-info.txt.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output_dir="${2:-}"; shift 2 ;;
    --configuration) configuration="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

[[ -n "$output_dir" ]] || { usage; exit 2; }
[[ -d "$output_dir" ]] || { echo "stamp-local-mod: no such directory: $output_dir" >&2; exit 2; }

# Hard requirement, not a soft degrade. Skipping the stamp is exactly the silent failure this script
# exists to end: the deploy would still succeed, and the seats would still run the Workshop build.
command -v jq >/dev/null 2>&1 || {
  echo "stamp-local-mod: jq is required to stamp the deployed mod manifest (the same tool scripts/package-release.sh uses)." >&2
  exit 1
}

manifest="$output_dir/couchcoop.json"
[[ -f "$manifest" ]] || {
  echo "stamp-local-mod: $manifest is missing — the publish did not copy the mod manifest." >&2
  exit 1
}

# The MAJOR that cannot lose. Deliberately absurd: it is read by a human in the game's mod list, where
# "9999" reads as "this is a local dev build", and by the game's version comparison, where it wins.
dev_major=9999

git_describe() { git -C "$repo_root" "$@" 2>/dev/null || true; }

source_commit="$(git_describe rev-parse HEAD)"
short_commit="$(git_describe rev-parse --short=12 HEAD)"
branch="$(git_describe rev-parse --abbrev-ref HEAD)"
dirty=false
if [[ -n "$source_commit" ]] && [[ -n "$(git_describe status --porcelain)" ]]; then
  dirty=true
fi

metadata="dev.${short_commit:-local}"
[[ "$dirty" == "true" ]] && metadata="$metadata.dirty"
dev_version="${dev_major}.0.0+${metadata}"

manifest_version="$(jq -r '.version // empty' "$manifest")"

# `.version = $version` and nothing else: every other field, `affects_gameplay` above all, is copied
# through untouched. Written to a temp file in the same directory and renamed, so a game reading the
# mod directory never sees a half-written manifest.
jq --arg version "$dev_version" '.version = $version' "$manifest" > "$manifest.tmp"
mv "$manifest.tmp" "$manifest"

# The sibling checkouts are live working trees for a dev build, not pinned commits, so record what is
# actually checked out next door — including whether it is dirty, because an unpushed sibling edit is
# live in this deploy with no build step (see AGENTS.md "Architecture Rules").
sibling_commit() { # sibling_commit <path>
  local path="$1" commit
  [[ -d "$path/.git" || -f "$path/.git" ]] || { printf 'unavailable'; return; }
  commit="$(git -C "$path" rev-parse HEAD 2>/dev/null || true)"
  [[ -n "$commit" ]] || { printf 'unavailable'; return; }
  if [[ -n "$(git -C "$path" status --porcelain 2>/dev/null || true)" ]]; then
    printf '%s-dirty' "$commit"
  else
    printf '%s' "$commit"
  fi
}

# The bridge API lane this build compiled against, detected by ../spirectl/bridge-mod/Sts2GameApi.props
# from the install's own release_info.json. Asked of MSBuild rather than re-derived here: two copies of
# the version-to-lane table would disagree the first time a game build is added to one of them.
lane=""
game_version=""
lane_probe="$(COUCHCOOP_GAME_MODS_DIR="${COUCHCOOP_GAME_MODS_DIR:-$output_dir}" dotnet msbuild \
  "$repo_root/src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj" \
  -nologo -getProperty:Sts2GameApi -getProperty:Sts2GameVersion 2>/dev/null || true)"
if [[ -n "$lane_probe" ]]; then
  lane="$(printf '%s' "$lane_probe" | jq -r '.Properties.Sts2GameApi // empty' 2>/dev/null || true)"
  game_version="$(printf '%s' "$lane_probe" | jq -r '.Properties.Sts2GameVersion // empty' 2>/dev/null || true)"
fi

# Same field names and nesting as the release build-info, so an operator (and the seat mismatch
# report) reads one shape. `sourceCommit` is the value the runtime guard compares through: a local
# build's AssemblyInformationalVersion is `<assembly version>+<sourceCommit>`, so these two identify
# the same build from opposite ends.
jq -n \
  --arg schema "couchcoop-local-build-info/v1" \
  --arg sourceCommit "${source_commit:-unavailable}" \
  --arg branch "${branch:-unavailable}" \
  --argjson dirty "$dirty" \
  --arg version "$dev_version" \
  --arg manifestVersion "${manifest_version:-unknown}" \
  --arg configuration "$configuration" \
  --arg builtAtUtc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg spirectl "$(sibling_commit "$repo_root/../spirectl")" \
  --arg godotSceneWeb "$(sibling_commit "$repo_root/../godot-scene-web")" \
  --arg sts2Lane "${lane:-unknown}" \
  --arg sts2GameVersion "${game_version:-unknown}" \
  --arg dotnet "$(dotnet --version 2>/dev/null || echo unknown)" \
  --arg node "$(node --version 2>/dev/null || echo unknown)" \
  '{
     schemaVersion: $schema,
     sourceCommit: $sourceCommit,
     branch: $branch,
     dirty: $dirty,
     tag: null,
     version: $version,
     manifestVersion: $manifestVersion,
     configuration: $configuration,
     builtAtUtc: $builtAtUtc,
     dependencies: {
       spirectl: $spirectl,
       godotSceneWeb: $godotSceneWeb,
       sts2References: { lane: $sts2Lane, id: "local-install", version: $sts2GameVersion }
     },
     toolchain: { dotnet: $dotnet, node: $node }
   }' > "$output_dir/build-info.txt.tmp"
mv "$output_dir/build-info.txt.tmp" "$output_dir/build-info.txt"

# One line an operator actually reads in the deploy output. It names the version that WAS written,
# not the one that was intended: the whole failure this replaces was a manifest nobody re-read.
printf 'deployed mod manifest version: %s (was %s) — outranks any published Workshop item; source %s%s\n' \
  "$dev_version" "${manifest_version:-unknown}" "${short_commit:-unknown}" \
  "$([[ "$dirty" == "true" ]] && printf ', DIRTY working tree' || printf '')"
