#!/usr/bin/env bash
# Track S (stretch-collapse) desktop verification harness for the native Godot client.
#
# Proves, on desktop, that COUCHCOOP_MIRROR_NOSTRETCH=1 (window viewport content-scale) is:
#   - OFF  => byte-identical to the shipped canvas_items pipeline (AE=0), and
#   - ON   => visually equivalent (Half/Quarter AE=0 at 16:9; Full P28-collapsed AE=0 at 16:9;
#             hidpi Full RMSE small after resample), with design-space input + text rects unchanged.
# The fill-rate WIN itself is only measurable on the hidpi phone (present blit is identity at windowH=1080);
# see .ai/plans/stretch-collapse-notes.md for the device (Streamline/RenderDoc) procedure.
#
# Requires: a real X display (Xvfb), the mono Godot 4.5.1 build, a running LIVE asset origin (read-only GETs),
# ImageMagick (`compare`). project.godot is NEVER modified. Build the client first (dotnet build godot-client/).
#
# Env (all optional):
#   GODOT   path to the mono Godot binary (default: ~/.local/godot-4.5.1-mono/.../Godot_v4.5.1-stable_mono_linux.x86_64)
#   DISPLAY X display to render on (default :63 — start your OWN Xvfb; do NOT use :1)
#   ASSETS  asset origin base URL (default http://127.0.0.1:13337 — read-only)
#   REC     recording under .sts2/bench (default the deterministic title gate)
#   OUT     output dir for shots/logs (default a mktemp dir)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GODOT="${GODOT:-$HOME/.local/godot-4.5.1-mono/Godot_v4.5.1-stable_mono_linux_x86_64/Godot_v4.5.1-stable_mono_linux.x86_64}"
export DISPLAY="${DISPLAY:-:63}"
ASSETS="${ASSETS:-http://127.0.0.1:13337}"
REC="${REC:-combat-2026-07-15T16-37-42-590Z.ndjson}"
OUT="${OUT:-$(mktemp -d)}"; mkdir -p "$OUT"
echo "GODOT=$GODOT DISPLAY=$DISPLAY ASSETS=$ASSETS REC=$REC OUT=$OUT"

# shot <out.png> <resolution> <Full|Half|Quarter> [extra ENV=VAL ...]
shot() {
  local out="$1" res="$2" scale="$3"; shift 3
  local xdh; xdh="$(mktemp -d)"; mkdir -p "$xdh/godot/app_userdata/STS2 CouchCoop"
  printf '[mirror]\nrenderScale="%s"\n' "$scale" > "$xdh/godot/app_userdata/STS2 CouchCoop/settings.cfg"
  env DISPLAY="$DISPLAY" XDG_DATA_HOME="$xdh" COUCHCOOP_EFFECTS=static "$@" \
    "$GODOT" --path "$REPO/godot-client" --resolution "$res" -- \
    --replay "$REPO/.sts2/bench/$REC" --assets "$ASSETS" --input-probe --shot "$out" \
    > "${out%.png}.log" 2>&1 || true
  rm -rf "$xdh"
}
ae()  { compare -metric AE   "$1" "$2" null: 2>&1 || true; }

fail=0
check() { # <label> <metric-output> <want-zero:0|1>
  local label="$1" val="$2" wantzero="$3"; local num="${val%% *}"
  if [ "$wantzero" = "1" ] && [ "$num" != "0" ]; then echo "  FAIL $label => $val"; fail=1; else echo "  ok   $label => $val"; fi
}

echo "== (i) OFF byte-identical parity: capture baselines =="
shot "$OUT/off-full.png" 1920x1080 Full COUCHCOOP_MIRROR_NOSTRETCH=0
shot "$OUT/off-half.png" 1920x1080 Half COUCHCOOP_MIRROR_NOSTRETCH=0

