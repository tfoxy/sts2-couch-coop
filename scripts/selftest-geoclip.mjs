#!/usr/bin/env node
// Acceptance gate for the geoclip browser-playback harness. Needs NO real artifact, no dev server, no game.
//
//   node scripts/selftest-geoclip.mjs
//   node scripts/selftest-geoclip.mjs --keep        # leave the temp artifact + screenshots for inspection
//   node scripts/selftest-geoclip.mjs --port 5219   # if 5218 is busy
//
// It writes the synthetic clip from scripts/make-geoclip-fixture.mjs into a temp dir, drives it through
// scripts/probe-geoclip-replay.mjs exactly as a real run would, and then reads the resulting PNGs.
//
// TWO KINDS OF ASSERT, on purpose.
//
//   NAMED CHECKS are hard-coded literals — "canvas pixel (50,165) on frame 0 is rgb(230,40,40)". They restate
//   the fixture's intent independently of the code that generated it, so a fixture change and a harness change
//   cannot quietly agree with each other. They cover exactly the behaviours the format has: rigid translation,
//   rotation, the deforming vertex path, the draw-order swap, per-slot alpha, per-slot RGB tint, additive
//   blending, both ways a slot can be hidden, srcRect-relative uv addressing, and the fit mapping (including a
//   y-flip).
//
//   PACKED GEOCLIP/1 (sections 15-21) is checked the same two ways, plus a third that only an independent
//   implementation can provide: the CPU oracle reads the upstream raw bake while the browser draws only the packed
//   artifact. That keeps the Couch player boundary real and still measures whether packing preserved the picture.
//   Sections 20 and 21 use section [2]'s packed screenshots as their same-player RMSE truth; the raw-vs-packed
//   assertion is the oracle sweep, never an accidental raw-player compatibility path.
//
//   THE ORACLE SWEEP is a from-scratch CPU rasteriser that reads the manifest and the page PNG and computes what
//   each sampled pixel should be — painter's order, barycentric uv, page texel, RGBA multiply, normal/additive
//   blend. It is compared to the GPU's answer on a grid over every frame. Points where the oracle is not stable
//   under a +-0.35px jitter are SKIPPED: those are geometry edges, where a rasterisation fill rule and a LINEAR
//   texture filter legitimately disagree with a nearest-sample reference, and asserting there would only teach
//   the next person to loosen the tolerance.
//
// Exit 0 iff every check passes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { writeGeoclipFixture, writePackedGeoclipFixture } from "./make-geoclip-fixture.mjs";
import { decodePackedGeoclip, EXTRUDE, packGeoclipDir, QUANT_STEPS } from "./lib/packed-geoclip.mjs";
import { decodePng, pixelAt } from "./lib/png.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(SCRIPT_DIR, "probe-geoclip-replay.mjs");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const KEEP = argv.includes("--keep");
const PORT = Number(argOf("--port", "5218"));

const CANVAS = 256;                 // the fixture is authored in a 256x256 local space; fit 1,1,0,0
const TOL = 3;                      // per-channel tolerance; the harness is byte-deterministic in practice

// The fixture's authored palette, restated here rather than imported (see the header).
const RED = [230, 40, 40];
const GREEN = [40, 160, 60];
const BLUE = [50, 60, 180];
const CANARY = [255, 0, 255];
const BG = [0, 0, 0];

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

const near = (got, want, tol = TOL) =>
  Math.abs(got[0] - want[0]) <= tol && Math.abs(got[1] - want[1]) <= tol && Math.abs(got[2] - want[2]) <= tol;
const fmt = (c) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;

function loadFrames(dir, indices) {
  const out = new Map();
  for (const i of indices) {
    const file = path.join(dir, `frame-${String(i).padStart(4, "0")}.png`);
    out.set(i, decodePng(readFileSync(file)));
  }
  return out;
}

/** A named pixel check: `at(frames, 4, 130, 165)` -> the rgb triple, ready for `near`. */
const at = (frames, f, x, y) => pixelAt(frames.get(f), x, y).slice(0, 3);

function runDriver(extra, { expectExit = 0 } = {}) {
  const r = spawnSync(process.execPath, [DRIVER, ...extra], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== expectExit) {
    console.log(`\n[driver exit ${r.status}, expected ${expectExit}]\n${r.stdout}\n${r.stderr}`);
  }
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("GEOCLIP_REPLAY_RESULT "));
  let result = null;
  try { result = line ? JSON.parse(line.slice("GEOCLIP_REPLAY_RESULT ".length)) : null; } catch { /* keep null */ }
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, result };
}

// ---------------------------------------------------------------------------------------------------------
// the CPU oracle — an independent reference rasteriser for one pixel
// ---------------------------------------------------------------------------------------------------------

function positionsOf(part, slot) {
  const ref = part.refVerts;
  if (Array.isArray(slot.verts) && slot.verts.length === ref.length) return slot.verts.slice();
  if (Array.isArray(slot.xform) && slot.xform.length >= 6) {
    const [a, b, c, d, tx, ty] = slot.xform;
    const out = new Array(ref.length);
    for (let i = 0; i < ref.length; i += 2) {
      out[i] = a * ref[i] + b * ref[i + 1] + tx;
      out[i + 1] = c * ref[i] + d * ref[i + 1] + ty;
    }
    return out;
  }
  return ref.slice();
}

/** Barycentric coordinates of (px,py) in triangle abc, or null if outside. */
function bary(ax, ay, bx, by, cx, cy, px, py) {
  const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(det) < 1e-9) return null;
  const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
  const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
  const l3 = 1 - l1 - l2;
  if (l1 < 0 || l2 < 0 || l3 < 0) return null;
  return [l1, l2, l3];
}

/** The colour the harness OUGHT to put at local point (lx, ly) on frame f. Returns [r,g,b] 0..255. */
function oracle(manifest, page, f, lx, ly) {
  const frame = manifest.frames[f];
  const slots = frame.slots || {};
  const order = frame.drawOrder ?? Object.keys(slots).map(Number).sort((a, b) => a - b);
  const acc = [BG[0], BG[1], BG[2]];
  for (const s of order) {
    const slot = Object.prototype.hasOwnProperty.call(slots, String(s)) ? slots[String(s)] : null;
    if (!slot || slot.part == null) continue;
    const part = manifest.parts.find((p) => p.id === slot.part);
    if (!part) continue;
    const pos = positionsOf(part, slot);
    let u = null;
    let v = null;
    for (let t = 0; t < part.indices.length; t += 3) {
      const [i0, i1, i2] = [part.indices[t], part.indices[t + 1], part.indices[t + 2]];
      const l = bary(pos[i0 * 2], pos[i0 * 2 + 1], pos[i1 * 2], pos[i1 * 2 + 1], pos[i2 * 2], pos[i2 * 2 + 1], lx, ly);
      if (!l) continue;
      u = l[0] * part.uvs[i0 * 2] + l[1] * part.uvs[i1 * 2] + l[2] * part.uvs[i2 * 2];
      v = l[0] * part.uvs[i0 * 2 + 1] + l[1] * part.uvs[i1 * 2 + 1] + l[2] * part.uvs[i2 * 2 + 1];
      break;
    }
    if (u === null) continue;
    const [sx, sy, sw, sh] = part.srcRect;
    const texel = pixelAt(page, Math.floor(sx + u * sw), Math.floor(sy + v * sh));
    const col = slot.color ?? [1, 1, 1, 1];
    const sa = (texel[3] / 255) * col[3];
    const src = [texel[0] * col[0], texel[1] * col[1], texel[2] * col[2]];
    for (let k = 0; k < 3; k++) {
      acc[k] = part.blendMode === 1 ? acc[k] + src[k] * sa : src[k] * sa + acc[k] * (1 - sa);
    }
  }
  return acc.map((c) => Math.min(255, Math.max(0, c)));
}

/**
 * The oracle at a canvas pixel, or null if the answer is not stable across the pixel — i.e. the pixel straddles
 * a geometry edge, where a fill rule and a LINEAR filter are entitled to disagree with a nearest-sample CPU
 * reference. Skipping those is the difference between a sweep that means something and a loosened tolerance.
 */
