#!/usr/bin/env bash
set -euo pipefail

# Build a reviewable release archive without reading sts2.local.yaml, a game
# installation, or sibling working trees.  The outer invocation creates a clean
# three-repository workspace; the inner invocation runs only in that workspace.

usage() {
  cat >&2 <<'EOF'
usage: scripts/package-release.sh [--snapshot]

At a clean vMAJOR.MINOR.PATCH tag, builds one archive per pinned STS2 reference lane:
  dist/couchcoop-vMAJOR.MINOR.PATCH.zip              the stable game branch
  dist/couchcoop-vMAJOR.MINOR.PATCH-<lane>.zip       every other lane
--snapshot permits a clean untagged commit and builds couchcoop-snapshot-<short-sha>[-<lane>].zip
with version 0.0.0-snapshot.<short-sha>.

Environment:
  COUCHCOOP_RELEASE_STS2_LANE   build only these lanes (space separated); default: every lane on disk
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/release-lanes.sh
source "$repo_root/scripts/lib/release-lanes.sh"

sdk_root="$repo_root/eng/Sts2.ReferenceSdk"
sts2_package_id="FuYnAloft.Sts2.References"
lane_project() { printf '%s/%s/Sts2.ReferenceSdk.%s.csproj\n' "$sdk_root" "$1" "$1"; }
lane_lockfile() { printf '%s/%s/packages.lock.json\n' "$sdk_root" "$1"; }

snapshot=0
if [[ "${1:-}" == "--snapshot" ]]; then
  snapshot=1
  shift
fi
if [[ $# -ne 0 ]]; then
  usage
  exit 2
fi

if [[ "${COUCHCOOP_RELEASE_STAGED:-}" != "1" ]]; then
  if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
    echo "release packaging requires a clean working tree" >&2
    exit 1
  fi

  # One invocation emits every lane, because .github/workflows/release.yml calls this script once
  # and then publishes dist/* and attests dist/*.zip wholesale. Per-lane invocations would either
  # need a second CI step or leave one lane's assets unattested, and they would re-clone both sibling
  # repositories per lane; a single outer pass clones once and stages the payload per lane instead.
  lanes=()
  if [[ -n "${COUCHCOOP_RELEASE_STS2_LANE:-}" ]]; then
    read -r -a lanes <<< "$COUCHCOOP_RELEASE_STS2_LANE"
  else
    mapfile -t lanes < <(release_lane_discover "$sdk_root")
  fi
  [[ ${#lanes[@]} -gt 0 ]] || { echo "no STS2 reference lane to build" >&2; exit 1; }
  for lane in "${lanes[@]}"; do
    release_lane_is_valid_name "$lane" || { echo "unusable STS2 reference lane name: $lane" >&2; exit 1; }
    [[ -f "$(lane_project "$lane")" && -f "$(lane_lockfile "$lane")" ]] || {
      echo "unknown STS2 reference lane: $lane" >&2
      exit 1
    }
    # Resolving it here fails an unreviewed lane before anything is built. A malformed floor is the
    # one outcome that must be impossible: it fails the mod on every game build, not just old ones.
    release_lane_min_game_version "$lane" >/dev/null
  done

  source_commit="$(git -C "$repo_root" rev-parse HEAD)"
  short_commit="$(git -C "$repo_root" rev-parse --short=12 HEAD)"
  tag="$(git -C "$repo_root" tag --points-at HEAD --list 'v*' | sort -V | tail -n 1)"
  if [[ "$snapshot" == "1" ]]; then
    # A snapshot names the version it is actually a build OF, taken from the shipped manifest, with
    # the commit as SemVer BUILD METADATA. Two consequences, both deliberate:
    #   * it reads as a real version, not 0.0.0;
    #   * build metadata is ignored when versions are compared, so a snapshot ties with the published
    #     release of the same version rather than losing to it. The game resolves a mod installed both
    #     from the Workshop and from mods/ by version, and on a TIE it keeps the local copy -- so a
    #     locally installed test build is the one that loads. A `-snapshot` PRERELEASE would sort
    #     BELOW the release and be silently ignored, which is exactly how a QA run gets contaminated.
    manifest_version="$(jq -er '.version' "$repo_root/src/CouchCoop.Mod.Loader/couchcoop.json")"
    [[ "$manifest_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
      echo "mod manifest version is not MAJOR.MINOR.PATCH: $manifest_version" >&2
      exit 1
    }
    version="${manifest_version}+snapshot.${short_commit}"
    assembly_version="${manifest_version}.0"
    archive_base="couchcoop-snapshot-${short_commit}"
    tag=""
  else
    if [[ ! "$tag" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
      echo "HEAD must be exactly tagged vMAJOR.MINOR.PATCH; use --snapshot for a clean development archive" >&2
      exit 1
    fi
    version="${tag#v}"
    assembly_version="${version}.0"
    archive_base="couchcoop-${tag}"
  fi
  if [[ -n "${COUCHCOOP_RELEASE_EXPECTED_TAG:-}" && "$tag" != "$COUCHCOOP_RELEASE_EXPECTED_TAG" ]]; then
    echo "checked out tag does not match COUCHCOOP_RELEASE_EXPECTED_TAG" >&2
    exit 1
  fi

  workspace="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-release.XXXXXX")"
  trap 'rm -rf "$workspace"' EXIT
  source_parent="$workspace/sources"
  mkdir -p "$source_parent/couchcoop"
  git -C "$repo_root" archive --format=tar "$source_commit" | tar -x -C "$source_parent/couchcoop"

  deps="$repo_root/release-dependencies.json"
  for name in spirectl godot-scene-web; do
    url="$(jq -er --arg name "$name" '.dependencies[$name].repository' "$deps")"
    commit="$(jq -er --arg name "$name" '.dependencies[$name].commit' "$deps")"
    [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid locked commit for $name" >&2; exit 1; }
    git clone --quiet "$url" "$source_parent/$name"
    git -C "$source_parent/$name" checkout --quiet --detach "$commit"
    [[ "$(git -C "$source_parent/$name" rev-parse HEAD)" == "$commit" ]] || { echo "locked $name revision did not resolve" >&2; exit 1; }
  done

  mkdir -p "$repo_root/dist"
  for lane in "${lanes[@]}"; do
    # Each lane compiles against a different set of STS2 reference assemblies, so no lane may inherit
    # another's intermediate output from the shared staged checkout.
    find "$source_parent/couchcoop/src" -type d \( -name obj -o -name bin \) -prune -exec rm -rf {} +
    COUCHCOOP_RELEASE_STAGED=1 \
    COUCHCOOP_RELEASE_SOURCE_COMMIT="$source_commit" \
    COUCHCOOP_RELEASE_TAG="$tag" \
    COUCHCOOP_RELEASE_VERSION="$version" \
    COUCHCOOP_RELEASE_ASSEMBLY_VERSION="$assembly_version" \
    COUCHCOOP_RELEASE_ARCHIVE_NAME="$(release_lane_archive_name "$archive_base" "$lane")" \
    COUCHCOOP_RELEASE_OUTPUT_DIR="$repo_root/dist" \
    COUCHCOOP_RELEASE_STS2_LANE="$lane" \
    bash "$source_parent/couchcoop/scripts/package-release.sh"
  done

  # One checksum file for the whole release, not one per lane. Each staged pass writes its own so it
  # can verify the archive it just built; here they become a single published asset, because a
  # release is one thing a person downloads from and `sha256sum -c` handles a multi-line file fine.
  combined="$repo_root/dist/$archive_base.SHA256SUMS"
  per_lane=()
  for lane in "${lanes[@]}"; do
    per_lane+=("$repo_root/dist/$(release_lane_archive_name "$archive_base" "$lane")")
  done
  : > "$combined.tmp"
  for archive in "${per_lane[@]}"; do
    cat "${archive%.zip}.SHA256SUMS" >> "$combined.tmp"
  done
  LC_ALL=C sort -k2 "$combined.tmp" > "$combined"
  rm -f "$combined.tmp"
  for archive in "${per_lane[@]}"; do
    [[ "${archive%.zip}.SHA256SUMS" == "$combined" ]] || rm -f "${archive%.zip}.SHA256SUMS"
  done
  # Prove the published file verifies every archive it names, from the directory it ships in.
  (cd "$repo_root/dist" && sha256sum -c "$(basename "$combined")")

  exit 0
fi

# The staged pass builds exactly one lane; the outer pass names it.
lane="${COUCHCOOP_RELEASE_STS2_LANE:?missing STS2 reference lane}"
sdk_project="$(lane_project "$lane")"
sdk_lockfile="$(lane_lockfile "$lane")"
[[ -f "$sdk_project" && -f "$sdk_lockfile" ]] || { echo "unknown STS2 reference lane: $lane" >&2; exit 1; }
min_game_version="$(release_lane_min_game_version "$lane")"
version="${COUCHCOOP_RELEASE_VERSION:?missing release version}"
assembly_version="${COUCHCOOP_RELEASE_ASSEMBLY_VERSION:?missing assembly version}"
archive_name="${COUCHCOOP_RELEASE_ARCHIVE_NAME:?missing archive name}"
output_dir="${COUCHCOOP_RELEASE_OUTPUT_DIR:?missing output directory}"
source_commit="${COUCHCOOP_RELEASE_SOURCE_COMMIT:?missing source commit}"

# A tagged release appends the commit as build metadata; a snapshot version already carries its own
# build metadata, and SemVer allows only one '+' segment.
if [[ "$version" == *+* ]]; then
  informational_version="$version"
else
  informational_version="$version+$source_commit"
fi

tag="${COUCHCOOP_RELEASE_TAG:-}"
source_parent="$(cd "$repo_root/.." && pwd)"
deps="$repo_root/release-dependencies.json"

for name in spirectl godot-scene-web; do
  expected="$(jq -er --arg name "$name" '.dependencies[$name].commit' "$deps")"
  actual="$(git -C "$source_parent/$name" rev-parse HEAD)"
  [[ "$actual" == "$expected" ]] || { echo "$name does not match release-dependencies.json" >&2; exit 1; }
done

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-release-build.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
sdk_dir="$work_dir/reference-sdk"
payload_dir="$work_dir/payload/couchcoop"
mkdir -p "$sdk_dir" "$payload_dir" "$output_dir"

"$repo_root/scripts/verify-sts2-reference-sdk.sh" "$lane"
DOTNET_ROLL_FORWARD=Major dotnet build "$sdk_project" \
  -c Release -o "$sdk_dir" -p:RestoreLockedMode=true -p:ContinuousIntegrationBuild=true \
  -p:DebugSymbols=false -p:DebugType=None

for assembly in sts2.dll GodotSharp.dll 0Harmony.dll; do
  [[ -f "$sdk_dir/$assembly" ]] || { echo "compile SDK did not produce $assembly" >&2; exit 1; }
done

# Corepack selects a package-manager version before pnpm receives --dir. Run it
# from each dependency instead, so Corepack finds a dependency's packageManager
# pin (godot-scene-web currently requires pnpm 10.26.0).
(
  cd "$source_parent/godot-scene-web"
  corepack pnpm install --frozen-lockfile
)
(
  cd "$source_parent/spirectl/presentation/web"
  corepack pnpm install --frozen-lockfile
)
npm --prefix "$repo_root/frontend" ci
npm --prefix "$repo_root/frontend" audit --omit=dev --audit-level=high

# The bridge resolves its game API lane from the install's release_info.json, and a staged reference
# SDK has none — so a release build has to say which lane it is, or the bridge refuses to compile.
game_api_lane="$(release_lane_game_api "$lane")"
DOTNET_ROLL_FORWARD=Major dotnet publish "$repo_root/src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj" \
  -c Release -o "$payload_dir" \
  -p:CouchCoopBuildToLocalMods=false \
  -p:CouchCoopEnableHotReload=false \
  -p:Sts2AssembliesDir="$sdk_dir" \
  -p:Sts2GameApi="$game_api_lane" \
  -p:EnableSts2LiveHost=true \
  -p:Version="$version" -p:AssemblyVersion="$assembly_version" -p:FileVersion="$assembly_version" \
  -p:InformationalVersion="$informational_version" -p:ContinuousIntegrationBuild=true \
  -p:DebugSymbols=false -p:DebugType=None

COUCHCOOP_RELEASE_BUILD=1 COUCHCOOP_FRONTEND_OUT_DIR="$payload_dir/frontend" \
  npm --prefix "$repo_root/frontend" run build

if [[ -n "$min_game_version" ]]; then
  # A lane built against a newer game's references declares that game as its floor, so the payload
  # refuses an older build loudly instead of loading and failing at a missing member. The value is
  # SemanticVersion-compared by the game and a leading `v` is canonical; scripts/lib/release-lanes.sh
  # owns the literal and rejects anything that would not parse.
  jq --arg version "$version" --arg minGameVersion "$min_game_version" \
    '.version = $version | .min_game_version = $minGameVersion' \
    "$payload_dir/couchcoop.json" > "$payload_dir/couchcoop.json.tmp"
else
  # Deliberately not a `del`: the stable lane declares no floor, and a floor that appeared in the
  # source manifest must fail the gate rather than be silently stripped here.
  jq --arg version "$version" '.version = $version' "$payload_dir/couchcoop.json" > "$payload_dir/couchcoop.json.tmp"
fi
mv "$payload_dir/couchcoop.json.tmp" "$payload_dir/couchcoop.json"
find "$payload_dir" -type f \( -name '*.deps.json' -o -name '*.runtimeconfig.json' \) -delete

license_dir="$payload_dir/licenses"
npm_license_dir="$license_dir/npm"
mkdir -p "$npm_license_dir"
cp "$repo_root/LICENSE" "$payload_dir/LICENSE"
cp "$repo_root/NOTICE" "$payload_dir/NOTICE"
cp "$repo_root/THIRD_PARTY_NOTICES.md" "$payload_dir/THIRD_PARTY_NOTICES.md"
cp "$repo_root/licenses/QRCoder-1.6.0-MIT.txt" "$license_dir/QRCoder-1.6.0-MIT.txt"
cp "$source_parent/spirectl/LICENSE" "$license_dir/spirectl-LICENSE"
cp "$source_parent/spirectl/NOTICE" "$license_dir/spirectl-NOTICE"
cp "$source_parent/godot-scene-web/LICENSE" "$license_dir/godot-scene-web-LICENSE"
cp "$source_parent/godot-scene-web/packages/hb-gpu/vendor/LICENSE-harfbuzz" "$license_dir/HarfBuzz-LICENSE"
cp "$source_parent/godot-scene-web/packages/hb-gpu/vendor/LICENSE-emscripten" "$license_dir/Emscripten-LICENSE"
cp "$source_parent/godot-scene-web/packages/html/vendor/LICENSE-OpenSans" "$license_dir/OpenSans-LICENSE"

npm_license_manifest="$license_dir/npm-dependencies.tsv"
printf 'package\tversion\tdeclared-license\tlicense-file\n' > "$npm_license_manifest"
while IFS=$'\t' read -r package_path package_version package_license; do
  package_name="${package_path#node_modules/}"
  package_dir="$repo_root/frontend/$package_path"
  safe_name="${package_name//@/}"
  safe_name="${safe_name//\//__}"
  license_file="$(find "$package_dir" -maxdepth 1 -type f -iname 'license*' -print -quit)"
  if [[ -z "$license_file" && -f "$repo_root/licenses/npm-fallbacks/$safe_name.LICENSE" ]]; then
    license_file="$repo_root/licenses/npm-fallbacks/$safe_name.LICENSE"
  fi
  [[ -n "$license_file" ]] || { echo "production npm dependency has no license file: $package_name" >&2; exit 1; }
  destination="npm/${safe_name}.LICENSE"
  cp "$license_file" "$license_dir/$destination"
  printf '%s\t%s\t%s\t%s\n' "$package_name" "$package_version" "$package_license" "$destination" >> "$npm_license_manifest"
done < <(jq -r '
  .packages | to_entries[]
  | select(.key | startswith("node_modules/"))
  | select(.value.dev != true)
  | [.key, .value.version, (.value.license // "UNKNOWN")] | @tsv
' "$repo_root/frontend/package-lock.json")

checksums="$output_dir/${archive_name%.zip}.SHA256SUMS"
archive="$output_dir/$archive_name"

# The build metadata ships INSIDE the payload, as the one thing about a release that the archive
# cannot otherwise tell you -- with one archive per game branch it is the record of which game API a
# zip targets, and a player who extracted a zip months ago can still read it.
#
# `.txt`, not `.json`, and this is load-bearing: STS2 lists a mod directory and treats every filename
# ending in `.json` as a mod manifest, while Godot's hidden-file test is a dot-prefix on Unix but
# FILE_ATTRIBUTE_HIDDEN on Windows, which a zip-extracted file never carries. A `.build-info.json`
# would therefore be skipped here and scanned as a broken manifest on every Windows player's machine.
# scripts/verify-release-archive.sh rejects any second root-level .json for the same reason.
build_info="$payload_dir/build-info.txt"
jq -n \
  --arg schema "couchcoop-release-build-info/v1" \
  --arg sourceCommit "$source_commit" --arg tag "$tag" --arg version "$version" \
  --arg spirectl "$(jq -r '.dependencies.spirectl.commit' "$deps")" \
  --arg godotSceneWeb "$(jq -r '.dependencies["godot-scene-web"].commit' "$deps")" \
  --arg sts2Lane "$lane" --arg sts2ReferenceId "$sts2_package_id" \
  --arg sts2ReferenceVersion "$(jq -er --arg id "$sts2_package_id" '.dependencies["net9.0"][$id].resolved' "$sdk_lockfile")" \
  --arg sts2ReferenceContentHash "$(jq -er --arg id "$sts2_package_id" '.dependencies["net9.0"][$id].contentHash' "$sdk_lockfile")" \
  --arg dotnet "$(dotnet --version)" --arg node "$(node --version)" --arg pnpm "$(corepack pnpm --version)" \
  --arg frontendLock "$(sha256sum "$repo_root/frontend/package-lock.json" | cut -d ' ' -f 1)" \
  --arg referenceSdkLock "$(sha256sum "$sdk_lockfile" | cut -d ' ' -f 1)" \
  --arg spirectlLock "$(sha256sum "$source_parent/spirectl/presentation/web/pnpm-lock.yaml" | cut -d ' ' -f 1)" \
  --arg godotSceneWebLock "$(sha256sum "$source_parent/godot-scene-web/pnpm-lock.yaml" | cut -d ' ' -f 1)" \
  '{schemaVersion: $schema, sourceCommit: $sourceCommit, tag: ($tag | if length > 0 then . else null end), version: $version, dependencies: {spirectl: $spirectl, godotSceneWeb: $godotSceneWeb, sts2References: {lane: $sts2Lane, id: $sts2ReferenceId, version: $sts2ReferenceVersion, nugetContentHash: $sts2ReferenceContentHash}}, toolchain: {dotnet: $dotnet, node: $node, pnpm: $pnpm}, lockfileSha256: {sts2ReferenceSdkNuGetLock: $referenceSdkLock, frontendPackageLock: $frontendLock, spirectlPresentationPnpmLock: $spirectlLock, godotSceneWebPnpmLock: $godotSceneWebLock}}' > "$build_info"

# The payload is complete here, build-info.txt included, so the gate sees exactly what ships.
"$repo_root/scripts/verify-release-archive.sh" --payload "$payload_dir" --version "$version" --lane "$lane"

(cd "$work_dir/payload" && TZ=UTC zip -X -q -r "$archive" couchcoop)
# One small checksum file per archive, kept on purpose. The in-payload manifest that used to be
# published alongside it was a CONSISTENCY check, not an authenticity one -- a tamperer rewrites a
# payload and its manifest together -- so it is recomputed inside the gate now instead of shipped.
# SHA256SUMS is cheap, works with sha256sum -c offline, and sits beside GitHub's per-asset digests
# and the release workflow's actions/attest signature. Do not "simplify" it away.
(cd "$output_dir" && sha256sum "$(basename "$archive")" > "$(basename "$checksums")")
"$repo_root/scripts/verify-release-archive.sh" \
  --archive "$archive" --checksums "$checksums" --lane "$lane" --version "$version"

printf 'release archive: %s (lane %s%s)\n' \
  "$archive" "$lane" "${min_game_version:+, min_game_version $min_game_version}"
