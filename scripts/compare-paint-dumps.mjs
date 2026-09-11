#!/usr/bin/env node
// THE PAINT-DUMP PARITY GATE — diff what the single-canvas backend painted against what the DOM backend painted.
//
// Both dumps come from `scripts/bench-mirror-replay.mjs --paint-dump`, run on the SAME checkout against the SAME
// recording: one arm with `?stage=canvas`, one without. This is canvas-vs-DOM, never branch-vs-branch. The canvas
// arm's lines come straight off its draw list (`window.__mirrorDrawListDump`); the DOM arm's are derived by
// walking `.mirror-stage`. See the flag's help text for the format and the derivation.
//
// RUN BOTH ARMS AT 1920x1080 BY DEFAULT. At exactly 16:9 the spread factor is 1.0 on both backends and neither has
// any re-layout in force, so a divergence here is a divergence in the paint and nothing else. Anything wider brings
// the wide-screen spread in on BOTH arms, and while they now agree there (M1a landed it in the canvas walk, out of
// the same `spreadLayout` module the DOM walk calls), a disagreement at a wide viewport has one more possible
// cause than the same disagreement at 16:9 — so the narrower run is the one to reach for first. The comparer
// REFUSES a pair taken at any other viewport unless `--any-viewport` is passed, which is how a widescreen run is
// deliberately asked for.
//
// WHAT IS COMPARED, and in what currency. A record is keyed `<nodeId>#<role>#<ordinal>` — the scene node, which of
// `emitNodePaint`'s four emissions it is (`fill` / `tex` / `line` / `range`), and its index among that node's
// records of that role. That key is what makes a canvas COMMAND comparable to the DOM SUB-LAYER painting the same
// pixels: `.mirror-range-fill` is a `range`, `.mirror-atlas-region` is a `tex`, the node's own background-color is
// a `fill`. For every matched pair the gate reports:
//
//   GEOMETRY — the max distance between corresponding corners of the two placed boxes, in design px. The box is
//              the affine applied to (0,0)/(w,0)/(0,h)/(w,h), so a difference in how the placement was FACTORED
//              (matrix vs width vs origin) cannot register as a geometry error and a real displacement always
//              does. Reported over 0.5 px.
//   TEXTURE  — the two urls, reduced to a path (origin and query stripped). `<canvas>` on the DOM side means the
//              pixels came from a baked atlas canvas, whose identity is not a url; those are counted, not failed.
//   BLEND    — `mix` / `add` / `sub` / `mul` against the CSS `mix-blend-mode` the DOM element carries.
//   ALPHA    — the premultiplied alpha channel, which is the one colour field both sides express the same way.
//   ORDER    — each record's rank among its own arm's records, as a fraction, so two lists of different lengths
//              are still comparable. A rank that moves by more than 2% of the list is an ORDER divergence.
//
// THE PRE-REGISTERED DIVERGENCE CLASSES. Each is a KNOWN, intended difference between the backends, each has its
// own flag, and each is ON by default (the gate's job is to find what is NOT on this list):
//
//   (a) --zorder      Exact-Godot z-order vs the DOM's CSS stacking. The canvas backend sorts siblings by
//                     `z_index` and lifts show-behind-parent children; the DOM backend paints in producer
//                     pre-order (`mirrorRenderer.paintIndexOf`). ORDER differences are counted and reported, not
//                     failed.
//   (b) --text        Text renders in the DOM overlay on BOTH backends, so a `text` overlay is expected on both
//                     sides and its DOM record is an element the canvas arm never draws.
//   (c) --float       Sub-pixel float formatting. Absorbed by the 0.5 px geometry tolerance; the flag exists so
//                     the tolerance is nameable and adjustable (`--geom-tolerance`).
//   (d) --blendfix    Blend-mode fixes the canvas backend makes and the DOM one cannot: an ADD child under a
//                     non-ADD parent, SUB (CSS has no subtract), and a degenerate nine-patch. Counted separately.
//   (e) --effects     Effects excluded under `--effects off` — shader / particle / spine / trail overlays, which
//                     the DOM arm does not mount at all when the runtimes are off.
//   (f) --fx          IN-CANVAS SURFACES the DOM arm shows some other way: `role=fx` (effect surfaces, M2) and
//                     `role=spine` (spine clip stills, M3). The same
//                     thing exists on BOTH arms and both arms show it — the canvas arm draws it as a quad at the
//                     node's own paint index, the DOM arm composites gsw's canvas (or the clip's <img>) over the
//                     stage — so it is a matched OVERLAY on both sides and the quad is the canvas arm's extra
//                     machinery for it, not a paint the DOM arm is missing. Counted in its own row (IN-CANVAS
//                     SURFACES, below) and kept out of the canvas-only bucket, where it would otherwise report
//                     every shader, emitter and creature on screen as an unregistered divergence. Turning the
//                     class off (`--no-fx` / `--strict`) puts them back in the raw diff. THE ONE THING THIS DOES
//                     NOT EXCUSE: a quad whose node has no overlay record on the DOM arm — that IS a divergence
//                     and is reported as `quads with no DOM surface`, because it means the flag invented
//                     something or the DOM arm lost it.
//   (g) --trail      CARD TRAILS, which are class (f)'s shape with one difference worth its own flag: BOTH arms
//                     draw the comet, and neither draws it from wire geometry. A trail carries no streamed
//                     points — the producer drops them deliberately — so each backend INTEGRATES the ribbon from
//                     the card's own motion and then draws it its own way: a run of untextured `role=trail`
//                     quads in the stage list here, an SVG ribbon inside a `mirror-trail` element there. Neither
//                     is the other's missing paint, and the DOM element is a matched `trail` OVERLAY on both
//                     sides. Counted in its own row (CARD TRAILS, below) for the same reason (f) is counted
//                     apart: keyed into the command diff, one flying card would report a hundred-odd canvas-only
//                     misses. The orphan rule transfers verbatim — a trail quad whose node has no overlay record
//                     on the DOM arm IS a divergence.
//   (h) --textquad   CANVAS TEXT LABELS (M4). The canvas arm draws accepted labels as `role=text` quads while
//                     refused labels stay elements. A label is therefore a matched `text` OVERLAY on both sides,
//                     and the quad is the canvas arm's machinery for painting it at its own depth.
//                     TWO THINGS THIS DOES NOT EXCUSE, and they are the reason the class is worth having rather
//                     than just filtering the role out. A text quad whose node has no `text` overlay on the DOM
//                     arm is an ORPHAN: the canvas path invented a label, or the DOM arm lost one. And a canvas
//                     text overlay that produced NO quad is a runtime refusal, whose coverage is worth reading.
//
// Pass `--strict` to turn every class OFF at once and see the raw diff.
//
// Usage:
//   node scripts/compare-paint-dumps.mjs <canvas.paint.txt> <dom.paint.txt>
//   node scripts/compare-paint-dumps.mjs a.txt b.txt --geom-tolerance 0.5 --top 20
//   node scripts/compare-paint-dumps.mjs a.txt b.txt --strict

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const DEFAULT_GEOM_TOLERANCE = 0.5;
/** A rank that moves by more than this FRACTION of the list is an order divergence, not float noise. */
const ORDER_TOLERANCE_FRACTION = 0.02;
/** Premultiplied-alpha agreement. Coarse on purpose: CSS composites opacity in sRGB and the draw list does not. */
const ALPHA_TOLERANCE = 0.02;

