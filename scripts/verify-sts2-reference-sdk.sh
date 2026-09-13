#!/usr/bin/env bash
set -euo pipefail

# Audit the pinned STS2 reference lanes. Needs no game install and no bridge: a lane is a NuGet pin
# plus a reviewed assembly allowlist, which is the whole point -- CI can build a release for a game
# branch it does not own.
#
# usage:
#   scripts/verify-sts2-reference-sdk.sh              every reviewed lane
#   scripts/verify-sts2-reference-sdk.sh <lane>...    only the named lanes
#
# Lane names are GAME STEAM BRANCHES (`stable` = the default `public` branch, `public-beta`), the
# same vocabulary as scripts/with-game-branch.sh. The `-beta` suffix on a package version is NuGet
# PRERELEASE and says nothing about the branch: `0.107.0-beta` is the STABLE lane's pin. Never read
# a lane off a package suffix.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/release-lanes.sh
source "$repo_root/scripts/lib/release-lanes.sh"
sdk_root="$repo_root/eng/Sts2.ReferenceSdk"
shared_targets="$sdk_root/Sts2.ReferenceSdk.targets"

# The reviewed lanes, in review order.
reviewed_lanes=(stable public-beta)

usage() {
  printf 'usage: scripts/verify-sts2-reference-sdk.sh [%s]...\n' "$(
    IFS='|'; echo "${reviewed_lanes[*]}"
  )" >&2
}

# ------------------------------------------------------------------------------------------------
# The reviewed inputs, per lane. These are assertions, not lookups: the script exists to fail when
# a pin, a content hash or an allowlist changes without someone reviewing the new package.
# ------------------------------------------------------------------------------------------------
lane_package_version() {
  case "$1" in
    stable)      echo '0.107.0-beta' ;;   # NuGet prerelease suffix; this is the STABLE lane
    public-beta) echo '0.111.0-beta' ;;
    *) return 1 ;;
  esac
}

lane_godot_version() {
  case "$1" in
    stable|public-beta) echo '4.5.1' ;;
    *) return 1 ;;
  esac
}

# The exact file set a lane's build must stage. Written out per lane on purpose: it is a review of
# one package version. 0.107.0-beta and 0.111.0-beta happen to ship the same eight assemblies
# (measured Sep 12 2026), so these two lists are identical today -- that is a finding, not a
# default, and a new lane must be listed rather than inheriting.
lane_expected_dlls() {
  case "$1" in
    stable)
      printf '%s\n' \
        0Harmony.dll \
        CouchCoop.Sts2.ReferenceSdk.dll \
        GodotSharp.dll \
        MonoMod.Backports.dll \
        MonoMod.ILHelpers.dll \
        Sentry.dll \
        SmartFormat.dll \
        SmartFormat.ZString.dll \
        Steamworks.NET.dll \
        sts2.dll
      ;;
    public-beta)
      printf '%s\n' \
        0Harmony.dll \
        CouchCoop.Sts2.ReferenceSdk.dll \
        GodotSharp.dll \
        MonoMod.Backports.dll \
        MonoMod.ILHelpers.dll \
        Sentry.dll \
        SmartFormat.dll \
        SmartFormat.ZString.dll \
        Steamworks.NET.dll \
        sts2.dll
      ;;
    *) return 1 ;;
  esac
}

is_reviewed_lane() {
  local lane candidate="$1"
  for lane in "${reviewed_lanes[@]}"; do
    [[ "$lane" == "$candidate" ]] && return 0
  done
  return 1
}

lane_project() { printf '%s/%s/Sts2.ReferenceSdk.%s.csproj\n' "$sdk_root" "$1" "$1"; }
lane_lockfile() { printf '%s/%s/packages.lock.json\n' "$sdk_root" "$1"; }

