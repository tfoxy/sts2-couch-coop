import { describe, expect, it } from "vitest";

import { BLEND_ADD, createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import {
  createPaintScratch,
  emitTextQuad,
  type OverlayRecord,
  type PaintSink,
  type TextQuadBox,
  type TextQuadSource,
  type TextSnap
} from "@/mirror/canvas/paintSpec";
import { TEXT_KEY_PREFIX } from "@/mirror/canvas/textSurfaces";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// TEXT INTO THE CANVAS (M4).
//
// Probe P6 counted, per recording, the visible nodes painting LATER than a text node whose box they cover: 7% on
// the map, 32-46% on combat/shop/reward, 70-73% on deck view and reshuffle. Those are all cases where the game
// paints OVER a label and the DOM overlay — which sits above the entire canvas — paints it UNDER. A quad at the
// node's own paint index does not have the problem, because "above" and "below" are command indices.
//
// The two claims these specs carry are the GEOMETRY (the quad's matrix must be the DOM's composition, not a
// re-derivation) and the OFF CONTRACT (absent a source, the list is byte-identical and the classification never
// moved — which is what keeps the offline oracle's numbers unchanged on both settings).

interface Pushed {
  texture: string | null;
  m: number[];
  w: number;
  h: number;
  src: [number, number, number, number];
  rgba: [number, number, number, number];
  blend: number;
}

function capturingSink(): { sink: PaintSink; pushed: Pushed[] } {
  const pushed: Pushed[] = [];
  return {
    pushed,
    sink: {
      quad(view, texture) {
        pushed.push({
          texture,
          m: [...view.m],
          w: view.w,
          h: view.h,
          src: [view.srcX, view.srcY, view.srcW, view.srcH],
          rgba: [view.r, view.g, view.b, view.a],
          blend: view.blend
        });
      },
      ninePatch() {
        throw new Error("a text quad is never a nine-patch");
      },
      polyline() {
        throw new Error("a text quad is never a polyline");
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

function box(over: Partial<TextQuadBox> = {}): TextQuadBox {
  // `texX`/`texY` default to the unpacked corner — a label on a texture of its own, which is what every case in
  // this file is about except the atlas one at the bottom.
  return {
    digest: "d1",
    dx: 10,
    dy: 4,
    w: 42,
    h: 27,
    texW: 42,
    texH: 27,
    texX: 0,
    texY: 0,
    blockScale: 1,
    lines: 1,
    ...over
  };
}

function emit(rec: OverlayRecord, b: TextQuadBox, snap: TextSnap | null = null): { pushed: Pushed[]; count: number } {
  const { sink, pushed } = capturingSink();
  const count = emitTextQuad(rec, b, undefined, createPaintScratch(), sink, snap);
  return { pushed, count };
}

/**
 * A rest tracker with the REAL semantics — records as it answers, so "at rest" means "the same translation as
 * last time this was asked". A test that wants a label treated as settled therefore emits twice.
 */
function restTracker(perDesignPx: number): TextSnap {
  let prev = new Map<string, string>();
  let cur = new Map<string, string>();
  return {
    perDesignPx,
    atRest(id, tx, ty) {
      const packed = `${tx},${ty}`;
      // The renderer rotates the maps per BUILD; here every call is its own build, which is what makes "emit
      // twice at the same place" the settled case and "emit twice at different places" the moving one.
      const was = prev.get(id);
      cur.set(id, packed);
      prev = cur;
      cur = new Map();
      return was === packed;
    }
  };
}

describe("emitTextQuad", () => {
  it("places the raster at the record's transform plus the ink's own offset", () => {
    const { pushed, count } = emit(record({ transform: [1, 0, 0, 1, 900, 500] }), box());
    expect(count).toBe(1);
    expect(pushed[0].m).toEqual([1, 0, 0, 1, 910, 504]);
    expect(pushed[0].w).toBe(42);
    expect(pushed[0].h).toBe(27);
  });

  // --- THE DEVICE-PIXEL SNAP ---------------------------------------------------------------------------------
  //
  // Getting the raster SCALE right makes the blit 1:1 in size and says nothing about PHASE. A texture landing at
  // x = 401.265 device px samples every texel between two screen pixels and the executor's LINEAR filter spreads
  // each glyph stem across two — measured on the live combat frame as 44 of 56 text quads at fractional
  // translations. These pin the rounding, the REST TEST that guards it, and the byte-identical off arm.

  it("rounds a settled quad's origin onto the DEVICE grid, not the design grid", () => {
    // 401.265 design px at 2 device px per design px is 802.53 device px, whose nearest whole device pixel is
    // 803 — i.e. 401.5 design px. Rounding in design space would have said 401, which is a DIFFERENT pixel.
    const snap = restTracker(2);
    const rec = record({ transform: [1, 0, 0, 1, 391.265, 500.1] });
    emit(rec, box({ dx: 10, dy: 0 }), snap); // build 1: nothing to compare against yet
    const { pushed } = emit(rec, box({ dx: 10, dy: 0 }), snap);
    expect(pushed[0].m[4]).toBe(401.5);
    expect(pushed[0].m[5]).toBe(500);
  });

  it("does NOT snap a label that MOVED since the last build — the anti-judder rule", () => {
    // The reason the snap is gated at all: a label drifting across the grid would step in whole device pixels
    // instead of gliding. Two builds at two places is the moving case, and it must come out unsnapped.
    const snap = restTracker(2);
    emit(record({ transform: [1, 0, 0, 1, 391.265, 500.1] }), box({ dx: 10, dy: 0 }), snap);
    const { pushed } = emit(record({ transform: [1, 0, 0, 1, 393.265, 500.1] }), box({ dx: 10, dy: 0 }), snap);
    expect(pushed[0].m[4]).toBe(Math.fround(403.265));
  });

  it("asks the rest test even when the grid is off, or a still label reads as having moved", () => {
    // The recording is a SIDE EFFECT of `atRest`, so skipping the call on an unsnappable frame would leave the
    // tracker a build behind and the label would never settle. Off then on, at one place, must snap.
    const off = restTracker(0);
    const rec = record({ transform: [1, 0, 0, 1, 391.265, 500.1] });
    emit(rec, box({ dx: 10, dy: 0 }), off);
    const on = { ...off, perDesignPx: 2 };
    expect(emit(rec, box({ dx: 10, dy: 0 }), on).pushed[0].m[4]).toBe(401.5);
  });

  it("leaves the four scale cells alone — a snap moves a label, it does not resize one", () => {
    // `Math.fround` because the view's `m` is a Float32Array: 1.24 is not representable, and comparing against
    // the float64 literal would fail for a reason that has nothing to do with snapping.
    const snap = restTracker(1);
    const rec = record({ transform: [1.24, 0, 0, 0.8, 10.3, 20.7] });
    emit(rec, box({ dx: 0, dy: 0 }), snap);
    const { pushed } = emit(rec, box({ dx: 0, dy: 0 }), snap);
    expect([...pushed[0].m.slice(0, 4)]).toEqual([Math.fround(1.24), 0, 0, Math.fround(0.8)]);
    expect([...pushed[0].m.slice(4)]).toEqual([10, 21]);
  });

  it("is byte-identical with no snap, including the legacy baseline", () => {
    const rec = record({ transform: [1, 0, 0, 1, 391.265, 500.1] });
    const unsnapped = [1, 0, 0, 1, Math.fround(401.265), Math.fround(504.1)];
    expect([...emit(rec, box(), null).pushed[0].m]).toEqual(unsnapped);
    // …and a nonsense grid must fall back to off rather than putting NaN in a matrix, which draws NOTHING.
    const nan = restTracker(Number.NaN);
    emit(rec, box(), nan);
    expect([...emit(rec, box(), nan).pushed[0].m]).toEqual(unsnapped);
    const negative = restTracker(-2);
    emit(rec, box(), negative);
    expect([...emit(rec, box(), negative).pushed[0].m]).toEqual(unsnapped);
  });

  // --- THE EXACT 1:1 BLIT (round 10) -------------------------------------------------------------------------
  //
  // Round 9 shipped the snap above and called the sharpness fixed on the strength of a draw-list measurement,
  // and the reporter could still see the blur. The size was never 1:1: `texW = ceil(ink.w * rasterScale)` is a
  // whole number of texels and the quad it was stretched over was the ink's FRACTIONAL design width, so the
  // sampler squeezed one or two extra texels into every label — zero of 39 visible labels at 1:1 on the live
  // frame. Measured through gsw's own sampler (LINEAR min+mag, no mipmaps), the bright share of ink falls from
  // 0.398 to 0.213 between ratio 1.000 and ratio 1.005: the cliff is AT 1, so "close" buys nothing.

  it("sizes a settled quad so the drawn DEVICE size EQUALS the texel count", () => {
    // 42 design px of ink at 2 device px per design px rastered to 43 texels — the `ceil` remainder. The quad
    // must therefore be 21.5 design px wide, so that 21.5 x 2 = 43 device px carry 43 texels, one for one.
    const snap = restTracker(2);
    const rec = record({ transform: [1, 0, 0, 1, 100, 200] });
    const b = box({ w: 42, h: 27, texW: 43, texH: 28 });
    emit(rec, b, snap); // build 1: not settled yet
    const { pushed } = emit(rec, b, snap);
    expect(pushed[0].w).toBe(21.5);
    expect(pushed[0].h).toBe(14);
  });

  it("carries the label's own scale through, so a scaled card description is exact too", () => {
    // The composed matrix, not `record.transform`, is what the divisor has to be: a 1.24 card rule means the
    // quad is drawn 1.24x larger, and sizing off the unscaled matrix would leave exactly that factor of resample.
    const snap = restTracker(1);
    const rec = record({ transform: [1.24, 0, 0, 1.24, 0, 0] });
    const b = box({ w: 42, h: 27, texW: 53, texH: 34, dx: 0, dy: 0 });
    emit(rec, b, snap);
    const { pushed } = emit(rec, b, snap);
    expect(pushed[0].w * 1.24).toBeCloseTo(53, 6);
    expect(pushed[0].h * 1.24).toBeCloseTo(34, 6);
  });

  it("REFUSES a rotated label — a rotated glyph grid lines up with the screen's at no size at all", () => {
    const snap = restTracker(2);
    const rec = record({ transform: [0, 1, -1, 0, 100, 200] });
    const b = box({ w: 42, h: 27, texW: 43, texH: 28 });
    emit(rec, b, snap);
    const { pushed } = emit(rec, b, snap);
    expect([pushed[0].w, pushed[0].h]).toEqual([42, 27]);
  });

  it("REFUSES a NON-UNIFORM scale rather than distorting the label to buy sharpness", () => {
    // One raster scale cannot satisfy two axes, so an exact blit here would draw the mean on both — a stretched
    // label. Softness is the better of the two failures, and it is the one that already exists.
    const snap = restTracker(2);
    const rec = record({ transform: [1.24, 0, 0, 0.8, 100, 200] });
    const b = box({ w: 42, h: 27, texW: 43, texH: 28 });
    emit(rec, b, snap);
    const { pushed } = emit(rec, b, snap);
    expect([pushed[0].w, pushed[0].h]).toEqual([42, 27]);
  });

  it("does NOT resize a MOVING label — the same anti-judder gate the snap uses, and the same one", () => {
    const snap = restTracker(2);
    const b = box({ w: 42, h: 27, texW: 43, texH: 28 });
    emit(record({ transform: [1, 0, 0, 1, 100, 200] }), b, snap);
    const { pushed } = emit(record({ transform: [1, 0, 0, 1, 108, 200] }), b, snap);
    expect([pushed[0].w, pushed[0].h]).toEqual([42, 27]);
  });

  it("keeps the design size with no snap, byte-identical in size as well as origin", () => {
    const rec = record({ transform: [1, 0, 0, 1, 100, 200] });
    const b = box({ w: 42, h: 27, texW: 43, texH: 28 });
    expect([emit(rec, b, null).pushed[0].w, emit(rec, b, null).pushed[0].h]).toEqual([42, 27]);
    // …and a grid of zero is the same arm reached the other way (`textSnapEnabled` false reports `perDesignPx` 0).
    const zero = restTracker(0);
    emit(rec, b, zero);
    expect(emit(rec, b, zero).pushed[0].w).toBe(42);
  });

  it("names the raster by its `text://` key, so the bridge routes it to the right registry", () => {
    expect(emit(record(), box({ digest: "abc" })).pushed[0].texture).toBe(`${TEXT_KEY_PREFIX}abc`);
  });

  it("sources the WHOLE texture — a zero-span source stretches one texel over the box", () => {
    expect(emit(record(), box({ texW: 84, texH: 54 })).pushed[0].src).toEqual([0, 0, 84, 54]);
  });

  it("applies a card's block scale about the BOX CENTRE, which is what `transform-origin: 50% 50%` means", () => {
    // The box is 200x60, so the centre is (100, 30). At scale 1.24 the origin offset is c(1-s) on each axis:
    // -24 and -7.2, and the ink offset then rides through the scale.
    const { pushed } = emit(record(), box({ blockScale: 1.24, dx: 10, dy: 4 }));
    const m = pushed[0].m;
    expect(m[0]).toBeCloseTo(1.24, 5);
    expect(m[3]).toBeCloseTo(1.24, 5);
    expect(m[4]).toBeCloseTo(100 * (1 - 1.24) + 1.24 * 10, 5);
    expect(m[5]).toBeCloseTo(30 * (1 - 1.24) + 1.24 * 4, 5);
  });

  it("is identity at scale 1 — an unscaled label composes exactly transform . translate(dx, dy)", () => {
    const { pushed } = emit(record({ transform: [2, 0, 0, 2, 100, 50] }), box({ blockScale: 1, dx: 3, dy: 7 }));
    expect(pushed[0].m).toEqual([2, 0, 0, 2, 106, 64]);
  });

  it("keeps the box centre on the RECORD's width, which carries any renderWidthOverride", () => {
    // A full-screen label stretched to a wide stage resolves `50%` against the RENDERED box, not the streamed one.
    const { pushed } = emit(record({ w: 400 }), box({ blockScale: 2, dx: 0, dy: 0 }));
    expect(pushed[0].m[4]).toBeCloseTo(200 * (1 - 2), 5);
  });

  it("premultiplies the composed tint and alpha rather than baking them into the raster", () => {
    // A fading label reuses one texture and fades through the quad — which is what stops a fade minting a texture
    // per frame, and is why the digest excludes opacity.
    const { pushed } = emit(record({ opacity: 0.5, tintR: 1, tintG: 0.5, tintB: 0 }), box());
    expect(pushed[0].rgba).toEqual([0.5, 0.25, 0, 0.5]);
  });

  it("carries the node's own canvas blend when it has one", () => {
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
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
            localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 60 } },
            visible: true,
            canvasBlendMode: 1,
            text: { text: "hi" }
          }
        ]
      })!
    );
    const { sink, pushed } = capturingSink();
    emitTextQuad(record(), box(), state.nodes.get("label"), createPaintScratch(), sink);
    expect(pushed[0].blend).toBe(BLEND_ADD);
  });

  it("refuses a record that is not text, and a raster with no extent", () => {
    expect(emit(record({ kind: "spine" }), box()).count).toBe(0);
    expect(emit(record(), box({ w: 0 })).count).toBe(0);
    expect(emit(record(), box({ texH: 0 })).count).toBe(0);
  });
});