function stableOracle(manifest, page, f, x, y) {
  const cx = x + 0.5;
  const cy = y + 0.5;
  const base = oracle(manifest, page, f, cx, cy);
  for (const [dx, dy] of [[-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) {
    const o = oracle(manifest, page, f, cx + dx, cy + dy);
    if (!near(o, base, 0.75)) return null;
  }
  return base;
}

// ---------------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------------

const tmp = mkdtempSync(path.join(os.tmpdir(), "geoclip-selftest-"));
const artifactDir = path.join(tmp, "artifact");
const packedDir = path.join(tmp, "packed");
const shotsDir = path.join(tmp, "shots");
const flipDir = path.join(tmp, "flip");
const diffDir = path.join(tmp, "diff");

console.log(`geoclip selftest — temp ${tmp}`);

console.log("\n[1] fixture generation");
const fixture = writeGeoclipFixture(artifactDir, { pretty: true });
const packedFixture = writePackedGeoclipFixture(packedDir, { pretty: true });
const rawManifest = fixture.manifest;
let packedManifest = packedFixture.manifest;
{
  const m = fixture.manifest;
  check("manifest written", existsSync(path.join(artifactDir, "manifest.json")));
  check("page PNG written", existsSync(path.join(artifactDir, "page-0.png")));
  check("schema is geoclip/1", m.meta.schema === "geoclip/1", m.meta.schema);
  check("8 frames, 3 parts, 1 page", m.frames.length === 8 && m.parts.length === 3 && m.pages.length === 1);
  check("boundsPerFrame has one box per frame", m.meta.boundsPerFrame.length === m.frames.length);
  // Determinism: a second write must produce identical bytes.
  const again = writeGeoclipFixture(path.join(tmp, "artifact2"), { pretty: true });
  check("generator is deterministic",
    readFileSync(path.join(artifactDir, "manifest.json"), "utf8") === readFileSync(path.join(again.dir, "manifest.json"), "utf8") &&
    readFileSync(path.join(artifactDir, "page-0.png")).equals(readFileSync(path.join(again.dir, "page-0.png"))));
}

console.log("\n[2] packed Couch player run — all 8 frames at 256x256, fit 1,1,0,0");
const run = runDriver([
  "--artifact", packedDir, "--out", shotsDir,
  "--canvas", `${CANVAS}x${CANVAS}`, "--all", "--port", String(PORT)
]);
check("driver exits 0", run.code === 0, `exit ${run.code}`);
check("emits GEOCLIP_REPLAY_RESULT", !!run.result);
if (!run.result) {
  console.log(run.out);
  console.log("\nSELFTEST FAILED: the driver produced no result line; nothing further can be checked.");
  process.exit(1);
}
check("no GL errors", run.result.glErrors === 0, String(run.result.glErrors));
check("no load warnings", (run.result.warnings ?? []).length === 0, JSON.stringify(run.result.warnings));
check("8 screenshots written", run.result.frames.length === 8 && run.result.frames.every((f) => existsSync(f.out)));

const frames = loadFrames(shotsDir, [0, 1, 2, 3, 4, 5, 6, 7]);
check("screenshots are exactly the requested canvas size",
  [...frames.values()].every((img) => img.width === CANVAS && img.height === CANVAS),
  [...frames.values()].map((i) => `${i.width}x${i.height}`).join(","));

// ---- 3. the RIGID path ------------------------------------------------------------------------------------
// The quad is 40x40 centred on its own origin; frame f puts that centre at (50 + 20f, 165). So its footprint on
// frame 0 is x in [30,70), y in [145,185), and on frame 2 it is that box shifted +40px.
console.log("\n[3] rigid part — the xform path lands where the manifest says");
check("f0 centre pixel is the red block", near(at(frames, 0, 50, 165), RED), fmt(at(frames, 0, 50, 165)));
check("f0 quad spans 40px: (31,165) and (68,165) are red", near(at(frames, 0, 31, 165), RED) && near(at(frames, 0, 68, 165), RED));
check("f0 just outside the quad is background", near(at(frames, 0, 27, 165), BG) && near(at(frames, 0, 72, 165), BG),
  `${fmt(at(frames, 0, 27, 165))} / ${fmt(at(frames, 0, 72, 165))}`);
check("f0 the frame-2 position is still empty", near(at(frames, 0, 90, 165), BG), fmt(at(frames, 0, 90, 165)));
check("f2 the quad HAS translated +40px", near(at(frames, 2, 90, 165), RED) && near(at(frames, 2, 50, 165), BG),
  `${fmt(at(frames, 2, 90, 165))} / ${fmt(at(frames, 2, 50, 165))}`);
// srcRect addressing: the whole quad is ONE block. A player that ignored srcRect and used the raw uvs would map
// the quad across the entire 128x128 page and paint green / blue / transparent over three of its quarters.
check("srcRect is respected across the whole quad",
  [[35, 152], [65, 152], [35, 178], [65, 178], [50, 165]].every(([x, y]) => near(at(frames, 0, x, y), RED)),
  [[35, 152], [65, 152], [35, 178], [65, 178]].map(([x, y]) => fmt(at(frames, 0, x, y))).join(" "));

// ---- 4. rotation ------------------------------------------------------------------------------------------
// Frames 6-7 rotate the quad 45 degrees. The corner offset (-18,-18) from the centre is INSIDE an axis-aligned
// 40x40 square (|dx|,|dy| < 20) and OUTSIDE the rotated one (the diagonal projection is 25.5 > 20).
console.log("\n[4] rigid part — frames 6-7 really are rotated, not just translated");
check("f5 (no rotation): the (-18,-18) corner is red", near(at(frames, 5, 150 - 18, 165 - 18), RED),
  fmt(at(frames, 5, 132, 147)));
check("f6 (45 degrees): the same corner is NOT red", !near(at(frames, 6, 170 - 18, 165 - 18), RED),
  fmt(at(frames, 6, 152, 147)));
check("f6 the quad's own centre is still red", near(at(frames, 6, 170, 165), RED), fmt(at(frames, 6, 170, 165)));

// ---- 5. the DEFORMING path --------------------------------------------------------------------------------
// The mesh's reference footprint is x in [100,220], y in [140,190]. Only vertex 5 — the bottom-right corner —
// moves, +8px down per frame. So (190,200) is empty on frame 0 and covered on frame 5, while the left half of
// the mesh never moves at all: this is a deformation, not the part sliding.
console.log("\n[5] deforming part — one vertex moves and the rest does not");
check("f0 below the reference bottom edge is empty", near(at(frames, 0, 190, 200), BG), fmt(at(frames, 0, 190, 200)));
check("f5 the stretched corner covers it", near(at(frames, 5, 190, 200), GREEN), fmt(at(frames, 5, 190, 200)));
check("the unmoved left half is identical on f0 and f5",
  near(at(frames, 0, 110, 165), GREEN) && near(at(frames, 5, 110, 165), GREEN),
  `${fmt(at(frames, 0, 110, 165))} / ${fmt(at(frames, 5, 110, 165))}`);
check("f0 the reference interior is already covered (the part did not move)",
  near(at(frames, 0, 190, 185), GREEN), fmt(at(frames, 0, 190, 185)));

// ---- 6. draw order ----------------------------------------------------------------------------------------
// drawOrder is [0,1,2] up to frame 4 and [1,0,2] from frame 5, and the rigid quad is inside the mesh at both.
// Sampling each frame's OWN quad centre makes the swap a one-pixel question.
console.log("\n[6] draw-order swap at frame 5");
check("f4 drawOrder [0,1,2]: the mesh paints OVER the quad centre", near(at(frames, 4, 130, 165), GREEN),
  fmt(at(frames, 4, 130, 165)));
check("f5 drawOrder [1,0,2]: the quad paints OVER the mesh", near(at(frames, 5, 150, 165), RED),
  fmt(at(frames, 5, 150, 165)));
check("f4 quad centre is not red / f5 quad centre is not green",
  !near(at(frames, 4, 130, 165), RED) && !near(at(frames, 5, 150, 165), GREEN));
check("the manifest really swapped (and did not just move geometry)",
  JSON.stringify(fixture.manifest.frames[4].drawOrder) === "[0,1,2]" &&
  JSON.stringify(fixture.manifest.frames[5].drawOrder) === "[1,0,2]");

// ---- 7. per-slot colour -----------------------------------------------------------------------------------
console.log("\n[7] per-slot colour — alpha fade and RGB tint");
const half = GREEN.map((c) => c * 0.5);
const quarter = GREEN.map((c) => c * 0.25);
check("f5 slot 1 alpha 1.00 -> full green", near(at(frames, 5, 110, 165), GREEN), fmt(at(frames, 5, 110, 165)));
check("f6 slot 1 alpha 0.50 -> blended over black", near(at(frames, 6, 110, 165), half), fmt(at(frames, 6, 110, 165)));
check("f7 slot 1 alpha 0.25 -> blended over black", near(at(frames, 7, 110, 165), quarter), fmt(at(frames, 7, 110, 165)));
check("f3 slot 0 tint [.5,.5,.5,1] halves every channel", near(at(frames, 3, 95, 165), RED.map((c) => c * 0.5)),
  fmt(at(frames, 3, 95, 165)));

// ---- 8. blend mode + hidden slots -------------------------------------------------------------------------
// The marker is blendMode 1 and sits on top of the mesh on frame 1 only. Additive over the green block gives
// 40+50, 160+60, 60+180 with no channel clipped, so a normal-blend bug reads as flat blue and is caught.
console.log("\n[8] additive blend, and the two ways a slot is hidden");
const additive = [GREEN[0] + BLUE[0], GREEN[1] + BLUE[1], GREEN[2] + BLUE[2]];
check("f1 additive marker over the mesh", near(at(frames, 1, 130, 165), additive), fmt(at(frames, 1, 130, 165)));
check("f1 is not a normal-blended marker", !near(at(frames, 1, 130, 165), BLUE));
check("f2 `part: null` hides the slot", near(at(frames, 2, 130, 165), GREEN), fmt(at(frames, 2, 130, 165)));
check("f4 an ABSENT slot key hides it too", near(at(frames, 4, 130, 165), GREEN), fmt(at(frames, 4, 130, 165)));
const byIndex = Object.fromEntries(run.result.frames.map((f) => [f.index, f]));
check("census: f0 counts one nullPart skip", byIndex[0].skipped.nullPart === 1, JSON.stringify(byIndex[0].skipped));
check("census: f4 counts one missingSlot skip", byIndex[4].skipped.missingSlot === 1, JSON.stringify(byIndex[4].skipped));
check("census: no unknown-part skips anywhere", run.result.frames.every((f) => f.skipped.unknownPart === 0));
check("census: f1 is the only additive draw", byIndex[1].additive === 1 && run.result.frames.filter((f) => f.additive > 0).length === 1);
check("census: every frame draws exactly one deforming part", run.result.frames.every((f) => f.deforming === 1));
check("census: drawOrder keeps slot 2 on every frame (drawn 3 / 2)",
  byIndex[1].drawn === 3 && [0, 2, 3, 4, 5, 6, 7].every((i) => byIndex[i].drawn === 2));

// ---- 9. the canary ----------------------------------------------------------------------------------------
// The page's fourth block is magenta and no part references it. A single magenta pixel means some part sampled
// outside its srcRect.
console.log("\n[9] the unreferenced page block never reaches the canvas");
{
  let hits = 0;
  for (const img of frames.values()) {
    for (let i = 0; i < img.data.length; i += 4) {
      if (Math.abs(img.data[i] - CANARY[0]) <= 24 && img.data[i + 1] <= 24 && Math.abs(img.data[i + 2] - CANARY[2]) <= 24) hits++;
    }
  }
  check("zero magenta pixels across all 8 frames", hits === 0, `${hits} pixels`);
}

// ---- 10. the fit mapping ----------------------------------------------------------------------------------
console.log("\n[10] fit — a y-flip moves the picture and nothing else has to change");
{
  const flip = runDriver([
    "--artifact", packedDir, "--out", flipDir,
    "--canvas", `${CANVAS}x${CANVAS}`, "--frames", "0",
    "--fit", JSON.stringify({ scaleX: 1, scaleY: -1, offsetX: 0, offsetY: CANVAS }),
    "--port", String(PORT)
  ]);
  check("driver exits 0", flip.code === 0, `exit ${flip.code}`);
  const img = decodePng(readFileSync(path.join(flipDir, "frame-0000.png")));
  const px = (x, y) => pixelAt(img, x, y).slice(0, 3);
  // canvasY = localY * -1 + 256, so local y 165 lands at canvas y 91.
  check("the quad centre moved to y = 256 - 165 = 91", near(px(50, 91), RED), fmt(px(50, 91)));
  check("its un-flipped position is empty", near(px(50, 165), BG), fmt(px(50, 165)));
  check("x is untouched (scaleX 1, offsetX 0)", near(px(31, 91), RED) && near(px(27, 91), BG));
}

console.log("\n[10b] --bg transparent really writes transparent pixels");
{
  // A transparent CLEAR is not automatically a transparent SCREENSHOT: Chromium composites an element shot over
  // the page behind it, so this check exists because the first cut silently produced opaque black everywhere.
  const trDir = path.join(tmp, "transparent");
  const tr = runDriver(["--artifact", packedDir, "--out", trDir, "--canvas", `${CANVAS}x${CANVAS}`,
    "--frames", "0", "--bg", "transparent", "--port", String(PORT)]);
  check("driver exits 0", tr.code === 0, `exit ${tr.code}`);
  const img = decodePng(readFileSync(path.join(trDir, "frame-0000.png")));
  const a = (x, y) => pixelAt(img, x, y)[3];
  check("empty canvas is alpha 0", a(5, 5) === 0, `alpha ${a(5, 5)}`);
  check("painted parts stay alpha 255", a(50, 165) === 255 && a(110, 165) === 255,
    `${a(50, 165)} / ${a(110, 165)}`);
  check("and the painted colour is unchanged", near(pixelAt(img, 50, 165).slice(0, 3), RED));
}

// ---- 11. truth diffing ------------------------------------------------------------------------------------
console.log("\n[11] --truth pixel diff, side-by-side stacks and summary.json");
{
  const diff = runDriver([
    "--artifact", packedDir, "--out", diffDir,
    "--canvas", `${CANVAS}x${CANVAS}`, "--all",
    "--truth", shotsDir, "--truth-pattern", "frame-%04d.png",
    "--port", String(PORT)
  ]);
  check("driver exits 0", diff.code === 0, `exit ${diff.code}`);
  const summaryPath = path.join(diffDir, "summary.json");
  check("summary.json written", existsSync(summaryPath));
  const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : {};
  check("summary carries one entry per frame", (summary.frames ?? []).length === 8);
  check("every frame scored an RMSE", (summary.frames ?? []).every((f) => typeof f.rmse === "number"));
  // The harness is deterministic run-to-run, so re-rendering the same clip against its own output must be an
  // EXACT match. If this ever starts drifting, every RMSE this tool reports has an unaccounted noise floor.
  check("mean RMSE is exactly 0 (render is run-to-run deterministic)", summary.meanRmse === 0, String(summary.meanRmse));
  check("side-by-side stack per frame", (summary.frames ?? []).every((f) => f.sideBySide && existsSync(f.sideBySide)));
  const sbs = summary.frames?.[0]?.sideBySide;
  if (sbs && existsSync(sbs)) {
    // `identify`, not the decoder: this also proves the evidence came out 8-bit. A Q16 ImageMagick writes 16-bit
    // PNGs unless told otherwise, and a stack no ordinary reader can open is not evidence.
    const id = spawnSync("identify", ["-format", "%w %h %z", sbs], { encoding: "utf8" });
    const [w, h, depth] = (id.stdout ?? "").trim().split(/\s+/).map(Number);
    // three labelled tiles side by side, each CANVAS wide, plus a label bar on top of each
    check("the stack is three tiles wide and taller than the frame",
      w === CANVAS * 3 && h > CANVAS, `${w}x${h}`);
    check("evidence PNGs are 8-bit", depth === 8, `depth ${depth}`);
    check("the stack decodes with the repo's own PNG reader", (() => {
      try { return decodePng(readFileSync(sbs)).width === CANVAS * 3; } catch { return false; }
    })());
  } else {
    check("the stack is three tiles wide and taller than the frame", false, "no side-by-side written");
  }
  check("summary records the fit and canvas it used",
    summary.canvas?.width === CANVAS && summary.fit?.scaleY === 1, JSON.stringify(summary.fit));
}

// ---- 12. refusals -----------------------------------------------------------------------------------------
console.log("\n[12] the driver refuses bad input instead of writing misleading pictures");
{
  const oob = runDriver(["--artifact", packedDir, "--out", path.join(tmp, "oob"), "--frames", "99",
    "--port", String(PORT)], { expectExit: 2 });
  check("a frame index past the end exits 2", oob.code === 2, `exit ${oob.code}`);
  check("and says how many frames there are", /has 8 frames/.test(oob.out));

  const missing = runDriver(["--artifact", path.join(tmp, "nope"), "--out", path.join(tmp, "oob2"),
    "--port", String(PORT)], { expectExit: 2 });
  check("a missing artifact exits 2", missing.code === 2, `exit ${missing.code}`);

  const badFit = runDriver(["--artifact", packedDir, "--out", path.join(tmp, "oob3"), "--fit", "{not json",
    "--port", String(PORT)], { expectExit: 2 });
  check("unparseable --fit exits 2", badFit.code === 2, `exit ${badFit.code}`);

  // `geoclip/1` alone is NOT Couch's contract: this is the upstream raw-bake shape the packer accepts. The
  // browser must reject it before it can turn its inline vertices into a plausible-looking picture.
  const raw = runDriver(["--artifact", artifactDir, "--out", path.join(tmp, "raw-refused"), "--frames", "0",
    "--port", String(PORT)], { expectExit: 1 });
  check("the Couch player rejects an upstream raw inline-vertex manifest", raw.code === 1, `exit ${raw.code}`);
  check("the raw refusal names verts.bin", /verts\.bin/.test(raw.out), raw.out.slice(-300));

  const inlineDir = path.join(tmp, "packed-inline-verts");
  writePackedGeoclipFixture(inlineDir, { pretty: true });
  const inline = JSON.parse(readFileSync(path.join(inlineDir, "manifest.json"), "utf8"));
  inline.frames[0].slots["1"].verts = rawManifest.frames[0].slots["1"].verts;
  writeFileSync(path.join(inlineDir, "manifest.json"), JSON.stringify(inline, null, 2));
  const inlineRun = runDriver(["--artifact", inlineDir, "--out", path.join(tmp, "inline-refused"), "--frames", "0",
    "--port", String(PORT)], { expectExit: 1 });
  check("the Couch player rejects inline verts even beside a verts.bin", inlineRun.code === 1, `exit ${inlineRun.code}`);
  check("the inline-vertex refusal names the offending representation", /inline verts/.test(inlineRun.out), inlineRun.out.slice(-300));
}

// ---- 13. the oracle sweep ---------------------------------------------------------------------------------
console.log("\n[13] upstream raw CPU oracle vs the packed Couch player, every frame");
{
  const page = decodePng(readFileSync(path.join(artifactDir, "page-0.png")));
  const manifest = JSON.parse(readFileSync(path.join(artifactDir, "manifest.json"), "utf8"));
  let compared = 0;
  let skippedEdges = 0;
  let worst = 0;
  let worstAt = null;
  let mismatches = 0;
  const samples = [];
  for (let f = 0; f < manifest.frames.length; f++) {
    const img = frames.get(f);
    for (let y = 2; y < CANVAS; y += 3) {
      for (let x = 2; x < CANVAS; x += 3) {
        const want = stableOracle(manifest, page, f, x, y);
        if (!want) { skippedEdges++; continue; }
        const got = pixelAt(img, x, y);
        compared++;
        const d = Math.max(Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]), Math.abs(got[2] - want[2]));
        if (d > worst) { worst = d; worstAt = `f${f} (${x},${y}) got ${fmt(got)} want ${fmt(want)}`; }
        if (d > TOL) {
          mismatches++;
          if (samples.length < 6) samples.push(`f${f} (${x},${y}) got ${fmt(got)} want ${fmt(want)}`);
        }
      }
    }
  }
  console.log(`        ${compared} pixels compared, ${skippedEdges} skipped as geometry edges, worst delta ${worst}`);
  check("the sweep actually sampled the picture", compared > 20000, String(compared));
  // A sweep that only ever landed on background would pass vacuously.
  check("and sampled painted pixels, not just background", (() => {
    let painted = 0;
    for (const img of frames.values()) {
      for (let y = 2; y < CANVAS; y += 3) for (let x = 2; x < CANVAS; x += 3) {
        const p = pixelAt(img, x, y);
        if (p[0] + p[1] + p[2] > 12) painted++;
      }
    }
    return painted > 2000;
  })(), "too few painted samples");
  check("GPU matches the CPU reference everywhere it is stable", mismatches === 0,
    `${mismatches} mismatches; e.g. ${samples.join(" | ")}`);
  if (worstAt && worst > 0) console.log(`        worst stable-pixel delta: ${worstAt}`);
}

