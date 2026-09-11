import { describe, expect, it } from "vitest";

import { createDrawList, createGlyphsView, createQuadView } from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import { parseHtmlColor } from "@/mirror/canvas/glyphPass";
import { dumpCommandLines, glyphDumpLine } from "@/mirror/canvas/paintDump";
import {
  createGlyphFloorCensus,
  createPaintScratch,
  emitTextGlyphs,
  translateTextGlyphBlock,
  type GlyphFloorProbe,
  type OverlayRecord,
  type PaintSink,
  type TextGlyphBlock,
  type TextGlyphSource,
  type TextQuadSource
} from "@/mirror/canvas/paintSpec";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// TEXT AS OUTLINE GLYPH RUNS.
//
// The claims these specs carry are the four that a photograph cannot check and that a wrong answer to would be
// invisible rather than obvious:
//
//   * THE GEOMETRY. A run's matrix must be the raster path's composition with the LINE's pen origin substituted
//     for the ink box's — `record.transform · scale(N about the box centre) · translate(originX, originY)`. Get
//     it wrong by a constant and the text is merely somewhere else, which reads as a layout bug in the game.
//   * THE COLOUR. gsw's fragment writes PREMULTIPLIED coverage into a `premultipliedAlpha: true` canvas, so the
//     one multiplication has to happen here and exactly once. Twice is not a fringe or a crash — it is text that
//     is merely darker, which is the single easiest wrong render to look at and accept.
//   * THE SPREAD. It is the whole of the outline, it is PER RUN, and the view is POOLED — so a run that does not
//     set it inherits the last one's and draws fat. And a scratch view built without the field at all still
//     type-checks against this repo's hand-maintained ambient `.d.ts` and hands gsw `undefined`, whose symptom is
//     an outline that silently never appears. Hence the field-for-field check against gsw's own factory.
//   * THE OFF CONTRACT. Absent a `glyphSource` the built list must be byte-identical, because the offline
//     draw-list oracle has no GL, no wasm and therefore no shaper — and the two text paths must be EXCLUSIVE per
//     label, because drawing both is double ink at a half-pixel offset (a bolder, blurrier label, not a bug).

interface PushedRun {
  m: number[];
  pixelsPerEm: number;
  rgba: [number, number, number, number];
  slots: number[];
  positions: number[];
  glyphCount: number;
  spreadPx: number;
}

function capturingSink(): { sink: PaintSink; pushed: PushedRun[] } {
  const pushed: PushedRun[] = [];
  return {
    pushed,
    sink: {
      quad() {
        throw new Error("a glyph run is never a quad");
      },
      ninePatch() {
        throw new Error("a glyph run is never a nine-patch");
      },
      polyline() {
        throw new Error("a glyph run is never a polyline");
      },
      // COPIED OUT HERE, exactly as gsw's `pushGlyphs` does: the view's `slots`/`positions` are the shaper's own
      // buffers and the next run re-points them, so a sink that retained the arrays would be reading whatever the
      // LAST run wrote. That is the aliasing hazard `emitTextGlyphs` documents, asserted rather than assumed.
      glyphs(view) {
        pushed.push({
          m: [...view.m],
          pixelsPerEm: view.pixelsPerEm,
          rgba: [view.r, view.g, view.b, view.a],
          slots: [...view.slots.subarray(0, view.glyphCount)],
          positions: [...view.positions.subarray(0, view.glyphCount * 2)],
          glyphCount: view.glyphCount,
          spreadPx: view.spreadPx
        });
      }
    }
  };
}

function record(over: Partial<OverlayRecord> = {}): OverlayRecord {
  return {
    id: "label",
    kind: "text",
    transform: [1, 0, 0, 1, 0, 0],
    w: 200,
    h: 60,
    order: 0,
    opacity: 1,
    tintR: 1,
    tintG: 1,
    tintB: 1,
    coveredAbove: false,
    clip: null,
    ...over
  };
}

/**
 * A block in the shape the registry produces: flat pooled buffers, `[start, count]` spans, STRAIGHT colours.
 *
 * `runs` is `[originX, originY, start, count, r, g, b, a, spread?]` per run, which is the whole of what
 * `emitTextGlyphs` reads — writing it as one literal keeps a test's intent on one line instead of across five
 * typed arrays. The spread is last and optional because a fill run's is 0 and most of these are fill runs.
 */
