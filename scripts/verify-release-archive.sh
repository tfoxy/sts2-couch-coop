#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib/release-lanes.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/release-lanes.sh"

usage() {
  cat >&2 <<'EOF'
usage: scripts/verify-release-archive.sh --payload <dir> --version <version> --lane <lane>...
                                         [--complete]
       scripts/verify-release-archive.sh --archive <zip> [--version <version>] [--lane <lane>]...
                                         [--complete] [--checksums <file>] [--emit-contents <file>]

Both modes run the same structural gate. Nothing outside the archive is required: the per-file
contents manifest is recomputed here rather than published as a release asset, and the build
metadata is read from the payload's own couchcoop/build-info.txt.

One payload carries every game lane, under couchcoop/lanes/<FLOOR>/ (bare MAJOR.MINOR.PATCH). Lane
expectations are explicit, never inferred from what happens to be in the zip:

  --lane <lane>   the payload MUST carry this lane; repeat for each one. Without it the gate only
                  checks that every lane present is a reviewed one — which is what a deliberate
                  single-lane local build (COUCHCOOP_RELEASE_STS2_LANE) produces.
  --complete      the payload must carry EXACTLY the reviewed lane set. This is the release gate: a
                  published archive that is missing a lane strands every player on that branch.

--emit-contents writes that recomputed manifest (couchcoop-release-contents/v1) for a reviewer who
wants one locally.
EOF
}

is_normalized_path() {
  local path="$1" part
  [[ -n "$path" && "$path" != /* && "$path" != *'\'* && "$path" != *'//'* ]] || return 1
  IFS='/' read -r -a parts <<< "$path"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != '.' && "$part" != '..' ]] || return 1
  done
}

# The per-lane assemblies; scripts/lib/release-lanes.sh owns the list, so the gate and the packager
# cannot disagree about what is lane-varying.
lane_assemblies=()
while IFS= read -r assembly; do lane_assemblies+=("$assembly"); done < <(release_lane_assembly_names)

is_allowed_payload_file() {
  local path="$1" leaf directory remainder assembly
  case "$path" in
    LICENSE|NOTICE|THIRD_PARTY_NOTICES.md|couchcoop.json|build-info.txt) return 0 ;;
    couchcoop.dll|CouchCoop.Mod.Contracts.dll|CouchCoop.MirrorProtocol.dll|QRCoder.dll|DeviceDetector.NET.dll|LiteDB.dll|Microsoft.Extensions.DependencyInjection.Abstractions.dll|Microsoft.Extensions.Logging.Abstractions.dll|System.Diagnostics.DiagnosticSource.dll|YamlDotNet.dll) return 0 ;;
    lanes/*)
      # Exactly the lane assemblies, exactly one directory deep, and only in a directory named after
      # a reviewed lane's floor. Nothing else may land here -- least of all a .json, which STS2 would
      # scan as a second mod manifest (it reads every *.json under a mod directory, recursively).
      leaf="${path#lanes/}"
      directory="${leaf%%/*}"
      remainder="${leaf#*/}"
      [[ "$directory" != "$leaf" && "$remainder" != */* && -n "$remainder" ]] || return 1
      release_lane_from_dir_name "$directory" >/dev/null || return 1
      for assembly in "${lane_assemblies[@]}"; do
        [[ "$remainder" == "$assembly" ]] && return 0
      done
      return 1
      ;;
    frontend/index.html|frontend/offline.html|frontend/sw.js|frontend/app-boot|frontend/.vite/manifest.json) return 0 ;;
    frontend/manifest.webmanifest|frontend/manifest.*.webmanifest) return 0 ;;
    frontend/icons/icon.svg|frontend/icons/icon-*.png) return 0 ;;
    licenses/QRCoder-1.6.0-MIT.txt|licenses/DeviceDetector.NET-6.5.2-Apache-2.0.txt|licenses/LiteDB-5.0.21-MIT.txt|licenses/Microsoft.Extensions.DependencyInjection.Abstractions-10.0.10-MIT.txt|licenses/Microsoft.Extensions.Logging.Abstractions-10.0.10-MIT.txt|licenses/System.Diagnostics.DiagnosticSource-10.0.10-MIT.txt|licenses/YamlDotNet-18.1.0-MIT.txt|licenses/spirectl-LICENSE|licenses/spirectl-NOTICE|licenses/godot-scene-web-LICENSE|licenses/HarfBuzz-LICENSE|licenses/Emscripten-LICENSE|licenses/OpenSans-LICENSE|licenses/npm-dependencies.tsv) return 0 ;;
    licenses/npm/*.LICENSE)
      leaf="${path#licenses/npm/}"
      [[ "$leaf" != */* && -n "$leaf" ]]
      return
      ;;
    frontend/app/*.js|frontend/app/*.css|frontend/app/*.wasm)
      leaf="${path#frontend/app/}"
      [[ "$leaf" != */* && -n "$leaf" ]]
      return
      ;;
    *) return 1 ;;
  esac
}

