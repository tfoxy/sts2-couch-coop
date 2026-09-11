import { beforeEach, describe, expect, it } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,


  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// O(delta) reconcile — the GEOMETRY EPOCH cache. The post-walk passes that rebuild whole-scene structures
// (applyViewScalePass + its input registry, the interactive-rect array, the ancestor-visibility climb inside
// forEachInteractiveRect) used to re-run on EVERY reconcile, which on a screen whose deltas are cosmetic (a card
// detail over the deck dialog: ~24 deltas/s that touch a couple of decorations) was ~3ms of pure repeat work per
// frame. They now cache against a monotonic `geometryEpoch` that only moves when something can actually change
// them.
//
// These specs pin BOTH halves: the epoch must NOT move for cosmetic churn (the win), and it MUST move for every
// shape of real geometry change (the correctness). `mirrorWalkStats.geomPassRuns / geomPassSkips /
// interactiveRectRebuilds` are the observable seam.

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}

function rect(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}

// A full (add/keyframe-shaped) node: carries the STATIC fields (name/nodeType/mouseFilter/sceneFilePath).
function node(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: xform(0, 0),
    localRect: rect(100, 100),
    visible: true,
    ...over
  };
}

// A mouse-visible (Stop) Control with a box at a game-space position — an interactive-rect candidate.
function hitRect(id: string, parentId: string | null, x: number, y: number): Record<string, unknown> {
  return node(id, parentId, { transform: xform(x, y), localRect: rect(80, 40), mouseFilter: 0 });
}

// A mouse-IGNORE decoration (the rotating background layers / floating icons that stream a fresh transform every
// single frame on an otherwise idle screen).
function decor(id: string, parentId: string | null, x: number, y: number): Record<string, unknown> {
  return node(id, parentId, { transform: xform(x, y), localRect: rect(64, 64), mouseFilter: 2 });
}

// The real wire shape of a VOLATILE upsert (see a recorded stream): no name/nodeType/mouseFilter — those are static
// and merged forward — just the per-tick placement + paint fields.
function volatile(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, parentId, transform: xform(0, 0), localRect: rect(100, 100), visible: true, ...over };
}

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function keyframe(state: MirrorState, nodes: Record<string, unknown>[]): void {
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

function update(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

function structural(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes, orderedIds: order })!
  );
}

// The scene the whole suite reuses: a mouse-visible button, a decoration leaf that animates every frame, and a
// boxless holder whose subtree is pure decoration (the enemy-intent shape).
function idleScene(): Record<string, unknown>[] {
  return [
    node("root", null, { transform: xform(0, 0), localRect: rect(1920, 1080), mouseFilter: 2 }),
    hitRect("button", "root", 500, 600),
    decor("layer2", "root", 100, 100),
    node("intentHolder", "root", { transform: xform(800, 200), localRect: rect(64, 64), mouseFilter: 2 }),
    decor("intentGlyph", "intentHolder", 0, 0)
  ];
}

beforeEach(() => {
  document.body.innerHTML = "";
  mirrorWalkStats.reset();
});

describe("geometry epoch — what does NOT invalidate", () => {
  it("a cosmetic-only delta skips the view-scale pass and reuses the interactive-rect array", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    keyframe(state, idleScene());
    renderer.reconcile(state);
    const runsAfterKeyframe = mirrorWalkStats.geomPassRuns;
    expect(runsAfterKeyframe).toBe(1);
    expect(mirrorWalkStats.geomPassSkips).toBe(0);

    const rects = renderer.interactiveRects();
    expect(rects.map((r) => r.id)).toEqual(["button"]);
    const rebuilds = mirrorWalkStats.interactiveRectRebuilds;
    expect(renderer.interactiveRects()).toBe(rects); // second call in the same epoch reuses the array

    // Pure paint churn: a new modulate on the button, nothing moved.
    update(state, [volatile("button", "root", { transform: xform(500, 600), localRect: rect(80, 40), modulate: { r: 1, g: 0, b: 0, a: 1 } })]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.geomPassRuns).toBe(runsAfterKeyframe);
    expect(mirrorWalkStats.geomPassSkips).toBe(1);
    expect(renderer.interactiveRects()).toBe(rects);
    expect(mirrorWalkStats.interactiveRectRebuilds).toBe(rebuilds);
  });

  it("an animated DECORATION leaf moving every frame never invalidates", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    keyframe(state, idleScene());
    renderer.reconcile(state);
    const rects = renderer.interactiveRects();
    const runs = mirrorWalkStats.geomPassRuns;

    for (let i = 1; i <= 5; i++) {
      update(state, [volatile("layer2", "root", { transform: xform(100 + i, 100 + i), localRect: rect(64, 64) })]);
      renderer.reconcile(state);
    }

    expect(mirrorWalkStats.geomPassRuns).toBe(runs);
    expect(mirrorWalkStats.geomPassSkips).toBe(5);
    expect(renderer.interactiveRects()).toBe(rects);
  });

  it("a boxless holder whose whole subtree is decoration does not invalidate (the intent-glyph case)", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    keyframe(state, idleScene());
    renderer.reconcile(state);
    const runs = mirrorWalkStats.geomPassRuns;

    update(state, [volatile("intentHolder", "root", { transform: xform(801, 200), localRect: rect(64, 63.999348) })]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.geomPassRuns).toBe(runs);
    expect(mirrorWalkStats.geomPassSkips).toBe(1);
  });
});

