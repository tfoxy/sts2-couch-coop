#!/usr/bin/env node
// OFFLINE TEXT CENSUS for M4 — what a per-label raster path would actually have to build, per screen.
//
// M4 moves text off the DOM overlay and into the stage canvas as ordinary textured quads. Before writing a
// rasterizer, three numbers decide its whole shape, and all three are answerable offline from the recorded wire —
// no browser, no GL, no live game. Same offline shape as `verify-canvas-drawlist.mjs`, whose replay + resolved
// walk this shares (`scripts/lib/mirror-probe.mjs`).
//
//   (1) HOW MANY DISTINCT RASTERS. A texture registry keyed by a digest of the raster descriptor shares one
//       upload across every label that draws the same pixels — and a combat screen's five identical "80" damage
//       numbers are one texture, not five. `labels / distinct` is that ratio, and it is what says whether the
//       registry is worth having.
//   (2) HOW OFTEN THEY CHANGE. A raster is only cheap if it survives; if a label's pixels change every delta then
//       per-label rasters are a treadmill and the design is wrong. Reported as digest changes per node over the
//       recording's own duration, so a 30-second combat and a 4-second reward screen compare.
//   (3) WHAT THE WIRE DOES NOT SAY. The producer streams a fixed box and no wrap result: `text.layout.lines` and
//       `text.richTextSpans` are on the wire and this counts how often they arrive non-empty. If the answer is
//       "never", then there is NO wrap oracle to match and the DOM's `white-space: pre-wrap` over the streamed box
//       IS the specification — which makes a greedy CSS-rule wrapper the correct thing to write, rather than a
//       reimplementation of Godot's `autowrap_mode`.
//
// THE DIGEST, and what is deliberately NOT in it. Everything that changes the label's PIXELS is in: the string,
// the face (family/weight/style), the size, the fill colour, the outline colour+size, the shadow, the horizontal
// alignment, the rich flag, and the box WIDTH (which is what a wrap depends on). Deliberately excluded, each for
// a reason the design turns on:
//   * the node's TINT and OPACITY — a fading label is the same pixels at a different quad colour, premultiplied
//     at draw time. Baking them would mint a texture per frame of every fade, which is the failure this avoids.
//   * the box HEIGHT and the VERTICAL alignment — both place the ink block, and placement is the quad's matrix.
//   * the node's transform/scale — the raster is at the label's own size and the matrix carries the rest.
// So this census reports the sharing an M4 registry can actually reach, not an optimistic bound.
//
// REFUSAL CANDIDATES are counted rather than assumed: the design refuses to raster a script it cannot break
// (CJK/Thai/Japanese have no spaces, so a greedy space-breaking wrapper would silently overflow instead of
// wrapping). A non-zero count here means the plain-text path needs a refusal arm before it can ship anywhere it
// would meet one; across the English recordings it should be 0, and saying that is the point.
//
// Usage:
//   node scripts/probe-text-census.mjs                      # the standard screen set
//   node scripts/probe-text-census.mjs perf5-map-open.ndjson
//   node scripts/probe-text-census.mjs --json               # machine-readable, for a gate
//   node scripts/probe-text-census.mjs --raster-hist        # R6 P6-D1: raster-size distribution + page sizing

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { benchDir, nodePaintsContent, printTable, replayRecording, walkResolved } from "./lib/mirror-probe.mjs";
import { requireReproHeader } from "./lib/repro-recording.mjs";

// The line pitch `.mirror-text` renders at, and the one `textLayout.LINE_PITCH_RATIO` uses. Restated here rather
// than imported because this script runs under bare Node with no TS pipeline.
const LINE_PITCH_RATIO = 1.1;

// The same six screen families `verify-canvas-drawlist.mjs` gates on — one screen family per paint mix, so the
// census and the oracle can be read against each other row for row.
const RECORDINGS = [
  "combat-modern-2026-08-06.ndjson",
  "audit-cardreward-open.ndjson",
  "deckview-40-openclose.ndjson",
  "perf5-map-open.ndjson",
  "audit-shop-open.ndjson",
  "probe-removal-used.ndjson"
];