function block(
  runs: readonly (readonly [number, number, number, number, number, number, number, number, number?])[],
  over: { slots?: number[]; positions?: number[]; pixelsPerEm?: number; blockScale?: number } = {}
): TextGlyphBlock {
  const origins = new Float32Array(runs.length * 2);
  const spans = new Int32Array(runs.length * 2);
  const colors = new Float32Array(runs.length * 4);
  const spreads = new Float32Array(runs.length);
  runs.forEach((run, i) => {
    origins[i * 2] = run[0];
    origins[i * 2 + 1] = run[1];
    spans[i * 2] = run[2];
    spans[i * 2 + 1] = run[3];
    colors[i * 4] = run[4];
    colors[i * 4 + 1] = run[5];
    colors[i * 4 + 2] = run[6];
    colors[i * 4 + 3] = run[7];
    spreads[i] = run[8] ?? 0;
  });
  const slots = over.slots ?? [11, 12, 13];
  const positions = over.positions ?? [0, 0, 8, 0, 16, 0];
  return {
    runCount: runs.length,
    origins,
    spans,
    colors,
    spreads,
    slots: Int32Array.from(slots),
    positions: Float32Array.from(positions),
    pixelsPerEm: over.pixelsPerEm ?? 14,
    blockScale: over.blockScale ?? 1
  };
}

function emit(rec: OverlayRecord, b: TextGlyphBlock): { pushed: PushedRun[]; count: number } {
  const { sink, pushed } = capturingSink();
  const count = emitTextGlyphs(rec, b, createPaintScratch(), sink);
  return { pushed, count };
}

// --- the scratch view -------------------------------------------------------------------------------------------

describe("createPaintScratch().glyphs", () => {
  it("is field-for-field gsw's own `createGlyphsView()` — the buffers alone differ, and deliberately", () => {
    const scratch = createPaintScratch(8);
    const view = createGlyphsView();
    expect(Object.keys(scratch.glyphs).sort()).toEqual(Object.keys(view).sort());
    expect([...scratch.glyphs.m]).toEqual([...view.m]);
    expect(scratch.glyphs.pixelsPerEm).toBe(view.pixelsPerEm);
    expect([scratch.glyphs.r, scratch.glyphs.g, scratch.glyphs.b, scratch.glyphs.a]).toEqual([
      view.r,
      view.g,
      view.b,
      view.a
    ]);
    expect(scratch.glyphs.glyphCount).toBe(view.glyphCount);
    // THE FIELD THIS SPEC CAUGHT MISSING. A view built without it type-checks (the ambient `.d.ts` is
    // hand-maintained here) and hands gsw `undefined`, which a Float32Array stores as NaN and gsw clamps back to
    // 0 — i.e. an outline that never appears, with no error anywhere. 0 is the plain fill.
    expect(scratch.glyphs.spreadPx).toBe(view.spreadPx);
    expect(scratch.glyphs.spreadPx).toBe(0);
    // THE ONE DIVERGENCE, and it is the point rather than a lapse: `emitTextGlyphs` POINTS these at the shaper's
    // own arrays rather than copying into them, so anything allocated here would be dead weight on every builder
    // that never draws a glyph — which is every one of them by default.
    expect(scratch.glyphs.slots.length).toBe(0);
    expect(scratch.glyphs.positions.length).toBe(0);
  });
});

// --- the geometry -----------------------------------------------------------------------------------------------

