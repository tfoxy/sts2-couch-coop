import { beforeEach, describe, expect, it, vi } from "vitest";

// THE OUTLINE THROUGH THE GLYPH PATH — `glyphPass.blockFor`'s run set, which is the half gsw deliberately does NOT
// own. gsw's pass carries one colour and one spread per run and refuses to synthesise the pair, so an outlined
// label is the same glyphs and the same pens pushed TWICE, and the ORDER and the SPREADS are this module's answer.
//
// FOUR CLAIMS, all of which are invisible on a screenshot taken by the agent who wrote the bug:
//
//   * THE ORDER IS SHADOW → OUTLINE → FILL, whole passes rather than per line. Reversed, the outline covers the
//     fill and every glyph reads as a solid blob in the outline colour; interleaved per line, line 2's shadow
//     lands on line 1's glyphs.
//   * THE SHADOW CARRIES THE SPREAD when the label is outlined. A CSS text-shadow is a silhouette of ALL the
//     element's ink, which is why `textSurfaces.drawPass` strokes inside the shadow pass too. Miss it and the
//     shadow is thinner than the raster's — visible, and easy to look at and accept.
//   * THE FILL RUN'S SPREAD GOES BACK TO 0. It shares a pooled view with the outline run.
//   * `spec.outlinePx / 2`, ONCE. `outlinePx` has already been through `OUTLINE_SCALE` in `textLayout`; the half
//     is the centred-stroke half, the same one `textSurfaces.inkPadOf` pads the raster surface by. Applying
//     either factor twice is a wrong-weight outline that still looks like an outline.
//
// The pass, the wasm and the shaper are STUBBED. What is under test is arithmetic and ordering over a shaped run,
// and the real ones need a GL context, a multi-MiB wasm and a font file — none of which make any of the four
// claims above easier to check.

const shapedGlyphs = 3;

/** A stand-in for gsw's `HbGpuGlyphPass`: `fillRun` fills the view with `shapedGlyphs` glyphs on one pen line. */
const fakePass = {
  stats: {
    slots: 0,
    runs: 0,
    glyphs: 0,
    inkless: 0,
    reuploads: 0,
    dropped: 0,
    runsBelowPpemFloor: 0,
    shapeHits: 0,
    shapeMisses: 0,
    shapeEntries: 0,
    shapeGlyphs: 0,
    shapeEvicted: 0
  },
  registerFace: vi.fn(() => ({ font: {}, face: { id: 1, upem: 1000 }, upem: 1000, label: "fake" })),
  slotFor: vi.fn(() => 1),
  glyphFor: vi.fn(() => 1),
  fillRun: vi.fn((run: { slots: Int32Array; positions: Float32Array; glyphCount: number }) => {
    for (let i = 0; i < shapedGlyphs; i++) {
      run.slots[i] = 100 + i;
      run.positions[i * 2] = i * 8;
      run.positions[i * 2 + 1] = 0;
    }
    run.glyphCount = shapedGlyphs;
    return true;
  }),
  drawRun: vi.fn(() => ({ glyphs: 0, drawCalls: 0 })),
  setViewport: vi.fn(),
  notifyContextLost: vi.fn(),
  rebuild: vi.fn(() => true),
  dispose: vi.fn(),
  renderer: {}
};

vi.mock("@godot-scene-web/canvas/glyphs", () => ({
  PPEM_FIDELITY_FLOOR: 16,
  GLYPH_SLOT_NONE: -1,
  createHbGpuGlyphPass: () => fakePass
}));

vi.mock("@godot-scene-web/hb-gpu", () => ({
  createHbGpu: async () => ({ destroy: vi.fn(), createFont: vi.fn() })
}));

vi.mock("@godot-scene-web/hb-gpu/vendor/hb-gpu.mjs", () => ({ default: vi.fn() }));

vi.mock("@godot-scene-web/hb-gpu/vendor/hb-gpu.wasm?url", () => ({ default: "/hb-gpu.wasm" }));

import { createGlyphPassRegistry, type GlyphBlock } from "@/mirror/canvas/glyphPass";
import { baselineOf, type TextLayout, type TextSpec } from "@/mirror/canvas/textLayout";
import type { MirrorFont } from "@/mirror/sceneTree";

const METRICS = { ascent: 12, descent: 3 };
const FONT: MirrorFont = { family: "kreon", url: "/fonts/kreon.ttf", weight: null, style: null };