/**
 * Scripts a greedy SPACE-breaking wrapper cannot break, which is the plain-text path's one refusal.
 *
 * CJK (incl. the Japanese kana blocks and the full-width forms) and Thai run words together and break on
 * character/dictionary rules instead. A wrapper that only breaks at spaces would not wrap them at all — it would
 * overflow the streamed box silently, which is worse than refusing and leaving the label on the DOM overlay.
 */
const UNBREAKABLE = /[ᄀ-ᇿ⺀-꓏ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯฀-๿]/;

/** `verify-canvas-drawlist.mjs`'s `oraclePaints` — the content gate plus the stroke and bar legs. */
function paints(node, ownOpacity) {
  if (nodePaintsContent(node, ownOpacity)) {
    return true;
  }
  if (ownOpacity <= 0.02) {
    return false;
  }
  if (node.linePoints != null && node.linePoints.length >= 4) {
    return true;
  }
  const range = node.range;
  const lr = node.localRect;
  return (
    range != null && lr != null && lr.width > 0 && lr.height > 0 && range.max > range.min && range.value > range.min
  );
}

/**
 * The raster descriptor, as one string. See the header for what is in it and what is deliberately not.
 *
 * Built from the PARSED node, so it reads exactly the fields `nodeStyles.textStyle` reads — including the
 * volatile-beats-stale outline rule, which is a real pixel input (the HP label's outline turns blue while the
 * player is blocking, and that is a different raster).
 */
function digestOf(node) {
  const t = node.text;
  const f = node.font;
  // `textStyle`'s own rule: the per-tick diagnostics outline wins over the stale top-level one.
  const outlineColor = t.outlineColorHtml ?? node.outline?.colorHtml ?? null;
  const outlineSize = t.outlineColorHtml != null && t.outlineSize > 0 ? t.outlineSize : (node.outline?.size ?? 0);
  const shadow = node.shadow ? `${node.shadow.offsetX},${node.shadow.offsetY},${node.shadow.colorHtml}` : "";
  return [
    t.text,
    f ? `${f.family}/${f.weight ?? ""}/${f.style ?? ""}` : "",
    t.fontSizePx ?? "",
    t.colorHtml ?? "",
    outlineColor ?? "",
    outlineSize,
    shadow,
    t.halign ?? "",
    node.richText ? "rich" : "plain",
    // The BOX WIDTH, because a wrap depends on it — two identical strings in differently-sized boxes are two
    // different rasters. The height is not here: it places the block, and placement is the quad's matrix.
    node.localRect ? Math.round(node.localRect.width) : ""
  ].join("");
}

/**
 * WHAT THE WIRE SAYS ABOUT WRAPPING — read from the RAW ndjson, not the parsed node.
 *
 * `sceneTree.normalizeText` keeps the two alignment fields out of `text.layout` and drops the rest, so
 * `layout.lines` and `richTextSpans` are only visible before parsing. That is exactly why they are worth
 * counting: a field the parser drops is a field no renderer on either backend has ever been able to honour.
 */
function scanRawWire(abs) {
  let textUpserts = 0;
  let withLines = 0;
  let withSpans = 0;
  let durationMs = 0;
  const recordingText = readFileSync(abs, "utf8");
  requireReproHeader(recordingText, abs);
  for (const line of recordingText.split("\n")) {
    if (line.length === 0) continue;
    let env;
    try {
      env = JSON.parse(line);
    } catch {
      continue;
    }
    if (env?.meta) {
      durationMs = Number(env.meta.durationMs) || 0;
      continue;
    }
    if (typeof env?.data !== "string") continue;
    let raw;
    try {
      raw = JSON.parse(env.data);
    } catch {
      continue;
    }
    for (const upsert of raw?.upserts ?? []) {
      const t = upsert?.text;
      if (!t || typeof t !== "object") continue;
      textUpserts++;
      if (Array.isArray(t.layout?.lines) && t.layout.lines.length > 0) withLines++;
      if (Array.isArray(t.richTextSpans) && t.richTextSpans.length > 0) withSpans++;
    }
  }
  return { textUpserts, withLines, withSpans, durationMs };
}

