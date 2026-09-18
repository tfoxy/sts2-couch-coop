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

# Do not dump arbitrary logs. Keep only the bounded startup and lobby checkpoints support can safely
# request. This is intentionally a FULL-LINE allowlist: a valid-looking substring followed by a URL, path,
# port, runtime type or stack must not turn the support snapshot into an arbitrary-log exfiltration route.
checkpoint_pattern='^(\[(INFO|ERROR)\] )?\[couchcoop\] (loader-entry|loader-version version=(<undetected>|v?[0-9]+\.[0-9]+\.[0-9]+([.+-][0-9A-Za-z.-]+)?)|loader-payload payload=(lane [0-9]+\.[0-9]+\.[0-9]+|flat, built for (<unstamped>|v?[0-9]+\.[0-9]+\.[0-9]+([.+-][0-9A-Za-z.-]+)?))|loader-invoke|mod-init|harmony-probe-enter|harmony-probe-complete result=(ok|failed)|lobby-patch-attempt phase=initial pending=2 total=2|lobby-patch-attempt phase=retry pending=[0-2] total=2|lobby-patch-complete targets=2 total=2|lobby-patch-incomplete targets=[0-1] total=2 retry=(pending|exhausted)|host-browser-listener result=(available|unavailable)|lobby-controller-armed|lobby-screen-mounted kind=(character-select|load-game)|host-lobby-evaluated kind=(character-select|load-game) result=(host|not-host|unavailable)|qr-panel-install-enter kind=(character-select|load-game)|qr-panel-install-complete kind=(character-select|load-game)|qr-panel-install-failed kind=(character-select|load-game) category=(lookup|create|stream-skip|attach|initialize|activate))$'
LC_ALL=C grep -E "$checkpoint_pattern" "$log" | tail -n 50 || true
