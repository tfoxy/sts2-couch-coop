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
cat > "$log" <<'EOF'
[couchcoop] loader-entry
[couchcoop] loader-version version=v0.111.0
[couchcoop] loader-payload payload=lane 0.111.0
[couchcoop] loader-invoke
[couchcoop] mod-init
[couchcoop] harmony-probe-enter
[couchcoop] harmony-probe-complete result=ok
[couchcoop] live-host-runtime result=supported
[ERROR] [couchcoop] live-host-runtime result=unsupported reason=outside-game-process
[ERROR] [couchcoop] live-host-runtime result=unsupported reason=non-live-build
[ERROR] [couchcoop] live-host-runtime result=unsupported reason=not-live-adapter
[ERROR] [couchcoop] live-host-runtime result=unsupported reason=unreported
[ERROR] [couchcoop] live-host-runtime result=unsupported reason=unknown
[couchcoop] lobby-patch-attempt phase=initial pending=2 total=2
[couchcoop] lobby-patch-attempt phase=retry pending=0 total=2
[couchcoop] lobby-patch-complete targets=2 total=2
[couchcoop] lobby-patch-incomplete targets=1 total=2 retry=pending
[ERROR] [couchcoop] lobby-patch-incomplete targets=0 total=2 retry=exhausted
[couchcoop] host-browser-listener result=available
[ERROR] [couchcoop] host-browser-listener result=unavailable
[couchcoop] lobby-controller-armed
[couchcoop] lobby-screen-mounted kind=character-select
[couchcoop] lobby-screen-mounted kind=load-game
[couchcoop] host-lobby-evaluated kind=character-select result=host
[couchcoop] host-lobby-evaluated kind=load-game result=not-host
[couchcoop] host-lobby-evaluated kind=load-game result=unavailable
[couchcoop] qr-panel-install-enter kind=character-select
[couchcoop] qr-panel-install-complete kind=character-select
[ERROR] [couchcoop] qr-panel-install-failed kind=load-game category=attach
junk [couchcoop] lobby-controller-armed
[couchcoop] lobby-controller-armed suffix=leak
[couchcoop] host-browser-listener result=available url=http://secret.invalid:13337/path
[couchcoop] lobby-screen-mounted kind=character-select path=/Users/secret
[couchcoop] host-lobby-evaluated kind=load-game result=host port=13337
[couchcoop] qr-panel-install-failed kind=load-game category=attach name=secret
[couchcoop] qr-panel-install-failed kind=load-game category=attach stack=trace
[couchcoop] host-browser-listener result=maybe
[couchcoop] lobby-screen-mounted kind=other
[couchcoop] qr-panel-install-failed kind=load-game category=unknown
[couchcoop] lobby-patch-attempt phase=initial pending=1 total=2
[couchcoop] live-host-runtime result=unsupported reason=/Users/secret
[couchcoop] live-host-runtime result=unsupported reason=maybe
[couchcoop] live-host-runtime result=unsupported reason=placeholder
[couchcoop] live-host-runtime result=supported suffix=leak
EOF

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
while IFS= read -r expected; do
  grep -Fx "$expected" <<< "$output" >/dev/null || { echo "missing approved checkpoint: $expected" >&2; exit 1; }
done <<'EOF'
[couchcoop] loader-entry
[couchcoop] harmony-probe-complete result=ok
[couchcoop] live-host-runtime result=supported
[ERROR] [couchcoop] live-host-runtime result=unsupported reason=outside-game-process
[ERROR] [couchcoop] live-host-runtime result=unsupported reason=non-live-build
[ERROR] [couchcoop] live-host-runtime result=unsupported reason=not-live-adapter
[ERROR] [couchcoop] live-host-runtime result=unsupported reason=unreported
[ERROR] [couchcoop] live-host-runtime result=unsupported reason=unknown
[couchcoop] lobby-patch-attempt phase=initial pending=2 total=2
[couchcoop] lobby-patch-complete targets=2 total=2
[ERROR] [couchcoop] lobby-patch-incomplete targets=0 total=2 retry=exhausted
[couchcoop] lobby-screen-mounted kind=character-select
[ERROR] [couchcoop] qr-panel-install-failed kind=load-game category=attach
EOF
while IFS= read -r rejected; do
  ! grep -F "$rejected" <<< "$output" >/dev/null || { echo "accepted malicious checkpoint: $rejected" >&2; exit 1; }
done <<'EOF'
junk [couchcoop] lobby-controller-armed
[couchcoop] lobby-controller-armed suffix=leak
url=http://secret.invalid:13337/path
path=/Users/secret
port=13337
name=secret
stack=trace
result=maybe
kind=other
category=unknown
lobby-patch-attempt phase=initial pending=1 total=2
reason=/Users/secret
reason=maybe
reason=placeholder
[couchcoop] live-host-runtime result=supported suffix=leak
EOF
! grep -F "$fixture" <<< "$output" >/dev/null || { echo "support output leaked a fixture path" >&2; exit 1; }
echo "test-macos-support-diagnostics: ok"
