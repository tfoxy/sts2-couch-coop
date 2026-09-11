#!/usr/bin/env bash
# bench-mirror-replay.mjs against the PHONE's Chrome, over adb.
#
# The desktop leg of this bench runs headless Chromium on SwiftShader, which prices GPU work as CPU and is
# therefore blind to the suspects that only exist on a device (fill/blend, particle re-sim, the multi-canvas
# architecture). This wrapper is the honest leg: it attaches to the phone's OWN Chrome via `--connect-cdp`, so
# every number comes off the real GPU, the real panel (90Hz on the round's Moto G86 — the frame-gap metric
# DETECTS the period rather than assuming 16.7ms) and the real thermal envelope.
#
# BEFORE RUNNING:
#   1. Unlock the phone and leave the screen on (a locked screen kills adb's connection mid-run — see the
#      device-profiling notes; this script refuses to start on a locked screen rather than produce a run that
#      measures a black display).
#   2. Open Chrome on the phone and FOREGROUND the tab this bench should drive. Connect mode reuses the first
#      context's first page on purpose: a tab it opened itself would be a BACKGROUND tab, and Android throttles
#      those to no animation frames at all.
#   3. Have the dev server up on the host at $DEV_PORT, started dead-proxy while a live host is running:
#        cd frontend && COUCHCOOP_DEV_PROXY_TARGET=http://127.0.0.1:9 npm run dev -- --port 5173
#
# The phone reaches BOTH host servers (the dev server and the bench's own recording/asset server) at
# 127.0.0.1 through `adb reverse` — never over the LAN, and never at the live host's port. The reverses and the
# forward are removed by the EXIT trap whichever way this script ends; `adb forward --list` and
# `adb reverse --list` must come back EMPTY afterwards.
#
# Usage:
#   scripts/bench-phone.sh --recording .sts2/bench/synth/flight-n30-shuffle-abcd1234.ndjson --window auto \
#                          --repeats 3 --effects=on --query 'trailMassStrokes=2'
#   ADB_SERIAL=XXXX DEV_PORT=5212 scripts/bench-phone.sh --recording ... --window auto
#
# Env overrides: ADB_SERIAL (default ZY32LL2X8W), DEV_PORT (5173), SERVE_PORT (8123), CDP_PORT (9222).

set -euo pipefail

ADB_SERIAL="${ADB_SERIAL:-ZY32LL2X8W}"
DEV_PORT="${DEV_PORT:-5173}"
SERVE_PORT="${SERVE_PORT:-8123}"
CDP_PORT="${CDP_PORT:-9222}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/android-webview-lib.sh"
require_live_lock
require_live_resource "exclusive:browser:${CDP_PORT}"

# LOCKSCREEN CHECK FIRST — before any forward is installed, so a refusal leaves the device exactly as it was.
# A locked phone still answers adb and still exposes the DevTools socket, so without this check the run would
# proceed and report a page that was never composited.
lock_state="$(adb -s "$ADB_SERIAL" shell dumpsys window 2>/dev/null | grep -o 'mDreamingLockscreen=[a-z]*' | head -1 || true)"
if [ -z "$lock_state" ]; then
  echo "bench-phone: could not read the lock state from '$ADB_SERIAL' (is the device connected and authorized?)" >&2
  echo "             adb devices:" >&2
  adb devices >&2 || true
  exit 2
fi
if [ "$lock_state" != "mDreamingLockscreen=false" ]; then
  echo "bench-phone: the phone is LOCKED ($lock_state)." >&2
  echo "             Unlock it, keep the screen on, foreground the Chrome tab, then re-run." >&2
  exit 2
fi

cleanup() {
  # ALWAYS remove all three. A forward left behind silently captures the next session's port, and a stale
  # reverse points the phone at whatever binds that host port next — including, at the wrong moment, the live
  # game host. Each is best-effort: teardown must not fail the run's exit code.
  adb -s "$ADB_SERIAL" forward --remove "tcp:$CDP_PORT" >/dev/null 2>&1 || true
  adb -s "$ADB_SERIAL" reverse --remove "tcp:$DEV_PORT" >/dev/null 2>&1 || true
  adb -s "$ADB_SERIAL" reverse --remove "tcp:$SERVE_PORT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The BROWSER-level DevTools endpoint. Chrome 151 broke the per-tab CDP endpoint; connectOverCDP speaks this one.
adb -s "$ADB_SERIAL" forward "tcp:$CDP_PORT" localabstract:chrome_devtools_remote >/dev/null
# The two host servers the PAGE has to reach, both as 127.0.0.1 from the phone's point of view: the dev server
# that serves the code under test, and this bench's own recording/asset server.
adb -s "$ADB_SERIAL" reverse "tcp:$DEV_PORT" "tcp:$DEV_PORT" >/dev/null
adb -s "$ADB_SERIAL" reverse "tcp:$SERVE_PORT" "tcp:$SERVE_PORT" >/dev/null

echo "bench-phone: $ADB_SERIAL   cdp 127.0.0.1:$CDP_PORT   dev 127.0.0.1:$DEV_PORT   serve 127.0.0.1:$SERVE_PORT"
echo "bench-phone: driving the FOREGROUNDED tab; forwards/reverses are removed on exit"

# NOT `exec`: exec replaces the shell, and a replaced shell never runs its EXIT trap — the forwards would
# outlive every run. Run node as a child and propagate its exit code; the trap then fires on every path.
node "$SCRIPT_DIR/bench-mirror-replay.mjs" \
  --connect-cdp "http://127.0.0.1:$CDP_PORT" \
  --serve-port "$SERVE_PORT" \
  --url "http://127.0.0.1:$DEV_PORT" \
  "$@"
