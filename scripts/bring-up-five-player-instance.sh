#!/bin/bash
# Bring up ONE isolated STS2 host instance configured for a >4-PLAYER couch-coop session, inside a private
# gamescope compositor, and publish everything a probe needs to join browser clients to it. Nothing here
# touches the operator's desktop, their game, or their profile. Modelled on (and deliberately shaped like)
# scripts/bring-up-gamescope-instance.sh; read that one first if only the compositor part is unfamiliar.
#
# WHY A SCRIPT AND NOT A RECIPE. A five-player session is the one configuration where getting the MOD LIST
# wrong is invisible: with `sts2unlimited` off the lobby silently caps at four and the fifth seat reads as a
# couch-coop bug, and with the workshop `couchcoop` enabled alongside the local one you are testing a build
# you did not deploy. Both failures look like product defects. So the loadout is pinned, in writing, per
# instance, before the game ever starts.
#
# WHY NOT `game.modLoadout`. The CLI's own loadout rewrite keys a map by mod ID, and this machine's mod_list
# carries `couchcoop` TWICE (`mods_directory` = the local dev deploy, `steam_workshop` = the published
# build). The two rows collapse and both come back tagged `steam_workshop` — i.e. asking the CLI to enable
# couchcoop can flip the instance onto the Workshop build. So `game.modLoadout` is left UNSET in the scratch
# config (which also means the CLI performs no settings.save rewrite or restore at all) and the loadout is
# applied by scripts/lib/mp5-mod-loadout.py, keyed on (id, source).
#
# WHY THE INSTANCE'S OWN settings.save. `sts2 --instance` points the game's XDG_DATA_HOME at the instance's
# user dir, so the mod list the game reads is `<userDir>/SlayTheSpire2/steam/<steamid>/settings.save` — a
# COPY the CLI seeds from the operator's profile, never the operator's own file. The <steamid> is discovered
# by glob; it is not this box's business to hardcode.
#
# WHAT THE SEED DRAGS IN, and why two directories are deleted right after it. The CLI seeds the instance user
# dir by copy-if-missing from `~/.local/share/SlayTheSpire2`, which carries two pieces of LIVE SESSION state:
# `couch-coop/browser-port` (the operator's running game's port AND its pid — a reader that trusted the copy
# would connect straight to their game, and the pid check would pass) and `couch-coop/headless-slots/` (their
# seat dirs, whose godot.log files would match this record's seatLogGlob). Both are removed before launch, so
# anything that appears afterwards was written by this instance. The port file is then accepted only after
# /proc/<pid>/environ proves the writer is a process running under THIS instance's XDG_DATA_HOME.
#
#   scripts/bring-up-five-player-instance.sh --instance mp5 --cache-root /tmp/mp5-cache \
#     --record /tmp/mp5-bringup.json --i-hold-the-live-lock
#
# Teardown (idempotent):
#   scripts/bring-up-five-player-instance.sh --instance mp5 --teardown
#
# `--plan` stops before the game launch but still writes the scratch config, brings up the compositor, seeds
# the instance and applies the loadout — all of which are game-free — so the mod configuration can be proved
# without holding the live lock. The first seed of a fresh instance copies ~800 MB and takes a while; a
# re-run against the same instance is free.
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

# How long to wait for the mod to publish its bound port. The browser server comes up well after the window
# does (asset cache warm-up, ENet host), and a cold instance on a cold cache is the slow case.
PORT_TIMEOUT_MS=240000

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
    -h|--help) sed -n '2,42p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

