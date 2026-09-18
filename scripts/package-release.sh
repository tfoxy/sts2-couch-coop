#!/usr/bin/env bash
set -euo pipefail

# Build a reviewable release archive without reading sts2.local.yaml or a game
# installation.  The outer invocation creates a clean three-repository workspace; the inner
# invocation runs only in that workspace.  A tagged release sources spirectl and godot-scene-web
# by cloning the commit release-dependencies.json pins; a --snapshot instead archives each
# sibling's current (clean) commit directly from ../spirectl and ../godot-scene-web, so the pin
# only has to move when preparing a tag release.

usage() {
  cat >&2 <<'EOF'
usage: scripts/package-release.sh [--snapshot]

At a clean vMAJOR.MINOR.PATCH tag, builds ONE archive carrying every pinned STS2 reference lane:
  dist/couchcoop-vMAJOR.MINOR.PATCH.zip        one payload, lanes/<floor>/ per game branch
  dist/couchcoop-vMAJOR.MINOR.PATCH.SHA256SUMS
--snapshot permits a clean untagged commit and builds couchcoop-snapshot-<short-sha>.zip with
version <manifest version>+snapshot.<short-sha>. It sources spirectl and godot-scene-web from the
sibling checkouts beside this repo (../spirectl, ../godot-scene-web) at their current commit -- each
must have a clean working tree -- rather than from the commits release-dependencies.json pins.

Environment:
  COUCHCOOP_RELEASE_STS2_LANE   build only these lanes (space separated); default: every lane on
                                disk. A payload built this way is a LOCAL build: it carries fewer
                                lanes than a release and the gate is told so explicitly.
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

  # One invocation emits one archive carrying every lane, because .github/workflows/release.yml
  # calls this script once and then publishes dist/* and attests dist/*.zip wholesale -- and because
  # a per-lane archive cannot survive Steam's refresh path at all (see scripts/lib/release-lanes.sh).
  # The outer pass clones the siblings once; the staged pass builds each lane inside that one
  # workspace and merges them into a single payload.
  all_lanes=()
  while IFS= read -r lane; do all_lanes+=("$lane"); done < <(release_lane_discover "$sdk_root")
  lanes=()
  if [[ -n "${COUCHCOOP_RELEASE_STS2_LANE:-}" ]]; then
    read -r -a lanes <<< "$COUCHCOOP_RELEASE_STS2_LANE"
  else
    lanes=("${all_lanes[@]}")
  fi
  [[ ${#lanes[@]} -gt 0 ]] || { echo "no STS2 reference lane to build" >&2; exit 1; }
  for lane in "${lanes[@]}"; do
    release_lane_is_valid_name "$lane" || { echo "unusable STS2 reference lane name: $lane" >&2; exit 1; }
    [[ -f "$(lane_project "$lane")" && -f "$(lane_lockfile "$lane")" ]] || {
      echo "unknown STS2 reference lane: $lane" >&2
      exit 1
    }
    # Resolving these here fails an unreviewed lane before anything is built. A malformed floor is
    # the one outcome that must be impossible: it fails the mod on every game build, not just old
    # ones -- and the floor also names the lane's payload directory.
    release_lane_game_floor "$lane" >/dev/null
    release_lane_dir_name "$lane" >/dev/null
  done

  # Complete means "carries every lane on disk", which is the only thing publishable: a subscriber on
  # a branch this payload has no lane for gets a mod that cannot load. It is computed, not assumed
  # from whether COUCHCOOP_RELEASE_STS2_LANE was set, so naming every lane by hand is still a release.
  complete=0
  if [[ "$(printf '%s\n' "${lanes[@]}" | LC_ALL=C sort -u)" == "$(printf '%s\n' "${all_lanes[@]}" | LC_ALL=C sort -u)" ]]; then
    complete=1
  else
    echo "package-release: building lanes [${lanes[*]}] only — this payload is a LOCAL build, not publishable" >&2
  fi

  source_commit="$(git -C "$repo_root" rev-parse HEAD)"
  short_commit="$(git -C "$repo_root" rev-parse --short=12 HEAD)"
  tag="$(git -C "$repo_root" tag --points-at HEAD --list 'v*' | release_semver_tag_latest)"
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

  mkdir -p "$repo_root/dist"
  archive_name="$(release_archive_name "$archive_base")"
  # A stale per-lane archive from before the merge would still be sitting in dist/, and the release
  # workflow publishes dist/* wholesale. Refuse rather than publish a payload this run did not build
  # -- and refuse here, before the clone and the builds, not after paying for them.
  stale_suffixes="$(release_lane_known_names | paste -sd '|' -)"
  for stale_path in "$repo_root/dist"/*; do
    [[ -f "$stale_path" ]] || continue
    stale="$(basename "$stale_path")"
    if [[ "$stale" =~ -($stale_suffixes)\.(zip|SHA256SUMS)$ ]]; then
      echo "package-release: dist/ still holds $stale from an older per-lane release; remove it first" >&2
      exit 1
    fi
  done

  workspace="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-release.XXXXXX")"
  trap 'rm -rf "$workspace"' EXIT
  source_parent="$workspace/sources"
  mkdir -p "$source_parent/couchcoop"
  git -C "$repo_root" archive --format=tar "$source_commit" | tar -x -C "$source_parent/couchcoop"

  deps="$repo_root/release-dependencies.json"
  sibling_commit_spirectl=""
  sibling_commit_godot_scene_web=""
  for name in spirectl godot-scene-web; do
    if [[ "$snapshot" == "1" ]]; then
      # A snapshot is a local dev/QA artifact, not a published release, so each sibling comes
      # straight from its own checkout beside this repo instead of the commit
      # release-dependencies.json pins -- that pin only has to move when preparing a tag release.
      # `git archive HEAD` needs no push and no network, unlike the clone below, and captures the
      # sibling's tree the same way the block above already captures this repo's own.
      sibling_repo="$repo_root/../$name"
      [[ -d "$sibling_repo/.git" ]] || { echo "no sibling checkout at $sibling_repo" >&2; exit 1; }
      [[ -z "$(git -C "$sibling_repo" status --porcelain)" ]] \
        || { echo "$name has uncommitted changes; commit before a snapshot build" >&2; exit 1; }
      commit="$(git -C "$sibling_repo" rev-parse HEAD)"
      mkdir -p "$source_parent/$name"
      git -C "$sibling_repo" archive --format=tar HEAD | tar -x -C "$source_parent/$name"
    else
      url="$(jq -er --arg name "$name" '.dependencies[$name].repository' "$deps")"
      commit="$(jq -er --arg name "$name" '.dependencies[$name].commit' "$deps")"
      [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid locked commit for $name" >&2; exit 1; }
      git clone --quiet "$url" "$source_parent/$name"
      git -C "$source_parent/$name" checkout --quiet --detach "$commit"
      [[ "$(git -C "$source_parent/$name" rev-parse HEAD)" == "$commit" ]] || { echo "locked $name revision did not resolve" >&2; exit 1; }
    fi
    case "$name" in
      spirectl) sibling_commit_spirectl="$commit" ;;
      godot-scene-web) sibling_commit_godot_scene_web="$commit" ;;
    esac
  done

  COUCHCOOP_RELEASE_STAGED=1 \
  COUCHCOOP_RELEASE_SNAPSHOT="$snapshot" \
  COUCHCOOP_RELEASE_SPIRECTL_COMMIT="$sibling_commit_spirectl" \
  COUCHCOOP_RELEASE_GODOT_SCENE_WEB_COMMIT="$sibling_commit_godot_scene_web" \
  COUCHCOOP_RELEASE_SOURCE_COMMIT="$source_commit" \
  COUCHCOOP_RELEASE_TAG="$tag" \
  COUCHCOOP_RELEASE_VERSION="$version" \
  COUCHCOOP_RELEASE_ASSEMBLY_VERSION="$assembly_version" \
  COUCHCOOP_RELEASE_ARCHIVE_NAME="$archive_name" \
  COUCHCOOP_RELEASE_OUTPUT_DIR="$repo_root/dist" \
  COUCHCOOP_RELEASE_STS2_LANE="${lanes[*]}" \
  COUCHCOOP_RELEASE_COMPLETE="$complete" \
  bash "$source_parent/couchcoop/scripts/package-release.sh"

  # One archive, one checksum file. Prove the published file verifies what it names, from the
  # directory it ships in.
  release_verify_checksums "$repo_root/dist/$(release_checksums_name "$archive_name").SHA256SUMS"

  exit 0
fi

# The staged pass builds every lane the outer pass names, into ONE payload.
read -r -a lanes <<< "${COUCHCOOP_RELEASE_STS2_LANE:?missing STS2 reference lane}"
[[ ${#lanes[@]} -gt 0 ]] || { echo "no STS2 reference lane to build" >&2; exit 1; }
for lane in "${lanes[@]}"; do
  [[ -f "$(lane_project "$lane")" && -f "$(lane_lockfile "$lane")" ]] \
    || { echo "unknown STS2 reference lane: $lane" >&2; exit 1; }
done
lane_assemblies=()
while IFS= read -r assembly; do lane_assemblies+=("$assembly"); done < <(release_lane_assembly_names)
# The merged manifest declares the LOWEST floor of the lanes actually built, so the one payload
# loads on the oldest branch it carries and the runtime selector picks the lane from there.
min_game_version="$(release_payload_min_game_version "${lanes[@]}")"
complete="${COUCHCOOP_RELEASE_COMPLETE:-0}"
version="${COUCHCOOP_RELEASE_VERSION:?missing release version}"
assembly_version="${COUCHCOOP_RELEASE_ASSEMBLY_VERSION:?missing assembly version}"
archive_name="${COUCHCOOP_RELEASE_ARCHIVE_NAME:?missing archive name}"
output_dir="${COUCHCOOP_RELEASE_OUTPUT_DIR:?missing output directory}"
source_commit="${COUCHCOOP_RELEASE_SOURCE_COMMIT:?missing source commit}"
snapshot="${COUCHCOOP_RELEASE_SNAPSHOT:?missing snapshot flag}"

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

if [[ "$snapshot" != "1" ]]; then
  # A snapshot sources each sibling as a plain archived tree with no .git to check against a pin
  # (see the outer pass); only a tag release clones and checks out a locked commit here.
  for name in spirectl godot-scene-web; do
    expected="$(jq -er --arg name "$name" '.dependencies[$name].commit' "$deps")"
    actual="$(git -C "$source_parent/$name" rev-parse HEAD)"
    [[ "$actual" == "$expected" ]] || { echo "$name does not match release-dependencies.json" >&2; exit 1; }
  done
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-release-build.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
sdk_root_dir="$work_dir/reference-sdk"
publish_root="$work_dir/publish"
references_dir="$work_dir/references"
payload_dir="$work_dir/payload/couchcoop"
mkdir -p "$sdk_root_dir" "$publish_root" "$references_dir" "$payload_dir" "$output_dir"

# Every lane's pins are audited before ANY of them is built: a four-minute build that dies on the
# second lane's unreviewed pin has already cost the first lane's build.
"$repo_root/scripts/verify-sts2-reference-sdk.sh" "${lanes[@]}"

# ------------------------------------------------------------------------------------------------
# Lane-INDEPENDENT work, hoisted out of the lane loop. The frontend, the licence texts and the npm
# dependency graph do not vary by STS2 reference lane -- the two v0.2.1 archives were byte-identical
# in every one of these files -- so building them once per lane only bought a slower release.
# ------------------------------------------------------------------------------------------------
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

COUCHCOOP_RELEASE_BUILD=1 COUCHCOOP_FRONTEND_OUT_DIR="$payload_dir/frontend" \
  npm --prefix "$repo_root/frontend" run build

# ------------------------------------------------------------------------------------------------
# The lane loop. Each lane is a clean-room compile against its own pinned STS2 references; only the
# two lane-varying assemblies reach the payload, under lanes/<floor>/.
# ------------------------------------------------------------------------------------------------

# The assertion that keeps the shared tree shared. Everything a lane publishes other than the lane
# assemblies must be byte-identical to the first lane's copy -- otherwise the merged payload would
# ship one lane's build of a file to players on every branch, which is exactly the silent failure
# this layout exists to remove. It fails the build; it does not pick a winner.
assert_shared_publish_matches() {
  local reference="$1" candidate="$2" lane="$3" relative differing=()
  local reference_list candidate_list
  reference_list="$(release_list_files "$reference")"
  candidate_list="$(release_list_files "$candidate")"
  if [[ "$reference_list" != "$candidate_list" ]]; then
    echo "lane $lane published a different set of shared files than lane $first_lane:" >&2
    diff <(printf '%s\n' "$reference_list") <(printf '%s\n' "$candidate_list") >&2 || true
    return 1
  fi
  while IFS= read -r relative; do
    [[ -n "$relative" ]] || continue
    cmp -s "$reference/$relative" "$candidate/$relative" || differing+=("${relative#./}")
  done <<< "$reference_list"
  [[ ${#differing[@]} -eq 0 ]] || {
    echo "lane $lane and lane $first_lane disagree on shared payload files: ${differing[*]}" >&2
    echo "a file that varies by lane must ship per lane: add it to release_lane_assembly_names() in scripts/lib/release-lanes.sh" >&2
    return 1
  }
}

first_lane="${lanes[0]}"
for lane in "${lanes[@]}"; do
  # Each lane compiles against a different set of STS2 reference assemblies, so no lane may inherit
  # another's intermediate output from the shared staged checkout.
  find "$repo_root/src" -type d \( -name obj -o -name bin \) -prune -exec rm -rf {} +

  sdk_dir="$sdk_root_dir/$lane"
  lane_publish="$publish_root/$lane"
  mkdir -p "$sdk_dir" "$lane_publish"
  DOTNET_ROLL_FORWARD=Major dotnet build "$(lane_project "$lane")" \
    -c Release -o "$sdk_dir" -p:RestoreLockedMode=true -p:ContinuousIntegrationBuild=true \
    -p:DebugSymbols=false -p:DebugType=None

  for assembly in sts2.dll GodotSharp.dll 0Harmony.dll; do
    [[ -f "$sdk_dir/$assembly" ]] || { echo "lane $lane compile SDK did not produce $assembly" >&2; exit 1; }
  done

  # The bridge resolves its game API lane from the install's release_info.json, and a staged
  # reference SDK has none — so a release build has to say which lane it is, or the bridge refuses
  # to compile.
  game_api_lane="$(release_lane_game_api "$lane")"
  DOTNET_ROLL_FORWARD=Major dotnet publish "$repo_root/src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj" \
    -c Release -o "$lane_publish" \
    -p:CouchCoopBuildToLocalMods=false \
    -p:CouchCoopEnableHotReload=false \
    -p:Sts2AssembliesDir="$sdk_dir" \
    -p:Sts2GameApi="$game_api_lane" \
    -p:EnableSts2LiveHost=true \
    -p:Version="$version" -p:AssemblyVersion="$assembly_version" -p:FileVersion="$assembly_version" \
    -p:InformationalVersion="$informational_version" -p:ContinuousIntegrationBuild=true \
    -p:DebugSymbols=false -p:DebugType=None

  # Dropped before anything is compared or staged: a *.deps.json under lanes/ would be a second
  # .json inside the mod directory, which STS2 scans as a mod manifest.
  find "$lane_publish" -type f \( -name '*.deps.json' -o -name '*.runtimeconfig.json' \) -delete

  lane_dir="$payload_dir/lanes/$(release_lane_dir_name "$lane")"
  mkdir -p "$lane_dir"
  for assembly in "${lane_assemblies[@]}"; do
    [[ -f "$lane_publish/$assembly" ]] || {
      echo "lane $lane publish did not produce the lane assembly $assembly" >&2
      exit 1
    }
    mv "$lane_publish/$assembly" "$lane_dir/$assembly"
  done

  [[ "$lane" == "$first_lane" ]] || assert_shared_publish_matches "$publish_root/$first_lane" "$lane_publish" "$lane"

  # One reference record per lane, merged into build-info.txt below. Written here because the
  # lockfile and the resolved package are the lane's, not the release's.
  lane_lock="$(lane_lockfile "$lane")"
  jq -n \
    --arg lane "$lane" \
    --arg id "$sts2_package_id" \
    --arg version "$(jq -er --arg id "$sts2_package_id" '.dependencies["net9.0"][$id].resolved' "$lane_lock")" \
    --arg contentHash "$(jq -er --arg id "$sts2_package_id" '.dependencies["net9.0"][$id].contentHash' "$lane_lock")" \
    --arg gameBuild "$(release_lane_game_build "$lane")" \
    --arg minGameVersion "$(release_lane_game_floor "$lane")" \
    --arg bridgeGameApi "$game_api_lane" \
    --arg laneDirectory "$(release_lane_dir_name "$lane")" \
    --arg nugetLock "$(release_sha256 "$lane_lock")" \
    '{($lane): {id: $id, version: $version, nugetContentHash: $contentHash, gameBuild: $gameBuild,
                minGameVersion: $minGameVersion, bridgeGameApi: $bridgeGameApi,
                laneDirectory: $laneDirectory, nugetLockSha256: $nugetLock}}' \
    > "$references_dir/$lane.json"
done

# The shared tree, emitted once, from the lane every other lane was just held identical to.
cp -a "$publish_root/$first_lane/." "$payload_dir/"

# The merged payload declares ONE floor for every lane it carries, and it has to be the lowest of
# them: the manifest gate runs before any lane is selected, so a v0.111.0 floor would make this one
# payload refuse to load on the stable branch whose lane it also ships. The value is
# SemanticVersion-compared by the game and a leading `v` is canonical; scripts/lib/release-lanes.sh
# owns the literals and rejects anything that would not parse.
jq --arg version "$version" --arg minGameVersion "$min_game_version" \
  '.version = $version | .min_game_version = $minGameVersion' \
  "$payload_dir/couchcoop.json" > "$payload_dir/couchcoop.json.tmp"
mv "$payload_dir/couchcoop.json.tmp" "$payload_dir/couchcoop.json"

license_dir="$payload_dir/licenses"
npm_license_dir="$license_dir/npm"
mkdir -p "$npm_license_dir"
cp "$repo_root/LICENSE" "$payload_dir/LICENSE"
cp "$repo_root/NOTICE" "$payload_dir/NOTICE"
cp "$repo_root/THIRD_PARTY_NOTICES.md" "$payload_dir/THIRD_PARTY_NOTICES.md"
cp "$repo_root/licenses/QRCoder-1.6.0-MIT.txt" "$license_dir/QRCoder-1.6.0-MIT.txt"
cp "$repo_root/licenses/DeviceDetector.NET-6.5.2-Apache-2.0.txt" "$license_dir/DeviceDetector.NET-6.5.2-Apache-2.0.txt"
for license in LiteDB-5.0.21-MIT.txt Microsoft.Extensions.DependencyInjection.Abstractions-10.0.10-MIT.txt Microsoft.Extensions.Logging.Abstractions-10.0.10-MIT.txt System.Diagnostics.DiagnosticSource-10.0.10-MIT.txt YamlDotNet-18.1.0-MIT.txt; do
  cp "$repo_root/licenses/$license" "$license_dir/$license"
done
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
  license_file=""
  while IFS= read -r candidate; do
    candidate_name="$(basename "$candidate" | tr '[:upper:]' '[:lower:]')"
    case "$candidate_name" in
      license*) [[ -n "$license_file" ]] || license_file="$candidate" ;;
    esac
  done < <(release_list_immediate_files "$package_dir")
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
# cannot otherwise tell you -- it is the record of which reference package each lane was built
# against, and a player who extracted a zip months ago can still read it.
#
# `.txt`, not `.json`, and this is load-bearing: STS2 lists a mod directory and treats every filename
# ending in `.json` as a mod manifest, while Godot's hidden-file test is a dot-prefix on Unix but
# FILE_ATTRIBUTE_HIDDEN on Windows, which a zip-extracted file never carries. A `.build-info.json`
# would therefore be skipped here and scanned as a broken manifest on every Windows player's machine.
# scripts/verify-release-archive.sh rejects any second root-level .json for the same reason.
if [[ "$snapshot" == "1" ]]; then
  # No release-dependencies.json pin applies to a snapshot -- record the sibling commit the outer
  # pass actually archived (its own clean-tree check already ran).
  spirectl_commit="${COUCHCOOP_RELEASE_SPIRECTL_COMMIT:?missing spirectl commit}"
  godot_scene_web_commit="${COUCHCOOP_RELEASE_GODOT_SCENE_WEB_COMMIT:?missing godot-scene-web commit}"
else
  spirectl_commit="$(jq -r '.dependencies.spirectl.commit' "$deps")"
  godot_scene_web_commit="$(jq -r '.dependencies["godot-scene-web"].commit' "$deps")"
fi

# `dependencies.sts2References` is a SET KEYED BY LANE, in the order the lanes were built: a merged
# payload is compiled against one pinned reference package per lane, and a single {lane, id,
# version} object could only ever describe one of them. Each entry also carries the lane's own NuGet
# lockfile hash, which is why lockfileSha256 below holds only the lane-independent locks. Everything
# else about a release -- the commit, the tag, the version, the toolchain -- is single-valued and
# stays that way.
reference_files=()
for lane in "${lanes[@]}"; do
  reference_files+=("$references_dir/$lane.json")
done
sts2_references="$(jq -s 'add' "${reference_files[@]}")"

build_info="$payload_dir/build-info.txt"
jq -n \
  --arg schema "couchcoop-release-build-info/v2" \
  --arg sourceCommit "$source_commit" --arg tag "$tag" --arg version "$version" \
  --arg spirectl "$spirectl_commit" \
  --arg godotSceneWeb "$godot_scene_web_commit" \
  --argjson sts2References "$sts2_references" \
  --arg dotnet "$(dotnet --version)" --arg node "$(node --version)" --arg pnpm "$(corepack pnpm --version)" \
  --arg frontendLock "$(release_sha256 "$repo_root/frontend/package-lock.json")" \
  --arg spirectlLock "$(release_sha256 "$source_parent/spirectl/presentation/web/pnpm-lock.yaml")" \
  --arg godotSceneWebLock "$(release_sha256 "$source_parent/godot-scene-web/pnpm-lock.yaml")" \
  '{schemaVersion: $schema, sourceCommit: $sourceCommit, tag: ($tag | if length > 0 then . else null end), version: $version, dependencies: {spirectl: $spirectl, godotSceneWeb: $godotSceneWeb, sts2References: $sts2References}, toolchain: {dotnet: $dotnet, node: $node, pnpm: $pnpm}, lockfileSha256: {frontendPackageLock: $frontendLock, spirectlPresentationPnpmLock: $spirectlLock, godotSceneWebPnpmLock: $godotSceneWebLock}}' > "$build_info"

# The payload is complete here, build-info.txt included, so the gate sees exactly what ships. The
# lane expectations are stated, not inferred: every lane built must be present, and a full release
# must additionally carry every lane that exists (--complete).
verify_args=()
for lane in "${lanes[@]}"; do verify_args+=(--lane "$lane"); done
if [[ "$complete" == "1" ]]; then verify_args+=(--complete); fi
"$repo_root/scripts/verify-release-archive.sh" \
  --payload "$payload_dir" --version "$version" "${verify_args[@]}"

(cd "$work_dir/payload" && TZ=UTC zip -X -q -r "$archive" couchcoop)
# One small checksum file per archive, kept on purpose. The in-payload manifest that used to be
# published alongside it was a CONSISTENCY check, not an authenticity one -- a tamperer rewrites a
# payload and its manifest together -- so it is recomputed inside the gate now instead of shipped.
# SHA256SUMS is cheap, verifies with the portable helper offline, and sits beside GitHub's per-asset digests
# and the release workflow's actions/attest signature. Do not "simplify" it away.
printf '%s  %s\n' "$(release_sha256 "$archive")" "$(basename "$archive")" > "$checksums"
"$repo_root/scripts/verify-release-archive.sh" \
  --archive "$archive" --checksums "$checksums" --version "$version" "${verify_args[@]}"

lane_report="$(for lane in "${lanes[@]}"; do printf '%s -> lanes/%s/  ' "$lane" "$(release_lane_dir_name "$lane")"; done)"
printf 'release archive: %s (min_game_version %s; %s)\n' \
  "$archive" "$min_game_version" "${lane_report% *}"
