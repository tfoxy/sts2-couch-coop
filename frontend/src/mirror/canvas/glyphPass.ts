// THE GPU GLYPH PATH — gsw's `@godot-scene-web/canvas/glyphs` wired into the mirror's canvas backend.
//
// WHAT IT IS, against the thing it sits beside. `textSurfaces` bakes a label into PIXELS with `fillText` and blits
// the result; this bakes the OUTLINE instead. HarfBuzz's Slug encoder turns each glyph's curves into a texel blob
// and gsw's fragment shader evaluates exact coverage from it at whatever size, rotation and sub-pixel phase the
// frame asks for. There is no raster scale to pick, no atlas page to size, no text-snap grid to land on and no
// second texture minted when a label settles — the same three problems the raster path spent rounds 7-9 on.
//
// IT IS THE SHIPPED PATH. What changed is the
// OUTLINE: gsw's `GlyphsView.spreadPx` dilates a run outward inside one fragment shader, so the one construct that
// used to make most of this game's text inexpressible is expressible, and `refusedOutline` — 122616 labels on a
// live census — is 0.
//
// WHAT IS STILL TRUE AND STILL COSTS SOMETHING, stated here because it is what a reader will want to argue with:
//
//   1. These scenes render at DPR 1, so a 14px label is ppem 14 — under gsw's `PPEM_FIDELITY_FLOOR` of 16, which
//      is HarfBuzz's own branch point rather than a gsw preference. Below it the coverage shader takes a five-tap
//      MSAA approximation that measures BLURRIER than the raster it would replace (0.196 vs 0.132 distortion on
//      Han at ppem 14). `on` IGNORES the floor deliberately: ONE renderer for every label beats a per-label
//      sharpness win that costs a rasterizer switch in the middle of an animation.
//   2. Line breaking is measured with `measureText` and drawn with HarfBuzz's advances, so this module draws
//      lines somebody else broke. THAT IS NOW MEASURED AND IT COSTS NOTHING: over every recording in the bench
//      dir (960 specs, 5624 runs, 2.66M label observations) 69.3% of runs agree exactly, p99 is 0.251 px, and of
//      the 976 lines `measureText` fitted into their box the shaper overflows ZERO of them. One of 7712 fit
//      tests is answered differently, at a 0.0006 px margin, with the shaper narrower. See
//      the former wrap probe's full-hinting check proved that a disagreement is detectable
//      (25 tests, 5 moved breaks) when the browser quantizes advances to whole pixels.
//   3. FACE COVERAGE, which is a different failure entirely and is the one that used to draw WRONG PIXELS on
//      the default arm: `fillRun` shapes through the ONE streamed face and hb-gpu has no fallback, where
//      `fillText` gets the browser's. So an uncovered codepoint rendered as `.notdef` — and `.notdef` has ink
//      (3168 texel bytes in `kreon_regular`), so it rendered as a TOFU BOX. The corpus contains exactly one
//      such label, `"Русский"` in the language menu, 7/7 `.notdef`. THAT IS NOW REFUSED rather than drawn:
//      `blockFor` asks the face's cmap for every codepoint of every line before it shapes anything, and a
//      single miss hands the WHOLE label to the raster path, which draws it correctly through the browser's
//      fallback. Counted as `refusedCoverage`, because the reason this survived a census is that it was
//      silent. The cost is 38 ns per codepoint — 0.023 ms for a 50-label build, measured on the real face.
//
// ---------------------------------------------------------------------------------------------------------------
// AN OUTLINED LABEL IS THE SAME GLYPHS PUSHED TWICE, AND THE ORDER IS THIS MODULE'S TO GET RIGHT. gsw's pass does
// NOT synthesise the pair — a `GlyphsView` carries one colour and one spread, and a command that quietly expanded
// to two draws would hide exactly the half a caller owns. So `blockFor` emits, per label:
//
//     shadow (spread, if the label is outlined) → outline (spread) → fill (no spread)
//
// which is `textSurfaces.drawPass`'s own order, i.e. `paint-order: stroke fill`. The SHADOW carries the spread too
// because a CSS `text-shadow` is a silhouette of ALL the element's ink, outline included — the raster path strokes
// in its shadow pass for that reason, and a shadow that ignored the outline would be visibly thinner than the one
// beside it. `spreadPx = spec.outlinePx / 2`, because `ctx.strokeText` is a CENTRED stroke of width `outlinePx`
// and reaches half of it outward; that is the same half `textSurfaces.inkPadOf` pads the raster by. `OUTLINE_SCALE`
// is already folded into `spec.outlinePx` by `textLayout` — applying it again here would halve every outline.
//
// THE ONE FIDELITY LIMIT, WRITTEN DOWN RATHER THAN HIDDEN: a dilation also fills the glyph's INTERIOR and a
// centred stroke does not. Under an opaque fill the two are identical, because the fill covers every pixel they
// disagree about. Under a TRANSLUCENT fill the outline colour shows through the middle of each glyph here and
// would not through a stroke. What this corpus actually has is translucency in the OUTLINE colour — `#00000080`
// is the single commonest outline in every recording measured (53-63 text nodes per screen) and every fill over
// it is opaque — which this path is unaffected by: one dilated run composites ONCE, where the raster's
// stroke-then-fill in one translucent colour double-composites its own overlap. A translucent FILL over an
// outline is the case that would differ, and this corpus does not contain one.
//
// COST: runs cannot merge (hb-gpu carries the colour, the model and the spread as UNIFORMS), so every run is a
// draw call. An outlined, shadowed, N-line label is `3N` of them where it used to be `2N` — counted in the census
// (`textGlyphs.runs`) rather than absorbed quietly.
//
// ---------------------------------------------------------------------------------------------------------------
// A REFUSAL IS NOT A LOSS — `textSurfaces`' rule verbatim, and the reason every failure path below returns `null`
// rather than throwing or drawing something approximate. Nothing here is a label's only route to the screen: a
// `null` means no glyph run is emitted, the raster path draws it exactly as it does today, and if THAT refuses
// too the DOM overlay keeps its element. A blank label is the failure mode to avoid, and it is the one that
// scores well on every performance counter.
//
// There are seven kinds of refusal and they are all in that class:
//   * the pass will not build (no WebGL2, no wasm, a driver that will not link the program),
//   * the face has not been fetched yet, or hb-gpu would not take its bytes,
//   * the face's LINE METRICS cannot be had yet — see the baseline note in `blockFor`,
//   * the face has NO GLYPH for one of the label's codepoints — the coverage gate in `blockFor`, and the only
//     one of the seven that was added because the path was drawing something WRONG rather than nothing,
//   * the label is outlined and its OUTLINE COLOUR is not a notation this can read — the whole of what
//     `refusedOutline` still means, and a refusal rather than a fill-only draw because silently deleting an
//     outline is most of the difference between readable and not on this game's text,
//   * `auto` and the device ppem is under the floor,
//   * the shaper declined the run.
//
// ---------------------------------------------------------------------------------------------------------------
// PREMULTIPLIED, END TO END, AND THAT IS NOT A DETAIL. gsw's fragment writes PREMULTIPLIED coverage and the stage's
// context is `premultipliedAlpha: true`; a straight-alpha surface anywhere in between composites the text twice
// and the symptom is not a crash or a fringe but text that is merely DARKER than it should be. So the block below
// carries STRAIGHT label colours and `paintSpec.emitTextGlyphs` does the one multiplication, in the same place and
// the same order `emitTextQuad` already does it for a raster.
//
// ---------------------------------------------------------------------------------------------------------------
// ONE HARFBUZZ. `fillRun` shapes through hb-gpu's OWN wasm, which is why this file fetches face bytes and hands
// them to `registerFace` rather than reaching for npm `harfbuzzjs` beside it: two builds is two heaps holding the
// same faces (4.19 MiB across the pair on a phone, measured by gsw), and — worse — it is the configuration in
// which glyph ids and outlines can come from two DIFFERENT files. That produces crisp, fluent, wrong text, which
// no counter downstream can see.