[ -n "$INSTANCE" ] || die "--instance <name> is required"
RUN_DIR="/tmp/mp5-bringup-$INSTANCE"
CONFIG="$RUN_DIR/sts2.$INSTANCE.yaml"
GS_LOG="$RUN_DIR/gamescope.log"
GS_PIDFILE="$RUN_DIR/gamescope.pid"
# `sts2 --instance` derives this from instances.dir; it is not read back from instance.json because that file
# does not exist until the first launch, and the loadout must be applied BEFORE that.
USER_DIR="$RUN_DIR/instances/$INSTANCE/user"
GAME_DATA_DIR="$USER_DIR/SlayTheSpire2"
PORT_FILE="$GAME_DATA_DIR/couch-coop/browser-port"
SEAT_LOG_GLOB="$GAME_DATA_DIR/couch-coop/headless-slots/slot-*/SlayTheSpire2/logs/godot.log"

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
[ -n "$CACHE_ROOT" ] || die "--cache-root is required: this instance writes and evicts in it, so it must be private"
case "$(readlink -f "$CACHE_ROOT")" in
  "$HOME"/.local/share/SlayTheSpire2*|"$HOME"/.steam*)
    die "--cache-root $CACHE_ROOT is inside the operator's own game data" ;;
esac

# The lease protects the GAME, so it is required exactly when a game is about to start. --plan brings up only
# a private compositor with a `sleep` inside it, plus file work under $RUN_DIR, which touches nothing anybody
# else owns.
if [ "$LOCK_HELD" != "1" ] && [ "$PLAN_ONLY" != "1" ]; then
  cat >&2 <<'MSG'
bring-up: this starts a real game process. Take the live-QA lease first (the `couch-live-lock` skill), then
re-run with --i-hold-the-live-lock. The operator's own game is never a lock holder and is never driven or
stopped by anything here; this script only ever touches the instance it launches.
MSG
  exit 2
fi

command -v gamescope >/dev/null || die "gamescope is not installed; there is no private display to put this instance on"
command -v sts2 >/dev/null || die "the sts2 CLI is not on PATH"
command -v python3 >/dev/null || die "python3 is not on PATH (the settings.save editor needs it)"
LOADOUT_EDITOR="$REPO_ROOT/scripts/lib/mp5-mod-loadout.py"
PORT_READER="$REPO_ROOT/scripts/lib/mp5-instance-port.py"
[ -f "$LOADOUT_EDITOR" ] || die "missing $LOADOUT_EDITOR"
[ -f "$PORT_READER" ] || die "missing $PORT_READER"

mkdir -p "$RUN_DIR" "$CACHE_ROOT"

# ---------------------------------------------------------------------------------------------------------
# A SCRATCH config, because the repo's sts2.local.yaml fights this
# ---------------------------------------------------------------------------------------------------------
# sts2.local.yaml is cwd-discovered and injects its own launchWrapper plus `--display-driver wayland`. Running
# from the repo root with that file present would put the game on the operator's compositor. So the config
# this script uses is generated here, carries only what this run needs, and is passed explicitly with
# --config.
#
# instances.symlinkUserDataDirs is [] deliberately: sts2.local.yaml symlinks `couch-coop` into every named
# instance, which would make this instance share — and clobber — the operator's browser-port record. That is
# how another agent loses their instance.
#
# game.modLoadout is deliberately ABSENT; see the header. Leaving it unset also means `game launch` performs
# no settings.save rewrite and no restore, so the loadout written below is what the game actually reads.
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
instances:
  dir: $RUN_DIR/instances
  symlinkUserDataDirs: []
YAML

# ---------------------------------------------------------------------------------------------------------
# The compositor
# ---------------------------------------------------------------------------------------------------------
# THE WAYLAND TRAP, the same one scripts/run-gpu.sh documents: with WAYLAND_DISPLAY still set, a client's
# Ozone or SDL auto-detection prefers Wayland and sails straight past the private display onto the real
# desktop.
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

# The compositor's own statement of which GPU it bound.
VULKAN_DEVICE="$(grep -oE "selecting physical device '[^']+'" "$GS_LOG" | head -1 | sed "s/.*'\\(.*\\)'/\\1/" || true)"

echo "bring-up: gamescope ready on DISPLAY=$GS_DISPLAY in ${GS_READY_MS} ms (device: ${VULKAN_DEVICE:-UNKNOWN})"

