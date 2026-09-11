#!/usr/bin/env node
// Generate a FULLY SYNTHETIC card-flight / trail benchmark fixture in the recorder's NDJSON format
// (scripts/record-mirror-stream.mjs), so `scripts/bench-mirror-replay.mjs` replays it unchanged.
//
//   node scripts/make-flight-fixture.mjs --n 30 --kind shuffle
//   node scripts/make-flight-fixture.mjs --n 3 --kind mixed --waves 2 --out .sts2/bench/synth/three.ndjson
//
// WHY SYNTHETIC AND NOT RECORDED
// ------------------------------
// The R15 question is "what does the client pay per flying card", and a recording answers it only at whichever N
// the host happened to shuffle. A generator makes N the independent variable: the same stream shape at 1, 3, 5, 30
// cards, with the stagger / arc / flight timing pinned, so a matrix cell differs from its neighbour in exactly one
// thing. It is also the only form of this fixture that can be COMMITTED — a recording is a captured wire payload
// (artifact policy), while this file emits programmatic payloads whose only game-derived content is node type/name
// strings and one resource path, the same material the committed specs below already carry.
//
// SOURCE OF TRUTH FOR THE PAYLOAD SHAPE (do not re-derive it from a recording — read these):
//   * frontend/src/mirror/__tests__/trailMassDiet.spec.ts (`moverNode` / `cardNodes` / `hint`, and the minimal
//     valid scene-delta envelope) — the per-card subtree and the hint field set.
//   * frontend/src/mirror/__tests__/flightVfxDiet.spec.ts — the fuller `Sprites` branch (particle emitters).
// This generator emits the FULL nine-node trail subtree (both emitters AND both silhouettes) where those specs
// trim to one of each: the point of the fixture is the compositor/canvas breadth a real card drags with it.
//
// WHAT ONE CARD IS ON THE WIRE (10 upserts):
//   f<i>                        the MOVER. "shuffle" flies a throwaway `NCardFlyShuffleVfx`; "discard" flies the
//                               real `NCard` the player just played (and turns out of `rot0`).
//   t<i>                        `NCardTrailVfx` — the comet root. The client DRIVES this node for the flight.
//   t<i>-Trails                   `Node2D` group
//   t<i>-outer / t<i>-inner       the two `NCardTrail` strokes (blend 1). Their GLOBAL transform is the identity —
//                                 the game world-pins them every frame — which is why they are emitted at (0,0)
//                                 while everything else in the subtree is parked at the flight's start point.
//   t<i>-Sprites                  `Node2D` group
//   t<i>-sparks / t<i>-sparks2    `CpuParticles2D` (amount 64, blend 1) — the decorative garnish
//   t<i>-glint / t<i>-glint2      `Sprite2D` silhouettes (blend 1)
//
// STREAM SHAPE
//   t=0     `{"type":"session","directView":true}` — the bench's own fake-WS join reply verbatim, so the mirror
//           leaves the join picker without the harness having to synthesize one.
//   t=50    the full keyframe: `Game` root + `--filler` inert Node2D on a deterministic grid. The filler clears the
//           bench's readiness gate (`.mirror-node > 50`) and gives the walk realistic breadth to re-derive.
//   t_i     per card i, ONE `full:false` delta carrying the card's 10 spawn upserts (parked at its start anchor),
//           the FULL updated `orderedIds`, and `cardFlights:[hint_i]`. Spawn and hint ride the same delta because
//           the renderer arms flights AFTER the walk within one reconcile (mirrorRenderer's `applyCardFlights` is
//           called at the end of the reconcile), so the record always exists by then.
//   +window the producer's settle re-emit: a VOLATILE upsert (no `name`, so `mergeNode` takes the merge branch)
//           putting the mover and the trail root at the landed pose, exactly as the host does when its suppression
//           window closes.
//   +400    teardown: `removedIds` for the whole subtree + the shortened `orderedIds`, so `--waves` can volley
//           again without the scene accumulating and so the trail pool actually gets its release path exercised.
//
// DETERMINISM is a contract: same params + same seed ⇒ byte-identical output, except the `recordedAt` stamp.
// Everything random (endpoint jitter, arc height) comes from one seeded mulberry32 drawn in a fixed order.
//
// TUNED DEFAULTS (measured, not guessed — R15 WP-A gate 3, against a real 30-card reshuffle replay)
// -------------------------------------------------------------------------------------------------
// Two defaults were moved off their first-draft values because the fixture landed in a different REGIME from the
// real thing, and a benchmark in the wrong regime measures the wrong pipeline:
//   * `--stagger-ms` 60 -> 40. A trail outlives its card by the point lifetime (0.8s), so a volley only ever has
//     all N comets in the air at once if it finishes inside that. At 60ms the 30th card armed after the 1st had
//     already collapsed (peak 52 of 60 strokes); the reference replay's own volley reaches exactly 2N. 40ms is
//     also the reference's measured card-to-card cadence.
//   * `--filler` 120 -> 2800. Trail repaints are rAF-driven under a 30Hz cap, so how many a flight scores depends
//     on how many frames the page can actually deliver — and a 120-node page delivers ~68Hz where a real combat
//     scene (~3.1k rendered nodes) delivers ~42-46Hz. Matching the node breadth is what brings paints-per-flight
//     inside the gate's 2x band (1.7x, from 2.0x) instead of measuring an unrealistically idle client.
// Both are plain CLI knobs: pass `--stagger-ms 60 --filler 120` to reproduce the first-draft stream exactly.
//
// KNOWN DIFFERENCES from a live reshuffle (deliberate; state them before drawing conclusions from absolute numbers):
//   * structural deltas here carry the FULL `orderedIds` array, where the live producer ships an `orderPatch`
//     (the Stage 4 wire diet). Same walk classification either way (both hand the client a new array reference);
//     the fixture just pays more parse per delta.
//   * the arc defaults are the committed specs' geometry. A live shuffle sweeps a wider, taller arc, which means
//     a bigger ribbon bbox per stroke — raise `--arc-height` / widen `--start`/`--end` when the question being
//     asked is about fill cost rather than about per-card scaling.
//   * trail repaints are frame-bound, and an idle desktop page delivers ~65Hz where a live combat replay delivers
//     ~30-42Hz. So repaints-per-flight is a reading of the HOST BOX as much as of the stream: at a matched frame
//     rate (`COUCHCOOP_CPU_THROTTLE=3`, measured 41Hz vs the replay's 42Hz) it sits 1.8x the replay's, and
//     unthrottled 2.0-2.6x. Compare cells to each other at one throttle setting; never across.
//   * every card here flies inside one volley, so the mass diet is armed for essentially every paint. A live
//     recording mixes small sub-volleys that stay BELOW the diet threshold — that regime is what `--n 3` / `--n 5`
//     fixtures are for, and it is why the matrix sweeps N rather than trusting one fixture.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------

