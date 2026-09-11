#!/usr/bin/env bash
# WS-BGBAKE round-3 PARITY gate (the user's second requirement: "the optimized bg looks EXACTLY the same as the
# unoptimized one"). Proves, on desktop, that turning the band-flatten combat background bake ON changes the rendered
# frame only within a documented, structurally-invisible budget — at BOTH the clean 16:9 width AND the 2401x1080
# widescreen width that surfaced every round-2 defect (floating trees, ember bleed-through, the stale orange HP bar,
# washed nets).
#
# Method (stretch-collapse-verify idiom): deterministic env COUCHCOOP_EFFECTS=static + COUCHCOOP_MIRROR_SPINE_FREEZE=1
# (a documented TRUE AE=0 OFF-vs-OFF floor). Per resolution ∈ {1920x1080, 2401x1080}, three single-drain --replay
# --shot legs — off-a, off-b, on — gated by:
#   * NON-VACUITY   : each shot is non-blank (image std-dev), and the ON log's settled M3_BAKE_PLAN shows the band
#                     bake actually engaged (bakeable=True band=True regions≥1) — else "AE=0" would be trivially true.
#   * DETERMINISM   : AE(off-a, off-b) == 0        — the true OFF-vs-OFF floor (precondition for any AE claim).
#   * STRUCTURAL    : AE -fuzz 20% (on vs off) == 0 — no pixel moved past a 20% tolerance (no floating tree / ember
#                     bleed / re-leveled layer): the band composites in the exact same PLACE.
#   * BRIGHTNESS    : AE -fuzz 2% (on vs off) ≤ BGBAKE_AE_BUDGET — the irreducible Sub/Mul 8-bit bake residual (a
#                     premult "over" quad of Sub/Mul content rounds to RGBA8 a hair differently than the live draw).
#                     Measured 155459 @2401 / 89302 @1920 on this recording; budgets pinned WITH headroom below.
#   * HP CROPS      : AE (on vs off) == 0 EXACT on the ally + enemy health-bar regions — the excluded-live-subtree
#                     design means the HealthBar is NEVER baked, so it must be byte-identical (this is the round-2
#                     stale-orange-bar regression's direct gate). Crop non-vacuity asserted on the OFF crop.
# PLUS a connect-mode STALENESS leg at 2401x1080 (--shot-after 26, no loop): --replay applies the whole recording as
# ONE drain so the bake plans on the FINAL state and a final-frame compare can NEVER catch HP staleness. The connect
# leg streams the HP values changing over 26s; with the HP subtree excluded from the bake, the ON HP crops must still
# match OFF (fuzz-tolerant — connect mode has weaker determinism than the single-drain --replay).
#
# Requires: an X server we start (Xvfb), the mono Godot 4.5.1 build (BUILD FIRST), ImageMagick, node, and a LIVE
# asset origin (read-only). project.godot is NEVER modified. Kills only PIDs it starts. ~10-12 min full matrix.
#
# Env (optional): GODOT, DISPLAY_NUM (≥60), ASSETS (default http://127.0.0.1:13337), REC (basename), OUT,
#   BGBAKE_AE_BUDGET_2401 (default 200000), BGBAKE_AE_BUDGET_1920 (default 120000),
#   PORT (staleness replay port base, default 13472), QA_PORT (staleness QA base, default 5572),
#   STALE_HP_FUZZ (default 5), STALE_HP_MAX_AE (default 800), SKIP_STALENESS=1 to skip the connect leg.
#   STALE_HP_MAX_AE rationale: the two staleness legs are separate LIVE runs — their --shot-after moments land on
#   different frames, so ANIMATED HP-adjacent chrome (status icons, label antialias) skews by a few hundred px
#   (measured 283 once, 0 other runs). The defect this leg guards (a stale baked HP fill — round 2's orange bar) is
#   a solid ~300x20 region ≈ 6000 px, 7x above the budget.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GODOT="${GODOT:-$HOME/.local/godot-4.5.1-mono/Godot_v4.5.1-stable_mono_linux_x86_64/Godot_v4.5.1-stable_mono_linux.x86_64}"
ASSETS="${ASSETS:-http://127.0.0.1:13337}"
REC="${REC:-combat-2026-07-15T16-40-09-999Z.ndjson}"
OUT="${OUT:-$(mktemp -d)}"; mkdir -p "$OUT"
BUDGET_2401="${BGBAKE_AE_BUDGET_2401:-200000}"
BUDGET_1920="${BGBAKE_AE_BUDGET_1920:-120000}"
STALE_PORT="${PORT:-13472}"
STALE_QA="${QA_PORT:-5572}"
STALE_HP_FUZZ="${STALE_HP_FUZZ:-5}"
STALE_HP_MAX_AE="${STALE_HP_MAX_AE:-800}"