# ---------------------------------------------------------------------------------------------------------
# Seed the instance user dir WITHOUT starting a game
# ---------------------------------------------------------------------------------------------------------
# `game mods settings` is the only lifecycle command that runs the instance user-data seed while neither
# deploying nor launching (it seeds so it has a settings.save to read). That is what lets the loadout be
# pinned BEFORE the first launch, instead of launching once to seed, editing, and restarting. Its exit code
# is ignored on purpose: the seed happens while it is collecting candidates, so a later failure to pick one
# does not mean the seed did not happen — the glob below is the real check.
echo "bring-up: seeding $USER_DIR (first time on a fresh instance copies ~800 MB; re-runs are free)"
sts2 --config "$CONFIG" --instance "$INSTANCE" --json game mods settings \
  > "$RUN_DIR/mods-settings-seed.json" 2> "$RUN_DIR/mods-settings-seed.err" || true

SETTINGS_SAVE=""
for candidate in "$GAME_DATA_DIR"/steam/*/settings.save; do
  [ -f "$candidate" ] || continue
  [ -z "$SETTINGS_SAVE" ] || die "more than one steam/<id>/settings.save under $GAME_DATA_DIR; refusing to guess which profile the game will read"
  SETTINGS_SAVE="$candidate"
done
if [ -z "$SETTINGS_SAVE" ]; then
  echo "--- sts2 game mods settings stderr ---" >&2
  tail -20 "$RUN_DIR/mods-settings-seed.err" >&2 || true
  die "no $GAME_DATA_DIR/steam/*/settings.save after the seed. The instance has no mod list to pin, so a
launch would run whatever the game discovers — which is the exact failure this script exists to prevent."
fi

# ---------------------------------------------------------------------------------------------------------
# Sterilize the two pieces of the operator's LIVE session that the seed copies in
# ---------------------------------------------------------------------------------------------------------
# browser-port carries their running game's port AND pid, so it survives a liveness check and would hand this
# script (and the probe reading this record) a connection to their game. headless-slots carries their seat
# dirs, whose godot.log files match this record's seatLogGlob. Neither may be inherited. Removing them before
# launch also means anything that appears afterwards was written by THIS instance.
rm -f "$PORT_FILE"
rm -rf "$GAME_DATA_DIR/couch-coop/headless-slots"

# ---------------------------------------------------------------------------------------------------------
# The mod loadout
# ---------------------------------------------------------------------------------------------------------
echo "bring-up: pinning the >4-player loadout in $SETTINGS_SAVE"
python3 "$LOADOUT_EDITOR" --settings "$SETTINGS_SAVE" --json > "$RUN_DIR/mod-loadout.json" \
  || die "the >4-player mod loadout could not be applied to $SETTINGS_SAVE (see the error above)"
python3 - "$RUN_DIR/mod-loadout.json" <<'PY'
import json, sys

report = json.load(open(sys.argv[1], encoding="utf-8"))
for row in report["modList"]["after"]:
    state = "on " if row["enabled"] else "off"
    print("  {0} {1} ({2})".format(state, row["id"], row["source"]))
PY

if [ "$PLAN_ONLY" = "1" ]; then
  cat <<PLAN
bring-up: --plan, so the game is NOT launched.
  config         $CONFIG
  user dir       $USER_DIR
  settings.save  $SETTINGS_SAVE
  loadout        $RUN_DIR/mod-loadout.json
Tear the compositor down with --teardown when you are done looking.
PLAN
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

read_json_path() {
  # read_json_path <file> <dotted.path> — prints nothing when the file or any segment is absent.
  python3 - "$1" "$2" <<'PY'
import json, sys

try:
    node = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    raise SystemExit(0)
for key in sys.argv[2].split("."):
    if not isinstance(node, dict):
        raise SystemExit(0)
    node = node.get(key)
if node is not None:
    print(node)
PY
}