# The shared tree. Every one of these is byte-identical across lanes -- packaging asserts that and
# fails the build rather than letting a lane-varying file leak in here.
required_files=(
  LICENSE
  NOTICE
  THIRD_PARTY_NOTICES.md
  couchcoop.json
  build-info.txt
  couchcoop.dll
  CouchCoop.Mod.Contracts.dll
  CouchCoop.MirrorProtocol.dll
  QRCoder.dll
  DeviceDetector.NET.dll
  LiteDB.dll
  Microsoft.Extensions.DependencyInjection.Abstractions.dll
  Microsoft.Extensions.Logging.Abstractions.dll
  System.Diagnostics.DiagnosticSource.dll
  YamlDotNet.dll
  frontend/index.html
  frontend/app-boot
  licenses/QRCoder-1.6.0-MIT.txt
  licenses/DeviceDetector.NET-6.5.2-Apache-2.0.txt
  licenses/LiteDB-5.0.21-MIT.txt
  licenses/Microsoft.Extensions.DependencyInjection.Abstractions-10.0.10-MIT.txt
  licenses/Microsoft.Extensions.Logging.Abstractions-10.0.10-MIT.txt
  licenses/System.Diagnostics.DiagnosticSource-10.0.10-MIT.txt
  licenses/YamlDotNet-18.1.0-MIT.txt
  licenses/spirectl-LICENSE
  licenses/spirectl-NOTICE
  licenses/godot-scene-web-LICENSE
  licenses/HarfBuzz-LICENSE
  licenses/Emscripten-LICENSE
  licenses/OpenSans-LICENSE
  licenses/npm-dependencies.tsv
)

# The lane directory names present in a payload, one per line, sorted. Reads the payload's own file
# list -- the lane table IS the directory layout, so there is nothing else to read it from.
payload_lane_directories() {
  sed -n 's#^lanes/\([^/][^/]*\)/.*#\1#p' "$1" | LC_ALL=C sort -u
}