import { createGlyphsView, type GlyphPass, type GlyphsView } from "@godot-scene-web/canvas";
import { createHbGpuGlyphPass, type GlyphFace, type HbGpuGlyphPass } from "@godot-scene-web/canvas/glyphs";
import { createHbGpu, type HbGpu, type HbGpuFailure } from "@godot-scene-web/hb-gpu";
import { HB_GPU_CONTRAST_NONE } from "@godot-scene-web/hb-gpu/webgl";
import createHbGpuModule from "@godot-scene-web/hb-gpu/vendor/hb-gpu.mjs";
import hbGpuWasmUrl from "@godot-scene-web/hb-gpu/vendor/hb-gpu.wasm?url";

import { baselineOf, type TextLayout, type TextLineMetrics, type TextSpec } from "@/mirror/canvas/textLayout";
import type { MirrorFont } from "@/mirror/sceneTree";

/**
 * ONE LABEL'S SHAPED RUNS, in FLAT buffers this module owns and refills.
 *
 * A block is valid only until the next {@link GlyphPassRegistry.blockFor} call, exactly like `PaintScratch`'s
 * views: the walk asks for one and pushes it in the same statement, and a pooled block is what keeps a settled
 * screen's fifty labels from allocating fifty objects and a hundred typed arrays per build.
 *
 * RUNS ARE ORDERED SHADOWS-FIRST, then outlines, then fills — never per line — because CSS composites a silhouette
 * of the WHOLE element's ink behind the whole element. Interleaving them puts line 2's shadow over line 1's glyphs,
 * which is exactly what the raster path's two `drawPass` calls avoid.
 */
export interface GlyphBlock {
  runCount: number;
  /** Per run: the pen origin in the label's BOX space — the line's left edge, on its baseline. `runCount * 2`. */
  origins: Float32Array;
  /** Per run: `[start, count]` into {@link GlyphBlock.slots} / {@link GlyphBlock.positions}. `runCount * 2`. */
  spans: Int32Array;
  /** Per run: STRAIGHT `r, g, b, a` in 0..1 — never premultiplied here. See the header. `runCount * 4`. */
  colors: Float32Array;
  /**
   * Per run: outward dilation in BOX units — `spec.outlinePx / 2` on an outline (and on the shadow under one),
   * `0` on a fill. `runCount`. See the header for why the pair is this module's to order.
   */
  spreads: Float32Array;
  /** gsw atlas slot ids, one per glyph, shared by a shadow run and its fill run. */
  slots: Int32Array;
  /** Pen positions, `x, y` per glyph, in design units relative to the run origin. */
  positions: Float32Array;
  /** Design units per em, i.e. the label's font size in BOX space. One size for the whole label. */
  pixelsPerEm: number;
  /** The `> .mirror-text { transform: scale(N) }` the card rules apply, about the box CENTRE. */
  blockScale: number;
}