// ---- 14. tolerance ----------------------------------------------------------------------------------------
// The contract says a player must be tolerant: ignore unknown fields, default missing optional ones, survive a
// malformed reference. All of that is only worth having if it has been PROVED once, because the artifact that
// exercises it will arrive from a bake nobody is watching.
console.log("\n[14] tolerance — a manifest that bends the contract still renders, and says what it found");
{
  const bentDir = path.join(tmp, "bent");
  const bent = JSON.parse(readFileSync(path.join(packedDir, "manifest.json"), "utf8"));

  bent.meta.somethingNewFromALaterBaker = { nested: true };      // unknown fields, every level
  bent.parts[0].futureField = "ignored";
  bent.frames[0].alsoUnknown = 7;
  delete bent.frames[0].drawOrder;                               // -> ascending slot order
  delete bent.frames[0].slots["0"].color;                        // -> [1,1,1,1]
  bent.frames[1].slots["1"].part = "p_does_not_exist";           // -> skipped + warned
  bent.pages[0].width = 999;                                     // lies about the page -> warned, decoded wins

  writePackedGeoclipFixture(bentDir, { pretty: true });          // pages + verts.bin + a manifest we overwrite
  writeFileSync(path.join(bentDir, "manifest.json"), JSON.stringify(bent, null, 2));

  const r = runDriver(["--artifact", bentDir, "--out", path.join(tmp, "bent-shots"),
    "--canvas", `${CANVAS}x${CANVAS}`, "--frames", "0-2", "--port", String(PORT)]);
  check("driver still exits 0", r.code === 0, `exit ${r.code}`);
  const bentFrames = loadFrames(path.join(tmp, "bent-shots"), [0, 1, 2]);
  check("no drawOrder: slots still draw in ascending index order",
    near(at(bentFrames, 0, 50, 165), RED) && near(at(bentFrames, 0, 110, 165), GREEN),
    `${fmt(at(bentFrames, 0, 50, 165))} / ${fmt(at(bentFrames, 0, 110, 165))}`);
  check("missing `color` defaults to [1,1,1,1]", near(at(bentFrames, 0, 50, 165), RED), fmt(at(bentFrames, 0, 50, 165)));
  const bentByIndex = Object.fromEntries((r.result?.frames ?? []).map((f) => [f.index, f]));
  check("an unknown part id is skipped, not fatal", bentByIndex[1]?.skipped.unknownPart === 1,
    JSON.stringify(bentByIndex[1]?.skipped));
  check("and the rest of that frame still drew", bentByIndex[1]?.drawn === 2, String(bentByIndex[1]?.drawn));
  const warnings = (r.result?.warnings ?? []).join(" | ");
  check("the page-size lie is reported", /declares width 999/.test(warnings), warnings);
  check("the unknown part is reported", /unknown part 'p_does_not_exist'/.test(warnings), warnings);
}

