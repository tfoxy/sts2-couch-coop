import { afterEach, describe, expect, it } from "vitest";

import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// WS-2 CONSUMER (web half) — LINE2D STROKE geometry, i.e. the map quill annotations.
//
// A map annotation is a `Line2D` appended live under the map's DrawViewport as the finger drags. It has no texture
// rect and no text and — the detail that shapes this whole feature — the producer measures NO `localRect` for it
// (only Control/Sprite2D get one). So `linePoints != null` is the ONLY signal that the node paints anything: it is
// what makes `needsOwnEl` build an element, and what anchors `drawBox` at ZERO_ORIGIN so the element's baked matrix
// maps SVG user space 1:1 onto the node's local space (the space the points are streamed in).
//
// What these specs pin, in the order the bugs would bite:
//   * the polyline's attributes come out of a MERGED node (so the sticky carry-forward is in the loop);
//   * an eraser (shader `line_erase.gdshader`, blend_sub) is discriminated with no wire flag and really ERASES —
//     composited as an SVG <mask> over the owner's pen strokes, never painted as a coloured line of its own;
//   * a GROWING stroke (~30 deltas/s while drawing) reuses the SAME element — asserted by reference, because an
//     element rebuild per frame is the one thing this path must never do;
//   * an EMPTY points array is the producer's "cleared" INSTRUCTION (undo / clear-all), not an absence: the geometry
//     blanks but the element stays;
//   * a volatile-only delta carrying none of the three line fields leaves the stroke exactly as it was;
//   * a quill stroke's LOCAL matrix is latched on first sight — it is the DrawViewport fit and never legitimately
//     changes, so a later transform delta (a stale producer viewport prefix drifting with the map scroll) can't
//     drag finished annotations off the map.

type Raw = Record<string, unknown>;

const xf = (tx: number, ty: number) => ({ xAxis: { x: 2, y: 0 }, yAxis: { x: 0, y: 2 }, origin: { x: tx, y: ty } });
const color = (html: string) => ({ html });

const PEN_SHADER = "res://shaders/map_drawing/line_draw.gdshader";
const ERASE_SHADER = "res://shaders/map_drawing/line_erase.gdshader";

// The per-player `MapDrawing` Control every stroke is flattened onto (SubViewport children are re-parented onto
// their nearest CanvasItem ancestor), i.e. the mask OWNER.
const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };
const OWNER: Raw = {
  id: "MapDrawing",
  parentId: "Game",
  name: "MapDrawing",
  nodeType: "Godot.Control",
  sceneFilePath: "res://scenes/screens/map/map_drawing.tscn",
  visible: true
};

function harness(): { stage: HTMLElement; renderer: MirrorRenderer; defs: SVGElement } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs), defs };
}

function full(state: MirrorState, nodes: Raw[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: nodes,
      orderedIds: nodes.map((n) => n.id as string)
    })!
  );
}