describe("emitTextGlyphs", () => {
  it("puts one run per line at the line's own pen origin, in the record's space", () => {
    const { pushed, count } = emit(
      record({ transform: [1, 0, 0, 1, 300, 120] }),
      block([
        [12, 30, 0, 2, 1, 1, 1, 1],
        [12, 45, 2, 1, 1, 1, 1, 1]
      ])
    );
    expect(count).toBe(2);
    expect(pushed.map((p) => p.m)).toEqual([
      [1, 0, 0, 1, 312, 150],
      [1, 0, 0, 1, 312, 165]
    ]);
    // The SPAN is what selects each run's glyphs out of the shared buffers — a shadow and its fill share one.
    expect(pushed[0].slots).toEqual([11, 12]);
    expect(pushed[0].positions).toEqual([0, 0, 8, 0]);
    expect(pushed[1].slots).toEqual([13]);
    expect(pushed[1].positions).toEqual([16, 0]);
    expect(pushed.every((p) => p.pixelsPerEm === 14)).toBe(true);
  });

  it("folds `blockScale` about the box CENTRE, exactly as the raster path's quad does", () => {
    // `transform-origin: 50% 50%` as an affine collapses to a uniform scale with a `c(1 - s)` offset per axis,
    // and the centre is the RECORD's box — what CSS resolves `50%` against. A card description is the live case
    // (`scale(1.24)`), and getting the origin wrong moves every glyph by a fraction of the box rather than by a
    // fraction of the text, which reads as a label that drifts as the card grows.
    const { pushed } = emit(record({ w: 200, h: 60 }), block([[10, 20, 0, 1, 1, 1, 1, 1]], { blockScale: 2 }));
    expect(pushed[0].m).toEqual([2, 0, 0, 2, 200 / 2 * (1 - 2) + 2 * 10, 60 / 2 * (1 - 2) + 2 * 20]);
  });

  it("carries a rotation through the MATRIX rather than through the pen positions", () => {
    // Not a stylistic preference: gsw's shader dilates each outline by half a SCREEN pixel and works out how far
    // that is by pushing the quad's corner and its normal through this matrix. Pen positions rotated on the CPU
    // would be dilated along the wrong axes — a rim of clipped antialiasing down one side of every glyph.
    const rot: OverlayRecord["transform"] = [0.8, 0.6, -0.6, 0.8, 10, 20];
    const { pushed } = emit(record({ transform: rot }), block([[0, 0, 0, 1, 1, 1, 1, 1]]));
    // `toBeCloseTo` because the view's `m` is a Float32Array — 0.8 does not survive the narrowing exactly, and
    // that is gsw's storage rather than anything this function did.
    [0.8, 0.6, -0.6, 0.8].forEach((want, i) => expect(pushed[0].m[i]).toBeCloseTo(want, 6));
    expect(pushed[0].positions).toEqual([0, 0]);
  });

  it("premultiplies ONCE — the label's own colour times the node's tint and opacity", () => {
    const { pushed } = emit(
      record({ opacity: 0.5, tintR: 1, tintG: 0.5, tintB: 0.25 }),
      block([[0, 0, 0, 1, 0.8, 0.4, 0.2, 1]])
    );
    const [r, g, b, a] = pushed[0].rgba;
    expect(a).toBeCloseTo(0.5, 6);
    expect(r).toBeCloseTo(0.8 * 1 * 0.5, 6);
    expect(g).toBeCloseTo(0.4 * 0.5 * 0.5, 6);
    expect(b).toBeCloseTo(0.2 * 0.25 * 0.5, 6);
    // …and the invariant that a premultiplied triple has to satisfy: no channel above its own alpha. A second
    // multiplication would still satisfy it, which is why the exact products above are asserted too.
    expect(r).toBeLessThanOrEqual(a + 1e-6);
  });

  it("multiplies the RUN's own alpha in — a semi-transparent shadow colour is not the node's opacity", () => {
    const { pushed } = emit(record({ opacity: 1 }), block([[0, 0, 0, 1, 1, 1, 1, 0.25]]));
    expect(pushed[0].rgba).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it("carries each run's own spread — and RE-STATES the 0, because the view is pooled", () => {
    // THE FAILURE THIS PINS is not a missing outline but a spreading one: `scratch.glyphs` is reused run after
    // run, so a fill run that left `spreadPx` alone would inherit the outline run's and draw the label's FILL
    // dilated — a uniformly bolder label, which reads as a font-weight bug rather than as a missing assignment.
    const { pushed } = emit(
      record(),
      block([
        [0, 0, 0, 2, 0, 0, 0, 0.5, 1.5], // the shadow, dilated because the label is outlined
        [0, 0, 0, 2, 0, 0, 0, 1, 1.5], // the outline
        [0, 0, 0, 2, 1, 1, 1, 1] // …and the fill, which must go back to 0
      ])
    );
    expect(pushed.map((p) => p.spreadPx)).toEqual([1.5, 1.5, 0]);
  });

  it("refuses a non-text record, an empty block and a sink that cannot take glyphs", () => {
    expect(emit(record({ kind: "spine" }), block([[0, 0, 0, 1, 1, 1, 1, 1]])).count).toBe(0);
    expect(emit(record(), block([])).count).toBe(0);
    const noGlyphSink: PaintSink = {
      quad() {},
      ninePatch() {},
      polyline() {}
    };
    expect(emitTextGlyphs(record(), block([[0, 0, 0, 1, 1, 1, 1, 1]]), createPaintScratch(), noGlyphSink)).toBe(0);
  });

  it("skips a zero-length run rather than pushing a degenerate one", () => {
    const { pushed, count } = emit(
      record(),
      block([
        [0, 0, 0, 0, 1, 1, 1, 1],
        [0, 10, 0, 2, 1, 1, 1, 1]
      ])
    );
    expect(count).toBe(1);
    expect(pushed[0].glyphCount).toBe(2);
  });
});

// --- the colour parser ------------------------------------------------------------------------------------------

describe("parseHtmlColor", () => {
  it("reads Godot's two `Color.ToHtml` shapes and nothing else", () => {
    expect(parseHtmlColor("#ff8000")).toEqual([1, 128 / 255, 0, 1]);
    expect(parseHtmlColor("ff8000")).toEqual([1, 128 / 255, 0, 1]);
    expect(parseHtmlColor("#ff800080")).toEqual([1, 128 / 255, 0, 128 / 255]);
  });

  it("REFUSES anything else rather than falling back to a colour nobody asked for", () => {
    // The raster path hands `spec.color` straight to `fillStyle`, so every CSS notation works there. This path
    // needs numbers, and a default (white, say) for a notation it cannot read would draw the label in
    // confidently the wrong colour — which is worse than the label simply rastering as it does today.
    for (const bad of ["rgb(1,2,3)", "red", "#fff", "", null, undefined, "#gggggg"]) {
      expect(parseHtmlColor(bad)).toBeNull();
    }
  });
});

// --- the off contract and the exclusivity -----------------------------------------------------------------------

function stateWithLabel(): MirrorState {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: ["label"],
      upserts: [
        {
          id: "label",
          parentId: null,
          name: "label",
          nodeType: "Godot.Label",
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 20, y: 30 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 120, y: 40 } },
          visible: true,
          text: { text: "hello", fontSizePx: 14 }
        }
      ]
    })!
  );
  return state;
}