// ---- 15. packed geoclip/1 ----------------------------------------------------------------------------------
// Everything in this section is arithmetic on files: no browser, no GL. The point is that the format's claims
// ("one record per deforming slot", "the quant box is the part's own extent", "uvs do not move") are checkable
// without rendering anything, so a rendering failure later cannot be blamed on the encoder by hand-waving.
console.log("\n[15] packed geoclip/1 — manifest shape, vertsBin layout, determinism");
{
  check("packed output preserves the external raw fixture byte-for-byte",
    readFileSync(path.join(packedDir, "raw", "manifest.json"), "utf8") ===
    readFileSync(path.join(artifactDir, "manifest.json"), "utf8"));
  check("manifest.json + sheet-0.png + verts.bin written",
    ["manifest.json", "sheet-0.png", "verts.bin"].every((f) => existsSync(path.join(packedDir, f))));
  check("packed schema remains Couch geoclip/1", packedManifest.meta.schema === "geoclip/1", String(packedManifest.meta.schema));
  check("the rest of meta is carried over untouched",
    JSON.stringify({ ...packedManifest.meta, schema: null }) === JSON.stringify({ ...rawManifest.meta, schema: null }));
  check("pages[] describes the repacked sheets", packedManifest.pages.length === 1 && packedManifest.pages[0].file === "sheet-0.png",
    JSON.stringify(packedManifest.pages));
  {
    const img = decodePng(readFileSync(path.join(packedDir, "sheet-0.png")));
    check("the sheet's declared size is its decoded size",
      img.width === packedManifest.pages[0].width && img.height === packedManifest.pages[0].height,
      `${img.width}x${img.height} vs ${packedManifest.pages[0].width}x${packedManifest.pages[0].height}`);
    check("the sheet fits the 2048px cap", img.width <= 2048 && img.height <= 2048, `${img.width}x${img.height}`);
    check("and it is SMALLER than the page it was cut from", img.width * img.height < 128 * 128,
      `${img.width}x${img.height}`);
  }

  // parts: same shape, same uvs, same rect SIZE — only where the pixels live changed.
  const rawPartById = new Map(rawManifest.parts.map((p) => [String(p.id), p]));
  check("parts keep their id, uvs, indices and refVerts", packedManifest.parts.every((p) => {
    const was = rawPartById.get(String(p.id));
    return was && JSON.stringify(p.uvs) === JSON.stringify(was.uvs) &&
      JSON.stringify(p.indices) === JSON.stringify(was.indices) &&
      JSON.stringify(p.refVerts) === JSON.stringify(was.refVerts);
  }));
  check("parts keep their srcRect SIZE (uvs are normalised to it)", packedManifest.parts.every((p) => {
    const was = rawPartById.get(String(p.id));
    return p.srcRect[2] === was.srcRect[2] && p.srcRect[3] === was.srcRect[3];
  }));
  check("every part now points into a sheet, at +1 (inside the extrusion)",
    packedManifest.parts.every((p) => packedManifest.pages.some((pg) => pg.id === p.pageId) && p.srcRect[0] >= EXTRUDE && p.srcRect[1] >= EXTRUDE),
    JSON.stringify(packedManifest.parts.map((p) => [p.pageId, p.srcRect])));

  // frames: deforming slots carry vref, everything else is byte-for-byte the raw frame.
  const deforming = packedManifest.frames.flatMap((f, i) => Object.keys(f.slots).filter((k) => "vref" in f.slots[k]).map((k) => `${i}/${k}`));
  check("one vref per deforming slot — 8 frames x slot 1", deforming.length === 8 &&
    deforming.every((s) => s.endsWith("/1")), deforming.join(","));
  check("a vref slot carries NO verts", packedManifest.frames.every((f) => Object.values(f.slots).every((s) => !("vref" in s) || !("verts" in s))));
  check("rigid slots still carry their xform, untouched",
    packedManifest.frames.every((f, i) => JSON.stringify(f.slots["0"]) === JSON.stringify(rawManifest.frames[i].slots["0"])));
  check("drawOrder is unchanged, swap and all",
    packedManifest.frames.every((f, i) => JSON.stringify(f.drawOrder) === JSON.stringify(rawManifest.frames[i].drawOrder)));

  // vertsBin: the layout the decoder is entitled to assume.
  const bin = packedManifest.vertsBin;
  const binBytes = readFileSync(path.join(packedDir, "verts.bin"));
  check("vertsBin names verts.bin and counts 8 records", bin.file === "verts.bin" && bin.records === 8,
    JSON.stringify({ file: bin.file, records: bin.records }));
  check("one byte offset per record, strictly ascending",
    bin.offsets.length === bin.records && bin.offsets.every((o, i) => i === 0 ? o === 0 : o > bin.offsets[i - 1]),
    JSON.stringify(bin.offsets));
  // The mesh is 6 vertices: 6 x 2 x u16 = 24 bytes per record, 8 records = 192 bytes. Stated as literals so a
  // change to the record layout has to come and edit this line.
  check("records are vertCount x 2 u16 (24 bytes for the 6-vertex mesh)",
    bin.offsets.every((o, i) => o === i * 24) && binBytes.length === 8 * 24,
    `offsets ${bin.offsets.join(",")} / ${binBytes.length} bytes`);
  check("the quant box is the part's OWN extent over the whole clip",
    JSON.stringify(bin.quant) === JSON.stringify({ p_mesh: [100, 140, 220, 246] }), JSON.stringify(bin.quant));
  check("rigid parts get no quant entry (they have no records)", !("p_rigid" in bin.quant) && !("p_marker" in bin.quant));

  // Determinism: the packer is a build step, so a second run must produce the same bytes.
  const againDir = path.join(tmp, "packed-again");
  writePackedGeoclipFixture(againDir, { pretty: true });
  check("the packer is deterministic", ["manifest.json", "sheet-0.png", "verts.bin"].every((f) =>
    readFileSync(path.join(packedDir, f)).equals(readFileSync(path.join(againDir, f)))));
}

