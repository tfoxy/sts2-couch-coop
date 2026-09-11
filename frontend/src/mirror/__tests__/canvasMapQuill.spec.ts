// THE MAP QUILL ON THE CANVAS STAGE — the player's own annotations, and the two things the DOM backend does with
// them that this one did not (R8/R9).
//
// A quill stroke's local transform is the DrawViewport's viewport→screen fit and is CONSTANT for the stroke's
// life: the stroke never moves inside the viewport, and scrolling the map moves the MapDrawing ANCESTOR. The DOM
// backend latches it on first sight because a stale viewport prefix on the producer side otherwise drags finished
// annotations off the map — the literal symptom behind "map drawings cannot be seen". This file pins the canvas
// twin of that latch, and the eraser's: an eraser stroke is a blend_sub shader inside an isolated SubViewport,
// which a flat draw list cannot express at all, so it emits NOTHING rather than laying down solid ink.

import { describe, expect, it } from "vitest";

import { DRAW_POLYLINE, createDrawList, createPolylineView, type DrawList } from "@godot-scene-web/canvas";

import { buildDrawList, type PinnedLocalSource } from "@/mirror/canvas/buildDrawList";
import { createMirrorState, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";
import type { Affine } from "@/mirror/affine";

const QUILL_SCENE = "res://scenes/screens/map/map_line_draw.tscn";
const ERASE_SCENE = "res://scenes/screens/map/map_line_erase.tscn";
const ERASE_SHADER = "res://scenes/screens/map/line_erase.gdshader";

function mkNode(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.Line2D",
    showBehindParent: false,
    clipChildren: 0,
    clipContents: false,
    ninePatchMargins: null,
    font: null,
    richBoldFont: null,
    richItalicFont: null,
    richBoldItalicFont: null,
    richBoldFontSizePx: null,
    richItalicFontSizePx: null,
    richBoldItalicFontSizePx: null,
    richBoldFontSpacingPx: null,
    richItalicFontSpacingPx: null,
    richBoldItalicFontSpacingPx: null,
    textWrap: null,
    shadow: null,
    richText: false,
    shaderId: null,
    materialRef: null,
    shaderParams: null,
    textureStretchMode: null,
    textureFlipH: false,
    textureFlipV: false,
    particleSpec: null,
    particleEmitting: false,
    particleRestartEpoch: 0,
    spineSceneResPath: null,
    spineNodePath: null,
    spineAnimations: null,
    spineSkelResPath: null,
    sceneFilePath: null,
    mouseFilter: null,
    anchorLeft: null,
    anchorRight: null,
    anchorOwnerId: null,
    containerLayout: null,
    contentKey: null,
    spineCurrentAnim: null,
    spineSkin: null,
    spineMat: null,
    spinePaused: false,
    spineTrackTime: 0,
    spineLooping: true,
    pinnedLoopAnim: null,
    outline: null,
    transform: [1, 0, 0, 1, 0, 0],
    localRect: { x: 0, y: 0, width: 100, height: 100 },
    visible: true,
    focused: false,
    opacity: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    pivotX: 0,
    pivotY: 0,
    zIndex: null,
    textureUrl: null,
    textureRegion: null,
    textureMargin: null,
    ninePatch: false,
    modulate: null,
    selfModulate: null,
    fillColor: null,
    range: null,
    text: null,
    intentFrames: null,
    linePoints: null,
    lineWidth: null,
    lineColor: null,
    ...over
  };
}

function stroke(id: string, transform: Affine, over: Partial<MirrorNode> = {}): MirrorNode {
  return mkNode(id, "Map", {
    name: "map_line_draw",
    sceneFilePath: QUILL_SCENE,
    linePoints: [0, 0, 10, 0, 10, 10],
    lineWidth: 4,
    transform,
    ...over
  });
}

function mkState(nodes: MirrorNode[]): MirrorState {
  const state = createMirrorState();
  for (const node of nodes) {
    state.nodes.set(node.id, node);
  }
  state.orderedIds = nodes.map((n) => n.id);
  state.revision = 1;
  return state;
}

/** A latch owned by the test, exactly as `canvasRenderer` owns one per stream. */
function latch(): PinnedLocalSource & { size: () => number } {
  const locals = new Map<string, Affine>();
  return {
    pin(id, local) {
      const held = locals.get(id);
      if (held !== undefined) {
        return held;
      }
      const own: Affine = [local[0], local[1], local[2], local[3], local[4], local[5]];
      locals.set(id, own);
      return own;
    },
    size: () => locals.size
  };
}

/** Every polyline's first design-space point, in list order. */
function firstPoints(list: DrawList<string>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < list.count; i++) {
    if (list.kindAt(i) !== DRAW_POLYLINE) {
      continue;
    }
    const view = list.readPolyline(i, createPolylineView());
    out.push([view.points[0], view.points[1]]);
  }
  return out;
}

function buildWith(nodes: MirrorNode[], options: Parameters<typeof buildDrawList>[2] = {}) {
  const list = createDrawList<string>();
  const result = buildDrawList(mkState(nodes), list, options);
  return { list, result };
}