function usage() {
  console.log("usage: node scripts/compare-paint-dumps.mjs <a.paint.txt> <b.paint.txt> [options]");
  console.log("  --geom-tolerance <px>   geometry delta that counts as a divergence (default 0.5)");
  console.log("  --top <n>               worst-offender rows to print per section (default 12)");
  console.log("  --strict                turn every pre-registered divergence class OFF");
  console.log(
    "  --no-zorder|--no-text|--no-float|--no-blendfix|--no-effects|--no-fx|--no-trail|--no-textquad   turn one class off"
  );
  console.log("  --any-viewport          allow a pair not taken at 1920x1080 (see the header)");
  console.log("  --json                  emit the summary as one JSON line as well");
}

function parseArgs(argv) {
  const a = {
    files: [],
    geomTolerance: DEFAULT_GEOM_TOLERANCE,
    top: 12,
    classes: {
      zorder: true,
      text: true,
      float: true,
      blendfix: true,
      effects: true,
      fx: true,
      trail: true,
      textquad: true
    },
    anyViewport: false,
    json: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      a.files.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    const val = () => (eq > 0 ? arg.slice(eq + 1) : argv[++i]);
    switch (key) {
      case "--geom-tolerance": a.geomTolerance = Number(val()); break;
      case "--top": a.top = Number(val()); break;
      case "--strict": for (const k of Object.keys(a.classes)) a.classes[k] = false; break;
      // Every class name in BOTH lists. `--trail` and `--no-trail` were missing from these two cases since class
      // (g) landed — the class existed, its flag did not, and `--no-trail` fell through to "Unknown argument".
      case "--zorder": case "--text": case "--float": case "--blendfix": case "--effects": case "--fx":
      case "--trail": case "--textquad":
        a.classes[key.slice(2)] = true; break;
      case "--no-zorder": case "--no-text": case "--no-float": case "--no-blendfix": case "--no-effects":
      case "--no-fx": case "--no-trail": case "--no-textquad":
        a.classes[key.slice(5)] = false; break;
      case "--any-viewport": a.anyViewport = true; break;
      case "--json": a.json = true; break;
      case "--help": case "-h": a.help = true; break;
      default: console.error(`Unknown argument: ${arg}`); a.help = true;
    }
  }
  return a;
}

// ---------------------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------------------

/** `k=v k=v …` from a dump line's tail, plus the positional head fields. Values never contain spaces. */
function fields(rest) {
  const out = {};
  for (const token of rest) {
    const eq = token.indexOf("=");
    if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

const nums = (s) => (s ?? "").split(",").map(Number);

/**
 * A node type reduced to its leaf.
 *
 * The two arms name the same type differently and neither is wrong: the canvas dump runs the wire's type through
 * `mirrorRenderer.nodeTypeLeaf` (which is what every classification in the renderer keys on), while the DOM's
 * `data-node-type` stamp carries the namespaced original. Grouping is by leaf on both sides.
 */
const leaf = (t) => {
  const s = String(t ?? "-");
  const dot = s.lastIndexOf(".");
  return dot >= 0 ? s.slice(dot + 1) : s;
};

function parseDump(path) {
  const text = readFileSync(path, "utf8");
  const meta = {};
  const commands = [];
  const clips = [];
  const overlays = [];
  const texts = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      const m = /^#\s*([A-Za-z]+)=(.*)$/.exec(line);
      if (m) meta[m[1]] = m[2];
      continue;
    }
    const parts = line.split(" ");
    if (parts[0] === "C") {
      const f = fields(parts.slice(4));
      commands.push({
        index: Number(parts[1]),
        nodeId: parts[2],
        kind: parts[3],
        role: f.role ?? "?",
        type: leaf(f.type),
        m: f.m ? nums(f.m) : null,
        wh: f.wh ? nums(f.wh) : null,
        // A polyline records its endpoints instead of a box; both are placements, so both go through the same
        // corner comparison below (a 2-point "box" for a line).
        p0: f.p0 && f.p0 !== "-" ? nums(f.p0) : null,
        p1: f.p1 && f.p1 !== "-" ? nums(f.p1) : null,
        rgba: f.rgba ? nums(f.rgba) : null,
        blend: f.blend ?? "mix",
        tex: f.tex ?? "-",
        clip: f.clip ?? "-",
        src: f.src ?? "?",
        fit: f.fit ?? "-",
        line
      });
    } else if (parts[0] === "K") {
      const f = fields(parts.slice(2));
      clips.push({
        nodeId: parts[1],
        rect: f.rect ? nums(f.rect) : null,
        border: f.border ? nums(f.border) : null,
        scope: f.scope ?? "-",
        line
      });
    } else if (parts[0] === "T") {
      const f = fields(parts.slice(2));
      texts.push({
        nodeId: parts[1],
        font: Number(f.font),
        lineHeight: Number(f.lineHeight),
        family: f.family ?? "-",
        scale: f.scale ?? "-",
        ts: f.ts ?? "-",
        box: f.box ?? "-",
        lines: Number(f.lines ?? 1),
        white: f.white ?? "-",
        line
      });
    } else if (parts[0] === "O") {
      const f = fields(parts.slice(4));
      overlays.push({
        order: Number(parts[1]),
        nodeId: parts[2],
        kind: parts[3],
        type: leaf(f.type),
        m: f.m ? nums(f.m) : null,
        wh: f.wh ? nums(f.wh) : null,
        line
      });
    }
  }
  return { path, meta, commands, clips, overlays, texts };
}

// ---------------------------------------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------------------------------------

/** The four corners of a record's placed box in design space, or the two endpoints of a polyline. */
function corners(rec) {
  if (rec.p0 && rec.p1) return [rec.p0, rec.p1];
  if (!rec.m || !rec.wh) return null;
  const [a, b, c, d, e, f] = rec.m;
  const [w, h] = rec.wh;
  const at = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  return [at(0, 0), at(w, 0), at(0, h), at(w, h)];
}

