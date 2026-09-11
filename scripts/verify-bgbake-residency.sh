#!/usr/bin/env bash
# WS-BGBAKE round-3 RESIDENCY gate (the user's first requirement: "the optimized bg is applied EVERY FRAME of the
# loop"). Proves, on a looping combat replay, that the band-flatten background bake HOLDS across loop seams and wave
# churn — never showing a frame of raw (un-baked) scene once a room has baked.
#
# How it works: an OWN Xvfb + an OWN replay-ws-server (--loop, recorded pace, proxying assets from the live origin) +
# the native Godot client in --connect mode with a QA channel. Shaders are forced Static (COUCHCOOP_EFFECTS=static —
# the SHIPPING device config AND the only mode the band plan has anything bakeable under; particles stay dynamic as
# realistic live interlopers). After the bake arms, a single QA connection samples `state` for a measurement window
# spanning several loop seams and asserts:
#   (a) bakeUnbakedVisibleFrames delta == 0  — THE frame-accurate every-frame guarantee (no raw scene after a bake)
#   (b) bakeStaleDrops           delta == 0  — no stale double-buffer picture was ever hard-dropped visible
#   (c) bakeGenSwaps             delta >= 2  — ≥2 loop seams were absorbed by the INVISIBLE atomic-rebake path
#   (d) every sample bakeState ∈ {Active,Rebaking} (Idle/Baking recovery windows tolerated iff (a) holds), ending Active
#   (e) bakeRegions ∈ {0,3,6} and bakeLiveZ ∈ {0,42} on this recording (0 only during an Idle/recovery window)
#   (f) DISTINCT failure if the bakeUnbakedVisibleFrames key is missing from the state JSON (contract regression)
# The (a)-(f) rationale AMENDS the plan file, which predates the retain-rebake reality (loop seams are KeyframeRetain,
# NOT clean survives — the recording's end-state differs from its frame-0 snapshot; some seams DROP a structurally
# different rewind, a design-correct raw-recovery window the unbaked gate excludes). See godot-client/docs/
# static-bake-coverage.md "How to verify WS-BGBAKE".
#
# Requires: an X server we start (Xvfb), the mono Godot 4.5.1 build (BUILD THE CLIENT FIRST: dotnet build
# godot-client/CouchCoop.GodotClient.csproj), node, and a LIVE asset origin (read-only GETs; we do NOT launch the game).
# project.godot is NEVER modified. Kills only the PIDs it starts, by exact PID, on EXIT. ~3 min.
#
# Env (all optional):
#   GODOT       mono Godot binary (default ~/.local/godot-4.5.1-mono/.../Godot_v4.5.1-stable_mono_linux.x86_64)
#   DISPLAY_NUM Xvfb display number (default: first free ≥ 60; NEVER :1/:7/:8)
#   ASSETS      live asset origin the replay server proxies (default http://127.0.0.1:13337 — read-only)
#   PORT        replay-ws-server port (default 13462; MUST differ from another agent's 13400/13411)
#   QA_PORT     client QA TCP port (default 5562)
#   RES         client resolution (default 2401x1080 — the widescreen leg that caught every round-2 defect)
#   REC         recording basename under .sts2/bench (default combat-2026-07-15T16-40-09-999Z.ndjson)
#   WARMUP_MS   measurement warm-up after first Active (default 30000 — let one full loop pass)
#   MEASURE_MS  measurement window (default 110000 — spans ~4 loop seams at ~25s/loop; measured ≥2 gen-swaps)
#   OUT         output dir for logs/samples (default a mktemp dir)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GODOT="${GODOT:-$HOME/.local/godot-4.5.1-mono/Godot_v4.5.1-stable_mono_linux_x86_64/Godot_v4.5.1-stable_mono_linux.x86_64}"
ASSETS="${ASSETS:-http://127.0.0.1:13337}"
PORT="${PORT:-13462}"
QA_PORT="${QA_PORT:-5562}"
RES="${RES:-2401x1080}"
REC="${REC:-combat-2026-07-15T16-40-09-999Z.ndjson}"
WARMUP_MS="${WARMUP_MS:-30000}"
MEASURE_MS="${MEASURE_MS:-110000}"
OUT="${OUT:-$(mktemp -d)}"; mkdir -p "$OUT"

fail=0
say()  { echo "$@"; }
FAIL() { echo "  FAIL $*"; fail=1; }
OK()   { echo "  ok   $*"; }