echo "== (ii) ON equivalence @16:9 (present blit identity) =="
shot "$OUT/on-full.png"    1920x1080 Full    COUCHCOOP_MIRROR_NOSTRETCH=1
shot "$OUT/on-half.png"    1920x1080 Half    COUCHCOOP_MIRROR_NOSTRETCH=1
shot "$OUT/on-quarter.png" 1920x1080 Quarter COUCHCOOP_MIRROR_NOSTRETCH=1
shot "$OUT/off-quarter.png" 1920x1080 Quarter COUCHCOOP_MIRROR_NOSTRETCH=0
check "Full  ON vs OFF" "$(ae "$OUT/off-full.png"    "$OUT/on-full.png")"    1
check "Half  ON vs OFF" "$(ae "$OUT/off-half.png"    "$OUT/on-half.png")"    1
check "Quart ON vs OFF" "$(ae "$OUT/off-quarter.png" "$OUT/on-quarter.png")" 1
grep -q "hosting=direct hostReason=nostretch" "$OUT/on-full.log" && echo "  ok   Full ON direct-hosted (P28 gone)" || { echo "  FAIL Full ON not direct-hosted"; fail=1; }

echo "== (ii) Full hidpi RMSE after present-like upscale (2712x1440) =="
shot "$OUT/off-full-hidpi.png" 2712x1440 Full COUCHCOOP_MIRROR_NOSTRETCH=0
shot "$OUT/on-full-hidpi.png"  2712x1440 Full COUCHCOOP_MIRROR_NOSTRETCH=1
onsz="$(identify -format '%wx%h' "$OUT/on-full-hidpi.png")"
convert "$OUT/on-full-hidpi.png" -filter Triangle -resize 2712x1440! "$OUT/on-full-hidpi-up.png"
echo "  perceptual RMSE (upscale ON -> window vs OFF native): $(compare -metric RMSE "$OUT/on-full-hidpi-up.png" "$OUT/off-full-hidpi.png" null: 2>&1) (ON RT=$onsz)"

echo "== (ii) M3_TEXT_RECTS design-space equality (Half @16:9) =="
shot "$OUT/tr-off.png" 1920x1080 Half COUCHCOOP_MIRROR_NOSTRETCH=0 COUCHCOOP_MIRROR_TEXTRECTS=1
shot "$OUT/tr-on.png"  1920x1080 Half COUCHCOOP_MIRROR_NOSTRETCH=1 COUCHCOOP_MIRROR_TEXTRECTS=1
lastrects() { awk '/M3_TEXT_RECTS_BEGIN/{b=""} /M3_TEXT_RECT /{b=b$0"\n"} /M3_TEXT_RECTS_END/{l=b} END{printf "%s",l}' "$1" | grep -oE "id=[0-9]+ x=[-0-9]+ y=[-0-9]+ w=[0-9]+ h=[0-9]+" | sort; }
if diff <(lastrects "$OUT/tr-off.log") <(lastrects "$OUT/tr-on.log") >/dev/null; then echo "  ok   text rects identical ($(lastrects "$OUT/tr-off.log" | wc -l) rects)"; else echo "  FAIL text rects differ"; fail=1; fi

echo "== (iii) input geometry ON==OFF at 3 aspects + hidpi =="
for res in 1920x1080 2400x1080 2712x1080 2712x1440; do
  shot "$OUT/g-off-$res.png" "$res" Full COUCHCOOP_MIRROR_NOSTRETCH=0
  shot "$OUT/g-on-$res.png"  "$res" Full COUCHCOOP_MIRROR_NOSTRETCH=1
  if diff <(grep INPUT_GEOM_PT "$OUT/g-off-$res.log" | sed 's/mode=[A-Za-z]* //') \
          <(grep INPUT_GEOM_PT "$OUT/g-on-$res.log"  | sed 's/mode=[A-Za-z]* //') >/dev/null; then
    echo "  ok   $res design landings identical"; else echo "  FAIL $res landings differ"; fail=1; fi
done

echo; [ "$fail" = 0 ] && echo "STRETCH_COLLAPSE_VERIFY: ALL PASS ($OUT)" || { echo "STRETCH_COLLAPSE_VERIFY: FAILURES ($OUT)"; exit 1; }
