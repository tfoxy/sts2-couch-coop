#!/usr/bin/env node
// probe-glyph-wrap.mjs — DOES THE GLYPH PATH'S SHAPER DISAGREE WITH `measureText` ABOUT WHERE LINES BREAK?
//
// THE QUESTION. The current text layout in `canvas/textLayout.ts` breaks lines against a `MeasureText` seam that
// `textSurfaces.measureFor` fills with the 2D context's `measureText`; the current glyph renderer then draws those
// lines through hb-gpu, which positions every glyph with HarfBuzz's own advances. Two measurers, one layout.
// Where they disagree by enough to move a break, a glyph line can be wider than the box it was fitted to. This
// probe checks that current implementation contract directly.
//
// WHAT IT COMPARES, and both halves are the REAL arithmetic rather than a restatement:
//
//   measureText — a real Chromium, the game's real `.ttf` faces registered as `FontFace`s exactly as
//                 `fonts.ensureFontFace` registers them, `ctx.font = spec.cssFont`. Byte for byte what
//                 `measureFor` hands `layoutText` today.
//   the shaper  — `HbGpuFont.shape` out of hb-gpu's own wasm, summed the way `glyph-pass-hbgpu.fillRun` sums it:
//                 `xAdvance` over EVERY glyph (the inkless ones move the pen too), times `fontPx / upem`.
//                 That sum IS `fillRun`'s final pen, i.e. the width the run actually occupies on screen.
//
// THREE LEVELS, weakest to strongest, because "the widths differ" and "a word moved" are very different claims:
//
//   (1) per-RUN width diff, over every distinct (string, font) the corpus draws.
//   (2) per-DECISION: for every `(substring, contentW)` pair the greedy breaker COULD test — a superset of the
//       ones it does test — do the two answer `fits` the same way? A zero here is stronger than a zero from
//       replaying the breaker, because it does not depend on which candidates the breaker happened to reach.
//   (3) end to end: the real `layoutText`, run twice per spec, line breaks diffed. Plus the thing the scope line
//       actually names — of the lines `measureText` FITTED into the box, how many does the shaper overflow, and
//       by how much.
//
// ---------------------------------------------------------------------------------------------------------------
// `--hinting=full` IS THE POSITIVE CONTROL, AND IT IS NOT OPTIONAL READING.
//
// Chrome's `measureText` returns FRACTIONAL advances when subpixel text positioning is on and WHOLE-PIXEL ones
// when it is not — and headless Chromium with no fontconfig defaults to the latter. That single switch moves this
// probe's answer by two orders of magnitude, so a run that did not say which regime it measured would be
// unreadable:
//
//   --hinting=none (DEFAULT) — fractional advances. This is what a real desktop browser does, verified against
//                  the live page's own context (Chrome 152, Ubuntu, DPR 1.25) agreeing with this probe's headless
//                  numbers to the last bit on `kreon_regular`.
//   --hinting=full — whole-pixel advances. Headless Chromium's own default, and what a Linux desktop configured
//                  for full hinting without subpixel positioning would do.
//
// It also makes this probe's zero falsifiable, which a measurement that can only report zero is not: under
// `full` the same corpus produces 25 differing decisions and 5 moved breaks. The mechanism works; the default
// regime simply has nothing for it to find.
//
// Usage:
//   node scripts/probe-glyph-wrap.mjs                      # the standard screen set, real-browser regime
//   node scripts/probe-glyph-wrap.mjs --all                # every recording in the bench dir
//   node scripts/probe-glyph-wrap.mjs --hinting=full       # the positive control
//   node scripts/probe-glyph-wrap.mjs --json               # machine-readable
//   node scripts/probe-glyph-wrap.mjs --fonts <dir>        # a different extracted fonts/ directory

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  benchDir,
  DEFAULT_RECORDINGS,
  loadSceneTree,
  REPO_ROOT,
  replayRecording,
  resolveRecordings
} from "./lib/mirror-probe.mjs";
import { RECOVERED_RESOURCE_ROOT } from "./lib/repo-layout.mjs";

