#!/usr/bin/env node
// Trail visual-comparison harness — renders the mirror client's card-trail comet at chosen recorded-stream
// instants under several client configurations ("arms"), then produces one labeled side-by-side image plus a
// numeric summary. Built on scripts/probe-card-trail-replay.mjs (READ IT FIRST): that probe already knows how to
// load a recording into a real mirror page and stop it at a given `--at` ms, so this harness's only job is to
// call it once per (instant × arm), then use ImageMagick to crop/label/stack the results and measure them.
//
//   node scripts/compare-card-trail.mjs \
//     --url http://127.0.0.1:5201 \
//     --recording .sts2/bench/r13-discard-10.ndjson \
//     --at 3750 \
//     --arm default= \
//     --arm nodeco=trailDecimate=off \
//     --out .sts2/artifacts/r14-trail/harness-selftest
//
// Each `--arm <label>=<queryString>` becomes one column (queryString may be empty, e.g. `default=`, for the
// client's own defaults); each `--at` becomes one row. `--baseline <label>` (default: the first `--arm`) is the
// column every other column is RMSE-diffed against, on the SAME crop. `--crop <WxH+X+Y>` restricts both the
// visual stack and the numeric metrics to the region around the flight (default: the full frame). `--real <png>`
// (repeatable) appends real-game reference frames as a final row, for eyeballing the synthesized comet against
// the thing it is imitating.
//
// Output: `<out>/crop-stack.png` (the labeled grid) + `<out>/summary.json` ({ perAt: { <at>: { <arm>: {
// rmseVsBaseline, trimSpan: {w,h} } } } }). Every intermediate PNG (raw probe screenshot, crop, labeled tile) is
// also left in `<out>/` for inspection.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_SCRIPT = resolve(REPO_ROOT, "scripts/probe-card-trail-replay.mjs");

// ---------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    url: "http://127.0.0.1:5199",
    recording: null,
    ats: [],
    arms: [], // { label, query }
    baseline: null,
    crop: null, // raw "WxH+X+Y" string, verbatim for -crop
    reals: [],
    out: null,
    width: 1920,
    height: 1080,
    settleMs: 400,
    resRoot: null,
    // R5 T-DR5 — capture at a chosen point of the comet's own decay instead of after a flat settle. 0 = settle-only.
    ageMs: 0,
    // The probe's own default is 4000ms, which the REPLAY ITSELF can consume: delivery runs at recorded pace, so
    // an `--at` beyond ~2.5s leaves the gate no window at all and it times out BEFORE the comet exists — both
    // arms then capture on a race, which is the exact confound `--age` was built to remove. Sized per run:
    // at-ms + flight (~1.4s) + age + slack.
    ageTimeoutMs: null,
    // R5 T-DR6 — `<onLabel>=<offLabel>` pairs; each becomes one arm's own comet mask (see the corridor block).
    corridors: [],
    help: false,
    parseError: false
  };
  const bad = (message) => { console.error(`compare-card-trail: ${message}`); a.parseError = true; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [key, inlineVal] = eq > 0 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const val = () => inlineVal ?? argv[++i];
    switch (key) {
      case "--url": a.url = val(); break;
      case "--recording": a.recording = val(); break;
      case "--at": {
        const raw = val();
        const n = Number(raw);
        if (!Number.isFinite(n)) { bad(`--at must be a number (got '${raw}')`); break; }
        a.ats.push(n);
        break;
      }
      case "--arm": {
        const raw = val();
        const idx = raw.indexOf("=");
        if (idx < 0) { bad(`--arm must be <label>=<queryString> (got '${raw}')`); break; }
        a.arms.push({ label: raw.slice(0, idx), query: raw.slice(idx + 1) });
        break;
      }
      case "--baseline": a.baseline = val(); break;
      case "--crop": {
        const raw = val();
        if (!/^\d+x\d+\+\d+\+\d+$/.test(raw)) { bad(`--crop must be WxH+X+Y (got '${raw}')`); break; }
        a.crop = raw;
        break;
      }
      case "--real": a.reals.push(resolve(val())); break;
      case "--out": a.out = val(); break;
      case "--width": a.width = Number(val()); break;
      case "--height": a.height = Number(val()); break;
      case "--settle": a.settleMs = Number(val()); break;
      case "--age": {
        const n = Number(val());
        if (!Number.isFinite(n) || n < 0) { bad(`--age must be a non-negative number of ms`); break; }
        a.ageMs = n;
        break;
      }
      case "--age-timeout": {
        const n = Number(val());
        if (!Number.isFinite(n) || n <= 0) { bad(`--age-timeout must be a positive number of ms`); break; }
        a.ageTimeoutMs = n;
        break;
      }
      case "--corridor": {
        const raw = val();
        const idx = raw.indexOf("=");
        if (idx < 0) { bad(`--corridor must be <onLabel>=<offLabel> (got '${raw}')`); break; }
        a.corridors.push({ on: raw.slice(0, idx), off: raw.slice(idx + 1) });
        break;
      }
      // Forwarded verbatim to the probe. MANDATORY for any arm involving particles: without real sprite bytes
      // every emitter paints nothing AND gsw refuses to key an undecoded texture, so both arms render the same
      // empty scene and this harness dutifully reports RMSE 0 — "no visual difference" for a mechanism that
      // never ran. See the flag's own note in probe-card-trail-replay.mjs.
      case "--res-root": a.resRoot = inlineVal ?? (argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[++i] : "default"); break;
      case "--help": case "-h": a.help = true; break;
      default: bad(`Unknown argument: ${arg}`);
    }
  }
  return a;
}

