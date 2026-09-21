#!/usr/bin/env bash
# bench-phone-canvas-ab.sh — the canvas-vs-DOM phone matrix, on the phone's own GPU.
#
# WHY FOUR BALANCED CELLS. A phone is not a stable measuring instrument: it warms up and throttles during a
# session. The required DOM → canvas → canvas → DOM order puts each current implementation at matching
# early/late positions. It is deliberately not configurable: changing this order invalidates the comparison.
#
# WHAT IS COMPARED. RAW frame gaps (p50 / p95), never `droppedPct`. Dropped% is derived by dividing by a
# DETECTED vsync period, and this panel changes refresh rate between 60 and 90Hz on its own (measured this
# round: 90Hz in portrait, 60Hz in landscape) — so the same raw cadence can score very differently in dropped%
# across two cells for reasons that have nothing to do with the renderer.
#
# THE THREE PHONE TRAPS this wraps (all measured, see scripts/phone-bench-tab.mjs):
#   * `bringToFront()` does not foreground an Android tab, so the bench's own tab selection is not enough —
#     the tab is (re)opened by an ANDROID INTENT before each cell and its frame rate is verified.
#   * a background tab gets NO animation frames, and Playwright's rAF-polled waits then hang forever.
#   * `--pace max` deadlocks the bench's credit pump on this leg; the canvas arm must run `--pace recorded`.
#
# Usage:
#   scripts/bench-phone-canvas-ab.sh --out-dir .sts2/bench/canvas-four-cell
#
# Env: ADB_SERIAL (ZY32LL2X8W), DEV_PORT (5190), SERVE_PORT (8123), CDP_PORT (9222), REPEATS (1), EFFECTS (on),
#      EFFECT_MODE (static), QUALITY (static), COUCHCOOP_DEV_BG_FIXTURE and
#      COUCHCOOP_DEV_ASSET_CACHE_ROOT. The latter two are ignored external inputs served by Vite and
#      serve-res-root respectively; they are required and recorded so a canvas result cannot silently use the
#      live fallback or render with missing generated textures. Optional exact URL checks are comma-separated in
#      COUCHCOOP_DEV_ASSET_PREFLIGHT_URLS and COUCHCOOP_DEV_BG_PREFLIGHT_URL.
#
# WHAT EACH CELL LEAVES BEHIND, and why each one exists (round 7 — three of the five are new because round 6's
# device conclusion was reached with instruments pointed at the wrong process):
#   .log      the bench's own output, tee'd live
#   .result.json  parsed BENCH_RESULT, including --census
#   .metrics.json marker-bounded trace metrics consumed by summarize-phone-canvas-bench.mjs
#   .procs    ps -A for every Chrome process, with RSS. THE ONE THAT MATTERS: Android names the GPU process
#             com.android.chrome:privileged_process* and each renderer :sandboxed_process*, which is the
#             currency the lowmemorykiller kill lines are written in. `dumpsys meminfo com.android.chrome`
#             describes the BROWSER process alone and cannot see either.
#   .meminfo  the browser process's own totals, kept for continuity with earlier rounds — read it as the
#             browser, never as "Chrome"
#   .lmk      lowmemorykiller lines from THIS CELL's time window only
#   .gpulog   GPU-process / context-loss chatter from the same window
#   .png      the settled frame

set -uo pipefail

