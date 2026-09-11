#!/usr/bin/env bash
# bench-godot-android.sh — adb measurement wrapper for the native Godot client app on a real Android device.
#
#   scripts/bench-godot-android.sh <package> <duration-s> [--battery] [--serial <adb-serial>]
#   scripts/bench-godot-android.sh org.godotengine.couchcoopclient 30
#
# REQUIRES A CONNECTED DEVICE + adb. This script does NOT launch the app — connect the native client to its host
# (or scripts/replay-ws-server.mjs) FIRST, THEN run this to sample it. It:
#   1. resets gfxinfo + (optional) batterystats + clears logcat
#   2. samples top -H per-thread CPU every second for <duration-s>, and dumpsys cpuinfo before/after
#   3. captures dumpsys gfxinfo framestats (jank + frame-time percentiles) after the window
#   4. captures dumpsys meminfo PSS, and (optional) batterystats --charged
#   5. scrapes the app's `BENCH_RESULT {json}` line out of logcat when emitted by the client
#   6. emits ONE merged JSON object to stdout (all adb-side + in-app numbers), plus progress on stderr
#
# Output JSON is designed to be piped to jq / stored alongside the desktop bench numbers. No device work here
# is destructive beyond a batterystats reset (opt-in via --battery).

set -u

# --------------------------------------------------------------------------------------------------
# args
# --------------------------------------------------------------------------------------------------

PKG=""
DURATION=""
DO_BATTERY=0
SERIAL=""

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    --battery) DO_BATTERY=1; shift ;;
    --serial) SERIAL="${2:-}"; shift 2 ;;
    -h|--help) usage 0 ;;
    -*) echo "unknown option: $1" >&2; usage 2 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
set -- "${POSITIONAL[@]:-}"
PKG="${1:-}"
DURATION="${2:-}"

if [ -z "$PKG" ] || [ -z "$DURATION" ]; then
  echo "usage: $0 <package> <duration-s> [--battery] [--serial <adb-serial>]" >&2
  exit 2
fi
if ! [[ "$DURATION" =~ ^[0-9]+$ ]] || [ "$DURATION" -le 0 ]; then
  echo "duration must be a positive integer (seconds), got '$DURATION'" >&2
  exit 2
fi

# --------------------------------------------------------------------------------------------------
# adb helpers
# --------------------------------------------------------------------------------------------------

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found on PATH — install platform-tools" >&2
  exit 3
fi

ADB=(adb)
[ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")

adbsh() { "${ADB[@]}" shell "$@"; }

# Confirm exactly one usable device (unless a serial was pinned).
DEV_COUNT=$(adb devices | awk 'NR>1 && $2=="device" {n++} END{print n+0}')
if [ -z "$SERIAL" ] && [ "$DEV_COUNT" -eq 0 ]; then
  echo "no adb device in 'device' state (adb devices):" >&2
  adb devices >&2
  exit 3
fi

# JSON string escaper (for embedding arbitrary shell strings safely).
json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/}"
  printf '"%s"' "$s"
}

# Extract the first integer following a label in a text blob (e.g. "Total frames rendered: 1234").
num_after() { # <blob> <regex-label>
  printf '%s\n' "$1" | grep -m1 -oiE "$2[^0-9]*[0-9]+" | grep -oE '[0-9]+$' | head -n1
}

echo "bench-godot-android: pkg=$PKG duration=${DURATION}s serial=${SERIAL:-<default>} battery=$DO_BATTERY" >&2

# --------------------------------------------------------------------------------------------------
# resolve pid
# --------------------------------------------------------------------------------------------------

