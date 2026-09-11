import { beforeEach, describe, expect, it, vi } from "vitest";

// FACE COVERAGE THROUGH THE GLYPH PATH — `glyphPass.blockFor`'s refusal for a codepoint the streamed face does
// not carry, and the only refusal in that function added because the path was drawing something WRONG rather
// than nothing.
//
// THE BUG THIS PINS. `fillRun` shapes through the one
// streamed face and hb-gpu has no fallback chain, where the raster path's `fillText` gets the browser's. So a
// codepoint the face has no glyph for came back as `.notdef` — and `.notdef` in this game's faces HAS INK
// (3168 texel bytes in `kreon_regular`, measured), so the label rendered as a row of TOFU BOXES. The raster path
// renders the same label correctly. The recorded-corpus audit covered every recording in the bench
// dir: of 960 distinct label specs and 12318 codepoints, exactly one label is affected — `"Русский"` in the
// language menu, 7/7 `.notdef` — which is precisely why a screenshot never caught it.
//
// FOUR CLAIMS, and each is a way to "fix" this that would still be wrong:
//
//   * THE LABEL IS REFUSED, so it falls through to the raster path and renders through the browser's fallback.
//     Drawing it anyway is the shipped bug; drawing it with the uncovered glyphs DROPPED would be worse still,
//     since a silently shortened word reads as correct text.
//   * THE REFUSAL IS PER LABEL, NOT PER RUN. A mixed-script string with a covered first line and an uncovered
//     second must not put the glyph path on one line and the raster on the next: their baselines, stem weights
//     and sub-pixel phases are close but not equal, which is the same visible shake `mirrorSettings`'
//     the shipped glyph path deliberately avoids.
//   * IT IS COUNTED. `refusedCoverage` is what lets the next census see this from
//     `window.__mirrorCanvasStats().textGlyphs` instead of by eye — a silent refusal being how the class
//     survived in the first place.
//   * IT ASKS ABOUT CODE POINTS, NOT CODE UNITS. A cmap is keyed by code point; walking UTF-16 units would ask
//     the face about a lone surrogate, which is not a character and which every face answers 0 for — so an
//     astral codepoint would be "refused" for the wrong reason and, worse, a COVERED astral one would be
//     refused too. No ASCII test can tell the two implementations apart.
//
// The pass, the wasm and the shaper are STUBBED, as in `canvasGlyphOutline.spec.ts` — the real ones need a GL
// context, a multi-MiB wasm and a font file, and none of the four claims get easier to check with them. What is
// NOT invented is which codepoints are missing: {@link UNCOVERED} was read out of the real `kreon_regular` face.

/**
 * Codepoints `kreon_regular` genuinely has NO GLYPH for — `hb_font_get_nominal_glyph` answers 0.
 *
 * MEASURED, NOT ASSUMED, against `kreon_regular.ttf` in the local extracted-resource root, through hb-gpu's own
 * wasm; the same
 * lookup used by the recorded-corpus audit, whose pass agrees with the shaped ground truth on all 960 specs.
 * The six Cyrillic letters are exactly the ones in `"Русский"`, the language menu's own label.
 *
 * Anything not listed answers non-zero, which is the fail-safe direction for a spec: a typo'd character would be
 * treated as covered and the refusal assertions would go RED rather than pass for the wrong reason.
 */
const UNCOVERED = new Set([
  0x0420, // Р   CYRILLIC CAPITAL ER
  0x0443, // у   CYRILLIC SMALL U
  0x0441, // с   CYRILLIC SMALL ES
  0x0441, // (dedup; `"Русский"` repeats с)
  0x0441,
  0x043a, // к   CYRILLIC SMALL KA
  0x0438, // и   CYRILLIC SMALL I
  0x0439, // й   CYRILLIC SMALL SHORT I
  0x2191, // ↑   UPWARDS ARROW — the debug console's own missing glyph
  0x0009, // TAB
  0x200b, // ZERO WIDTH SPACE
  0x1f600 // 😀  an ASTRAL codepoint, for the code-point-vs-code-unit claim
]);

const shapedGlyphs = 3;

/** Every codepoint `blockFor` asked the face about, in order — the code-unit claim is checked against this. */
const asked: number[] = [];

