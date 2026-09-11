#!/usr/bin/env bash
set -euo pipefail

# Build the native Android client APK locally (no CI) and optionally deploy it next to the mod's SPA so the
# host serves it at /couchcoop-client.apk and the join page shows an install link (lean M1f).
#
# Wraps the proven recipe from godot-client/README.md "Android export recipe":
#   setup-android-template.sh (once) -> dotnet build -> godot --headless --export-debug "Android".
# Known failure mode guarded below: exporting with a full disk leaves the .NET publish dir empty and Godot
# still signs an APK with NO managed assemblies ("ERROR: .NET: Assemblies not found" on device) — hence the
# mandatory arm64 publish-payload gate after every export.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
client_dir="$repo_root/godot-client"
apk_path="$client_dir/dist/couchcoop-client.apk"
config_path="$repo_root/sts2.local.yaml"

godot_bin="${GODOT_MONO_BIN:-$HOME/.local/godot-4.5.1-mono/Godot_v4.5.1-stable_mono_linux_x86_64/Godot_v4.5.1-stable_mono_linux.x86_64}"
templates_dir="${GODOT_EXPORT_TEMPLATES:-$HOME/.local/share/godot/export_templates/4.5.1.stable.mono}"
java_home="${JAVA_HOME:-$HOME/.local/jdk-17}"

deploy=false
deploy_dir=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/build-android-apk.sh [--deploy] [--deploy-dir <dir>]

Builds godot-client/dist/couchcoop-client.apk (debug-signed, arm64).
--deploy copies it into the mod's apk dir (game.modsDir/couchcoop/apk or game.path/mods/couchcoop/apk
from sts2.local.yaml, same resolution as build-local-mod.sh), where the host serves it at
/couchcoop-client.apk and the join page advertises it. Deliberately a SIBLING of frontend/ — the
frontend deploy (vite) wipes frontend/ on every build and would delete the APK.
EOF
}

yaml_value() {
  local key="$1"
  sed -nE "s/^[[:space:]]*${key}[[:space:]]*:[[:space:]]*\"([^\"]*)\"[[:space:]]*(#.*)?$/\1/p;
           s/^[[:space:]]*${key}[[:space:]]*:[[:space:]]*'([^']*)'[[:space:]]*(#.*)?$/\1/p;
           s/^[[:space:]]*${key}[[:space:]]*:[[:space:]]*([^#[:space:]][^#]*)[[:space:]]*(#.*)?$/\1/p" "$config_path" | head -n 1 | sed -E 's/[[:space:]]+$//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy) deploy=true; shift ;;
    --deploy-dir) deploy=true; deploy_dir="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

fail() { echo "build-android-apk: $1" >&2; exit 1; }

# ---- preflight ------------------------------------------------------------------------------------------
[[ -x "$godot_bin" ]] || fail "Godot 4.5.1 MONO editor not found at $godot_bin (set GODOT_MONO_BIN). The PATH 'godot' is a non-mono build and exports a scriptless client."
[[ -d "$templates_dir" ]] || fail "export templates not found at $templates_dir (need 4.5.1.stable.mono)"
[[ -x "$java_home/bin/java" ]] || fail "JDK 17 not found at $java_home (set JAVA_HOME)"
[[ -f "$HOME/.local/android-keystore/debug.keystore" ]] || fail "debug keystore missing at ~/.local/android-keystore/debug.keystore"
if [[ ! -f "$client_dir/android/build/AndroidManifest.xml" ]]; then
  fail "android build template not installed — run godot-client/setup-android-template.sh first"
fi
grep -q 'usesCleartextTraffic="true"' "$client_dir/android/build/AndroidManifest.xml" \
  || fail "AndroidManifest.xml lacks usesCleartextTraffic — re-run godot-client/setup-android-template.sh"

# Gradle needs ~1.5GB; a FULL disk silently produces an assemblyless APK (see header).
free_kb="$(df --output=avail -k "$client_dir" | tail -1 | tr -d ' ')"
[[ "$free_kb" -ge $((2 * 1024 * 1024)) ]] || fail "less than 2GB free on $(df --output=target -k "$client_dir" | tail -1) — refusing (full-disk exports produce broken APKs)"

# A DISTRIBUTABLE apk must launch to the Connect screen: refuse baked bench/join args in the preset.
extra_args="$(sed -nE 's/^command_line\/extra_args="(.*)"$/\1/p' "$client_dir/export_presets.cfg" | head -n 1)"
if [[ "$extra_args" =~ --connect|--name|--bench|--duration|--replay ]]; then
  fail "export_presets.cfg bakes command_line/extra_args='$extra_args' — clear it (a distributable build must not auto-join/exit)"
fi

# ---- build + export -------------------------------------------------------------------------------------
echo "build-android-apk: dotnet build (Godot exports the LAST-BUILT assembly)" >&2
dotnet build "$client_dir" >/dev/null

mkdir -p "$client_dir/dist"
echo "build-android-apk: exporting (debug, arm64) -> $apk_path" >&2
JAVA_HOME="$java_home" "$godot_bin" --headless --path "$client_dir" --export-debug "Android" "dist/couchcoop-client.apk"

[[ -f "$apk_path" ]] || fail "export produced no APK at $apk_path"

# ---- payload gate (mandatory) ---------------------------------------------------------------------------
payload_count="$(unzip -l "$apk_path" | grep -c 'assets/.godot/mono/publish/arm64' || true)"
[[ "$payload_count" -gt 0 ]] || fail "APK has NO .NET arm64 payload ($payload_count entries) — broken export (disk full during publish?)"

apk_size="$(stat -c%s "$apk_path")"
apk_sha="$(sha256sum "$apk_path" | cut -d' ' -f1)"

# ---- optional deploy ------------------------------------------------------------------------------------
deployed_to=""
if $deploy; then
  if [[ -z "$deploy_dir" ]]; then
    [[ -f "$config_path" ]] || fail "missing sts2.local.yaml (needed to resolve the mod frontend dir); use --deploy-dir"
    mods_dir="$(yaml_value modsDir || true)"
    if [[ -z "$mods_dir" ]]; then
      game_path="$(yaml_value path || true)"
      [[ -n "$game_path" ]] || fail "sts2.local.yaml has neither game.modsDir nor game.path; use --deploy-dir"
      mods_dir="$game_path/mods"
    fi
    deploy_dir="$mods_dir/couchcoop/apk"
  fi
  mkdir -p "$deploy_dir"
  # Atomic swap so an in-flight download never reads a half-copied file.
  cp "$apk_path" "$deploy_dir/couchcoop-client.apk.tmp"
  mv "$deploy_dir/couchcoop-client.apk.tmp" "$deploy_dir/couchcoop-client.apk"
  deployed_to="$deploy_dir/couchcoop-client.apk"
fi

printf '{"apk":"%s","bytes":%s,"sha256":"%s","payloadEntries":%s,"deployedTo":"%s"}\n' \
  "$apk_path" "$apk_size" "$apk_sha" "$payload_count" "$deployed_to"
