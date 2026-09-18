#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/release-portable.sh
source "$repo_root/scripts/lib/release-portable.sh"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-macos-support.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT

app="$fixture/Slay The Spire 2.app"
mod="$app/Contents/MacOS/mods/couchcoop"
log="$fixture/godot.log"
mkdir -p "$app/Contents/Resources" "$mod/lanes/0.107.1" "$mod/lanes/0.111.0"
printf '{"version":"v0.111.0"}\n' > "$app/Contents/Resources/release_info.json"
for file in couchcoop.json couchcoop.dll; do printf fixture > "$mod/$file"; done
for lane in 0.107.1 0.111.0; do
  printf fixture > "$mod/lanes/$lane/CouchCoop.Mod.dll"
  printf fixture > "$mod/lanes/$lane/CouchCoop.Spirectl.dll"
done
printf '%s\n' '[couchcoop] loader-entry' '[couchcoop] harmony-probe-complete result=ok' > "$log"

snapshot() {
  local file
  while IFS= read -r file; do printf '%s  %s\n' "$(release_sha256 "$file")" "$file"; done \
    < <(find "$fixture" -type f -print | LC_ALL=C sort)
}
before="$(snapshot)"
output="$("$repo_root/scripts/macos-support-diagnostics.sh" --app "$app" --mod "$mod" --log "$log")"
after="$(snapshot)"
[[ "$before" == "$after" ]] || { echo "support diagnostics changed the fixture" >&2; exit 1; }
grep -F 'package_layout           ok' <<< "$output" >/dev/null
grep -F '[couchcoop] loader-entry' <<< "$output" >/dev/null
grep -F '[couchcoop] harmony-probe-complete result=ok' <<< "$output" >/dev/null
! grep -F "$fixture" <<< "$output" >/dev/null || { echo "support output leaked a fixture path" >&2; exit 1; }
echo "test-macos-support-diagnostics: ok"