function listFor(options: { glyphSource?: TextGlyphSource | null; textSource?: TextQuadSource | null }) {
  const list = createDrawList<string>();
  const built = buildDrawList(stateWithLabel(), list, { ...options, hitTest: false });
  return { list, built };
}

describe("buildDrawList with the glyph path", () => {
  it("is byte-identical with no glyphSource — the offline oracle has no shaper and must build the same list", () => {
    const withNone = listFor({});
    const withNull = listFor({ glyphSource: null });
    expect(withNone.list.count).toBe(withNull.list.count);
    expect([...withNone.list.floats.subarray(0, 64)]).toEqual([...withNull.list.floats.subarray(0, 64)]);
    expect(withNone.built.stats.textGlyphLabels).toBe(0);
    expect(withNone.built.stats.textGlyphRuns).toBe(0);
    expect(withNone.built.stats.glyphRuns).toBe(0);
  });

  it("draws a label as runs and NOT also as a quad — the two paths are exclusive per label", () => {
    let rasterAsked = 0;
    const glyphSource: TextGlyphSource = {
      blockFor: () => block([[0, 0, 0, 2, 1, 1, 1, 1]])
    };
    const textSource: TextQuadSource = {
      boxFor: () => {
        rasterAsked++;
        return null;
      }
    };
    const { list, built } = listFor({ glyphSource, textSource });
    expect(built.stats.textGlyphLabels).toBe(1);
    expect(built.stats.textGlyphRuns).toBe(1);
    expect(built.stats.glyphRuns).toBe(1);
    expect(built.stats.textQuads).toBe(0);
    // NOT ASKED AT ALL, rather than asked and ignored: resolving and rastering a label whose outlines are already
    // in the list would pay for a texture upload nothing will ever sample.
    expect(rasterAsked).toBe(0);
    // …and the label is published as canvas-drawn, so the overlay drops its element exactly as for a raster. A
    // label drawn as outlines that kept a hoisted element would render twice.
    expect(built.textQuadIds.has("label")).toBe(true);
    expect(list.kindNameAt(list.count - 1)).toBe("glyphs");
  });

  it("falls through to the raster path on every glyph refusal", () => {
    let rasterAsked = 0;
    const { built } = listFor({
      glyphSource: { blockFor: () => null },
      textSource: {
        boxFor: () => {
          rasterAsked++;
          return null;
        }
      }
    });
    expect(built.stats.textGlyphLabels).toBe(0);
    expect(rasterAsked).toBe(1);
  });

  it("keeps a rich label's glyph and inline-image commands at its one painter index", () => {
    const state = stateWithLabel();
    state.nodes.get("label")!.richText = true;
    let rasterAsked = 0;
    const list = createDrawList<string>();
    const built = buildDrawList(state, list, {
      glyphSource: {
        blockFor: () => {
          throw new Error("rich labels must use their ordered emitter");
        },
        emitRich: (_input, rec, scratch, sink) => {
          const glyphs = emitTextGlyphs(rec, block([[0, 12, 0, 2, 1, 1, 1, 1]]), scratch, sink);
          const quad = scratch.quad;
          quad.m.set([1, 0, 0, 1, 24, 6]);
          quad.w = 10;
          quad.h = 10;
          quad.srcX = 0;
          quad.srcY = 0;
          quad.srcW = 10;
          quad.srcH = 10;
          quad.r = quad.g = quad.b = quad.a = 1;
          quad.flipH = quad.flipV = false;
          quad.hasColorMatrix = false;
          quad.blend = 0;
          sink.quad(quad, "inline-image");
          return glyphs + 1;
        }
      },
      textSource: {
        boxFor: () => {
          rasterAsked++;
          return null;
        }
      },
      hitTest: false
    });
    expect([...Array(list.count).keys()].map((i) => list.kindNameAt(i)).slice(-2)).toEqual(["glyphs", "quad"]);
    expect(built.textQuadIds).toEqual(new Set(["label"]));
    expect(rasterAsked).toBe(0);
  });

  it("does not let a pending rich source fall through to a raster/DOM substitute", () => {
    const state = stateWithLabel();
    state.nodes.get("label")!.richText = true;
    let rasterAsked = 0;
    const built = buildDrawList(state, createDrawList<string>(), {
      glyphSource: { blockFor: () => null, emitRich: () => "pending" },
      textSource: {
        boxFor: () => {
          rasterAsked++;
          return null;
        }
      },
      hitTest: false
    });
    expect(built.textQuadIds.size).toBe(0);
    expect(rasterAsked).toBe(0);
  });

  it("keeps every rich record pending when two labels share one cold face", () => {
    const state = stateWithLabel();
    const first = state.nodes.get("label")!;
    first.richText = true;
    const second = { ...first, id: "label-2", richText: true };
    state.nodes.set(second.id, second);
    state.orderedIds = ["label", "label-2"];
    const pending: string[] = [];
    const built = buildDrawList(state, createDrawList<string>(), {
      glyphSource: {
        blockFor: () => null,
        emitRich: (_input, rec) => {
          pending.push(rec.id);
          return "pending";
        }
      },
      hitTest: false
    });
    expect(pending).toEqual(["label", "label-2"]);
    expect(built.textQuadIds.size).toBe(0);
  });
});