PID=$(adbsh pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')
if [ -z "$PID" ]; then
  # Fallback: scan ps for the package name.
  PID=$(adbsh ps -A 2>/dev/null | tr -d '\r' | awk -v p="$PKG" '$0 ~ p {print $2; exit}')
fi
if [ -z "$PID" ]; then
  echo "could not resolve a running pid for '$PKG' — is the app launched?" >&2
  exit 4
fi
echo "  pid=$PID" >&2

DEVICE_MODEL=$(adbsh getprop ro.product.model 2>/dev/null | tr -d '\r')
ANDROID_REL=$(adbsh getprop ro.build.version.release 2>/dev/null | tr -d '\r')

# --------------------------------------------------------------------------------------------------
# reset counters
# --------------------------------------------------------------------------------------------------

adbsh dumpsys gfxinfo "$PKG" reset >/dev/null 2>&1
if [ "$DO_BATTERY" -eq 1 ]; then
  adbsh dumpsys batterystats --reset >/dev/null 2>&1
fi
"${ADB[@]}" logcat -c >/dev/null 2>&1

CPUINFO_BEFORE=$(adbsh dumpsys cpuinfo 2>/dev/null | tr -d '\r' | grep -E "$PKG|TOTAL:" | head -n8)

# --------------------------------------------------------------------------------------------------
# sample window: top -H per-thread CPU each second
# --------------------------------------------------------------------------------------------------

echo "  sampling top -H for ${DURATION}s..." >&2
TOP_SAMPLES=()  # each entry: aggregate %CPU across the pid's threads at that second
for ((i = 0; i < DURATION; i++)); do
  # top -H -b -n1 filtered to the pid; sum the %CPU column ([%CPU] varies by column index across builds, so
  # match the pid's own rows and sum the first float-looking CPU token). Best-effort; robust to toybox layout.
  SUM=$(adbsh top -H -b -n1 -p "$PID" 2>/dev/null | tr -d '\r' \
        | awk 'NR>1 { for (j=1;j<=NF;j++) if ($j ~ /^[0-9]+(\.[0-9]+)?$/ && $j+0<=100) { s+=$j; break } } END { printf "%.1f", s+0 }')
  TOP_SAMPLES+=("$SUM")
  sleep 1
done

CPUINFO_AFTER=$(adbsh dumpsys cpuinfo 2>/dev/null | tr -d '\r' | grep -E "$PKG|TOTAL:" | head -n8)

# --------------------------------------------------------------------------------------------------
# gfxinfo framestats (jank + percentiles)
# --------------------------------------------------------------------------------------------------

GFX=$(adbsh dumpsys gfxinfo "$PKG" framestats 2>/dev/null | tr -d '\r')
GFX_TOTAL=$(num_after "$GFX" "Total frames rendered:")
GFX_JANKY=$(num_after "$GFX" "Janky frames:")
GFX_P50=$(num_after "$GFX" "50th percentile:")
GFX_P90=$(num_after "$GFX" "90th percentile:")
GFX_P95=$(num_after "$GFX" "95th percentile:")
GFX_P99=$(num_after "$GFX" "99th percentile:")
GFX_MISSED=$(num_after "$GFX" "Number Missed Vsync:")

# --------------------------------------------------------------------------------------------------
# meminfo PSS
# --------------------------------------------------------------------------------------------------

MEM=$(adbsh dumpsys meminfo "$PKG" 2>/dev/null | tr -d '\r')
# "TOTAL PSS:" (newer) or the "TOTAL" row in the pss table (older).
MEM_PSS=$(printf '%s\n' "$MEM" | grep -m1 -iE "TOTAL PSS:" | grep -oE '[0-9]+' | head -n1)
[ -z "$MEM_PSS" ] && MEM_PSS=$(printf '%s\n' "$MEM" | grep -m1 -iE "^[[:space:]]*TOTAL[[:space:]]" | grep -oE '[0-9]+' | head -n1)

# --------------------------------------------------------------------------------------------------
# battery (optional)
# --------------------------------------------------------------------------------------------------

BATT_JSON="null"
if [ "$DO_BATTERY" -eq 1 ]; then
  BATT=$(adbsh dumpsys batterystats --charged "$PKG" 2>/dev/null | tr -d '\r' | head -n 200)
  BATT_UAH=$(printf '%s\n' "$BATT" | grep -m1 -oiE "Computed drain:.*" | head -n1)
  BATT_JSON=$(json_str "${BATT_UAH:-unavailable}")
fi

# --------------------------------------------------------------------------------------------------
# scrape the in-app BENCH_RESULT line from logcat
# --------------------------------------------------------------------------------------------------

# Godot routes GD.Print to logcat (tag "godot"); the client may print `BENCH_RESULT {json}` on quit.
LOG=$("${ADB[@]}" logcat -d 2>/dev/null | tr -d '\r')
BENCH_LINE=$(printf '%s\n' "$LOG" | grep -m1 "BENCH_RESULT " | tail -n1)
BENCH_JSON=$(printf '%s' "$BENCH_LINE" | sed -n 's/.*BENCH_RESULT \({.*}\).*/\1/p')
[ -z "$BENCH_JSON" ] && BENCH_JSON="null"

# --------------------------------------------------------------------------------------------------
# assemble merged JSON
# --------------------------------------------------------------------------------------------------

# top samples -> JSON number array + a simple median.
TOP_ARR=$(printf '%s\n' "${TOP_SAMPLES[@]:-}" | awk 'BEGIN{printf "["} {printf "%s%s", (NR>1?",":""), ($0==""?"0":$0)} END{printf "]"}')
# Median via host `sort -n` (portable — avoids the gawk-only asort).
TOP_MEDIAN=$(printf '%s\n' "${TOP_SAMPLES[@]:-}" | grep -v '^$' | sort -n \
  | awk '{a[NR]=$1} END{if(NR==0){print "null"; exit} print (NR%2? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2)}')
[ -z "$TOP_MEDIAN" ] && TOP_MEDIAN="null"

n_or_null() { [ -n "$1" ] && printf '%s' "$1" || printf 'null'; }

cat <<JSON
{
  "package": $(json_str "$PKG"),
  "pid": $PID,
  "durationSec": $DURATION,
  "device": { "model": $(json_str "${DEVICE_MODEL:-unknown}"), "androidRelease": $(json_str "${ANDROID_REL:-unknown}") },
  "gfxinfo": {
    "totalFrames": $(n_or_null "$GFX_TOTAL"),
    "jankyFrames": $(n_or_null "$GFX_JANKY"),
    "missedVsync": $(n_or_null "$GFX_MISSED"),
    "frameMs": { "p50": $(n_or_null "$GFX_P50"), "p90": $(n_or_null "$GFX_P90"), "p95": $(n_or_null "$GFX_P95"), "p99": $(n_or_null "$GFX_P99") }
  },
  "topHThreadCpuPct": { "perSecond": $TOP_ARR, "median": $(n_or_null "$TOP_MEDIAN") },
  "meminfoTotalPssKb": $(n_or_null "$MEM_PSS"),
  "battery": $BATT_JSON,
  "cpuinfo": { "before": $(json_str "$CPUINFO_BEFORE"), "after": $(json_str "$CPUINFO_AFTER") },
  "benchResult": $BENCH_JSON
}
JSON