# `launch.stdio.{stdoutPath,stderrPath}` are THIS launch's concrete capture files. instance.json instead
# records the per-instance `game.std{out,err}.log` symlinks that are re-pointed at every launch — used only as
# a fallback, so the record always names a file a reader can tail.
HOST_STDOUT="$(read_json_path "$RUN_DIR/launch.json" launch.stdio.stdoutPath)"
HOST_STDERR="$(read_json_path "$RUN_DIR/launch.json" launch.stdio.stderrPath)"
INSTANCE_JSON="$RUN_DIR/instances/$INSTANCE/instance.json"
if [ -z "$HOST_STDOUT" ]; then
  HOST_STDOUT="$(read_json_path "$INSTANCE_JSON" stdoutPath)"
  HOST_STDERR="$(read_json_path "$INSTANCE_JSON" stderrPath)"
fi

# ---------------------------------------------------------------------------------------------------------
# Wait for the mod to publish the port it ACTUALLY bound
# ---------------------------------------------------------------------------------------------------------
# COUCHCOOP_PREFERRED_PORT is a preference: the browser server walks upward when a port is taken, so the
# answer is whatever the mod wrote, never 13337 by assumption (see the instance-browser-port-file memory).
# Polling the file beats sleeping a guess, and the record is accepted only once the writer's own
# XDG_DATA_HOME proves it is THIS instance — see the header, and scripts/lib/mp5-instance-port.py.
BROWSER_PORT=""
GAME_PID=""
POLLS=0
PORT_DEADLINE_MS=$(( $(date +%s%3N) + PORT_TIMEOUT_MS ))
# Grace before "no process under this user dir" counts as a death: the spawn is detached, so there is a
# window after `game launch` returns in which the game legitimately has not appeared yet.
LIVENESS_FROM_MS=$(( $(date +%s%3N) + 30000 ))
while :; do
  if PORT_LINE="$(python3 "$PORT_READER" --port-file "$PORT_FILE" --user-dir "$USER_DIR")" \
      && [ -n "$PORT_LINE" ]; then
    BROWSER_PORT="${PORT_LINE%% *}"
    GAME_PID="${PORT_LINE##* }"
    break
  fi
  # Every ~5 s (the scan walks /proc), and never by `launch.pid`: that is the pid the CLI SPAWNED, which a
  # detached or re-execed launch leaves dead while the game runs on. Asking "is anything still running under
  # this instance's user dir" has no such ambiguity, and cannot match the operator's game either.
  POLLS=$(( POLLS + 1 ))
  if [ "$(( POLLS % 10 ))" = "0" ] && [ "$(date +%s%3N)" -ge "$LIVENESS_FROM_MS" ]; then
    if ! python3 "$PORT_READER" --alive --user-dir "$USER_DIR" > /dev/null; then
      if [ -n "$HOST_STDOUT" ]; then
        echo "--- host stdout tail ---" >&2
        tail -40 "$HOST_STDOUT" >&2 || true
      fi
      die "no process is running under $USER_DIR any more — the game exited before publishing a browser port"
    fi
  fi
  if [ "$(date +%s%3N)" -ge "$PORT_DEADLINE_MS" ]; then
    echo "--- host stdout tail ---" >&2
    tail -60 "${HOST_STDOUT:-/dev/null}" >&2 || true
    die "no browser port at $PORT_FILE after $(( PORT_TIMEOUT_MS / 1000 )) s. Either the mod never started its
server (check the tail above and $GAME_DATA_DIR/logs/godot.log) or it published a record written by some
other process, which this script refuses."
  fi
  sleep 0.5
done
READY_MS=$(( $(date +%s%3N) - GAME_START_MS ))
# GAME_PID is the pid the MOD published, i.e. the process actually serving the browser endpoint in this
# record — not the pid the CLI spawned, which may no longer be the same process.

# ---------------------------------------------------------------------------------------------------------
# The effective mod list
# ---------------------------------------------------------------------------------------------------------
# `game mods active` is the ground truth — it is the running ModManager's own answer, so it reports what
# LOADED rather than what was requested. It needs the bridge, hence only now; `--instance` scopes the bridge
# endpoint to this instance, so it cannot reach the operator's game. The settings.save this script wrote is
# the fallback, and the record says which one it is.
MODS_SOURCE="settings.save"
MODS_JSON=""
if timeout 30 sts2 --config "$CONFIG" --instance "$INSTANCE" --json game mods active \
    > "$RUN_DIR/mods-active.json" 2> "$RUN_DIR/mods-active.err"; then
  MODS_JSON="$(python3 -c '
