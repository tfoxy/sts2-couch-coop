#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
marker="$tmp/profile-term"
cat > "$tmp/bin/mise" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == 'run android-webview-profile' ]]
trap 'printf terminated > "$MOCK_PROFILE_MARKER"; exit 0' TERM
while :; do sleep 1 & wait "$!"; done
EOF
chmod +x "$tmp/bin/mise"

# `setsid` gives this harness an owned process group. The exact TERM used by
# bench-phone-canvas-ab.sh must reach the profile task, not merely its launcher.
PATH="$tmp/bin:$PATH" MOCK_PROFILE_MARKER="$marker" setsid env mise run android-webview-profile >/dev/null 2>&1 &
profile_pid=$!
sleep 0.1
kill -TERM -- "-$profile_pid"
wait "$profile_pid" || true
[[ "$(cat "$marker")" == terminated ]]

runner="$(cat "$root/scripts/bench-phone-canvas-ab.sh")"
[[ "$runner" == *'setsid env STREAMLINE_COUNTERS_FILE='* ]]
[[ "$runner" == *'kill -TERM -- "-$profile_pid"'* ]]
[[ "$runner" == *'analyze-mali-capture.mjs" "$profile_apc" "$profile_timeline" "$trace" "$phase" "$metrics"'* ]]
echo 'bench phone Mali profile process-group checks passed'
