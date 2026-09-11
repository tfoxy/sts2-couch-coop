#!/usr/bin/env node
// Generate a FULLY SYNTHETIC geoclip artifact — `manifest.json` + one generated page PNG — in the geoclip/1
// format that scripts/geoclip-harness.html plays and scripts/probe-geoclip-replay.mjs drives.
//
//   node scripts/make-geoclip-fixture.mjs --out /tmp/geoclip-fixture
//   node scripts/make-geoclip-fixture.mjs --out /tmp/geoclip-fixture --pretty
//   node scripts/make-geoclip-fixture.mjs --out /tmp/geoclip-fixture          # packed Couch geoclip/1
//
// WHY SYNTHETIC. The harness has to be trustworthy BEFORE any real bake exists, and a real bake cannot be
// committed anyway (artifact policy). So the acceptance gate runs against a clip whose every pixel is authored
// here: solid, well-separated colours in the page, whole-number vertex coordinates in a 256x256 local space, and
// a `fit` of exactly 1,1,0,0 — which makes skeleton-local coordinates and canvas pixels the SAME NUMBER. An
// assert can then be written as "canvas pixel (50,165) is the red block", with no arithmetic between the claim
// and the picture.
//
// WHAT IT EXERCISES (one clip, 8 frames, three slots — every branch the harness has):
//
//   slot 0  "p_rigid"   RIGID quad, 40x40, walking +20px per frame across the mesh, y pinned at 165.
//                       Frames 6-7 also carry a 45 degree rotation, so the xform path is not just a translation
//                       in disguise. Frame 3 carries a 0.5 grey TINT, which only shows on a non-primary colour —
//                       hence the deliberately off-primary palette below.
//   slot 1  "p_mesh"    DEFORMING 6-vertex 2x3 grid (4 triangles). Every frame ships raw `verts`; vertex 5 (the
//                       bottom-right corner) walks +8px down per frame and nothing else moves, so "the deforming
//                       path is live" is a claim about ONE corner and not about the whole part having shifted.
//   slot 2  "p_marker"  ADDITIVE (blendMode 1) 24x24 quad, and the hidden-slot exhibit:
//                         frame 0      `part: null`            -> hidden
//                         frame 1      visible, ON TOP of the mesh -> additive blue over green, no channel clips
//                         frames 2-3   `part: null`            -> hidden
//                         frames 4-7   the slot KEY IS ABSENT  -> hidden by the other rule
//                       It stays in `drawOrder` on every frame, including the frames where it draws nothing,
//                       because that is exactly the case the contract says a player must tolerate.
//
//   DRAW-ORDER SWAP at frame 5: `[0,1,2]` becomes `[1,0,2]`. The rigid quad's own centre is therefore GREEN on
//   frame 4 (the mesh paints over it) and RED on frame 5 (it paints over the mesh) — the swap is readable at a
//   single pixel, which is the only kind of ordering assert that cannot be fooled by a coincidence.
//
//   ALPHA FADE on slot 1: alpha 1.0 through frame 5, 0.5 on frame 6, 0.25 on frame 7.
//
// PALETTE. The blocks are deliberately NOT primaries. A tint of [0.5,0.5,0.5,1] on pure red is still pure red,
// and an additive blue over a pure green saturates two channels to 255 — both would let a broken multiply or a
// broken blend equation pass. The chosen values keep every product in range: red 230,40,40 halves to 115,20,20;
// blue 50,60,180 added to green 40,160,60 gives 90,220,240 with nothing clipped.
//
// PAGE PADDING. Each 32x32 `srcRect` sits at the centre of a 48x48 block of the SAME colour. The harness filters
// LINEAR, so a uv of exactly 0 or 1 samples the texel just outside the rect; with padding that texel is the same
// colour and the edge stays clean, while a part that ignored `srcRect` entirely would sample the mostly
// TRANSPARENT page and be caught immediately.
//
// DETERMINISM is a contract: no randomness, no clock in the payload. Same arguments => byte-identical output.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { encodePngRgba } from "./lib/png.mjs";
import { packGeoclipDir } from "./lib/packed-geoclip.mjs";

// ---------------------------------------------------------------------------------------------------------
// authored constants — the fixture's ground truth, in one table
// ---------------------------------------------------------------------------------------------------------

