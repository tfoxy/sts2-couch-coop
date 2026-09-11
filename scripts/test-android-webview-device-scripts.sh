#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/adb-state"
lock_env=(COUCHCOOP_LIVEQA_LEASE_ROOT="$tmp/leases" COUCHCOOP_LIVEQA_REGISTRY_GUARD="$tmp/guard")
env "${lock_env[@]}" node "$repo_root/scripts/live-qa-lock.mjs" acquire --owner mali-sep05-root --pid "$$" \
  --resource shared:install --resource exclusive:android:serial-42 --resource exclusive:browser:9222 >/dev/null
log="$tmp/adb.log"
cat > "$tmp/bin/adb" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_ADB_LOG"
[[ "$1" == '-s' && "$2" == 'serial-42' ]]
shift 2
case "$1 ${2:-}" in
  'reverse --list') [[ -f "$MOCK_ADB_STATE/reverse" ]] && cat "$MOCK_ADB_STATE/reverse" ;;
  'forward --list') [[ -f "$MOCK_ADB_STATE/forward" ]] && cat "$MOCK_ADB_STATE/forward" ;;
  'reverse --no-rebind')
    [[ ! -e "$MOCK_ADB_STATE/reverse" ]] || exit 1
    printf '%s %s %s\n' 'UsbFfs' "$3" "$4" > "$MOCK_ADB_STATE/reverse"
    ;;
  'forward --no-rebind')
    [[ ! -e "$MOCK_ADB_STATE/forward" ]] || exit 1
    printf '%s %s %s\n' 'serial-42' "$3" "$4" > "$MOCK_ADB_STATE/forward"
    ;;
  'reverse --remove') rm -f "$MOCK_ADB_STATE/reverse" ;;
  'forward --remove') rm -f "$MOCK_ADB_STATE/forward" ;;
  'shell pidof')
    count_file="$MOCK_ADB_STATE/pidof-count"; count=0
    [[ -f "$count_file" ]] && count="$(cat "$count_file")"
    count=$((count + 1)); printf '%s' "$count" > "$count_file"
    [[ "$count" -gt "${MOCK_PID_DELAY:-0}" ]] && echo 4321
    ;;
  'logcat --pid')
    run="$(sed -n "s/.*RUN_ID' '\([^']*\)'.*/\1/p" "$MOCK_ADB_LOG" | tail -1)"
    case "${MOCK_READY:-yes}" in
      yes) echo "ready pageCommitVisible run=${run} url=${MOCK_READY_URL}" ;;
      stale) echo "ready pageCommitVisible run=old url=${MOCK_READY_URL}"; echo "loading run=${run} url=${MOCK_READY_URL}" ;;
    esac ;;
esac
EOF
chmod +x "$tmp/bin/adb"
url="http://127.0.0.1:13400/?a=1&label=O'Brien"
env_base=(PATH="$tmp/bin:$PATH" MOCK_ADB_LOG="$log" MOCK_ADB_STATE="$tmp/adb-state" MOCK_READY_URL="$url" ADB_SERIAL=serial-42 COUCHCOOP_LIVEQA_OWNER=mali-sep05-root COUCHCOOP_LIVEQA_PID="$$" "${lock_env[@]}" COUCHCOOP_ANDROID_WEBVIEW_STATE_DIR="$tmp/state")
geometry=(--content-width-px 2452 --content-height-px 980 --content-left-px 125 --content-top-px 79 --density-dpi 558)
env "${env_base[@]}" bash "$repo_root/scripts/android-webview-launch.sh" "${geometry[@]}" "$url"
rg -q -- '-s serial-42 reverse --no-rebind tcp:13400 tcp:13400' "$log"
rg -q -- '-s serial-42 forward --no-rebind tcp:9222 localabstract:webview_devtools_remote_4321' "$log"
rg -Fq -- "--es 'coop.couch.webview.URL' 'http://127.0.0.1:13400/?a=1&label=O'\\''Brien'" "$log"
rg -Fq -- "--ei 'coop.couch.webview.CONTENT_WIDTH_PX' '2452'" "$log"
rg -Fq -- 'am start -f 0x20000000 -n' "$log"

# Cold launches can make am start return before pidof sees the wrapper.
rm -f "$tmp/adb-state/pidof-count"
env "${env_base[@]}" MOCK_PID_DELAY=2 PID_READY_ATTEMPTS=3 PID_READY_DELAY_SECONDS=0 bash "$repo_root/scripts/android-webview-launch.sh" "$url"
[[ "$(cat "$tmp/adb-state/pidof-count")" = 3 ]]