// `serve-res-root.mjs`'s own default, one directory down: the extracted resource root is where the real faces
// are, and the probe is worthless with any other bytes — `measureText` and the shaper must be handed the SAME
// file or the comparison measures the file difference instead.
const DEFAULT_FONT_DIR = resolve(RECOVERED_RESOURCE_ROOT, "fonts");
const GSW_HB_GPU = resolve(REPO_ROOT, "../godot-scene-web/packages/hb-gpu");

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const all = argv.includes("--all");
const hinting = argv.find((a) => a.startsWith("--hinting="))?.slice("--hinting=".length) ?? "none";
const fontDir = resolve(argv.includes("--fonts") ? argv[argv.indexOf("--fonts") + 1] : DEFAULT_FONT_DIR);
if (hinting !== "none" && hinting !== "full") {
  console.error(`--hinting must be "none" or "full" (got ${JSON.stringify(hinting)})`);
  process.exit(2);
}
if (!existsSync(fontDir)) {
  console.error(`no font directory at ${fontDir} — pass --fonts <resource-root>/fonts`);
  process.exit(2);
}

const say = (...parts) => {
  if (!json) console.log(...parts);
};

// The hooks that map `@/…` and stub gsw/vue. MUST run before any frontend TS import below.
//
// AND `console.info` IS MUZZLED ACROSS THEM UNDER `--json`. `textLayout` reaches `@/mirror/nodeStyles`, which
// reaches `@/render/quality`, which prints `[render] quality: …` on STDOUT at import time — a banner that is
// useful in a terminal and is a syntax error in front of a JSON document.
const info = console.info;
if (json) console.info = () => {};
await loadSceneTree();
const { breakOpportunities, layoutText, resolveTextSpec } = await import(
  pathToFileURL(resolve(REPO_ROOT, "frontend/src/mirror/canvas/textLayout.ts")).href
);
const { resolveTextScaleDecls } = await import(
  pathToFileURL(resolve(REPO_ROOT, "frontend/src/mirror/textScaleClasses.ts")).href
);
const { resolveSceneInfo } = await import(pathToFileURL(resolve(REPO_ROOT, "frontend/src/mirror/canvas/hitTest.ts")).href);
const { parseSimpleRich } = await import(pathToFileURL(resolve(REPO_ROOT, "frontend/src/mirror/canvas/richSimple.ts")).href);
// THE REAL TAG TABLE, imported rather than left to the stub. `richSimple` reaches `DEFAULT_BBCODE_TAGS` through
// `@spirectl/presentation/render`, which the probe hook stubs to `{}` — and with an empty table every `[gold]` in
// the corpus refuses, which would silently drop most card text out of the population being measured.
const { DEFAULT_BBCODE_TAGS } = await import(
  pathToFileURL(resolve(REPO_ROOT, "../spirectl/presentation/web/src/render/bbcodeTags.ts")).href
);

console.info = info;

const trimEnd = (s) => s.replace(/[ \t]+$/, "");
const collapse = (s) => s.replace(/\s+/g, " ").trim();

/** `<style> <weight> <px>px "<family>"` — the shorthand `resolveTextSpec` builds, taken apart again. */
function parseCssFont(cssFont) {
  const m = /^(?:(italic|oblique)\s+)?(?:(\d{3,4}|bold|normal)\s+)?([\d.]+)px\s+"(.+)"$/.exec(cssFont);
  if (!m) throw new Error(`unparsed cssFont ${cssFont}`);
  return { style: m[1] ?? "normal", weight: m[2] ?? "400", fontPx: Number(m[3]), family: m[4] };
}

/**
 * Every substring the breaker could ask a measurer about, for one spec.
 *
 * A SUPERSET OF WHAT IT ACTUALLY ASKS, on purpose. `breakLine` walks `(start, end)` pairs drawn from the break
 * opportunities, and WHICH pairs it reaches depends on the measurer — so measuring only the ones one measurer
 * reached would compare two different question sets. Every pair is cheap (a label is a handful of words) and the
 * superset makes the two runs answerable from one table.
 */
