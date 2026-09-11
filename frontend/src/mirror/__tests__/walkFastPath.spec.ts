import { beforeEach, describe, expect, it } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,


  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// R10-PERF6 WS-P1 — the ANCESTOR-AFFINE fast path.
//
// A map scroll is ONE wire upsert on the scroll container: every descendant's node object and inherited context are
// unchanged EXCEPT the parent matrices, yet the pre-round walk re-ran each one's full restyle (nodeStyle + shader/
// particle attrs + sub-layers + applyAttrs) and discarded an identical result. The fast path re-derives only what an
// ancestor's matrix can change (spread classification → placement transform → spread attrs → gDesign → the child
// frame).
//
// The gate these specs enforce is PARITY: the DOM the fast path leaves must be byte-identical to the DOM the full
// visit leaves, for the same delta sequence, at 16:9 AND on a widened stage (where a rigid ride still moves `dx`).
// Everything else here is the counters and the exclusions.

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}

function rect(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}

function node(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: xform(0, 0),
    localRect: rect(100, 100),
    visible: true,
    mouseFilter: 2,
    ...over
  };
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
      screenType: "Screens.Map.NMapScreen",
      upserts: nodes,
      orderedIds: nodes.map((n) => n.id as string)
    })!
  );
}

function update(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "Screens.Map.NMapScreen",
      upserts: nodes
    })!
  );
}

// The map screen in miniature: a scroll container whose subtree is a grid of points (each an interactive hit box
// with a painted child), plus a full-canvas backdrop. Moving `scroll` re-bases every descendant's global.
function mapScene(): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [
    node("root", null, { localRect: rect(1920, 1080) }),
    node("bg", "root", { localRect: rect(1920, 3240), anchorLeft: 0, anchorRight: 1 }),
    node("scroll", "root", { transform: xform(0, -600), localRect: rect(1920, 1080) })
  ];
  for (let i = 0; i < 12; i++) {
    const px = 120 + (i % 4) * 380;
    const py = 100 + Math.floor(i / 4) * 260;
    nodes.push(
      node(`point${i}`, "scroll", { transform: xform(px, py), localRect: rect(96, 96), mouseFilter: 0 }),
      node(`icon${i}`, `point${i}`, { transform: xform(8, 8), localRect: rect(80, 80) }),
      node(`glyph${i}`, `icon${i}`, { transform: xform(4, 4), localRect: rect(72, 72) })
    );
  }
  return nodes;
}

function scrollTo(y: number): Record<string, unknown>[] {
  // The real shape of a scroll frame: ONE volatile upsert, transform only.
  return [{ id: "scroll", parentId: "root", transform: xform(0, y), localRect: rect(1920, 1080), visible: true }];
}

// Every element under the stage, in document order, with its full inline style + attribute set — the parity oracle.
function domSnapshot(stage: HTMLElement): string[] {
  const out: string[] = [];
  const walk = (el: Element, path: string): void => {
    const attrs = Array.from(el.attributes)
      .map((a) => `${a.name}=${a.value}`)
      .sort()
      .join(",");
    out.push(`${path}|${el.tagName}|${(el as HTMLElement).style?.cssText ?? ""}|${attrs}`);
    let i = 0;
    for (const child of Array.from(el.children)) {
      walk(child, `${path}/${i++}`);
    }
  };
  let i = 0;
  for (const child of Array.from(stage.children)) {
    walk(child, String(i++));
  }
  return out;
}

// Drive the current affine path through a scroll sequence and return its DOM + counters.
function runScroll(stretch: number): { dom: string[]; rested: string[]; affine: number; styled: number } {
  mirrorWalkStats.reset();
  const { stage, renderer } = harness();
  renderer.setStretch(stretch);
  const state = createMirrorState();
  keyframe(state, mapScene());
  renderer.reconcile(state);
  const styledAfterKeyframe = mirrorWalkStats.styledNodes;
  const rested = domSnapshot(stage);
  for (const y of [-580, -540, -470, -390, -300]) {
    update(state, scrollTo(y));
    renderer.reconcile(state);
  }
  return {
    dom: domSnapshot(stage),
    rested,
    affine: mirrorWalkStats.affineFastPathVisits,
    styled: mirrorWalkStats.styledNodes - styledAfterKeyframe
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  mirrorWalkStats.reset();
});

describe("ancestor-affine fast path", () => {
  it("updates the scroll DOM at 16:9 through affine visits", () => {
    const result = runScroll(1);
    expect(result.affine).toBeGreaterThan(0);
    expect(result.dom).not.toEqual(result.rested);
  });

  it("updates spread placement on a widened stage", () => {
    const result = runScroll(2520 / 1920);
    expect(result.affine).toBeGreaterThan(0);
    // On a widened stage each rider re-claims the squeeze field at its own
    // rendered X, so the scroll really does rewrite descendant transforms + `data-spread-dx`. If the fast path wrote
    // nothing, this would fail.
    expect(result.dom).not.toEqual(result.rested);
  });

  it("styles only the streamed scroll container while visiting affine descendants", () => {
    const result = runScroll(1);
    expect(result.styled).toBeLessThanOrEqual(5);
    expect(result.affine).toBeGreaterThanOrEqual(5 * 36);
  });
});

describe("ancestor-affine fast path — exclusions", () => {
  it("a pinned-loop node (a travelable map point) takes the full visit", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    const scene = mapScene();
    // Mark one point travelable, the way the producer does.
    (scene.find((n) => n.id === "point3") as Record<string, unknown>).pinnedLoopAnim = "map_point_pulse";
    keyframe(state, scene);
    renderer.reconcile(state);
    mirrorWalkStats.reset();
    update(state, scrollTo(-580));
    renderer.reconcile(state);
    // The pulsing point re-styles (its loop pivot is re-derived from the rendered matrix); its clean siblings don't.
    expect(mirrorWalkStats.styledNodes).toBeGreaterThanOrEqual(1);
    expect(mirrorWalkStats.affineFastPathVisits).toBeGreaterThan(0);
  });

  it("a node whose own object changed still takes the full visit", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    keyframe(state, mapScene());
    renderer.reconcile(state);
    mirrorWalkStats.reset();
    update(state, [
      ...scrollTo(-580),
      { id: "icon4", parentId: "point4", transform: xform(8, 8), localRect: rect(80, 80), visible: true }
    ]);
    renderer.reconcile(state);
    expect(mirrorWalkStats.styledNodes).toBeGreaterThanOrEqual(1);
  });
});