export const PAGE_SIZE = 128;
export const BLOCK = 48;      // painted block, page px
export const RECT = 32;       // srcRect inside it, page px

/** Page blocks: [name, colour, block top-left]. srcRect is the centred RECT x RECT inside each block. */
const BLOCKS = [
  { name: "a", rgb: [230, 40, 40], at: [8, 8] },     // p_rigid
  { name: "b", rgb: [40, 160, 60], at: [72, 8] },    // p_mesh
  { name: "c", rgb: [50, 60, 180], at: [8, 72] },    // p_marker (additive)
  { name: "d", rgb: [255, 0, 255], at: [72, 72] }    // canary: referenced by nothing, must never appear
];

const srcRectOf = (b) => [b.at[0] + (BLOCK - RECT) / 2, b.at[1] + (BLOCK - RECT) / 2, RECT, RECT];

export const FRAME_COUNT = 8;
export const FPS = 10;

// rigid quad: 40x40 centred on its own origin
const RIGID_HALF = 20;
const RIGID_Y = 165;
const RIGID_X0 = 50;
const RIGID_STEP = 20;
const RIGID_ROT_FROM = 6;           // frames >= this carry a 45 degree rotation
const RIGID_TINT_FRAME = 3;

// deforming mesh: 2 rows x 3 columns over [100,140]..[220,190]
const MESH_X = [100, 160, 220];
const MESH_Y = [140, 190];
const MESH_MOVER = 5;               // vertex index (220,190) — the bottom-right corner
const MESH_MOVER_STEP = 8;          // px down, per frame

const MARKER_HALF = 12;
const MARKER_AT = [130, RIGID_Y];
const MARKER_FRAME = 1;             // the ONE frame it is visible

const ORDER_SWAP_FRAME = 5;
const FADE = { 6: 0.5, 7: 0.25 };   // slot 1 alpha by frame

// ---------------------------------------------------------------------------------------------------------
// page PNG
// ---------------------------------------------------------------------------------------------------------

function buildPage() {
  const px = new Uint8Array(PAGE_SIZE * PAGE_SIZE * 4); // transparent black everywhere by default
  for (const b of BLOCKS) {
    for (let y = b.at[1]; y < b.at[1] + BLOCK; y++) {
      for (let x = b.at[0]; x < b.at[0] + BLOCK; x++) {
        const o = (y * PAGE_SIZE + x) * 4;
        px[o] = b.rgb[0]; px[o + 1] = b.rgb[1]; px[o + 2] = b.rgb[2]; px[o + 3] = 255;
      }
    }
  }
  return encodePngRgba(PAGE_SIZE, PAGE_SIZE, px);
}

// ---------------------------------------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------------------------------------

/** Per-frame rigid xform for slot 0: rotate by theta (y-down), then translate. */
function rigidXform(f) {
  const theta = f >= RIGID_ROT_FROM ? Math.PI / 4 : 0;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // x' = cos*x - sin*y + tx ; y' = sin*x + cos*y + ty  =>  [a,b,c,d,tx,ty]
  return [cos, -sin, sin, cos, RIGID_X0 + RIGID_STEP * f, RIGID_Y];
}

const meshRefVerts = () => {
  const v = [];
  for (const y of MESH_Y) for (const x of MESH_X) v.push(x, y);
  return v;
};

/** Per-frame deformed verts for slot 1: only MESH_MOVER's y changes. */
function meshVerts(f) {
  const v = meshRefVerts();
  v[MESH_MOVER * 2 + 1] += MESH_MOVER_STEP * f;
  return v;
}

