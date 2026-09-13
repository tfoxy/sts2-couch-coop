#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib/release-lanes.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/release-lanes.sh"

usage() {
  cat >&2 <<'EOF'
usage: scripts/verify-release-archive.sh --payload <dir> --version <version> --lane <lane>
       scripts/verify-release-archive.sh --archive <zip> [--version <version>] [--lane <lane>]
                                         [--checksums <file>] [--emit-contents <file>]

Both modes run the same structural gate. Nothing outside the archive is required: the per-file
contents manifest is recomputed here rather than published as a release asset, and the build
metadata is read from the payload's own couchcoop/build-info.txt.

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

is_allowed_payload_file() {
  local path="$1" leaf
  case "$path" in
    LICENSE|NOTICE|THIRD_PARTY_NOTICES.md|couchcoop.json|build-info.txt) return 0 ;;
    couchcoop.dll|CouchCoop.Mod.dll|CouchCoop.Mod.Contracts.dll|CouchCoop.MirrorProtocol.dll|CouchCoop.Spirectl.dll|QRCoder.dll) return 0 ;;
    frontend/index.html|frontend/offline.html|frontend/sw.js|frontend/app-boot|frontend/.vite/manifest.json) return 0 ;;
    frontend/manifest.webmanifest|frontend/manifest.*.webmanifest) return 0 ;;
    frontend/icons/icon.svg|frontend/icons/icon-*.png) return 0 ;;
    licenses/QRCoder-1.6.0-MIT.txt|licenses/spirectl-LICENSE|licenses/spirectl-NOTICE|licenses/godot-scene-web-LICENSE|licenses/HarfBuzz-LICENSE|licenses/Emscripten-LICENSE|licenses/OpenSans-LICENSE|licenses/npm-dependencies.tsv) return 0 ;;
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

required_files=(
  LICENSE
  NOTICE
  THIRD_PARTY_NOTICES.md
  couchcoop.json
  build-info.txt
  couchcoop.dll
  CouchCoop.Mod.dll
  CouchCoop.Mod.Contracts.dll
  CouchCoop.MirrorProtocol.dll
  CouchCoop.Spirectl.dll
  QRCoder.dll
  frontend/index.html
  frontend/app-boot
  licenses/QRCoder-1.6.0-MIT.txt
  licenses/spirectl-LICENSE
  licenses/spirectl-NOTICE
  licenses/godot-scene-web-LICENSE
  licenses/HarfBuzz-LICENSE
  licenses/Emscripten-LICENSE
  licenses/OpenSans-LICENSE
  licenses/npm-dependencies.tsv
)