const HELP = `compare-card-trail.mjs — trail visual-comparison harness (multi-arm × multi-instant)

  --url <origin>          dev server serving the code under test (default http://127.0.0.1:5199)
  --recording <ndjson>    NDJSON recording to replay (required, see scripts/record-mirror-stream.mjs)
  --at <ms>               recorded-stream instant to screenshot (repeatable; at least one required)
  --arm <label>=<query>   one column: a client query-string variant (repeatable; at least one required).
                          queryString may be empty for the client's own defaults, e.g. --arm default=
  --baseline <label>      the --arm every other arm is RMSE-diffed against (default: the first --arm)
  --crop <WxH+X+Y>        ImageMagick crop geometry around the flight (default: full frame)
  --real <png>            a real-game reference frame, appended as a final labeled row (repeatable)
  --out <dir>             output directory (required) — raw/crop/tile PNGs, crop-stack.png, summary.json
  --width <px>            probe viewport width (default 1920)
  --height <px>           probe viewport height (default 1080)
  --settle <ms>           probe post-stop settle wait (default 400, see probe-card-trail-replay.mjs)
  --age <ms>              capture each arm once its card has LANDED and this many ms have passed since the
                          last trail point was laid down, instead of after a flat settle. A trail decays over
                          800ms and the two arms age on different clocks, so without this every cross-arm
                          RMSE is measuring decay phase. The summary reports each arm's phase and REFUSES
                          (loudly) when two arms disagree. 150-250 is a good window: late enough that the
                          flight has settled, early enough that the ribbon has not drained.
  --age-timeout <ms>      how long the probe may wait for the age gate (probe default 4000). The REPLAY runs
                          at recorded pace inside this window, so an --at beyond ~2.5s needs this raised:
                          at-ms + flight (~1.4s) + age + slack, or the gate expires before the comet exists.
  --corridor <on>=<off>   build one arm's own comet mask by diffing its trails-ON capture against its
                          trails-OFF one (repeatable). Two or more give an IoU + centroid + box-edge
                          agreement between the arms' corridors — a position-and-extent claim that a
                          brightness difference cannot move, which is what a higher-fidelity arm needs.
  --res-root [dir]        serve '/res/**' from an extracted resource root (default: the local one).
                          MANDATORY for any particle arm — without it every sprite 404s, gsw refuses to key an
                          undecoded texture, and both arms render the same nothing at RMSE 0.
  --help`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.parseError) {
  console.error(HELP);
  process.exit(2);
}
if (!args.recording) fail("--recording is required");
if (!args.out) fail("--out is required");
if (args.ats.length === 0) fail("at least one --at is required");
if (args.arms.length === 0) fail("at least one --arm is required");
const labels = args.arms.map((a) => a.label);
if (new Set(labels).size !== labels.length) fail(`--arm labels must be unique (got: ${labels.join(", ")})`);
const baselineLabel = args.baseline ?? args.arms[0].label;
if (!labels.includes(baselineLabel)) {
  fail(`--baseline '${baselineLabel}' does not match any --arm label (have: ${labels.join(", ")})`);
}