// ---- 16. quantisation ---------------------------------------------------------------------------------------
// The one way this format can be cheap AND wrong is by quantising too hard. So the error is MEASURED against the
// raw numbers it replaced, and compared to the bound the contract promises: range / 65535 per part.
console.log("\n[16] quantisation error is bounded, and the decode is the raw clip again");
let quantBound = 0;
{
  const bin = packedManifest.vertsBin;
  for (const box of Object.values(bin.quant)) {
    quantBound = Math.max(quantBound, (box[2] - box[0]) / QUANT_STEPS, (box[3] - box[1]) / QUANT_STEPS);
  }
  const decoded = decodePackedGeoclip(packedManifest, new Uint8Array(readFileSync(path.join(packedDir, "verts.bin"))));

  let worst = 0;
  let count = 0;
  for (let f = 0; f < rawManifest.frames.length; f++) {
    for (const key of Object.keys(rawManifest.frames[f].slots)) {
      const was = rawManifest.frames[f].slots[key].verts;
      if (!Array.isArray(was)) continue;
      const now = decoded.frames[f].slots[key].verts;
      check(`f${f} slot ${key}: decoded verts are a plain array of the right length`,
        Array.isArray(now) && now.length === was.length, `${Array.isArray(now)} / ${now && now.length}`);
      for (let i = 0; i < was.length; i++) { worst = Math.max(worst, Math.abs(now[i] - was[i])); count++; }
    }
  }
  console.log(`        ${count} coordinates round-tripped; worst error ${worst.toExponential(3)} px, ` +
    `bound ${quantBound.toExponential(3)} px`);
  check("every coordinate round-trips within the contract's bound", worst <= quantBound && count === 8 * 12,
    `worst ${worst} > ${quantBound} (${count} coordinates)`);
  check("and the bound itself is far below a pixel", quantBound < 0.01, String(quantBound));

  // Everything that is NOT a vertex must survive byte-for-byte: colours, xforms, draw orders, both flavours of
  // hidden slot. Stripping verts/vref from both sides turns that into one string compare.
  const strip = (frames) => JSON.stringify(frames.map((f) => ({
    ...f,
    slots: Object.fromEntries(Object.entries(f.slots).map(([k, s]) => [k, { ...s, verts: undefined, vref: undefined }]))
  })));
  check("decode returns the raw clip in every respect except the vertices",
    strip(decoded.frames) === strip(rawManifest.frames));
  check("decoded parts/pages are the SHEET's, not the old page's",
    JSON.stringify(decoded.parts) === JSON.stringify(packedManifest.parts) &&
    JSON.stringify(decoded.pages) === JSON.stringify(packedManifest.pages));

  // A vref the bin cannot honour is the packed-shaped version of "verts of the wrong length": report it, drop the
  // vertices, let the player's existing fallback draw the part. Never invent numbers, never throw.
  const bent = JSON.parse(JSON.stringify(packedManifest));
  bent.frames[0].slots["1"].vref = 99;                       // past the end of offsets[]
  bent.frames[1].slots["1"].part = "p_does_not_exist";       // no vert count, no quant box
  const warned = [];
  const bentClip = decodePackedGeoclip(bent, new Uint8Array(readFileSync(path.join(packedDir, "verts.bin"))),
    { onWarn: (m) => warned.push(m) });
  check("an unresolvable vref is warned, not guessed",
    warned.length === 2 && warned.every((w) => /vref/.test(w)), JSON.stringify(warned));
  check("and its slot comes back with neither verts nor vref",
    !("verts" in bentClip.frames[0].slots["1"]) && !("vref" in bentClip.frames[0].slots["1"]));
  check("the frames around it still decode", Array.isArray(bentClip.frames[2].slots["1"].verts));
}

