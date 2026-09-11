#!/bin/bash
# Bring up a PRIVATE gamescope compositor and one ISOLATED STS2 instance inside it, for the KNIGHTS_ELITE
# geoclip gate (scripts/bench-geoclip-knights.mjs). Nothing here touches the operator's desktop or their game.
#
# WHY GAMESCOPE AND NOT XVFB. Xvfb prices an awaited engine frame about 20x the desktop's (qa-recipes §2.x,
# measured in the phase-7 gate: ForceDraw 27 -> 595 ms per 8 draws). A geoclip bake and a raster still await
# DIFFERENT numbers of engine frames, so that distortion does not cancel between the lanes — an Xvfb number
# would manufacture a verdict rather than measure one. `gamescope --backend headless` gives a headed X11/Vulkan
# game on the real GPU with no window on anybody's screen: verified on this box at gamescope 3.16.19, which logs
# `vulkan: selecting physical device 'NVIDIA GeForce RTX 2060'` and starts its own XWayland (the child sees
# DISPLAY=:N, WAYLAND_DISPLAY empty, GAMESCOPE_WAYLAND_DISPLAY=gamescope-0).
#
# Direct Wayland into that compositor STALLED when it was tried (project memory, phase-7 round), so the game is
# launched with --display-driver x11 against gamescope's XWayland. That is a deliberate choice, not an oversight.
#
# WHAT IT COSTS, and why the bench is told: the compositor plus the game take seconds to become useful and about
# a gigabyte of RSS. That is startup, not lane cost. This script measures it and writes it to a record the bench
# folds into its `overhead` block, so a reader can see it was accounted for and excluded rather than assume it.
#
#   scripts/bring-up-gamescope-instance.sh --instance geoclip-knights \
#     --cache-root /tmp/geoclip-bench-cache --record /tmp/geoclip-bringup.json
#
# Then, and only then, drive the encounter and run the bench. Teardown:
#   scripts/bring-up-gamescope-instance.sh --instance geoclip-knights --teardown
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE=""
CACHE_ROOT=""
RECORD=""
WIDTH=1920
HEIGHT=1080
TEARDOWN=0
PLAN_ONLY=0
LOCK_HELD=0

die() { echo "bring-up: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --instance) INSTANCE="$2"; shift 2 ;;
    --cache-root) CACHE_ROOT="$2"; shift 2 ;;
    --record) RECORD="$2"; shift 2 ;;
    --width) WIDTH="$2"; shift 2 ;;
    --height) HEIGHT="$2"; shift 2 ;;
    --teardown) TEARDOWN=1; shift ;;
    --plan) PLAN_ONLY=1; shift ;;
    --i-hold-the-live-lock) LOCK_HELD=1; shift ;;
    -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

[ -n "$INSTANCE" ] || die "--instance <name> is required"
RUN_DIR="/tmp/geoclip-bringup-$INSTANCE"
CONFIG="$RUN_DIR/sts2.$INSTANCE.yaml"
GS_LOG="$RUN_DIR/gamescope.log"
GS_PIDFILE="$RUN_DIR/gamescope.pid"

# ---------------------------------------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------------------------------------
if [ "$TEARDOWN" = "1" ]; then
  if [ -f "$CONFIG" ]; then
    sts2 --config "$CONFIG" --instance "$INSTANCE" game close >/dev/null 2>&1 || true
  fi
  if [ -f "$GS_PIDFILE" ]; then
    GS_PID="$(cat "$GS_PIDFILE")"
    # Only ever OUR compositor: the pid file is written by this script and the process is checked to still be
    # gamescope before it is signalled. Never a pkill pattern — see the pkill-headless-self-match memory.
    if [ -d "/proc/$GS_PID" ] && tr '\0' ' ' < "/proc/$GS_PID/cmdline" | grep -q gamescope; then
      kill "$GS_PID" 2>/dev/null || true
    fi
    rm -f "$GS_PIDFILE"
  fi
  echo "bring-up: torn down $INSTANCE"
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------
# Refusals BEFORE anything is started
# ---------------------------------------------------------------------------------------------------------
[ -n "$CACHE_ROOT" ] || die "--cache-root is required: the bench purges it, so it must be private to this instance"
case "$(readlink -f "$CACHE_ROOT")" in
  "$HOME"/.local/share/SlayTheSpire2*|"$HOME"/.steam*)
    die "--cache-root $CACHE_ROOT is inside the operator's own game data" ;;