describe("geometry epoch — what DOES invalidate", () => {
  const cases: { name: string; drive: (state: MirrorState) => void; expectRects?: string[] }[] = [
    {
      name: "an interactive control moving",
      drive: (state) => update(state, [volatile("button", "root", { transform: xform(700, 600), localRect: rect(80, 40) })])
    },
    {
      name: "an interactive control's BOX resizing",
      drive: (state) => update(state, [volatile("button", "root", { transform: xform(500, 600), localRect: rect(120, 40) })])
    },
    {
      name: "an interactive control being hidden",
      drive: (state) =>
        update(state, [volatile("button", "root", { transform: xform(500, 600), localRect: rect(80, 40), visible: false })]),
      expectRects: []
    },
    {
      name: "an ANCESTOR being hidden (effective visibility)",
      drive: (state) => update(state, [volatile("root", null, { transform: xform(0, 0), localRect: rect(1920, 1080), visible: false })]),
      expectRects: []
    },
    {
      name: "a decoration becoming mouse-visible",
      drive: (state) => update(state, [node("layer2", "root", { transform: xform(100, 100), localRect: rect(64, 64), mouseFilter: 1 })]),
      expectRects: ["button", "layer2"]
    },
    {
      name: "a structural delta (a control is added)",
      drive: (state) =>
        structural(state, [hitRect("extra", "root", 900, 700)], ["root", "button", "layer2", "intentHolder", "intentGlyph", "extra"]),
      expectRects: ["button", "extra"]
    }
  ];

  for (const c of cases) {
    it(`re-runs the passes for ${c.name}`, () => {
      const { renderer } = harness();
      const state = createMirrorState();
      keyframe(state, idleScene());
      renderer.reconcile(state);
      renderer.interactiveRects();
      const runs = mirrorWalkStats.geomPassRuns;
      const rebuilds = mirrorWalkStats.interactiveRectRebuilds;

      c.drive(state);
      renderer.reconcile(state);

      expect(mirrorWalkStats.geomPassRuns).toBe(runs + 1);
      const after = renderer.interactiveRects();
      expect(mirrorWalkStats.interactiveRectRebuilds).toBe(rebuilds + 1);
      if (c.expectRects) {
        expect(after.map((r) => r.id)).toEqual(c.expectRects);
      }
    });
  }

  it("publishes the MOVED game-space rect after an interactive control moves", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    keyframe(state, idleScene());
    renderer.reconcile(state);
    expect(renderer.interactiveRects()[0].transform[4]).toBe(500);

    update(state, [volatile("button", "root", { transform: xform(742, 600), localRect: rect(80, 40) })]);
    renderer.reconcile(state);
    expect(renderer.interactiveRects()[0].transform[4]).toBe(742);
  });

  it("a parent moving carries its interactive child's game rect (and invalidates)", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    keyframe(
      state,
      [
        node("root", null, { transform: xform(0, 0), localRect: rect(1920, 1080), mouseFilter: 2 }),
        node("panel", "root", { transform: xform(100, 100), localRect: rect(400, 300), mouseFilter: 2 }),
        hitRect("button", "panel", 10, 10)
      ]
    );
    renderer.reconcile(state);
    expect(renderer.interactiveRects()[0].transform[4]).toBe(110); // 100 (panel) + 10 (button)
    const runs = mirrorWalkStats.geomPassRuns;

    // Only the PANEL is upserted — the child's own local transform is untouched, but its global moved.
    update(state, [volatile("panel", "root", { transform: xform(300, 100), localRect: rect(400, 300) })]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.geomPassRuns).toBe(runs + 1);
    expect(renderer.interactiveRects()[0].transform[4]).toBe(310);
  });
});