export interface GlyphPassStats {
  /** Did the wasm + pass build at all? Null while the load is still in flight. */
  ready: boolean | null;
  /** Faces registered with hb-gpu, and the ones whose fetch or registration failed. */
  faces: number;
  facesFailed: number;
  /** Faces whose bytes are still being fetched — must reach 0 on a settled screen. */
  facesPending: number;
  /**
   * Labels this module produced runs for, and the runs/glyphs in them — CUMULATIVE, not per build.
   *
   * PER-BUILD WAS THE WRONG SHAPE and the first census proved it: every reading here is taken POST-SETTLE, when
   * the last build drew nothing new, so a per-build counter reports a working path as zeros. The builder's own
   * `textGlyphRuns` is the per-build number and the renderer publishes it beside these.
   */
  labels: number;
  runs: number;
  glyphs: number;
  /**
   * Labels refused, BY CLASS and cumulatively, so a census says which constraint is holding a screen back.
   *
   * `refusedPpem` is the fidelity floor doing its job under `auto`, `refusedNoFace` and `refusedNoMetrics` are the
   * two halves of "the face is not here yet" (hb-gpu's bytes and the DOM face's metrics arrive on separate clocks)
   * and should both fall to 0 once the faces land, and `refusedShape`/`refusedColor` are expected to be 0
   * outright.
   *
   * `refusedOutline` USED TO BE THE SCOPE LINE and dominated every census (122616 labels) back when hb-gpu could
   * only fill. It survives with a much narrower meaning — an outlined label whose OUTLINE COLOUR is not a
   * notation {@link parseHtmlColor} reads — and is expected to be 0 outright, because the wire only ever carries
   * Godot's own `Color.ToHtml`. The field is kept rather than deleted so a census taken across this change is
   * comparable term for term; a non-zero reading now means a colour notation nobody has seen before, not a
   * missing feature.
   */
  refusedNotReady: number;
  refusedNoFace: number;
  /**
   * Labels refused because the face's own line metrics were not available — see {@link GlyphPassOptions.metrics}.
   *
   * A TIMING NUMBER, and it must fall to 0 on a settled screen for the same reason `refusedNoFace` must: the DOM
   * `FontFace` this asks about is registered by the same `ensureNodeFonts` call that precedes every one of these
   * builds, so a non-zero reading after the loads settle means a face that never arrived, not a rule doing its
   * job. Non-zero DURING warm-up is the design working — those labels raster, exactly as they do today.
   */
  refusedNoMetrics: number;
  /**
   * Labels refused because the streamed face has no glyph for one of their codepoints.
   *
   * NOT A TIMING NUMBER — unlike `refusedNoFace` and `refusedNoMetrics` this does NOT fall to 0 as a screen
   * settles, because it is a property of the face's character set and the label's string rather than of the
   * load order. A steady non-zero reading on the language menu is this counter doing its job.
   *
   * IT EXISTS BECAUSE THE FAILURE IT REPLACES WAS SILENT. hb-gpu has no fallback chain where `fillText` has the
   * browser's, so an uncovered codepoint used to render as `.notdef` — a tofu box, on the DEFAULT arm — and no
   * counter anywhere said so. `refusedOutline`'s note applies here too: a refusal that nothing counts is how a
   * whole class of wrong render survives a census. See the gate in `blockFor` for why it is per LABEL.
   */
  refusedCoverage: number;
  refusedOutline: number;
  refusedPpem: number;
  refusedShape: number;
  refusedColor: number;
  /** hb-gpu's own counters, or null before the pass exists. */
  pass: {
    slots: number;
    runs: number;
    glyphs: number;
    inkless: number;
    reuploads: number;
    dropped: number;
    runsBelowPpemFloor: number;
    shapeHits: number;
    shapeMisses: number;
    shapeEntries: number;
    shapeGlyphs: number;
    shapeEvicted: number;
  } | null;
  /** Every refusal hb-gpu reported, most recent last, capped. Reasons only — the sentences go to the console. */
  failures: string[];
}

export interface GlyphPassOptions {
  gl: WebGL2RenderingContext;
  /** The stage's design extent at construction. Only a seed — `drawRun` reads the frame's own projection. */
  designWidth: number;
  designHeight: number;
  /**
   * A FACE OR THE PASS ITSELF LANDED — arm a repaint so the labels that were refused re-ask.
   *
   * NEVER ACKS, `onFontReady`'s contract verbatim: a font arriving is not a scene delta, and answering the wire's
   * ack from one would tell MirrorView a frame was presented for state it never saw.
   */
  onReady?: () => void;
  /**
   * THE FACE'S OWN LINE BOX for a font shorthand — `textSurfaces.lineMetricsFor`, and REQUIRED.
   *
   * Required rather than optional because there is no honest default. The baseline this module places is
   * `line.y + (pitch - (ascent + descent)) / 2 + ascent`, the raster path's expression verbatim, and it is only
   * the raster path's ANSWER if the two numbers come from the same face the raster path measures. A registry
   * built without this could only guess at them — which is what it used to do, at 0.8/0.2 of the font size, and
   * what put every glyph-drawn label most of a pixel above its raster-drawn neighbour.
   *
   * `null` from it means "cannot be answered honestly" (no context, face still loading, no `fontBoundingBox*`)
   * and the label is REFUSED and counted, never drawn at a substituted ratio. Injected rather than measured here
   * because this module owns no 2D context: hb-gpu draws outlines, and opening a second canvas to measure with
   * would be a second font-resolution state to keep in step with the one that rasters.
   */
  metrics: (cssFont: string) => TextLineMetrics | null;
  /** Injectable for tests, which have no host to fetch from. Defaults to `globalThis.fetch`. */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}

/**
 * The seam the renderer holds: a `GlyphPass` for the executor, a face registry, and one label's runs.
 *
 * THE PASS IS HANDED OVER BEFORE IT EXISTS, and that is deliberate rather than sloppy. `CanvasExecutorOptions` is
 * read once at construction while the wasm arrives asynchronously, so {@link GlyphPassRegistry.pass} is a stable
 * delegating object that answers "drew nothing" until the real pass is built. Re-creating the executor when the
 * module landed would throw away the program it just paid ~100-250 ms to link.
 */