function candidateStrings(spec) {
  const out = new Set();
  const source = spec.whiteSpace === "normal" ? collapse(spec.text) : spec.text;
  for (const hard of source.split("\n")) {
    out.add(trimEnd(hard));
    if (spec.whiteSpace === "pre") continue;
    const points = breakOpportunities(hard);
    for (const start of [0, ...points]) {
      for (const end of [...points, hard.length]) {
        if (end > start) out.add(trimEnd(hard.slice(start, end)));
      }
    }
  }
  out.delete("");
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// 1. the corpus — every label the canvas text path would lay out, over every state the replay passes through
// ---------------------------------------------------------------------------------------------------------

async function collectCorpus(recordings) {
  const specs = new Map();
  const strings = new Map();
  let observations = 0;
  let withStreamedWrap = 0;

  for (const abs of recordings) {
    const screen = basename(abs, ".ndjson");
    await replayRecording(abs, (_delta, _t, live) => {
      for (const [id, node] of live.nodes) {
        if (node.text == null || !node.text.text) continue;
        const scene = resolveSceneInfo(id, live.nodes);
        const decls = resolveTextScaleDecls(scene?.file ?? null, scene?.relPath ?? null);
        let spec = resolveTextSpec(node, decls);
        if (spec === null) continue;
        // Re-resolve through the current rich-text normalizer, matching the renderer's production path.
        if (spec.refusal === "rich") {
          const parsed = parseSimpleRich(spec.text, { tags: DEFAULT_BBCODE_TAGS });
          if (!parsed.ok) continue;
          const plain = resolveTextSpec(
            { ...node, richText: false, text: { ...node.text, text: parsed.value.text } },
            decls
          );
          if (plain === null || plain.refusal !== null) continue;
          spec = parsed.value.align === null ? plain : { ...plain, align: parsed.value.align };
        }
        if (spec.refusal !== null) continue;
        observations++;
        // A label whose wrap the producer streamed REPLAYS those breaks and runs no breaker at all, so the two
        // measurers cannot disagree about it. Counted rather than dropped: a corpus that was all replay would
        // make this probe's zero vacuous, and today the count is 0.
        if (spec.godotLines !== null) withStreamedWrap++;
        const key = [spec.text, spec.cssFont, Math.round(spec.contentW * 1000), spec.whiteSpace, spec.align].join(" ");
        let entry = specs.get(key);
        if (entry === undefined) {
          entry = {
            text: spec.text,
            cssFont: spec.cssFont,
            fontPx: spec.fontPx,
            contentW: spec.contentW,
            whiteSpace: spec.whiteSpace,
            align: spec.align,
            screens: new Set(),
            hits: 0
          };
          specs.set(key, entry);
          let set = strings.get(spec.cssFont);
          if (set === undefined) {
            set = new Set();
            strings.set(spec.cssFont, set);
          }
          for (const s of candidateStrings(spec)) set.add(s);
        }
        entry.hits++;
        entry.screens.add(screen);
      }
    });
    say(`  replayed ${screen} — ${specs.size} distinct specs so far`);
  }
  return {
    specs: [...specs.values()],
    fonts: [...strings.entries()].map(([cssFont, set]) => ({ cssFont, strings: [...set] })),
    observations,
    withStreamedWrap
  };
}

// ---------------------------------------------------------------------------------------------------------
// 2. the shaper's widths — hb-gpu's own wasm, `fillRun`'s arithmetic
// ---------------------------------------------------------------------------------------------------------

async function shaperWidths(fonts) {
  const { createHbGpu } = await import(pathToFileURL(resolve(GSW_HB_GPU, "src/index.ts")).href);
  const factory = (await import(pathToFileURL(resolve(GSW_HB_GPU, "vendor/hb-gpu.mjs")).href)).default;
  const module = await createHbGpu(factory, new Uint8Array(readFileSync(resolve(GSW_HB_GPU, "vendor/hb-gpu.wasm"))), {
    onError: (f) => console.error(`hb-gpu: ${f.reason}: ${f.message}`)
  });

  const open = new Map();
  const fontFor = (family) => {
    let font = open.get(family);
    if (font === undefined) {
      const path = resolve(fontDir, `${family}.ttf`);
      if (!existsSync(path)) throw new Error(`no face file at ${path} — the corpus asks for family "${family}"`);
      font = module.createFont(new Uint8Array(readFileSync(path)));
      if (!font) throw new Error(`hb-gpu refused ${path}`);
      open.set(family, font);
    }
    return font;
  };

  const out = {};
  let shaped = 0;
  let notdef = 0;
  const t0 = performance.now();
  for (const entry of fonts) {
    const { fontPx, family } = parseCssFont(entry.cssFont);
    const font = fontFor(family);
    // FONT UNITS TO DESIGN PX, `fillRun`'s own conversion: `run.pixelsPerEm / face.upem`.
    const scale = fontPx / font.upem;
    const widths = {};
    for (const s of entry.strings) {
      const run = font.shape(s);
      if (run === null) {
        widths[s] = null;
        continue;
      }
      let pen = 0;
      // EVERY GLYPH, INCLUDING THE INKLESS ONES — `fillRun` advances the pen for a space too, and a sum that
      // skipped them would report a width no run is ever drawn at.
      for (const g of run) {
        pen += g.xAdvance;
        if (g.glyphId === 0) notdef++;
      }
      widths[s] = pen * scale;
      shaped++;
    }
    out[entry.cssFont] = { upem: font.upem, widths };
  }
  return { widths: out, shaped, notdef, ms: performance.now() - t0, fontFor };
}

/**
 * THE SHIPPED COVERAGE GATE, run against the REAL faces — `glyphPass.blockFor`'s rule, restated over the corpus.
 *
 * It exists because the vitest spec for that gate (`canvasGlyphCoverage.spec.ts`) necessarily stubs hb-gpu and
 * transcribes `kreon_regular`'s missing codepoints as data. That proves the RULE; this proves the DATA, against
 * the actual `.ttf` through the actual wasm. Both halves are cheap and neither is sufficient alone.
 *
 * It also cross-checks the cheap cmap lookup the gate uses against the SHAPED ground truth, which is the thing
 * the gate is a proxy for: a disagreement here means the gate is refusing (or admitting) a label for a reason
 * shaping does not share, and the two must be reported apart rather than averaged.
 */
function coverageAudit(corpus, fontFor) {
  let refusedSpecs = 0;
  let shapeNotdefSpecs = 0;
  let disagreements = 0;
  let codepoints = 0;
  const missing = new Set();
  const examples = [];
  for (const spec of corpus.specs) {
    const font = fontFor(parseCssFont(spec.cssFont).family);
    let gateRefuses = false;
    let shapeNotdef = false;
    // PER LINE, because `blockFor` walks `layout.lines` and a "\n" never reaches the shaper — counting it would
    // report every multi-line label in the game as uncovered.
    for (const line of spec.text.split("\n")) {
      for (const ch of line) {
        codepoints++;
        if (font.glyphFor(ch.codePointAt(0)) === 0) {
          gateRefuses = true;
          missing.add(ch);
        }
      }
      for (const g of font.shape(line)) if (g.glyphId === 0) shapeNotdef = true;
    }
    if (gateRefuses) {
      refusedSpecs++;
      if (examples.length < 5) examples.push({ cssFont: spec.cssFont, text: spec.text.slice(0, 40), hits: spec.hits });
    }
    if (shapeNotdef) shapeNotdefSpecs++;
    if (gateRefuses !== shapeNotdef) disagreements++;
  }
  return { refusedSpecs, shapeNotdefSpecs, disagreements, codepoints, missing: [...missing].join(""), examples };
}

// ---------------------------------------------------------------------------------------------------------
// 3. `measureText`'s widths — a real browser, the real faces
// ---------------------------------------------------------------------------------------------------------

async function measuredWidths(fonts) {
  const { chromium } = await import(pathToFileURL(resolve(REPO_ROOT, "frontend/node_modules/playwright/index.mjs")).href);

  // One FontFace per (family, weight, style) the corpus asks for — which reproduces `fonts.ensureFontFace`'s
  // `@font-face` for this corpus, where every family resolves to exactly one file.
  const wanted = new Map();
  for (const entry of fonts) {
    const { family, weight, style } = parseCssFont(entry.cssFont);
    wanted.set(`${family}|${weight}|${style}`, { family, weight, style });
  }
  const faces = [...wanted.values()].map((f) => ({
    ...f,
    base64: readFileSync(resolve(fontDir, `${f.family}.ttf`)).toString("base64")
  }));

  // See the header: this flag, and nothing else, decides whether the answer is "0.04 px" or "1.7 px".
  const browser = await chromium.launch({ args: [`--font-render-hinting=${hinting}`] });
  const page = await browser.newPage();
  await page.goto("about:blank");
  const result = await page.evaluate(
    async ({ faces, fonts }) => {
      const decode = (b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
      };
      for (const f of faces) {
        const face = new FontFace(f.family, decode(f.base64), { weight: f.weight, style: f.style });
        await face.load();
        document.fonts.add(face);
      }
      const ctx = document.createElement("canvas").getContext("2d");
      const out = {};
      let n = 0;
      const t0 = performance.now();
      for (const entry of fonts) {
        const widths = {};
        for (const s of entry.strings) {
          // RE-ASSIGNED PER STRING, like `measureFor` does: the shorthand is the whole of what selects the face.
          ctx.font = entry.cssFont;
          widths[s] = ctx.measureText(s).width;
          n++;
        }
        out[entry.cssFont] = widths;
      }
      return { widths: out, measured: n, ms: performance.now() - t0 };
    },
    { faces, fonts }
  );
  const version = browser.version();
  await browser.close();
  return { ...result, version };
}

// ---------------------------------------------------------------------------------------------------------
// 4. the comparison
// ---------------------------------------------------------------------------------------------------------

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

function compare(corpus, shaper, measured) {
  // (1) per-run width diff
  const runs = [];
  for (const entry of corpus.fonts) {
    const s = shaper[entry.cssFont].widths;
    const m = measured[entry.cssFont];
    for (const str of entry.strings) {
      if (s[str] == null || m[str] == null) continue;
      runs.push({ cssFont: entry.cssFont, text: str, dom: m[str], hb: s[str], d: s[str] - m[str] });
    }
  }
  const abs = runs.map((r) => Math.abs(r.d)).sort((a, b) => a - b);

  // (2) per-decision
  let decisions = 0;
  const decisionFlips = [];
  const margins = [];
  let wrappable = 0;
  for (const spec of corpus.specs) {
    if (spec.whiteSpace === "pre" || spec.contentW <= 0) continue;
    wrappable++;
    const m = measured[spec.cssFont];
    const s = shaper[spec.cssFont].widths;
    const source = spec.whiteSpace === "normal" ? collapse(spec.text) : spec.text;
    for (const hard of source.split("\n")) {
      const points = breakOpportunities(hard);
      for (const start of [0, ...points]) {
        for (const end of [...points, hard.length]) {
          if (end <= start) continue;
          const str = trimEnd(hard.slice(start, end));
          const dom = m[str];
          const hb = s[str];
          if (dom == null || hb == null) continue;
          decisions++;
          // The perturbation that would flip THIS decision: how far the measured width sits from the box edge.
          margins.push(Math.abs(spec.contentW - dom));
          if (dom <= spec.contentW !== hb <= spec.contentW) {
            decisionFlips.push({ cssFont: spec.cssFont, text: str, dom, hb, contentW: spec.contentW });
          }
        }
      }
    }
  }
  margins.sort((a, b) => a - b);

  // (3) end to end
  const layoutFor = (spec, table) =>
    layoutText(
      {
        ...spec,
        color: "#fff",
        outlinePx: 0,
        outlineColor: null,
        shadow: null,
        blockAlign: "start",
        blockAlignY: "start",
        boxH: 100,
        pitchPx: spec.fontPx * 1.1,
        paragraphGapPx: 0,
        blockScale: 1,
        godotLines: null,
        refusal: null
      },
      (text) => table[text] ?? 0
    );

  let sameBreaks = 0;
  let wrappedSpecs = 0;
  let wrappedHits = 0;
  let movedHits = 0;
  const moved = [];
  let fittedLines = 0;
  let overflowed = 0;
  let worstOverflow = 0;
  let worstOverflowRow = null;
  for (const spec of corpus.specs) {
    const a = layoutFor(spec, measured[spec.cssFont]);
    const b = layoutFor(spec, shaper[spec.cssFont].widths);
    if (a.wrapped) {
      wrappedSpecs++;
      wrappedHits += spec.hits;
    }
    const ta = a.lines.map((l) => l.text);
    const tb = b.lines.map((l) => l.text);
    if (ta.length === tb.length && ta.every((t, i) => t === tb[i])) {
      sameBreaks++;
    } else {
      movedHits += spec.hits;
      moved.push({ cssFont: spec.cssFont, contentW: spec.contentW, hits: spec.hits, dom: ta, hb: tb });
    }
    // THE SCOPE LINE'S OWN FAILURE, in pixels: a line `measureText` FITTED, re-measured with the shaper that
    // draws it. Lines `measureText` already overflows are not the shaper's doing and are excluded.
    if (spec.contentW <= 0) continue;
    for (const line of a.lines) {
      const t = trimEnd(line.text);
      const dom = measured[spec.cssFont][t];
      const hb = shaper[spec.cssFont].widths[t];
      if (dom == null || hb == null || dom > spec.contentW) continue;
      fittedLines++;
      const over = hb - spec.contentW;
      if (over > 0) {
        overflowed++;
        if (over > worstOverflow) {
          worstOverflow = over;
          worstOverflowRow = { cssFont: spec.cssFont, text: t, contentW: spec.contentW, dom, hb };
        }
      }
    }
  }

  return {
    runs: {
      total: runs.length,
      exact: abs.filter((x) => x === 0).length,
      under001: abs.filter((x) => x > 0 && x < 0.01).length,
      under01: abs.filter((x) => x >= 0.01 && x < 0.1).length,
      under1: abs.filter((x) => x >= 0.1 && x < 1).length,
      under5: abs.filter((x) => x >= 1 && x < 5).length,
      over5: abs.filter((x) => x >= 5).length,
      median: quantile(abs, 0.5),
      p90: quantile(abs, 0.9),
      p99: quantile(abs, 0.99),
      max: abs.at(-1) ?? 0,
      worst: [...runs].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 8)
    },
    decisions: {
      total: decisions,
      wrappableSpecs: wrappable,
      flips: decisionFlips.length,
      examples: decisionFlips.slice(0, 10),
      minMargin: margins[0] ?? 0,
      p1Margin: quantile(margins, 0.01),
      p10Margin: quantile(margins, 0.1),
      medianMargin: quantile(margins, 0.5)
    },
    layouts: {
      specs: corpus.specs.length,
      observations: corpus.observations,
      wrappedSpecs,
      wrappedHits,
      sameBreaks,
      moved: moved.length,
      movedHits,
      examples: moved.slice(0, 10)
    },
    overflow: { fittedLines, overflowed, worstOverflow, worstOverflowRow }
  };
}