export ADB_SERIAL="${ADB_SERIAL:-ZY32LL2X8W}"
DEV_PORT="${DEV_PORT:-5190}"
SERVE_PORT="${SERVE_PORT:-8123}"
CDP_PORT="${CDP_PORT:-9222}"
REPEATS="${REPEATS:-1}"
EFFECTS="${EFFECTS:-on}"
# THE EFFECT MODE, and why it now defaults to `static` (round-7 correction). Round 6's Leg A ran EFFECTS=on and
# passed no mode, and `--effects on` alone means DYNAMIC — the settings panel's worst case, not the shipped
# one. At the phone's dpr the dynamic fleet is 4x (shaders) and 16x (particles) the surface area of the static
# default every viewer actually gets, so those cells measured a stack nobody ships. The bench has had
# --effect-mode since 7dc31e9; this script simply never passed it. Set EFFECT_MODE=dynamic deliberately when
# the question is "what does the worst case cost".
EFFECT_MODE="${EFFECT_MODE:-static}"
# `static` is the phone-representative tier and the published protocol's setting. The bench's own URL
# default is `high`, and running the DOM arm at high on this device does not degrade — it KILLS the
# renderer at page load (measured round 6: 8/8 DOM cells dead, audit-shop in warmup, at high; the same
# cells complete at static). Override only when the question is explicitly "what does high cost".
QUALITY="${QUALITY:-static}"
TRACE_PROCESSOR="${TRACE_PROCESSOR:-$(command -v trace_processor_shell || true)}"
# Optional global Mali capture. This records hardware counters for the entire
# phone, not Chrome-attributed utilization; it is deliberately off by default.
MALI_PROFILE="${MALI_PROFILE:-off}"
STREAMLINE_DURATION_SECONDS="${STREAMLINE_DURATION_SECONDS:-45}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUT_DIR="$REPO_ROOT/.sts2/bench/canvas-ab"
WORKLOADS="idle,discard,reshuffle,dense"
# This sequence is an acceptance requirement, not a tuning knob.
ARMS="dom,canvas,canvas,dom"
# `--report`'s default trace is streamed through its bounded collector and retains exactly the markers,
# RunTask CPU, DrawFrame, and metadata this gate reads. Set this only when an op-level investigation is needed:
# full raw GPU categories are much larger and can overflow the phone trace buffer.
TRACE_RAW_FULL="${TRACE_RAW_FULL:-off}"
DEV_BG_FIXTURE="${COUCHCOOP_DEV_BG_FIXTURE:-}"
ASSET_CACHE_ROOT="${COUCHCOOP_DEV_ASSET_CACHE_ROOT:-}"
ASSET_PREFLIGHT_URLS="${COUCHCOOP_DEV_ASSET_PREFLIGHT_URLS:-/res/project.godot,/res/scenes/game.tscn%3A%3AGradientTexture2D_5newe,/res/images/atlases/intent_atlas.sprites/attack/intent_attack_3.tres?format=png,/res/images/atlases/intent_atlas.sprites/intent_defend.tres?format=png,/res/scenes/screens/settings_screen.tscn%3A%3AGradientTexture2D_hcj65}"
BG_PREFLIGHT_URL="${COUCHCOOP_DEV_BG_PREFLIGHT_URL:-/bg/overgrowth.png}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --workloads) WORKLOADS="$2"; shift 2 ;;
    --recordings)
      echo "bench-phone-canvas-ab: --recordings was replaced by the named bounded --workloads matrix" >&2
      exit 2 ;;
    --help|-h)
      sed -n '2,44p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$TRACE_RAW_FULL" != "on" ] && [ "$TRACE_RAW_FULL" != "off" ]; then
  echo "bench-phone-canvas-ab: TRACE_RAW_FULL must be on or off" >&2
  exit 2
fi
if [ "$MALI_PROFILE" != on ] && [ "$MALI_PROFILE" != off ]; then
  echo "bench-phone-canvas-ab: MALI_PROFILE must be on or off" >&2
  exit 2
fi
if [ "$MALI_PROFILE" = on ]; then
  [ -n "${STREAMLINE_COUNTERS_FILE:-}" ] && [ -f "$STREAMLINE_COUNTERS_FILE" ] || { echo "bench-phone-canvas-ab: MALI_PROFILE=on requires STREAMLINE_COUNTERS_FILE." >&2; exit 2; }
  [[ "$STREAMLINE_DURATION_SECONDS" =~ ^[1-9][0-9]?$ ]] || { echo "bench-phone-canvas-ab: STREAMLINE_DURATION_SECONDS must be 1..99 for MALI_PROFILE." >&2; exit 2; }
  [ -n "${STREAMLINE_CLI:-}" ] && [ -x "$STREAMLINE_CLI" ] || { echo "bench-phone-canvas-ab: MALI_PROFILE=on requires executable STREAMLINE_CLI for timeline export." >&2; exit 2; }
  command -v mise >/dev/null || { echo "bench-phone-canvas-ab: MALI_PROFILE=on requires mise android-webview profile tasks." >&2; exit 2; }
fi
if [ -z "$TRACE_PROCESSOR" ] || [ ! -x "$TRACE_PROCESSOR" ]; then
  echo "bench-phone-canvas-ab: TRACE_PROCESSOR must name trace_processor_shell for actual presentation gates." >&2
  exit 2
fi
if [ -z "$DEV_BG_FIXTURE" ] || [ ! -d "$DEV_BG_FIXTURE" ]; then
  echo "bench-phone-canvas-ab: COUCHCOOP_DEV_BG_FIXTURE must name the ignored external background-fixture directory." >&2
  exit 2
fi
if [ -z "$ASSET_CACHE_ROOT" ] || [ ! -d "$ASSET_CACHE_ROOT" ]; then
  echo "bench-phone-canvas-ab: COUCHCOOP_DEV_ASSET_CACHE_ROOT must name the production asset-cache schema directory." >&2
  exit 2
fi
DEV_BG_FIXTURE="$(realpath -m "$DEV_BG_FIXTURE")"
ASSET_CACHE_ROOT="$(realpath -m "$ASSET_CACHE_ROOT")"
# This is an acceptance matrix, not a knob sweep. A lower quality/effect tier would make a faster
# implementation indistinguishable from a less faithful one.
if [ "$EFFECTS" != "on" ] || [ "$EFFECT_MODE" != "static" ] || [ "$QUALITY" != "static" ]; then
  echo "bench-phone-canvas-ab: acceptance cells require EFFECTS=on, EFFECT_MODE=static, and QUALITY=static" >&2
  exit 2
fi
# Keep every artifact path absolute. Besides making the cell metadata portable, this is required by the
# small CommonJS health probe below: Node treats a bare `.sts2/...` passed to `require()` as a package name,
# not as a path relative to the repository.
OUT_DIR="$(realpath -m "$OUT_DIR")"
if [ -d "$OUT_DIR" ] && [ -n "$(ls -A "$OUT_DIR")" ]; then
  echo "bench-phone-canvas-ab: refusing nonempty output directory; preserve prior/failed captures: $OUT_DIR" >&2
  exit 2
