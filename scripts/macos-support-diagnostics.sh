#!/usr/bin/env bash
set -euo pipefail

# Read-only, narrowly scoped support snapshot for a macOS CouchCoop install. It intentionally does
# not walk the game bundle or profile: only the supplied app/mod/log paths and a reviewed CouchCoop
# allowlist are inspected.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/release-lanes.sh
source "$repo_root/scripts/lib/release-lanes.sh"

usage() {
  echo "usage: scripts/macos-support-diagnostics.sh --app <SlayTheSpire2.app> --mod <couchcoop-dir> --log <godot.log>" >&2
}

app="" mod="" log=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) app="${2:-}"; shift 2 ;;
    --mod) mod="${2:-}"; shift 2 ;;
    --log) log="${2:-}"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done
[[ -n "$app" && -n "$mod" && -n "$log" ]] || { usage; exit 2; }
[[ -d "$app" ]] || { echo "app is not a directory" >&2; exit 2; }
[[ -d "$mod" ]] || { echo "mod is not a directory" >&2; exit 2; }
[[ -f "$log" ]] || { echo "log is not a file" >&2; exit 2; }

redact_path() { printf '<redacted>/%s' "$(basename "$1")"; }
status() { printf '%-24s %s\n' "$1" "$2"; }

status os "$(uname -s | tr -cd '[:alnum:]._-')"
status arch "$(uname -m | tr -cd '[:alnum:]._-')"
status app "$(redact_path "$app")"
status mod "$(redact_path "$mod")"

if release_info_exact="$(release_exact_path "$app" "Contents/Resources/release_info.json" 2>/dev/null)"; then
  version="$(jq -r '.version // "unknown"' "$release_info_exact" 2>/dev/null || printf unknown)"
  [[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.+-][0-9A-Za-z.-]+)?$ ]] || version=unknown
  status release_info "version=$version"
else
  status release_info "missing-or-wrong-case"
fi

layout="ok"
for name in couchcoop.json couchcoop.dll; do
  release_exact_path "$mod" "$name" >/dev/null 2>&1 || layout="missing-or-wrong-case:$name"
done
for lane in stable public-beta; do
  directory="$(release_lane_dir_name "$lane")"
  for name in CouchCoop.Mod.dll CouchCoop.Spirectl.dll; do
    release_exact_path "$mod" "lanes/$directory/$name" >/dev/null 2>&1 || layout="missing-or-wrong-case:lanes/$directory/$name"
  done
done
status package_layout "$layout"

allowlisted=(
  couchcoop.json couchcoop.dll CouchCoop.Mod.Contracts.dll CouchCoop.MirrorProtocol.dll
  QRCoder.dll DeviceDetector.NET.dll LiteDB.dll Microsoft.Extensions.DependencyInjection.Abstractions.dll
  Microsoft.Extensions.Logging.Abstractions.dll System.Diagnostics.DiagnosticSource.dll YamlDotNet.dll
)
for lane in stable public-beta; do
  directory="$(release_lane_dir_name "$lane")"
  allowlisted+=("lanes/$directory/CouchCoop.Mod.dll" "lanes/$directory/CouchCoop.Spirectl.dll")
done
for relative in "${allowlisted[@]}"; do
  path="$(release_exact_path "$mod" "$relative" 2>/dev/null || true)"
  [[ -n "$path" && -f "$path" ]] || continue
  printf 'file %-58s sha256=%s mode=%s\n' "$relative" "$(release_sha256 "$path")" "$(release_file_mode "$path")"
done

if command -v codesign >/dev/null 2>&1; then
  if codesign --verify --deep --strict "$app" >/dev/null 2>&1; then
    status codesign verified
  else
    status codesign failed
  fi
else
  status codesign unavailable
fi
if command -v spctl >/dev/null 2>&1; then
  if spctl --assess --type execute "$app" >/dev/null 2>&1; then
    status spctl accepted
  else
    status spctl rejected
  fi
else
  status spctl unavailable
fi

# Do not dump arbitrary logs. These are the only startup checkpoints the support contract promises.
grep -E '\[couchcoop\] (loader-entry|loader-version|loader-payload|loader-invoke|mod-init|harmony-probe-enter|harmony-probe-complete)' "$log" | tail -n 50 || true
