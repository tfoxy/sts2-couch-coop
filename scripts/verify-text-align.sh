#!/usr/bin/env bash
# WS-B round-5 TEXT-ALIGNMENT gate (the user's explicit demand: a REAL automated test for combat text centring,
# not guess-and-check). Proves, on desktop, that each combat HUD count/HP label's rendered INK sits on its box centre
# (== where the GAME's own Godot Center places it) — so the round-4 "counts float ~8px above the gem" over-lift can
# never silently come back.
#
# Method (verify-bgbake-parity.sh idiom): ONE deterministic default-env --replay --shot leg at 1920x1080 (design px ==
# shot px) with COUCHCOOP_MIRROR_TEXTALIGN_DUMP=1 so the settled frame ALSO logs the streamed per-node boxes
# (M1C_TEXTALIGN json). Per target element:
#   * BOX: parsed from the M1C_TEXTALIGN json by (scene-file substring, relPath). Fallback documented: GeometryDumpProbe
#     (COUCHCOOP_GEOMDUMP_* over the same recording) prints the same boxes — used if the dump line is ever absent.
#   * INK: a central vertical-stripe bright-ink (>=200 luma; the ivory digit fill) bbox centre, robust against the
#     bright cream draw-pile card that overlaps the draw count (a per-element min-bright-px gate excludes the thin card
#     sliver). Blue/coloured pile cards fall below the luma threshold and never contaminate.
#   * ASSERT per element: |inkCentre − boxCentre| <= SELF_TOL (self-oracle: the ink is on its own box centre) AND
#     |inkCentre − committed reference| <= REF_TOL. The references are the FIXED-build measurements, which ARE the
#     native Godot-Center placement (same engine + game MSDF font + streamed box + Center as the game) — i.e. the
#     game-matching offsets. HP is the TIGHT-box / nudge-0 control: its ×1.42 bump overflows the bar box, so the
#     overflow-aware growth-centering keeps a real lift there — the fix must NOT move it (ref +1.5), which this pins.
#   * NON-VACUITY: >= MIN_ELEMENTS measured, every ink height in a sane band, and the per-element dy spread is
#     non-degenerate (stddev > 0 — guards an all-identical / blank read).
# Elements absent from the settled frame (block / star / exhaust in the canonical recording) SKIP with a warning.
#
# Requires: an X server we start (Xvfb), the mono Godot build (BUILD FIRST), python3 + PIL/Pillow, a LIVE asset origin
# (read-only). project.godot is NEVER modified. Kills only PIDs it starts.
#
# Env (optional): GODOT, DISPLAY_NUM (>=60), ASSETS (default http://127.0.0.1:13337), REC (basename, default the 37-10
#   combat twin — the richest settled frame), OUT, SELF_TOL (default 3.5), REF_TOL (default 2.0), MIN_ELEMENTS (4).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIMARY="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)")"
GODOT="${GODOT:-$HOME/.local/godot-4.5.1-mono/Godot_v4.5.1-stable_mono_linux_x86_64/Godot_v4.5.1-stable_mono_linux.x86_64}"
ASSETS="${ASSETS:-http://127.0.0.1:13337}"
REC="${REC:-combat-2026-07-15T16-37-10-241Z.ndjson}"
OUT="${OUT:-$(mktemp -d)}"; mkdir -p "$OUT"
SELF_TOL="${SELF_TOL:-3.5}"
REF_TOL="${REF_TOL:-2.0}"
MIN_ELEMENTS="${MIN_ELEMENTS:-4}"