export interface GlyphPassRegistry {
  /** Install this on `createCanvasExecutor({ glyphs })`. Stable for the registry's whole life. */
  readonly pass: GlyphPass;
  /**
   * Shape one laid-out label into runs, or `null` for any of the six refusals in the header.
   *
   * `deviceScale` is design px to DEVICE px for THIS label — the product of the record's own on-screen scale, the
   * stage's fit-to-screen transform and the device pixel ratio. It is the ppem gate's only input and it is asked
   * of the caller because this module cannot see a record.
   */
  blockFor(spec: TextSpec, layout: TextLayout, font: MirrorFont, deviceScale: number): GlyphBlock | null;
  /** Close the build. A no-op today; see {@link GlyphPassStats.labels} for why the counters are cumulative. */
  endBuild(): void;
  /** CONTEXT LOSS: drop the renderer's GL objects WITHOUT calling into the dead driver. */
  invalidate(): void;
  /** …and the restore. False when the atlas could not be put back; the labels then stay on the raster path. */
  restore(): boolean;
  stats(): GlyphPassStats;
  dispose(): void;
}

/** Godot `#RRGGBB` / `#RRGGBBAA` → 0..1 channels, or null for anything else — see `parseHtmlColor`. */
type Rgba = readonly [number, number, number, number];

/**
 * A LABEL COLOUR, PARSED — or `null`, which refuses the label.
 *
 * Refusing rather than defaulting is the point. The raster path hands `spec.color` straight to `fillStyle`, so
 * every CSS colour notation works there; this path needs NUMBERS, and a fallback (white, say) for a notation this
 * cannot read would draw the label in confidently the wrong colour. The wire only ever carries Godot's own
 * `Color.ToHtml` output, which is exactly these two shapes.
 */
export function parseHtmlColor(html: string | null | undefined): Rgba | null {
  if (!html) {
    return null;
  }
  const hex = html.startsWith("#") ? html.slice(1) : html;
  if (hex.length !== 6 && hex.length !== 8) {
    return null;
  }
  const byteAt = (i: number): number => parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255;
  const r = byteAt(0);
  const g = byteAt(1);
  const b = byteAt(2);
  const a = hex.length === 8 ? byteAt(3) : 1;
  return [r, g, b, a].every((n) => Number.isFinite(n)) ? [r, g, b, a] : null;
}

/** Failure reasons kept for the stats block. Bounded, because a broken face would otherwise report forever. */
const FAILURE_CAP = 8;

function grownInts(current: Int32Array, needed: number): Int32Array {
  let capacity = Math.max(1, current.length);
  while (capacity < needed) capacity *= 2;
  const next = new Int32Array(capacity);
  next.set(current);
  return next;
}

function grownFloats(current: Float32Array, needed: number): Float32Array {
  let capacity = Math.max(1, current.length);
  while (capacity < needed) capacity *= 2;
  const next = new Float32Array(capacity);
  next.set(current);
  return next;
}

