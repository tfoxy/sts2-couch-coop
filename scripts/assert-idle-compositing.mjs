#!/usr/bin/env node
// PASS/FAIL GATE: "when the mirror sits idle, its animations must run on the COMPOSITOR ONLY".
//
// Idle combat is where a phone spends most of its battery: the scene is settled, nothing is being dragged, and
// the only thing moving is decoration (the energy-orb spin, the enemy-intent bob). If that decoration is
// compositor-only, the renderer main thread does literally nothing — no style recalc, no Layerize, no Commit.
// The moment ANY main-thread frame is requested per animation frame, every running animation is re-styled and the
// whole compositing pipeline runs again: that is the 4-8 ms/frame the phone traces show.
//
//   node scripts/assert-idle-compositing.mjs --url http://127.0.0.1:5191 \
//     --recording .sts2/bench/combat-2026-07-15T16-40-09-999Z.ndjson \
//     --out-dir .sts2/perf-round2-aug5/a4-baseline
//
// It drives scripts/bench-mirror-replay.mjs as a CHILD (so the replay path, the fake WebSocket, the settle logic
// and the trace plumbing stay in exactly one place) with `--idle --trace --anim-audit-out --idle-shots`, then
// asserts, in order:
//
//   1. WINDOW        the trace carries cc-idle-start / cc-idle-end markers.
//   2. QUIET         inside [cc-idle-start + grace, cc-idle-end] the renderer main thread produced ZERO
//                    UpdateLayoutTree / Layerize / Commit / PrePaint events. This is the real gate: it is only
//                    reachable when nothing requests a main frame while the animations run.
//   3. COMPOSITED    every trace `Animation` async event whose name starts with `spirectl-` reports
//                    compositeFailed == 0. A failure prints its decoded reason bits, its `unsupportedProperties`
//                    and the matching element (identity + the ancestor chain) from the audit JSON.
//   4. ANY-LAYER     at least one running animation is corroborated as composited by the compositor itself —
//                    a cc layer whose compositingReasons name an active animation (ActiveTransformAnimation /
//                    ActiveTranslateAnimation / ActiveOpacityAnimation / …), resolved back to its DOM element.
//                    (Chosen over getAnimations() because it is the COMPOSITOR's own answer, not Blink's intent.)
//   5. MOTION        two screenshots taken ~600ms apart in the still-idle tail must differ INSIDE the animated
//                    elements' (runtime-derived, motion-inflated) rects and be near-identical everywhere else.
//                    Without it every other assertion is satisfiable by an animation that does not animate.
//
// Exit codes: 0 all assertions passed · 1 an assertion failed · 2 harness/usage error.
//
// Artifacts (all under --out-dir, none committed — see the artifact policy): the trace, the animation audit JSON,
// the two idle screenshots, a motion-diff PNG, the child bench log, and REPORT.json.
//
// Notes on two deliberate choices:
//   * The screenshots are taken AFTER cc-idle-end, not inside the window: Page.captureScreenshot forces a
//     compositor frame, which would contaminate the very frame counts assertion 2 reads. The tail is still idle
//     (nothing is ever interacted with), so it measures the same motion regime.
//   * PNG decode/encode is implemented here on top of node:zlib — pixelmatch/pngjs are NOT installed in this
//     repo and the task must not add npm dependencies.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    url: process.env.COUCHCOOP_BENCH_URL ?? "http://127.0.0.1:5173",
    recording: process.env.COUCHCOOP_BENCH_RECORDING ?? null,
    outDir: null,
    idleMs: 5000,
    graceMs: 500,
    gapMs: 600,
    quality: "high",
    viewport: "2100x900",
    query: "spineMode=off",
    reuse: null,
    keepGoing: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [key, inlineVal] = eq > 0 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const val = () => inlineVal ?? argv[++i];
    switch (key) {
      case "--url": a.url = val(); break;
      case "--recording": a.recording = val(); break;
      case "--out-dir": a.outDir = resolve(val()); break;
      case "--idle": a.idleMs = Number(val()); break;
      case "--grace": a.graceMs = Number(val()); break;
      case "--gap": a.gapMs = Number(val()); break;
      case "--quality": a.quality = val(); break;
      case "--viewport": a.viewport = val(); break;
      case "--query": a.query = val(); break;
      case "--reuse": a.reuse = resolve(val()); break;
      case "--keep-going": a.keepGoing = true; break;
      case "--help": case "-h": a.help = true; break;
      default: console.error(`Unknown argument: ${arg}`); a.help = true;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`assert-idle-compositing.mjs — gate: idle mirror animations must run compositor-only

  --url <origin>       dev server serving THE CODE UNDER TEST (default http://127.0.0.1:5173 / COUCHCOOP_BENCH_URL).
                       Start one with:  cd frontend && npx vite --host 127.0.0.1 --port 5191
                       NEVER 'npm run build' in a worktree — its outDir deploys into the installed mod.
  --recording <path>   NDJSON replay stream (default COUCHCOOP_BENCH_RECORDING, else the bench's newest).
                       Use a COMBAT recording: the orb spin + intent bob only exist in combat.
  --out-dir <dir>      where trace / audit / screenshots / diff / REPORT.json land
                       (default .sts2/bench/idle-gate/<timestamp>)
  --idle <ms>          idle window held after settle (default 5000)
  --grace <ms>         ignored lead-in inside the window (default 500 — lets the settle tail drain)
  --gap <ms>           gap between the two motion screenshots (default 600)
  --quality <tier>     mirror render tier (default high; 'static' for a phone-representative run)
  --viewport <WxH>     viewport (default 2100x900)
  --query <k=v&…>      extra page query (default 'spineMode=off' — keeps the replay off a live host's
                       /spines still-render path; pass '' to include spines)
  --reuse <dir>        skip the browser run and re-assert an earlier --out-dir (offline re-check of artifacts)
  --keep-going         report every assertion instead of stopping at the first failure (still exits non-zero)

Exit: 0 pass · 1 assertion failed · 2 harness error.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = args.outDir ?? resolve(REPO_ROOT, ".sts2/bench/idle-gate", stamp);

// ---------------------------------------------------------------------------------------------------------
// PNG codec (node:zlib only — no pixelmatch/pngjs in this repo, and the gate must not add dependencies)
// ---------------------------------------------------------------------------------------------------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Decode an 8-bit, non-interlaced PNG (colour types 0/2/4/6) to RGBA. That is what Chromium's screenshots are;
// anything else throws loudly rather than silently comparing garbage.
function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let head = null;
  const idat = [];
  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      head = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      };
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!head) throw new Error("PNG has no IHDR");
  if (head.bitDepth !== 8 || head.interlace !== 0) {
    throw new Error(`unsupported PNG (bitDepth ${head.bitDepth}, interlace ${head.interlace})`);
  }
  const channelsFor = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsFor[head.colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${head.colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = head;
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[o++];
    for (let i = 0; i < stride; i++) {
      const x = raw[o + i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      cur[i] =
        filter === 0 ? x
          : filter === 1 ? (x + a) & 0xff
            : filter === 2 ? (x + b) & 0xff
              : filter === 3 ? (x + ((a + b) >> 1)) & 0xff
                : (x + paeth(a, b, c)) & 0xff;
    }
    o += stride;
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels === 1) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = 255; }
      else if (channels === 2) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = cur[s + 1]; }
      else if (channels === 3) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255; }
      else { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = cur[s + 3]; }
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return { width, height, data: out };
}

function crc32(buf) {
  let c;
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Encode RGB (colour type 2, filter 0 rows) — only used for the evidence diff image.
function encodePngRgb(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------------------------------------
// trace parsing
// ---------------------------------------------------------------------------------------------------------

function loadTrace(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.traceEvents)) return data.traceEvents;
  throw new Error("unrecognized trace format (no traceEvents array)");
}

// The renderer main thread that ran the mirror page = the CrRendererMain with the most events (same rule as
// analyze-mirror-trace.mjs, so both tools attribute to the same thread).
function findRendererMain(events) {
  const names = new Map();
  for (const e of events) {
    if (e.cat === "__metadata" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args?.name ?? "");
  }
  const counts = new Map();
  for (const e of events) {
    const key = `${e.pid}:${e.tid}`;
    if (names.get(key) === "CrRendererMain") counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [key, count] of counts) if (count > bestCount) { bestCount = count; best = key; }
  return best;
}

// console.timeStamp → a `TimeStamp` instant event (args.data.message); performance.mark → a blink.user_timing
// event named after the mark. The bench emits both, so the window survives either being unavailable.
function findMarkers(events) {
  const marks = {};
  for (const e of events) {
    if (e.name === "TimeStamp" && e.args?.data?.message) {
      const label = e.args.data.message;
      if (marks[label] === undefined) marks[label] = e.ts;
    }
  }
  for (const e of events) {
    if (String(e.cat ?? "").includes("blink.user_timing") && typeof e.name === "string" && e.name.startsWith("cc-")) {
      if (marks[e.name] === undefined) marks[e.name] = e.ts;
    }
  }
  return marks;
}

// Async `Animation` events (blink.animations): a `b` opens a span carrying {displayName, nodeId, nodeName, state},
// later `n` events patch it with {compositeFailed} / {unsupportedProperties} / {state}, an `e` closes it. Async
// ids are RECYCLED after the close, so spans must be tracked open→close, never grouped by id alone.
function parseAnimationSpans(events) {
  const spans = [];
  const open = new Map();
  const list = events.filter((e) => e.name === "Animation").sort((a, b) => a.ts - b.ts);
  for (const e of list) {
    const key = `${e.pid ?? 0}|${e.id2?.local ?? e.id}`;
    if (e.ph === "b") {
      const span = { startTs: e.ts, endTs: null, data: { ...(e.args?.data ?? {}) } };
      open.set(key, span);
      spans.push(span);
    } else if (e.ph === "n") {
      const span = open.get(key);
      if (span) Object.assign(span.data, e.args?.data ?? {});
    } else if (e.ph === "e") {
      const span = open.get(key);
      if (span) span.endTs = e.ts;
      open.delete(key);
    }
  }
  return spans;
}

// Chromium's CompositorAnimations::FailureReason bitmask. The two bits marked (verified) were confirmed against
// THIS Chromium build with engineered pages (animate `left` → 0x2020 + unsupportedProperties:["left"];
// visibility:hidden and a clipped-to-nothing ancestor → 0x20000). The rest are the enum's documented order and
// are printed as a best-effort label — the raw bitmask and unsupportedProperties are always printed too, so a
// mislabel can never hide the evidence.
const FAILURE_BITS = {
  0x00001: "acceleratedAnimationsDisabled",
  0x00002: "effectSuppressedByDevtools",
  0x00004: "invalidAnimationOrEffect",
  0x00008: "effectHasUnsupportedTimingParameters",
  0x00010: "effectHasNonReplaceCompositeMode",
  0x00020: "targetHasInvalidCompositingState (verified: set alongside an unsupported property)",
  0x00040: "targetHasIncompatibleAnimations",
  0x00080: "targetHasCSSOffset",
  0x00100: "targetHasMultipleTransformProperties",
  0x00200: "animationAffectsNonCSSProperties",
  0x00400: "transformRelatedPropertyCannotBeAcceleratedOnTarget",
  0x00800: "transformRelatedPropertyDependsOnBoxSize",
  0x01000: "filterRelatedPropertyMayMovePixels",
  0x02000: "unsupportedCSSProperty (verified: animating `left`)",
  0x04000: "mixedKeyframeValueTypes",
  0x08000: "timelineSourceHasInvalidCompositingState",
  0x10000: "affectsImportantProperty",
  0x20000: "animationHasNoVisibleChange (verified: visibility:hidden / clipped-away ancestor)"
};

function decodeFailure(mask) {
  if (!mask) return [];
  const out = [];
  for (let bit = 1; bit <= 0x80000000; bit *= 2) {
    if (mask & bit) out.push(FAILURE_BITS[bit] ?? `unknownBit(0x${bit.toString(16)})`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// pixel diff
// ---------------------------------------------------------------------------------------------------------

// Motion check. `rects` are the animated elements' runtime bounding boxes, inflated so a transform that moves the
// element still lands inside its own crop. Returns per-region changed-pixel counts + a diff image (dimmed base,
// red = changed inside a rect, magenta = changed outside, green outlines = the rects).
function diffImages(a, b, rects, opts) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`screenshot size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const { width, height } = a;
  const threshold = opts.threshold ?? 12;
  const mask = new Uint8Array(width * height);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.ceil(r.x + r.width));
    const y1 = Math.min(height, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) mask[y * width + x] = 1;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  let insideArea = 0;
  let outsideArea = 0;
  let insideChanged = 0;
  let outsideChanged = 0;
  let maxDelta = 0;
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const dr = Math.abs(a.data[p] - b.data[p]);
    const dg = Math.abs(a.data[p + 1] - b.data[p + 1]);
    const db = Math.abs(a.data[p + 2] - b.data[p + 2]);
    const delta = Math.max(dr, dg, db);
    if (delta > maxDelta) maxDelta = delta;
    const inside = mask[i] === 1;
    if (inside) insideArea++; else outsideArea++;
    const changed = delta > threshold;
    if (changed) { if (inside) insideChanged++; else outsideChanged++; }
    const o = i * 3;
    const dim = (a.data[p] * 0.25 + a.data[p + 1] * 0.5 + a.data[p + 2] * 0.25) * 0.35;
    if (changed && inside) { rgb[o] = 255; rgb[o + 1] = 40; rgb[o + 2] = 40; }
    else if (changed) { rgb[o] = 255; rgb[o + 1] = 0; rgb[o + 2] = 255; }
    else { rgb[o] = rgb[o + 1] = rgb[o + 2] = dim; }
  }
  // Green rect outlines so the crops are legible in the evidence image.
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width - 1, Math.ceil(r.x + r.width));
    const y1 = Math.min(height - 1, Math.ceil(r.y + r.height));
    for (let x = x0; x <= x1; x++) {
      for (const y of [y0, y1]) { const o = (y * width + x) * 3; rgb[o] = 0; rgb[o + 1] = 255; rgb[o + 2] = 0; }
    }
    for (let y = y0; y <= y1; y++) {
      for (const x of [x0, x1]) { const o = (y * width + x) * 3; rgb[o] = 0; rgb[o + 1] = 255; rgb[o + 2] = 0; }
    }
  }
  return {
    width, height, threshold,
    insideArea, outsideArea, insideChanged, outsideChanged, maxDelta,
    insidePct: insideArea ? (insideChanged / insideArea) * 100 : 0,
    outsidePct: outsideArea ? (outsideChanged / outsideArea) * 100 : 0,
    image: encodePngRgb(width, height, rgb)
  };
}