fail=0
FAIL() { echo "  FAIL $*"; fail=1; }
OK()   { echo "  ok   $*"; }

find_rec() {
  local root
  for root in "$REPO" "${REPO%/.claude/worktrees/*}"; do
    if [ -f "$root/.sts2/bench/$REC" ]; then echo "$root/.sts2/bench/$REC"; return 0; fi
  done
  return 1
}
REC_PATH="$(find_rec || true)"
if [ -z "${REC_PATH:-}" ] || [ ! -f "$REC_PATH" ]; then
  echo "SETUP ERROR: recording '$REC' not found under .sts2/bench (worktree or repo root; .sts2 is machine-local)."; exit 2
fi
[ -x "$GODOT" ] || { echo "SETUP ERROR: mono Godot not at $GODOT"; exit 2; }
ls "$REPO"/godot-client/.godot/mono/temp/bin/*/CouchCoop.GodotClient.dll >/dev/null 2>&1 || {
  echo "SETUP ERROR: client not built. Run: dotnet build godot-client/CouchCoop.GodotClient.csproj"; exit 2; }
curl -s -o /dev/null --max-time 5 "$ASSETS/" || { echo "SETUP ERROR: asset origin $ASSETS not answering."; exit 2; }
command -v compare >/dev/null || { echo "SETUP ERROR: ImageMagick 'compare' not found"; exit 2; }
command -v node >/dev/null || { echo "SETUP ERROR: node not found"; exit 2; }

# ---- own Xvfb (free display ≥ :60) --------------------------------------------------------------------------------
pick_display() {
  if [ -n "${DISPLAY_NUM:-}" ]; then echo "$DISPLAY_NUM"; return; fi
  local d; for d in $(seq 61 99); do [ ! -e "/tmp/.X11-unix/X$d" ] && { echo "$d"; return; }; done
  echo "SETUP ERROR: no free X display 61-99" >&2; exit 2
}
DISP=":$(pick_display)"
Xvfb "$DISP" -screen 0 3200x1440x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 1
STALE_PIDS=()
cleanup() {
  for p in "${STALE_PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

echo "GODOT=$GODOT DISPLAY=$DISP ASSETS=$ASSETS REC=$(basename "$REC_PATH") OUT=$OUT"
echo "budgets: 2401=$BUDGET_2401 1920=$BUDGET_1920"

# shot <out.png> <res> <off|on>
shot() {
  local out="$1" res="$2" mode="$3"
  local xdh; xdh="$(mktemp -d)"; mkdir -p "$xdh/godot/app_userdata/STS2 CouchCoop"
  local bakeenv=()
  [ "$mode" = "on" ] && bakeenv=(COUCHCOOP_MIRROR_STATICBAKE=1)
  env DISPLAY="$DISP" XDG_DATA_HOME="$xdh" COUCHCOOP_EFFECTS=static COUCHCOOP_MIRROR_SPINE_FREEZE=1 "${bakeenv[@]}" \
    "$GODOT" --path "$REPO/godot-client" --resolution "$res" -- \
    --replay "$REC_PATH" --assets "$ASSETS" --shot "$out" \
    >"${out%.png}.log" 2>&1 || true
  rm -rf "$xdh"
}

ae()      { compare -metric AE "$1" "$2" null: 2>&1 || true; }
ae_fuzz() { compare -metric AE -fuzz "$1%" "$2" "$3" null: 2>&1 || true; }
stddev()  { convert "$1" -colorspace Gray -format '%[fx:standard_deviation]' info: 2>/dev/null || echo 0; }
gt0()     { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>b)}'; }         # a > b ?
crop()    { convert "$1" -crop "$2" +repage "$3"; }
numonly() { echo "${1%% *}"; }                                      # AE value is "<n> (<frac>)" or "<n>"

# hp geometry per resolution (recomputed at 1920 by scaling; validated non-vacuously on the OFF crop)
hp_ally()  { case "$1" in 2401x1080) echo "480x80+470+725";; *) echo "480x80+376+725";; esac; }
hp_enemy() { case "$1" in 2401x1080) echo "480x80+1640+725";; *) echo "480x80+1312+725";; esac; }

leg() { # <res> <budget>
  local res="$1" budget="$2"
  echo "== parity @ $res (budget $budget) =="
  local A="$OUT/off-a-$res.png" B="$OUT/off-b-$res.png" ON="$OUT/on-$res.png"
  shot "$A"  "$res" off
  shot "$B"  "$res" off
  shot "$ON" "$res" on

  # non-vacuity: shots exist + non-blank.
  for f in "$A" "$B" "$ON"; do
    if [ ! -s "$f" ]; then FAIL "$res: missing shot $(basename "$f")"; return; fi
  done
  local sdOff sdOn; sdOff="$(stddev "$A")"; sdOn="$(stddev "$ON")"
  if gt0 "$sdOff" 0.02 && gt0 "$sdOn" 0.02; then OK "$res non-vacuous shots (stddev off=$sdOff on=$sdOn)"
  else FAIL "$res blank/near-blank shot (stddev off=$sdOff on=$sdOn)"; fi

  # ON bake actually engaged (settled M3_BAKE_PLAN).
  local planline; planline="$(grep 'M3_BAKE_PLAN:' "${ON%.png}.log" | tail -1)"
  if echo "$planline" | grep -qE 'bakeable=True band=True regions=[1-9]'; then
    OK "$res ON band bake engaged [$planline]"
  else
    FAIL "$res ON band bake did NOT engage (last plan: ${planline:-<none>})"
  fi

  # determinism floor.
  local aOFF; aOFF="$(numonly "$(ae "$A" "$B")")"
  if [ "$aOFF" = "0" ]; then OK "$res determinism AE(off-a,off-b) == 0"
  else FAIL "$res OFF-vs-OFF AE = $aOFF (expected 0 — non-deterministic; the parity floor is broken)"; fi

  # structural (fuzz 20%).
  local aStruct; aStruct="$(numonly "$(ae_fuzz 20 "$A" "$ON")")"
  if [ "$aStruct" = "0" ]; then OK "$res structural AE -fuzz 20% == 0 (nothing moved / re-leveled)"
  else FAIL "$res structural AE -fuzz 20% = $aStruct (a layer moved — floating tree / ember bleed class)"; fi

  # brightness residual (fuzz 2%) ≤ budget; archive the diff.
  local aBright; aBright="$(numonly "$(ae_fuzz 2 "$A" "$ON")")"
  compare -metric AE -fuzz 2% "$A" "$ON" "$OUT/diff-bright-$res.png" 2>/dev/null || true
  if [ -n "$aBright" ] && awk -v a="$aBright" -v b="$budget" 'BEGIN{exit !(a<=b)}'; then
    OK "$res brightness AE -fuzz 2% = $aBright ≤ budget $budget (documented Sub/Mul 8-bit residual)"
  else FAIL "$res brightness AE -fuzz 2% = $aBright > budget $budget (see $OUT/diff-bright-$res.png)"; fi

  # HP crops EXACT (excluded live subtree — never baked).
  local geomA geomE; geomA="$(hp_ally "$res")"; geomE="$(hp_enemy "$res")"
  local offAllyC="$OUT/hp-ally-off-$res.png" onAllyC="$OUT/hp-ally-on-$res.png"
  local offEnemyC="$OUT/hp-enemy-off-$res.png" onEnemyC="$OUT/hp-enemy-on-$res.png"
  crop "$A"  "$geomA" "$offAllyC";  crop "$ON" "$geomA" "$onAllyC"
  crop "$A"  "$geomE" "$offEnemyC"; crop "$ON" "$geomE" "$onEnemyC"
  local sdAlly sdEnemy; sdAlly="$(stddev "$offAllyC")"; sdEnemy="$(stddev "$offEnemyC")"
  if gt0 "$sdAlly" 0.01; then OK "$res ally HP crop non-vacuous (stddev $sdAlly)"; else FAIL "$res ally HP crop looks empty (stddev $sdAlly) — geometry off"; fi
  if gt0 "$sdEnemy" 0.01; then OK "$res enemy HP crop non-vacuous (stddev $sdEnemy)"; else FAIL "$res enemy HP crop looks empty (stddev $sdEnemy) — geometry off"; fi
  local aAlly aEnemy; aAlly="$(numonly "$(ae "$offAllyC" "$onAllyC")")"; aEnemy="$(numonly "$(ae "$offEnemyC" "$onEnemyC")")"
  if [ "$aAlly" = "0" ]; then OK "$res ally HP crop AE == 0 (never baked)"; else FAIL "$res ally HP crop AE = $aAlly (stale-orange-bar class regression)"; fi
  if [ "$aEnemy" = "0" ]; then OK "$res enemy HP crop AE == 0 (never baked)"; else FAIL "$res enemy HP crop AE = $aEnemy (stale-bar class regression)"; fi
}

leg 1920x1080 "$BUDGET_1920"
leg 2401x1080 "$BUDGET_2401"

# ---- connect-mode STALENESS leg (2401x1080; the ONLY leg that exercises HP-staleness) -----------------------------
# --replay is one drain (bakes on the final state); a live connect stream changes HP over 26s. Excluded HP subtree
# ⇒ ON HP crops must still match OFF at the same --shot-after moment (fuzz-tolerant: weaker connect determinism).
staleness_shot() { # <out.png> <off|on> <port> <qa>
  local out="$1" mode="$2" port="$3" qa="$4"
  node "$REPO/scripts/replay-ws-server.mjs" --recording "$REC_PATH" --port "$port" \
    --pace recorded --assets-origin "$ASSETS" >"${out%.png}.replay.log" 2>&1 &
  local rp=$!; STALE_PIDS+=("$rp")
  for _ in $(seq 1 20); do curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/" && break; sleep 0.3; done
  local xdh; xdh="$(mktemp -d)"; mkdir -p "$xdh/godot/app_userdata/STS2 CouchCoop"
  local bakeenv=()
  [ "$mode" = "on" ] && bakeenv=(COUCHCOOP_MIRROR_STATICBAKE=1)
  env DISPLAY="$DISP" XDG_DATA_HOME="$xdh" COUCHCOOP_EFFECTS=static COUCHCOOP_MIRROR_SPINE_FREEZE=1 "${bakeenv[@]}" \
    "$GODOT" --path "$REPO/godot-client" --resolution 2401x1080 -- \
    --connect "127.0.0.1:$port" --qa-port "$qa" --shot-after 26 --shot "$out" \
    >"${out%.png}.log" 2>&1 || true
  kill "$rp" 2>/dev/null; rm -rf "$xdh"
}

if [ "${SKIP_STALENESS:-0}" = "1" ]; then
  echo "== staleness leg SKIPPED (SKIP_STALENESS=1) =="
else
  echo "== connect-mode staleness leg @ 2401x1080 (--shot-after 26) =="
  SOFF="$OUT/stale-off.png"; SON="$OUT/stale-on.png"
  staleness_shot "$SOFF" off "$STALE_PORT" "$STALE_QA"
  staleness_shot "$SON"  on  "$((STALE_PORT+1))" "$((STALE_QA+1))"
  if [ ! -s "$SOFF" ] || [ ! -s "$SON" ]; then
    FAIL "staleness shots missing (see $OUT/stale-*.log)"
  else
    planline="$(grep 'M3_BAKE_PLAN:' "${SON%.png}.log" | tail -1)"
    if echo "$planline" | grep -qE 'bakeable=True band=True'; then OK "staleness ON bake Active by shot moment [$planline]"
    else FAIL "staleness ON bake NOT active by shot (last plan: ${planline:-<none>})"; fi
    for side in ally enemy; do
      geom="$([ "$side" = ally ] && hp_ally 2401x1080 || hp_enemy 2401x1080)"
      crop "$SOFF" "$geom" "$OUT/stale-$side-off.png"; crop "$SON" "$geom" "$OUT/stale-$side-on.png"
      sd="$(stddev "$OUT/stale-$side-off.png")"
      gt0 "$sd" 0.01 && OK "staleness $side HP crop non-vacuous (stddev $sd)" || FAIL "staleness $side HP crop empty (stddev $sd)"
      a="$(numonly "$(ae_fuzz "$STALE_HP_FUZZ" "$OUT/stale-$side-off.png" "$OUT/stale-$side-on.png")")"
      if [ -n "$a" ] && [ "$a" -le "$STALE_HP_MAX_AE" ] 2>/dev/null; then
        OK "staleness $side HP crop AE -fuzz ${STALE_HP_FUZZ}% = $a ≤ $STALE_HP_MAX_AE (no stale bake; budget = live-run animation skew, defect class ≈ 6000)"
      else FAIL "staleness $side HP crop AE -fuzz ${STALE_HP_FUZZ}% = ${a:-?} > $STALE_HP_MAX_AE (HP baked stale — the connect-mode defect)"; fi
    done
  fi
fi

echo
if [ "$fail" = 0 ]; then echo "BGBAKE_PARITY: ALL PASS ($OUT)"; else echo "BGBAKE_PARITY: FAILURES ($OUT)"; fi
exit "$fail"