describe("rich glyph fragment placement", () => {
  it("translates shadow, outline and fill together without erasing the shadow offset", () => {
    const shaped = block([
      [3, 7, 0, 1, 0, 0, 0, 1],
      [0, 0, 0, 1, 1, 1, 1, 1],
      [0, 0, 0, 1, 1, 1, 1, 1]
    ]);
    translateTextGlyphBlock(shaped, 20, 40);
    expect([...shaped.origins]).toEqual([23, 47, 20, 40, 20, 40]);
  });
});

// --- the paint dump's `G` line (R-A4) ----------------------------------------------------------------------------
//
// THE BUG THIS BLOCK PINS, and it shipped on the arm the text harness actually runs (`probe-text-scratch.mjs`
// asks for the canvas stage with `paintDump=1`).
// `drawListDump` dispatched on THREE kinds — nine-patch, polyline, everything else — and "everything else" called
// `readQuad`. gsw's `requireKind` refuses to read a `glyphs` command as a quad, correctly: its payload is not a
// quad payload. So the first glyph run in the list threw, `window.__mirrorDrawListDump()` returned nothing at
// all, and the paint dump is therefore a parity
// gate could only ever see a text path the game does not use.
//
// Two claims, and the first is the one a regression would break silently:
//
//   * READING THE COMMAND DOES NOT THROW. Asserted against the same list, both ways: `readQuad` on that index
//     still throws (that IS the shipped fallthrough, so the spec would pass vacuously if it stopped throwing for
//     some other reason), and `dumpCommandLines` over the same list does not.
//   * THE LINE IS PARSEABLE BY `compare-paint-dumps.mjs`'s RULE — split on spaces, read `k=v`. A field with a
//     space in it truncates silently for every reader, which is how the `text://` key had to become an ordinal.