# ---- preflight (SETUP ERROR = exit 2; never a false OK/FAIL) -------------------------------------------------------
find_rec() {
  local root
  for root in "$REPO" "$PRIMARY"; do
    if [ -f "$root/.sts2/bench/$REC" ]; then echo "$root/.sts2/bench/$REC"; return 0; fi
  done
  return 1
}
REC_PATH="$(find_rec || true)"
[ -n "${REC_PATH:-}" ] && [ -f "$REC_PATH" ] || { echo "SETUP ERROR: recording '$REC' not found under .sts2/bench (worktree/repo root; .sts2 is machine-local)."; exit 2; }
[ -x "$GODOT" ] || { echo "SETUP ERROR: mono Godot not at $GODOT"; exit 2; }
ls "$REPO"/godot-client/.godot/mono/temp/bin/*/CouchCoop.GodotClient.dll >/dev/null 2>&1 || {
  echo "SETUP ERROR: client not built. Run: dotnet build godot-client/CouchCoop.GodotClient.csproj"; exit 2; }
curl -s -o /dev/null --max-time 5 "$ASSETS/" || { echo "SETUP ERROR: asset origin $ASSETS not answering."; exit 2; }
command -v python3 >/dev/null || { echo "SETUP ERROR: python3 not found"; exit 2; }
python3 -c 'import PIL' 2>/dev/null || { echo "SETUP ERROR: python3 PIL/Pillow not importable"; exit 2; }

# ---- own Xvfb (free display >= :60) -------------------------------------------------------------------------------
pick_display() {
  if [ -n "${DISPLAY_NUM:-}" ]; then echo "$DISPLAY_NUM"; return; fi
  local d; for d in $(seq 60 99); do [ ! -e "/tmp/.X11-unix/X$d" ] && { echo "$d"; return; }; done
  echo "SETUP ERROR: no free X display 60-99" >&2; exit 2
}
DISP=":$(pick_display)"
Xvfb "$DISP" -screen 0 2200x1300x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 1
cleanup() { [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT

echo "GODOT=$GODOT DISPLAY=$DISP ASSETS=$ASSETS REC=$(basename "$REC_PATH") OUT=$OUT tol[self=$SELF_TOL ref=$REF_TOL]"

# ---- render one default-env leg with the alignment dump -----------------------------------------------------------
SHOT="$OUT/align.png"; LOG="$OUT/align.log"
xdh="$(mktemp -d)"; mkdir -p "$xdh/godot/app_userdata/STS2 CouchCoop"
env DISPLAY="$DISP" XDG_DATA_HOME="$xdh" COUCHCOOP_MIRROR_TEXTALIGN_DUMP=1 \
  "$GODOT" --path "$REPO/godot-client" --resolution 1920x1080 -- \
  --replay "$REC_PATH" --assets "$ASSETS" --shot "$SHOT" >"$LOG" 2>&1 || true
rm -rf "$xdh"
[ -s "$SHOT" ] || { echo "SETUP ERROR: shot not written (see $LOG)"; exit 2; }
grep -q 'M1C_TEXTALIGN:' "$LOG" || { echo "SETUP ERROR: no M1C_TEXTALIGN line (COUCHCOOP_MIRROR_TEXTALIGN_DUMP twin missing — stale build?)"; exit 2; }

# ---- measure + assert (python/PIL) --------------------------------------------------------------------------------
python3 - "$SHOT" "$LOG" "$SELF_TOL" "$REF_TOL" "$MIN_ELEMENTS" <<'PY'
import sys, json, re, math
from PIL import Image
shot, logp, self_tol, ref_tol, min_elems = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5])

# element: scene-file substring, relPath, ink params (half-stripe px, min bright px/row), committed reference dy,
#          and whether a missing element is a hard FAIL or a soft SKIP-with-warning.
# References = the FIXED-build ink offsets (native Godot Center == game-matching); measured round-5.
ELEMENTS = [
  # key,          scene-substr,               relPath,                         half, minpx, ref,  required
  ("energy",      "_energy_counter.tscn",     "Label",                          14,   3,   -1.0, True),
  ("draw",        "draw_pile.tscn",           "CountContainer/Count",            8,   6,   -1.0, True),
  ("discard",     "discard_pile.tscn",        "CountContainer/Count",            8,   3,   -0.5, True),
  ("hp",          "health_bar.tscn",          "HpBarContainer/HpLabel",         12,   4,   +1.5, True),   # tight-box / nudge-0 control
  ("block",       "health_bar.tscn",          "BlockContainer/BlockLabel",       6,   2,   -0.5, False),  # SKIP if absent (0 block)
  ("star",        "star_counter.tscn",        "MarginContainer/CountLabel",      8,   3,   -0.5, False),  # SKIP if absent (no stars)
  ("exhaust",     "exhaust_pile.tscn",        "CountContainer/Count",            8,   3,   -0.5, False),  # SKIP if absent (nothing exhausted)
]

m = re.search(r'M1C_TEXTALIGN:\s*(\{.*\})\s*$', open(logp).read(), re.M)
if not m:
    print("  FAIL no M1C_TEXTALIGN json in log"); sys.exit(1)
dump = json.loads(m.group(1))
# index the dumped nodes by (scene, relPath); a node may appear more than once (ally+enemy HP) -> keep a list.
nodes = {}
for n in dump.get("nodes", []):
    nodes.setdefault((n.get("scene") or "", n.get("relPath") or ""), []).append(n)

def find(scene_sub, rel):
    hits = []
    for (sc, rp), lst in nodes.items():
        if scene_sub in sc and rp == rel:
            hits += lst
    return hits

img = Image.open(shot).convert("L"); W, H = img.size; px = img.load()
def ink_dy(box, half, minpx, thresh=200, ypad=25):
    x0, y0, x1, y1 = box["minX"], box["minY"], box["maxX"], box["maxY"]
    bcx = (x0 + x1) / 2.0; bcy = (y0 + y1) / 2.0
    sx0 = max(0, int(round(bcx - half))); sx1 = min(W, int(round(bcx + half)))
    cy0 = max(0, int(round(y0)) - ypad); cy1 = min(H, int(round(y1)) + ypad)
    rows = [r for r in range(cy0, cy1) if sum(1 for c in range(sx0, sx1) if px[c, r] >= thresh) >= minpx]
    if not rows: return None
    inkcy = (rows[0] + rows[-1]) / 2.0
    return inkcy - bcy, (rows[-1] - rows[0])

fail = 0; measured = []; warns = []
for key, scene, rel, half, minpx, ref, required in ELEMENTS:
    hits = find(scene, rel)
    if not hits:
        (print(f"  ok   {key}: absent from settled frame — SKIP (soft)") if not required
         else (print(f"  FAIL {key}: REQUIRED element not in the dump ({scene} :: {rel})")))
        if required: fail = 1
        else: warns.append(key)
        continue
    for i, node in enumerate(hits):
        tag = key if len(hits) == 1 else f"{key}[{i}]"
        r = ink_dy(node["box"], half, minpx)
        if r is None:
            if required: print(f"  FAIL {tag}: no bright ink measured in box"); fail = 1
            else: print(f"  ok   {tag}: no ink (SKIP)"); warns.append(tag)
            continue
        dy, ih = r
        okself = abs(dy) <= self_tol
        okref = abs(dy - ref) <= ref_tol
        okink = 6 <= ih <= 70
        status = "ok  " if (okself and okref and okink) else "FAIL"
        if status == "FAIL": fail = 1
        print(f"  {status} {tag:10s} inkDy={dy:+5.1f} (|.|<= {self_tol}) ref={ref:+.1f} d={dy-ref:+.1f} (<= {ref_tol}) inkH={ih} text={node.get('text')!r}")
        measured.append(dy)

# non-vacuity
n = len(measured)
if n < min_elems:
    print(f"  FAIL non-vacuity: only {n} elements measured (need >= {min_elems})"); fail = 1
else:
    print(f"  ok   non-vacuity: {n} elements measured (>= {min_elems})")
if n >= 2:
    mean = sum(measured) / n
    std = math.sqrt(sum((d - mean) ** 2 for d in measured) / n)
    if std > 0.0: print(f"  ok   non-vacuity: dy spread stddev={std:.2f} > 0")
    else: print(f"  FAIL non-vacuity: dy stddev 0 (degenerate/blank read)"); fail = 1
if warns: print(f"  note: skipped (absent this frame): {', '.join(warns)}")
sys.exit(fail)
PY
rc=$?

echo
if [ "$rc" = 0 ]; then echo "TEXTALIGN: ALL PASS ($OUT)"; else echo "TEXTALIGN: FAILURES ($OUT)"; fi
exit "$rc"