// ---- 17. the repacked sheet ---------------------------------------------------------------------------------
// Three claims about the sheet, each checked on every pixel it concerns: the crop is the same pixels, the 1px
// extrusion really replicates the border (so a uv of 0 or 1 under LINEAR samples the part's own colour), and the
// 2px gutter beyond it is empty (so no neighbour can bleed in even if a sampler overshoots).
console.log("\n[17] repacked sheets — lossless crops, real extrusion, empty gutters");
{
  const page = decodePng(readFileSync(path.join(artifactDir, "page-0.png")));
  const sheet = decodePng(readFileSync(path.join(packedDir, "sheet-0.png")));
  const rawPartById = new Map(rawManifest.parts.map((p) => [String(p.id), p]));
  const px = (img, x, y) => {
    const o = (y * img.width + x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
  };
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

  let cropPixels = 0;
  let cropBad = 0;
  let ringPixels = 0;
  let ringBad = 0;
  let gutterPixels = 0;
  let gutterBad = 0;
  let firstBad = "";
  for (const part of packedManifest.parts) {
    const was = rawPartById.get(String(part.id));
    const [sx, sy, w, h] = part.srcRect;
    const [ox, oy] = was.srcRect;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        cropPixels++;
        if (!same(px(sheet, sx + x, sy + y), px(page, ox + x, oy + y))) {
          cropBad++;
          if (!firstBad) firstBad = `part ${part.id} crop (${x},${y})`;
        }
      }
    }
    // distance 1 = the extrusion (must replicate the nearest border texel);
    // distance 2 = the gutter (must be untouched, i.e. fully transparent).
    for (let d = 1; d <= EXTRUDE + 1; d++) {
      for (let x = sx - d; x <= sx + w - 1 + d; x++) {
        for (const y of [sy - d, sy + h - 1 + d]) {
          if (x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) continue;
          const clampX = Math.min(sx + w - 1, Math.max(sx, x));
          const clampY = Math.min(sy + h - 1, Math.max(sy, y));
          if (d <= EXTRUDE) {
            ringPixels++;
            if (!same(px(sheet, x, y), px(sheet, clampX, clampY))) { ringBad++; if (!firstBad) firstBad = `part ${part.id} extrusion (${x},${y})`; }
          } else {
            gutterPixels++;
            if (px(sheet, x, y)[3] !== 0) { gutterBad++; if (!firstBad) firstBad = `part ${part.id} gutter (${x},${y}) alpha ${px(sheet, x, y)[3]}`; }
          }
        }
      }
      for (let y = sy - d + 1; y <= sy + h - 2 + d; y++) {
        for (const x of [sx - d, sx + w - 1 + d]) {
          if (x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) continue;
          const clampX = Math.min(sx + w - 1, Math.max(sx, x));
          const clampY = Math.min(sy + h - 1, Math.max(sy, y));
          if (d <= EXTRUDE) {
            ringPixels++;
            if (!same(px(sheet, x, y), px(sheet, clampX, clampY))) { ringBad++; if (!firstBad) firstBad = `part ${part.id} extrusion (${x},${y})`; }
          } else {
            gutterPixels++;
            if (px(sheet, x, y)[3] !== 0) { gutterBad++; if (!firstBad) firstBad = `part ${part.id} gutter (${x},${y}) alpha ${px(sheet, x, y)[3]}`; }
          }
        }
      }
    }
  }
  console.log(`        ${cropPixels} crop / ${ringPixels} extrusion / ${gutterPixels} gutter pixels checked`);
  check("every crop is the raw page's pixels, unchanged", cropBad === 0 && cropPixels === 3 * 32 * 32,
    `${cropBad} bad of ${cropPixels}${firstBad ? `; first ${firstBad}` : ""}`);
  check("the extrusion replicates the border on all four sides + corners", ringBad === 0 && ringPixels > 0,
    `${ringBad} bad of ${ringPixels}${firstBad ? `; first ${firstBad}` : ""}`);
  check("the gutter beyond it is transparent — no neighbour can bleed in", gutterBad === 0 && gutterPixels > 0,
    `${gutterBad} bad of ${gutterPixels}${firstBad ? `; first ${firstBad}` : ""}`);
  // The fixture's fourth page block is referenced by nothing. In a raw page it ships anyway; a repack must simply
  // not carry it, which is most of where the size win comes from.
  let magenta = 0;
  for (let i = 0; i < sheet.data.length; i += 4) {
    if (sheet.data[i] > 200 && sheet.data[i + 1] < 40 && sheet.data[i + 2] > 200) magenta++;
  }
  check("the unreferenced page block is not in the sheet at all", magenta === 0, `${magenta} pixels`);
}