# A repeat launch reuses the matching mappings created by this lock session.
env "${env_base[@]}" bash "$repo_root/scripts/android-webview-launch.sh" "$url"
[[ "$(rg -c -- '-s serial-42 reverse --no-rebind tcp:13400 tcp:13400' "$log")" -eq 1 ]]
[[ "$(rg -c -- '-s serial-42 forward --no-rebind tcp:9222 localabstract:webview_devtools_remote_4321' "$log")" -eq 1 ]]
env "${env_base[@]}" bash "$repo_root/scripts/android-webview-cleanup.sh"
rg -q -- '-s serial-42 reverse --remove tcp:13400' "$log"
rg -q -- '-s serial-42 forward --remove tcp:9222' "$log"
# A recycled PID with a matching-looking pid file must not kill this test process:
# cleanup also verifies the calibrator command line and its --pid-file argument.
state_dir="$tmp/state/serial-42/$$"
printf '%s\n' "$$" > "$tmp/reused-calibrator.pid"
printf '%s\t%s\n' "$$" "$tmp/reused-calibrator.pid" > "$state_dir/calibrators"
env "${env_base[@]}" bash "$repo_root/scripts/android-webview-cleanup.sh"
kill -0 "$$"
cat > "$tmp/android-webview-cdp-calibrate.mjs" <<'EOF'
setInterval(() => {}, 1000);
EOF
node "$tmp/android-webview-cdp-calibrate.mjs" --pid-file "$tmp/live-calibrator.pid" &
live_calibrator=$!
printf '%s\n' "$live_calibrator" > "$tmp/live-calibrator.pid"
env "${env_base[@]}" bash -c 'source "$1/scripts/android-webview-lib.sh"; record_calibrator "$2" "$3"' _ "$repo_root" "$live_calibrator" "$tmp/live-calibrator.pid"
[[ "$(cat "$state_dir/calibrators")" == "$(printf '%s\t%s' "$live_calibrator" "$tmp/live-calibrator.pid")" ]]
env "${env_base[@]}" bash "$repo_root/scripts/android-webview-cleanup.sh"
if wait "$live_calibrator"; then exit 1; fi
! kill -0 "$live_calibrator" 2>/dev/null

if env "${env_base[@]}" bash "$repo_root/scripts/android-webview-launch.sh" http://example.test/; then exit 1; fi
if env "${env_base[@]}" bash "$repo_root/scripts/android-webview-launch.sh" --content-width-px 2452 "$url"; then exit 1; fi

# A foreign tunnel is never overwritten, including a replacement on the same port
# or an entry owned by another device serial.
env "${env_base[@]}" bash "$repo_root/scripts/android-webview-launch.sh" "$url"
: > "$log"
printf 'serial-42 tcp:9222 localabstract:replacement\n' > "$tmp/adb-state/forward"
if env "${env_base[@]}" bash "$repo_root/scripts/android-webview-launch.sh" "$url"; then exit 1; fi
! rg -q -- 'forward --remove tcp:9222' "$log"
[[ "$(cat "$tmp/adb-state/forward")" == 'serial-42 tcp:9222 localabstract:replacement' ]]
# Cleanup verifies the ledger's target again and keeps a foreign replacement.
env "${env_base[@]}" bash "$repo_root/scripts/android-webview-cleanup.sh"
[[ "$(cat "$tmp/adb-state/forward")" == 'serial-42 tcp:9222 localabstract:replacement' ]]
rm -f "$tmp/adb-state/forward"
: > "$log"
printf 'UsbFfs tcp:13400 tcp:13400\n' > "$tmp/adb-state/reverse"
if env "${env_base[@]}" bash "$repo_root/scripts/android-webview-launch.sh" "$url"; then exit 1; fi
! rg -q -- 'reverse tcp:13400 tcp:13400' "$log"
rm -f "$tmp/adb-state/reverse"
: > "$log"
printf 'serial-42 tcp:9222 localabstract:foreign\n' > "$tmp/adb-state/forward"
if env "${env_base[@]}" bash "$repo_root/scripts/android-webview-launch.sh" "$url"; then exit 1; fi
! rg -q -- 'forward --remove tcp:9222' "$log"
[[ "$(cat "$tmp/adb-state/forward")" == 'serial-42 tcp:9222 localabstract:foreign' ]]
rm -f "$tmp/adb-state/forward"
: > "$log"
printf 'other-device tcp:9222 localabstract:webview_devtools_remote_4321\n' > "$tmp/adb-state/forward"
if env "${env_base[@]}" bash "$repo_root/scripts/android-webview-launch.sh" "$url"; then exit 1; fi
! rg -q -- 'forward --remove tcp:9222' "$log"
[[ "$(cat "$tmp/adb-state/forward")" == 'other-device tcp:9222 localabstract:webview_devtools_remote_4321' ]]
rm -f "$tmp/adb-state/forward"
: > "$log"
if env "${env_base[@]}" MOCK_READY=no READY_ATTEMPTS=1 bash "$repo_root/scripts/android-webview-launch.sh" "$url"; then exit 1; fi
rg -q -- '-s serial-42 forward --remove tcp:9222' "$log"
rg -q -- '-s serial-42 reverse --remove tcp:13400' "$log"
if env "${env_base[@]}" MOCK_READY=stale READY_ATTEMPTS=1 bash "$repo_root/scripts/android-webview-launch.sh" "$url"; then exit 1; fi
# Missing pidof output must fail after the bounded polling interval and leave no
# newly-created tunnels behind.
rm -f "$tmp/adb-state/forward" "$tmp/adb-state/reverse" "$tmp/adb-state/pidof-count"
: > "$log"
if missing_output="$(env "${env_base[@]}" MOCK_PID_DELAY=99 PID_READY_ATTEMPTS=2 PID_READY_DELAY_SECONDS=0 bash "$repo_root/scripts/android-webview-launch.sh" "$url" 2>&1)"; then exit 1; fi
grep -Fq 'did not appear after 2 pidof attempts' <<< "$missing_output"
! test -e "$tmp/adb-state/forward"
! test -e "$tmp/adb-state/reverse"
echo 'android webview device-script mock checks passed'