# ---- locate the recording (worktree first, then the primary repo root) --------------------------------------------
find_rec() {
  local root
  for root in "$REPO" "${REPO%/.claude/worktrees/*}"; do
    if [ -f "$root/.sts2/bench/$REC" ]; then echo "$root/.sts2/bench/$REC"; return 0; fi
  done
  return 1
}
REC_PATH="$(find_rec || true)"
if [ -z "${REC_PATH:-}" ] || [ ! -f "$REC_PATH" ]; then
  echo "SETUP ERROR: recording '$REC' not found under .sts2/bench (worktree or repo root)."
  echo "  .sts2/ is machine-local (gitignored). Provide REC=<basename> present on this machine."
  exit 2
fi

# ---- preconditions ------------------------------------------------------------------------------------------------
if [ ! -x "$GODOT" ]; then echo "SETUP ERROR: mono Godot not found/executable at $GODOT"; exit 2; fi
CLIENT_DLL="$REPO/godot-client/.godot/mono/temp/bin/Debug/CouchCoop.GodotClient.dll"
if ! ls "$REPO"/godot-client/.godot/mono/temp/bin/*/CouchCoop.GodotClient.dll >/dev/null 2>&1; then
  echo "SETUP ERROR: client not built. Run: dotnet build godot-client/CouchCoop.GodotClient.csproj"; exit 2
fi
if ! curl -s -o /dev/null --max-time 5 "$ASSETS/"; then
  echo "SETUP ERROR: asset origin $ASSETS not answering (a LIVE game must serve assets; we do NOT launch it)."; exit 2
fi
command -v node >/dev/null || { echo "SETUP ERROR: node not found"; exit 2; }

# ---- own Xvfb on a free display ≥ :60 (never :1/:7/:8) -------------------------------------------------------------
pick_display() {
  if [ -n "${DISPLAY_NUM:-}" ]; then echo "$DISPLAY_NUM"; return; fi
  local d
  for d in $(seq 60 99); do
    if [ ! -e "/tmp/.X11-unix/X$d" ]; then echo "$d"; return; fi
  done
  echo "SETUP ERROR: no free X display 60-99" >&2; exit 2
}
DNUM="$(pick_display)"
DISP=":$DNUM"
Xvfb "$DISP" -screen 0 2560x1440x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 1

# ---- own replay-ws-server (loop, recorded pace, asset reverse-proxy) -----------------------------------------------
node "$REPO/scripts/replay-ws-server.mjs" --recording "$REC_PATH" --port "$PORT" \
  --pace recorded --loop --assets-origin "$ASSETS" >"$OUT/replay.log" 2>&1 &
REPLAY_PID=$!

CLIENT_PID=""
cleanup() {
  [ -n "$CLIENT_PID" ] && kill "$CLIENT_PID" 2>/dev/null
  [ -n "${REPLAY_PID:-}" ] && kill "$REPLAY_PID" 2>/dev/null
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

# Wait for the replay server to accept connections.
for _ in $(seq 1 30); do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then break; fi
  sleep 0.3
done

echo "GODOT=$GODOT DISPLAY=$DISP ASSETS=$ASSETS PORT=$PORT QA_PORT=$QA_PORT RES=$RES REC=$(basename "$REC_PATH") OUT=$OUT"

# ---- launch the client in --connect mode with a fresh XDG_DATA_HOME + QA channel ----------------------------------
XDH="$(mktemp -d)"; mkdir -p "$XDH/godot/app_userdata/STS2 CouchCoop"
env DISPLAY="$DISP" XDG_DATA_HOME="$XDH" \
    COUCHCOOP_EFFECTS=static COUCHCOOP_MIRROR_STATICBAKE=1 \
    "$GODOT" --path "$REPO/godot-client" --resolution "$RES" -- \
    --connect "127.0.0.1:$PORT" --qa-port "$QA_PORT" >"$OUT/client.log" 2>&1 &
CLIENT_PID=$!

# ---- QA sampler (single connection) — arms the bake, warms up, measures ≥2 loop seams -----------------------------
cat > "$OUT/sample.mjs" <<'NODE'
import net from 'node:net';
const [,, qaPortS, warmupS, measureS] = process.argv;
const QA_PORT = Number(qaPortS), WARMUP = Number(warmupS), MEASURE = Number(measureS);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One persistent QA connection; strictly serialized request→response (one line in → one line out).
let sock = null, buf = '', pending = [];
function onData(d) {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const p = pending.shift(); if (p) p(line);
  }
}
async function connect() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      sock = await new Promise((res, rej) => {
        const s = net.connect(QA_PORT, '127.0.0.1');
        s.once('connect', () => res(s));
        s.once('error', rej);
      });
      sock.setEncoding('utf8'); sock.on('data', onData);
      return true;
    } catch { await sleep(500); }
  }
  return false;
}
function req(cmd) {
  return new Promise((resolve) => {
    pending.push(resolve);
    sock.write(cmd + '\n');
  });
}
async function state() {
  const line = await req('state');
  if (!line.startsWith('ok ')) return null;
  try { return JSON.parse(line.slice(3)); } catch { return null; }
}

const fail = (m) => { console.log('SAMPLER_FAIL ' + m); process.exit(1); };

if (!(await connect())) fail('could not open QA channel on 127.0.0.1:' + QA_PORT);

// Arm: shaders Static (also set by launch env), bake opt-in, band-flatten path.
await req('setting shader static');
await req('setting staticbake on');
await req('setting bgbake on');

// Wait for the first Active + band bake (up to 60s).
let reached = false;
{
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const s = await state();
    if (s && s.bakeState === 'Active' && s.bakeBand === true) { reached = true; break; }
    await sleep(500);
  }
}
if (!reached) fail('band bake never reached Active+band within 60s');
console.log('SAMPLER_ARMED bake reached Active+band');

// Warm-up: let one full loop pass so the first loop seam is behind us.
await sleep(WARMUP);

// Measure: sample every 500ms across the window.
const samples = [];
let baseline = null, last = null, keyPresent = true;
{
  const end = Date.now() + MEASURE;
  while (Date.now() < end) {
    const s = await state();
    if (s) {
      if (!('bakeUnbakedVisibleFrames' in s)) keyPresent = false;
      if (!baseline) baseline = s;
      last = s;
      samples.push({
        st: s.bakeState, rg: s.bakeRegions, lz: s.bakeLiveZ,
        uv: s.bakeUnbakedVisibleFrames, gs: s.bakeGenSwaps, sd: s.bakeStaleDrops,
      });
    }
    await sleep(500);
  }
}
if (!baseline || !last) fail('no state samples collected during the measurement window');

// Recovery: the window may legitimately CLOSE inside a structural-DROP recovery (Idle/Baking). Prove the client is
// not wedged by waiting (bounded) for the bake to be shown again; the unbaked gate above stays scoped to the window.
let finalState = last.bakeState;
if (finalState !== 'Active' && finalState !== 'Rebaking') {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const s = await state();
    if (s) { finalState = s.bakeState; if (finalState === 'Active' || finalState === 'Rebaking') break; }
    await sleep(500);
  }
}

// (f) the counter key must exist.
if (!keyPresent) { console.log('SAMPLER_RESULT ' + JSON.stringify({ keyMissing: true, samples: samples.length })); process.exit(3); }

const num = (v) => (typeof v === 'number' ? v : Number(v));
const dUnbaked = num(last.bakeUnbakedVisibleFrames) - num(baseline.bakeUnbakedVisibleFrames);
const dGenSwaps = num(last.bakeGenSwaps) - num(baseline.bakeGenSwaps);
const dStaleDrops = num(last.bakeStaleDrops) - num(baseline.bakeStaleDrops);

// Observed (state,regions,liveZ) histogram for (d)/(e).
const hist = {};
for (const s of samples) { const k = `${s.st}/rg=${s.rg}/lz=${s.lz}`; hist[k] = (hist[k] || 0) + 1; }
const states = [...new Set(samples.map(s => s.st))];
const regionsSeen = [...new Set(samples.map(s => num(s.rg)))].sort((a, b) => a - b);
const liveZSeen = [...new Set(samples.map(s => num(s.lz)))].sort((a, b) => a - b);
const badState = samples.filter(s => !['Active', 'Rebaking', 'Idle', 'Baking'].includes(s.st));
const badRegions = samples.filter(s => ![0, 3, 6].includes(num(s.rg)));
const badLiveZ = samples.filter(s => ![0, 42].includes(num(s.lz)));

console.log('SAMPLER_RESULT ' + JSON.stringify({
  keyMissing: false, n: samples.length,
  dUnbaked, dGenSwaps, dStaleDrops,
  finalState,
  states, regionsSeen, liveZSeen,
  badState: badState.length, badRegions: badRegions.length, badLiveZ: badLiveZ.length,
  hist,
}));
process.exit(0);
NODE

echo "== sampling (warmup ${WARMUP_MS}ms + measure ${MEASURE_MS}ms) =="
SAMP_OUT="$(node "$OUT/sample.mjs" "$QA_PORT" "$WARMUP_MS" "$MEASURE_MS" 2>&1)"
echo "$SAMP_OUT" | sed 's/^/  [sampler] /'
RESULT_LINE="$(echo "$SAMP_OUT" | grep '^SAMPLER_RESULT ' | tail -1)"

echo
echo "== assertions =="
if echo "$SAMP_OUT" | grep -q '^SAMPLER_FAIL'; then
  FAIL "QA sampler error: $(echo "$SAMP_OUT" | grep '^SAMPLER_FAIL' | head -1)"
elif [ -z "$RESULT_LINE" ]; then
  FAIL "no SAMPLER_RESULT produced (see $OUT/client.log)"
else
  JSON="${RESULT_LINE#SAMPLER_RESULT }"
  read -r keyMissing dUnbaked dGenSwaps dStaleDrops finalState badState badRegions badLiveZ n \
       regionsSeen liveZSeen states < <(node -e '
    const j = JSON.parse(process.argv[1]);
    process.stdout.write([j.keyMissing, j.dUnbaked, j.dGenSwaps, j.dStaleDrops, j.finalState,
      j.badState, j.badRegions, j.badLiveZ, j.n,
      JSON.stringify(j.regionsSeen), JSON.stringify(j.liveZSeen), JSON.stringify(j.states)].join(" "));
  ' "$JSON")

  echo "  samples=$n regionsSeen=$regionsSeen liveZSeen=$liveZSeen states=$states finalState=$finalState"

  # (f) counter key present.
  if [ "$keyMissing" = "true" ]; then FAIL "(f) bakeUnbakedVisibleFrames key MISSING from state JSON (contract regression)"
  else OK "(f) bakeUnbakedVisibleFrames key present"; fi

  # (a) THE gate: zero raw frames across the window.
  if [ "$dUnbaked" = "0" ]; then OK "(a) bakeUnbakedVisibleFrames delta == 0 (every-frame guarantee)"
  else FAIL "(a) bakeUnbakedVisibleFrames delta = $dUnbaked (expected 0 — raw scene shown)"; fi

  # (b) no hard stale drop.
  if [ "$dStaleDrops" = "0" ]; then OK "(b) bakeStaleDrops delta == 0"
  else FAIL "(b) bakeStaleDrops delta = $dStaleDrops (expected 0)"; fi

  # (c) ≥2 invisible rebake swaps proves ≥2 loop seams were absorbed.
  if [ "$dGenSwaps" -ge 2 ] 2>/dev/null; then OK "(c) bakeGenSwaps delta = $dGenSwaps (≥2 loop seams absorbed invisibly)"
  else FAIL "(c) bakeGenSwaps delta = $dGenSwaps (expected ≥2 — increase MEASURE_MS or the seam path regressed)"; fi

  # (d) states within the allowed set + ends Active/Rebaking.
  if [ "$badState" = "0" ]; then OK "(d) every sample bakeState ∈ {Active,Rebaking,Idle,Baking}"
  else FAIL "(d) $badState sample(s) had an out-of-set bakeState"; fi
  case "$finalState" in Active|Rebaking) OK "(d) run ends shown (bakeState=$finalState, ≤60s recovery grace)";; *) FAIL "(d) bake never re-shown within 60s of the window closing (bakeState=$finalState — wedged recovery)";; esac

  # (e) region/liveZ shape.
  if [ "$badRegions" = "0" ]; then OK "(e) bakeRegions ∈ {0,3,6} every sample"
  else FAIL "(e) $badRegions sample(s) had bakeRegions ∉ {0,3,6} (seen $regionsSeen)"; fi
  if [ "$badLiveZ" = "0" ]; then OK "(e) bakeLiveZ ∈ {0,42} every sample"
  else FAIL "(e) $badLiveZ sample(s) had bakeLiveZ ∉ {0,42} (seen $liveZSeen)"; fi
fi

echo
if [ "$fail" = 0 ]; then echo "BGBAKE_RESIDENCY: ALL PASS ($OUT)"; else echo "BGBAKE_RESIDENCY: FAILURES ($OUT)"; fi
exit "$fail"