verify_file_list() {
  local list_file="$1" path required directory lane lane_directories=()
  if LC_ALL=C sort "$list_file" | uniq -d | grep -q .; then
    echo "release payload contains duplicate paths" >&2
    return 1
  fi
  while IFS= read -r path; do
    is_normalized_path "$path" || { echo "release path is not normalized: $path" >&2; return 1; }
    case "$path" in
      hot-reload|hot-reload/*)
        echo "release payload contains forbidden hot-reload path: $path" >&2
        return 1
        ;;
      Spirectl.Sts2.dll)
        echo "release payload contains the bridge's default-named shared runtime: $path" >&2
        return 1
        ;;
      CouchCoop.Mod.dll|CouchCoop.Spirectl.dll)
        # A lane assembly at the root is the failure this layout exists to prevent: it is one lane's
        # build sitting where the loader-neutral shared tree goes, and whichever lane wrote it last
        # would win for every player.
        echo "release payload holds a lane assembly at its root; it belongs in lanes/<floor>/: $path" >&2
        return 1
        ;;
      lanes/*)
        # Said here rather than left to the allowlist, so a directory named after a version nobody
        # reviewed reads as what it is instead of as an unexplained path rejection.
        directory="${path#lanes/}"
        directory="${directory%%/*}"
        release_lane_from_dir_name "$directory" >/dev/null || {
          echo "release payload holds lanes/$directory/, which is not a reviewed lane's game floor: $path" >&2
          return 1
        }
        ;;
    esac
    # STS2 lists a mod directory and reads EVERY name ending in .json as a mod manifest, and Godot's
    # hidden-file test is platform-split -- a dot prefix hides a file on Linux but not on Windows,
    # where a zip-extracted file carries no FILE_ATTRIBUTE_HIDDEN. So a second root-level .json (or a
    # dot-prefixed one) loads as a manifest on every Windows player's machine and fails with no id.
    # This is why the build metadata ships as build-info.txt; do not "fix" the extension back.
    case "$path" in
      */*) ;;
      couchcoop.json) ;;
      *.json)
        echo "release payload root holds a second .json, which STS2 scans as a mod manifest: $path" >&2
        return 1
        ;;
    esac
    is_allowed_payload_file "$path" || { echo "release path is not allowlisted: $path" >&2; return 1; }
    case "$path" in
      *.pdb|*.map|*.cs|*.ts|*.vue|*.props|*.targets|*.deps.json|*.runtimeconfig.json|sts2.dll|GodotSharp.dll|0Harmony.dll|CouchCoop.Sts2.ReferenceSdk.dll|MonoMod.Backports.dll|MonoMod.ILHelpers.dll|Sentry.dll|SmartFormat.dll|SmartFormat.ZString.dll|Steamworks.NET.dll)
        echo "release contains a forbidden source/debug/build-time file: $path" >&2
        return 1
        ;;
    esac
  done < "$list_file"
  for required in "${required_files[@]}"; do
    grep -Fxq "$required" "$list_file" || { echo "release payload is missing: $required" >&2; return 1; }
  done
  grep -Eq '^licenses/npm/[^/]+\.LICENSE$' "$list_file" || {
    echo "release payload is missing npm license texts" >&2
    return 1
  }

  # At least one lane, every lane directory a reviewed lane's floor, and every lane complete. A lane
  # directory missing an assembly is worse than a missing lane: the selector would pick it and the
  # mod would fail at load with a file-not-found nobody can act on.
  lane_directories=()
  while IFS= read -r directory; do lane_directories+=("$directory"); done < <(payload_lane_directories "$list_file")
  [[ ${#lane_directories[@]} -gt 0 ]] || {
    echo "release payload carries no lanes/<floor>/ directory, so no game build can load it" >&2
    return 1
  }
  for directory in "${lane_directories[@]}"; do
    lane="$(release_lane_from_dir_name "$directory")" || {
      echo "release payload holds lanes/$directory/, which is not a reviewed lane's game floor" >&2
      return 1
    }
    for required in "${lane_assemblies[@]}"; do
      grep -Fxq "lanes/$directory/$required" "$list_file" || {
        echo "release payload lane $lane (lanes/$directory/) is missing: $required" >&2
        return 1
      }
    done
  done
}

verify_loader_has_no_hot_reload_symbols() {
  local loader="$1" symbol
  for symbol in \
    CouchCoopHotReloadProtocol \
    DescribeSpirectlHotReloadStatusJson \
    RequestSpirectlHotReloadJsonAsync; do
    if grep -aFq "$symbol" "$loader"; then
      echo "release loader contains forbidden hot-reload symbol: $symbol" >&2
      return 1
    fi
  done
}

# build-info.txt is the only thing in the payload that is not derivable from the payload: it records
# which reference package each lane was built against. The gate reads the lane SET out of it, holds
# it to the lane directories that actually ship, and holds the manifest to both.
#
# <build info> <manifest> <expected version|""> <payload lane>...
verify_build_info_and_manifest() {
  local build_info="$1" manifest="$2" expected_version="$3"
  shift 3
  local payload_lanes=("$@")
  local lane build_info_version manifest_version expected_min actual_min
  local declared=() expected_directory expected_floor

  jq -e '
    .schemaVersion == "couchcoop-release-build-info/v2"
    and (.version | type == "string" and length > 0)
    and (.dependencies.sts2References | type == "object")
    and (.dependencies.sts2References | length > 0)
    and (.dependencies.sts2References | to_entries | all(
      (.key | type == "string" and length > 0)
      and (.value.id | type == "string" and length > 0)
      and (.value.version | type == "string" and length > 0)
      and (.value.laneDirectory | type == "string" and length > 0)
      and (.value.minGameVersion | type == "string" and length > 0)))
  ' "$build_info" >/dev/null || { echo "payload build-info.txt is invalid" >&2; return 1; }

  # sts2References is keyed BY LANE now -- one merged payload is built from more than one reference
  # package, so a single {lane, id, version} object could only ever describe one of them.
  declared=()
  while IFS= read -r lane; do declared+=("$lane"); done < <(jq -r '.dependencies.sts2References | keys_unsorted[]' "$build_info" | LC_ALL=C sort)
  for lane in "${declared[@]}"; do
    release_lane_is_valid_name "$lane" || { echo "payload build-info.txt declares an unusable lane: $lane" >&2; return 1; }
    release_lane_is_known "$lane" || { echo "payload build-info.txt declares an unreviewed lane: $lane" >&2; return 1; }
    expected_directory="$(release_lane_dir_name "$lane")"
    expected_floor="$(release_lane_game_floor "$lane")"
    [[ "$(jq -r --arg lane "$lane" '.dependencies.sts2References[$lane].laneDirectory' "$build_info")" == "$expected_directory" ]] || {
      echo "payload build-info.txt puts lane $lane somewhere other than lanes/$expected_directory/" >&2
      return 1
    }
    [[ "$(jq -r --arg lane "$lane" '.dependencies.sts2References[$lane].minGameVersion' "$build_info")" == "$expected_floor" ]] || {
      echo "payload build-info.txt declares a floor for lane $lane that is not the reviewed $expected_floor" >&2
      return 1
    }
  done
  # The record and the payload must name the same lanes. A build-info that claims a lane the archive
  # does not carry is how a player on that branch gets told they have a build they do not have.
  diff <(printf '%s\n' "${declared[@]}") <(printf '%s\n' "${payload_lanes[@]}") >/dev/null || {
    echo "payload build-info.txt lanes [${declared[*]}] do not match the shipped lanes [${payload_lanes[*]}]" >&2
    return 1
  }

  build_info_version="$(jq -r '.version' "$build_info")"
  if [[ -n "$expected_version" && "$build_info_version" != "$expected_version" ]]; then
    echo "payload build-info.txt version is '$build_info_version', not the requested '$expected_version'" >&2
    return 1
  fi

  manifest_version="$(jq -r '.version // empty' "$manifest")"
  if [[ -n "$expected_version" && "$manifest_version" != "$expected_version" ]]; then
    echo "manifest version mismatch" >&2
    return 1
  fi
  [[ "$manifest_version" == "$build_info_version" ]] || {
    echo "manifest version '$manifest_version' disagrees with build-info.txt '$build_info_version'" >&2
    return 1
  }

  # The floor the MERGED payload declares: the lowest floor among the lanes it carries, recomputed
  # here rather than trusted from whoever stamped the manifest. Too high and the one payload refuses
  # to load on the older branch it also carries. Unparseable is worse still:
  # MOD_ERROR.GAME_VERSION_INVALID fails the mod on every game build, the right one included.
  expected_min="$(release_payload_min_game_version "${payload_lanes[@]}")"
  actual_min="$(jq -r '.min_game_version // empty' "$manifest")"
  if [[ -n "$actual_min" && ! "$actual_min" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "manifest min_game_version does not parse as [v]MAJOR.MINOR.PATCH: $actual_min" >&2
    return 1
  fi
  [[ "$actual_min" == "$expected_min" ]] || {
    echo "manifest min_game_version is '${actual_min:-unset}' but lanes [${payload_lanes[*]}] require '${expected_min:-unset}'" >&2
    return 1
  }
}

# The lanes a payload carries, as lane names, sorted. verify_file_list has already refused any
# directory that is not a reviewed lane's floor, so every lookup here resolves.
resolve_payload_lanes() {
  local list_file="$1" directory lane lanes=()
  while IFS= read -r directory; do
    lane="$(release_lane_from_dir_name "$directory")" || return 1
    lanes+=("$lane")
  done < <(payload_lane_directories "$list_file")
  payload_lanes=()
  while IFS= read -r lane; do payload_lanes+=("$lane"); done < <(printf '%s\n' ${lanes[@]+"${lanes[@]}"} | LC_ALL=C sort)
}

# What the CALLER said it expected, kept separate from what the payload happens to contain. A
# single-lane payload is a legitimate local build (COUCHCOOP_RELEASE_STS2_LANE); a single-lane
# RELEASE is a branch full of players who silently get nothing, so the release gate passes
# --complete and this is where the two part company.
verify_lane_expectations() {
  local lane missing=() known=()
  for lane in ${requested_lanes[@]+"${requested_lanes[@]}"}; do
    printf '%s\n' "${payload_lanes[@]}" | grep -Fxq "$lane" \
      || { echo "release payload does not carry the requested lane: $lane" >&2; return 1; }
  done
  [[ "$require_complete" == "1" ]] || return 0
  known=()
  while IFS= read -r lane; do known+=("$lane"); done < <(release_lane_known_names | LC_ALL=C sort)
  for lane in "${known[@]}"; do
    printf '%s\n' "${payload_lanes[@]}" | grep -Fxq "$lane" || missing+=("$lane")
  done
  [[ ${#missing[@]} -eq 0 ]] || {
    echo "release payload is not complete: no lane directory for [${missing[*]}]" >&2
    return 1
  }
}

# The published per-file manifest is gone; this recreates it from the archive on demand.
emit_contents_manifest() {
  local root="$1" destination="$2" lines="$3" relative
  : > "$lines"
  while IFS= read -r relative; do
    jq -cn --arg path "couchcoop/$relative" --arg sha256 "$(release_sha256 "$root/$relative")" \
      --argjson size "$(release_file_size "$root/$relative")" '{path: $path, size: $size, sha256: $sha256}' >> "$lines"
  done < <(release_list_files "$root")
  jq -s '{schemaVersion: "couchcoop-release-contents/v1", files: .}' "$lines" > "$destination"
}

payload=""
version=""
requested_lanes=()
require_complete=0
payload_lanes=()
archive=""
checksums=""
emit_contents=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --payload) payload="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --lane) requested_lanes+=("${2:-}"); shift 2 ;;
    --complete) require_complete=1; shift ;;
    --archive) archive="${2:-}"; shift 2 ;;
    --checksums) checksums="${2:-}"; shift 2 ;;
    --emit-contents) emit_contents="${2:-}"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done