describe("the paint dump's G line", () => {
  /** A list with a real DRAW_GLYPHS command in it, plus the build's ranges — what the dump is handed. */
  function dumpOf(over: Parameters<typeof block>[1] = {}, runs?: Parameters<typeof block>[0]) {
    const glyphSource: TextGlyphSource = {
      blockFor: () => block(runs ?? [[5, 7, 0, 3, 1, 0.5, 0.25, 1, 1.5]], over)
    };
    const state = stateWithLabel();
    const list = createDrawList<string>();
    const built = buildDrawList(state, list, { glyphSource, hitTest: false });
    return { state, list, built };
  }

  function lines(d: ReturnType<typeof dumpOf>): string[] {
    return dumpCommandLines({
      list: d.list,
      nodes: d.state.nodes,
      ranges: d.built.ranges,
      clipPushes: new Map([...d.built.clipRanges].map(([id, r]) => [id, r.push])),
      // A glyph run never asks for a role (it is `glyph` by construction), so a roleOf that throws proves it.
      roleOf: () => {
        throw new Error("a glyph run must not be asked for a quad role");
      }
    });
  }

  it("dumps a G line for a DRAW_GLYPHS command instead of throwing", () => {
    const d = dumpOf();
    const at = d.list.count - 1;
    expect(d.list.kindNameAt(at)).toBe("glyphs");
    // THE SHIPPED FALLTHROUGH, still throwing — so the assertion below is about the DUMP and not about gsw
    // having quietly started to tolerate the read.
    expect(() => d.list.readQuad(at, createQuadView())).toThrow();
    const out = lines(d);
    const g = out.filter((l) => l.startsWith("G "));
    expect(g).toHaveLength(1);
  });

  it("carries the run's matrix, size, glyph count, pens, premultiplied colour and spread", () => {
    // transform (20, 30) from `stateWithLabel`, pen origin (5, 7), blockScale 1 -> the run's own origin is the
    // sum, which is the composition `emitTextGlyphs` documents.
    const g = lines(dumpOf()).find((l) => l.startsWith("G "))!;
    expect(g).toContain("G 0 label glyphs role=glyph type=Label");
    expect(g).toContain("m=1.000,0.000,0.000,1.000,25.000,37.000");
    expect(g).toContain("ppem=14.000");
    expect(g).toContain("count=3");
    // The FIRST and LAST pen, in the run's own space and BEFORE `m` — never `p0`/`p1`, which a polyline prints
    // in DESIGN space. Two meanings under one key name is the mistake the `tscale` row exists to undo.
    expect(g).toContain("pen0=0.000,0.000");
    expect(g).toContain("pen1=16.000,0.000");
    // PREMULTIPLIED, as every `C` line's rgba is: the block's straight (1, 0.5, 0.25, 1) with alpha 1.
    expect(g).toContain("rgba=1.000,0.500,0.250,1.000");
    expect(g).toContain("spread=1.500");
    expect(g).toContain("clip=-");
  });

  it("is parseable by the comparer's rule — split on spaces, every field a `k=v` with no spaces in it", () => {
    const g = lines(dumpOf()).find((l) => l.startsWith("G "))!;
    const parts = g.split(" ");
    expect(parts[0]).toBe("G");
    expect(Number.isInteger(Number(parts[1]))).toBe(true);
    expect(parts[2]).toBe("label");
    expect(parts[3]).toBe("glyphs");
    const fields = new Map(parts.slice(4).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
    expect([...fields.keys()]).toEqual([
      "role",
      "type",
      "m",
      "ppem",
      "count",
      "pen0",
      "pen1",
      "rgba",
      "spread",
      "clip"
    ]);
    for (const [key, value] of fields) {
      expect(value, `${key} must not be empty`).not.toBe("");
      expect(value, `${key} must carry no space`).not.toContain(" ");
    }
  });

  it("shares the paint counter with the C lines, so a run's index is its true paint rank", () => {
    // Two runs (an outline and its fill) after nothing else: paint ranks 0 and 1.
    const d = dumpOf({}, [
      [5, 7, 0, 3, 0, 0, 0, 1, 1.5],
      [5, 7, 0, 3, 1, 1, 1, 1]
    ]);
    const g = lines(d).filter((l) => l.startsWith("G "));
    expect(g).toHaveLength(2);
    expect(g[0].startsWith("G 0 label ")).toBe(true);
    expect(g[1].startsWith("G 1 label ")).toBe(true);
    // The outline is the one with the spread, and it is FIRST — outline under fill. A dump that lost the order
    // would read identically field for field and describe a label drawn the wrong way round.
    expect(g[0]).toContain("spread=1.500");
    expect(g[1]).toContain("spread=0.000");
  });

  it("prints `-` pens for an empty run rather than reading past the buffer", () => {
    // `emitTextGlyphs` skips a zero-count run, so this is reached only through a hand-built view — which is
    // exactly what a partially-patched list could hand a dump.
    const view = createGlyphsView(4);
    view.glyphCount = 0;
    expect(glyphDumpLine(3, "n", "Label", view, "Dialog")).toContain("count=0 pen0=- pen1=-");
    expect(glyphDumpLine(3, "n", "Label", view, "Dialog")).toContain("clip=Dialog");
  });
});

// --- the fidelity-floor census, `textGlyphs.belowFloorTrue` (R-A4) -----------------------------------------------
//
// PUBLISH, THEN GATE. Nothing here refuses a run or moves a pixel; it counts the runs this build emitted at a
// device ppem HarfBuzz's coverage shader approximates at, so that "does the glyph path
// drawing this screen's text blurrier than `off` would" becomes a number instead of an argument.
//
// THE ARITHMETIC IS THE CLAIM. It must be `pixelsPerEm x meanAxis(the COMPOSED matrix) x perDesignPx`, which is
// the same product `glyphPass`'s own `auto` gate reaches from the other end as
// `spec.fontPx * spec.blockScale * deviceScale`. Drop the parent scale, or the block scale, or the stage's
// design-to-device factor and the counter still counts something — it just counts it at a size nothing draws the
// label at, which is a counter that reads 0 on exactly the screens worth reporting.

describe("the ppem fidelity floor, counted at emission", () => {
  function probe(perDesignPx: number) {
    const below: { id: string; ppem: number }[] = [];
    return {
      below,
      floor: {
        get perDesignPx() {
          return perDesignPx;
        },
        below(id: string, ppem: number) {
          below.push({ id, ppem });
        }
      } satisfies GlyphFloorProbe
    };
  }

  it("counts a run whose DEVICE ppem lands under the floor", () => {
    // 14 design px per em, at DPR 1 and no scale anywhere: 14 < 16.
    const p = probe(1);
    const { sink } = capturingSink();
    expect(emitTextGlyphs(record(), block([[0, 0, 0, 3, 1, 1, 1, 1]]), createPaintScratch(), sink, p.floor)).toBe(1);
    expect(p.below).toHaveLength(1);
    expect(p.below[0].id).toBe("label");
    expect(p.below[0].ppem).toBeCloseTo(14, 6);
  });

  it("counts NOTHING once the same label is drawn big enough — the healthy case is 0, not merely small", () => {
    const p = probe(2); // a 2x device ratio takes the same 14px label to ppem 28
    const { sink } = capturingSink();
    emitTextGlyphs(record(), block([[0, 0, 0, 3, 1, 1, 1, 1]]), createPaintScratch(), sink, p.floor);
    expect(p.below).toHaveLength(0);
  });

  it("reads the PARENT's scale out of the matrix — the leg gsw's counter had to be taught", () => {
    // A 20px label is comfortably over the floor at DPR 1 (20 >= 16) and is NOT over it inside a parent scaled
    // to 0.6 (12). A counter that priced the run at `pixelsPerEm x dpr` alone would report this screen as crisp.
    const p = probe(1);
    const { sink } = capturingSink();
    emitTextGlyphs(
      record({ transform: [0.6, 0, 0, 0.6, 100, 100] }),
      block([[0, 0, 0, 3, 1, 1, 1, 1]], { pixelsPerEm: 20 }),
      createPaintScratch(),
      sink,
      p.floor
    );
    expect(p.below).toHaveLength(1);
    expect(p.below[0].ppem).toBeCloseTo(12, 6);
  });

  it("reads the card rules' BLOCK scale too — the other half of the same product", () => {
    // 14px at blockScale 1.24 is 17.36, over the floor; the same label without it is 14 and under.
    const scaled = probe(1);
    const { sink: sinkA } = capturingSink();
    emitTextGlyphs(
      record(),
      block([[0, 0, 0, 3, 1, 1, 1, 1]], { blockScale: 1.24 }),
      createPaintScratch(),
      sinkA,
      scaled.floor
    );
    expect(scaled.below).toHaveLength(0);
    const plain = probe(1);
    const { sink: sinkB } = capturingSink();
    emitTextGlyphs(record(), block([[0, 0, 0, 3, 1, 1, 1, 1]]), createPaintScratch(), sinkB, plain.floor);
    expect(plain.below).toHaveLength(1);
  });

  it("asks ONCE PER RUN, so an outlined label under the floor counts its outline as well as its fill", () => {
    // `belowFloorTrue` is in the same units as `DrawListStats.textGlyphRuns` — draw calls — and an outlined line
    // is two of them. Counting per LABEL here would make the two incomparable.
    const p = probe(1);
    const { sink } = capturingSink();
    const pushed = emitTextGlyphs(
      record(),
      block([
        [0, 0, 0, 3, 0, 0, 0, 1, 1.5],
        [0, 0, 0, 3, 1, 1, 1, 1]
      ]),
      createPaintScratch(),
      sink,
      p.floor
    );
    expect(pushed).toBe(2);
    expect(p.below).toHaveLength(2);
  });

  it("reports a DEGENERATE matrix as below the floor rather than silently as fine", () => {
    // `!(ppem >= floor)` and not `ppem < floor`: a NaN axis compares false against everything, so the second
    // spelling would call a run nobody can measure crisp.
    const p = probe(Number.NaN);
    const { sink } = capturingSink();
    emitTextGlyphs(record(), block([[0, 0, 0, 3, 1, 1, 1, 1]]), createPaintScratch(), sink, p.floor);
    expect(p.below).toHaveLength(1);
    expect(Number.isNaN(p.below[0].ppem)).toBe(true);
  });

  it("is ABSENT BY DEFAULT and changes not one float — the offline oracle's byte-identical rule", () => {
    const withProbe = createDrawList<string>();
    const withNone = createDrawList<string>();
    const glyphSource: TextGlyphSource = { blockFor: () => block([[0, 0, 0, 3, 1, 1, 1, 1]]) };
    const p = probe(1);
    buildDrawList(stateWithLabel(), withProbe, { glyphSource, glyphFloor: p.floor, hitTest: false });
    buildDrawList(stateWithLabel(), withNone, { glyphSource, hitTest: false });
    expect(withProbe.count).toBe(withNone.count);
    expect([...withProbe.floats.subarray(0, 64)]).toEqual([...withNone.floats.subarray(0, 64)]);
    // …and the probe DID see the build, so the equality above is not vacuous.
    expect(p.below).toHaveLength(1);
  });
});

// --- the census that the renderer publishes from -----------------------------------------------------------------

describe("createGlyphFloorCensus", () => {
  function census(over: { perDesignPx?: number } = {}) {
    const warnings: string[] = [];
    const c = createGlyphFloorCensus({
      perDesignPx: () => over.perDesignPx ?? 1,
      describe: (id) => `res://scenes/Combat.tscn TopBar/${id}`,
      warn: (m) => warnings.push(m)
    });
    return { c, warnings };
  }

  function emitUnder(c: ReturnType<typeof census>["c"], id: string, runs = 1): void {
    const { sink } = capturingSink();
    emitTextGlyphs(
      record({ id }),
      block(Array.from({ length: runs }, () => [0, 0, 0, 3, 1, 1, 1, 1] as const)),
      createPaintScratch(),
      sink,
      c.probe
    );
  }

  it("counts every run and is cumulative across builds", () => {
    const { c } = census();
    expect(c.runs).toBe(0);
    emitUnder(c, "a", 2);
    expect(c.runs).toBe(2);
    emitUnder(c, "b", 3);
    expect(c.runs).toBe(5);
  });

  it("warns ONCE per session, naming the FIRST offender's scene path, id and measured ppem", () => {
    const { c, warnings } = census();
    emitUnder(c, "GoldLabel");
    emitUnder(c, "EnergyLabel", 4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("res://scenes/Combat.tscn TopBar/GoldLabel");
    expect(warnings[0]).toContain("(id GoldLabel)");
    expect(warnings[0]).toContain("ppem 14.00");
    // …and it says what the number is and where to read the rest, because a warning that only says "this is bad"
    // sends the next reader looking for a counter they have no name for.
    expect(warnings[0]).toContain("belowFloorTrue");
    expect(warnings[0]).toContain("lower-fidelity glyph approximation");
    // The count keeps climbing after the warning has been spent — the latch is on the console, not the census.
    expect(c.runs).toBe(5);
  });

  it("says nothing at all when every run clears the floor", () => {
    const { c, warnings } = census({ perDesignPx: 2 });
    emitUnder(c, "GoldLabel", 3);
    expect(c.runs).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("re-reads `perDesignPx` per run, so a resize is followed rather than latched at construction", () => {
    // The stage's fit-to-screen factor changes when the window does, and a census built at boot would otherwise
    // price every later run at the ratio the page happened to open with.
    let ratio = 2;
    const warnings: string[] = [];
    const c = createGlyphFloorCensus({
      perDesignPx: () => ratio,
      describe: (id) => id,
      warn: (m) => warnings.push(m)
    });
    emitUnder(c, "a");
    expect(c.runs).toBe(0);
    ratio = 1;
    emitUnder(c, "a");
    expect(c.runs).toBe(1);
  });
});