fi
mkdir -p "$OUT_DIR"

# Verify delegated ownership before any device command. The Mali/CDP session is independent of game instances,
# but both endpoints are exclusive and every live consumer shares the installed mod against deployment.
source "$SCRIPT_DIR/android-webview-lib.sh"
require_live_lock
require_live_resource "exclusive:browser:${CDP_PORT}"

# LOCKSCREEN FIRST — before any tunnel is installed, so a refusal leaves the device as it was. A locked phone
# still answers adb and still serves CDP; without this the run measures a display that was never composited.
lock_state="$(adb -s "$ADB_SERIAL" shell dumpsys window 2>/dev/null | grep -o 'mDreamingLockscreen=[a-z]*' | head -1 || true)"
if [ "$lock_state" != "mDreamingLockscreen=false" ]; then
  echo "bench-phone-canvas-ab: the phone is LOCKED ($lock_state). Unlock it and re-run." >&2
  exit 2
fi

# ASSETS PREFLIGHT. `--res-root` serves assets on the BENCH's port only; the PAGE's own same-origin /res/**
# requests go to the dev server, which on a dead-proxy dev server 404s every one of them. Both arms then
# render with ZERO textures and the A/B stops being about painting at all (measured once, the hard way:
# `res-root: 0 asset requests served`, and the canvas arm's device screenshot was the DOM text overlay on an
# empty canvas). Refuse to start rather than produce that number again.
IFS=',' read -r -a ASSET_PREFLIGHT_ARR <<< "$ASSET_PREFLIGHT_URLS"
for preflight_url in "${ASSET_PREFLIGHT_ARR[@]}"; do
  preflight_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$DEV_PORT$preflight_url" || echo 000)"
  if [ "$preflight_code" != "200" ]; then
    echo "bench-phone-canvas-ab: required asset preflight failed: $preflight_url (HTTP $preflight_code)." >&2
    echo "  Refusing to measure missing/generated asset content. Start serve-res-root with --asset-cache-root '$ASSET_CACHE_ROOT'." >&2
    exit 2
  fi
done
bg_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$DEV_PORT$BG_PREFLIGHT_URL" || echo 000)"
if [ "$bg_code" != "200" ]; then
  echo "bench-phone-canvas-ab: required static background preflight failed: $BG_PREFLIGHT_URL (HTTP $bg_code)." >&2
  echo "  Start Vite with COUCHCOOP_DEV_BG_FIXTURE='$DEV_BG_FIXTURE'; do not measure the live-background fallback." >&2
  exit 2
fi
echo "bench-phone-canvas-ab: assets + static-background fixture preflight OK (cache $ASSET_CACHE_ROOT; bg $DEV_BG_FIXTURE)"

