#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"; printf 'MaliFrag,GPU_ACTIVE\n' > "$tmp/counters"
lock_env=(COUCHCOOP_LIVEQA_LEASE_ROOT="$tmp/leases" COUCHCOOP_LIVEQA_REGISTRY_GUARD="$tmp/guard")
env "${lock_env[@]}" node "$root/scripts/live-qa-lock.mjs" acquire --owner owner --pid "$$" \
  --resource shared:install --resource exclusive:android:s >/dev/null
cat > "$tmp/bin/adb" <<'EOF'
#!/usr/bin/env bash
shift 2
case "$1 ${2:-}" in
 'shell pidof') echo 321 ;;
 'shell getprop') echo 1 ;;
 'exec-out run-as') capture="${!#}"; target="$(dirname "$MOCK_CAPTURE")/$capture"; mkdir -p "$target"; printf capture > "$target/captured.xml"; : > "$target/0000000000"; tar -czf - -C "$(dirname "$target")" "$(basename "$target")" ;;
esac
EOF
cat > "$tmp/bin/streamline" <<'EOF'
#!/usr/bin/env bash
count=0
if [ -n "${MOCK_STATE:-}" ] && [ -f "$MOCK_STATE" ]; then count="$(cat "$MOCK_STATE")"; fi
count=$((count + 1)); [ -z "${MOCK_STATE:-}" ] || printf '%s' "$count" > "$MOCK_STATE"
case "${MOCK_TIMELINE_MODE:-good}" in
  footer) printf 'INFO preamble\nIndex (s),Mali GPU_ACTIVE\n1.000,2\n1.001,3\n# JVM crash footer\n' ;;
  retry) if [ "$count" = 1 ]; then printf 'Index (s),Mali GPU_ACTIVE\n1.000,2\n1.001,3\n# JVM crash footer\n'; else printf 'Index (s),Mali GPU_ACTIVE\n1.000,2\n1.001,3\n'; fi ;;
  *) printf 'INFO preamble\nIndex (s),Mali GPU_ACTIVE\n1.000,2\n1.001,3\n' ;;
esac
EOF
chmod +x "$tmp/bin/adb" "$tmp/bin/streamline"
env PATH="$tmp/bin:$PATH" MOCK_CAPTURE="$tmp/cc-webview-$$.apc" ADB_SERIAL=s COUCHCOOP_LIVEQA_OWNER=owner COUCHCOOP_LIVEQA_PID="$$" "${lock_env[@]}" STREAMLINE_COUNTERS_FILE="$tmp/counters" STREAMLINE_DURATION_SECONDS=5 STREAMLINE_APC_OUT="$tmp/a.apc" bash "$root/scripts/android-webview-profile.sh"
env STREAMLINE_APC_IN="$tmp/a.apc" STREAMLINE_TIMELINE_OUT="$tmp/t.csv" STREAMLINE_CLI="$tmp/bin/streamline" bash "$root/scripts/android-webview-profile-export.sh"
rg -q Mali "$tmp/t.csv"
printf 'existing\n' > "$tmp/existing.csv"
if env STREAMLINE_APC_IN="$tmp/a.apc" STREAMLINE_TIMELINE_OUT="$tmp/existing.csv" STREAMLINE_CLI="$tmp/bin/streamline" bash "$root/scripts/android-webview-profile-export.sh"; then
  echo 'existing output was overwritten' >&2; exit 1
fi
rg -qx existing "$tmp/existing.csv"
printf 0 > "$tmp/footer-state"
if env MOCK_TIMELINE_MODE=footer MOCK_STATE="$tmp/footer-state" STREAMLINE_APC_IN="$tmp/a.apc" STREAMLINE_TIMELINE_OUT="$tmp/footer.csv" STREAMLINE_CLI="$tmp/bin/streamline" bash "$root/scripts/android-webview-profile-export.sh"; then
  echo 'crash footer was published' >&2; exit 1
fi
[ "$(cat "$tmp/footer-state")" = 3 ]
[ ! -e "$tmp/footer.csv" ]
[ "$(find "$tmp" -maxdepth 1 -name '.footer.csv.attempt-*' | wc -l)" = 6 ]
printf 0 > "$tmp/retry-state"
env MOCK_TIMELINE_MODE=retry MOCK_STATE="$tmp/retry-state" STREAMLINE_APC_IN="$tmp/a.apc" STREAMLINE_TIMELINE_OUT="$tmp/retry.csv" STREAMLINE_CLI="$tmp/bin/streamline" bash "$root/scripts/android-webview-profile-export.sh"
[ "$(cat "$tmp/retry-state")" = 2 ]
rg -q '^1\.001,3$' "$tmp/retry.csv"
[ "$(find "$tmp" -maxdepth 1 -name '.retry.csv.attempt-*' | wc -l)" = 4 ]
echo 'android WebView Streamline mock checks passed'