function cornerDelta(x, y) {
  const cx = corners(x);
  const cy = corners(y);
  if (!cx || !cy || cx.length !== cy.length) return null;
  let worst = 0;
  for (let i = 0; i < cx.length; i++) {
    worst = Math.max(worst, Math.hypot(cx[i][0] - cy[i][0], cx[i][1] - cy[i][1]));
  }
  return worst;
}

/** The centre of a record's placed box — the placement, independent of how big the picture inside it is. */
function centreOf(rec) {
  const c = corners(rec);
  if (!c) return null;
  let x = 0;
  let y = 0;
  for (const [px, py] of c) {
    x += px;
    y += py;
  }
  return [x / c.length, y / c.length];
}

/**
 * A texture url reduced to a comparable identity: no origin, no query, no cache-busting version.
 *
 * `blob:` is NOT a url the two arms can be expected to agree on and its difference is not a fidelity gap: it is
 * the DOM backend's ATLAS BAKE — a region cropped out of the atlas page into its own canvas and handed back as an
 * object url, precisely so the browser rasterizes one small image instead of a full page per sprite. The canvas
 * backend has no such step (it samples the page directly with a source rect), so the honest verdict is "not
 * expressible", counted and reported rather than failed.
 */
function texKey(url) {
  if (!url || url === "-") return null;
  if (url.startsWith("<")) return url; // `<canvas>` — a baked surface, not a url
  if (url.startsWith("blob:") || url.startsWith("data:")) return "<baked>";
  let path = url;
  const scheme = path.indexOf("://");
  if (scheme >= 0) {
    const slash = path.indexOf("/", scheme + 3);
    path = slash >= 0 ? path.slice(slash) : "/";
  }
  const q = path.indexOf("?");
  if (q >= 0) path = path.slice(0, q);
  return path;
}

/** `<nodeId>#<role>#<ordinal>` — see the header. */
function keyed(records) {
  const out = new Map();
  const seen = new Map();
  for (const rec of records) {
    const stem = `${rec.nodeId}#${rec.role}`;
    const n = seen.get(stem) ?? 0;
    seen.set(stem, n + 1);
    rec.key = `${stem}#${n}`;
    out.set(rec.key, rec);
  }
  return out;
}

const EFFECT_OVERLAY_KINDS = new Set(["shader", "particles", "spine", "trail"]);

/**
 * The command roles CLASS (f) covers — a surface the canvas arm paints IN the stage that the DOM arm shows as an
 * overlay element. `fx` is M2's shader/particle quads; `spine` is M3's clip stills. Both are canvas-only BY
 * DESIGN, and both have a matched overlay record on the DOM side, which is what the class asserts.
 */
const IN_CANVAS_ROLES = new Set(["fx", "spine"]);

/**
 * …and CLASS (g)'s role. Separate from the set above because the two classes make different claims: (f) says the
 * DOM arm shows the same SURFACE some other way, (g) says the DOM arm draws the same RIBBON some other way. Their
 * flags are independent so a run can put one back in the raw diff without the other.
 */
const TRAIL_ROLES = new Set(["trail"]);

/**
 * …and CLASS (h)'s. Separate again, and for the sharpest reason of the three: (f) and (g) are backend differences
 * that are always there, while this one identifies the canvas text path's matched overlay records.
 */
const TEXT_QUAD_ROLES = new Set(["text"]);

/** Which pre-registered class (if any) explains a record that exists on only ONE side. */
function unmatchedClass(rec, isOverlay) {
  if (isOverlay) return rec.kind === "text" ? "text" : EFFECT_OVERLAY_KINDS.has(rec.kind) ? "effects" : "other";
  // Only reachable with the matching class turned OFF (`--no-fx` / `--no-trail` / `--no-textquad` / `--strict`),
  // which puts those quads back in the raw diff. Still named rather than dumped into "other": what they are is not
  // in question, only whether the run wants them excluded.
  if (IN_CANVAS_ROLES.has(rec.role)) return "fx";
  if (TRAIL_ROLES.has(rec.role)) return "trail";
  return TEXT_QUAD_ROLES.has(rec.role) ? "textquad" : "other";
}

function pct(n, d) {
  return d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : "-";
}