const recordingPath = resolve(REPO_ROOT, args.recording);
readFileSync(recordingPath); // fail fast with a clear ENOENT rather than deep inside a spawned probe
const outDir = resolve(REPO_ROOT, args.out);
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------------------------------------
// small process/log helpers — every external command failure is fatal and says exactly what ran
// ---------------------------------------------------------------------------------------------------------

function fail(message) {
  console.error(`compare-card-trail: ${message}`);
  process.exit(2);
}

function log(message) {
  console.log(`[compare-card-trail] ${message}`);
}

function run(cmd, cmdArgs, label) {
  const result = spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    fail(`${label} failed to launch (${cmd}): ${result.error.message}`);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// probe invocation — one real Chromium run per (at × arm), exactly scripts/probe-card-trail-replay.mjs's contract
// ---------------------------------------------------------------------------------------------------------

function runProbe(at, arm, outPath) {
  log(`probe at=${at}ms arm=${arm.label} (query='${arm.query}') -> ${outPath}`);
  const result = run(
    process.execPath,
    [
      PROBE_SCRIPT,
      "--url", args.url,
      "--recording", recordingPath,
      "--at", String(at),
      "--out", outPath,
      "--query", arm.query,
      ...(args.resRoot ? (args.resRoot === "default" ? ["--res-root"] : ["--res-root", args.resRoot]) : []),
      "--width", String(args.width),
      "--height", String(args.height),
      "--settle", String(args.settleMs),
      // THE AGE GATE, forwarded (see the probe's own note). Without it every arm is captured after a flat
      // settle, i.e. at whatever point of its 800 ms decay it happened to reach — and two arms aging on two
      // clocks make a crop comparison meaningless.
      ...(args.ageMs > 0 ? ["--age", String(args.ageMs)] : []),
      ...(args.ageTimeoutMs != null ? ["--age-timeout", String(args.ageTimeoutMs)] : [])
    ],
    `probe(at=${at}, arm=${arm.label})`
  );
  if (result.status !== 0) {
    fail(
      `probe-card-trail-replay.mjs failed for at=${at}ms arm=${arm.label} (exit ${result.status})\n` +
        `  stdout: ${(result.stdout ?? "").trim()}\n  stderr: ${(result.stderr ?? "").trim()}`
    );
  }
  // The probe prints ONE JSON object. Its `trailPhase` is what the cross-arm gate below reads, and its
  // `shotRefused` is what says the PNG beside it is the stage rather than the overlay.
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`probe-card-trail-replay.mjs produced unparseable JSON for at=${at}ms arm=${arm.label}:\n${result.stdout}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// the CROSS-ARM PHASE GATE — run before any pixel is measured
// ---------------------------------------------------------------------------------------------------------
//
// A comet is a decaying record of motion: what is on screen is a function of how old every point is, and every
// point dies 800 ms after it was laid down. Two arms stopped at the same recorded millisecond are therefore not
// showing the same picture unless their histories match — and if they do not, an RMSE between their crops
// measures the mismatch and reports it as fidelity. That is exactly what happened in round 4.
//
// So: compare the two probes' own phase readings first, and REFUSE with numbers rather than produce a
// confounded number. The tolerances are one poll interval's worth of drift, not a fudge factor.
const PHASE_TOLERANCE = {
  points: 2, // ±1 sample on each of a comet's two strokes
  headPx: 8, // a card moves ~23px per frame at flight speed; this is well under one
  arcFraction: 0.05,
  headAgeMs: 20 // ~one display frame
};

function phaseAgreement(baselineLabel, baseline, label, phase) {
  if (!baseline || !phase) {
    return { ok: false, why: `${!baseline ? baselineLabel : label} published no trail phase (no __mirrorTrailProbe)` };
  }
  if (baseline.strokes === 0 || phase.strokes === 0) {
    // A trails-OFF arm has no comet BY CONSTRUCTION — it is the thing a corridor mask is diffed against, not a
    // thing to be phase-matched. There is no picture to be at the wrong phase of.
    return { ok: true, noComet: true, why: null };
  }
  const dPoints = Math.abs(baseline.points - phase.points);
  const dHead =
    baseline.headX === null || phase.headX === null
      ? Infinity
      : Math.hypot(baseline.headX - phase.headX, baseline.headY - phase.headY);
  const dArc = Math.abs(baseline.arcPx - phase.arcPx) / Math.max(1, baseline.arcPx);
  const dHeadAge = Math.abs(baseline.headAgeMs - phase.headAgeMs);
  const failures = [];
  if (dPoints > PHASE_TOLERANCE.points) failures.push(`points ${baseline.points} vs ${phase.points}`);
  if (dHead > PHASE_TOLERANCE.headPx) failures.push(`head ${dHead.toFixed(1)}px apart`);
  if (dArc > PHASE_TOLERANCE.arcFraction) failures.push(`arc ${(dArc * 100).toFixed(1)}% apart`);
  if (dHeadAge > PHASE_TOLERANCE.headAgeMs) failures.push(`head age ${dHeadAge.toFixed(0)}ms apart`);
  return {
    ok: failures.length === 0,
    why: failures.join(", "),
    deltas: {
      points: dPoints,
      headPx: Number.isFinite(dHead) ? Math.round(dHead * 10) / 10 : null,
      arcFraction: Math.round(dArc * 1000) / 1000,
      headAgeMs: Math.round(dHeadAge)
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// ImageMagick helpers
// ---------------------------------------------------------------------------------------------------------

function imageSize(path) {
  const result = run("identify", ["-format", "%wx%h", path], `identify(${path})`);
  if (result.status !== 0) {
    fail(`identify failed on ${path} (exit ${result.status}): ${(result.stderr ?? "").trim()}`);
  }
  const m = /^(\d+)x(\d+)$/.exec(result.stdout.trim());
  if (!m) fail(`identify produced unparseable output for ${path}: '${result.stdout}'`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

function cropImage(src, dst) {
  const cmdArgs = args.crop
    ? [src, "-crop", args.crop, "+repage", dst]
    : [src, dst]; // no --crop given: the "crop" is the untouched full frame
  const result = run("convert", cmdArgs, `crop(${src})`);
  if (result.status !== 0) {
    fail(`ImageMagick crop failed on ${src} (exit ${result.status}): ${(result.stderr ?? "").trim()}`);
  }
  return dst;
}

// A label bar the exact width of `imgPath`, then the labeled image stacked underneath it.
function labelStack(imgPath, text, dstPath) {
  const { w } = imageSize(imgPath);
  const barPath = dstPath.replace(/\.png$/i, "-bar.png");
  const bar = run(
    "convert",
    ["-size", `${w}x28`, "-background", "#222", "-fill", "white", "-pointsize", "14", "-gravity", "center", `label:${text}`, barPath],
    `label(${text})`
  );
  if (bar.status !== 0) {
    fail(`ImageMagick label failed for '${text}' (exit ${bar.status}): ${(bar.stderr ?? "").trim()}`);
  }
  const stacked = run("convert", [barPath, imgPath, "-append", dstPath], `label-stack(${imgPath})`);
  if (stacked.status !== 0) {
    fail(`ImageMagick label-stack failed for ${imgPath} (exit ${stacked.status}): ${(stacked.stderr ?? "").trim()}`);
  }
  return dstPath;
}

function appendImages(paths, dstPath, direction) {
  const flag = direction === "horizontal" ? "+append" : "-append";
  const result = run("convert", [...paths, flag, dstPath], `append-${direction}(${dstPath})`);
  if (result.status !== 0) {
    fail(`ImageMagick ${direction} append failed for ${dstPath} (exit ${result.status}): ${(result.stderr ?? "").trim()}`);
  }
  return dstPath;
}

// `compare -metric RMSE a b null:` — exit 0 (identical) and 1 (differ, the common case) both carry a real
// result on stderr; only exit 2 is an actual ImageMagick error (unreadable file, incompatible geometry, …).
function rmseVsBaseline(cropPath, baselinePath) {
  const result = spawnSync("compare", ["-metric", "RMSE", cropPath, baselinePath, "null:"], { encoding: "utf8" });
  if (result.error) fail(`ImageMagick compare failed to launch: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    fail(`ImageMagick compare errored on ${cropPath} vs ${baselinePath} (exit ${result.status}): ${(result.stderr ?? "").trim()}`);
  }
  const m = /^([\d.eE+-]+)\s*\(([\d.eE+-]+)\)/.exec((result.stderr ?? "").trim());
  if (!m) fail(`ImageMagick compare produced unparseable RMSE output for ${cropPath}: '${result.stderr}'`);
  return { rmseAbs: Number(m[1]), rmseVsBaseline: Number(m[2]) };
}