const HELP = `make-flight-fixture.mjs — synthesize a card-flight/trail bench fixture (recorder NDJSON)

  --n <count>            cards in the volley (default 30)
  --kind <k>             shuffle | discard | mixed (default shuffle; mixed alternates, even i = shuffle)
  --seed <int>           PRNG seed for the fan-out jitter (default 1)
  --stagger-ms <ms>      gap between consecutive cards' hints (default 40 — see TUNED DEFAULTS)
  --pre-ms <ms>          quiet time between the keyframe and the first hint (default 800)
  --post-ms <ms>         quiet tail after the last teardown (default 1500)
  --duration <t>         flight duration in the game's pseudo-time unit (default 1.4)
  --speed0 <v>           initial pseudo-time rate (default 1.18)
  --accel <a>            pseudo-time acceleration (default 2.3)
  --window-ms <ms>       producer suppression window / client pin (default 3600)
  --scale0 <s>           mover's spawn scale (default 1)
  --start <x,y>          arc start anchor in design space (default 300,880)
  --end <x,y>            arc end anchor (default 1620,880)
  --arc-height <px>      bezier control lift above the start/end midpoint (default 220)
  --jitter <px>          per-card endpoint jitter, +/- (default 40); arc height jitters +/-25%
  --filler <count>       inert Node2D in the keyframe (default 2800 — see TUNED DEFAULTS)
  --waves <count>        repeat the whole volley this many times (default 1)
  --wave-gap-ms <ms>     spacing between wave starts (default 4500)
  --teardown <on|off>    remove each card's subtree 400ms after its window closes (default on)
  --out <path>           output file (default .sts2/bench/synth/flight-n<N>-<kind>-<hash8>.ndjson)

The meta line carries derived.params + derived.suggestedWindow, so the fixture documents itself and a bench run
can be reproduced from the file alone.`;