async function censusOne(name, abs) {
  const wire = scanRawWire(abs);

  // VOLATILITY, integrated over the replay: how often a text node's digest actually changed. Sampled per applied
  // delta rather than per build — a build the wire did not feed cannot have changed a label's pixels.
  const lastDigest = new Map();
  let digestChanges = 0;
  let firstSeen = 0;
  const { state, deltas, lastT } = await replayRecording(abs, (_delta, _t, live) => {
    for (const [id, node] of live.nodes) {
      if (node.text == null || !node.text.text) continue;
      const d = digestOf(node);
      const prev = lastDigest.get(id);
      if (prev === undefined) {
        firstSeen++;
      } else if (prev !== d) {
        digestChanges++;
      }
      lastDigest.set(id, d);
    }
  });

  // …and the FINAL STATE's on-screen census, which is what one frame of the M4 path would have to draw.
  const distinct = new Set();
  // R6 P6-D1 — the raster BOX per distinct digest, for `--raster-hist`. One entry per texture the registry would
  // hold, which is the population an atlas page has to fit (the `labels` count double-counts shared rasters).
  const rasterBoxes = new Map();
  let labels = 0;
  let rich = 0;
  let multiline = 0;
  let unbreakable = 0;
  let outlined = 0;
  let shadowed = 0;
  let noFont = 0;
  let inkPx = 0;
  const families = new Set();
  walkResolved(state, ({ node, hidden, ownOpacity }) => {
    if (hidden || node.text == null || !node.text.text) return;
    if (!paints(node, ownOpacity)) return;
    labels++;
    const digest = digestOf(node);
    distinct.add(digest);
    if (!rasterBoxes.has(digest)) {
      const bw = node.localRect ? Math.max(0, node.localRect.width) : 0;
      const bLines = node.text.text.split("\n").length;
      rasterBoxes.set(digest, { w: bw, h: (node.text.fontSizePx ?? 16) * LINE_PITCH_RATIO * bLines });
    }
    if (node.richText) rich++;
    if (node.text.text.includes("\n")) multiline++;
    if (UNBREAKABLE.test(node.text.text)) unbreakable++;
    // `textStyle`'s `hasOutline`, exactly: a colour AND a positive size, with the volatile size winning only when
    // the volatile colour did. A colour at size 0 paints nothing and must not inflate this.
    {
      const oc = node.text.outlineColorHtml ?? node.outline?.colorHtml ?? null;
      const os =
        node.text.outlineColorHtml != null && node.text.outlineSize > 0
          ? node.text.outlineSize
          : (node.outline?.size ?? 0);
      if (oc != null && os > 0) outlined++;
    }
    if (node.shadow) shadowed++;
    if (node.font) families.add(node.font.family);
    else noFont++;
    // A ROUGH raster area, and rough is enough for a sizing decision: the streamed box width by the line box
    // (1.1 x the font size, the pitch `.mirror-text` already renders at), per DISTINCT label — a shared raster is
    // uploaded once. Real ink is narrower than the box, so this is an upper bound and is labelled as one.
    const w = node.localRect ? Math.max(0, node.localRect.width) : 0;
    const lines = node.text.text.split("\n").length;
    inkPx += w * (node.text.fontSizePx ?? 16) * 1.1 * lines;
  });

  const seconds = wire.durationMs > 0 ? wire.durationMs / 1000 : lastT / 1000 || 1;
  return {
    name,
    labels,
    rich,
    richPct: labels > 0 ? Math.round((rich / labels) * 1000) / 10 : 0,
    distinct: distinct.size,
    sharing: distinct.size > 0 ? Math.round((labels / distinct.size) * 100) / 100 : 0,
    multiline,
    unbreakable,
    outlined,
    shadowed,
    noFont,
    families: [...families].sort(),
    // The upper bound above, at rasterScale 1 and 4 bytes a pixel, in MB.
    estMB: Math.round((inkPx * 4) / 1024 / 102.4) / 10,
    deltas,
    seconds: Math.round(seconds * 10) / 10,
    digestChanges,
    changesPer30s: seconds > 0 ? Math.round((digestChanges / seconds) * 30) : 0,
    firstSeen,
    wireTextUpserts: wire.textUpserts,
    wireWithLines: wire.withLines,
    wireWithSpans: wire.withSpans,
    rasterBoxes: [...rasterBoxes.values()]
  };
}