// Bounding box of non-background pixels — the comet is bright on a dark stage, so a fuzzy trim finds it.
// A crop with NO visible comet trims to a degenerate 1x1 (ImageMagick warns on stderr but still exits 0 and
// still prints a parseable geometry line) — that is a legitimate (if uninteresting) trail span, not an error.
function trimSpan(cropPath) {
  const result = spawnSync("convert", [cropPath, "-fuzz", "8%", "-trim", "info:"], { encoding: "utf8" });
  if (result.error) fail(`ImageMagick trim failed to launch: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`ImageMagick trim errored on ${cropPath} (exit ${result.status}): ${(result.stderr ?? "").trim()}`);
  }
  const m = /PNG\s+(\d+)x(\d+)/.exec(result.stdout);
  if (!m) fail(`ImageMagick trim produced unparseable output for ${cropPath}: '${result.stdout}'`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

// ---------------------------------------------------------------------------------------------------------
// the INK CORRIDOR — where the comet is, insensitive to how bright it is
// ---------------------------------------------------------------------------------------------------------
//
// AN RMSE IS THE WRONG SHAPE FOR THIS ROUND'S QUESTION. The canvas arm deliberately draws a HIGHER-fidelity
// ribbon than the DOM one — the authored page's own cross-section instead of a three-step approximation of it,
// which reads ~19% hotter at the core — so "how different are these two crops" is now measuring a difference we
// went out of our way to create. What has to be true is that both arms put the comet in the SAME PLACE with the
// same extent.
//
// So: per arm, diff the trails-ON capture against the same arm's trails-OFF capture and threshold it. What
// survives is that arm's own comet, with the entire rest of the screen — backgrounds, cards, text, fonts,
// whatever else differs between the two backends — cancelled out by construction. Comparing those two masks
// asks only about position and extent, which is the claim.

function inkMask(onPath, offPath, dstPath) {
  const result = run(
    "convert",
    [onPath, offPath, "-compose", "difference", "-composite", "-colorspace", "Gray", "-threshold", "8%", dstPath],
    `mask(${onPath})`
  );
  if (result.status !== 0) {
    fail(`ImageMagick mask failed on ${onPath} (exit ${result.status}): ${(result.stderr ?? "").trim()}`);
  }
  return dstPath;
}

/** The fraction of the image that is white — multiply by the pixel count for an area. */
function whiteFraction(path) {
  const result = run("identify", ["-format", "%[fx:mean]", path], `mean(${path})`);
  if (result.status !== 0) {
    fail(`ImageMagick mean failed on ${path} (exit ${result.status}): ${(result.stderr ?? "").trim()}`);
  }
  return Number(result.stdout.trim());
}

/** Centroid and trimmed bounding box of a mask's ink, in the mask's own pixel coordinates. */
function maskShape(path) {
  const moments = run("identify", ["-verbose", "-define", "identify:moments", path], `moments(${path})`);
  const centroid = /Centroid:\s*(-?[\d.]+),\s*(-?[\d.]+)/.exec(moments.stdout ?? "");
  const trimmed = spawnSync("convert", [path, "-trim", "info:"], { encoding: "utf8" });
  const box = /\s(\d+)x(\d+)\+(\d+)\+(\d+)\s/.exec(trimmed.stdout ?? "");
  return {
    centroid: centroid ? { x: Number(centroid[1]), y: Number(centroid[2]) } : null,
    box: box
      ? { w: Number(box[1]), h: Number(box[2]), x: Number(box[3]), y: Number(box[4]) }
      : null
  };
}

/** Intersection-over-union of two masks, plus how far apart their centroids and box edges are. */
function corridorAgreement(maskA, maskB, dir, label) {
  const { w, h } = imageSize(maskA);
  const pixels = w * h;
  const interPath = resolve(dir, `${label}-inter.png`);
  const unionPath = resolve(dir, `${label}-union.png`);
  run("convert", [maskA, maskB, "-compose", "Darken", "-composite", interPath], "intersect");
  run("convert", [maskA, maskB, "-compose", "Lighten", "-composite", unionPath], "union");
  const inter = whiteFraction(interPath) * pixels;
  const union = whiteFraction(unionPath) * pixels;
  const a = maskShape(maskA);
  const b = maskShape(maskB);
  const centroidPx =
    a.centroid && b.centroid ? Math.hypot(a.centroid.x - b.centroid.x, a.centroid.y - b.centroid.y) : null;
  const edgePx =
    a.box && b.box
      ? Math.max(
          Math.abs(a.box.x - b.box.x),
          Math.abs(a.box.y - b.box.y),
          Math.abs(a.box.x + a.box.w - (b.box.x + b.box.w)),
          Math.abs(a.box.y + a.box.h - (b.box.y + b.box.h))
        )
      : null;
  return {
    iou: union > 0 ? Math.round((inter / union) * 1000) / 1000 : 0,
    inkPxA: Math.round(whiteFraction(maskA) * pixels),
    inkPxB: Math.round(whiteFraction(maskB) * pixels),
    centroidPx: centroidPx === null ? null : Math.round(centroidPx * 10) / 10,
    boxEdgePx: edgePx,
    maskA,
    maskB
  };
}

// ---------------------------------------------------------------------------------------------------------
// 1. probe every (at × arm), crop, label
// ---------------------------------------------------------------------------------------------------------

// tiles[at][label] = { cropPath, tilePath, probe }
const tiles = new Map();
for (const at of args.ats) {
  const byLabel = new Map();
  tiles.set(at, byLabel);
  for (const arm of args.arms) {
    const rawPath = resolve(outDir, `${at}-${arm.label}.png`);
    const probe = runProbe(at, arm, rawPath);
    const cropPath = cropImage(rawPath, resolve(outDir, `${at}-${arm.label}-crop.png`));
    const tilePath = labelStack(cropPath, `${at}ms  ${arm.label}`, resolve(outDir, `${at}-${arm.label}-tile.png`));
    byLabel.set(arm.label, { cropPath, rawPath, tilePath, probe });
  }
}

// ---------------------------------------------------------------------------------------------------------
// 2. numeric summary — every arm vs the baseline, same `at`, same crop
// ---------------------------------------------------------------------------------------------------------

const summary = { perAt: {}, phase: {}, corridor: {} };
let phaseRefusals = 0;

// THE AT-CAPTURE PHASE, not the post-capture one. The probe deliberately captures FIRST and diagnoses AFTER
// (a comet is gone 800ms after the card stops, and diagnostics cost CDP round trips), so its top-level
// `trailPhase` is a picture of a screen the capture no longer shows — on any `--age` run it reads as drained.
// The phase the gate FIRED on rides in `ageGate.phase`, and that is the one two arms have to agree about.
function atCapturePhase(probe) {
  return probe?.ageGate?.phase ?? probe?.trailPhase ?? null;
}

// The OFF half of a corridor pair has no comet BY CONSTRUCTION — on the DOM backend that reads as zero strokes,
// on the canvas backend as a null probe ("not drawing ribbons at all"). Null from any other arm stays a refusal:
// blurring it into "fine" would let a silently-broken arm pass the gate.
const corridorOffHalves = new Set(args.corridors.map((pair) => pair.off));

for (const at of args.ats) {
  const byLabel = tiles.get(at);
  const baselineCrop = byLabel.get(baselineLabel).cropPath;
  const baselinePhase = atCapturePhase(byLabel.get(baselineLabel).probe);
  const row = {};
  const phaseRow = {};
  for (const arm of args.arms) {
    const { cropPath, probe } = byLabel.get(arm.label);
    const { rmseVsBaseline: rmse } = rmseVsBaseline(cropPath, baselineCrop);
    const span = trimSpan(cropPath);
    row[arm.label] = { rmseVsBaseline: rmse, trimSpan: span };
    log(`  at=${at}ms arm=${arm.label}: rmseVsBaseline=${rmse}  trimSpan=${span.w}x${span.h}`);
    if (arm.label !== baselineLabel) {
      const agree = corridorOffHalves.has(arm.label)
        ? { ok: true, noComet: true, why: null }
        : phaseAgreement(baselineLabel, baselinePhase, arm.label, atCapturePhase(probe));
      phaseRow[arm.label] = agree;
      if (!agree.ok) {
        phaseRefusals++;
        log(`  ⚠ at=${at}ms ${arm.label} vs ${baselineLabel}: PHASE MISMATCH — ${agree.why}`);
        log(`    the RMSE above is CONFOUNDED: it is measuring decay phase, not fidelity.`);
      }
    }
    phaseRow[`${arm.label}:phase`] = atCapturePhase(probe);
  }
  summary.perAt[at] = row;
  summary.phase[at] = phaseRow;
}

// ---------------------------------------------------------------------------------------------------------
// 2b. the ink corridor — `--corridor <onLabel>=<offLabel>` pairs, one mask per arm
// ---------------------------------------------------------------------------------------------------------

for (const at of args.ats) {
  const byLabel = tiles.get(at);
  const masks = [];
  for (const pair of args.corridors) {
    const on = byLabel.get(pair.on);
    const off = byLabel.get(pair.off);
    if (!on || !off) {
      fail(`--corridor ${pair.on}=${pair.off} names an arm that is not in --arm (have: ${labels.join(", ")})`);
    }
    masks.push({
      label: pair.on,
      path: inkMask(on.cropPath, off.cropPath, resolve(outDir, `${at}-${pair.on}-mask.png`))
    });
  }
  if (masks.length >= 2) {
    const row = {};
    for (let i = 1; i < masks.length; i++) {
      const agree = corridorAgreement(masks[0].path, masks[i].path, outDir, `${at}-${masks[0].label}-${masks[i].label}`);
      row[`${masks[0].label}-vs-${masks[i].label}`] = agree;
      log(
        `  at=${at}ms corridor ${masks[0].label} vs ${masks[i].label}: IoU=${agree.iou} ` +
          `centroid=${agree.centroidPx}px boxEdge=${agree.boxEdgePx}px ink=${agree.inkPxA}/${agree.inkPxB}px`
      );
    }
    summary.corridor[at] = row;
  } else if (masks.length === 1) {
    summary.corridor[at] = { [masks[0].label]: { mask: masks[0].path } };
  }
}

// ---------------------------------------------------------------------------------------------------------
// 3. crop-stack.png — one row per `at` (arms left-to-right, CLI order), + a final row for --real frames
// ---------------------------------------------------------------------------------------------------------

const rowPaths = [];
for (const at of args.ats) {
  const byLabel = tiles.get(at);
  const rowTiles = args.arms.map((arm) => byLabel.get(arm.label).tilePath);
  rowPaths.push(appendImages(rowTiles, resolve(outDir, `row-${at}.png`), "horizontal"));
}

if (args.reals.length > 0) {
  const realTiles = args.reals.map((realPath, i) => {
    readFileSync(realPath); // fail fast with a clear ENOENT
    const cropPath = cropImage(realPath, resolve(outDir, `real-${i}-crop.png`));
    return labelStack(cropPath, `REAL  ${basename(realPath)}`, resolve(outDir, `real-${i}-tile.png`));
  });
  rowPaths.push(appendImages(realTiles, resolve(outDir, "row-real.png"), "horizontal"));
}

const stackPath = appendImages(rowPaths, resolve(outDir, "crop-stack.png"), "vertical");
const summaryPath = resolve(outDir, "summary.json");
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");

log(`crop-stack: ${stackPath}`);
log(`summary:    ${summaryPath}`);
console.log(`\nSUMMARY ${JSON.stringify(summary)}`);

// A PHASE MISMATCH IS A FAILED RUN, not a caveat. The numbers above are all real and all confounded, and the
// one thing a harness must never do is hand a confounded number to someone deciding a default.
if (phaseRefusals > 0) {
  console.error(
    `\ncompare-card-trail: ${phaseRefusals} arm pair(s) were captured at DIFFERENT points of the comet's decay.\n` +
      `  Every rmseVsBaseline above is measuring that mismatch as well as any real difference.\n` +
      `  Re-run with --age <ms> (e.g. --age 200) so both arms are captured at the same phase.`
  );
  process.exit(4);
}