describe("geometry epoch — the view-scale pass", () => {
  // The live map-legend shape (see viewScaleInputRegistry.spec): a 1.2x GROUP stamp resolved by node NAME under the
  // map screen's scene root, with an interactive row inside it.
  function legendScene(): Record<string, unknown>[] {
    return [
      node("screen", null, {
        nodeType: "NMapScreen",
        sceneFilePath: "res://scenes/screens/map/map_screen.tscn",
        transform: xform(0, 0),
        localRect: rect(1920, 1080),
        mouseFilter: 0
      }),
      node("MapLegend", "screen", { nodeType: "TextureRect", transform: xform(1536, 289), localRect: rect(340, 454), mouseFilter: 2 }),
      hitRect("row", "MapLegend", 1582, 390),
      decor("spinner", "screen", 200, 200)
    ];
  }

  function legendEl(stage: HTMLElement): HTMLElement {
    return stage.querySelector('[data-node-id="MapLegend"]') as HTMLElement;
  }

  it("keeps the composed stamp AND the published input registry across a skipped walk", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    keyframe(state, legendScene());
    renderer.reconcile(state);

    const stamped = legendEl(stage).style.transform;
    expect(stamped.match(/matrix\(/g)?.length).toBe(2); // the view-scale stamp PREPENDED to the base transform
    const registry = renderer.viewScaleInputStamps();
    expect(registry).toHaveLength(1);
    expect(registry[0].isGroup).toBe(true);
    const runs = mirrorWalkStats.geomPassRuns;

    // Pure decoration churn on the same screen — the pass must be skipped WITHOUT clearing what it published.
    for (let i = 1; i <= 3; i++) {
      update(state, [volatile("spinner", "screen", { transform: xform(200 + i, 200), localRect: rect(64, 64) })]);
      renderer.reconcile(state);
    }

    expect(mirrorWalkStats.geomPassRuns).toBe(runs);
    expect(mirrorWalkStats.geomPassSkips).toBe(3);
    expect(legendEl(stage).style.transform).toBe(stamped);
    expect(renderer.viewScaleInputStamps()).toBe(registry);
    expect(renderer.viewScaleInputStamps()).toHaveLength(1);
  });

  // R10-PERF6 WS-P1 — the INPUT half of the pass is LAZY. A shuffle frame legitimately bumps the geometry epoch
  // (the flying card moves real hitboxes), so the visual stamp loop must re-run — but the GAME-space input
  // registry it used to rebuild in the same breath is coordinate-only and read exclusively by pointer events.
  it("does not assemble the input registry until something reads it", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    keyframe(state, legendScene());
    renderer.reconcile(state);
    // Nothing has touched the screen: the pass ran (the stamp is on the element) but the registry is unbuilt.
    expect(mirrorWalkStats.geomPassRuns).toBeGreaterThan(0);
    expect(mirrorWalkStats.viewScaleRegistryBuilds).toBe(0);

    // Real geometry churn — the legend item itself moving, which re-runs the pass every time.
    for (let i = 1; i <= 5; i++) {
      update(state, [volatile("MapLegend", "screen", { transform: xform(1536, 289 + i), localRect: rect(340, 454) })]);
      renderer.reconcile(state);
    }
    expect(mirrorWalkStats.viewScaleRegistryBuilds).toBe(0);

    // The first pointer read pays for it, once; later reads in the same epoch reuse the array.
    const registry = renderer.viewScaleInputStamps();
    expect(mirrorWalkStats.viewScaleRegistryBuilds).toBe(1);
    expect(registry).toHaveLength(1);
    expect(renderer.viewScaleInputStamps()).toBe(registry);
    expect(mirrorWalkStats.viewScaleRegistryBuilds).toBe(1);

    // …and a fresh pass invalidates it again (the next read rebuilds).
    update(state, [volatile("MapLegend", "screen", { transform: xform(1536, 300), localRect: rect(340, 454) })]);
    renderer.reconcile(state);
    expect(mirrorWalkStats.viewScaleRegistryBuilds).toBe(1);
    expect(renderer.viewScaleInputStamps()).not.toBe(registry);
    expect(mirrorWalkStats.viewScaleRegistryBuilds).toBe(2);
  });

  it("re-stamps when the scaled item itself moves", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    keyframe(state, legendScene());
    renderer.reconcile(state);
    const before = legendEl(stage).style.transform;
    const runs = mirrorWalkStats.geomPassRuns;

    update(state, [volatile("MapLegend", "screen", { transform: xform(1400, 289), localRect: rect(340, 454) })]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.geomPassRuns).toBe(runs + 1);
    const after = legendEl(stage).style.transform;
    expect(after).not.toBe(before);
    expect(after.match(/matrix\(/g)?.length).toBe(2);
  });

  it("retires the stamp when the item stops resolving (screen closed)", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    keyframe(state, legendScene());
    renderer.reconcile(state);
    expect(renderer.viewScaleInputStamps()).toHaveLength(1);
    const runs = mirrorWalkStats.geomPassRuns;

    update(state, [volatile("MapLegend", "screen", { transform: xform(1536, 289), localRect: rect(340, 454), visible: false })]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.geomPassRuns).toBe(runs + 1);
    expect(renderer.viewScaleInputStamps()).toHaveLength(0);
  });
});