// ---------------------------------------------------------------------------------------------------------------
// R6 P6-D1 — `--raster-hist`: HOW BIG the label rasters are, which is the one number that decides the page size of
// a label ATLAS.
//
// The promotion criterion in `textSurfaces`' header is met (measured texture-slot flushes at +20/+45 per build
// against a +8 budget), so labels have to be packed onto shared pages. Packing needs a page DIMENSION, and picking
// one blind has two failure modes that pull opposite ways: too small and half the labels are oversize and fall
// back to their own textures (paying the binds the atlas exists to remove), too large and one screen's worth of
// text costs a page allocation many times bigger than the ink in it.
//
// So: the distribution of raster sizes per screen, at each raster scale the renderer can choose, plus what a shelf
// allocator would actually do with them at three candidate page dimensions.
//
// EVERYTHING HERE IS AN UPPER BOUND, and the bound is the streamed BOX rather than the ink inside it — the same
// approximation `est MB` above uses, and for the same reason (there is no 2D context offline, so there is no
// `measureText` and no real line breaking). Real rasters are narrower. An upper bound is the right side to be
// wrong on for a sizing decision: it can only over-provision.
const RASTER_SCALES = [1, 1.5, 2, 3];
const PAGE_CANDIDATES = [512, 1024, 2048];
const SIZE_BUCKETS = [32, 64, 128, 256, 512, 1024, 2048];
/** The gutter a page allocator leaves between rects — see the LINEAR/CLAMP argument in `atlasRepack`. */
const GUTTER = 1;
/** Shelf heights are quantized so a row of similar labels shares one shelf instead of minting a new one each. */
const SHELF_QUANTUM = 8;

/** Which `SIZE_BUCKETS` bucket a dimension falls in, as a label. */
function bucketOf(px) {
  for (const edge of SIZE_BUCKETS) {
    if (px <= edge) return `<=${edge}`;
  }
  return `>${SIZE_BUCKETS[SIZE_BUCKETS.length - 1]}`;
}

/**
 * Shelf next-fit with a bounded best-fit-by-height retry, over rects sorted TALLEST FIRST — the allocator the
 * label atlas would use, run offline so the page dimension is chosen against what it actually does rather than
 * against an area estimate. Answers pages used, oversize rects (which fall back to their own texture) and the
 * fraction of allocated page area that carries ink.
 */
function packShelves(rects, dim) {
  const sorted = [...rects].sort((a, b) => b.h - a.h);
  const pages = []; // { shelves: [{ y, height, used }], bottom }
  let oversize = 0;
  let live = 0;
  for (const rect of sorted) {
    const w = rect.w + GUTTER;
    const h = Math.ceil((rect.h + GUTTER) / SHELF_QUANTUM) * SHELF_QUANTUM;
    if (w > dim || h > dim) {
      oversize++;
      continue;
    }
    live += rect.w * rect.h;
    let placed = false;
    for (const page of pages) {
      // Best fit by height among shelves that still have width — a short label must not open a tall shelf.
      let best = null;
      for (const shelf of page.shelves) {
        if (shelf.height < h || shelf.used + w > dim) continue;
        if (best === null || shelf.height < best.height) best = shelf;
      }
      if (best) {
        best.used += w;
        placed = true;
        break;
      }
      if (page.bottom + h <= dim) {
        page.shelves.push({ height: h, used: w });
        page.bottom += h;
        placed = true;
        break;
      }
    }
    if (!placed) {
      pages.push({ shelves: [{ height: h, used: w }], bottom: h });
    }
  }
  const allocated = pages.length * dim * dim;
  return {
    pages: pages.length,
    oversize,
    liveFraction: allocated > 0 ? Math.round((live / allocated) * 1000) / 10 : 0
  };
}