/** Only the fields `blockFor` reads; the rest of a `TextSpec` never reaches it. */
function spec(over: Partial<TextSpec> = {}): TextSpec {
  return {
    text: "AB",
    cssFont: '14px "kreon"',
    family: "kreon",
    fontPx: 14,
    color: "#ffffff",
    outlinePx: 0,
    outlineColor: null,
    shadow: null,
    align: "left",
    blockAlign: "start",
    blockAlignY: "start",
    boxW: 100,
    boxH: 40,
    contentW: 100,
    pitchPx: 18,
    paragraphGapPx: 0,
    whiteSpace: "pre-wrap",
    blockScale: 1,
    ...over
  } as TextSpec;
}

function layout(lineCount = 1): TextLayout {
  return {
    lines: Array.from({ length: lineCount }, (_, i) => ({ text: "AB", width: 24, x: 5, y: i * 18 })),
    blockW: 24,
    blockH: lineCount * 18,
    wrapped: false
  };
}

/** A registry whose pass and face have both landed — the state every assertion below is about. */
async function readyRegistry() {
  // The wasm FETCH is real code even with the module stubbed — `build()` fetches the url before instantiating —
  // and jsdom has no server to answer it. Face bytes go through the injected `fetchBytes` instead.
  vi.stubGlobal("fetch", async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));
  const gl = {
    UNPACK_FLIP_Y_WEBGL: 1,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 2,
    getParameter: () => false,
    pixelStorei: () => {}
  } as unknown as WebGL2RenderingContext;
  const registry = createGlyphPassRegistry({
    gl,
    designWidth: 1920,
    designHeight: 1080,
    metrics: () => METRICS,
    fetchBytes: async () => new Uint8Array(4)
  });
  // Two settlements to wait on and they are independent: the wasm build (armed in the constructor) and the face
  // fetch (armed by the FIRST `blockFor`, which therefore refuses with `refusedNoFace` however ready the pass is).
  await vi.waitFor(() => expect(registry.stats().ready).toBe(true));
  registry.blockFor(spec(), layout(), FONT, 1);
  await vi.waitFor(() => expect(registry.stats().faces).toBe(1));
  return registry;
}

/** `[originX, originY, spread, r, g, b, a]` per run — the whole of what distinguishes one run from another. */
function runsOf(block: GlyphBlock): number[][] {
  return Array.from({ length: block.runCount }, (_, i) => [
    block.origins[i * 2],
    block.origins[i * 2 + 1],
    block.spreads[i],
    block.colors[i * 4],
    block.colors[i * 4 + 1],
    block.colors[i * 4 + 2],
    block.colors[i * 4 + 3]
  ]);
}

const BASELINE = baselineOf(0, 18, METRICS);

