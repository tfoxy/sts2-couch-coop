#!/usr/bin/env bash
set -euo pipefail

# Build a reviewable release archive without reading sts2.local.yaml, a game
# installation, or sibling working trees.  The outer invocation creates a clean
# three-repository workspace; the inner invocation runs only in that workspace.

usage() {
  cat >&2 <<'EOF'
usage: scripts/package-release.sh [--snapshot]

At a clean vMAJOR.MINOR.PATCH tag, builds dist/couchcoop-vMAJOR.MINOR.PATCH.zip.
--snapshot permits a clean untagged commit and builds
dist/couchcoop-snapshot-<short-sha>.zip with version 0.0.0-snapshot.<short-sha>.
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Which pinned STS2 reference lane to build against: one lane per game Steam branch, under
# eng/Sts2.ReferenceSdk/<lane>/. Read in both passes and handed to the staged pass explicitly.
lane="${COUCHCOOP_RELEASE_STS2_LANE:-stable}"
sts2_package_id="FuYnAloft.Sts2.References"
sdk_project="$repo_root/eng/Sts2.ReferenceSdk/$lane/Sts2.ReferenceSdk.$lane.csproj"
sdk_lockfile="$repo_root/eng/Sts2.ReferenceSdk/$lane/packages.lock.json"
[[ -f "$sdk_project" && -f "$sdk_lockfile" ]] || {
  echo "unknown STS2 reference lane: $lane" >&2
  exit 1
}

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

  source_commit="$(git -C "$repo_root" rev-parse HEAD)"
  short_commit="$(git -C "$repo_root" rev-parse --short=12 HEAD)"
  tag="$(git -C "$repo_root" tag --points-at HEAD --list 'v*' | sort -V | tail -n 1)"
  if [[ "$snapshot" == "1" ]]; then
    version="0.0.0-snapshot.${short_commit}"
    assembly_version="0.0.0.0"
    archive_name="couchcoop-snapshot-${short_commit}.zip"
    tag=""
  else
    if [[ ! "$tag" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
      echo "HEAD must be exactly tagged vMAJOR.MINOR.PATCH; use --snapshot for a clean development archive" >&2
      exit 1
    fi
    version="${tag#v}"
    assembly_version="${version}.0"
    archive_name="couchcoop-${tag}.zip"
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
  COUCHCOOP_RELEASE_STAGED=1 \
  COUCHCOOP_RELEASE_SOURCE_COMMIT="$source_commit" \
  COUCHCOOP_RELEASE_TAG="$tag" \
  COUCHCOOP_RELEASE_VERSION="$version" \
  COUCHCOOP_RELEASE_ASSEMBLY_VERSION="$assembly_version" \
  COUCHCOOP_RELEASE_ARCHIVE_NAME="$archive_name" \
  COUCHCOOP_RELEASE_OUTPUT_DIR="$repo_root/dist" \
  COUCHCOOP_RELEASE_STS2_LANE="$lane" \
  bash "$source_parent/couchcoop/scripts/package-release.sh"
  exit 0
fi

version="${COUCHCOOP_RELEASE_VERSION:?missing release version}"
assembly_version="${COUCHCOOP_RELEASE_ASSEMBLY_VERSION:?missing assembly version}"
archive_name="${COUCHCOOP_RELEASE_ARCHIVE_NAME:?missing archive name}"
output_dir="${COUCHCOOP_RELEASE_OUTPUT_DIR:?missing output directory}"
source_commit="${COUCHCOOP_RELEASE_SOURCE_COMMIT:?missing source commit}"
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

DOTNET_ROLL_FORWARD=Major dotnet publish "$repo_root/src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj" \
  -c Release -o "$payload_dir" \
  -p:CouchCoopBuildToLocalMods=false \
  -p:CouchCoopEnableHotReload=false \
  -p:Sts2AssembliesDir="$sdk_dir" \
  -p:EnableSts2LiveHost=true \
  -p:Version="$version" -p:AssemblyVersion="$assembly_version" -p:FileVersion="$assembly_version" \
  -p:InformationalVersion="$version+$source_commit" -p:ContinuousIntegrationBuild=true \
  -p:DebugSymbols=false -p:DebugType=None

COUCHCOOP_RELEASE_BUILD=1 COUCHCOOP_FRONTEND_OUT_DIR="$payload_dir/frontend" \
  npm --prefix "$repo_root/frontend" run build

jq --arg version "$version" '.version = $version' "$payload_dir/couchcoop.json" > "$payload_dir/couchcoop.json.tmp"
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

"$repo_root/scripts/verify-release-archive.sh" --payload "$payload_dir" --version "$version"

contents="$output_dir/${archive_name%.zip}.contents.json"
build_info="$output_dir/${archive_name%.zip}.build-info.json"
checksums="$output_dir/${archive_name%.zip}.SHA256SUMS"
archive="$output_dir/$archive_name"

manifest_lines="$work_dir/contents.ndjson"
while IFS= read -r -d '' file; do
  relative="${file#$work_dir/payload/}"
  jq -cn --arg path "$relative" --arg sha256 "$(sha256sum "$file" | cut -d ' ' -f 1)" --argjson size "$(stat -c %s "$file")" \
    '{path: $path, size: $size, sha256: $sha256}' >> "$manifest_lines"
done < <(find "$work_dir/payload/couchcoop" -type f -print0 | sort -z)
jq -s '{schemaVersion: "couchcoop-release-contents/v1", files: .}' "$manifest_lines" > "$contents"
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
(cd "$work_dir/payload" && TZ=UTC zip -X -q -r "$archive" couchcoop)
(cd "$output_dir" && sha256sum "$(basename "$archive")" "$(basename "$contents")" "$(basename "$build_info")" > "$(basename "$checksums")")
"$repo_root/scripts/verify-release-archive.sh" \
  --archive "$archive" --contents "$contents" --checksums "$checksums"

printf 'release archive: %s\n' "$archive"