function rasterHistogram(rows) {
  console.log(
    "\nR6 P6-D1 — LABEL RASTER SIZES, per DISTINCT digest (one texture each). Upper bound: the streamed box,\n" +
      "not the ink in it. `w` and `h` are texture device pixels at the given raster scale.\n"
  );
  for (const scale of RASTER_SCALES) {
    const buckets = new Map();
    let widest = 0;
    let tallest = 0;
    let bytes = 0;
    let count = 0;
    for (const row of rows) {
      for (const box of row.rasterBoxes) {
        const w = Math.ceil(box.w * scale) + 2;
        const h = Math.ceil(box.h * scale) + 2; // the registry's 1px ink margin, both sides
        count++;
        widest = Math.max(widest, w);
        tallest = Math.max(tallest, h);
        bytes += w * h * 4;
        const key = bucketOf(Math.max(w, h));
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
    }
    const order = [...SIZE_BUCKETS.map((e) => `<=${e}`), `>${SIZE_BUCKETS[SIZE_BUCKETS.length - 1]}`];
    const shown = order.filter((k) => buckets.has(k)).map((k) => `${k}: ${buckets.get(k)}`);
    console.log(
      `  scale ${scale}  n=${count}  longest side buckets  ${shown.join("  ")}\n` +
        `             widest ${widest}px  tallest ${tallest}px  total ${Math.round((bytes / 1024 / 1024) * 100) / 100} MB across all six screens`
    );
  }

  console.log("\nWhat a shelf allocator does with ONE SCREEN's labels, per candidate page dimension\n");
  const cols = [{ key: "name", label: "recording" }, { key: "scale", label: "scale", align: "r" }];
  for (const dim of PAGE_CANDIDATES) {
    cols.push({ key: `p${dim}`, label: `${dim}: pages/over/live%`, align: "r" });
  }
  const table = [];
  for (const row of rows) {
    for (const scale of RASTER_SCALES) {
      const rects = row.rasterBoxes.map((b) => ({
        w: Math.ceil(b.w * scale) + 2,
        h: Math.ceil(b.h * scale) + 2
      }));
      const entry = { name: row.name, scale };
      for (const dim of PAGE_CANDIDATES) {
        const r = packShelves(rects, dim);
        entry[`p${dim}`] = `${r.pages}/${r.oversize}/${r.liveFraction}%`;
      }
      table.push(entry);
    }
  }
  printTable(cols, table);
  console.log(
    "\n  pages = allocations a screen's whole label set needs; over = rects too big for the page (they keep their\n" +
      "  own texture and their own bind); live% = the fraction of allocated page area carrying ink.\n" +
      "\n  READ THE SCALE ROWS BY WHAT A DEVICE ACTUALLY PICKS. `rasterScaleFor` multiplies the node's drawn scale\n" +
      "  by DPR and quantizes — and on this stage the stage transform DIVIDES by DPR, so the two largely cancel: a\n" +
      "  phone sits at 1-1.5, not at 3. The scale-3 rows are the pathological arm (a view-scale enlarged option),\n" +
      "  not the operating point.\n"
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const wantRasterHist = argv.includes("--raster-hist");
  const named = argv.filter((a) => !a.startsWith("--"));
  const wanted = named.length > 0 ? named : RECORDINGS;
  const dir = benchDir();

  const rows = [];
  let missing = 0;
  for (const name of wanted) {
    const abs = `${dir}/${name.endsWith(".ndjson") ? name : `${name}.ndjson`}`;
    if (!existsSync(abs)) {
      console.error(`missing recording: ${abs}`);
      missing++;
      continue;
    }
    rows.push(await censusOne(basename(abs, ".ndjson"), abs));
  }
  if (rows.length === 0) {
    console.error("no recordings found — is .sts2/bench/ populated in this checkout?");
    process.exitCode = 1;
    return;
  }
  if (missing > 0) {
    console.error(`${missing} requested/default recording(s) were missing`);
    process.exitCode = 1;
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log("\nOn-screen text at the final state — what one M4 frame would have to draw\n");
  printTable(
    [
      { key: "name", label: "recording" },
      { key: "labels", label: "labels", align: "r" },
      { key: "rich", label: "rich", align: "r" },
      { key: "richPct", label: "rich%", align: "r" },
      { key: "distinct", label: "distinct", align: "r" },
      { key: "share", label: "share", align: "r" },
      { key: "multiline", label: "multi", align: "r" },
      { key: "outlined", label: "outl", align: "r" },
      { key: "shadowed", label: "shad", align: "r" },
      { key: "noFont", label: "noFont", align: "r" },
      { key: "estMB", label: "est MB", align: "r" }
    ],
    rows.map((r) => ({ ...r, share: `${r.sharing}x` }))
  );
  console.log(
    "\n  distinct = labels sharing one raster under the M4 digest (tint/opacity/height/valign excluded — see the\n" +
      "  header). est MB is an UPPER bound at rasterScale 1: the streamed box, not the ink inside it.\n" +
      "\n  READ `share` WITH THE VOLATILITY TABLE, NEVER ALONE. It is the sharing available in ONE FRAME between\n" +
      "  different nodes, and it is small — a screen's labels mostly say different things. The registry's real\n" +
      "  argument is the next table: the same labels are re-drawn on EVERY build while their pixels change a\n" +
      "  handful of times per 30 seconds, so a keyed raster is reused across builds hundreds of times over."
  );

  console.log("\nVolatility — a raster is only cheap if it survives\n");
  printTable(
    [
      { key: "name", label: "recording" },
      { key: "deltas", label: "deltas", align: "r" },
      { key: "seconds", label: "secs", align: "r" },
      { key: "firstSeen", label: "labels first seen", align: "r" },
      { key: "digestChanges", label: "digest changes", align: "r" },
      { key: "changesPer30s", label: "per 30s", align: "r" }
    ],
    rows
  );

  console.log("\nWhat the wire says about WRAPPING (raw upserts, pre-parse)\n");
  printTable(
    [
      { key: "name", label: "recording" },
      { key: "wireTextUpserts", label: "text upserts", align: "r" },
      { key: "wireWithLines", label: "layout.lines non-empty", align: "r" },
      { key: "wireWithSpans", label: "richTextSpans non-empty", align: "r" }
    ],
    rows
  );
  const anyLines = rows.some((r) => r.wireWithLines > 0);
  const anySpans = rows.some((r) => r.wireWithSpans > 0);
  console.log(
    anyLines
      ? "\n  layout.lines DOES arrive — there is a wrap oracle on the wire and M4 must match it, not CSS."
      : "\n  layout.lines never arrives. There is NO wrap oracle on the wire, so the DOM's `white-space: pre-wrap`\n" +
          "  over the streamed box IS the specification a canvas wrapper has to reproduce."
  );
  if (anySpans) {
    console.log("  richTextSpans DOES arrive — a span-accurate rich path is possible from the wire.");
  }

  const refusals = rows.reduce((n, r) => n + r.unbreakable, 0);
  console.log(
    refusals === 0
      ? "\n  Refusal candidates (unbreakable non-Latin): 0 across this set — the greedy space-breaking wrapper is\n" +
          "  sufficient for every label recorded here. The refusal arm still ships; nothing here exercises it."
      : `\n  Refusal candidates (unbreakable non-Latin): ${refusals} — the plain-text path MUST refuse these.`
  );

  const fams = new Set(rows.flatMap((r) => r.families));
  console.log(`\n  Faces across the set: ${[...fams].sort().join(", ") || "(none streamed)"}\n`);

  if (wantRasterHist) {
    rasterHistogram(rows);
  }
}

await main();