const MAP = () => mkNode("Map", null, { nodeType: "Godot.Control", transform: [1, 0, 0, 1, 0, 0], linePoints: null });

describe("the map-quill local pin", () => {
  it("latches the first local it sees and ignores every later wire delta", () => {
    const pinnedLocals = latch();
    // The stroke's points are node-local, so the placement is the whole of where it lands: the first build fixes
    // it at 2x, and the producer's later (stale-prefix) 3x must not move the finished annotation.
    const first = buildWith([MAP(), stroke("s", [2, 0, 0, 2, 0, 0])], { pinnedLocals });
    const second = buildWith([MAP(), stroke("s", [3, 0, 0, 3, 100, 100])], { pinnedLocals });
    expect(firstPoints(first.list)).toEqual(firstPoints(second.list));
    expect(pinnedLocals.size()).toBe(1);
  });

  it("pins the wire's LOCAL, so the ancestor still moves the stroke", () => {
    const pinnedLocals = latch();
    const scrolled = () => mkNode("Map", null, { nodeType: "Godot.Control", transform: [1, 0, 0, 1, 0, -40], linePoints: null });
    buildWith([MAP(), stroke("s", [2, 0, 0, 2, 0, 30])], { pinnedLocals });
    const after = buildWith([scrolled(), stroke("s", [2, 0, 0, 2, 0, 30])], { pinnedLocals });
    // Latching the composed GLOBAL would have frozen the annotation on screen; latching the local leaves the map
    // free to scroll it, which is the behaviour the pin exists to preserve.
    expect(firstPoints(after.list)).toEqual([[0, -10]]);
  });

  it("reaches mGame as well as the drawn pose — a tap and the paint agree", () => {
    const pinnedLocals = latch();
    buildWith([MAP(), stroke("s", [2, 0, 0, 2, 0, 0])], { pinnedLocals });
    const second = buildWith([MAP(), stroke("s", [3, 0, 0, 3, 0, 0])], { pinnedLocals });
    const entry = second.result.hitEntries.find((e) => e.nodeId === "s")!;
    // The substitution happens ahead of the gGame/gRaw split, so there is exactly one place it can disagree with
    // itself — and this is the read that would catch it.
    expect([entry.mGame[0], entry.mGame[3]]).toEqual([2, 2]);
  });

  it("COPIES the wire array: a later merge of the same object cannot rewrite the latch", () => {
    const pinnedLocals = latch();
    const live: Affine = [2, 0, 0, 2, 0, 0];
    buildWith([MAP(), stroke("s", live)], { pinnedLocals });
    live[0] = 9;
    live[3] = 9;
    const after = buildWith([MAP(), stroke("s", live)], { pinnedLocals });
    expect(firstPoints(after.list)).toEqual([[0, 0]]);
    const entry = after.result.hitEntries.find((e) => e.nodeId === "s")!;
    expect(entry.mGame[0]).toBe(2);
  });

  it("leaves any other Line2D alone", () => {
    const pinnedLocals = latch();
    const other = (m: Affine) => mkNode("t", "Map", { name: "TrailStroke", linePoints: [0, 0, 10, 0], transform: m });
    buildWith([MAP(), other([2, 0, 0, 2, 0, 0])], { pinnedLocals });
    const after = buildWith([MAP(), other([1, 0, 0, 1, 50, 60])], { pinnedLocals });
    expect(firstPoints(after.list)).toEqual([[50, 60]]);
    expect(pinnedLocals.size()).toBe(0);
  });

  it("is absent by default — the offline gate and every pre-R8 spec build the streamed matrix", () => {
    const after = buildWith([MAP(), stroke("s", [3, 0, 0, 3, 7, 8])]);
    expect(firstPoints(after.list)).toEqual([[7, 8]]);
  });
});

describe("the map eraser", () => {
  const eraser = (over: Partial<MirrorNode> = {}) =>
    mkNode("e", "Map", {
      name: "map_line_erase",
      sceneFilePath: ERASE_SCENE,
      shaderId: ERASE_SHADER,
      linePoints: [0, 0, 10, 0, 10, 10],
      lineWidth: 8,
      transform: [1, 0, 0, 1, 0, 0],
      ...over
    });

  it("emits no ink for an eraser stroke", () => {
    const { list } = buildWith([MAP(), eraser()]);
    expect(firstPoints(list)).toEqual([]);
  });

  it("still emits a PEN stroke beside it", () => {
    const { list } = buildWith([MAP(), stroke("s", [1, 0, 0, 1, 5, 5]), eraser()]);
    expect(firstPoints(list)).toEqual([[5, 5]]);
  });

  it("only skips a MAP eraser, never any other shader-carrying Line2D", () => {
    const other = mkNode("t", "Map", {
      name: "TrailStroke",
      shaderId: "res://shaders/card_trail.gdshader",
      linePoints: [0, 0, 10, 0],
      transform: [1, 0, 0, 1, 3, 4]
    });
    const { list } = buildWith([MAP(), other]);
    expect(firstPoints(list)).toEqual([[3, 4]]);
  });
});