function update(state: MirrorState, nodes: Raw[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

// A pen stroke exactly as the producer streams one: NO localRect, NO texture, NO text.
function stroke(over: Raw = {}): Raw {
  return {
    id: "stroke",
    parentId: "MapDrawing",
    name: "map_line_draw",
    nodeType: "Godot.Line2D",
    visible: true,
    sceneFilePath: "res://scenes/screens/map/map_line_draw.tscn",
    shader: { resourcePath: PEN_SHADER },
    transform: xf(1160.5, 618),
    linePoints: [17, 98, 457, 249, 390.25, 554.5],
    lineWidth: 4,
    lineColor: color("#ff0000ff"),
    ...over
  };
}

// A VOLATILE-only upsert (no `name` → the client takes mergeNode's volatile branch).
function volatileStroke(over: Raw = {}): Raw {
  return { id: "stroke", parentId: "MapDrawing", transform: xf(1160.5, 618), visible: true, ...over };
}

function el(stage: HTMLElement, id: string): HTMLElement {
  const found = stage.querySelector(`[data-node-id="${id}"]`);
  expect(found, `element ${id}`).not.toBeNull();
  return found as HTMLElement;
}

function lineDiv(stage: HTMLElement, id = "stroke"): HTMLElement {
  const found = el(stage, id).querySelector(".mirror-line");
  expect(found, "the stroke's .mirror-line sub-layer").not.toBeNull();
  return found as HTMLElement;
}

function polyline(stage: HTMLElement, id = "stroke"): SVGPolylineElement {
  const found = lineDiv(stage, id).querySelector("polyline");
  expect(found, "the stroke's <polyline>").not.toBeNull();
  return found as SVGPolylineElement;
}

// The owner's eraser <mask> in the SHARED defs (the registerTint idiom), or null while nobody has erased.
function maskFor(defs: SVGElement, ownerId = "MapDrawing"): SVGElement | null {
  return defs.querySelector(`mask#mline-${ownerId}`);
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Line2D map-quill strokes (web)", () => {
  it("paints a pen stroke's points/width/colour off a merged node", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, OWNER, stroke()]);
    renderer.reconcile(state);

    const p = polyline(stage);
    // The streamed NODE-LOCAL coordinates land VERBATIM: the element bakes the node matrix at local (0,0), so SVG
    // user space IS node-local space and the x2 viewport fit rides the transform, never the point values.
    expect(p.getAttribute("points")).toBe("17,98 457,249 390.25,554.5");
    expect(p.getAttribute("stroke-width")).toBe("4");
    // Alpha rides stroke-opacity, so the stroke colour is the RGB half only (else the two would multiply).
    expect(p.getAttribute("stroke")).toBe("#ff0000");
    expect(p.getAttribute("stroke-opacity")).toBe("1");
    // Joint/caps are constant `round` on the authored stroke scenes — hard-coded, never streamed.
    expect(p.getAttribute("stroke-linejoin")).toBe("round");
    expect(p.getAttribute("stroke-linecap")).toBe("round");
    expect(p.getAttribute("fill")).toBe("none");
    // A pen is not an eraser.
    expect(lineDiv(stage).hasAttribute("data-line-erase")).toBe(false);
  });

  // A pen alone must cost NOTHING extra: no <mask> in the shared defs, no mask reference on the polyline. The mask
  // is raster tax, so it may only exist once somebody has actually erased.
  it("registers no mask while the owner has only pen strokes", () => {
    const { stage, renderer, defs } = harness();
    const state = createMirrorState();
    full(state, [ROOT, OWNER, stroke()]);
    renderer.reconcile(state);

    expect(maskFor(defs)).toBeNull();
    expect(polyline(stage).hasAttribute("mask")).toBe(false);
  });

  // THE ERASER. The wire carries no eraser flag: an eraser is exactly the stroke whose shader is the blend_sub
  // `line_erase.gdshader`, which in-game SUBTRACTS from the DrawViewport's accumulated ink. So it must paint no
  // line of its own — it becomes a BLACK cut inside the owner's <mask>, and the owner's pen strokes reference it.
  it("erases: an eraser stroke becomes a black cut in the owner's mask and paints nothing itself", () => {
    const { stage, renderer, defs } = harness();
    const state = createMirrorState();
    full(state, [
      ROOT,
      OWNER,
      stroke(),
      stroke({
        id: "rub",
        name: "map_line_erase",
        sceneFilePath: "res://scenes/screens/map/map_line_erase.tscn",
        shader: { resourcePath: ERASE_SHADER },
        lineWidth: 12,
        lineColor: color("#ffffffff"),
        linePoints: [100, 100, 200, 200]
      })
    ]);
    renderer.reconcile(state);

    // The eraser's OWN polyline is empty — no grey/parchment pencil line on the map any more.
    expect(polyline(stage, "rub").getAttribute("points")).toBe("");
    expect(lineDiv(stage, "rub").hasAttribute("data-line-erase")).toBe(true);

    // …its ink lives in the shared defs as a black round-capped cut, in the SAME (DrawViewport) user space.
    const mask = maskFor(defs)!;
    expect(mask, "the owner's <mask> in the shared defs").not.toBeNull();
    expect(mask.getAttribute("maskUnits")).toBe("userSpaceOnUse");
    expect(mask.getAttribute("maskContentUnits")).toBe("userSpaceOnUse");
    const cut = mask.querySelector("polyline")!;
    expect(cut.getAttribute("points")).toBe("100,100 200,200");
    expect(cut.getAttribute("stroke")).toBe("#000000");
    expect(cut.getAttribute("stroke-width")).toBe("12");
    expect(cut.getAttribute("stroke-linecap")).toBe("round");

    // The white base rect is the "keep everything" ground the cut is taken out of, and the mask REGION must cover
    // the pen it hides (outside a mask's region, content is masked out entirely). Pen x spans 17..457 ± (4/2 + 1).
    const base = mask.querySelector("rect")!;
    expect(base.getAttribute("fill")).toBe("#ffffff");
    expect(Number(base.getAttribute("x"))).toBeLessThanOrEqual(17);
    expect(Number(base.getAttribute("y"))).toBeLessThanOrEqual(98);
    expect(Number(base.getAttribute("x")) + Number(base.getAttribute("width"))).toBeGreaterThanOrEqual(457);
    expect(Number(base.getAttribute("y")) + Number(base.getAttribute("height"))).toBeGreaterThanOrEqual(554.5);
    expect(mask.getAttribute("x")).toBe(base.getAttribute("x"));
    expect(mask.getAttribute("width")).toBe(base.getAttribute("width"));

    // …and the PEN is what the mask is applied to.
    expect(polyline(stage).getAttribute("mask")).toBe("url(#mline-MapDrawing)");
  });

  // A pen drawn BEFORE the eraser existed is not re-visited by the walk once it is finished, so the mask reference
  // has to be pushed onto every already-painted pen the moment the first eraser lands (and pulled off again when
  // the last one goes — undo).
  it("retro-applies the mask to existing pens and drops it when the last eraser goes", () => {
    const { stage, renderer, defs } = harness();
    const state = createMirrorState();
    full(state, [ROOT, OWNER, stroke()]);
    renderer.reconcile(state);
    const pen = polyline(stage);
    expect(pen.hasAttribute("mask")).toBe(false);

    // A structural delta (the eraser node is NEW), which is what the game sends when a finger starts rubbing.
    full(state, [
      ROOT,
      OWNER,
      stroke(),
      stroke({
        id: "rub",
        name: "map_line_erase",
        sceneFilePath: "res://scenes/screens/map/map_line_erase.tscn",
        shader: { resourcePath: ERASE_SHADER },
        lineWidth: 12,
        linePoints: [100, 100, 200, 200]
      })
    ]);
    renderer.reconcile(state);
    expect(polyline(stage), "the pen element survives the eraser landing").toBe(pen);
    expect(pen.getAttribute("mask")).toBe("url(#mline-MapDrawing)");

    // Undo the eraser: the node leaves the scene, the cut goes with it, and the pen is whole again.
    full(state, [ROOT, OWNER, stroke()]);
    renderer.reconcile(state);
    expect(maskFor(defs)).toBeNull();
    expect(polyline(stage).hasAttribute("mask")).toBe(false);
  });

  // THE MAP-SCROLL PIN. A quill stroke's local matrix is the DrawViewport→screen fit and is constant for the
  // stroke's lifetime; scrolling the map moves the MapDrawing ANCESTOR, which nested DOM already carries. Latching
  // it means a producer that (as it did before this round) re-emits a drifting local while the map scrolls cannot
  // slide finished annotations off the map — the client simply never re-reads it.
  it("latches a quill stroke's local matrix and ignores later transform deltas", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, OWNER, stroke()]);
    renderer.reconcile(state);
    const host = el(stage, "stroke");
    expect(host.style.transform).toContain("matrix(2, 0, 0, 2, 1160.5, 618)");

    // A scroll's worth of drift, as the stale-prefix producer emitted it: minus the scroll delta, every tick.
    for (const dy of [-40, -140, -300]) {
      update(state, [volatileStroke({ transform: xf(1160.5, 618 + dy) })]);
      renderer.reconcile(state);
      expect(host.style.transform, "the pinned local never follows the drift").toContain(
        "matrix(2, 0, 0, 2, 1160.5, 618)"
      );
    }
  });

  // The pin is scoped by SCENE IDENTITY, not by "is a Line2D": a host running with
  // SPIRECTL_SCENE_WATCH_LINE2D_GEOMETRY=all streams other Line2Ds (VFX) whose transforms really do animate.
  it("does not pin a Line2D that is not a map quill stroke", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [
      ROOT,
      OWNER,
      stroke({ name: "SomeVfxLine", sceneFilePath: "res://scenes/vfx/some_line.tscn" })
    ]);
    renderer.reconcile(state);
    const host = el(stage, "stroke");
    expect(host.style.transform).toContain("matrix(2, 0, 0, 2, 1160.5, 618)");

    update(state, [volatileStroke({ transform: xf(1160.5, 300) })]);
    renderer.reconcile(state);
    expect(host.style.transform).toContain("matrix(2, 0, 0, 2, 1160.5, 300)");
  });

  // A mask is a compositor raster, so it may only be applied to the pens the rubbing actually touches. An
  // annotation on the far side of the map keeps its plain, unmasked polyline.
  it("leaves a pen the eraser never reaches unmasked", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [
      ROOT,
      OWNER,
      stroke({ linePoints: [10, 10, 60, 60] }),
      stroke({ id: "far", linePoints: [800, 900, 860, 960] }),
      stroke({
        id: "rub",
        name: "map_line_erase",
        sceneFilePath: "res://scenes/screens/map/map_line_erase.tscn",
        shader: { resourcePath: ERASE_SHADER },
        lineWidth: 12,
        linePoints: [20, 20, 40, 40]
      })
    ]);
    renderer.reconcile(state);

    expect(polyline(stage).getAttribute("mask"), "the rubbed stroke").toBe("url(#mline-MapDrawing)");
    expect(polyline(stage, "far").hasAttribute("mask"), "the far stroke pays no raster").toBe(false);
  });

  // Two players draw into two SEPARATE MapDrawing/DrawViewport pairs, so one player's eraser must never cut into
  // the other's annotations: one mask per owner, referenced only by that owner's pens.
  it("keeps each player's mask to their own MapDrawing", () => {
    const { stage, renderer, defs } = harness();
    const state = createMirrorState();
    const owner2: Raw = { ...OWNER, id: "MapDrawing2" };
    full(state, [
      ROOT,
      OWNER,
      owner2,
      stroke(),
      stroke({ id: "pen2", parentId: "MapDrawing2" }),
      stroke({
        id: "rub",
        name: "map_line_erase",
        sceneFilePath: "res://scenes/screens/map/map_line_erase.tscn",
        shader: { resourcePath: ERASE_SHADER },
        linePoints: [100, 100, 200, 200]
      })
    ]);
    renderer.reconcile(state);

    expect(maskFor(defs, "MapDrawing")).not.toBeNull();
    expect(maskFor(defs, "MapDrawing2")).toBeNull();
    expect(polyline(stage).getAttribute("mask")).toBe("url(#mline-MapDrawing)");
    expect(polyline(stage, "pen2").hasAttribute("mask")).toBe(false);
  });

  // THE PERF-CRITICAL ONE. A stroke under the finger re-ships its whole array on most ticks; the element and its
  // polyline must be the SAME OBJECTS afterwards (attribute writes only), never rebuilt.
  it("keeps the SAME element identity while a stroke grows", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, OWNER, stroke({ linePoints: [17, 98] })]);
    renderer.reconcile(state);
    const firstDiv = lineDiv(stage);
    const firstPolyline = polyline(stage);

    for (const points of [
      [17, 98, 40, 120],
      [17, 98, 40, 120, 80, 160],
      [17, 98, 40, 120, 80, 160, 130, 205]
    ]) {
      update(state, [volatileStroke({ linePoints: points })]);
      renderer.reconcile(state);
      expect(lineDiv(stage), "the wrapper survives every append").toBe(firstDiv);
      expect(polyline(stage), "the polyline survives every append").toBe(firstPolyline);
    }

    expect(firstPolyline.getAttribute("points")).toBe("17,98 40,120 80,160 130,205");
  });

  // An EMPTY array is an INSTRUCTION ("the stroke was cleared — erase what you drew"), the opposite of an omitted
  // one ("unchanged — keep the retained geometry"). The element stays: the same node is drawn into again.
  it("clears the geometry on an EMPTY points array but keeps the element", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, OWNER, stroke()]);
    renderer.reconcile(state);
    const before = polyline(stage);
    expect(before.getAttribute("points")).not.toBe("");

    update(state, [volatileStroke({ linePoints: [] })]);
    renderer.reconcile(state);
    expect(polyline(stage), "the element is kept, only emptied").toBe(before);
    expect(before.getAttribute("points")).toBe("");

    // …and drawing again re-fills the same element.
    update(state, [volatileStroke({ linePoints: [5, 6, 7, 8] })]);
    renderer.reconcile(state);
    expect(polyline(stage)).toBe(before);
    expect(before.getAttribute("points")).toBe("5,6 7,8");
  });

  // STICKY: the producer re-ships the three line fields only when the stroke's signature changed, so most deltas
  // for a finished stroke carry none of them. mergeNode's carry-forward is what keeps the stroke on screen — without
  // it every finished annotation on the map would blank one tick after it appeared.
  it("retains the stroke across a volatile delta that carries no line fields", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, OWNER, stroke()]);
    renderer.reconcile(state);
    const before = polyline(stage);

    // A plain per-tick upsert: a move, and nothing else.
    update(state, [volatileStroke({ transform: xf(1200, 618) })]);
    renderer.reconcile(state);

    expect(state.nodes.get("stroke")!.linePoints).toEqual([17, 98, 457, 249, 390.25, 554.5]);
    expect(state.nodes.get("stroke")!.lineWidth).toBe(4);
    expect(state.nodes.get("stroke")!.lineColor?.html).toBe("#ff0000ff");
    expect(polyline(stage)).toBe(before);
    expect(before.getAttribute("points")).toBe("17,98 457,249 390.25,554.5");
    expect(before.getAttribute("stroke")).toBe("#ff0000");
  });

  // The element gate keys on linePoints, NOT on a localRect (there is none), and the svg must be anchored at the
  // node's local origin with overflow visible — never sized/positioned from the points' bounding box, or a growing
  // stroke would slide as its bbox origin moved.
  it("builds an element for a rect-less Line2D and anchors the svg at the node origin", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, OWNER, stroke()]);
    renderer.reconcile(state);

    const node = state.nodes.get("stroke")!;
    expect(node.localRect, "the producer streams no localRect for a Line2D").toBeNull();

    const host = el(stage, "stroke");
    // The node's own element still carries the streamed matrix (drawBox = ZERO_ORIGIN), which is what makes SVG
    // user space equal node-local space.
    expect(host.style.transform).toContain("matrix(2, 0, 0, 2, 1160.5, 618)");

    const svg = lineDiv(stage).querySelector("svg") as SVGSVGElement;
    expect(svg).not.toBeNull();
    expect(svg.style.overflow).toBe("visible");
    // Inline-level svg would ride the wrapper's baseline line box (one font-size of downward offset, ×node scale —
    // Tier-3 measured the stroke 33 screen px low). jsdom does no layout, so pin the inline style itself.
    expect(svg.style.display, "block display pins the svg at the wrapper's (0,0)").toBe("block");
    expect(svg.getAttribute("viewBox"), "no viewBox: user space must stay 1:1 with node-local space").toBeNull();
    expect(lineDiv(stage).className).toBe("mirror-line");
  });

  // A node that stops being a stroke (or never was one) carries no sub-layer.
  it("tears the sub-layer down when the node is no longer a stroke", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, OWNER, stroke()]);
    renderer.reconcile(state);
    expect(el(stage, "stroke").querySelector(".mirror-line")).not.toBeNull();

    // A STATIC-bearing upsert (a `name`) replaces the whole node — the sticky carry-forward is bypassed, so the
    // stroke really is gone.
    full(state, [ROOT, OWNER, { id: "stroke", parentId: "MapDrawing", name: "Plain", nodeType: "Godot.Control", visible: true }]);
    renderer.reconcile(state);
    expect(stage.querySelector(".mirror-line")).toBeNull();
  });
});