// --- the builder's seam -------------------------------------------------------------------------------------

function sceneWithLabels(): MirrorState {
  const state = createMirrorState();
  const node = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    parentId: id === "Root" ? null : "Root",
    name: id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 60 } },
    visible: true,
    ...over
  });
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: ["Root", "Plate", "A", "B"],
      upserts: [
        node("Root", { parentId: null }),
        node("Plate", { fillColor: { r: 1, g: 0, b: 0, a: 1 } }),
        node("A", { nodeType: "Godot.Label", text: { text: "one" } }),
        node("B", { nodeType: "Godot.Label", text: { text: "two" } })
      ]
    })!
  );
  return state;
}

function build(state: MirrorState, textSource: TextQuadSource | null) {
  const list = createDrawList<string>();
  return buildDrawList(state, list, { textSource, hitTest: false });
}

describe("the builder's text-quad seam", () => {
  it("emits a quad per label the source rasters, and names them", () => {
    const source: TextQuadSource = { boxFor: (r) => (r.id === "A" ? box({ digest: `d-${r.id}` }) : null) };
    const out = build(sceneWithLabels(), source);
    expect(out.stats.textQuads).toBe(1);
    expect([...out.textQuadIds]).toEqual(["A"]);
  });

  it("leaves a REFUSED label to the overlay — a null is not a missing label", () => {
    // Every null on this path (a refusal, a pacing, a face still loading) means the DOM overlay keeps its element.
    // The record is still produced, which is what the overlay reconciles against.
    const out = build(sceneWithLabels(), { boxFor: () => null });
    expect(out.stats.textQuads).toBe(0);
    expect(out.textQuadIds.size).toBe(0);
    expect(out.overlayRecords.filter((r) => r.kind === "text")).toHaveLength(2);
  });

  it("NEVER moves a classification — a text node is an overlay node on both settings", () => {
    // This is what keeps the offline oracle's `canvas ∪ overlay` union identical whether the lever is on or off,
    // and therefore why turning M4 on cannot move a single number in that gate.
    const off = build(sceneWithLabels(), null);
    const on = build(sceneWithLabels(), { boxFor: () => box() });
    expect(on.stats.overlay).toBe(off.stats.overlay);
    expect(on.stats.canvas).toBe(off.stats.canvas);
    expect(on.overlayRecords.map((r) => `${r.id}:${r.kind}`)).toEqual(
      off.overlayRecords.map((r) => `${r.id}:${r.kind}`)
    );
  });

  it("is BYTE-IDENTICAL with no source — the default page builds the pre-M4 list", () => {
    const withOut = build(sceneWithLabels(), null);
    const withNull = build(sceneWithLabels(), { boxFor: () => null });
    expect(withOut.stats.commands).toBe(withNull.stats.commands);
    expect(withOut.stats.quads).toBe(withNull.stats.quads);
    expect(withOut.textQuadIds.size).toBe(0);
    expect(withOut.stats.textQuads).toBe(0);
  });

  it("draws the label at its OWN paint index, after the plate the game paints under it", () => {
    // The whole point: a label's command sits between the commands painted before and after that node, so
    // anything the game paints later lands ON TOP of it — which is what the DOM overlay cannot do.
    const source: TextQuadSource = { boxFor: (r) => box({ digest: `d-${r.id}` }) };
    const out = build(sceneWithLabels(), source);
    const plate = out.ranges.get("Plate")!;
    const a = out.ranges.get("A")!;
    const b = out.ranges.get("B")!;
    expect(plate.paintEnd).toBeLessThanOrEqual(a.start);
    expect(a.paintEnd).toBeLessThanOrEqual(b.start);
  });

  it("puts a label's quad inside its OWN command range, which the tier-3 patcher needs", () => {
    const out = build(sceneWithLabels(), { boxFor: () => box() });
    const a = out.ranges.get("A")!;
    expect(a.paintEnd - a.start).toBe(1);
  });

  // --- `clip_contents`, pinned because it was SUSPECTED and turned out to be already right -------------------
  //
  // "Card descriptions overflow onto the neighbouring card" reads like a missing clip, and the round's plan
  // carried "honour clip_contents for text quads" as a fix. It is not one: the walk opens a node's clip scope
  // BEFORE that node's own paint, so a label's quad is already inside its own clip — and a RichTextLabel is
  // deliberately never clipped on EITHER backend (R20's readability transform is meant to spill). These two pin
  // both halves so the non-fix stays a non-fix, and so the next reader does not re-derive it from the report.

  it("draws a clipping label's quad INSIDE its own clip scope", () => {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: ["Root", "L"],
        upserts: [
          {
            id: "Root",
            parentId: null,
            name: "Root",
            nodeType: "Control",
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
            localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 60 } },
            visible: true
          },
          {
            id: "L",
            parentId: "Root",
            name: "L",
            nodeType: "Godot.Label",
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
            localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 60 } },
            visible: true,
            clipContents: true,
            text: { text: "one" }
          }
        ]
      })!
    );
    const out = build(state, { boxFor: () => box() });
    const clip = out.clipRanges.get("L")!;
    const paint = out.ranges.get("L")!;
    expect(out.stats.textQuads).toBe(1);
    // The push comes before the quad and the pop after it: the label's own clip really does contain its pixels.
    expect(clip.push).toBeLessThan(paint.start);
    expect(clip.pop).toBeGreaterThanOrEqual(paint.paintEnd);
  });

  it("opens NO clip for a RichTextLabel, matching the DOM arm's deliberate spill", () => {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: ["Root", "R"],
        upserts: [
          {
            id: "Root",
            parentId: null,
            name: "Root",
            nodeType: "Control",
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
            localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 60 } },
            visible: true
          },
          {
            id: "R",
            parentId: "Root",
            name: "R",
            nodeType: "Godot.RichTextLabel",
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
            localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 60 } },
            visible: true,
            clipContents: true,
            richText: true,
            text: { text: "one" }
          }
        ]
      })!
    );
    const out = build(state, { boxFor: () => box() });
    expect(out.clipRanges.has("R")).toBe(false);
  });
});