function parseArgs(argv) {
  const a = {
    n: 30,
    kind: "shuffle",
    seed: 1,
    staggerMs: 40,
    preMs: 800,
    postMs: 1500,
    duration: 1.4,
    speed0: 1.18,
    accel: 2.3,
    windowMs: 3600,
    scale0: 1,
    start: [300, 880],
    end: [1620, 880],
    arcHeight: 220,
    jitter: 40,
    filler: 2800,
    waves: 1,
    waveGapMs: 4500,
    teardown: true,
    out: null,
    help: false
  };
  const point = (raw, flag) => {
    const parts = String(raw).split(",").map((s) => Number(s.trim()));
    if (parts.length !== 2 || !parts.every(Number.isFinite)) {
      fail(`--${flag} wants "x,y" (got '${raw}')`);
    }
    return parts;
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${key} needs a value`);
      return v;
    };
    switch (key) {
      case "--n": a.n = Number(val()); break;
      case "--kind": a.kind = val(); break;
      case "--seed": a.seed = Number(val()); break;
      case "--stagger-ms": a.staggerMs = Number(val()); break;
      case "--pre-ms": a.preMs = Number(val()); break;
      case "--post-ms": a.postMs = Number(val()); break;
      case "--duration": a.duration = Number(val()); break;
      case "--speed0": a.speed0 = Number(val()); break;
      case "--accel": a.accel = Number(val()); break;
      case "--window-ms": a.windowMs = Number(val()); break;
      case "--scale0": a.scale0 = Number(val()); break;
      case "--start": a.start = point(val(), "start"); break;
      case "--end": a.end = point(val(), "end"); break;
      case "--arc-height": a.arcHeight = Number(val()); break;
      case "--jitter": a.jitter = Number(val()); break;
      case "--filler": a.filler = Number(val()); break;
      case "--waves": a.waves = Number(val()); break;
      case "--wave-gap-ms": a.waveGapMs = Number(val()); break;
      case "--teardown": a.teardown = val() !== "off"; break;
      case "--out": a.out = val(); break;
      case "--help": case "-h": a.help = true; break;
      default: fail(`Unknown argument: ${key}`);
    }
  }
  return a;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

if (!["shuffle", "discard", "mixed"].includes(args.kind)) {
  fail(`--kind must be shuffle | discard | mixed (got '${args.kind}')`);
}
for (const [flag, v, min] of [
  ["--n", args.n, 1],
  ["--waves", args.waves, 1],
  ["--filler", args.filler, 0],
  ["--stagger-ms", args.staggerMs, 0],
  ["--pre-ms", args.preMs, 0],
  ["--post-ms", args.postMs, 0],
  ["--jitter", args.jitter, 0],
  ["--wave-gap-ms", args.waveGapMs, 0]
]) {
  if (!Number.isFinite(v) || v < min) fail(`${flag} must be a finite number >= ${min} (got '${v}')`);
}
// The strict client-side parser (sceneTree.ts `parseCardFlight`) DROPS a hint whose integrator scalars can't run,
// and a dropped hint leaves its nodes frozen rather than merely un-eased. Refuse to write a fixture that would be
// rejected, here, where the message can name the flag.
for (const [flag, v] of [["--duration", args.duration], ["--speed0", args.speed0], ["--window-ms", args.windowMs]]) {
  if (!Number.isFinite(v) || v <= 0) fail(`${flag} must be > 0 — the client's flight parser rejects the hint otherwise (got '${v}')`);
}
if (!Number.isFinite(args.accel)) fail(`--accel must be finite (got '${args.accel}')`);
if (!Number.isFinite(args.scale0) || Math.abs(args.scale0) <= 1e-6) {
  fail(`--scale0 must be non-zero — phase 2 divides by it (got '${args.scale0}')`);
}
if (!Number.isFinite(args.arcHeight)) fail(`--arc-height must be finite (got '${args.arcHeight}')`);

// ---------------------------------------------------------------------------------------------------------
// params identity — the fixture's name and its self-description
// ---------------------------------------------------------------------------------------------------------

// Everything that changes a BYTE of the stream, with stable key order so the hash is stable. `out` is excluded:
// it is derived FROM this hash, and a fixture written to two paths is the same fixture.
const params = {
  n: args.n,
  kind: args.kind,
  seed: args.seed,
  staggerMs: args.staggerMs,
  preMs: args.preMs,
  postMs: args.postMs,
  duration: args.duration,
  speed0: args.speed0,
  accel: args.accel,
  windowMs: args.windowMs,
  scale0: args.scale0,
  start: args.start,
  end: args.end,
  arcHeight: args.arcHeight,
  jitter: args.jitter,
  filler: args.filler,
  waves: args.waves,
  waveGapMs: args.waveGapMs,
  teardown: args.teardown
};
const paramHash = createHash("sha1").update(JSON.stringify(params)).digest("hex").slice(0, 8);

// The bench holds everything (including the measured window's open) until the page renders >50 `.mirror-node`
// elements, and only the keyframe is on screen by then. A fixture that can't clear that on its keyframe alone
// still runs, but its window opens late — mid-volley — which silently truncates every counter in it.
if (1 + args.filler <= 50) {
  console.error(
    `warning: --filler ${args.filler} leaves a ${1 + args.filler}-node keyframe; bench-mirror-replay waits for ` +
      ">50 .mirror-node before opening its window, so the bracket will open late. Use --filler 60 or more."
  );
}
const outPath = resolve(REPO_ROOT, args.out ?? `.sts2/bench/synth/flight-n${args.n}-${args.kind}-${paramHash}.ndjson`);

// ---------------------------------------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------------------------------------

// mulberry32 — 32-bit, seedable, and identical in every JS engine, which is what makes the fixture reproducible
// on any box from `--seed` alone.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

// The client's integrator advances the game's pseudo-time as `time += speed*dt` with `speed += accel*dt`, so the
// flight lands when `speed0*s + accel*s^2/2 == duration`. Solving it here is what lets the meta state an honest
// `suggestedWindow` — a window that closed at the last HINT would miss most of the flying.
function flightWallMs(speed0, accel, duration) {
  if (Math.abs(accel) < 1e-9) {
    return (duration / speed0) * 1000;
  }
  const disc = speed0 * speed0 + 2 * accel * duration;
  if (disc < 0) {
    return (duration / speed0) * 1000; // decelerating past a stop — treat as linear rather than emit NaN
  }
  return ((-speed0 + Math.sqrt(disc)) / accel) * 1000;
}

const FLIGHT_MS = flightWallMs(args.speed0, args.accel, args.duration);

const rnd = mulberry32(args.seed);
const jit = (amount) => (rnd() * 2 - 1) * amount;

// One card's arc. Drawn in a FIXED order (start.x, start.y, end.x, end.y, arcHeight) so adding a card never
// re-rolls the ones before it, and so wave 2's fan differs from wave 1's exactly as a second real reshuffle would.
function makeArc() {
  const start = [round2(args.start[0] + jit(args.jitter)), round2(args.start[1] + jit(args.jitter))];
  const end = [round2(args.end[0] + jit(args.jitter)), round2(args.end[1] + jit(args.jitter))];
  const lift = args.arcHeight * (1 + jit(0.25));
  const control = [round2((start[0] + end[0]) / 2), round2((start[1] + end[1]) / 2 - lift)];
  return { start, end, control };
}

// The mover's landed pose: the bezier's own endpoint, i.e. where the settle re-emit must put it (the producer
// re-states the true transform once its suppression window closes).
const kindOf = (i) => (args.kind === "mixed" ? (i % 2 === 0 ? "shuffle" : "discard") : args.kind);

// ---------------------------------------------------------------------------------------------------------
// wire payloads — see the spec files named at the top; these are those builders as plain JS
// ---------------------------------------------------------------------------------------------------------

const xf = (tx, ty) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });
const CARD_BOX = { position: { x: 0, y: 0 }, size: { x: 100, y: 140 } };
const SPARK_TEXTURE = "res://images/packed/vfx/small_card_silhouette.png";