// ---- 18. packed replay ------------------------------------------------------------------------------
// The Couch player renders only packed input. `--truth` here is section [2]'s packed screenshot, proving that
// this second player run is deterministic; section [13]'s raw CPU oracle is the independent raw-vs-packed check.
console.log("\n[18] the packed clip replays deterministically, frame for frame");
{
  const packedShots = path.join(tmp, "packed-shots");
  const r = runDriver([
    "--artifact", packedDir, "--out", packedShots,
    "--canvas", `${CANVAS}x${CANVAS}`, "--all",
    "--truth", shotsDir, "--truth-pattern", "frame-%04d.png",
    "--port", String(PORT)
  ]);
  check("driver exits 0 on a packed geoclip/1 artifact", r.code === 0, `exit ${r.code}`);
  check("the harness reports schema geoclip/1", r.result?.schema === "geoclip/1", String(r.result?.schema));
  check("it decoded 8 vertex records from verts.bin", r.result?.vertsDecoded === 8, String(r.result?.vertsDecoded));
  check("no GL errors, no warnings", r.result?.glErrors === 0 && (r.result?.warnings ?? []).length === 0,
    JSON.stringify(r.result?.warnings));
  check("every frame still draws its deforming part", (r.result?.frames ?? []).every((f) => f.deforming === 1));

  const summary = JSON.parse(readFileSync(path.join(packedShots, "summary.json"), "utf8"));
  const worst = summary.frames.reduce((a, f) => Math.max(a, f.rmse ?? Infinity), 0);
  console.log(`        per-frame RMSE vs the first packed render: mean ${summary.meanRmse}, worst ${worst}`);
  // A vertex moved by <= 1.8e-3 px cannot move a pixel: LINEAR sampling is continuous in the vertex position, so
  // the tolerance here is "exactly the same picture", not a loosened one. Kept as a named constant with the
  // quantisation bound beside it so that if this ever becomes non-zero the number is compared to something.
  check("every frame is pixel-identical to the first packed render", summary.frames.every((f) => f.rmse === 0),
    summary.frames.map((f) => `f${f.index}=${f.rmse}`).join(" "));
  check(`(the vertices moved by at most ${quantBound.toExponential(2)} px)`, quantBound < 0.01, String(quantBound));

  // And the independent CPU reference again, this time reading the PACKED clip: same rasteriser, new srcRects,
  // new sheet, dequantised vertices. It is what proves the packed pictures are right and not merely equal to raw.
  const sheet = decodePng(readFileSync(path.join(packedDir, "sheet-0.png")));
  const decoded = decodePackedGeoclip(packedManifest, new Uint8Array(readFileSync(path.join(packedDir, "verts.bin"))));
  const packedFrames = loadFrames(packedShots, [0, 1, 2, 3, 4, 5, 6, 7]);
  let compared = 0;
  let mismatches = 0;
  let worstDelta = 0;
  const samples = [];
  for (let f = 0; f < decoded.frames.length; f++) {
    const img = packedFrames.get(f);
    for (let y = 2; y < CANVAS; y += 3) {
      for (let x = 2; x < CANVAS; x += 3) {
        const want = stableOracle(decoded, sheet, f, x, y);
        if (!want) continue;
        const got = pixelAt(img, x, y);
        compared++;
        const d = Math.max(Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]), Math.abs(got[2] - want[2]));
        if (d > worstDelta) worstDelta = d;
        if (d > TOL) { mismatches++; if (samples.length < 6) samples.push(`f${f} (${x},${y}) got ${fmt(got)} want ${fmt(want)}`); }
      }
    }
  }
  console.log(`        ${compared} pixels compared against the CPU reference, worst delta ${worstDelta}`);
  check("the CPU reference agrees with the packed render too", mismatches === 0 && compared > 20000,
    `${mismatches} mismatches of ${compared}; e.g. ${samples.join(" | ")}`);

  // The harness carries its OWN copy of the decode (it imports nothing), so the tolerance rule has to be proved
  // in the browser and not only in the library: a broken vref must warn and fall back, never take the page down.
  const bentDir = path.join(tmp, "packed-bent");
  writePackedGeoclipFixture(bentDir, { pretty: true });
  const bentManifest = JSON.parse(readFileSync(path.join(bentDir, "manifest.json"), "utf8"));
  bentManifest.frames[0].slots["1"].vref = 99;
  bentManifest.futureFieldFromALaterPacker = { nested: true };
  writeFileSync(path.join(bentDir, "manifest.json"), JSON.stringify(bentManifest, null, 2));
  const bent = runDriver(["--artifact", bentDir, "--out", path.join(tmp, "packed-bent-shots"),
    "--canvas", `${CANVAS}x${CANVAS}`, "--frames", "0", "--port", String(PORT)]);
  check("the harness survives an unresolvable vref", bent.code === 0, `exit ${bent.code}`);
  check("it warns about it", (bent.result?.warnings ?? []).some((w) => /vref 99/.test(w)),
    JSON.stringify(bent.result?.warnings));
  check("and still draws the rest of the frame", bent.result?.frames?.[0]?.drawn === 2,
    String(bent.result?.frames?.[0]?.drawn));
}

// ---- 19. size -----------------------------------------------------------------------------------------------
// The reason the schema exists. Both numbers matter and they do not move together: raw is what the host holds in
// memory and what a disk cache pays, gzip is what the phone downloads.
console.log("\n[19] packed geoclip/1 is smaller than the external raw bake");
const measureFiles = (dir, files) => files.reduce((acc, f) => {
  const buf = readFileSync(path.join(dir, f));
  return { raw: acc.raw + statSync(path.join(dir, f)).size, gzip: acc.gzip + gzipSync(buf, { level: 9 }).length };
}, { raw: 0, gzip: 0 });
const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;
{
  const before = measureFiles(artifactDir, ["manifest.json", "page-0.png"]);
  const after = measureFiles(packedDir, ["manifest.json", "sheet-0.png", "verts.bin"]);
  console.log(`        fixture:  raw ${before.raw} raw / ${before.gzip} gzip   ->   packed ${after.raw} raw / ` +
    `${after.gzip} gzip   (${pct(after.raw, before.raw)} raw, ${pct(after.gzip, before.gzip)} gzip)`);
  check("packed is smaller raw", after.raw < before.raw, `${after.raw} vs ${before.raw}`);
  // GZIP GOES THE OTHER WAY ON THE FIXTURE, and that is a fact about the fixture, not about the schema: 8 frames
  // of a 6-vertex part whose coordinates are WHOLE NUMBERS is 96 integers that deflate to almost nothing, while
  // the binary form pays a per-record byte offset in the manifest and hands deflate 192 bytes of high-entropy
  // u16. Asserting a gzip win here would only teach someone to make the fixture unrealistic. So the assertion
  // that matters is made at a realistic scale below, and this one is recorded as what it is.
  check("(and its gzip regression is bounded — the toy scale, not the schema)", after.gzip < before.gzip * 1.25,
    `${after.gzip} vs ${before.gzip}`);
}

// The same clip at the shape a real bake has: hundreds of frames, and vertices that are MEASUREMENTS (3 decimal
// places) rather than authored round numbers. That is where JSON stops being cheap — 345.931 costs seven bytes
// and deflates badly, while the u16 pair costs four and does not care.
{
  const bigRaw = path.join(tmp, "scaled-raw");
  const bigPacked = path.join(tmp, "scaled-packed");
  writeGeoclipFixture(bigRaw, { pretty: false });          // for its page-0.png; the manifest is replaced below
  const big = JSON.parse(readFileSync(path.join(artifactDir, "manifest.json"), "utf8"));
  const FRAMES = 400;
  // A deterministic wobble: no clock, no randomness, and the same values on every machine.
  const wobble = (f, i) => Number((Math.sin(f * 0.37 + i * 1.13) * 3.5).toFixed(3));
  big.frames = Array.from({ length: FRAMES }, (_, f) => {
    const src = rawManifest.frames[f % rawManifest.frames.length];
    const slots = {};
    for (const [k, s] of Object.entries(src.slots)) {
      slots[k] = Array.isArray(s.verts)
        ? { ...s, verts: s.verts.map((v, i) => Number((v + wobble(f, i)).toFixed(3))) }
        : s;
    }
    return { ...src, t: Number((f / big.meta.fps).toFixed(6)), slots };
  });
  big.meta.frameCount = FRAMES;
  big.meta.boundsPerFrame = Array.from({ length: FRAMES }, (_, f) => big.meta.boundsPerFrame[f % 8]);
  writeFileSync(path.join(bigRaw, "manifest.json"), JSON.stringify(big) + "\n");

  const report = packGeoclipDir(bigRaw, bigPacked);
  const before = measureFiles(bigRaw, ["manifest.json", "page-0.png"]);
  const after = measureFiles(bigPacked, ["manifest.json", "sheet-0.png", "verts.bin"]);
  console.log(`        ${FRAMES} frames: raw ${before.raw} raw / ${before.gzip} gzip   ->   packed ${after.raw} raw / ` +
    `${after.gzip} gzip   (${pct(after.raw, before.raw)} raw, ${pct(after.gzip, before.gzip)} gzip)`);
  check(`at ${FRAMES} frames of measured vertices, packed is smaller raw`, after.raw < before.raw,
    `${after.raw} vs ${before.raw}`);
  check(`at ${FRAMES} frames of measured vertices, packed is smaller gzipped`, after.gzip < before.gzip,
    `${after.gzip} vs ${before.gzip}`);
  check("the scaled pack really did carry every frame as a record", report.stats.records === FRAMES,
    `${report.stats.records} records`);
}