function applyXform(xform, verts) {
  const [a, b, c, d, tx, ty] = xform;
  const out = [];
  for (let i = 0; i < verts.length; i += 2) {
    out.push(a * verts[i] + b * verts[i + 1] + tx, c * verts[i] + d * verts[i + 1] + ty);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------------------------------------

export function buildGeoclipFixture() {
  const [rectA, rectB, rectC] = [BLOCKS[0], BLOCKS[1], BLOCKS[2]].map(srcRectOf);

  const rigidRef = [-RIGID_HALF, -RIGID_HALF, RIGID_HALF, -RIGID_HALF, RIGID_HALF, RIGID_HALF, -RIGID_HALF, RIGID_HALF];
  const markerRef = [-MARKER_HALF, -MARKER_HALF, MARKER_HALF, -MARKER_HALF, MARKER_HALF, MARKER_HALF, -MARKER_HALF, MARKER_HALF];
  const quadUvs = [0, 0, 1, 0, 1, 1, 0, 1];
  const quadIdx = [0, 1, 2, 0, 2, 3];

  const meshRef = meshRefVerts();
  const meshUvs = [];
  for (let i = 0; i < meshRef.length; i += 2) {
    meshUvs.push(
      (meshRef[i] - MESH_X[0]) / (MESH_X[2] - MESH_X[0]),
      (meshRef[i + 1] - MESH_Y[0]) / (MESH_Y[1] - MESH_Y[0])
    );
  }
  //  0---1---2      two quads, four triangles, deliberately NOT in a fan so a broken index buffer shows as a
  //  |  /|  /|      missing wedge rather than a missing whole part.
  //  3---4---5
  const meshIdx = [0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2];

  const parts = [
    {
      id: "p_rigid", slotIndex: 0, attachmentName: "quad-a", pageId: "p0", srcRect: rectA,
      indices: quadIdx, uvs: quadUvs, refVerts: rigidRef, refFrame: 0, rigid: true, blendMode: 0
    },
    {
      id: "p_mesh", slotIndex: 1, attachmentName: "grid-b", pageId: "p0", srcRect: rectB,
      indices: meshIdx, uvs: meshUvs, refVerts: meshRef, refFrame: 0, rigid: false, blendMode: 0
    },
    {
      id: "p_marker", slotIndex: 2, attachmentName: "quad-c", pageId: "p0", srcRect: rectC,
      indices: quadIdx, uvs: quadUvs, refVerts: markerRef, refFrame: 0, rigid: true, blendMode: 1
    }
  ];

  const frames = [];
  const boundsPerFrame = [];
  for (let f = 0; f < FRAME_COUNT; f++) {
    const slots = {};
    const drawn = [];

    const rx = rigidXform(f);
    slots["0"] = {
      part: "p_rigid",
      color: f === RIGID_TINT_FRAME ? [0.5, 0.5, 0.5, 1] : [1, 1, 1, 1],
      xform: rx
    };
    drawn.push(applyXform(rx, rigidRef));

    const mv = meshVerts(f);
    slots["1"] = {
      part: "p_mesh",
      color: [1, 1, 1, FADE[f] ?? 1],
      verts: mv
    };
    drawn.push(mv);

    if (f === MARKER_FRAME) {
      const mx = [1, 0, 0, 1, MARKER_AT[0], MARKER_AT[1]];
      slots["2"] = { part: "p_marker", color: [1, 1, 1, 1], xform: mx };
      drawn.push(applyXform(mx, markerRef));
    } else if (f < 4) {
      // hidden the EXPLICIT way
      slots["2"] = { part: null, color: [1, 1, 1, 1], xform: [1, 0, 0, 1, MARKER_AT[0], MARKER_AT[1]] };
    }
    // f >= 4: the key is simply absent — hidden the IMPLICIT way. slot 2 stays in drawOrder regardless.

    const drawOrder = f < ORDER_SWAP_FRAME ? [0, 1, 2] : [1, 0, 2];

    frames.push({ t: Number((f / FPS).toFixed(6)), drawOrder, slots });

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const verts of drawn) {
      for (let i = 0; i < verts.length; i += 2) {
        minX = Math.min(minX, verts[i]); maxX = Math.max(maxX, verts[i]);
        minY = Math.min(minY, verts[i + 1]); maxY = Math.max(maxY, verts[i + 1]);
      }
    }
    const r6 = (n) => Number(n.toFixed(6));
    boundsPerFrame.push([r6(minX), r6(minY), r6(maxX - minX), r6(maxY - minY)]);
  }

  const manifest = {
    meta: {
      schema: "geoclip/1",
      scene: "synthetic://geoclip-fixture",
      node: "SyntheticSkeleton",
      anim: "fixture",
      fps: FPS,
      frameCount: FRAME_COUNT,
      durationMs: (FRAME_COUNT / FPS) * 1000,
      boundsPerFrame
    },
    pages: [{ id: "p0", file: "page-0.png", width: PAGE_SIZE, height: PAGE_SIZE }],
    parts,
    frames
  };

  return { manifest, pages: [{ file: "page-0.png", buffer: buildPage() }] };
}

export function writeGeoclipFixture(dir, { pretty = false } = {}) {
  const out = resolve(dir);
  mkdirSync(out, { recursive: true });
  const { manifest, pages } = buildGeoclipFixture();
  for (const page of pages) writeFileSync(resolve(out, page.file), page.buffer);
  const json = pretty ? JSON.stringify(manifest, null, 2) + "\n" : JSON.stringify(manifest) + "\n";
  writeFileSync(resolve(out, "manifest.json"), json);
  return {
    dir: out,
    manifest,
    files: ["manifest.json", ...pages.map((p) => p.file)].map((f) => resolve(out, f))
  };
}

/**
 * The same clip, packed as Couch geoclip/1 (scripts/lib/packed-geoclip.mjs) — written by packing the raw fixture rather than
 * by generating its binary numbers a second time. That is deliberate: the fixture's job is to be a clip whose every
 * value is authored HERE, so the packed copy has to be a transformation of it and not an independent claim about what
 * the packed numbers ought to be. `slot 1` is the deforming part, so `verts.bin` carries one record per frame and the
 * vref path is exercised on every frame the harness draws.
 *
 * The raw artifact is written into `<dir>/raw` and the packed one into `<dir>` itself, so a caller can point a
 * player straight at `dir` while keeping the external input available to the offline oracle.
 */
export function writePackedGeoclipFixture(dir, { pretty = false } = {}) {
  const out = resolve(dir);
  const raw = writeGeoclipFixture(resolve(out, "raw"), { pretty });
  const report = packGeoclipDir(raw.dir, out, { pretty });
  return {
    dir: out,
    raw,
    manifest: report.manifest,
    report,
    files: ["manifest.json", ...report.manifest.pages.map((p) => p.file), report.manifest.vertsBin.file]
      .map((f) => resolve(out, f))
  };
}

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------

const HELP = `make-geoclip-fixture.mjs — write a deterministic synthetic geoclip artifact

  --out <dir>   artifact directory to write (packed manifest.json + sheet-*.png + verts.bin) [required]
  --raw         write the upstream raw bake shape instead of Couch's packed geoclip/1
  --pretty      pretty-print the manifest (default: one line)
  --help

The clip is 8 frames at 10fps in a 256x256 local space, authored so that a fit of {1,1,0,0} makes local
coordinates and canvas pixels identical. See the header for what each slot exercises.`;

function main(argv) {
  const a = { out: null, pretty: false, raw: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const next = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--out") a.out = next();
    else if (flag === "--pretty") a.pretty = true;
    else if (flag === "--raw") a.raw = true;
    else if (flag === "--help" || flag === "-h") a.help = true;
    else { console.error(`make-geoclip-fixture: unknown argument '${argv[i]}'`); a.help = true; a.bad = true; }
  }
  if (a.help || !a.out) {
    console.log(HELP);
    if (!a.out && !a.help) console.error("make-geoclip-fixture: --out is required");
    process.exit(a.bad || (!a.out && !a.help) ? 2 : 0);
  }
  if (!a.raw) {
    const res = writePackedGeoclipFixture(a.out, { pretty: a.pretty });
    const { meta, parts, frames, pages, vertsBin } = res.manifest;
    console.log(`wrote ${res.dir}: ${meta.schema}, ${parts.length} parts, ${frames.length} frames @ ${meta.fps}fps, ` +
      `${pages.length} sheet(s) ${pages.map((p) => `${p.width}x${p.height}`).join(",")}, ` +
      `${vertsBin.records} vertex record(s)`);
    console.log(`  quant bound ${res.report.stats.quantBound.toExponential(3)} px, ` +
      `worst measured ${res.report.stats.quantMaxError.toExponential(3)} px`);
    for (const f of res.files) console.log(`  ${f}`);
    console.log(`  upstream raw source kept at ${res.raw.dir}`);
    return;
  }
  const res = writeGeoclipFixture(a.out, { pretty: a.pretty });
  const { meta, parts, frames } = res.manifest;
  console.log(`wrote ${res.dir}: ${parts.length} parts, ${frames.length} frames @ ${meta.fps}fps, ` +
    `1 page ${PAGE_SIZE}x${PAGE_SIZE}`);
  for (const f of res.files) console.log(`  ${f}`);
}

// Only run the CLI when invoked directly — selftest-geoclip.mjs imports this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