const ROOT_ID = "Game";

function rootNode() {
  return {
    id: ROOT_ID,
    parentId: null,
    name: "Game",
    nodeType: "Godot.Control",
    visible: true,
    transform: xf(0, 0),
    localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } }
  };
}

// Inert breadth. A deterministic grid across the 1920x1080 design box: enough elements that the walk has a real
// tree to re-derive (and that the bench's `.mirror-node > 50` readiness gate is cleared by the keyframe alone),
// with nothing on them that paints, animates or fetches.
function fillerNodes(count) {
  const nodes = [];
  if (count <= 0) return nodes;
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * (1920 / 1080))));
  const rows = Math.max(1, Math.ceil(count / cols));
  const dx = 1920 / cols;
  const dy = 1080 / rows;
  for (let k = 0; k < count; k++) {
    const col = k % cols;
    const row = Math.floor(k / cols);
    nodes.push({
      id: `bg${k}`,
      parentId: ROOT_ID,
      name: `Filler${k}`,
      nodeType: "Godot.Node2D",
      visible: true,
      transform: xf(round2(col * dx + 8), round2(row * dy + 8)),
      localRect: { position: { x: 0, y: 0 }, size: { x: round2(dx * 0.75), y: round2(dy * 0.6) } }
    });
  }
  return nodes;
}

