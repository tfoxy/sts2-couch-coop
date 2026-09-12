#!/usr/bin/env bash
set -euo pipefail

# Prove that a reference lane is a faithful stand-in for the game build it is paired with: this
# repository's consumer assemblies must emit identical STS2 type/member references AND identical
# normalized IL whether they were compiled against the legitimate game install or against the
# lane's declaration-only NuGet package.
#
# The IL leg is not redundant. Enum values and optional-parameter defaults are baked into the
# caller as constants, so they change emitted instructions without changing a single MemberRef row.
#
# Unlike scripts/verify-sts2-reference-sdk.sh (the CI audit, which needs no game), this needs a real
# install per lane -- and a lane must be compared against ITS OWN game build. The pairing table is
# eng/Sts2.ReferenceSdk/README.md.

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/compare-sts2-reference-builds.sh LANE GAME_ASSEMBLIES_DIR [LANE GAME_ASSEMBLIES_DIR ...]
  scripts/compare-sts2-reference-builds.sh GAME_ASSEMBLIES_DIR

Lane names are game Steam branches -- `stable` (the default `public` branch) and `public-beta` --
matching eng/Sts2.ReferenceSdk/<lane>/ and scripts/with-game-branch.sh. The one-argument form means
the stable lane.

Multiple lanes run SEQUENTIALLY, never concurrently: every pass builds the same consumer projects
into the same bin/Release/net9.0 directories, so two lanes in one checkout would overwrite each
other's outputs. Use separate checkouts to get parallelism.

The `-beta` suffix on a package version is NuGet prerelease, not a Steam branch: the stable lane's
pin is 0.107.0-beta. Lane names are the only thing that says which game branch is meant.
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_root="$repo_root/eng/Sts2.ReferenceSdk"

lane_project() { printf '%s/%s/Sts2.ReferenceSdk.%s.csproj\n' "$sdk_root" "$1" "$1"; }

# ------------------------------------------------------------------------------------------------
# Arguments: (lane, game assemblies dir) pairs, validated up front so a typo in the last pair does
# not surface after the first lane's builds.
# ------------------------------------------------------------------------------------------------
args=("$@")
if [[ ${#args[@]} -eq 1 && -d "${args[0]}" ]]; then
  args=(stable "${args[0]}")
fi
if [[ ${#args[@]} -eq 0 || $(( ${#args[@]} % 2 )) -ne 0 ]]; then
  usage
  exit 2
fi

lanes=()
real_sdks=()
for (( i = 0; i < ${#args[@]}; i += 2 )); do
  lane="${args[i]}"
  real_sdk="${args[i + 1]}"
  project="$(lane_project "$lane")"
  if [[ ! -f "$project" ]]; then
    echo "unknown reference lane '$lane': no $project" >&2
    usage
    exit 2
  fi
  if [[ ! -d "$real_sdk" ]]; then
    echo "not a game assemblies directory: $real_sdk" >&2
    usage
    exit 2
  fi
  for assembly in sts2.dll GodotSharp.dll 0Harmony.dll; do
    [[ -f "$real_sdk/$assembly" ]] || {
      echo "missing game assembly: $real_sdk/$assembly" >&2
      exit 1
    }
  done
  for seen in "${lanes[@]}"; do
    [[ "$seen" != "$lane" ]] || { echo "lane '$lane' named twice" >&2; exit 2; }
  done
  lanes+=("$lane")
  real_sdks+=("$real_sdk")
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

work_root="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-reference-build-audit.XXXXXX")"
trap 'rm -rf "$work_root"' EXIT

# Explicit `|| return 1` throughout the functions below: `set -e` is suppressed inside a function
# called in a condition context, so a failed build would otherwise fall through to the copies and
# the IL diff and report a confusing failure instead of the real one.
build_consumers() {
  local sdk="$1"
  local output="$2"
  DOTNET_ROLL_FORWARD=Major dotnet build \
    "$repo_root/src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj" \
    -c Release --no-incremental \
    -p:CouchCoopBuildToLocalMods=false \
    -p:Sts2AssembliesDir="$sdk" \
    -p:EnableSts2LiveHost=true \
    -p:DebugSymbols=false -p:DebugType=None || return 1
  cp "$repo_root/src/CouchCoop.Mod/bin/Release/net9.0/CouchCoop.Mod.dll" "$output/" || return 1
  cp "$repo_root/src/CouchCoop.Mod.Loader/bin/Release/net9.0/couchcoop.dll" "$output/" || return 1
  cp "$spirectl_root/bridge-mod/src/Spirectl.Sts2/bin/Release/net9.0/CouchCoop.Spirectl.dll" "$output/" || return 1
}

compare_lane() {
  local lane="$1" real_sdk="$2" work_dir="$3"
  mkdir -p "$work_dir/real" "$work_dir/reference" "$work_dir/reference-sdk" || return 1

  # Compile against the legitimate local game first, then rebuild the exact same sources against
  # the lane's pinned declaration-only NuGet reference SDK. Only consumer assemblies are inspected;
  # sts2.dll itself is never copied into an audit result or release.
  build_consumers "$real_sdk" "$work_dir/real" || return 1
  DOTNET_ROLL_FORWARD=Major dotnet build "$(lane_project "$lane")" \
    -c Release -o "$work_dir/reference-sdk" \
    -p:RestoreLockedMode=true -p:ContinuousIntegrationBuild=true \
    -p:DebugSymbols=false -p:DebugType=None || return 1
  build_consumers "$work_dir/reference-sdk" "$work_dir/reference" || return 1

  local failed=0 dll side raw
  for dll in CouchCoop.Mod.dll couchcoop.dll CouchCoop.Spirectl.dll; do
    for side in real reference; do
      raw="$work_dir/$side/$dll.il"
      ilspycmd -il "$work_dir/$side/$dll" > "$raw" 2>/dev/null || return 1
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
      echo "[$lane] $dll emitted different STS2 type/member references" >&2
      diff -u "$work_dir/reference/$dll.sts2refs" "$work_dir/real/$dll.sts2refs" >&2 || true
      failed=1
    fi
    if ! cmp -s "$work_dir/reference/$dll.instructions" "$work_dir/real/$dll.instructions"; then
      echo "[$lane] $dll emitted different instructions (check enum values and optional defaults)" >&2
      diff -u "$work_dir/reference/$dll.instructions" "$work_dir/real/$dll.instructions" >&2 || true
      failed=1
    fi
  done

  (( failed == 0 )) || return 1
}

failed_lanes=()
for (( i = 0; i < ${#lanes[@]}; i++ )); do
  lane="${lanes[i]}"
  printf 'compare-sts2-reference-builds: lane %s against %s\n' "$lane" "${real_sdks[i]}" >&2
  if compare_lane "$lane" "${real_sdks[i]}" "$work_root/$lane"; then
    printf 'compare-sts2-reference-builds: lane %s ok\n' "$lane"
  else
    failed_lanes+=("$lane")
  fi
done

if (( ${#failed_lanes[@]} > 0 )); then
  printf 'compare-sts2-reference-builds: FAILED lanes: %s\n' "${failed_lanes[*]}" >&2
  exit 1
fi
echo "compare-sts2-reference-builds: ok"
