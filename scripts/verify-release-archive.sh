#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/verify-release-archive.sh (--payload <dir> --version <version> | --archive <zip> [--contents <json>] [--checksums <file>])" >&2
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
    LICENSE|NOTICE|THIRD_PARTY_NOTICES.md|couchcoop.json) return 0 ;;
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

payload=""
version=""
archive=""
contents=""
checksums=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --payload) payload="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --archive) archive="${2:-}"; shift 2 ;;
    --contents) contents="${2:-}"; shift 2 ;;
    --checksums) checksums="${2:-}"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
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
  archive_loader="$tmp_dir/couchcoop.dll"
  unzip -p "$archive" couchcoop/couchcoop.dll > "$archive_loader"
  verify_loader_has_no_hot_reload_symbols "$archive_loader"

  if [[ -n "$contents" ]]; then
    [[ -f "$contents" ]] || { echo "contents manifest does not exist" >&2; exit 2; }
    jq -e '
      .schemaVersion == "couchcoop-release-contents/v1"
      and (.files | type == "array")
      and (([.files[].path] | length) == ([.files[].path] | unique | length))
      and all(.files[];
        (.path | type == "string" and startswith("couchcoop/"))
        and (.size | type == "number" and . >= 0)
        and (.sha256 | type == "string" and test("^[0-9a-f]{64}$")))
    ' "$contents" >/dev/null || { echo "contents manifest is invalid" >&2; exit 1; }
    diff -u \
      <(jq -r '.files[].path' "$contents" | LC_ALL=C sort) \
      <(sed 's#^#couchcoop/#' "$file_list" | LC_ALL=C sort) || {
        echo "contents manifest paths do not match archive" >&2
        exit 1
      }
    while IFS=$'\t' read -r path size sha256; do
      actual_size="$(unzip -p "$archive" "$path" | wc -c)"
      actual_sha256="$(unzip -p "$archive" "$path" | sha256sum | cut -d ' ' -f 1)"
      [[ "$actual_size" == "$size" && "$actual_sha256" == "$sha256" ]] || {
        echo "contents manifest hash or size mismatch: $path" >&2
        exit 1
      }
    done < <(jq -r '.files[] | [.path, .size, .sha256] | @tsv' "$contents")
  fi
  if [[ -n "$checksums" ]]; then
    [[ -f "$checksums" ]] || { echo "checksum file does not exist" >&2; exit 2; }
    (cd "$(dirname "$checksums")" && sha256sum -c "$(basename "$checksums")")
  fi
  echo "verify-release-archive: archive ok"
  exit 0
fi

[[ -n "$payload" && -n "$version" && -d "$payload" ]] || { usage; exit 2; }
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
[[ "$(jq -r '.version' "$payload/couchcoop.json")" == "$version" ]] || {
  echo "manifest version mismatch" >&2
  exit 1
}
echo "verify-release-archive: payload ok"