function moverNode(i, kind, at) {
  return kind === "discard"
    ? { id: `f${i}`, parentId: ROOT_ID, name: "Card", nodeType: "NCard", visible: true, transform: xf(at[0], at[1]), localRect: CARD_BOX }
    : {
        id: `f${i}`,
        parentId: ROOT_ID,
        name: "VfxCardFlyShuffle",
        nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardFlyShuffleVfx",
        visible: true,
        transform: xf(at[0], at[1]),
        localRect: CARD_BOX
      };
}

function sparkNode(id, parentId, name, at) {
  return {
    id,
    parentId,
    name,
    nodeType: "Godot.CpuParticles2D",
    visible: true,
    transform: xf(at[0], at[1]),
    canvasBlendMode: 1,
    particleSpec: {
      kind: "CPUParticles2D",
      amount: 64,
      lifetime: 1,
      oneShot: false,
      scaleMin: 1,
      scaleMax: 1,
      emissionShape: 0,
      texture: { resourcePath: SPARK_TEXTURE, resourceType: "Texture2D", resourceName: "" },
      blendMode: 1
    },
    particleEmitting: true
  };
}

// The 10 upserts one card puts on the wire, in PRE-ORDER (parents before children) — `orderedIds` is flattened in
// this order and `rebuildStructure` reads it as the tree.
function cardNodes(i, kind, at) {
  const t = `t${i}`;
  return [
    moverNode(i, kind, at),
    { id: t, parentId: ROOT_ID, name: "CardTrailIronclad", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx", visible: true, transform: xf(at[0], at[1]) },
    { id: `${t}-Trails`, parentId: t, name: "Trails", nodeType: "Godot.Node2D", visible: true, transform: xf(at[0], at[1]) },
    // The two strokes are world-pinned by the game every frame, so their GLOBAL transform is the identity and the
    // element's own local space IS design space — the fact the whole client-side ribbon synthesis rests on.
    { id: `${t}-outer`, parentId: `${t}-Trails`, name: "OuterTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(0, 0), canvasBlendMode: 1 },
    { id: `${t}-inner`, parentId: `${t}-Trails`, name: "InnerTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(0, 0), canvasBlendMode: 1 },
    { id: `${t}-Sprites`, parentId: t, name: "Sprites", nodeType: "Godot.Node2D", visible: true, transform: xf(at[0], at[1]) },
    sparkNode(`${t}-sparks`, `${t}-Sprites`, "BigSparks", at),
    sparkNode(`${t}-sparks2`, `${t}-Sprites`, "LittleSparks", at),
    { id: `${t}-glint`, parentId: `${t}-Sprites`, name: "Sprite2D2", nodeType: "Godot.Sprite2D", visible: true, transform: xf(at[0], at[1]), localRect: CARD_BOX, canvasBlendMode: 1 },
    { id: `${t}-glint2`, parentId: `${t}-Sprites`, name: "Sprite2D3", nodeType: "Godot.Sprite2D", visible: true, transform: xf(at[0], at[1]), localRect: CARD_BOX, canvasBlendMode: 1 }
  ];
}

// The teardown's `removedIds`, derived FROM the builder rather than re-listed — a hand-kept second list is how a
// subtree ends up half-removed the day someone adds a node to the comet.
function cardIds(i) {
  return cardNodes(i, "shuffle", [0, 0]).map((n) => n.id);
}

// Every field the strict parser requires, with the two lenient ones (`kind`, `rot0`) stated explicitly anyway —
// a fixture that leans on a fail-open would stop testing the thing it is named after.
function hint(i, arc, kind) {
  return {
    targetId: `f${i}`,
    trailId: `t${i}`,
    start: arc.start,
    end: arc.end,
    control: arc.control,
    basis: [1, 0, 0, 1],
    speed0: args.speed0,
    accel: args.accel,
    duration: args.duration,
    scale0: args.scale0,
    windowMs: args.windowMs,
    kind,
    rot0: kind === "discard" ? -0.35 : 0
  };
}

// A VOLATILE upsert: no `name`, so the client's `mergeNode` takes its merge branch and keeps the retained static
// fields — which is exactly what the producer's own settle re-emit looks like on the wire.
function volatileUpsert(id, parentId, at, withBox) {
  const u = { id, parentId, transform: xf(at[0], at[1]), visible: true };
  if (withBox) u.localRect = CARD_BOX;
  return u;
}

const SCREEN_TYPE = "combat";
const SCREEN_INSTANCE = "synth-1";

function delta(fields) {
  return {
    type: "scene-delta",
    full: false,
    screenType: SCREEN_TYPE,
    screenInstanceId: SCREEN_INSTANCE,
    upserts: [],
    removedIds: [],
    ...fields
  };
}

// ---------------------------------------------------------------------------------------------------------
// stream assembly
// ---------------------------------------------------------------------------------------------------------

const KEYFRAME_MS = 50;

const keyframeNodes = [rootNode(), ...fillerNodes(args.filler)];
const liveIds = keyframeNodes.map((n) => n.id);

// Build the event list first (each event knows its time and what it needs to do), then sort by (t, seq) and
// realize the payloads in time order — `orderedIds` and `removedIds` must describe the scene AS OF that instant,
// and spawns/settles/teardowns from different cards interleave.
const events = [];
let seq = 0;
const at = (t, run) => events.push({ t: Math.round(t), seq: seq++, run });

let firstHintT = null;
let lastLandT = 0;
// PER-WAVE brackets, same shape as `suggestedWindow` (which spans ALL waves). A multi-wave run is the only way
// to price a mechanism whose state is WARMED by an earlier volley — gsw's encoded-still cache is module-scoped
// and dies with the document, and the bench reloads the page per repeat, so wave 1 is always cold and wave 2 is
// the steady state. Windowing "the fixture" would average the two and report neither.
const waveSpans = [];

for (let w = 0; w < args.waves; w++) {
  const waveBase = KEYFRAME_MS + args.preMs + w * args.waveGapMs;
  for (let c = 0; c < args.n; c++) {
    const i = w * args.n + c; // ids are unique across waves: a torn-down card never comes back as itself
    const kind = kindOf(c);
    const arc = makeArc();
    const spawnT = waveBase + c * args.staggerMs;
    if (firstHintT == null) firstHintT = spawnT;
    lastLandT = Math.max(lastLandT, spawnT + FLIGHT_MS);
    const span = (waveSpans[w] ??= { first: spawnT, last: 0 });
    span.first = Math.min(span.first, spawnT);
    span.last = Math.max(span.last, spawnT + FLIGHT_MS);

    at(spawnT, () => {
      const nodes = cardNodes(i, kind, arc.start);
      for (const n of nodes) liveIds.push(n.id);
      return delta({ upserts: nodes, orderedIds: liveIds.slice(), cardFlights: [hint(i, arc, kind)] });
    });

    // The producer's settle re-emit, one window after the hint: the nodes it stopped streaming get their true
    // (landed) pose back. The client releases its pin one frame later, so this is the frame that must not
    // teleport the card — which is why the pose here is the arc's own endpoint.
    at(spawnT + args.windowMs, () =>
      delta({
        upserts: [
          volatileUpsert(`f${i}`, ROOT_ID, arc.end, true),
          volatileUpsert(`t${i}`, ROOT_ID, arc.end, false)
        ]
      })
    );

    if (args.teardown) {
      at(spawnT + args.windowMs + 400, () => {
        const ids = cardIds(i);
        const gone = new Set(ids);
        for (let k = liveIds.length - 1; k >= 0; k--) {
          if (gone.has(liveIds[k])) liveIds.splice(k, 1);
        }
        return delta({ removedIds: ids, orderedIds: liveIds.slice() });
      });
    }
  }
}

events.sort((a, b) => a.t - b.t || a.seq - b.seq);

const records = [
  // The bench's fake WS replies to a `join` with exactly this string; putting it IN the stream makes the
  // recording's own pre-scan see `hasRecordedDirectView`, so no synthesized session is layered on top.
  { t: 0, data: '{"type":"session","directView":true}' },
  {
    t: KEYFRAME_MS,
    data: JSON.stringify({
      type: "scene-delta",
      full: true,
      screenType: SCREEN_TYPE,
      screenInstanceId: SCREEN_INSTANCE,
      upserts: keyframeNodes,
      removedIds: [],
      orderedIds: keyframeNodes.map((n) => n.id),
      hints: [],
      cardFlights: []
    })
  }
];
for (const e of events) {
  records.push({ t: e.t, data: JSON.stringify(e.run()) });
}

// A quiet tail, and the message that makes `durationMs` honest: the last flight event plus `--post-ms`. The bench
// drains the stream to the end before its post-window probes, so the tail is also what "settled" means here.
const tailT = records[records.length - 1].t + args.postMs;
records.push({ t: tailT, data: JSON.stringify(delta({})) });

// firstHintT-100 opens the bracket just before the first hint (never on it — the harness polls the crossing at rAF
// resolution); lastLandT+300 closes it after the last card has landed and its ribbon has begun collapsing.
const suggestedWindow = [Math.max(0, Math.round(firstHintT - 100)), Math.round(lastLandT + 300)];
// Each wave's own bracket, opened and closed by the same rule as `suggestedWindow`. Pass one of these to the
// bench's `--window` to price a single volley: `waveWindows[0]` is the COLD one (nothing cached yet) and the
// last is the warm steady state.
const waveWindows = waveSpans.map((s) => [Math.max(0, Math.round(s.first - 100)), Math.round(s.last + 300)]);

const bytes = records.reduce((n, r) => n + Buffer.byteLength(r.data, "utf8"), 0);
const meta = {
  format: "repro/1",
  recordedAt: new Date().toISOString(),
  url: "synthetic:make-flight-fixture",
  durationMs: tailT,
  messages: records.length,
  bytes,
  derived: {
    generator: "make-flight-fixture",
    params,
    paramHash,
    flightMs: Math.round(FLIGHT_MS),
    suggestedWindow,
    waveWindows
  }
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, [JSON.stringify({ meta }), ...records.map((r) => JSON.stringify(r))].join("\n") + "\n");

const totalCards = args.n * args.waves;
console.log(
  `wrote ${outPath}\n` +
    `  ${records.length} messages, ${(bytes / 1e6).toFixed(2)} MB, span ${(tailT / 1000).toFixed(1)}s\n` +
    `  ${totalCards} cards (${args.kind}, ${args.waves} wave(s) of ${args.n}), ${args.staggerMs}ms stagger, ` +
    `${Math.round(FLIGHT_MS)}ms per flight, ${args.filler} filler nodes\n` +
    `  suggested window: ${suggestedWindow[0]}:${suggestedWindow[1]}   params hash: ${paramHash}\n` +
    (waveWindows.length > 1
      ? `  per-wave windows: ${waveWindows.map((w, i) => `w${i + 1} ${w[0]}:${w[1]}`).join("   ")}\n`
      : "") +
    `  bench it:\n` +
    `    node scripts/bench-mirror-replay.mjs --url http://127.0.0.1:5173 \\\n` +
    `      --recording ${args.out ?? outPath.slice(REPO_ROOT.length + 1)} \\\n` +
    `      --repeats 3 --viewport 2100x900 --window ${suggestedWindow[0]}:${suggestedWindow[1]}`
);