// ---- 20. more than one sheet --------------------------------------------------------------------------------
// A real rig can overflow the 2048px cap, and a repacker's classic bug is a part left pointing at the sheet it
// USED to be on. The cap is a parameter, so the case is reachable without a 2048px fixture: pack the same clip
// into 40px sheets and the three parts land on three different ones.
console.log("\n[20] sheets roll over at the cap, and the player still draws the clip");
{
  const multiDir = path.join(tmp, "packed-multi");
  const report = packGeoclipDir(artifactDir, multiDir, { pretty: true, maxSize: 40 });
  const m = report.manifest;
  check("three crops, three sheets", m.pages.length === 3 && m.pages.every((p, i) => p.file === `sheet-${i}.png`),
    JSON.stringify(m.pages));
  check("each sheet file exists and decodes to its declared size", m.pages.every((p) => {
    const img = decodePng(readFileSync(path.join(multiDir, p.file)));
    return img.width === p.width && img.height === p.height && img.width <= 40 && img.height <= 40;
  }));
  check("the parts are spread across all three", new Set(m.parts.map((p) => p.pageId)).size === 3,
    JSON.stringify(m.parts.map((p) => [p.id, p.pageId, p.srcRect])));

  const shots = path.join(tmp, "packed-multi-shots");
  const r = runDriver(["--artifact", multiDir, "--out", shots, "--canvas", `${CANVAS}x${CANVAS}`,
    "--frames", "0-1", "--truth", shotsDir, "--truth-pattern", "frame-%04d.png", "--port", String(PORT)]);
  check("driver exits 0", r.code === 0, `exit ${r.code}`);
  check("the harness loaded three pages", r.result && (r.result.warnings ?? []).length === 0,
    JSON.stringify(r.result?.warnings));
  const summary = JSON.parse(readFileSync(path.join(shots, "summary.json"), "utf8"));
  check("a three-sheet clip renders exactly the one-page picture",
    summary.frames.length === 2 && summary.frames.every((f) => f.rmse === 0),
    summary.frames.map((f) => `f${f.index}=${f.rmse}`).join(" "));
}

// ---- 21. the passthrough arm ---------------------------------------------------------------------------------
// `--repack never` writes the referenced pages out as the sheets, byte for byte, and moves nothing else. It exists
// because a repack optimises DECODED TEXTURE AREA and does not always win: on byrdonis the shelf pack plans
// 710,185 px^2 where the page is 573,460, so it would spend ~547 KB of decoded RGBA to save 25 KB of PNG. `auto`
// makes that call by measurement, which is what the last two checks here are about.
//
// The load-bearing check is the RMSE one: the same driver, the same canvas and fit, playing the passthrough
// artifact, diffed against section [2]'s packed screenshots. Everything above it is arithmetic saying the bytes and
// the numbers stayed still; only a browser can say that no DECODER can tell.
//
// Section [17]'s extrusion / gutter / canary asserts are deliberately NOT reused here — they are repack-only
// properties. Under passthrough the fixture's magenta canary block IS in the sheet; it simply is never sampled,
// which is what section [9]'s zero-magenta sweep already proves about the pixels that reach a canvas.
console.log("\n[21] --repack never — the page IS the sheet, and no decoder can tell");
{
  const ptDir = path.join(tmp, "packed-passthrough");
  const report = packGeoclipDir(artifactDir, ptDir, { pretty: true, repack: "never" });
  const m = report.manifest;

  check("manifest.json + sheet-0.png + verts.bin written",
    ["manifest.json", "sheet-0.png", "verts.bin"].every((f) => existsSync(path.join(ptDir, f))));
  // Not "decodes to the same pixels": the same BYTES. A re-encode would pass a pixel compare while quietly making
  // the arm's whole claim ("it copies the page") unfalsifiable.
  check("the sheet is byte-identical to the fixture's page-0.png",
    readFileSync(path.join(ptDir, "sheet-0.png")).equals(readFileSync(path.join(artifactDir, "page-0.png"))));
  check("the sheet is the page's size, not a crop of it",
    m.pages.length === 1 && m.pages[0].width === 128 && m.pages[0].height === 128, JSON.stringify(m.pages));

  // `pageId` is the ONE field this arm touches: unreferenced pages are dropped, so the survivors are renumbered
  // 0..n-1 to agree with their sheet-<k>.png names ("p0" -> 0 here). Everything that addresses PIXELS — srcRect,
  // uvs, indices, refVerts — has to be the raw array, verbatim.
  const withoutPageId = (parts) => JSON.stringify(parts.map(({ pageId, ...rest }) => rest));
  check("srcRect / uvs / indices / refVerts are the raw arrays, verbatim",
    withoutPageId(m.parts) === withoutPageId(rawManifest.parts),
    JSON.stringify(m.parts.map((p) => [p.id, p.srcRect])));
  check("only pageId moved, onto the one surviving sheet",
    m.parts.every((p) => p.pageId === 0) && rawManifest.parts.every((p) => p.pageId === "p0"),
    JSON.stringify(m.parts.map((p) => p.pageId)));

  // It is still a packed Couch geoclip/1 artifact — the vertex tracks are binary whichever arm the pages took.
  check("it is packed geoclip/1 with binary vertex tracks",
    m.meta.schema === "geoclip/1" && m.vertsBin.records === 8,
    `${m.meta.schema} / ${m.vertsBin.records} records`);
  check("packing records the arm and that nothing was extruded",
    m.packing.mode === "passthrough" && m.packing.extruded === false, JSON.stringify(m.packing));

  const ptShots = path.join(tmp, "packed-passthrough-shots");
  const r = runDriver([
    "--artifact", ptDir, "--out", ptShots,
    "--canvas", `${CANVAS}x${CANVAS}`, "--all",
    "--truth", shotsDir, "--truth-pattern", "frame-%04d.png",
    "--port", String(PORT)
  ]);
  check("driver exits 0 on a passthrough artifact", r.code === 0, `exit ${r.code}`);
  check("no GL errors, no warnings", r.result?.glErrors === 0 && (r.result?.warnings ?? []).length === 0,
    JSON.stringify(r.result?.warnings));
  const summary = JSON.parse(readFileSync(path.join(ptShots, "summary.json"), "utf8"));
  check("every frame is pixel-identical to the packed reference — the decoders cannot tell",
    summary.frames.length === 8 && summary.frames.every((f) => f.rmse === 0),
    summary.frames.map((f) => `f${f.index}=${f.rmse}`).join(" "));

  // And `auto` is a measurement, not a coin flip: the fixture's parts are 3 x 32x32 out of a 128x128 page, so a
  // repack plans 3,604 px^2 against 16,384 px^2 referenced and auto must take it. (Byrdonis is the other side of
  // that same comparison — it is why the arm exists — but no real bake can be committed, so the fixture proves
  // the branch and geoclip-pack.mjs prints the number for the rig in front of you.)
  const autoDir = path.join(tmp, "packed-auto");
  const auto = packGeoclipDir(artifactDir, autoDir, { repack: "auto" });
  check("auto REPACKS the fixture, because the plan beats the page", auto.stats.mode === "repack",
    `${auto.stats.mode}: planned ${auto.stats.consideredSheetArea} vs referenced ${auto.stats.referencedArea}`);
  check("and it chose on the areas it reports",
    auto.stats.consideredSheetArea < auto.stats.referencedArea && auto.stats.referencedArea === 128 * 128,
    JSON.stringify({ planned: auto.stats.consideredSheetArea, referenced: auto.stats.referencedArea }));
}

// ---------------------------------------------------------------------------------------------------------
console.log("");
if (failures) {
  console.log(`SELFTEST FAILED: ${failures} of ${checks} check(s) failed. Artifacts kept at ${tmp}`);
  process.exit(1);
}
if (!KEEP) rmSync(tmp, { recursive: true, force: true });
console.log(`SELFTEST OK — ${checks} checks passed.${KEEP ? ` Artifacts at ${tmp}` : ""}`);