verify_file_list() {
  local list_file="$1" path required
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
    esac
    # STS2 lists a mod directory and reads EVERY name ending in .json as a mod manifest, and Godot's
    # hidden-file test is platform-split -- a dot prefix hides a file on Linux but not on Windows,
    # where a zip-extracted file carries no FILE_ATTRIBUTE_HIDDEN. So a second root-level .json (or a
    # dot-prefixed one) loads as a manifest on every Windows player's machine and fails with no id.
    # This is why the build metadata ships as build-info.txt; do not "fix" the extension back.
    case "$path" in
      */*) ;;
      couchcoop.json) ;;
      *.json|.*.json)
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

# build-info.txt is the only thing in the payload that is not derivable from the payload, and with
# one archive per game branch it is the record of which game API a zip was built against. So the
# gate reads the lane and version out of it and holds the manifest to them.
verify_build_info_and_manifest() {
  local build_info="$1" manifest="$2" expected_lane="$3" expected_version="$4"
  local lane build_info_version manifest_version expected_min actual_min

  jq -e '
    .schemaVersion == "couchcoop-release-build-info/v1"
    and (.version | type == "string" and length > 0)
    and (.dependencies.sts2References.lane | type == "string" and length > 0)
  ' "$build_info" >/dev/null || { echo "payload build-info.txt is invalid" >&2; return 1; }

  lane="$(jq -r '.dependencies.sts2References.lane' "$build_info")"
  build_info_version="$(jq -r '.version' "$build_info")"
  release_lane_is_valid_name "$lane" || { echo "payload build-info.txt declares an unusable lane: $lane" >&2; return 1; }
  release_lane_is_known "$lane" || { echo "payload build-info.txt declares an unreviewed lane: $lane" >&2; return 1; }
  if [[ -n "$expected_lane" && "$lane" != "$expected_lane" ]]; then
    echo "payload was built for lane '$lane', not the requested '$expected_lane'" >&2
    return 1
  fi
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

  # The lane's reviewed floor, checked independently of whoever stamped the manifest. An unparseable
  # min_game_version is worse than none at all: MOD_ERROR.GAME_VERSION_INVALID fails the mod on every
  # game build, the right one included.
  expected_min="$(release_lane_min_game_version "$lane")"
  actual_min="$(jq -r '.min_game_version // empty' "$manifest")"
  if [[ -n "$actual_min" && ! "$actual_min" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "manifest min_game_version does not parse as [v]MAJOR.MINOR.PATCH: $actual_min" >&2
    return 1
  fi
  [[ "$actual_min" == "$expected_min" ]] || {
    echo "manifest min_game_version is '${actual_min:-unset}' but lane $lane requires '${expected_min:-unset}'" >&2
    return 1
  }
}

# The published per-file manifest is gone; this recreates it from the archive on demand.
emit_contents_manifest() {
  local root="$1" destination="$2" lines="$3" file relative
  : > "$lines"
  while IFS= read -r -d '' file; do
    relative="${file#$root/}"
    jq -cn --arg path "couchcoop/$relative" --arg sha256 "$(sha256sum "$file" | cut -d ' ' -f 1)" \
      --argjson size "$(stat -c %s "$file")" '{path: $path, size: $size, sha256: $sha256}' >> "$lines"
  done < <(find "$root" -type f -print0 | LC_ALL=C sort -z)
  jq -s '{schemaVersion: "couchcoop-release-contents/v1", files: .}' "$lines" > "$destination"
}

payload=""
version=""
lane=""
archive=""
checksums=""
emit_contents=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --payload) payload="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --lane) lane="${2:-}"; shift 2 ;;
    --archive) archive="${2:-}"; shift 2 ;;
    --checksums) checksums="${2:-}"; shift 2 ;;
    --emit-contents) emit_contents="${2:-}"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done
if [[ -n "$lane" ]]; then
  release_lane_is_valid_name "$lane" || { echo "unusable lane name: $lane" >&2; exit 2; }
fi

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
    "$payload_root/build-info.txt" "$payload_root/couchcoop.json" "$lane" "$version"
  if [[ -n "$emit_contents" ]]; then
    emit_contents_manifest "$payload_root" "$emit_contents" "$tmp_dir/contents.ndjson"
  fi

  if [[ -n "$checksums" ]]; then
    [[ -f "$checksums" ]] || { echo "checksum file does not exist" >&2; exit 2; }
    # One SHA256SUMS covers every lane's archive, and a caller usually holds only one of them (an
    # uploader downloads its own lane). --ignore-missing checks what is here and still fails when
    # nothing was verified, so a checksum file that does not name this archive is caught.
    (cd "$(dirname "$checksums")" && sha256sum --ignore-missing -c "$(basename "$checksums")")
  fi
  echo "verify-release-archive: archive ok"
  exit 0
fi

[[ -n "$payload" && -n "$version" && -n "$lane" && -d "$payload" ]] || { usage; exit 2; }
if find "$payload" -type l -print -quit | grep -q .; then
  echo "release payload contains a symlink" >&2
  exit 1
fi
while IFS= read -r -d '' directory; do
  relative_directory="${directory#$payload/}"
  case "$relative_directory" in
    hot-reload|hot-reload/*)
      echo "release payload contains forbidden hot-reload directory: $relative_directory" >&2
      exit 1
      ;;
  esac
done < <(find "$payload" -mindepth 1 -type d -print0)
while IFS= read -r -d '' file; do
  printf '%s\n' "${file#$payload/}" >> "$file_list"
done < <(find "$payload" -type f -print0)
verify_file_list "$file_list"
verify_loader_has_no_hot_reload_symbols "$payload/couchcoop.dll"
verify_build_info_and_manifest "$payload/build-info.txt" "$payload/couchcoop.json" "$lane" "$version"
echo "verify-release-archive: payload ok"