import json, sys
try:
    mods = json.load(open(sys.argv[1])).get("mods") or []
except Exception:
    mods = []
rows = [
    {"id": m.get("id"), "enabled": bool(m.get("enabled")), "source": m.get("source")}
    for m in mods
    if isinstance(m, dict) and m.get("id")
]
print(json.dumps(rows) if rows else "")
' "$RUN_DIR/mods-active.json")"
  if [ -n "$MODS_JSON" ]; then
    MODS_SOURCE="sts2 game mods active"
  fi
fi
if [ -z "$MODS_JSON" ]; then
  MODS_JSON="$(python3 -c '
import json, sys
print(json.dumps(json.load(open(sys.argv[1]))["modList"]["after"]))
' "$RUN_DIR/mod-loadout.json")"
fi

# ---------------------------------------------------------------------------------------------------------
# The record — the contract the browser-join probe reads
# ---------------------------------------------------------------------------------------------------------
# Every value is passed as an ARGUMENT, never interpolated into the Python source: a device name with a
# quote in it, or an empty vulkanDevice, would otherwise produce a syntactically broken record (or worse, a
# valid one with the wrong value).
if [ -n "$RECORD" ]; then
  python3 - "$RECORD" "$INSTANCE" "$CONFIG" "$RUN_DIR" "$GS_DISPLAY" "$GS_PID" "$GS_LOG" "$VULKAN_DEVICE" \
      "$USER_DIR" "$BROWSER_PORT" "$GAME_PID" "$HOST_STDOUT" "$HOST_STDERR" "$SEAT_LOG_GLOB" \
      "$MODS_JSON" "$MODS_SOURCE" "$SETTINGS_SAVE" "$READY_MS" <<'PY'
import json, sys

(
    out, instance, config, run_dir, display, gamescope_pid, gamescope_log, vulkan_device,
    user_dir, browser_port, game_pid, host_stdout, host_stderr, seat_log_glob,
    mods_json, mods_source, settings_save, ready_ms,
) = sys.argv[1:19]

record = {
    "schema": "couchcoop-five-player-bringup/1",
    "instance": instance,
    "config": config,
    "runDir": run_dir,
    "display": display,
    "gamescopePid": int(gamescope_pid),
    "gamescopeLog": gamescope_log,
    "vulkanDevice": vulkan_device or None,
    "userDir": user_dir,
    "browserPort": int(browser_port),
    "browserBaseUrl": "http://127.0.0.1:{0}".format(int(browser_port)),
    "gamePid": int(game_pid),
    "hostStdoutPath": host_stdout or None,
    "hostStderrPath": host_stderr or None,
    "seatLogGlob": seat_log_glob,
    "mods": json.loads(mods_json),
    "modsSource": mods_source,
    "settingsSave": settings_save,
    "readyMs": int(ready_ms),
}
with open(out, "w", encoding="utf-8") as stream:
    json.dump(record, stream, indent=2)
    stream.write("\n")
PY
fi

cat <<SUMMARY
bring-up: instance $INSTANCE is up, configured for >4 players.
  DISPLAY        $GS_DISPLAY   (private gamescope, headless backend, no desktop surface)
  GPU            ${VULKAN_DEVICE:-UNKNOWN}
  browser        http://127.0.0.1:$BROWSER_PORT   (published by the mod, pid $GAME_PID, ${READY_MS} ms)
  settings.save  $SETTINGS_SAVE
  mods from      $MODS_SOURCE
  host stdout    ${HOST_STDOUT:-?}
  seat logs      $SEAT_LOG_GLOB
  cache root     $CACHE_ROOT
${RECORD:+  record         $RECORD}
Next, with the live lock still held: load a host-lobby fixture, then join browser clients at the URL above.
Tear down with:
  $REPO_ROOT/scripts/bring-up-five-player-instance.sh --instance $INSTANCE --teardown
SUMMARY