// ---------------------------------------------------------------------------------------------------------

const recordings = resolveRecordings(
  all ? readdirSync(benchDir()).filter((f) => f.endsWith(".ndjson")).sort() : DEFAULT_RECORDINGS
);
say(`corpus (${recordings.length} recordings)`);
const corpus = await collectCorpus(recordings);
const shaper = await shaperWidths(corpus.fonts);
const measured = await measuredWidths(corpus.fonts);
const report = compare(corpus, shaper.widths, measured.widths);
const coverage = coverageAudit(corpus, shaper.fontFor);

if (json) {
  console.log(
    JSON.stringify(
      {
        hinting,
        browser: measured.version,
        recordings: recordings.map((r) => basename(r)),
        corpus: {
          specs: corpus.specs.length,
          fonts: corpus.fonts.length,
          strings: shaper.shaped,
          observations: corpus.observations,
          withStreamedWrap: corpus.withStreamedWrap,
          notdefGlyphs: shaper.notdef
        },
        cost: { shapeMs: shaper.ms, measureMs: measured.ms, strings: shaper.shaped },
        coverage,
        ...report
      },
      null,
      2
    )
  );
  process.exit(0);
}

const r = report.runs;
const pc = (n, total) => `${((100 * n) / total).toFixed(2)}%`;
console.log("");
console.log(`browser ${measured.version}, --font-render-hinting=${hinting}`);
console.log(
  `corpus: ${report.layouts.specs} distinct specs, ${corpus.fonts.length} font shorthands, ${shaper.shaped} distinct runs, ` +
    `${corpus.observations} label observations, ${corpus.withStreamedWrap} with a streamed wrap`
);
console.log(`cost: shape ${(shaper.ms / shaper.shaped).toFixed(4)} ms/run, measureText ${(measured.ms / measured.measured).toFixed(4)} ms/run`);
console.log("");
console.log(`(1) RUN-WIDTH DIFF |shaper - measureText|, ${r.total} distinct runs`);
for (const [label, n] of [
  ["exact (== 0)", r.exact],
  ["< 0.01 px", r.under001],
  ["0.01-0.1 px", r.under01],
  ["0.1-1 px", r.under1],
  ["1-5 px", r.under5],
  [">= 5 px", r.over5]
]) {
  console.log(`      ${label.padEnd(14)} ${String(n).padStart(6)}   ${pc(n, r.total)}`);
}
console.log(`      median ${r.median.toFixed(6)}   p90 ${r.p90.toFixed(6)}   p99 ${r.p99.toFixed(6)}   max ${r.max.toFixed(4)}`);
for (const w of r.worst.slice(0, 5)) {
  console.log(
    `        ${(w.d >= 0 ? "+" : "") + w.d.toFixed(4)} px  dom=${w.dom.toFixed(3)} hb=${w.hb.toFixed(3)}  ${w.cssFont}  ` +
      `${JSON.stringify(w.text.length > 40 ? `${w.text.slice(0, 40)}…` : w.text)}`
  );
}
const d = report.decisions;
console.log("");
console.log(`(2) PER-DECISION "does this fit in contentW", ${d.total} tests over ${d.wrappableSpecs} wrappable specs`);
console.log(`      answered DIFFERENTLY by the two measurers: ${d.flips}   ${pc(d.flips, d.total)}`);
console.log(
  `      margin |contentW - measureText(s)|: min ${d.minMargin.toFixed(4)}  p1 ${d.p1Margin.toFixed(3)}  ` +
    `p10 ${d.p10Margin.toFixed(3)}  median ${d.medianMargin.toFixed(2)}`
);
for (const f of d.examples) {
  console.log(`        W=${f.contentW.toFixed(3)} dom=${f.dom.toFixed(3)} hb=${f.hb.toFixed(3)}  ${f.cssFont}  ${JSON.stringify(f.text)}`);
}
const l = report.layouts;
console.log("");
console.log(`(3) END TO END — the real layoutText, twice per spec`);
console.log(`      specs the greedy breaker WRAPPED : ${l.wrappedSpecs}  (${l.wrappedHits} observations)`);
console.log(`      identical line breaks            : ${l.sameBreaks} / ${l.specs}`);
console.log(`      MOVED line breaks                : ${l.moved}  (${l.movedHits} observations)`);
for (const f of l.examples) {
  console.log(`        contentW=${f.contentW.toFixed(2)} ${f.cssFont} hits=${f.hits}`);
  console.log(`          measureText: ${JSON.stringify(f.dom)}`);
  console.log(`          shaper     : ${JSON.stringify(f.hb)}`);
}
const o = report.overflow;
console.log("");
console.log(`      THE SCOPE LINE'S OWN FAILURE — lines measureText fitted, re-measured with the shaper that draws them`);
console.log(`      lines measureText FITTED into the box : ${o.fittedLines}`);
console.log(`      of those, the shaper OVERFLOWS        : ${o.overflowed}   worst ${o.worstOverflow.toFixed(6)} px`);
if (o.worstOverflowRow) {
  console.log(
    `        W=${o.worstOverflowRow.contentW} dom=${o.worstOverflowRow.dom.toFixed(3)} hb=${o.worstOverflowRow.hb.toFixed(3)}  ` +
      `${o.worstOverflowRow.cssFont}  ${JSON.stringify(o.worstOverflowRow.text)}`
  );
}
console.log("");
console.log("FACE COVERAGE — glyphPass.blockFor's shipped gate, re-run here against the REAL faces");
console.log(`      codepoints checked                          : ${coverage.codepoints}`);
console.log(`      specs the coverage gate REFUSES             : ${coverage.refusedSpecs} / ${report.layouts.specs}`);
console.log(`      specs that actually SHAPE to a .notdef      : ${coverage.shapeNotdefSpecs}  (${shaper.notdef} glyphs)`);
console.log(`      gate/shaping disagreements (must be 0)      : ${coverage.disagreements}`);
console.log(`      characters no streamed face carries         : ${JSON.stringify(coverage.missing)}`);
for (const e of coverage.examples) {
  console.log(`        ${e.cssFont}  ${JSON.stringify(e.text)}  ${e.hits} observations`);
}