for requested in ${requested_lanes[@]+"${requested_lanes[@]}"}; do
  release_lane_is_valid_name "$requested" || { echo "unusable lane name: $requested" >&2; exit 2; }
  release_lane_is_known "$requested" || { echo "unreviewed lane name: $requested" >&2; exit 2; }
done

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-release-verify.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT
file_list="$tmp_dir/files.txt"

if [[ -n "$archive" ]]; then
  [[ -f "$archive" ]] || { echo "archive does not exist" >&2; exit 2; }
  archive_entries="$tmp_dir/archive-entries.txt"
  unzip -Z1 "$archive" > "$archive_entries"
  while IFS= read -r entry; do
    is_normalized_path "$entry" || { echo "archive path is not normalized: $entry" >&2; exit 1; }
    [[ "$entry" == couchcoop || "$entry" == couchcoop/* ]] || {
      echo "archive has an entry outside couchcoop/: $entry" >&2
      exit 1
    }
    case "$entry" in
      couchcoop/hot-reload|couchcoop/hot-reload/*)
        echo "archive contains forbidden hot-reload path: $entry" >&2
        exit 1
        ;;
    esac
  done < "$archive_entries"
  if LC_ALL=C sort "$archive_entries" | uniq -d | grep -q .; then
    echo "archive contains duplicate entries" >&2
    exit 1
  fi
  sed -n '/^couchcoop\/.*[^\/]$/s#^couchcoop/##p' "$archive_entries" > "$file_list"
  verify_file_list "$file_list"
  resolve_payload_lanes "$file_list"
  verify_lane_expectations

  # Every entry is extracted once, which is also the CRC check, and the rest of the gate then reads
  # real files instead of piping each one back out of the zip.
  extract_root="$tmp_dir/extract"
  mkdir -p "$extract_root"
  unzip -qq -o "$archive" -d "$extract_root" || {
    echo "archive did not extract cleanly (CRC or format error): $archive" >&2
    exit 1
  }
  payload_root="$extract_root/couchcoop"
  verify_loader_has_no_hot_reload_symbols "$payload_root/couchcoop.dll"
  verify_build_info_and_manifest \
    "$payload_root/build-info.txt" "$payload_root/couchcoop.json" "$version" "${payload_lanes[@]}"
  if [[ -n "$emit_contents" ]]; then
    emit_contents_manifest "$payload_root" "$emit_contents" "$tmp_dir/contents.ndjson"
  fi

  if [[ -n "$checksums" ]]; then
    [[ -f "$checksums" ]] || { echo "checksum file does not exist" >&2; exit 2; }
    # --ignore-missing checks what is here and still fails when nothing was verified, so a checksum
    # file that does not name this archive is caught. It mattered more when one SHA256SUMS covered
    # several per-lane archives; kept because a caller may hold the file without every asset beside
    # it, and a checksum file naming nothing it can see must still fail.
    release_verify_checksums "$checksums"
  fi
  echo "verify-release-archive: archive ok (lanes: ${payload_lanes[*]})"
  exit 0
fi

[[ -n "$payload" && -n "$version" && ${#requested_lanes[@]} -gt 0 && -d "$payload" ]] || { usage; exit 2; }
if find "$payload" -type l -print -quit | grep -q .; then
  echo "release payload contains a symlink" >&2
  exit 1
fi
while IFS= read -r relative_directory; do
  case "$relative_directory" in
    hot-reload|hot-reload/*)
      echo "release payload contains forbidden hot-reload directory: $relative_directory" >&2
      exit 1
      ;;
  esac
done < <(release_list_directories "$payload")
release_list_files "$payload" > "$file_list"
verify_file_list "$file_list"
resolve_payload_lanes "$file_list"
verify_lane_expectations
verify_loader_has_no_hot_reload_symbols "$payload/couchcoop.dll"
verify_build_info_and_manifest \
  "$payload/build-info.txt" "$payload/couchcoop.json" "$version" "${payload_lanes[@]}"
echo "verify-release-archive: payload ok (lanes: ${payload_lanes[*]})"