# ------------------------------------------------------------------------------------------------
# A lane directory that nobody reviewed is the failure this catches: the lane list above is what CI
# audits, so an unlisted lane would ship unaudited pins the moment a caller named it.
# ------------------------------------------------------------------------------------------------
verify_lane_inventory() {
  local dir lane found
  for dir in "$sdk_root"/*/; do
    lane="$(basename "$dir")"
    [[ -f "$(lane_project "$lane")" ]] || {
      echo "$dir holds no Sts2.ReferenceSdk.$lane.csproj; a lane directory must be named after its project" >&2
      return 1
    }
    is_reviewed_lane "$lane" || {
      echo "reference lane '$lane' exists on disk but is not in this script's reviewed lane list" >&2
      return 1
    }
  done
  for lane in "${reviewed_lanes[@]}"; do
    found="$(lane_project "$lane")"
    [[ -f "$found" ]] || { echo "reviewed reference lane '$lane' is missing $found" >&2; return 1; }
  done
  [[ -f "$shared_targets" ]] || { echo "shared lane logic is missing: $shared_targets" >&2; return 1; }
}

# Two lanes pinning one package version is a copy-paste that would make the beta release build a
# stable one, with every other check still green.
verify_lane_pins_are_distinct() {
  local lane count
  count="$(
    for lane in "${reviewed_lanes[@]}"; do lane_package_version "$lane"; done | LC_ALL=C sort -u | wc -l
  )"
  [[ "$count" == "${#reviewed_lanes[@]}" ]] || {
    echo "reference lanes must pin distinct FuYnAloft.Sts2.References versions" >&2
    return 1
  }
}

verify_lane() {
  local lane="$1" work_dir="$2"
  local project lockfile package_version godot_version game_build
  project="$(lane_project "$lane")"
  lockfile="$(lane_lockfile "$lane")"
  package_version="$(lane_package_version "$lane")"
  godot_version="$(lane_godot_version "$lane")"
  game_build="$(release_lane_game_build "$lane")"

  [[ -f "$project" && -f "$lockfile" ]] || {
    echo "STS2 reference lane $lane audit inputs are missing" >&2
    return 1
  }

  grep -Fq "Version=\"[$package_version]\"" "$project" || {
    echo "lane $lane must pin the reviewed exact STS2 reference version $package_version" >&2
    return 1
  }
  grep -Fq "Version=\"[$godot_version]\"" "$project" || {
    echo "lane $lane must pin the reviewed exact GodotSharp version $godot_version" >&2
    return 1
  }
  # Per-file counts of exactly the two PackageReferences a lane declares.
  [[ "$(grep -Fc 'ExcludeAssets="all"' "$project")" == "2" ]] || {
    echo "all lane $lane packages must exclude automatic NuGet assets" >&2
    return 1
  }
  [[ "$(grep -Fc 'PrivateAssets="all"' "$project")" == "2" ]] || {
    echo "all lane $lane packages must remain private build inputs" >&2
    return 1
  }
  # The staging target and its missing-input error are shared; a lane that stopped importing them
  # would stage whatever it liked without failing anything else here.
  grep -Fq '<Import Project="../Sts2.ReferenceSdk.targets" />' "$project" || {
    echo "lane $lane must import the shared ../Sts2.ReferenceSdk.targets" >&2
    return 1
  }

  jq -e --arg version "$package_version" --arg godot "$godot_version" '
    .version == 1
    and .dependencies["net9.0"]["FuYnAloft.Sts2.References"].type == "Direct"
    and .dependencies["net9.0"]["FuYnAloft.Sts2.References"].requested == "[\($version), \($version)]"
    and .dependencies["net9.0"]["FuYnAloft.Sts2.References"].resolved == $version
    and (.dependencies["net9.0"]["FuYnAloft.Sts2.References"].contentHash | type == "string" and length > 0)
    and .dependencies["net9.0"].GodotSharp.type == "Direct"
    and .dependencies["net9.0"].GodotSharp.requested == "[\($godot), \($godot)]"
    and .dependencies["net9.0"].GodotSharp.resolved == $godot
    and (.dependencies["net9.0"].GodotSharp.contentHash | type == "string" and length > 0)
  ' "$lockfile" >/dev/null || {
    echo "lane $lane lockfile does not match the reviewed inputs" >&2
    return 1
  }

  DOTNET_ROLL_FORWARD=Major dotnet restore "$project" --locked-mode
  DOTNET_ROLL_FORWARD=Major dotnet build "$project" --no-restore \
    -c Release -o "$work_dir" -p:ContinuousIntegrationBuild=true \
    -p:DebugSymbols=false -p:DebugType=None

  local expected="$work_dir.expected.txt" actual="$work_dir.actual.txt"
  lane_expected_dlls "$lane" | LC_ALL=C sort > "$expected"
  find "$work_dir" -maxdepth 1 -type f -name '*.dll' -printf '%f\n' | LC_ALL=C sort > "$actual"
  diff -u "$expected" "$actual" || {
    echo "lane $lane output does not match the reviewed assembly allowlist" >&2
    return 1
  }

  printf 'verify-sts2-reference-sdk: ok (lane %s: FuYnAloft.Sts2.References %s, game %s)\n' \
    "$lane" "$package_version" "$game_build"
}

# ------------------------------------------------------------------------------------------------
lanes=()
if [[ $# -eq 0 ]]; then
  lanes=("${reviewed_lanes[@]}")
else
  for requested in "$@"; do
    case "$requested" in
      -h|--help) usage; exit 0 ;;
    esac
    is_reviewed_lane "$requested" || { echo "unknown reference lane: $requested" >&2; usage; exit 2; }
    lanes+=("$requested")
  done
fi

verify_lane_inventory
verify_lane_pins_are_distinct

work_root="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-reference-sdk.XXXXXX")"
trap 'rm -rf "$work_root"' EXIT

# Sequentially: each lane restores and builds, and the caller usually wants the first failure.
for lane in "${lanes[@]}"; do
  verify_lane "$lane" "$work_root/$lane"
done