describe("emitTextQuad on an atlas page (R6 P6-D2)", () => {
  it("samples the label's own SUB-RECT, and leaves the geometry alone", () => {
    // The whole of what packing changed downstream: a label used to own its texture, so its source rect started
    // at the origin. Now many labels share one page and only the origin moves — the quad's matrix, box and colour
    // are a function of the RECORD, and a page is not a record.
    const plain = emit(record({ transform: [1, 0, 0, 1, 900, 500] }), box());
    const packed = emit(record({ transform: [1, 0, 0, 1, 900, 500] }), box({ texX: 137, texY: 264 }));

    expect(packed.count).toBe(1);
    expect(packed.pushed[0].src).toEqual([137, 264, 42, 27]);
    expect(plain.pushed[0].src).toEqual([0, 0, 42, 27]);
    // …and everything else is byte-identical between the two arms.
    expect(packed.pushed[0].m).toEqual(plain.pushed[0].m);
    expect(packed.pushed[0].w).toBe(plain.pushed[0].w);
    expect(packed.pushed[0].h).toBe(plain.pushed[0].h);
    expect(packed.pushed[0].texture).toBe(plain.pushed[0].texture);
  });

  it("still refuses a zero-SPAN raster, which a zero ORIGIN is not", () => {
    // The trap `emitSpineQuad` names: a zero-span source rect makes the executor stretch one texel over the box.
    // A zero origin is just the top-left corner and must stay perfectly ordinary.
    expect(emit(record(), box({ texW: 0 })).count).toBe(0);
    expect(emit(record(), box({ texH: 0 })).count).toBe(0);
    expect(emit(record(), box({ texX: 0, texY: 0 })).count).toBe(1);
  });
});