// ---------------------------------------------------------------------------------------------------------
// run the child bench
// ---------------------------------------------------------------------------------------------------------

function runBench(paths) {
  const argv = [
    resolve(REPO_ROOT, "scripts/bench-mirror-replay.mjs"),
    "--url", args.url,
    "--repeats", "1",
    "--quality", args.quality,
    "--viewport", args.viewport,
    "--trace", basename(paths.trace),
    "--idle", String(args.idleMs),
    "--idle-shots", paths.shotPrefix,
    "--idle-shot-gap", String(args.gapMs),
    "--anim-audit-out", paths.audit
  ];
  if (args.recording) argv.push("--recording", args.recording);
  if (args.query) argv.push("--query", args.query);
  console.log(`> node ${argv.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ")}\n`);
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, argv, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    child.on("error", rej);
    child.on("close", (code) => {
      writeFileSync(paths.benchLog, out);
      if (code !== 0) rej(new Error(`bench-mirror-replay.mjs exited ${code}`));
      else res(out);
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const paths = {
  trace: resolve(outDir, "idle-trace.json"),
  audit: resolve(outDir, "anim-audit.json"),
  shotPrefix: resolve(outDir, "idle"),
  shotA: resolve(outDir, "idle-a.png"),
  shotB: resolve(outDir, "idle-b.png"),
  diff: resolve(outDir, "idle-motion-diff.png"),
  benchLog: resolve(outDir, "bench.log"),
  report: resolve(outDir, "REPORT.json")
};

console.log("assert-idle-compositing");
console.log(`  url:       ${args.url}`);
console.log(`  recording: ${args.recording ?? "(bench default: newest .sts2/bench/*.ndjson)"}`);
console.log(`  out-dir:   ${outDir}`);
console.log(`  idle:      ${args.idleMs}ms (grace ${args.graceMs}ms)   shots ${args.gapMs}ms apart`);
console.log(`  page:      quality=${args.quality} viewport=${args.viewport} query='${args.query}'`);
console.log("");

let benchResult = null;
if (args.reuse) {
  for (const key of Object.keys(paths)) paths[key] = paths[key].replace(outDir, args.reuse);
  console.log(`(reusing artifacts in ${args.reuse} — no browser run)\n`);
  // Keep the original run's bench numbers instead of blanking them when REPORT.json is rewritten.
  try {
    const previous = JSON.parse(readFileSync(paths.report, "utf8"));
    benchResult = previous.bench ? { medians: previous.bench.medians, walkStats: previous.bench.walkStats, config: { url: previous.bench.pageUrl } } : null;
  } catch { /* first run / unreadable — fine */ }
} else {
  let benchOut;
  try {
    benchOut = await runBench(paths);
  } catch (e) {
    console.error(`\nHARNESS ERROR: ${e.message}`);
    console.error("Is the dev server up?  cd frontend && npx vite --host 127.0.0.1 --port 5191");
    process.exit(2);
  }
  const line = benchOut.split("\n").find((l) => l.startsWith("BENCH_RESULT "));
  if (line) benchResult = JSON.parse(line.slice("BENCH_RESULT ".length));
  // The bench always writes its trace under .sts2/bench/traces/<name>; move a copy next to the other evidence.
  const written = benchResult?.tracePath;
  if (written && existsSync(written) && resolve(written) !== paths.trace) copyFileSync(written, paths.trace);
}

const failures = [];
const notes = [];
const fail = (id, message, detail) => {
  failures.push({ id, message, detail: detail ?? null });
  console.log(`FAIL  ${id}: ${message}`);
  if (detail) console.log(detail.split("\n").map((l) => `      ${l}`).join("\n"));
  if (!args.keepGoing) {
    finish();
  }
};
const pass = (id, message) => console.log(`ok    ${id}: ${message}`);

let report = {};
function finish() {
  report.failures = failures;
  report.notes = notes;
  report.passed = failures.length === 0;
  report.outDir = outDir;
  writeFileSync(paths.report, JSON.stringify(report, null, 2));
  console.log("");
  console.log(report.passed ? "IDLE COMPOSITING GATE: PASS" : `IDLE COMPOSITING GATE: FAIL (${failures.length} assertion${failures.length === 1 ? "" : "s"})`);
  console.log(`  report: ${paths.report}`);
  process.exit(report.passed ? 0 : 1);
}

for (const p of [paths.trace, paths.audit, paths.shotA, paths.shotB]) {
  if (!existsSync(p)) {
    console.error(`HARNESS ERROR: expected artifact missing: ${p}`);
    process.exit(2);
  }
}

const events = loadTrace(paths.trace);
const audit = JSON.parse(readFileSync(paths.audit, "utf8"));
const mainKey = findRendererMain(events);
if (!mainKey) {
  console.error("HARNESS ERROR: no CrRendererMain thread in the trace");
  process.exit(2);
}
const [pid, tid] = mainKey.split(":").map(Number);
const marks = findMarkers(events);

report = {
  generatedAt: new Date().toISOString(),
  config: { url: args.url, recording: args.recording, quality: args.quality, viewport: args.viewport, query: args.query, idleMs: args.idleMs, graceMs: args.graceMs, gapMs: args.gapMs },
  artifacts: paths,
  bench: benchResult ? { medians: benchResult.medians, walkStats: benchResult.walkStats, pageUrl: benchResult.config?.url } : null,
  rendererMain: { pid, tid }
};

// ---- 1. WINDOW ------------------------------------------------------------------------------------------
if (marks["cc-idle-start"] === undefined || marks["cc-idle-end"] === undefined) {
  fail("WINDOW", "no cc-idle-start / cc-idle-end markers in the trace (was --idle passed to the bench?)",
    `markers found: ${JSON.stringify(Object.keys(marks))}`);
} else {
  pass("WINDOW", `markers found (window ${((marks["cc-idle-end"] - marks["cc-idle-start"]) / 1000).toFixed(0)}ms)`);
}
const winStart = (marks["cc-idle-start"] ?? 0) + args.graceMs * 1000;
const winEnd = marks["cc-idle-end"] ?? 0;

// ---- 2. QUIET -------------------------------------------------------------------------------------------
const GATE_EVENTS = ["UpdateLayoutTree", "Layerize", "Commit", "PrePaint"];
// Reported for attribution, never asserted: they name WHO requested the frame.
const CONTEXT_EVENTS = [
  "Layout", "Paint", "UpdateLayer", "LayerTreeHost::DoUpdateLayers", "ProxyMain::BeginMainFrame",
  "FireAnimationFrame", "RequestAnimationFrame", "TimerFire", "FunctionCall", "ScheduleStyleRecalculation",
  "EventDispatch", "ParseHTML", "RunTask"
];
const winCounts = {};
const winDur = {};
const callers = {};
for (const e of events) {
  if (e.pid !== pid || e.tid !== tid) continue;
  if (e.ts < winStart || e.ts > winEnd) continue;
  winCounts[e.name] = (winCounts[e.name] ?? 0) + 1;
  if (e.ph === "X" && typeof e.dur === "number") winDur[e.name] = (winDur[e.name] ?? 0) + e.dur;
  if (e.name === "FunctionCall") {
    const d = e.args?.data ?? {};
    const key = `${d.functionName || "?"} @ ${String(d.url ?? "").split("/").pop()}:${d.lineNumber ?? "?"}`;
    callers[key] = (callers[key] ?? 0) + 1;
  }
}
const gateCounts = Object.fromEntries(GATE_EVENTS.map((n) => [n, winCounts[n] ?? 0]));
const contextCounts = Object.fromEntries(CONTEXT_EVENTS.filter((n) => winCounts[n]).map((n) => [n, winCounts[n]]));
const windowSec = Math.max(0.001, (winEnd - winStart) / 1e6);
const styleElements = events
  .filter((e) => e.pid === pid && e.tid === tid && e.name === "UpdateLayoutTree" && e.ts >= winStart && e.ts <= winEnd)
  .reduce((s, e) => s + (e.args?.elementCount ?? e.args?.beginData?.elementCount ?? 0), 0);
report.window = {
  seconds: Math.round(windowSec * 100) / 100,
  gateCounts,
  gatePerSecond: Object.fromEntries(Object.entries(gateCounts).map(([k, v]) => [k, Math.round((v / windowSec) * 10) / 10])),
  gateSelfMs: Object.fromEntries(GATE_EVENTS.map((n) => [n, Math.round(((winDur[n] ?? 0) / 1000) * 100) / 100])),
  contextCounts,
  styleRecalcElements: styleElements,
  styleRecalcElementsPerFrame: winCounts.UpdateLayoutTree
    ? Math.round((styleElements / winCounts.UpdateLayoutTree) * 100) / 100
    : 0,
  rafCallers: callers
};
const offenders = GATE_EVENTS.filter((n) => gateCounts[n] > 0);
if (offenders.length) {
  const lines = [
    `window ${report.window.seconds}s (grace ${args.graceMs}ms applied)`,
    ...GATE_EVENTS.map((n) => `  ${n.padEnd(18)} ${String(gateCounts[n]).padStart(5)}  (${report.window.gatePerSecond[n]}/s, ${report.window.gateSelfMs[n]}ms total)`),
    `  style recalc touched ${styleElements} elements (${report.window.styleRecalcElementsPerFrame}/frame)`,
    `  frame-requesting JS in the window: ${Object.entries(callers).map(([k, v]) => `${k} ×${v}`).join(", ") || "(none — frames came from elsewhere)"}`,
    `  other main-thread events: ${Object.entries(contextCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(", ")}`
  ].join("\n");
  fail("QUIET", `${offenders.join(", ")} ran during the idle window — the main thread is producing frames while nothing but animations should be moving`, lines);
} else {
  pass("QUIET", `0 UpdateLayoutTree / Layerize / Commit / PrePaint across ${report.window.seconds}s`);
}

// ---- 3. COMPOSITED --------------------------------------------------------------------------------------
const spans = parseAnimationSpans(events);
const spirectlSpans = spans.filter((s) => String(s.data.displayName ?? "").startsWith("spirectl-"));
const liveSpans = spirectlSpans.filter((s) => s.endTs === null); // still running when tracing stopped
const considered = liveSpans.length ? liveSpans : spirectlSpans;
report.animations = {
  totalSpans: spans.length,
  spirectlSpans: spirectlSpans.length,
  stillRunning: liveSpans.length,
  byName: {},
  failures: []
};
for (const s of considered) {
  const name = s.data.displayName;
  const entry = (report.animations.byName[name] ??= { total: 0, composited: 0, failed: 0 });
  entry.total++;
  if (s.data.compositeFailed) entry.failed++; else entry.composited++;
}
// Element context for a failing animation. The trace names the animation but identifies its element only by a
// DevTools nodeId, so the audit is matched by animation-name and then NARROWED with the compositor's own answer:
// an element that owns an active-animation layer is provably composited, so it cannot be one of the failures.
// With one distinct suspect left per failing span the attribution is exact rather than a list of candidates.
const compositedNodeIds = new Set();
for (const l of audit.layerProbe?.animationLayers ?? []) {
  const id = l.node?.attributes?.["data-node-id"];
  if (id) compositedNodeIds.add(id);
}
const auditByName = new Map();
for (const a of audit.animations ?? []) {
  if (!auditByName.has(a.animationName)) auditByName.set(a.animationName, []);
  auditByName.get(a.animationName).push(a);
}
// Fallback identity for layers CDP could not resolve back to a DOM node (and for animSelf layers, which are
// self-layer children with no data-node-id): the layer's size in layout px. Compared against the element's own
// inline width/height — NOT its bounding rect, which the view scale has already shrunk.
const compositedLayerBoxes = new Set(
  (audit.layerProbe?.animationLayers ?? [])
    .filter((l) => !l.node?.attributes?.["data-node-id"])
    .map((l) => `${Math.round(l.width)}x${Math.round(l.height)}`)
);
const inlineBox = (a) => {
  const style = a.element?.inlineStyle ?? "";
  const w = /(?:^|;)\s*width:\s*([\d.]+)px/.exec(style);
  const h = /(?:^|;)\s*height:\s*([\d.]+)px/.exec(style);
  return w && h ? `${Math.round(Number(w[1]))}x${Math.round(Number(h[1]))}` : null;
};
const isProvablyComposited = (a) => {
  const id = a.element?.data?.["data-node-id"];
  if (id && compositedNodeIds.has(id)) return true;
  const box = inlineBox(a) ?? `${Math.round(a.rect.width)}x${Math.round(a.rect.height)}`;
  return compositedLayerBoxes.has(box);
};
const failing = considered.filter((s) => (s.data.compositeFailed ?? 0) !== 0);
if (considered.length === 0) {
  fail("COMPOSITED", "no `spirectl-*` Animation events in the trace — cannot verify compositing",
    "The blink.animations category must be enabled (bench --idle/--anim-audit does that) and the recording must be a COMBAT stream (the orb spin / intent bob only exist in combat).");
} else if (failing.length) {
  const lines = [];
  const seenNames = new Set();
  for (const s of failing) {
    const mask = s.data.compositeFailed;
    lines.push(`${s.data.displayName}  on ${s.data.nodeName}`);
    lines.push(`  compositeFailed = ${mask} (0x${mask.toString(16)}) → ${decodeFailure(mask).join(", ")}`);
    lines.push(`  unsupportedProperties = ${JSON.stringify(s.data.unsupportedProperties ?? [])}`);
    const all = auditByName.get(s.data.displayName) ?? [];
    const suspects = all.filter((c) => !isProvablyComposited(c));
    const failingOfName = failing.filter((f) => f.data.displayName === s.data.displayName).length;
    const exact = suspects.length === failingOfName;
    if (!seenNames.has(s.data.displayName)) {
      seenNames.add(s.data.displayName);
      lines.push(`  ${exact ? "IDENTIFIED" : "candidates"}: ${suspects.length} of ${all.length} '${s.data.displayName}' element(s) are not backed by an active-animation compositor layer` +
        (exact ? ` — exactly the ${failingOfName} failing span(s)` : ""));
      for (const c of suspects.slice(0, 6)) {
        lines.push(`   • ${c.element.tag}.${String(c.element.class).split(" ")[0]}  ${c.element.data["data-node-path"] ?? "(no node path)"}`);
        lines.push(`     rect ${Math.round(c.rect.width)}x${Math.round(c.rect.height)} @ ${Math.round(c.rect.x)},${Math.round(c.rect.y)}   animates ${JSON.stringify(c.animatedProperties)}`);
        for (const link of c.chain) {
          if (link.suspicious.length) {
            lines.push(`     ${link.self ? "SELF" : `ancestor d${link.depth}`} ${link.tag}.${String(link.class).split(" ")[0]}: ${link.suspicious.join(" ; ")}`);
          }
        }
      }
    }
    report.animations.failures.push({
      name: s.data.displayName,
      node: s.data.nodeName,
      compositeFailed: mask,
      reasons: decodeFailure(mask),
      unsupportedProperties: s.data.unsupportedProperties ?? [],
      suspects: suspects.map((c) => ({
        nodePath: c.element.data["data-node-path"] ?? null,
        nodeType: c.element.data["data-node-type"] ?? null,
        rect: c.rect,
        animatedProperties: c.animatedProperties,
        suspiciousChain: c.chain.filter((l) => l.suspicious.length).map((l) => ({ depth: l.depth, self: l.self, suspicious: l.suspicious }))
      })),
      attributionExact: exact
    });
  }
  fail("COMPOSITED", `${failing.length}/${considered.length} spirectl-* animations could not be composited`, lines.join("\n"));
} else {
  pass("COMPOSITED", `all ${considered.length} spirectl-* animations report compositeFailed == 0`);
}

// ---- 4. ANY-LAYER ---------------------------------------------------------------------------------------
const probe = audit.layerProbe;
const animLayers = probe?.animationLayers ?? [];
report.compositedLayers = {
  layerCount: probe?.layerCount ?? null,
  reasons: probe?.reasons ?? null,
  animationLayers: animLayers.map((l) => ({
    reasons: l.animationReasons,
    size: `${l.width}x${l.height}`,
    nodePath: l.node?.attributes?.["data-node-path"] ?? null,
    nodeClass: l.node?.attributes?.class ?? null
  }))
};
if (animLayers.length === 0) {
  fail("ANY-LAYER", "the compositor reports NO layer owned by an active animation (ActiveTransformAnimation / ActiveTranslateAnimation / …)",
    `layer compositing reasons seen: ${JSON.stringify(probe?.reasons ?? null)}`);
} else {
  pass("ANY-LAYER", `${animLayers.length} compositor layer(s) exist because of an active animation (${[...new Set(animLayers.flatMap((l) => l.animationReasons))].join(", ")})`);
}

// ---- 5. MOTION ------------------------------------------------------------------------------------------
// Rects come from the audit (runtime bounding boxes of the animated elements) — never hardcoded — inflated so a
// moving element stays inside its own crop, and scaled if the screenshot is not 1 CSS px per image px.
const imgA = decodePng(readFileSync(paths.shotA));
const imgB = decodePng(readFileSync(paths.shotB));
const cssW = audit.viewport?.width ?? imgA.width;
const scale = imgA.width / cssW;
const rects = [];
for (const a of audit.animations ?? []) {
  const r = a.rect;
  if (!r) continue;
  const padX = Math.max(24, r.width * 0.25);
  const padY = Math.max(24, r.height * 0.25);
  const rect = {
    x: (r.x - padX) * scale,
    y: (r.y - padY) * scale,
    width: (r.width + padX * 2) * scale,
    height: (r.height + padY * 2) * scale,
    name: a.animationName
  };
  if (rect.width > 0 && rect.height > 0) rects.push(rect);
}
if (rects.length === 0) {
  fail("MOTION", "the audit contains no animated-element rects to crop", "audit.animations is empty");
} else {
  let diff;
  try {
    diff = diffImages(imgA, imgB, rects, { threshold: 12 });
  } catch (e) {
    console.error(`HARNESS ERROR: ${e.message}`);
    process.exit(2);
  }
  writeFileSync(paths.diff, diff.image);
  report.motion = {
    rects: rects.length,
    imageSize: `${diff.width}x${diff.height}`,
    threshold: diff.threshold,
    insideChanged: diff.insideChanged,
    insideArea: diff.insideArea,
    insidePct: Math.round(diff.insidePct * 1000) / 1000,
    outsideChanged: diff.outsideChanged,
    outsideArea: diff.outsideArea,
    outsidePct: Math.round(diff.outsidePct * 1000) / 1000,
    maxChannelDelta: diff.maxDelta,
    diffImage: paths.diff
  };
  const MIN_INSIDE_PX = 200;
  const MIN_INSIDE_PCT = 0.2;
  const MAX_OUTSIDE_PCT = 0.05;
  if (diff.insideChanged < MIN_INSIDE_PX || diff.insidePct < MIN_INSIDE_PCT) {
    fail("MOTION", `the animated elements did not move between the two idle screenshots (${diff.insideChanged}px / ${report.motion.insidePct}% of their crops changed; need ≥${MIN_INSIDE_PX}px and ≥${MIN_INSIDE_PCT}%)`,
      `diff image: ${paths.diff}\nA: ${paths.shotA}\nB: ${paths.shotB}`);
  } else if (diff.outsidePct > MAX_OUTSIDE_PCT) {
    fail("MOTION", `pixels changed OUTSIDE the animated elements' crops (${report.motion.outsidePct}% > ${MAX_OUTSIDE_PCT}%) — the page is not actually idle`,
      `${diff.outsideChanged} changed pixels outside\ndiff image: ${paths.diff}`);
  } else {
    pass("MOTION", `${diff.insideChanged}px (${report.motion.insidePct}%) changed inside the ${rects.length} animated crops, ${report.motion.outsidePct}% outside`);
  }
}

// ---- summary --------------------------------------------------------------------------------------------
console.log("");
console.log("=== idle window ===");
console.log(`  seconds:            ${report.window?.seconds}`);
for (const n of GATE_EVENTS) console.log(`  ${n.padEnd(18)}  ${String(gateCounts[n]).padStart(5)}  (${report.window.gatePerSecond[n]}/s)`);
console.log(`  style recalc:       ${styleElements} elements (${report.window.styleRecalcElementsPerFrame}/frame)`);
if (Object.keys(callers).length) console.log(`  frame-requesting JS: ${Object.entries(callers).map(([k, v]) => `${k} ×${v}`).join(", ")}`);
console.log("=== animations ===");
for (const [name, e] of Object.entries(report.animations.byName)) {
  console.log(`  ${name.padEnd(32)} ${e.total} running, ${e.composited} composited, ${e.failed} failed`);
}
if (report.compositedLayers.animationLayers.length) {
  console.log("=== compositor layers owned by an animation ===");
  for (const l of report.compositedLayers.animationLayers) {
    console.log(`  ${l.reasons.join("+")}  ${l.size}  ${l.nodePath ?? l.nodeClass ?? ""}`);
  }
}
if (report.motion) {
  console.log("=== motion ===");
  console.log(`  inside crops:  ${report.motion.insideChanged}px (${report.motion.insidePct}%)`);
  console.log(`  outside crops: ${report.motion.outsideChanged}px (${report.motion.outsidePct}%)`);
  console.log(`  diff image:    ${report.motion.diffImage}`);
}
finish();
