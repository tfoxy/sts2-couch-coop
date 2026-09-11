#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/compare-sts2-reference-builds.sh GAME_ASSEMBLIES_DIR" >&2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
real_sdk="${1:-}"
if [[ $# -ne 1 || ! -d "$real_sdk" ]]; then
  usage
  exit 2
fi
for assembly in sts2.dll GodotSharp.dll 0Harmony.dll; do
  [[ -f "$real_sdk/$assembly" ]] || {
    echo "missing game assembly: $real_sdk/$assembly" >&2
    exit 1
  }
done
command -v ilspycmd >/dev/null || {
  echo "ilspycmd is required for game/reference comparison" >&2
  exit 1
}

spirectl_root="$(cd "$repo_root/../spirectl" && pwd)"
expected_spirectl="$(jq -er '.dependencies.spirectl.commit' "$repo_root/release-dependencies.json")"
actual_spirectl="$(git -C "$spirectl_root" rev-parse HEAD)"
[[ "$actual_spirectl" == "$expected_spirectl" ]] || {
  echo "../spirectl is not at the revision pinned by release-dependencies.json" >&2
  exit 1
}

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-reference-build-audit.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/real" "$work_dir/reference" "$work_dir/reference-sdk"

build_consumers() {
  local sdk="$1"
  local output="$2"
  DOTNET_ROLL_FORWARD=Major dotnet build \
    "$repo_root/src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj" \
    -c Release --no-incremental \
    -p:CouchCoopBuildToLocalMods=false \
    -p:Sts2AssembliesDir="$sdk" \
    -p:EnableSts2LiveHost=true \
    -p:DebugSymbols=false -p:DebugType=None
  cp "$repo_root/src/CouchCoop.Mod/bin/Release/net9.0/CouchCoop.Mod.dll" "$output/"
  cp "$repo_root/src/CouchCoop.Mod.Loader/bin/Release/net9.0/couchcoop.dll" "$output/"
  cp "$spirectl_root/bridge-mod/src/Spirectl.Sts2/bin/Release/net9.0/CouchCoop.Spirectl.dll" "$output/"
}

# Compile against the legitimate local game first, then rebuild the exact same
# sources against the pinned declaration-only NuGet reference SDK. Only consumer assemblies are
# inspected; sts2.dll itself is never copied into an audit result or release.
build_consumers "$real_sdk" "$work_dir/real"
DOTNET_ROLL_FORWARD=Major dotnet build \
  "$repo_root/eng/Sts2.ReferenceSdk/Sts2.ReferenceSdk.csproj" \
  -c Release -o "$work_dir/reference-sdk" \
  -p:RestoreLockedMode=true -p:ContinuousIntegrationBuild=true \
  -p:DebugSymbols=false -p:DebugType=None
build_consumers "$work_dir/reference-sdk" "$work_dir/reference"

failed=0
for dll in CouchCoop.Mod.dll couchcoop.dll CouchCoop.Spirectl.dll; do
  for side in real reference; do
    raw="$work_dir/$side/$dll.il"
    ilspycmd -il "$work_dir/$side/$dll" > "$raw" 2>/dev/null
    sed -nE '/^[[:space:]]*IL_[0-9a-fA-F]+:/ {
      s/^[[:space:]]*IL_[0-9a-fA-F]+:[[:space:]]*//
      s/IL_[0-9a-fA-F]+/IL_LABEL/g
      p
    }' "$raw" > "$work_dir/$side/$dll.instructions"
    awk '/\[sts2\]/' "$raw" \
      | sed -E 's/^[[:space:]]*IL_[0-9a-fA-F]+:[[:space:]]*//; s/IL_[0-9a-fA-F]+/IL_LABEL/g' \
      | sort -u > "$work_dir/$side/$dll.sts2refs"
  done

  if ! cmp -s "$work_dir/reference/$dll.sts2refs" "$work_dir/real/$dll.sts2refs"; then
    echo "$dll emitted different STS2 type/member references" >&2
    diff -u "$work_dir/reference/$dll.sts2refs" "$work_dir/real/$dll.sts2refs" >&2 || true
    failed=1
  fi
  if ! cmp -s "$work_dir/reference/$dll.instructions" "$work_dir/real/$dll.instructions"; then
    echo "$dll emitted different instructions (check enum values and optional defaults)" >&2
    diff -u "$work_dir/reference/$dll.instructions" "$work_dir/real/$dll.instructions" >&2 || true
    failed=1
  fi
done

(( failed == 0 )) || exit 1
echo "compare-sts2-reference-builds: ok"
