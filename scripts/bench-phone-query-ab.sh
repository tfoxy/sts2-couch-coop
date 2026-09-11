#!/usr/bin/env bash
# bench-phone-query-ab.sh — device-GPU named-query ABBA runner.
#
# Each recording is A,B,B,A.  The result must be read as raw frame-gap p50/p95: Android can switch this
# panel between refresh rates, so a derived dropped-frame percentage is not an admissible A/B headline.
# Every cell gets a new Android-intent Chrome tab.  CDP Page.bringToFront and visibilityState are known lies on
# Android; phone-bench-tab.mjs proves scheduling by counting rAFs instead.

set -uo pipefail

ADB_SERIAL="${ADB_SERIAL:-ZY32LL2X8W}"
DEV_PORT="${DEV_PORT:-5190}"
SERVE_PORT="${SERVE_PORT:-8123}"
CDP_PORT="${CDP_PORT:-9222}"
REPEATS="${REPEATS:-1}"
EFFECTS="${EFFECTS:-on}"
EFFECT_MODE="${EFFECT_MODE:-static}"
QUALITY="${QUALITY:-static}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$REPO_ROOT/.sts2/bench/query-ab"
RECORDINGS=""
BEFORE_NAME="dom"
AFTER_NAME="canvas"
BEFORE_QUERY="stage=dom"
AFTER_QUERY="stage=canvas"
WINDOW=""

usage() {
  cat <<'EOF'
Usage: scripts/bench-phone-query-ab.sh --recordings <a.ndjson,b.ndjson> [options]

Runs each recording in ABBA order: before, after, after, before.  The before/after names and query
strings are arbitrary, so this runner works for any named-query comparison on one checkout/dev server.

  --recordings <paths>     required comma-separated, byte-identical workload(s)
  --before-name <name>     default dom
  --after-name <name>      default canvas
  --before-query <query>   default stage=dom
  --after-query <query>    default stage=canvas
  --window <a:b|auto>      pass the identical recorded-clock bracket to every cell
  --out-dir <dir>          default .sts2/bench/query-ab

Environment: ADB_SERIAL DEV_PORT SERVE_PORT CDP_PORT REPEATS EFFECTS EFFECT_MODE QUALITY.
Every cell leaves .log, .json, .procs, .meminfo, .lmk, .gpulog, .png and foreground checks.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --recordings) RECORDINGS="$2"; shift 2 ;;
    --before-name) BEFORE_NAME="$2"; shift 2 ;;
    --after-name) AFTER_NAME="$2"; shift 2 ;;
    --before-query) BEFORE_QUERY="${2#\?}"; shift 2 ;;
    --after-query) AFTER_QUERY="${2#\?}"; shift 2 ;;
    --window) WINDOW="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "bench-phone-query-ab: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$RECORDINGS" ]; then
  echo "bench-phone-query-ab: --recordings is required" >&2
  exit 2
fi
if [ -z "$BEFORE_NAME" ] || [ -z "$AFTER_NAME" ] || [ "$BEFORE_NAME" = "$AFTER_NAME" ] || [ -z "$BEFORE_QUERY" ] || [ -z "$AFTER_QUERY" ]; then
  echo "bench-phone-query-ab: arm names must be distinct and names/queries must be non-empty" >&2
  exit 2
fi
if [ -n "$WINDOW" ] && ! [[ "$WINDOW" =~ ^([0-9]+:[0-9]+|auto)$ ]]; then
  echo "bench-phone-query-ab: --window must be <startMs>:<endMs> or auto" >&2
  exit 2
fi
source "$SCRIPT_DIR/android-webview-lib.sh"
require_live_lock
require_live_resource "exclusive:browser:${CDP_PORT}"
mkdir -p "$OUT_DIR"