owned_forward=0; owned_dev_reverse=0; owned_serve_reverse=0
perfetto_prefix=""
profile_pid=""
forward_target() {
  adb -s "$ADB_SERIAL" forward --list | awk -v serial="$ADB_SERIAL" -v port="tcp:$CDP_PORT" '$1==serial && $2==port {print $3}'
}
reverse_target() {
  adb -s "$ADB_SERIAL" reverse --list | awk -v port="tcp:$1" '$2==port {print $3}'
}
ensure_mappings() {
  local current
  current="$(forward_target)" || return 1
  if [ -z "$current" ]; then
    adb -s "$ADB_SERIAL" forward --no-rebind "tcp:$CDP_PORT" localabstract:chrome_devtools_remote || return 1
    owned_forward=1
  elif [ "$current" != localabstract:chrome_devtools_remote ]; then
    echo "Refusing to replace foreign forward tcp:$CDP_PORT -> $current" >&2; return 1
  fi
  for port in "$DEV_PORT" "$SERVE_PORT"; do
    current="$(reverse_target "$port")" || return 1
    if [ -z "$current" ]; then
      adb -s "$ADB_SERIAL" reverse --no-rebind "tcp:$port" "tcp:$port" || return 1
      if [ "$port" = "$DEV_PORT" ]; then owned_dev_reverse=1; else owned_serve_reverse=1; fi
    elif [ "$current" != "tcp:$port" ]; then
      echo "Refusing to replace foreign reverse tcp:$port -> $current" >&2; return 1
    fi
  done
}
cleanup() {
  # The child owns its gatord cleanup trap. Only signal the profile this shell
  # started; never broadly kill another operator's profiler.
  if [ -n "$profile_pid" ] && kill -0 "$profile_pid" 2>/dev/null; then kill -TERM -- "-$profile_pid" 2>/dev/null || true; fi
  if [ -n "$perfetto_prefix" ] && [ -f "$perfetto_prefix.perfetto-state.json" ]; then
    node "$SCRIPT_DIR/phone-frame-capture.mjs" cancel --serial "$ADB_SERIAL" --out-prefix "$perfetto_prefix" || true
  fi
  if [ "$owned_forward" = 1 ] && [ "$(forward_target)" = localabstract:chrome_devtools_remote ]; then
    adb -s "$ADB_SERIAL" forward --remove "tcp:$CDP_PORT" || true
  fi
  if [ "$owned_dev_reverse" = 1 ] && [ "$(reverse_target "$DEV_PORT")" = "tcp:$DEV_PORT" ]; then
    adb -s "$ADB_SERIAL" reverse --remove "tcp:$DEV_PORT" || true
  fi
  if [ "$owned_serve_reverse" = 1 ] && [ "$(reverse_target "$SERVE_PORT")" = "tcp:$SERVE_PORT" ]; then
    adb -s "$ADB_SERIAL" reverse --remove "tcp:$SERVE_PORT" || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ensure_mappings || exit 2

echo "bench-phone-canvas-ab: $ADB_SERIAL  dev $DEV_PORT  serve $SERVE_PORT  cdp $CDP_PORT  repeats $REPEATS" \
     "effects $EFFECTS/$EFFECT_MODE  quality $QUALITY"
echo "                       arms per recording: $ARMS"
echo "                       Mali global profile: $MALI_PROFILE (hardware scope; not Chrome attribution)"

IFS=',' read -r -a ARM_ARR <<< "$ARMS"

# The workload brackets are on the recording clock, not harness wall time. `--window` is the bench CLI's
# marker-bounded segment switch; `--limit-ms` bounds the dense prefix, and idle deliberately replays its full
# short source before a separately marker-bounded five-second quiet interval.
workload_config() {
  workload="$1"
  case "$workload" in
    idle)
      rec="${IDLE_RECORDING:-$REPO_ROOT/.sts2/bench/r13-discard-10.ndjson}"
      phase="idle"; workload_args=(--limit-ms "${IDLE_LIMIT_MS:-6561}" --idle "${IDLE_DURATION_MS:-5000}") ;;
    discard)
      rec="${DISCARD_RECORDING:-$REPO_ROOT/.sts2/bench/r13-discard-10.ndjson}"
      phase="active"; workload_args=(--window "${DISCARD_WINDOW:-3000:6500}") ;;
    reshuffle)
      rec="${RESHUFFLE_RECORDING:-$REPO_ROOT/.sts2/bench/r13-reshuffle-30.ndjson}"
      phase="active"; workload_args=(--window "${RESHUFFLE_WINDOW:-2800:7000}") ;;
    dense)
      rec="${DENSE_RECORDING:-$REPO_ROOT/.sts2/bench/combat-modern-2026-08-06.ndjson}"
      phase="active"; workload_args=(--window "${DENSE_WINDOW:-9500:15000}" --limit-ms "${DENSE_LIMIT_MS:-15500}") ;;
    *) echo "bench-phone-canvas-ab: unknown workload '$workload' (idle, discard, reshuffle, dense)" >&2; return 1 ;;
  esac
  [ -f "$rec" ] || { echo "bench-phone-canvas-ab: recording missing for $workload: $rec" >&2; return 1; }
}