function table(rows, columns) {
  if (rows.length === 0) return;
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? "").length)));
  const pad = (s, w, right) => (right ? String(s).padStart(w) : String(s).padEnd(w));
  console.log("  " + columns.map((c, i) => pad(c.label, widths[i], c.align === "r")).join("  "));
  console.log("  " + columns.map((_, i) => "-".repeat(widths[i])).join("  "));
  for (const r of rows) {
    console.log("  " + columns.map((c, i) => pad(r[c.key] ?? "", widths[i], c.align === "r")).join("  "));
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.files.length !== 2) {
    usage();
    return args.help ? 0 : 2;
  }
  const [first, second] = args.files.map(parseDump);
  // Orientation is by the header, not by argument order: the canvas arm is always reported as "canvas".
  const canvas = first.meta.backend === "canvas" ? first : second;
  const dom = canvas === first ? second : first;
  if (canvas.meta.backend !== "canvas" || dom.meta.backend !== "dom") {
    console.error(
      `expected one canvas dump and one dom dump, got backend=${first.meta.backend} and backend=${second.meta.backend}`
    );
    return 2;
  }
  if (canvas.meta.recording !== dom.meta.recording) {
    console.error(`the two dumps are of DIFFERENT recordings (${canvas.meta.recording} vs ${dom.meta.recording})`);
    return 2;
  }
  if (!args.anyViewport && (canvas.meta.viewport !== "1920x1080" || dom.meta.viewport !== "1920x1080")) {
    console.error(
      `viewport ${canvas.meta.viewport} / ${dom.meta.viewport}: the canvas backend has no wide-screen spread yet ` +
        `(M1a), so only 1920x1080 is a fair comparison. Re-run both arms at --viewport 1920x1080, or pass ` +
        `--any-viewport to compare anyway.`
    );
    return 2;
  }

  // CLASS (f) — see the header. A `role=fx` command exists only on the canvas arm.
  // It is the in-canvas paint of a surface that is a matched OVERLAY on BOTH arms, so it is lifted out of the
  // command comparison entirely rather than keyed into it, where every shader and emitter on screen would read as
  // a canvas-only miss. Its own section below is where it is accounted for.
  const fxQuads = args.classes.fx ? canvas.commands.filter((c) => IN_CANVAS_ROLES.has(c.role)) : [];
  // CLASS (g) — the same lift, for the same reason, over the trail role. A single flying card contributes up to
  // 282 of these (two strokes x three bands x one cell per segment), so leaving them keyed into the command diff
  // would bury every real divergence on the screen under one comet.
  const trailQuads = args.classes.trail ? canvas.commands.filter((c) => TRAIL_ROLES.has(c.role)) : [];
  // CLASS (h) — the same lift over the rastered-label role. A dense screen contributes one per drawn label (52 on
  // the shop), every one of which has a matched `text` overlay on both arms, so keying them into the command diff
  // would report the entire lever as canvas-only misses.
  const textQuads = args.classes.textquad ? canvas.commands.filter((c) => TEXT_QUAD_ROLES.has(c.role)) : [];
  const lifted = (c) =>
    (args.classes.fx && IN_CANVAS_ROLES.has(c.role)) ||
    (args.classes.trail && TRAIL_ROLES.has(c.role)) ||
    (args.classes.textquad && TEXT_QUAD_ROLES.has(c.role));
  const canvasCommands = canvas.commands.filter((c) => !lifted(c));
  // PAINT-ORDER RANK IS TAKEN OVER THE COMPARED LIST, not over the raw stream. Effect quads shift later canvas
  // ranks, which would report an ORDER divergence on commands that
  // did not move. With no fx quads this is exactly `index`, so no existing dump reads differently.
  canvasCommands.forEach((c, i) => { c.rankIndex = i; });
  dom.commands.forEach((d, i) => { d.rankIndex = i; });

  const cCmds = keyed(canvasCommands);
  const dCmds = keyed(dom.commands);
  const cOver = new Map(canvas.overlays.map((o) => [o.nodeId, o]));
  const dOver = new Map(dom.overlays.map((o) => [o.nodeId, o]));

  const matched = [];
  const fitRecords = [];
  const fitBad = [];
  const geomBad = [];
  const texBad = [];
  const texSkipped = [];
  const blendBad = [];
  const alphaBad = [];
  const orderBad = [];
  const clipBad = [];

  for (const [key, c] of cCmds) {
    const d = dCmds.get(key);
    if (!d) continue;
    matched.push(key);
    // ASPECT-FIT records are compared by CENTRE, not by corner. On `contain`/`cover` the builder resolves the fit
    // into the destination rect while CSS leaves the element box alone and fits the background inside it, so the
    // two arms record different rectangles for the same pixels ON PURPOSE. The centre is what both agree on, and
    // it is what a real displacement moves; the extent is reported beside it so a fit that is genuinely wrong (an
    // image fitted to the wrong box) still shows up.
    const aspectFit = d.fit === "contain" || d.fit === "cover";
    const delta = aspectFit ? null : cornerDelta(c, d);
    if (delta !== null && delta > args.geomTolerance) {
      geomBad.push({ key, type: c.type, role: c.role, delta: Math.round(delta * 100) / 100, c, d });
    }
    if (aspectFit) {
      const cc = centreOf(c);
      const dc = centreOf(d);
      const cd = cc && dc ? Math.hypot(cc[0] - dc[0], cc[1] - dc[1]) : null;
      fitRecords.push(key);
      if (cd !== null && cd > args.geomTolerance) {
        fitBad.push({ key, type: c.type, delta: Math.round(cd * 100) / 100, c, d });
      }
    }
    const ct = texKey(c.tex);
    const dt = texKey(d.tex);
    if (ct !== null && dt !== null) {
      if (dt.startsWith("<")) texSkipped.push(key);
      else if (ct !== dt) texBad.push({ key, type: c.type, canvas: ct, dom: dt });
    } else if (ct !== dt) {
      texSkipped.push(key);
    }
    if (c.blend !== d.blend) blendBad.push({ key, type: c.type, canvas: c.blend, dom: d.blend });
    if (c.rgba && d.rgba && Math.abs(c.rgba[3] - d.rgba[3]) > ALPHA_TOLERANCE) {
      alphaBad.push({ key, type: c.type, role: c.role, canvas: c.rgba[3], dom: d.rgba[3] });
    }
    const cRank = c.rankIndex / Math.max(1, canvasCommands.length);
    const dRank = d.rankIndex / Math.max(1, dom.commands.length);
    if (Math.abs(cRank - dRank) > ORDER_TOLERANCE_FRACTION) {
      orderBad.push({ key, type: c.type, canvas: c.index, dom: d.index, drift: Math.round((cRank - dRank) * 1000) / 10 });
    }
    if (c.clip !== d.clip) clipBad.push({ key, type: c.type, canvas: c.clip, dom: d.clip });
  }

  // CLIP SCOPES. Keyed by the clipper's node id — one scope per clipper on both arms. The rect itself matters as
  // much as the paint does: a scope that is 12px narrow crops the art inside it, and nothing in the command
  // comparison above would see that (the commands are identical; only the scissor moved).
  const cClips = new Map(canvas.clips.map((c) => [c.nodeId, c]));
  const dClips = new Map(dom.clips.map((c) => [c.nodeId, c]));
  const clipRectBad = [];
  let clipMatched = 0;
  for (const [id, c] of cClips) {
    const d = dClips.get(id);
    if (!d) continue;
    clipMatched++;
    if (!c.rect || !d.rect) continue;
    let worst = 0;
    for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(c.rect[i] - d.rect[i]));
    if (worst > args.geomTolerance) {
      clipRectBad.push({
        key: id,
        delta: Math.round(worst * 100) / 100,
        canvas: c.rect.map((n) => n.toFixed(1)).join(","),
        dom: d.rect.map((n) => n.toFixed(1)).join(",")
      });
    }
  }
  const clipOnlyCanvas = [...cClips.keys()].filter((k) => !dClips.has(k));
  const clipOnlyDom = [...dClips.keys()].filter((k) => !cClips.has(k));

  const onlyCanvas = [...cCmds.keys()].filter((k) => !dCmds.has(k)).map((k) => cCmds.get(k));
  const onlyDom = [...dCmds.keys()].filter((k) => !cCmds.has(k)).map((k) => dCmds.get(k));
  const overlayBoth = [...cOver.keys()].filter((k) => dOver.has(k));
  const overlayOnlyCanvas = [...cOver.values()].filter((o) => !dOver.has(o.nodeId));
  const overlayOnlyDom = [...dOver.values()].filter((o) => !cOver.has(o.nodeId));

  const group = (records, isOverlay) => {
    const by = new Map();
    for (const r of records) {
      const cls = unmatchedClass(r, isOverlay);
      const bucket = by.get(cls) ?? new Map();
      const label = isOverlay ? `${r.kind}/${r.type}` : `${r.role}/${r.type}`;
      bucket.set(label, (bucket.get(label) ?? 0) + 1);
      by.set(cls, bucket);
    }
    return by;
  };

  const label = `${basename(canvas.path)}  vs  ${basename(dom.path)}`;
  console.log(`\n${label}`);
  console.log(
    `  recording ${canvas.meta.recording}   viewport ${canvas.meta.viewport}` +
      `   canvas ${canvasCommands.length} cmds${fxQuads.length > 0 ? ` (+${fxQuads.length} fx)` : ""}` +
      ` / ${canvas.overlays.length} overlays / ${canvas.clips.length} clips` +
      `   dom ${dom.commands.length} cmds / ${dom.overlays.length} overlays / ${dom.clips.length} clips`
  );

  const total = Math.max(cCmds.size, dCmds.size);
  console.log("\nMATCH");
  table(
    [
      { metric: "matched commands", n: matched.length, of: `${cCmds.size} canvas / ${dCmds.size} dom`, rate: pct(matched.length, total) },
      { metric: "canvas-only", n: onlyCanvas.length, of: `${cCmds.size}`, rate: pct(onlyCanvas.length, cCmds.size) },
      { metric: "dom-only", n: onlyDom.length, of: `${dCmds.size}`, rate: pct(onlyDom.length, dCmds.size) },
      { metric: "matched overlays", n: overlayBoth.length, of: `${cOver.size} canvas / ${dOver.size} dom`, rate: pct(overlayBoth.length, Math.max(cOver.size, dOver.size)) }
    ],
    [
      { key: "metric", label: "metric" },
      { key: "n", label: "n", align: "r" },
      { key: "of", label: "of" },
      { key: "rate", label: "rate", align: "r" }
    ]
  );

  console.log("\nAGREEMENT ON MATCHED COMMANDS");
  const cls = args.classes;
  table(
    [
      {
        check: `geometry, corners (<= ${args.geomTolerance}px)`,
        bad: geomBad.length,
        rate: pct(matched.length - geomBad.length - fitRecords.length, matched.length - fitRecords.length),
        note: cls.float ? "class (c) absorbed by the tolerance" : ""
      },
      {
        check: `geometry, aspect-fit centres`,
        bad: fitBad.length,
        rate: pct(fitRecords.length - fitBad.length, fitRecords.length),
        note: `${fitRecords.length} contain/cover records — compared by centre (see the header)`
      },
      { check: "texture identity", bad: texBad.length, rate: pct(matched.length - texBad.length - texSkipped.length, matched.length - texSkipped.length), note: texSkipped.length > 0 ? `${texSkipped.length} not expressible on one side` : "" },
      { check: "blend mode", bad: blendBad.length, rate: pct(matched.length - blendBad.length, matched.length), note: cls.blendfix ? "class (d) — canvas fixes ADD/SUB/degenerate" : "" },
      { check: "premultiplied alpha", bad: alphaBad.length, rate: pct(matched.length - alphaBad.length, matched.length), note: "" },
      { check: "clip scope", bad: clipBad.length, rate: pct(matched.length - clipBad.length, matched.length), note: "" },
      {
        check: `paint-order rank (<= ${ORDER_TOLERANCE_FRACTION * 100}%)`,
        bad: orderBad.length,
        rate: pct(matched.length - orderBad.length, matched.length),
        note: cls.zorder ? "class (a) — reported, not failed" : ""
      }
    ],
    [
      { key: "check", label: "check" },
      { key: "bad", label: "diverged", align: "r" },
      { key: "rate", label: "agree", align: "r" },
      { key: "note", label: "note" }
    ]
  );

  // The SCALE RATIO between the arms is the single most attributing number a geometry row can carry. A ratio of
  // exactly 1.25 on a combat pile button is the M2 view-scale stub (`viewScale.VIEW_SCALE_PILE`, which the canvas
  // backend does not apply yet and says so at `viewScaleInputStamps`); a ratio of 1 with a big delta is a real
  // displacement; a rotation that differs is usually a free-running animation caught at a different phase.
  const scaleOf = (m) => (m ? Math.hypot(m[0], m[1]) : 0);
  const geomRow = (g) => ({
    key: g.key,
    type: g.type,
    delta: g.delta,
    ratio: scaleOf(g.c.m) > 0 ? (scaleOf(g.d.m) / scaleOf(g.c.m)).toFixed(3) : "-",
    canvas: `${g.c.m ? g.c.m.slice(4).map((n) => n.toFixed(1)).join(",") : "-"} ${g.c.wh ? g.c.wh.map((n) => n.toFixed(1)).join("x") : ""}`,
    dom: `${g.d.m ? g.d.m.slice(4).map((n) => n.toFixed(1)).join(",") : "-"} ${g.d.wh ? g.d.wh.map((n) => n.toFixed(1)).join("x") : ""}`
  });
  const geomCols = [
    { key: "key", label: "node#role#n" },
    { key: "type", label: "type" },
    { key: "delta", label: "px", align: "r" },
    { key: "ratio", label: "dom/cvs scale", align: "r" },
    { key: "canvas", label: "canvas origin + box" },
    { key: "dom", label: "dom origin + box" }
  ];
  if (geomBad.length > 0) {
    geomBad.sort((a, b) => b.delta - a.delta);
    console.log(`\nWORST GEOMETRY (top ${Math.min(args.top, geomBad.length)} of ${geomBad.length})`);
    table(geomBad.slice(0, args.top).map(geomRow), geomCols);
  }
  if (fitBad.length > 0) {
    fitBad.sort((a, b) => b.delta - a.delta);
    console.log(`\nWORST ASPECT-FIT CENTRES (top ${Math.min(args.top, fitBad.length)} of ${fitBad.length})`);
    table(fitBad.slice(0, args.top).map(geomRow), geomCols);
  }

  // FX SURFACES (class (f)) — the M2 accounting, printed only when the canvas arm actually drew effects in-canvas.
  //
  // The two questions worth asking of an fx quad, and neither of them is geometry: the quad's box is gsw's CANVAS
  // box (a shader's is a percentage of the self layer, an emitter's is a px box with a NEGATIVE travel margin
  // around a node whose own box is 0x0), so comparing it to the DOM host element's box would report a divergence
  // on every emitter by construction. What IS comparable is EXISTENCE.
  //
  //   1. Does every fx quad correspond to a surface the DOM arm also shows? An orphan means the flag invented an
  //      effect, or the DOM arm lost one — a real divergence either way, and reported as one.
  //   2. How many of the canvas arm's own shader/particle surfaces reached the draw list? That is M2's coverage
  //      read off the paint dump instead of off the census, and the two should agree.
  // The overlay kinds a class-(f) quad can be painting. `spine` is here since M3: a still the canvas draws is a
  // `spine` overlay record on the DOM arm, exactly as a shader surface is a `shader` one.
  const fxSurfaceKinds = new Set(["shader", "particles", "spine"]);
  const cFxSurfaces = canvas.overlays.filter((o) => fxSurfaceKinds.has(o.kind));
  if (fxQuads.length > 0 || cFxSurfaces.length > 0) {
    const drawn = new Set(fxQuads.map((q) => q.nodeId));
    const orphans = fxQuads.filter((q) => !dOver.has(q.nodeId));
    const byKind = new Map();
    for (const q of fxQuads) {
      const kind = cOver.get(q.nodeId)?.kind ?? "?";
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    console.log(
      "\nIN-CANVAS SURFACES (class (f): the canvas arm paints these in the stage)"
    );
    table(
      [
        {
          metric: "in-canvas quads (canvas-only by design)",
          n: fxQuads.length,
          of: [...byKind.entries()].map(([k, v]) => `${k}x${v}`).join(" ") || "-",
          rate: "-"
        },
        {
          metric: "…whose surface the DOM arm shows too",
          n: fxQuads.length - orphans.length,
          of: `${fxQuads.length}`,
          rate: pct(fxQuads.length - orphans.length, fxQuads.length)
        },
        {
          metric: "…orphan (no DOM surface) — INVESTIGATE",
          n: orphans.length,
          of: `${fxQuads.length}`,
          rate: pct(orphans.length, fxQuads.length)
        },
        {
          metric: "canvas surfaces of those kinds drawn as a quad",
          n: cFxSurfaces.filter((o) => drawn.has(o.nodeId)).length,
          of: `${cFxSurfaces.length} shader/particle overlays`,
          rate: pct(cFxSurfaces.filter((o) => drawn.has(o.nodeId)).length, cFxSurfaces.length)
        }
      ],
      [
        { key: "metric", label: "metric" },
        { key: "n", label: "n", align: "r" },
        { key: "of", label: "of" },
        { key: "rate", label: "rate", align: "r" }
      ]
    );
    if (orphans.length > 0) {
      console.log(`\nORPHAN FX QUADS (top ${Math.min(args.top, orphans.length)} of ${orphans.length})`);
      table(
        orphans.slice(0, args.top).map((q) => ({
          key: q.nodeId,
          type: q.type,
          canvas: `${q.wh ? q.wh.map((n) => n.toFixed(1)).join("x") : "-"} blend=${q.blend}`,
          dom: cOver.get(q.nodeId) ? `canvas overlay ${cOver.get(q.nodeId).kind}` : "no canvas overlay either"
        })),
        [
          { key: "key", label: "node" },
          { key: "type", label: "type" },
          { key: "canvas", label: "fx quad" },
          { key: "dom", label: "dom side" }
        ]
      );
    }
  }

  console.log("\nCLIP SCOPES");
  table(
    [
      { metric: "matched scopes", n: clipMatched, of: `${cClips.size} canvas / ${dClips.size} dom`, rate: pct(clipMatched, Math.max(cClips.size, dClips.size)) },
      { metric: `rect agrees (<= ${args.geomTolerance}px)`, n: clipMatched - clipRectBad.length, of: `${clipMatched}`, rate: pct(clipMatched - clipRectBad.length, clipMatched) },
      { metric: "canvas-only scope", n: clipOnlyCanvas.length, of: `${cClips.size}`, rate: pct(clipOnlyCanvas.length, cClips.size) },
      { metric: "dom-only scope", n: clipOnlyDom.length, of: `${dClips.size}`, rate: pct(clipOnlyDom.length, dClips.size) }
    ],
    [
      { key: "metric", label: "metric" },
      { key: "n", label: "n", align: "r" },
      { key: "of", label: "of" },
      { key: "rate", label: "rate", align: "r" }
    ]
  );
  if (clipRectBad.length > 0) {
    clipRectBad.sort((a, b) => b.delta - a.delta);
    console.log(`\nWORST CLIP RECTS (top ${Math.min(args.top, clipRectBad.length)} of ${clipRectBad.length})`);
    table(clipRectBad.slice(0, args.top), [
      { key: "key", label: "clipper" },
      { key: "delta", label: "px", align: "r" },
      { key: "canvas", label: "canvas x,y,w,h" },
      { key: "dom", label: "dom x,y,w,h" }
    ]);
  }

  for (const [title, bad] of [
    ["TEXTURE IDENTITY", texBad],
    ["BLEND MODE", blendBad],
    ["CLIP SCOPE ASSIGNMENT", clipBad]
  ]) {
    if (bad.length === 0) continue;
    console.log(`\n${title} (top ${Math.min(args.top, bad.length)} of ${bad.length})`);
    table(bad.slice(0, args.top), [
      { key: "key", label: "node#role#n" },
      { key: "type", label: "type" },
      { key: "canvas", label: "canvas" },
      { key: "dom", label: "dom" }
    ]);
  }

  // TEXT METRICS. Class (b) says text is a DOM overlay on BOTH backends, so this section should be all-100%: the
  // same font at the same size on the same number of lines. Anything else is a real fidelity bug wearing an
  // "expected AA difference" costume — a label that wraps on one backend and not the other moves thousands of
  // pixels while every geometry check above still reads 100%.
  const cText = new Map(canvas.texts.map((t) => [t.nodeId, t]));
  const dText = new Map(dom.texts.map((t) => [t.nodeId, t]));
  let textShared = 0;
  let fontAgree = 0;
  let familyAgree = 0;
  let scaleAgree = 0;
  let tsAgree = 0;
  let linesAgree = 0;
  const textBad = [];
  for (const [id, c] of cText) {
    const d = dText.get(id);
    if (!d) continue;
    textShared++;
    const sameFont = Math.abs(c.font - d.font) <= 0.51;
    if (sameFont) fontAgree++;
    if (c.family === d.family) familyAgree++;
    if (c.scale === d.scale) scaleAgree++;
    if (c.ts === d.ts) tsAgree++;
    if (c.lines === d.lines) linesAgree++;
    if (!sameFont || c.lines !== d.lines || c.family !== d.family) {
      textBad.push({
        key: id,
        canvas: `${c.font}px ${c.family} x${c.lines}l scale=${c.scale} ts=${c.ts}`,
        dom: `${d.font}px ${d.family} x${d.lines}l scale=${d.scale} ts=${d.ts}`
      });
    }
  }
  console.log("\nTEXT METRICS (class (b) — text is a DOM overlay on BOTH backends, so these should be 100%)");
  table(
    [
      { metric: "labels compared", n: textShared, of: `${cText.size} canvas / ${dText.size} dom`, rate: pct(textShared, Math.max(cText.size, dText.size)) },
      { metric: "computed font-size", n: fontAgree, of: `${textShared}`, rate: pct(fontAgree, textShared) },
      { metric: "font family", n: familyAgree, of: `${textShared}`, rate: pct(familyAgree, textShared) },
      { metric: "--godot-text-scale", n: scaleAgree, of: `${textShared}`, rate: pct(scaleAgree, textShared) },
      { metric: "mirror-ts-* rules stamped", n: tsAgree, of: `${textShared}`, rate: pct(tsAgree, textShared) },
      { metric: "rendered line count", n: linesAgree, of: `${textShared}`, rate: pct(linesAgree, textShared) }
    ],
    [
      { key: "metric", label: "metric" },
      { key: "n", label: "agree", align: "r" },
      { key: "of", label: "of" },
      { key: "rate", label: "rate", align: "r" }
    ]
  );
  if (textBad.length > 0) {
    console.log(`\nWORST TEXT METRICS (top ${Math.min(args.top, textBad.length)} of ${textBad.length})`);
    table(textBad.slice(0, args.top), [
      { key: "key", label: "node" },
      { key: "canvas", label: "canvas" },
      { key: "dom", label: "dom" }
    ]);
  }

  // CARD TRAILS (class (g)) — printed only when a comet was actually on screen, which for most recordings is
  // never: a trail exists only while a card is moving, and a paint dump is taken at a settled instant.
  //
  // The two questions are (f)'s, restated for a shape that has no shared geometry to compare AT ALL. The DOM arm
  // draws one closed SVG polygon per band; the canvas arm draws one quad per band per segment. Those are two
  // different tessellations of the same ribbon, so per-command geometry is meaningless across them and EXISTENCE
  // is what the gate can honestly assert:
  //
  //   1. Does every trail quad belong to a stroke the DOM arm also has a `trail` overlay for? An orphan means
  //      one arm invented a comet or lost one.
  //   2. How many of the canvas arm's own trail strokes actually reached the draw list? A stroke with a record
  //      and no quads is a ribbon that was classified and then not drawn.
  const cTrailStrokes = canvas.overlays.filter((o) => o.kind === "trail");
  const dTrailStrokes = dom.overlays.filter((o) => o.kind === "trail");
  if (trailQuads.length > 0 || cTrailStrokes.length > 0 || dTrailStrokes.length > 0) {
    const drawnTrails = new Set(trailQuads.map((q) => q.nodeId));
    const trailOrphans = trailQuads.filter((q) => !dOver.has(q.nodeId));
    const perStroke = drawnTrails.size > 0 ? Math.round(trailQuads.length / drawnTrails.size) : 0;
    console.log(
      "\nCARD TRAILS (class (g) — both arms integrate the ribbon; the canvas arm draws it IN the stage)"
    );
    table(
      [
        {
          metric: "trail quads (canvas-only by design)",
          n: trailQuads.length,
          of: `${drawnTrails.size} stroke(s), ~${perStroke}/stroke`,
          rate: "-"
        },
        {
          metric: "…whose stroke the DOM arm shows too",
          n: trailQuads.length - trailOrphans.length,
          of: `${trailQuads.length}`,
          rate: pct(trailQuads.length - trailOrphans.length, trailQuads.length)
        },
        {
          metric: "…orphan (no DOM stroke) — INVESTIGATE",
          n: trailOrphans.length,
          of: `${trailQuads.length}`,
          rate: pct(trailOrphans.length, trailQuads.length)
        },
        {
          metric: "canvas trail strokes drawn as quads",
          n: cTrailStrokes.filter((o) => drawnTrails.has(o.nodeId)).length,
          of: `${cTrailStrokes.length} canvas / ${dTrailStrokes.length} dom trail overlays`,
          rate: pct(cTrailStrokes.filter((o) => drawnTrails.has(o.nodeId)).length, cTrailStrokes.length)
        }
      ],
      [
        { key: "metric", label: "metric" },
        { key: "n", label: "n", align: "r" },
        { key: "of", label: "of" },
        { key: "rate", label: "rate", align: "r" }
      ]
    );
    if (trailOrphans.length > 0) {
      console.log(`\nORPHAN TRAIL QUADS (top ${Math.min(args.top, trailOrphans.length)} of ${trailOrphans.length})`);
      table(
        trailOrphans.slice(0, args.top).map((q) => ({
          key: q.nodeId,
          type: q.type,
          canvas: `blend=${q.blend}`,
          dom: cOver.get(q.nodeId) ? `canvas overlay ${cOver.get(q.nodeId).kind}` : "no canvas overlay either"
        })),
        [
          { key: "key", label: "node" },
          { key: "type", label: "type" },
          { key: "canvas", label: "trail quad" },
          { key: "dom", label: "dom side" }
        ]
      );
    }
  }

  // RASTERED LABELS (class (h)) — printed only when the lever is on, so every dump taken before it existed reads
  // exactly as it did.
  //
  // The questions are (f)'s and (g)'s, with one addition that only a LEVER needs. Geometry is not among them: a
  // text quad's box is the label's INK box (the glyph run plus an outline's half-width, a shadow's displacement
  // and a 1px skirt), while the DOM overlay's box is the label's streamed BOX — two different rectangles for the
  // same words, by design, so comparing them would report a divergence on every label that exists. What is
  // comparable is EXISTENCE, and:
  //
  //   1. Does every text quad correspond to a label the DOM arm also shows? An orphan means the lever invented a
  //      label, or the DOM arm lost one.
  //   2. HOW MANY of the canvas arm's own labels became quads. This is the addition, and it is the row that makes
  //      a vacuous pass visible: the canvas arm emits a `text` overlay record for every label whether it drew it
  //      or not, so "lever on, coverage 0%" and "lever off" are the same picture everywhere else in this report
  //      and differ only here. A gap is a runtime refusal (a face still loading, a paced upload, a rich label) —
  //      each of which is a designed outcome, and none of which should be a surprise at a settled capture.
  const cTextOverlays = canvas.overlays.filter((o) => o.kind === "text");
  const dTextOverlays = dom.overlays.filter((o) => o.kind === "text");
  if (textQuads.length > 0) {
    const drawnLabels = new Set(textQuads.map((q) => q.nodeId));
    const textOrphans = textQuads.filter((q) => !dOver.has(q.nodeId) || dOver.get(q.nodeId).kind !== "text");
    const covered = cTextOverlays.filter((o) => drawnLabels.has(o.nodeId)).length;
    console.log("\nCANVAS TEXT LABELS (class (h): the canvas arm draws these in the stage)");
    table(
      [
        {
          metric: "text quads (canvas-only by design)",
          n: textQuads.length,
          of: `${drawnLabels.size} label(s)`,
          rate: "-"
        },
        {
          metric: "…whose label the DOM arm shows too",
          n: textQuads.length - textOrphans.length,
          of: `${textQuads.length}`,
          rate: pct(textQuads.length - textOrphans.length, textQuads.length)
        },
        {
          metric: "…orphan (no DOM label) — INVESTIGATE",
          n: textOrphans.length,
          of: `${textQuads.length}`,
          rate: pct(textOrphans.length, textQuads.length)
        },
        {
          metric: "canvas labels drawn as a quad (coverage)",
          n: covered,
          of: `${cTextOverlays.length} canvas / ${dTextOverlays.length} dom text overlays`,
          rate: pct(covered, cTextOverlays.length)
        },
        {
          metric: "…still on the overlay (refused or paced)",
          n: cTextOverlays.length - covered,
          of: `${cTextOverlays.length}`,
          rate: pct(cTextOverlays.length - covered, cTextOverlays.length)
        }
      ],
      [
        { key: "metric", label: "metric" },
        { key: "n", label: "n", align: "r" },
        { key: "of", label: "of" },
        { key: "rate", label: "rate", align: "r" }
      ]
    );
    if (textOrphans.length > 0) {
      console.log(`\nORPHAN TEXT QUADS (top ${Math.min(args.top, textOrphans.length)} of ${textOrphans.length})`);
      table(
        textOrphans.slice(0, args.top).map((q) => ({
          key: q.nodeId,
          type: q.type,
          canvas: `${q.wh ? q.wh.map((n) => n.toFixed(1)).join("x") : "-"} tex=${q.tex}`,
          dom: dOver.get(q.nodeId) ? `dom overlay is ${dOver.get(q.nodeId).kind}, not text` : "no dom overlay at all"
        })),
        [
          { key: "key", label: "node" },
          { key: "type", label: "type" },
          { key: "canvas", label: "text quad" },
          { key: "dom", label: "dom side" }
        ]
      );
    }
  }

  console.log("\nUNMATCHED, BY CLASS");
  const rows = [];
  for (const [side, records, isOverlay] of [
    ["canvas-only cmd", onlyCanvas, false],
    ["dom-only cmd", onlyDom, false],
    ["canvas-only overlay", overlayOnlyCanvas, true],
    ["dom-only overlay", overlayOnlyDom, true]
  ]) {
    for (const [clsName, bucket] of group(records, isOverlay)) {
      const top = [...bucket.entries()].sort((a, b) => b[1] - a[1]);
      rows.push({
        side,
        class: clsName,
        n: top.reduce((s, [, v]) => s + v, 0),
        registered: clsName === "other" ? "NO — investigate" : `yes (${clsName})`,
        top: top.slice(0, 5).map(([k, v]) => `${k}x${v}`).join(" ")
      });
    }
  }
  table(rows, [
    { key: "side", label: "side" },
    { key: "class", label: "class" },
    { key: "n", label: "n", align: "r" },
    { key: "registered", label: "pre-registered" },
    { key: "top", label: "top kinds" }
  ]);

  const summary = {
    recording: canvas.meta.recording,
    viewport: canvas.meta.viewport,
    canvasCommands: cCmds.size,
    domCommands: dCmds.size,
    matched: matched.length,
    matchRate: total > 0 ? Math.round((matched.length / total) * 1000) / 10 : null,
    geomCompared: matched.length - fitRecords.length,
    geomDiverged: geomBad.length,
    geomWorstPx: geomBad.length > 0 ? geomBad[0].delta : 0,
    aspectFitRecords: fitRecords.length,
    aspectFitDiverged: fitBad.length,
    textureDiverged: texBad.length,
    textureSkipped: texSkipped.length,
    blendDiverged: blendBad.length,
    alphaDiverged: alphaBad.length,
    clipDiverged: clipBad.length,
    clipScopesMatched: clipMatched,
    clipRectDiverged: clipRectBad.length,
    clipRectWorstPx: clipRectBad.length > 0 ? clipRectBad[0].delta : 0,
    orderDiverged: orderBad.length,
    canvasOnly: onlyCanvas.length,
    domOnly: onlyDom.length,
    overlayMatched: overlayBoth.length,
    overlayCanvasOnly: overlayOnlyCanvas.length,
    overlayDomOnly: overlayOnlyDom.length,
    textLabels: textShared,
    textFontAgree: fontAgree,
    textFamilyAgree: familyAgree,
    textScaleAgree: scaleAgree,
    textRulesAgree: tsAgree,
    textLinesAgree: linesAgree,
    // CLASS (f). Its counts separate in-canvas surfaces from ordinary commands on every row above.
    fxQuads: fxQuads.length,
    fxSurfaces: cFxSurfaces.length,
    fxSurfacesDrawn: cFxSurfaces.filter((o) => fxQuads.some((q) => q.nodeId === o.nodeId)).length,
    fxOrphanQuads: fxQuads.filter((q) => !dOver.has(q.nodeId)).length,
    // CLASS (g), on the same terms as the other draw-list totals.
    trailQuads: trailQuads.length,
    trailStrokes: cTrailStrokes.length,
    trailStrokesDrawn: cTrailStrokes.filter((o) => trailQuads.some((q) => q.nodeId === o.nodeId)).length,
    trailOrphanQuads: trailQuads.filter((q) => !dOver.has(q.nodeId)).length,
    // CLASS (h). `textLabelsDrawn` against `textOverlays` is the coverage the gate reads; a zero there is
    // otherwise invisible everywhere else.
    textQuads: textQuads.length,
    textOverlays: cTextOverlays.length,
    textLabelsDrawn: cTextOverlays.filter((o) => textQuads.some((q) => q.nodeId === o.nodeId)).length,
    textOrphanQuads: textQuads.filter((q) => !dOver.has(q.nodeId) || dOver.get(q.nodeId).kind !== "text").length,
    unregisteredUnmatched: rows.filter((r) => r.class === "other").reduce((s, r) => s + r.n, 0)
  };
  if (args.json) console.log("\nPAINT_DIFF " + JSON.stringify(summary));
  console.log("");
  return 0;
}

process.exitCode = main();