esac

# The lease protects the GAME, so it is required exactly when a game is about to start. --plan brings up only a
# private compositor with a `sleep` inside it, which touches nothing anybody else owns.
if [ "$LOCK_HELD" != "1" ] && [ "$PLAN_ONLY" != "1" ]; then
  cat >&2 <<'MSG'
bring-up: this starts a real game process. Take the live-QA lease first (the `couch-live-lock` skill), then
re-run with --i-hold-the-live-lock. The operator's own game is never a lock holder and is never driven or
stopped by anything here; this script only ever touches the instance it launches.
MSG
  exit 2
fi

command -v gamescope >/dev/null || die "gamescope is not installed; there is no valid display for a cross-lane timing verdict on this box"
command -v sts2 >/dev/null || die "the sts2 CLI is not on PATH"

mkdir -p "$RUN_DIR" "$CACHE_ROOT"

# ---------------------------------------------------------------------------------------------------------
# A SCRATCH config, because the repo's sts2.local.yaml fights this
# ---------------------------------------------------------------------------------------------------------
# sts2.local.yaml is cwd-discovered and injects its own launchWrapper plus `--display-driver wayland`. Running
# from the repo root with that file present would put the game on the operator's compositor. So the config this
# script uses is generated here, carries only what this run needs, and is passed explicitly with --config.
#
# instances.symlinkUserDataDirs is [] deliberately: a named instance otherwise inherits the shared couch-coop
# symlink and clobbers the operator's browser-port record, which is how another agent loses their instance.
ASSEMBLIES_DIR="$(grep -E '^\s*assembliesDir:' "$REPO_ROOT/sts2.local.yaml" | head -1 | sed 's/.*assembliesDir:[[:space:]]*//')"
GAME_PATH="$(grep -E '^\s*path:' "$REPO_ROOT/sts2.local.yaml" | head -1 | sed 's/.*path:[[:space:]]*//')"
[ -n "$ASSEMBLIES_DIR" ] || die "could not read game.assembliesDir out of $REPO_ROOT/sts2.local.yaml"

cat > "$CONFIG" <<YAML
game:
  path: $GAME_PATH
  assembliesDir: $ASSEMBLIES_DIR
  # No launchWrapper here: gamescope is already running and this launch goes INTO it through DISPLAY.
  launchArgs: ["--display-driver", "x11"]
  disableBackgroundThrottle: true
  launchEnv:
    COUCHCOOP_CACHE_ROOT: $CACHE_ROOT
    # Spelled exactly as CouchCoopGeoclipProvider.OnDemandEnvVar spells it — ONDEMAND, one word. It is an
    # opt-OUT switch (anything but "0" is on), so this line is documentation of intent as much as configuration.
    COUCHCOOP_GEOCLIP_ONDEMAND: "1"
    # Sts2RenderPhaseProfile.ProfileEnvVar. On by default; pinned here because the host half of the gate IS the
    # phase split, and a run with it off would report phases:null on every bake.
    SPIRECTL_RENDER_PHASE_PROFILE: "1"
    SPIRECTL_SPINE_GEOCLIP_LOG_GODOT: "1"
    # No --prerender-spines and no COUCHCOOP_SPINE_BENCH: every leg must be an ON-DEMAND cold produce through
    # the route a real client uses, not a prerendered cache hit and not the re-bake bench route.
instances:
  dir: $RUN_DIR/instances
  symlinkUserDataDirs: []
YAML

# ---------------------------------------------------------------------------------------------------------
# The compositor
# ---------------------------------------------------------------------------------------------------------
# THE WAYLAND TRAP, the same one scripts/run-gpu.sh documents: with WAYLAND_DISPLAY still set, a client's Ozone
# or SDL auto-detection prefers Wayland and sails straight past the private display onto the real desktop.
GS_START_MS=$(date +%s%3N)
env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 \
  gamescope --backend headless -W "$WIDTH" -H "$HEIGHT" -w "$WIDTH" -h "$HEIGHT" \
  -- sh -c 'echo "GAMESCOPE_CHILD_DISPLAY=$DISPLAY"; sleep infinity' \
  > "$GS_LOG" 2>&1 &
GS_PID=$!
echo "$GS_PID" > "$GS_PIDFILE"

