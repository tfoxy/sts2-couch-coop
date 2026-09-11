import { describe, expect, it, vi } from "vitest";

// THE CONTRAST CURVE THIS APP MOUNTS THE GLYPH PATH WITH — one option on one `createHbGpuGlyphPass` call, and the
// only thing in this repo that decides how heavy every GPU-drawn glyph on the screen is.
//
// WHY IT NEEDS A SPEC AT ALL, given it is a single property. Because there is no other way to see it. hb-gpu's
// stem darkening is EDGE-ONLY (gated on partial coverage) and ramps off by ppem 48, so dropping the option
// changes no layout, no counter, no `data-*` attribute and no drawlist byte — it changes the width of the
// anti-aliasing ramp on every letter. A regression here reads as "the text looks a bit heavier", which is
// exactly the class of thing that survives a review and a screenshot.
//
// AND THE VALUE IS gsw's OWN CONSTANT, imported rather than transcribed. `{ gamma: 1, stemDarkening: false }`
// written out here would still pass if gsw renamed a field or added a third one — the check has to be identity
// with the thing the renderer actually reads, which is why `@godot-scene-web/hb-gpu/webgl` is deliberately NOT
// mocked below while everything else is.
//
// The pass, the wasm and the shaper are stubbed, as in `canvasGlyphOutline.spec.ts` and for the same reason: the
// real ones need a GL context, a multi-MiB wasm and a font file, and none of them make the option easier to see.

/** Every options object `createGlyphPassRegistry` handed to gsw. One per registry that got as far as building. */
const mounted: Record<string, unknown>[] = [];

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
  registerFace: vi.fn(() => ({ font: {}, face: { id: 1, upem: 1000 }, upem: 1000, label: "fake" })),
  slotFor: vi.fn(() => 1),
  glyphFor: vi.fn(() => 1),
  fillRun: vi.fn(() => true),
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
  createHbGpuGlyphPass: (options: Record<string, unknown>) => {
    mounted.push(options);
    return fakePass;
  }
}));

vi.mock("@godot-scene-web/hb-gpu", () => ({
  createHbGpu: async () => ({ destroy: vi.fn(), createFont: vi.fn() })
}));

vi.mock("@godot-scene-web/hb-gpu/vendor/hb-gpu.mjs", () => ({ default: vi.fn() }));

vi.mock("@godot-scene-web/hb-gpu/vendor/hb-gpu.wasm?url", () => ({ default: "/hb-gpu.wasm" }));

// NOT MOCKED, on purpose — see the header. This is gsw's real frozen constant, out of the same module the
// renderer resolves its own default from.
import { HB_GPU_CONTRAST_DEFAULT, HB_GPU_CONTRAST_NONE } from "@godot-scene-web/hb-gpu/webgl";

import { createGlyphPassRegistry } from "@/mirror/canvas/glyphPass";

/** A registry whose wasm build has settled. The face is not needed: nothing here draws. */
async function mountedOptions(): Promise<Record<string, unknown>> {
  mounted.length = 0;
  // The wasm FETCH is real code even with the module stubbed — `build()` fetches the url before instantiating —
  // and jsdom has no server to answer it.
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
    metrics: () => ({ ascent: 12, descent: 3 }),
    fetchBytes: async () => new Uint8Array(4)
  });
  await vi.waitFor(() => expect(registry.stats().ready).toBe(true));
  expect(mounted).toHaveLength(1);
  return mounted[0];
}

describe("the glyph pass is mounted at Godot-parity contrast", () => {
  it("passes HB_GPU_CONTRAST_NONE, gsw's own constant", async () => {
    // GODOT APPLIES NO CONTRAST CURVE — its grayscale and MSDF glyph interiors come out byte-uniform — and this
    // screen is a mirror of Godot, not a page of DOM text. gsw's A1 crossover sweep also measures the shipped
    // curve as the whole quality gap: at ppem 16 the glyph path grades 0.1091 with it and 0.0258 without, where
    // canvas2d is 0.0925 — i.e. WITH the curve it loses to a plain `fillText`. See the call site.
    const options = await mountedOptions();
    expect(options.contrast).toBe(HB_GPU_CONTRAST_NONE);
  });

  it("does not mount at the shipped default, which is the setting this exists to override", async () => {
    // The negative half, spelled out rather than implied by the positive one: `HB_GPU_CONTRAST_DEFAULT` is what
    // an OMITTED option resolves to inside gsw's renderer, so "no contrast key at all" and "the wrong contrast"
    // are the same regression from this app's side and both have to be red.
    const options = await mountedOptions();
    expect(options.contrast).not.toBe(HB_GPU_CONTRAST_DEFAULT);
    expect(options.contrast).not.toBeUndefined();
    expect(options.contrast).toMatchObject({ stemDarkening: false });
  });
});