IFS=',' read -r -a WORKLOAD_ARR <<< "$WORKLOADS"
for workload in "${WORKLOAD_ARR[@]}"; do
  workload_config "$workload" || exit 2
  stem="${workload}--$(basename "$rec" .ndjson)"
  pos=0
  for arm in "${ARM_ARR[@]}"; do
    pos=$((pos + 1))
    label="${stem}__${pos}-${arm}"
    log="$OUT_DIR/${label}.log"
    result="$OUT_DIR/${label}.result.json"
    meta="$OUT_DIR/${label}.meta.json"
    report="$OUT_DIR/${label}.report.json"
    trace_name="${label}.report-trace.json"
    trace_source="$REPO_ROOT/.sts2/bench/traces/$trace_name"
    trace="$OUT_DIR/${label}.trace.json"
    metrics="$OUT_DIR/${label}.metrics.json"
    perfetto_prefix="$OUT_DIR/${label}.frame-timeline"
    profile_apc="$OUT_DIR/${label}.mali.apc"
    profile_log="$OUT_DIR/${label}.mali-profile.log"
    profile_export_log="$OUT_DIR/${label}.mali-profile-export.log"
    profile_timeline="$OUT_DIR/${label}.mali.timeline.csv"
    echo ""
    echo "=== $label ==="

    # Reuse matching mappings; never replace or later remove someone else's mapping.
    ensure_mappings || exit 2

    # Something else may be in front of Chrome; ask Android to bring the browser forward before anything
    # tries to talk to it. (Never a mirror URL — this is the browser, not a page.)
    adb -s "$ADB_SERIAL" shell monkey -p com.android.chrome -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
    sleep 1

    # A FRESH FOREGROUND TAB per cell. Not politeness: the previous cell left the tab on a mirror page with a
    # live renderer, and the bench's own between-repeat about:blank parking is not enough to guarantee the tab
    # is still the one Android is scheduling. Two attempts, because the first can lose a race with whatever
    # just stole the foreground.
    # THE MOTOROLA UPDATE PROMPT self-launches fullscreen every ~13 minutes, steals the foreground and
    # silently voids the cell (the tab step then measures a background tab, or fails outright). The
    # package is on the vendor's non-disableable list, so the only defence is eviction: force-stop it
    # before every cell. Harmless when it is not running.
    adb -s "$ADB_SERIAL" shell am force-stop com.motorola.ccc.ota 2>/dev/null || true
    # phone-bench-tab.mjs owns the whole stale-tab handoff: it closes only this benchmark port,
    # observes the closed tab's renderer PID exit, and waits for the remaining renderer/GPU set to
    # stabilize before opening the next cell. Do not pre-close here: doing so erases its PID evidence.
    tab_ok=0
    for attempt in 1 2; do
      if node "$SCRIPT_DIR/phone-bench-tab.mjs" open --url "http://127.0.0.1:$DEV_PORT/" \
           --serial "$ADB_SERIAL" --cdp-port "$CDP_PORT" > "$OUT_DIR/${label}.foreground.pre-raf" 2>&1; then
        tab_ok=1
        break
      else
        tab_status=$?
      fi
      if [ "$tab_status" -eq 3 ]; then
        echo "bench-phone-canvas-ab: teardown evidence failed for $label; refusing unguarded retry" >&2
        exit 3
      fi
      echo "  (tab attempt $attempt failed; retrying)" >&2
      sleep 5
    done
    if [ "$tab_ok" != "1" ]; then
      echo "bench-phone-canvas-ab: could not get a live foreground tab for $label — SKIPPED" >&2
      continue
    fi

    # The two shipped implementations are DOM and strict single-canvas.
    query_args=()
    case "$arm" in
      dom) query="stage=dom" ;;
      canvas) query="stage=canvas&paintDump=1" ;;
      *) echo "bench-phone-canvas-ab: internal unknown arm '$arm'" >&2; exit 2 ;;
    esac
    query_args=(--query "$query")
    echo "  cell query: ${query_args[*]:-(none)}"

    # THE CELL'S OWN CLOCK, read from the DEVICE (its clock is the one logcat timestamps are in). Everything
    # this cell later greps out of logcat is bounded by this instant, so a kill from ten minutes and four cells
    # ago can never be re-reported as this cell's.
    CELL_T0="$(adb -s "$ADB_SERIAL" shell "date '+%m-%d %H:%M:%S.000'" 2>/dev/null | tr -d '\r')"
    adb -s "$ADB_SERIAL" shell dumpsys thermalservice 2>/dev/null > "$OUT_DIR/${label}.thermal.before" || true
    adb -s "$ADB_SERIAL" shell ps -A -o PID,RSS,NAME 2>/dev/null | grep -i "com.android.chrome" > "$OUT_DIR/${label}.procs.before" || true
    adb -s "$ADB_SERIAL" shell dumpsys display 2>/dev/null > "$OUT_DIR/${label}.display" || true
    adb -s "$ADB_SERIAL" shell dumpsys activity activities 2>/dev/null | grep -E "topResumedActivity|mResumedActivity" > "$OUT_DIR/${label}.foreground.before" || true

    META_PATH="$meta" LABEL="$label" WORKLOAD="$workload" ARM="$arm" SEQUENCE="$pos" QUERY="$query" \
    RECORDING="$rec" PHASE="$phase" RESULT_PATH="$result" REPORT_PATH="$report" TRACE_PATH="$trace" \
    DISPLAY_PATH="$OUT_DIR/${label}.display" REPEATS="$REPEATS" EFFECTS="$EFFECTS" EFFECT_MODE="$EFFECT_MODE" \
    QUALITY="$QUALITY" DEV_BG_FIXTURE="$DEV_BG_FIXTURE" ASSET_CACHE_ROOT="$ASSET_CACHE_ROOT" MALI_PROFILE="$MALI_PROFILE" \
    ASSET_PREFLIGHT_URLS="$ASSET_PREFLIGHT_URLS" BG_PREFLIGHT_URL="$BG_PREFLIGHT_URL" node -e '
      const { writeFileSync } = require("node:fs");
      writeFileSync(process.env.META_PATH, JSON.stringify({
        schema: "phone-canvas-cell/1", label: process.env.LABEL, arm: process.env.ARM,
        sequence: Number(process.env.SEQUENCE), query: process.env.QUERY,
        workload: { id: process.env.WORKLOAD, phase: process.env.PHASE, recording: process.env.RECORDING },
        run: { repeats: Number(process.env.REPEATS), effects: process.env.EFFECTS, effectMode: process.env.EFFECT_MODE,
          quality: process.env.QUALITY,
          assets: { source: "recovered-project+production-asset-cache", assetCacheRoot: process.env.ASSET_CACHE_ROOT,
            requiredUrls: process.env.ASSET_PREFLIGHT_URLS.split(",") },
          staticBackground: { source: "COUCHCOOP_DEV_BG_FIXTURE", fixtureDir: process.env.DEV_BG_FIXTURE,
            requiredUrl: process.env.BG_PREFLIGHT_URL } },
        artifacts: { result: process.env.RESULT_PATH, report: process.env.REPORT_PATH, trace: process.env.TRACE_PATH, display: process.env.DISPLAY_PATH },
        maliProfile: { enabled: process.env.MALI_PROFILE === "on", scope: "global Mali hardware counters; not Chrome hardware attribution" }
      }, null, 2) + "\n");
    '

    # THE EFFECT ARGS. `--effect-mode` implies effects on, so the two are mutually exclusive: passing both
    # would let `--effects on` (dynamic) silently win a race with the mode the operator asked for.
    effect_args=()
    if [ "$EFFECTS" = "off" ]; then effect_args=(--effects off); else effect_args=(--effect-mode "$EFFECT_MODE"); fi
    echo "  cell effects: ${effect_args[*]}   quality: $QUALITY"

    # --report supplies renderer-main marker bounds; --trace-gpu supplies CrGpuMain/Viz CPU. Device process
    # RSS comes from the post-cell Android ledger below: host-side process sampling cannot see an attached phone.
    # --pace recorded remains required on this phone: max pacing deadlocks.
    trace_args=()
    if [ "$TRACE_RAW_FULL" = "on" ]; then trace_args=(--trace "$trace_name"); fi
    if [ "$MALI_PROFILE" = on ]; then
      # Global counters begin only after the foreground/rAF preflight. The wrapper
      # task independently checks the running wrapper PID; that PID is metadata,
      # never a claim that the global hardware counters belong to Chrome.
      setsid env STREAMLINE_COUNTERS_FILE="$STREAMLINE_COUNTERS_FILE" STREAMLINE_DURATION_SECONDS="$STREAMLINE_DURATION_SECONDS" \
      STREAMLINE_APC_OUT="$profile_apc" mise run android-webview-profile > "$profile_log" 2>&1 &
      profile_pid=$!
    fi
    node "$SCRIPT_DIR/phone-frame-capture.mjs" start --serial "$ADB_SERIAL" --out-prefix "$perfetto_prefix" --package com.android.chrome > "$perfetto_prefix.start.log" 2>&1 || { echo "FrameTimeline start failed: $perfetto_prefix.start.log" >&2; exit 2; }
    # android-webview-lib.sh enables -e. Disable it only across this pipeline so
    # PIPESTATUS can be captured and Perfetto/health/artifact finalization still runs.
    set +e
    node "$SCRIPT_DIR/bench-mirror-replay.mjs" \
      --connect-cdp "http://127.0.0.1:$CDP_PORT" \
      --keep-connected-page \
      --serve-port "$SERVE_PORT" \
      --url "http://127.0.0.1:$DEV_PORT" \
      --recording "$rec" \
      --pace recorded \
      --quality "$QUALITY" \
      "${effect_args[@]}" \
      --repeats "$REPEATS" \
      --census \
      --res-root \
      --asset-cache-root "$ASSET_CACHE_ROOT" \
      --report "$report" \
      --no-report-shot \
      --trace-gpu \
      "${workload_args[@]}" \
      "${trace_args[@]}" \
      "${query_args[@]}" 2>&1 | tee "$log"
    bench_exit=${PIPESTATUS[0]}
    set -e
    if [ -f "$trace_source" ]; then cp "$trace_source" "$trace"; fi
    node "$SCRIPT_DIR/phone-frame-capture.mjs" stop --serial "$ADB_SERIAL" --out-prefix "$perfetto_prefix" --meta "$meta" --trace-processor "$TRACE_PROCESSOR" > "$perfetto_prefix.stop.log" 2>&1 || { echo "FrameTimeline stop failed: $perfetto_prefix.stop.log" >&2; exit 2; }
    if [ "$MALI_PROFILE" = on ]; then
      if ! wait "$profile_pid"; then
        profile_pid=""
        echo "bench-phone-canvas-ab: Mali profile failed for $label; preserving $profile_apc and $profile_log." >&2
        exit 2
      fi
      profile_pid=""
      STREAMLINE_APC_IN="$profile_apc" STREAMLINE_TIMELINE_OUT="$profile_timeline" STREAMLINE_CLI="$STREAMLINE_CLI" \
        mise run android-webview-profile-export > "$profile_export_log" 2>&1 || { echo "bench-phone-canvas-ab: Mali timeline export failed for $label; preserving $profile_apc and logs." >&2; exit 2; }
      META_PATH="$meta" PROFILE_APC="$profile_apc" PROFILE_LOG="$profile_log" PROFILE_EXPORT_LOG="$profile_export_log" PROFILE_TIMELINE="$profile_timeline" node -e '
        const fs=require("node:fs"), m=JSON.parse(fs.readFileSync(process.env.META_PATH,"utf8"));
        const profile=JSON.parse(fs.readFileSync(`${process.env.PROFILE_APC}.json`,"utf8"));
        if (!Number.isSafeInteger(profile.pid) || profile.pid <= 0) throw Error("profile metadata has no wrapper tracked PID");
        m.artifacts={...m.artifacts, maliProfileApc:process.env.PROFILE_APC, maliProfileMetadata:`${process.env.PROFILE_APC}.json`, maliProfileLog:process.env.PROFILE_LOG, maliProfileExportLog:process.env.PROFILE_EXPORT_LOG, maliProfileTimeline:process.env.PROFILE_TIMELINE};
        m.maliProfile={...m.maliProfile, scope:"global Mali hardware counters; not Chrome hardware attribution", wrapperTrackedPid:profile.pid ?? null, durationSeconds:profile.durationSeconds ?? null, counterList:profile.counterList ?? null};
        fs.writeFileSync(process.env.META_PATH,JSON.stringify(m,null,2)+"\n");
      ' || { echo "bench-phone-canvas-ab: Mali profile metadata is invalid for $label." >&2; exit 2; }
    fi
    adb -s "$ADB_SERIAL" shell dumpsys thermalservice 2>/dev/null > "$OUT_DIR/${label}.thermal.after" || true
    thermal_throttle=false
    for thermal_file in "$OUT_DIR/${label}.thermal.before" "$OUT_DIR/${label}.thermal.after"; do
      thermal_status="$(sed -n 's/^Thermal Status: *\([0-6]\).*$/\1/p' "$thermal_file")"
      if [ "$thermal_status" != 0 ] && [ "$thermal_status" != 1 ]; then thermal_throttle=true; fi
    done

    # The Android intent/open check above proves the start, but a notification or OTA prompt can take the
    # foreground during the replay.  Preserve the real rAF proof at both ends; visibilityState is not evidence.
    foreground_post=false
    if node "$SCRIPT_DIR/phone-bench-tab.mjs" verify --url-prefix "http://127.0.0.1:$DEV_PORT" \
         --serial "$ADB_SERIAL" --cdp-port "$CDP_PORT" > "$OUT_DIR/${label}.foreground.after" 2>&1; then
      foreground_post=true
    fi

    grep -h "^BENCH_RESULT" "$log" | tail -1 | sed 's/^BENCH_RESULT //' > "$result" || true
    # R6 P6-H + R7 W1-I1h: the per-cell facts the stage-default criteria read, taken HERE because the end of a
    # cell is the only moment anything is present at the settled page.
    #
    # PER-PROCESS FIRST. Round 6 recorded `dumpsys meminfo com.android.chrome` and read it as "Chrome's
    # memory", but that command describes the BROWSER process only — while the process the kernel actually
    # killed was `com.android.chrome:privileged_process2` (the GPU process) at 1.33-1.63 GB. `ps -A` names
    # every process in the same currency the kill lines use, so the two artifacts can finally be read together:
    # :privileged_process* = GPU, :sandboxed_process* = renderers, bare package name = browser.
    adb -s "$ADB_SERIAL" shell ps -A -o PID,RSS,NAME 2>/dev/null | grep -i "com.android.chrome" > "$OUT_DIR/${label}.procs" || true
    # Kept for continuity with the earlier rounds' artifacts. It is the BROWSER process; the file name no
    # longer implies otherwise because .procs sits beside it.
    adb -s "$ADB_SERIAL" shell dumpsys meminfo com.android.chrome 2>/dev/null | grep -E "TOTAL (PSS|RSS)" | head -2 > "$OUT_DIR/${label}.meminfo" || true
    # TIME-BOUNDED, not `tail -5`. The old form took the last five lines of the whole buffer whatever their
    # age: round 6's evidence survived by luck, and could just as easily have shown another cell's kills.
    adb -s "$ADB_SERIAL" logcat -d -t "$CELL_T0" -s lowmemorykiller 2>/dev/null > "$OUT_DIR/${label}.lmk" || true
    # THE GPU PROCESS'S OWN VOICE over the same window. A context loss and a GPU-process restart are the two
    # events that turn a cell's numbers into fiction, and until now nothing in this harness collected either.
    adb -s "$ADB_SERIAL" logcat -d -t "$CELL_T0" 2>/dev/null \
      | grep -Ei "gpu process|GpuProcessHost|lost the GPU|context lost" > "$OUT_DIR/${label}.gpulog" || true
    adb -s "$ADB_SERIAL" exec-out screencap -p > "$OUT_DIR/${label}.png" 2>/dev/null || true
    if [ -f "$trace_source" ]; then cp "$trace_source" "$trace"; else echo "  trace missing: $trace_source" >&2; fi

    # A new renderer tab is normal; a GPU-process PID disappearing during one cell is not. Keep the raw before
    # and after process ledgers too, so this boolean never hides the evidence it was derived from.
    gpu_before="$(awk '/privileged_process/ { print $1 }' "$OUT_DIR/${label}.procs.before" | sort -u | tr '\n' ',')"
    gpu_after="$(awk '/privileged_process/ { print $1 }' "$OUT_DIR/${label}.procs" | sort -u | tr '\n' ',')"
    # Missing process evidence and any vanished GPU process invalidate the cell.
    process_restart=true
    if [ -n "$gpu_before" ] && [ -n "$gpu_after" ]; then
      vanished_gpu="$(comm -23 <(printf '%s\n' "$gpu_before" | tr ',' '\n' | sed '/^$/d' | sort -u) <(printf '%s\n' "$gpu_after" | tr ',' '\n' | sed '/^$/d' | sort -u))"
      [ -z "$vanished_gpu" ] && process_restart=false
    fi
    lmk=false; grep -Eqi 'Kill .*com\.android\.chrome|com\.android\.chrome.*(killed|kill)' "$OUT_DIR/${label}.lmk" && lmk=true || true
    context_loss=false; grep -Eqi 'lost the GPU|context lost|GpuProcessHost.*(crash|restart)' "$OUT_DIR/${label}.gpulog" && context_loss=true || true
    page_crash=false; asset_failure=false; known_nonpainting_asset_errors='[]'
    if [ -s "$result" ]; then
      read -r page_crash asset_failure known_nonpainting_asset_errors < <(RESULT_PATH="$result" node -e '
        const r=require(process.env.RESULT_PATH);
        const crash=r.pageCrashed===true || (r.crashedRepeats||[]).some(Boolean);
        const known=new Set(["/res/scenes/game.tscn%3A%3AGradientTexture2D_5newe","/res/scenes/screens/settings_screen.tscn%3A%3AGradientTexture2D_hcj65"]);
        const errors=(r.responseErrors||[]).filter(x => Number(x.status)>=400);
        const knownErrors=errors.filter(x => known.has(x.pathname));
        const asset=errors.some(x => !known.has(x.pathname));
        console.log(`${crash} ${asset} ${JSON.stringify(knownErrors)}`);
      ')
    else page_crash=true; asset_failure=true; fi
    META_PATH="$meta" BENCH_EXIT="$bench_exit" LMK="$lmk" CONTEXT="$context_loss" RESTART="$process_restart" \
    PAGE_CRASH="$page_crash" ASSET_FAILURE="$asset_failure" KNOWN_NONPAINTING_ASSET_ERRORS="$known_nonpainting_asset_errors" GPU_BEFORE="$gpu_before" GPU_AFTER="$gpu_after" \
    FOREGROUND_PRE="$tab_ok" FOREGROUND_POST="$foreground_post" THERMAL="$thermal_throttle" \
    PROCS_BEFORE="$OUT_DIR/${label}.procs.before" PROCS_AFTER="$OUT_DIR/${label}.procs" FOREGROUND_PRE_RAF="$OUT_DIR/${label}.foreground.pre-raf" FOREGROUND_BEFORE="$OUT_DIR/${label}.foreground.before" FOREGROUND_AFTER="$OUT_DIR/${label}.foreground.after" \
    THERMAL_BEFORE="$OUT_DIR/${label}.thermal.before" THERMAL_AFTER="$OUT_DIR/${label}.thermal.after" \
    LMK_PATH="$OUT_DIR/${label}.lmk" GPU_LOG="$OUT_DIR/${label}.gpulog" node -e '
      const fs=require("node:fs"), m=JSON.parse(fs.readFileSync(process.env.META_PATH,"utf8"));
      m.artifacts={...m.artifacts, thermalBefore:process.env.THERMAL_BEFORE, thermalAfter:process.env.THERMAL_AFTER, procsBefore:process.env.PROCS_BEFORE, procsAfter:process.env.PROCS_AFTER, foregroundPreRaf:process.env.FOREGROUND_PRE_RAF, foregroundBefore:process.env.FOREGROUND_BEFORE, foregroundAfter:process.env.FOREGROUND_AFTER, lmk:process.env.LMK_PATH, gpuLog:process.env.GPU_LOG};
      m.health={benchExit:Number(process.env.BENCH_EXIT), lmk:process.env.LMK==="true", contextLoss:process.env.CONTEXT==="true", processRestart:process.env.RESTART==="true", pageCrash:process.env.PAGE_CRASH==="true", assetFailure:process.env.ASSET_FAILURE==="true", knownNonpaintingAssetErrors:JSON.parse(process.env.KNOWN_NONPAINTING_ASSET_ERRORS||"[]"), thermalThrottle:process.env.THERMAL==="true", foregroundPre:process.env.FOREGROUND_PRE==="1", foregroundPost:process.env.FOREGROUND_POST==="true", gpuPidsBefore:process.env.GPU_BEFORE, gpuPidsAfter:process.env.GPU_AFTER};
      fs.writeFileSync(process.env.META_PATH, JSON.stringify(m,null,2)+"\n");
    '
    if [ -s "$trace" ] && [ -s "$result" ]; then
      node "$SCRIPT_DIR/analyze-phone-canvas-cell.mjs" --trace "$trace" --result "$result" --meta "$meta" --phase "$phase" --out "$metrics" --perfetto-trace "$perfetto_prefix.pftrace" --trace-processor "$TRACE_PROCESSOR" || true
    fi
    if [ "$MALI_PROFILE" = on ]; then
      [ -s "$metrics" ] || { echo "bench-phone-canvas-ab: Mali profile requires cell metrics for $label." >&2; exit 2; }
      node "$SCRIPT_DIR/analyze-mali-capture.mjs" "$profile_apc" "$profile_timeline" "$trace" "$phase" "$metrics" "$OUT_DIR/${label}.mali.analysis.json" || {
        echo "bench-phone-canvas-ab: Mali marker analysis failed for $label; preserving raw APC and timeline." >&2
        exit 2
      }
    fi
    echo "  -> $log"
  done
done

echo ""
echo "all cells written to $OUT_DIR"
echo "summarize with: node scripts/summarize-phone-canvas-bench.mjs --input '$OUT_DIR' --visual-quality '<review.json>'"