describe("glyphPass.blockFor and the outline", () => {
  beforeEach(() => {
    fakePass.fillRun.mockClear();
  });

  it("no longer refuses an outlined label — the refusal that dominated the census is gone", async () => {
    const registry = await readyRegistry();
    const block = registry.blockFor(spec({ outlinePx: 3, outlineColor: "#000000" }), layout(), FONT, 1);
    expect(block).not.toBeNull();
    expect(registry.stats().refusedOutline).toBe(0);
  });

  it("emits shadow → outline → fill, in that order, with the spread on the first two", async () => {
    const registry = await readyRegistry();
    const block = registry.blockFor(
      spec({
        outlinePx: 3,
        outlineColor: "#000000",
        color: "#ffffff",
        shadow: { dx: 1, dy: 2, color: "#00000080" }
      }),
      layout(),
      FONT,
      1
    );
    expect(block).not.toBeNull();
    expect(runsOf(block!)).toEqual([
      // the shadow: displaced, in the shadow's own colour, and DILATED because the label is outlined
      // (`Math.fround` because the block's colours live in a Float32Array — gsw's storage, not a rounding here)
      [5 + 1, BASELINE + 2, 1.5, 0, 0, 0, Math.fround(128 / 255)],
      // the outline: undisplaced, outline colour, same dilation
      [5, BASELINE, 1.5, 0, 0, 0, 1],
      // …and the fill, which must be back at spread 0 or the label draws bold
      [5, BASELINE, 0, 1, 1, 1, 1]
    ]);
  });

  it("gives a TRANSLUCENT outline exactly one run, so it composites once and does not read doubled", async () => {
    const registry = await readyRegistry();
    // `#00000080` is the commonest outline colour in this corpus (53-63 text nodes on every screen measured).
    // The whole reason gsw dilates INSIDE one fragment shader rather than stamping N offset copies is that N
    // copies of a half-alpha outline composite N times and read as a solid black one. One run per line, whatever
    // the spread, is that guarantee at this end.
    const block = registry.blockFor(spec({ outlinePx: 3, outlineColor: "#00000080" }), layout(), FONT, 1);
    expect(block!.runCount).toBe(2); // outline + fill, and no third
    expect(block!.colors[3]).toBe(Math.fround(128 / 255));
    expect(block!.spreads[0]).toBe(1.5);
  });

  it("shapes ONE pass however many runs come out of it — the three share a span", async () => {
    const registry = await readyRegistry();
    fakePass.fillRun.mockClear();
    const block = registry.blockFor(
      spec({ outlinePx: 3, outlineColor: "#000000", shadow: { dx: 1, dy: 1, color: "#000000" } }),
      layout(2),
      FONT,
      1
    );
    // Two lines, six runs, and exactly TWO shaping calls: pen positions that came from one shaping pass cannot
    // drift apart between an outline and the fill sitting on top of it.
    expect(block!.runCount).toBe(6);
    expect(fakePass.fillRun).toHaveBeenCalledTimes(2);
    const spans = Array.from({ length: 6 }, (_, i) => [block!.spans[i * 2], block!.spans[i * 2 + 1]]);
    expect(spans).toEqual([
      [0, 3],
      [3, 3], // shadow, line 1 and line 2
      [0, 3],
      [3, 3], // outline
      [0, 3],
      [3, 3] // fill
    ]);
  });

  it("leaves an unoutlined label exactly as it was: shadow then fill, no spread anywhere", async () => {
    const registry = await readyRegistry();
    const block = registry.blockFor(spec({ shadow: { dx: 1, dy: 2, color: "#000000" } }), layout(), FONT, 1);
    expect(runsOf(block!)).toEqual([
      [6, BASELINE + 2, 0, 0, 0, 0, 1],
      [5, BASELINE, 0, 1, 1, 1, 1]
    ]);
  });

  it("halves `outlinePx` ONCE — a centred stroke of width W reaches W/2, and OUTLINE_SCALE is already in", async () => {
    const registry = await readyRegistry();
    // `spec.outlinePx` is the width `strokeText` would be given, i.e. `outline_size * OUTLINE_SCALE` as
    // `textLayout` computes it. Halving it again here (or re-applying the 0.5) is a thin outline that still looks
    // like an outline, which is why the number is pinned rather than described.
    const block = registry.blockFor(spec({ outlinePx: 5, outlineColor: "#123456" }), layout(), FONT, 1);
    expect(block!.spreads[0]).toBeCloseTo(2.5, 6);
    expect(block!.spreads[1]).toBe(0);
  });

  it("REFUSES an outlined label whose outline colour it cannot read, rather than dropping the outline", async () => {
    const registry = await readyRegistry();
    // The one thing `refusedOutline` still counts. Drawing the fill alone is the failure that looks like a
    // successful render — and on this game's text an outline is most of the difference between readable and not.
    const block = registry.blockFor(spec({ outlinePx: 3, outlineColor: "rgb(0,0,0)" }), layout(), FONT, 1);
    expect(block).toBeNull();
    expect(registry.stats().refusedOutline).toBe(1);
  });

  it("grows the per-run arrays past their starting capacity — 3N runs is not 2N's code path", async () => {
    const registry = await readyRegistry();
    // The pooled block starts at 8 runs. A shadowed, outlined five-line label wants 15, so this is the doubling
    // path in `pushRun` running for real rather than a claim in its comment.
    const block = registry.blockFor(
      spec({ outlinePx: 4, outlineColor: "#000000", shadow: { dx: 1, dy: 1, color: "#000000" } }),
      layout(5),
      FONT,
      1
    );
    expect(block!.runCount).toBe(15);
    expect(block!.origins.length).toBeGreaterThanOrEqual(30);
    expect(block!.spreads.length).toBeGreaterThanOrEqual(15);
    // …and the last run is still the FILL, i.e. nothing was lost or reordered by the growth.
    expect(block!.spreads[14]).toBe(0);
    expect(block!.spreads[9]).toBe(2);
  });
});