/** A stand-in for gsw's `HbGpuGlyphPass`, with `glyphFor` answering for the REAL face. See {@link UNCOVERED}. */
const fakePass = {
  stats: {
    slots: 0,
    runs: 0,
    glyphs: 0,
    inkless: 0,
    reuploads: 0,
    dropped: 0,
    runsBelowPpemFloor: 0
  },
  registerFace: vi.fn(() => ({ font: {}, face: { id: 1, upem: 1000 }, upem: 1000, label: "kreon_regular" })),
  slotFor: vi.fn(() => 1),
  glyphFor: vi.fn((_face: unknown, codepoint: number) => {
    asked.push(codepoint);
    return UNCOVERED.has(codepoint) ? 0 : 1;
  }),
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

import { createGlyphPassRegistry } from "@/mirror/canvas/glyphPass";
import type { TextLayout, TextSpec } from "@/mirror/canvas/textLayout";
import type { MirrorFont } from "@/mirror/sceneTree";

const METRICS = { ascent: 12, descent: 3 };
const FONT: MirrorFont = {
  family: "kreon_regular",
  url: "/res/fonts/kreon_regular.ttf",
  weight: null,
  style: null
};

/** Only the fields `blockFor` reads. */
function spec(over: Partial<TextSpec> = {}): TextSpec {
  return {
    text: "End Turn",
    cssFont: '22px "kreon_regular"',
    family: "kreon_regular",
    fontPx: 22,
    color: "#ffffff",
    outlinePx: 0,
    outlineColor: null,
    shadow: null,
    align: "left",
    blockAlign: "start",
    blockAlignY: "start",
    boxW: 200,
    boxH: 40,
    contentW: 200,
    pitchPx: 24,
    paragraphGapPx: 0,
    whiteSpace: "pre-wrap",
    blockScale: 1,
    ...over
  } as TextSpec;
}

/** A layout over the given line texts — what `blockFor` walks, and what the coverage gate reads. */
function layout(...lines: string[]): TextLayout {
  return {
    lines: lines.map((text, i) => ({ text, width: 24, x: 5, y: i * 24 })),
    blockW: 24,
    blockH: lines.length * 24,
    wrapped: lines.length > 1
  };
}

/** A registry whose pass and face have both landed — the state every assertion below is about. */
async function readyRegistry() {
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
  await vi.waitFor(() => expect(registry.stats().ready).toBe(true));
  // The FIRST `blockFor` is what arms the face fetch, so it refuses with `refusedNoFace` however ready the pass
  // is. An all-covered label, so it cannot spend the coverage counter these specs are about.
  registry.blockFor(spec(), layout("End Turn"), FONT, 1);
  await vi.waitFor(() => expect(registry.stats().faces).toBe(1));
  return registry;
}

describe("glyphPass.blockFor and face coverage", () => {
  beforeEach(() => {
    fakePass.fillRun.mockClear();
    fakePass.glyphFor.mockClear();
    asked.length = 0;
  });

  it("REFUSES the language menu's own label rather than drawing seven tofu boxes", async () => {
    const registry = await readyRegistry();
    fakePass.fillRun.mockClear();
    // The real string, at its real size, against the real face's real coverage gap. Every one of its seven
    // letters answers `.notdef`, and `.notdef` has ink — so before the gate this drew seven boxes.
    const block = registry.blockFor(spec({ text: "Русский" }), layout("Русский"), FONT, 1);
    expect(block).toBeNull();
    expect(registry.stats().refusedCoverage).toBe(1);
    // …and it is refused BEFORE shaping, which is not a performance nicety: shaping a tofu run also uploads the
    // `.notdef` outline into the atlas, where it then occupies a slot for the life of the page.
    expect(fakePass.fillRun).not.toHaveBeenCalled();
  });

  it("still draws a label the face fully covers, and spends no coverage refusal doing it", async () => {
    const registry = await readyRegistry();
    const block = registry.blockFor(spec({ text: "End Turn" }), layout("End Turn"), FONT, 1);
    expect(block).not.toBeNull();
    expect(block!.runCount).toBe(1);
    expect(registry.stats().refusedCoverage).toBe(0);
  });

  it("refuses the WHOLE label when only one line is uncovered — never half glyph path, half raster", async () => {
    const registry = await readyRegistry();
    fakePass.fillRun.mockClear();
    // The mixed-script case. Refusing per RUN would draw line 1 through hb-gpu and line 2 through `fillText`,
    // two rasterizers on adjacent lines of one label — the shake `auto` was kept out of the defaults for.
    const block = registry.blockFor(
      spec({ text: "Language\nРусский" }),
      layout("Language", "Русский"),
      FONT,
      1
    );
    expect(block).toBeNull();
    expect(registry.stats().refusedCoverage).toBe(1);
    // The covered line must not have been shaped either: a block is only ever pushed whole, so a partially
    // filled one is exactly the state that could leak a half-drawn label.
    expect(fakePass.fillRun).not.toHaveBeenCalled();
  });

  it("asks the face about CODE POINTS, never about a lone surrogate", async () => {
    const registry = await readyRegistry();
    // "😀" is ONE code point (U+1F600) and TWO UTF-16 code units (D83D DE00). A `for (let i = 0; i < s.length)`
    // walk would ask about 0xD83D — which every face answers 0 for, so the label would still be refused and the
    // test would still be green while the implementation was wrong for every astral character.
    const block = registry.blockFor(spec({ text: "hi \u{1F600}" }), layout("hi \u{1F600}"), FONT, 1);
    expect(block).toBeNull();
    expect(asked).toEqual([0x68, 0x69, 0x20, 0x1f600]);
    expect(asked.some((cp) => cp >= 0xd800 && cp <= 0xdfff)).toBe(false);
  });

  it("counts each refused label once, and leaves the other refusal counters alone", async () => {
    const registry = await readyRegistry();
    registry.blockFor(spec({ text: "Русский" }), layout("Русский"), FONT, 1);
    registry.blockFor(spec({ text: "Русский" }), layout("Русский"), FONT, 1);
    const stats = registry.stats();
    expect(stats.refusedCoverage).toBe(2);
    // The gate must not be mistaken for one of the timing refusals: those are read as "the face has not landed
    // yet" and would send someone looking at the font loader instead of at the character set. `refusedNoFace` is
    // 1 and stays 1 — that one is `readyRegistry`'s own priming call, which is what ARMS the face fetch.
    expect(stats.refusedNoFace).toBe(1);
    expect(stats.refusedNoMetrics).toBe(0);
    expect(stats.refusedShape).toBe(0);
    expect(stats.refusedOutline).toBe(0);
  });
});