# Wait for gamescope's OWN XWayland to announce a display, rather than sleeping a guessed interval.
GS_DISPLAY=""
for _ in $(seq 1 200); do
  GS_DISPLAY="$(grep -oE 'GAMESCOPE_CHILD_DISPLAY=:[0-9]+' "$GS_LOG" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  [ -n "$GS_DISPLAY" ] && break
  [ -d "/proc/$GS_PID" ] || { echo "--- gamescope log ---" >&2; cat "$GS_LOG" >&2; die "gamescope exited before it produced a display"; }
  sleep 0.1
done
[ -n "$GS_DISPLAY" ] || { cat "$GS_LOG" >&2; die "gamescope produced no XWayland display within 20 s"; }
GS_READY_MS=$(( $(date +%s%3N) - GS_START_MS ))

# The compositor's own statement of which GPU it bound. This is the positive GPU evidence the bench requires;
# without it the bench refuses to reach a verdict rather than assuming hardware.
VULKAN_DEVICE="$(grep -oE "selecting physical device '[^']+'" "$GS_LOG" | head -1 | sed "s/.*'\\(.*\\)'/\\1/" || true)"

echo "bring-up: gamescope ready on DISPLAY=$GS_DISPLAY in ${GS_READY_MS} ms (device: ${VULKAN_DEVICE:-UNKNOWN})"

if [ "$PLAN_ONLY" = "1" ]; then
  echo "bring-up: --plan, so the game is NOT launched. Config written to $CONFIG"
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------
# The instance
# ---------------------------------------------------------------------------------------------------------
GAME_START_MS=$(date +%s%3N)
env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 DISPLAY="$GS_DISPLAY" \
  sts2 --config "$CONFIG" --instance "$INSTANCE" game launch \
  > "$RUN_DIR/launch.json" 2> "$RUN_DIR/launch.err" \
  || { echo "--- launch stderr ---" >&2; tail -40 "$RUN_DIR/launch.err" >&2; die "game launch failed"; }
GAME_READY_MS=$(( $(date +%s%3N) - GAME_START_MS ))

USER_DIR="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["userDir"])' "$RUN_DIR/instances/$INSTANCE/instance.json" 2>/dev/null || true)"
PORT_FILE="$USER_DIR/SlayTheSpire2/couch-coop/browser-port"
GAME_PID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("pid",""))' "$PORT_FILE" 2>/dev/null || true)"
RSS_KB="$(awk '/VmRSS/{print $2}' "/proc/$GAME_PID/status" 2>/dev/null || true)"

if [ -n "$RECORD" ]; then
  if [ -n "$VULKAN_DEVICE" ]; then VULKAN_JSON="\"$VULKAN_DEVICE\""; else VULKAN_JSON="null"; fi
  cat > "$RECORD" <<JSON
{
  "schema": "geoclip-bringup/1",
  "instance": "$INSTANCE",
  "display": "$GS_DISPLAY",
  "gamescopePid": $GS_PID,
  "gamescopeLog": "$GS_LOG",
  "vulkanDevice": $VULKAN_JSON,
  "compositorStartupMs": $GS_READY_MS,
  "gameLaunchMs": $GAME_READY_MS,
  "gameRssKb": ${RSS_KB:-null},
  "config": "$CONFIG",
  "cacheRoot": "$CACHE_ROOT",
  "portFile": "$PORT_FILE",
  "note": "Startup, not lane cost. The bench runs against an already-running instance and excludes every number here from both gate metrics."
}
JSON
fi

cat <<SUMMARY
bring-up: instance $INSTANCE is up.
  DISPLAY        $GS_DISPLAY   (private gamescope, headless backend, no desktop surface)
  GPU            ${VULKAN_DEVICE:-UNKNOWN}
  compositor     ${GS_READY_MS} ms
  game launch    ${GAME_READY_MS} ms, RSS ${RSS_KB:-?} kB
  port file      $PORT_FILE
  cache root     $CACHE_ROOT
Next, with the live lock still held:
  sts2 --config $CONFIG --instance $INSTANCE dev fixture load <an ironclad fixture>
  sts2 --config $CONFIG --instance $INSTANCE --mode dev dev console fight KNIGHTS_ELITE
  # record the ACTUAL roster, write it into a probe dataset, then run the bench.
SUMMARY