export function createGlyphPassRegistry(options: GlyphPassOptions): GlyphPassRegistry {
  let live: HbGpuGlyphPass | null = null;
  let module: HbGpu | null = null;
  let ready: boolean | null = null;
  let disposed = false;
  let contextLost = false;

  const failures: string[] = [];
  const report = (failure: HbGpuFailure): void => {
    if (failures.length < FAILURE_CAP) {
      failures.push(failure.reason);
    }
    console.warn(`[mirror] glyph path: ${failure.message}`);
  };

  const counters = {
    labels: 0,
    runs: 0,
    glyphs: 0,
    refusedNotReady: 0,
    refusedNoFace: 0,
    refusedNoMetrics: 0,
    refusedCoverage: 0,
    refusedOutline: 0,
    refusedPpem: 0,
    refusedShape: 0,
    refusedColor: 0
  };

  /**
   * Faces KEYED BY URL, not by family — and that is a real difference from `fonts.ensureFontFace`, whose own doc
   * records that its family-keyed dedup drops a family's second face on the floor. A url IS the file, so two
   * weights of one family register as the two distinct faces they are, and the "gid 97 means two things" hazard
   * the header names cannot arise from this map.
   */
  const faces = new Map<string, GlyphFace | null>();
  const pending = new Set<string>();
  let facesFailed = 0;

  const fetchBytes =
    options.fetchBytes ??
    (async (url: string): Promise<Uint8Array> => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    });

  // The shaping scratch: ONE view, refilled per line. `fillRun` replaces its buffers when a run does not fit, so
  // it settles at the high-water mark of the longest line ever shaped and allocates nothing after that.
  const shaped: GlyphsView = createGlyphsView(64);

  /**
   * THE PIXEL-STORE BRACKET — the one thing two uploaders sharing one GL context have to agree about, and the
   * defect that this file was written twice because of.
   *
   * WHAT HAPPENS WITHOUT IT, measured rather than reasoned: the glyph path CRASHED the renderer process — a
   * hard `Target crashed`, no JS exception, no GL error, nothing on the console — on the very first glyph the
   * atlas tried to upload. Bisected to `slotFor`; `glyphFor` (pure wasm) answered fine one line earlier.
   *
   * WHY. `UNPACK_PREMULTIPLY_ALPHA_WEBGL` and `UNPACK_FLIP_Y_WEBGL` are CONTEXT state, not texture state. gsw's
   * own `createTextureCache` sets premultiply TRUE before each of its `texImage2D`s (that is this package's
   * contract for colour textures) and leaves it set. hb-gpu's atlas then uploads an `RGBA16I` blob from an
   * `ArrayBufferView` — a combination for which both flags MUST be false, because WebGL only defines them for
   * DOM sources — and ANGLE/Vulkan does not answer that with `INVALID_OPERATION` here; it takes the process
   * down. hb-gpu saves and restores `UNPACK_ALIGNMENT` around every upload (`webgl.ts:975`) and these two are
   * simply not in that set.
   *
   * SO THE CONSUMER BRACKETS IT, because the consumer is the party that mixed the two uploaders onto one
   * context. THE DURABLE FIX BELONGS UPSTREAM — hb-gpu should carry these two in the same save/restore its
   * alignment already uses, and then this bracket becomes redundant rather than wrong.
   *
   * THAT FIX HAS SINCE LANDED (`godot-scene-web` `99abb6b`): `uploadTexels` now saves, forces false and
   * restores both flags, with three fake-GL tests, two of which were proved able to fail by dropping the force
   * and then by dropping only the restore. Every path that can reach `texSubImage2D` from here — `fillRun` via
   * `slotFor`, and `drawRun` via its eviction re-upload — goes through `HbGpuRenderer.upload`, so this bracket
   * is now belt and braces rather than the thing standing between this app and a dead renderer process.
   *
   * IT IS KEPT, on full evidence rather than a pending hunch. The 2026-09-06 Vulkan/headless ABBA replayed the
   * complete deckview-40-openclose and combat-modern-2026-08-06 streams at the only clean seven-row atlas
   * (28,672 texels): wrapper/upstream/upstream/wrapper had zero crashes, context losses, dropped glyphs or GL
   * errors, with state stable at alignment=4 / flip=false / premultiply=false. But that capacity had zero
   * reuploads. The next lower six-row capacity (24,576) made 24,921 reuploads during full deck replay and hit
   * hb-gpu's same-frame atlas-overwrite error twice. Thus the required initial-upload-and-reupload removal gate
   * cannot pass; retain the mixed-uploader safeguard. Durable reports, raw RGBA and pixel comparisons are under
   * the consumer checkout's ignored `.sts2/renderer-deferred-20260906/unpack-*`.
   *
   * Query-and-restore rather than set-and-forget: pixel-store parameters are client-side state in every WebGL
   * implementation, so `getParameter` here is a struct read and not a driver round trip — and restoring means
   * this cannot change what the texture cache's next upload does, whatever gsw decides that should be.
   */
  function withGlyphUnpack<T>(fn: () => T): T {
    const gl = options.gl;
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) === true;
    const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) === true;
    if (flip) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    if (premultiply) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    try {
      return fn();
    } finally {
      if (flip) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      }
      if (premultiply) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      }
    }
  }

  const block: GlyphBlock = {
    runCount: 0,
    origins: new Float32Array(16),
    spans: new Int32Array(16),
    colors: new Float32Array(32),
    // ONE FLOAT PER RUN where `origins` takes two, so 8 runs is the same starting capacity in both and `pushRun`
    // can grow the whole set behind one test. Eight covers a shadowed, outlined two-line label (`3N`) with room.
    spreads: new Float32Array(8),
    slots: new Int32Array(256),
    positions: new Float32Array(512),
    pixelsPerEm: 16,
    blockScale: 1
  };

  /**
   * BUILD THE PASS, ONCE, ASYNCHRONOUSLY — and never retry.
   *
   * A retry loop is the wrong shape for every failure this can have: a browser without WebGL2, a host that will
   * not serve the wasm, a driver that will not link the program. None of them get better by asking again, and
   * asking again per build would spend a network round trip per frame to keep drawing exactly what it already
   * draws. `ready === false` is a permanent, honest answer and the raster path is unaffected by it.
   */
  async function build(): Promise<void> {
    try {
      const response = await fetch(hbGpuWasmUrl);
      if (!response.ok) {
        throw new Error(`hb-gpu.wasm: ${response.status} ${response.statusText}`);
      }
      const binary = await response.arrayBuffer();
      if (disposed) {
        return;
      }
      const hb = await createHbGpu(
        createHbGpuModule as Parameters<typeof createHbGpu>[0],
        binary,
        { onError: report }
      );
      if (disposed) {
        hb.destroy();
        return;
      }
      module = hb;
      live = createHbGpuGlyphPass({
        gl: options.gl,
        module: hb,
        designWidth: Math.max(1, options.designWidth),
        designHeight: Math.max(1, options.designHeight),
        onError: report,
        // The floor warning is gsw's and it is worth having once: the current glyph path deliberately keeps a
        // label on one renderer through its animation instead of changing paths at a ppem threshold.
        warnBelowPpemFloor: true,
        // NO CONTRAST CURVE, BECAUSE THE THING THIS MIRRORS HAS NONE. hb-gpu ships stem darkening ON and gsw's
        // pass keeps that default, which is the right call for a page whose neighbour is DOM text — uncorrected
        // analytic coverage reads washed out beside Blink's. This app's neighbour is not DOM text. It is the
        // GODOT GAME the same screen is a mirror of, and Godot applies no contrast curve at all: its grayscale
        // and MSDF glyph interiors come out byte-uniform. A darkened stem here is therefore a WEIGHT MISMATCH
        // against the reference, not a legibility win.
        //
        // AND IT IS ALSO JUST BETTER, WHICH IS THE PART THAT SETTLED IT. gsw's A1 crossover sweep grades every
        // text arm against an 8x area-coverage reference (`packages/perf-harness/probes/text-crossover.ts`,
        // `--hb-contrast default|none`):
        //
        //     ppem 16    default 0.1091    none 0.0258     canvas2d 0.0925
        //     ppem 24    default 0.0537    none 0.0138
        //
        // With the shipped curve the glyph path LOSES to a plain `fillText` at 16 and costs ~4x its achievable
        // distortion at 24 — a card title on the user's config (1920x1080, DPR 1) is about 24 device ppem, so
        // that is the default arm's own text. With the curve off it beats every arm at every size swept (16-52).
        //
        // IT MOVES EDGES, NOT INK. The correction is gated on partial coverage, so glyph interiors are
        // byte-identical either way — only the ramp at the boundary narrows — and the library ramps it off by
        // ppem 48, so headings barely move and small labels move most.
        contrast: HB_GPU_CONTRAST_NONE
      });
      ready = live !== null;
      if (!ready) {
        hb.destroy();
        module = null;
      }
    } catch (error) {
      ready = false;
      console.warn(`[mirror] glyph path unavailable, labels stay on the raster path: ${String(error)}`);
    }
    // ARM A REPAINT EITHER WAY. On success the labels refused while the wasm was in flight re-ask and land; on
    // failure nothing changes on screen, and one wasted build is cheaper than a branch that can forget.
    options.onReady?.();
  }

  void build();

  /**
   * The face for one streamed font, fetching it on first sight. `null` while the fetch is in flight and forever
   * after one that failed — the label rasters in the meantime, which is what it does today anyway.
   */
  function faceFor(font: MirrorFont): GlyphFace | null {
    const known = faces.get(font.url);
    if (known !== undefined) {
      return known;
    }
    if (live === null || pending.has(font.url)) {
      return null;
    }
    pending.add(font.url);
    void fetchBytes(font.url).then(
      (bytes) => {
        pending.delete(font.url);
        // THE PASS CAN HAVE GONE while the bytes were in flight — a context loss, or a dispose. Registering into
        // a dead renderer would put a face in a wasm heap nothing will ever read from.
        if (disposed || live === null) {
          return;
        }
        const face = live.registerFace(bytes, font.family || font.url);
        faces.set(font.url, face);
        if (face === null) {
          facesFailed++;
        }
        // Arm the repaint on BOTH settlements: a face that registered wants its labels re-asked, and one that did
        // not wants them to stop asking (`faces` now holds an explicit `null`, so the next build refuses cheaply).
        options.onReady?.();
      },
      (error) => {
        pending.delete(font.url);
        // A face the host cannot serve. Recorded as an explicit `null` so this is asked ONCE — re-fetching every
        // build would spend a request per label per frame to keep drawing exactly what it already draws.
        faces.set(font.url, null);
        facesFailed++;
        console.warn(`[mirror] glyph path: face "${font.url}" could not be fetched (${String(error)})`);
      }
    );
    return null;
  }

  /**
   * The shaping pass's per-line scratch — `[start, count, x, baselineY]` per laid-out line, pooled like
   * everything else here so a label with four lines does not mint an array per build.
   */
  let lines = new Float64Array(16);

  /**
   * Append one run to the pooled block, growing the per-run arrays if it does not fit.
   *
   * THE RUN COUNT IS UNBOUNDED AND THE GROWTH IS DOUBLING — checked rather than assumed when the outline added a
   * third run per line: `grownFloats`/`grownInts` double from the current length until the need is met, and every
   * one of the four arrays is re-tested on the same `runCount`, so `3N` runs is the same code path `2N` was.
   */
  function pushRun(
    originX: number,
    originY: number,
    start: number,
    count: number,
    color: Rgba,
    spread: number
  ): void {
    const i = block.runCount;
    if ((i + 1) * 2 > block.origins.length) {
      block.origins = grownFloats(block.origins, (i + 1) * 2);
      block.spans = grownInts(block.spans, (i + 1) * 2);
      block.colors = grownFloats(block.colors, (i + 1) * 4);
      block.spreads = grownFloats(block.spreads, i + 1);
    }
    block.origins[i * 2] = originX;
    block.origins[i * 2 + 1] = originY;
    block.spans[i * 2] = start;
    block.spans[i * 2 + 1] = count;
    block.colors[i * 4] = color[0];
    block.colors[i * 4 + 1] = color[1];
    block.colors[i * 4 + 2] = color[2];
    block.colors[i * 4 + 3] = color[3];
    block.spreads[i] = spread;
    block.runCount = i + 1;
  }

  return {
    pass: {
      drawRun(run, projection) {
        // THE DELEGATE. Before the wasm lands there is nothing to draw with — and nothing to draw either, because
        // `blockFor` refuses until `live` exists, so this arm is reachable only by a list retained across a
        // context loss. Zero rather than a throw: the frame is one label short, not gone.
        if (live === null) {
          return { glyphs: 0, drawCalls: 0 };
        }
        // BRACKETED TOO, and not only `fillRun`: a run whose glyph the atlas has evicted since the list was
        // recorded is RE-ENCODED AND RE-UPLOADED inside `drawRun` (that is the whole point of the slot-id
        // indirection), so this path reaches `texSubImage2D` as well. It is also the path that runs INSIDE the
        // executor's frame, i.e. right after the quad batcher's own texture binds.
        const pass = live;
        return withGlyphUnpack(() => pass.drawRun(run, projection));
      }
    },

    blockFor(spec, layout, font, _deviceScale) {
      if (live === null || contextLost) {
        counters.refusedNotReady++;
        return null;
      }
      // THE OUTLINE, WHICH THIS USED TO REFUSE OUTRIGHT. `spec.outlinePx` is the width `strokeText` would be
      // given (`textLayout` has already applied `OUTLINE_SCALE`, so DO NOT apply it again), and a CENTRED stroke
      // of width W reaches W/2 outward — the same half `textSurfaces.inkPadOf` pads the raster's own surface by.
      // That is the dilation gsw's `spreadPx` takes, in the run's own units, which are these units.
      const outlined = spec.outlinePx > 0;
      const outlineSpread = outlined ? spec.outlinePx / 2 : 0;
      // REFUSED, NOT DRAWN FILL-ONLY, when the outline colour is unreadable. Everything else here refuses a label
      // it cannot draw CORRECTLY; drawing an outlined label without its outline is the one failure that looks
      // like a successful render, and on this game's text it is most of the difference between readable and not.
      const outlineColor = outlined ? parseHtmlColor(spec.outlineColor) : null;
      if (outlined && outlineColor === null) {
        counters.refusedOutline++;
        return null;
      }
      const fill = parseHtmlColor(spec.color);
      const shadowColor = spec.shadow ? parseHtmlColor(spec.shadow.color) : null;
      if (fill === null || (spec.shadow !== null && shadowColor === null)) {
        counters.refusedColor++;
        return null;
      }
      const face = faceFor(font);
      if (face === null) {
        counters.refusedNoFace++;
        return null;
      }
      // Aliased non-nullable so the closures below narrow — the same note gsw's own `glyph-pass-hbgpu.ts`
      // carries about its renderer.
      const shaper = live;

      // THE COVERAGE GATE — the one refusal that is about the FACE'S CHARACTER SET rather than about this
      // module's arithmetic, and the only one here whose absence produced WRONG PIXELS rather than a fallback.
      //
      // WHAT IT IS THE ANSWER TO. `fillRun` shapes through the ONE streamed face and hb-gpu has no fallback
      // chain; `fillText` on the raster path gets the browser's, which is why a codepoint the face does not
      // carry renders correctly there and as `.notdef` here. `.notdef` in this game's faces HAS INK (3168 texel
      // bytes in `kreon_regular`, measured), so the glyph path drew TOFU BOXES — and drew them on the default
      // path. Over every recording in the
      // bench dir, 960 distinct label specs and 12318 codepoints, exactly ONE label is affected — `"Русский"`
      // in the language menu, 7/7 `.notdef` in `kreon_regular` — and that one label is the whole of the corpus
      // evidence, which is precisely why nobody saw it.
      //
      // A WHOLE-LABEL REFUSAL, AND THAT IS THE POINT RATHER THAN A SIMPLIFICATION. Refusing per RUN would put
      // the covered lines of a label on the glyph path and the uncovered ones on the raster — two rasterizers
      // whose baselines, stem weights and sub-pixel phases are close but not equal, on adjacent lines of one
      // label. A mixed-script label (`"Deal 6 damage. Русский"`) is exactly where it would land. Returning `null` here
      // hands the ENTIRE label to the raster path, which is what every other refusal in this function does.
      //
      // A CMAP LOOKUP, BEFORE SHAPING, NOT AN INSPECTION OF THE SHAPED RUN. Three reasons and they all matter:
      // it costs nothing to refuse (a shaped tofu run also UPLOADS the `.notdef` outline into the atlas, which
      // then occupies a slot for the life of the page); it does not depend on `.notdef` having ink, so it also
      // catches the face where `.notdef` is blank and the glyph path would silently draw a GAP instead of a
      // box; and it is cheap enough not to need a memo — 38 ns per codepoint, i.e. 0.023 ms for a 50-label
      // build, measured against the real face.
      //
      // `for (const ch of ...)` ITERATES CODE POINTS, not code units, which is the half of this that a test
      // over ASCII could never catch: a cmap is keyed by code point, and feeding it a lone surrogate would ask
      // about a character that does not exist. (`textWrap.fnv1a32` documents the OPPOSITE choice for the
      // opposite reason — it has a C# `foreach` to agree with.)
      //
      // OVER-REFUSING IS THE SAFE DIRECTION and it is worth naming the case: HarfBuzz maps a default-ignorable
      // (a zero-width space, say) to an invisible glyph rather than to `.notdef`, so a label carrying one would
      // be refused here where shaping would have coped. It costs that label the raster path, which draws it
      // correctly — and the corpus contains none, the cmap check agreeing with the shaped ground truth on all
      // 960 specs.
      for (const line of layout.lines) {
        for (const ch of line.text) {
          const codepoint = ch.codePointAt(0);
          if (codepoint !== undefined && shaper.glyphFor(face, codepoint) !== 0) {
            continue;
          }
          counters.refusedCoverage++;
          return null;
        }
      }

      // THE BASELINE, from the REAL FACE — `baselineOf` with the metrics the raster path reads off its own 2D
      // context for this exact shorthand. Same expression, same two numbers, therefore the same row of pixels.
      //
      // IT USED TO BE A GUESS, and the guess cost more than its comment claimed. `ascent = fontPx * 0.8` with
      // `descent = fontPx * 0.2` puts the baseline at `y + pitch/2 + 0.3*fontPx`, so the error is
      // `((A - D) - 0.6) / 2 * fontPx` — and Chrome reports this game's `kreon_regular` at A=1.000/D=0.250 at
      // 12px and 0.950/0.300 at 20px, i.e. 0.5-0.9 px of it on ordinary label sizes, always in the same
      // direction (the guess draws HIGH). Measured on the shop screen before this change: the card-description
      // labels sat 0.72-1.07 px above their raster-drawn neighbours. With the glyph path becoming the default
      // that is not an A/B curiosity — it is every label, and every outlined label (which can only raster) then
      // sits a pixel below the ones beside it.
      //
      // REFUSING IS THE ONLY OTHER HONEST ANSWER. `metrics` returns null while the DOM face is still loading,
      // where `measureText` would answer for the browser's FALLBACK — a wrong ascent, not a missing one. The
      // label rasters this build, `refusedNoMetrics` says it happened, and the raster path's own readiness gate
      // arms the load that clears it.
      const metrics = options.metrics(spec.cssFont);
      if (metrics === null) {
        counters.refusedNoMetrics++;
        return null;
      }

      block.runCount = 0;
      block.pixelsPerEm = spec.fontPx;
      block.blockScale = spec.blockScale;
      shaped.pixelsPerEm = spec.fontPx;
      let glyphTotal = 0;
      let lineCount = 0;
      // SHAPE EVERY LINE FIRST, then emit whole passes in order — see {@link GlyphBlock} for why they cannot
      // interleave. A line is shaped ONCE however many times it is drawn: the shadow, outline and fill runs of a
      // line all name the same span, so they carry pen positions from a single shaping pass and cannot drift.
      for (const line of layout.lines) {
        // SHAPE + UPLOAD, bracketed: `fillRun` issues a slot id per new glyph, and issuing one uploads its
        // outline. See `withGlyphUnpack` for the crash this is the answer to.
        if (!withGlyphUnpack(() => shaper.fillRun(shaped, face, line.text))) {
          counters.refusedShape++;
          return null;
        }
        const count = shaped.glyphCount;
        if (count === 0) {
          continue; // a blank line: legitimately no ink, and no run to push
        }
        if (glyphTotal + count > block.slots.length) {
          block.slots = grownInts(block.slots, glyphTotal + count);
          block.positions = grownFloats(block.positions, (glyphTotal + count) * 2);
        }
        block.slots.set(shaped.slots.subarray(0, count), glyphTotal);
        block.positions.set(shaped.positions.subarray(0, count * 2), glyphTotal * 2);
        if ((lineCount + 1) * 4 > lines.length) {
          const next = new Float64Array(Math.max(4, lines.length * 2));
          next.set(lines);
          lines = next;
        }
        lines[lineCount * 4] = glyphTotal;
        lines[lineCount * 4 + 1] = count;
        lines[lineCount * 4 + 2] = line.x;
        lines[lineCount * 4 + 3] = baselineOf(line.y, spec.pitchPx, metrics);
        lineCount++;
        glyphTotal += count;
      }
      if (lineCount === 0) {
        return null; // nothing to draw — an empty label, or a layout with no lines
      }
      // SHADOW → OUTLINE → FILL, whole passes rather than per line, which is `textSurfaces.drawPass`'s own order
      // (stroke then fill, i.e. `paint-order: stroke fill`) applied to the two passes that path makes.
      //
      // THE SHADOW CARRIES THE SPREAD TOO. A CSS `text-shadow` is a silhouette of ALL the element's ink — the
      // outline included — which is why the raster path strokes inside its shadow pass as well; a shadow that
      // ignored the outline is visibly thinner than the raster's under every outlined label, and most of this
      // game's labels are outlined. One dilated run is exactly that silhouette: `glyph ∪ (centred band of width
      // outlinePx)` IS the glyph dilated by `outlinePx / 2`. It also composites ONCE, where the raster's
      // stroke-then-fill in a single translucent shadow colour double-darkens its own overlap.
      if (spec.shadow !== null && shadowColor !== null) {
        for (let i = 0; i < lineCount; i++) {
          pushRun(
            lines[i * 4 + 2] + spec.shadow.dx,
            lines[i * 4 + 3] + spec.shadow.dy,
            lines[i * 4],
            lines[i * 4 + 1],
            shadowColor,
            outlineSpread
          );
        }
      }
      // THE OUTLINE: the SAME span, the same pens, dilated and in the outline colour. Shaped once with the fill
      // (the two runs share `lines[i]`), so the pair cannot drift apart by a sub-pixel the way two shaping passes
      // could.
      if (outlineColor !== null) {
        for (let i = 0; i < lineCount; i++) {
          pushRun(lines[i * 4 + 2], lines[i * 4 + 3], lines[i * 4], lines[i * 4 + 1], outlineColor, outlineSpread);
        }
      }
      for (let i = 0; i < lineCount; i++) {
        pushRun(lines[i * 4 + 2], lines[i * 4 + 3], lines[i * 4], lines[i * 4 + 1], fill, 0);
      }
      counters.labels++;
      counters.runs += block.runCount;
      counters.glyphs += glyphTotal;
      return block;
    },

    endBuild() {
      // NOTHING TO RESET, and that is deliberate — see {@link GlyphPassStats.labels}. The method stays because
      // the registry is one of four the renderer closes per build and a seam that exists only when it currently
      // has work is a seam the next change forgets to add back.
    },

    invalidate() {
      contextLost = true;
      live?.notifyContextLost();
    },

    restore() {
      if (live === null) {
        return false;
      }
      const ok = live.rebuild();
      contextLost = !ok;
      return ok;
    },

    stats() {
      return {
        ready,
        faces: faces.size - facesFailed,
        facesFailed,
        facesPending: pending.size,
        labels: counters.labels,
        runs: counters.runs,
        glyphs: counters.glyphs,
        refusedNotReady: counters.refusedNotReady,
        refusedNoFace: counters.refusedNoFace,
        refusedNoMetrics: counters.refusedNoMetrics,
        refusedCoverage: counters.refusedCoverage,
        refusedOutline: counters.refusedOutline,
        refusedPpem: counters.refusedPpem,
        refusedShape: counters.refusedShape,
        refusedColor: counters.refusedColor,
        pass: live === null ? null : { ...live.stats },
        failures: [...failures]
      };
    },

    dispose() {
      disposed = true;
      live?.dispose();
      live = null;
      // The FONTS go with the module, and they have to: each holds a copy of its face in the wasm heap, so
      // dropping the module without destroying it would leak every face for the life of the page.
      module?.destroy();
      module = null;
      faces.clear();
      pending.clear();
    }
  };
}