# Refuse before installing anything.  adb/CDP can still answer while the display is locked, which would create
# a convincing trace for a screen that did not composite.
lock_state="$(adb -s "$ADB_SERIAL" shell dumpsys window 2>/dev/null | grep -o 'mDreamingLockscreen=[a-z]*' | head -1 || true)"
if [ "$lock_state" != "mDreamingLockscreen=false" ]; then
  echo "bench-phone-query-ab: phone is locked or unreadable ($lock_state); unlock before measuring" >&2
  exit 2
fi

# --res-root only serves the bench helper server.  The page's own assets still come from the dev origin, so make
# that origin prove /res now.  A 404 here is the blank-page failure mode, never a zero-work result.
res_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$DEV_PORT/res/project.godot" || true)"
if [ "$res_code" != "200" ]; then
  echo "bench-phone-query-ab: /res preflight failed ($res_code) at http://127.0.0.1:$DEV_PORT; refusing blank-page bench" >&2
  exit 2
fi

forward_added=0
reverse_dev_added=0
reverse_serve_added=0
has_forward() { adb -s "$ADB_SERIAL" forward --list 2>/dev/null | grep -Fq "$ADB_SERIAL tcp:$CDP_PORT localabstract:chrome_devtools_remote"; }
has_reverse() { adb -s "$ADB_SERIAL" reverse --list 2>/dev/null | grep -Fq "tcp:$1 tcp:$1"; }

install_tunnels() {
  if ! has_forward; then adb -s "$ADB_SERIAL" forward "tcp:$CDP_PORT" localabstract:chrome_devtools_remote >/dev/null || return 1; forward_added=1; fi
  if ! has_reverse "$DEV_PORT"; then adb -s "$ADB_SERIAL" reverse "tcp:$DEV_PORT" "tcp:$DEV_PORT" >/dev/null || return 1; reverse_dev_added=1; fi
  if ! has_reverse "$SERVE_PORT"; then adb -s "$ADB_SERIAL" reverse "tcp:$SERVE_PORT" "tcp:$SERVE_PORT" >/dev/null || return 1; reverse_serve_added=1; fi
}
cleanup() {
  # Delete only mappings this invocation created; never damage an operator's unrelated adb tunnel.
  [ "$forward_added" = 1 ] && adb -s "$ADB_SERIAL" forward --remove "tcp:$CDP_PORT" >/dev/null 2>&1 || true
  [ "$reverse_dev_added" = 1 ] && adb -s "$ADB_SERIAL" reverse --remove "tcp:$DEV_PORT" >/dev/null 2>&1 || true
  [ "$reverse_serve_added" = 1 ] && adb -s "$ADB_SERIAL" reverse --remove "tcp:$SERVE_PORT" >/dev/null 2>&1 || true
}
# EXIT does cleanup exactly once in the normal path.  The explicit signal handlers convert an interrupted matrix
# into the conventional non-zero status instead of returning from the trap and silently continuing to cell 2.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! install_tunnels; then
  echo "bench-phone-query-ab: could not install CDP/dev/serve adb tunnels" >&2
  exit 2
fi
echo "bench-phone-query-ab: /res=200; ${BEFORE_NAME}=${BEFORE_QUERY}; ${AFTER_NAME}=${AFTER_QUERY}; window=${WINDOW:-whole recording}"

IFS=',' read -r -a REC_ARR <<< "$RECORDINGS"
ARMS=("$BEFORE_NAME" "$AFTER_NAME" "$AFTER_NAME" "$BEFORE_NAME")
cell_failed=0

capture_cell_artifacts() {
  local label="$1" cell_t0="$2"
  # Per-cell and time-bounded: never re-label a low-memory kill from a previous arm as this arm's failure.
  adb -s "$ADB_SERIAL" shell ps -A -o PID,RSS,NAME 2>/dev/null | grep -i 'com.android.chrome' > "$OUT_DIR/${label}.procs" || true
  adb -s "$ADB_SERIAL" shell dumpsys meminfo com.android.chrome 2>/dev/null | grep -E 'TOTAL (PSS|RSS)' | head -2 > "$OUT_DIR/${label}.meminfo" || true
  adb -s "$ADB_SERIAL" logcat -d -t "$cell_t0" -s lowmemorykiller 2>/dev/null > "$OUT_DIR/${label}.lmk" || true
  adb -s "$ADB_SERIAL" logcat -d -t "$cell_t0" 2>/dev/null | grep -Ei 'gpu process|GpuProcessHost|lost the GPU|context lost' > "$OUT_DIR/${label}.gpulog" || true
  adb -s "$ADB_SERIAL" exec-out screencap -p > "$OUT_DIR/${label}.png" 2>/dev/null || true
}

for rec in "${REC_ARR[@]}"; do
  stem="$(basename "$rec" .ndjson)"
  pos=0
  for arm in "${ARMS[@]}"; do
    pos=$((pos + 1))
    query="$BEFORE_QUERY"; [ "$arm" = "$AFTER_NAME" ] && query="$AFTER_QUERY"
    label="${stem}__${pos}-${arm}"
    log="$OUT_DIR/${label}.log"
    echo "\n=== $label  query=$query  window=${WINDOW:-whole} ==="

    # Reassert after any unrelated Android interruption.  The tab tool sweeps only this origin before attaching,
    # avoiding the one stale mirror tab that can wedge browser-wide connectOverCDP.
    if ! install_tunnels; then echo "tunnel failure" | tee "$log"; cell_failed=1; continue; fi
    cell_t0="$(adb -s "$ADB_SERIAL" shell date '+%m-%d %H:%M:%S.000' 2>/dev/null | tr -d '\r')"
    adb -s "$ADB_SERIAL" shell am force-stop com.motorola.ccc.ota 2>/dev/null || true
    if ! node "$SCRIPT_DIR/phone-bench-tab.mjs" open --url "http://127.0.0.1:$DEV_PORT/" --serial "$ADB_SERIAL" --cdp-port "$CDP_PORT" >"$OUT_DIR/${label}.foreground-before" 2>&1; then
      cat "$OUT_DIR/${label}.foreground-before" | tee "$log"
      echo "SKIPPED: fresh Android-intent tab was not foreground/scheduled" >> "$log"
      printf '{"status":"skipped","reason":"foreground-before-failed"}\n' > "$OUT_DIR/${label}.json"
      capture_cell_artifacts "$label" "$cell_t0"
      cell_failed=1
      continue
    fi

    effect_args=(--effect-mode "$EFFECT_MODE")
    [ "$EFFECTS" = off ] && effect_args=(--effects off)
    window_args=()
    [ -n "$WINDOW" ] && window_args=(--window "$WINDOW")
    node "$SCRIPT_DIR/bench-mirror-replay.mjs" \
      --connect-cdp "http://127.0.0.1:$CDP_PORT" --serve-port "$SERVE_PORT" --url "http://127.0.0.1:$DEV_PORT" \
      --recording "$rec" --pace recorded --quality "$QUALITY" "${effect_args[@]}" --repeats "$REPEATS" \
      --census --res-root --query "$query" "${window_args[@]}" 2>&1 | tee "$log"
    bench_status=${PIPESTATUS[0]}
    grep -h '^BENCH_RESULT ' "$log" | tail -1 > "$OUT_DIR/${label}.json" || true

    capture_cell_artifacts "$label" "$cell_t0"
    if ! node "$SCRIPT_DIR/phone-bench-tab.mjs" verify --url-prefix "http://127.0.0.1:$DEV_PORT" --serial "$ADB_SERIAL" --cdp-port "$CDP_PORT" >"$OUT_DIR/${label}.foreground-after" 2>&1; then
      echo "WARN: Android foreground check failed after measured cell" >> "$log"
      cell_failed=1
    fi
    [ "$bench_status" -eq 0 ] || { echo "bench exited $bench_status" >> "$log"; cell_failed=1; }
  done
done

echo "all cells written to $OUT_DIR"
exit "$cell_failed"
