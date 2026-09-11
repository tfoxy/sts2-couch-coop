import { beforeEach, describe, expect, it } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,


  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import {
  applySceneDelta,
  createMirrorState,
  MIRROR_MAX_DESIGN_WIDTH,
  parseSceneDelta,
  type MirrorState
} from "@/mirror/sceneTree";

// THE STAMP — `data-godot-particle-visible-rect`, the budget gsw clamps a particle canvas's
// travel-derived margin to (the arithmetic itself is `particleVisibleRect.spec.ts`; this is the WALK's
// half). Three claims, and each is a way the chest's coin burst gets cropped or over-allocated if it
// breaks: it lands on the node gsw reads it from, it tracks the node's RENDERED global on BOTH walk
// paths.

const ATTR = "data-godot-particle-visible-rect";
const F = MIRROR_MAX_DESIGN_WIDTH / 1920; // 1.3125

function xform(tx: number, ty: number, a = 1, b = 0, c = 0, d = 1): Record<string, unknown> {
  return { xAxis: { x: a, y: b }, yAxis: { x: c, y: d }, origin: { x: tx, y: ty } };
}

function rect(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}

/** A GpuParticles2D as the producer streams one: a global transform and NO localRect (a Node2D has no box). */
function emitter(id: string, parentId: string | null, tx: number, ty: number): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "GPUParticles2D",
    transform: xform(tx, ty),
    visible: true,
    particleSpec: {
      kind: "GPUParticles2D",
      amount: 32,
      lifetime: 2.5,
      oneShot: true,
      emissionShape: 0,
      blendMode: 0
    },
    particleEmitting: true,
    particleRestartEpoch: 1
  };
}

function control(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: xform(0, 0),
    localRect: rect(1920, 1080),
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

function el(stage: HTMLElement, id: string): HTMLElement {
  const found = stage.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  if (!found) throw new Error(`no element for ${id}`);
  return found;
}

beforeEach(() => {
  document.body.innerHTML = "";
  mirrorWalkStats.reset();
});

describe("the particle visible-rect stamp", () => {
  it("lands on the node carrying the runtime marker, not on the self-layer", () => {
    // gsw reads the rect off the same element it reads `data-godot-particle-specs` from — the
    // `[data-godot-particle-runtime]` node its reconcile selects. (Its shader sibling windows the SELF
    // layer instead, which is why this is worth pinning.)
    const { stage, renderer } = harness();
    const state = createMirrorState();
    keyframe(state, [control("root", null), emitter("gold", "root", 937, 512)]);
    renderer.reconcile(state);

    const node = el(stage, "gold");
    expect(node.getAttribute("data-godot-particle-runtime")).toBe("1");
    expect(node.getAttribute(ATTR)).toBe("-944,-512,1936,1088");
    expect(node.querySelector(`[${ATTR}]`)).toBeNull();
  });

  it("is not stamped on a node that has no particle system", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    keyframe(state, [control("root", null), control("panel", "root", { transform: xform(200, 200) })]);
    renderer.reconcile(state);
    expect(el(stage, "panel").hasAttribute(ATTR)).toBe(false);
  });

  it("follows the emitter when it moves", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    keyframe(state, [control("root", null), emitter("gold", "root", 937, 512)]);
    renderer.reconcile(state);
    expect(el(stage, "gold").getAttribute(ATTR)).toBe("-944,-512,1936,1088");

    // The chest slides to the left edge of the stage: less room to its left, more to its right.
    update(state, [emitter("gold", "root", 240, 512)]);
    renderer.reconcile(state);
    expect(el(stage, "gold").getAttribute(ATTR)).toBe("-240,-512,1920,1088");
  });

  describe("a scrolling ancestor (the ancestor-affine fast path)", () => {
    // The map-scroll shape: ONE volatile upsert on the scroll container, and an emitter underneath whose
    // own node object never changes. That node takes the fast path, which skips the whole restyle — so the
    // stamp has to be re-derived there too, or a scrolling emitter keeps the budget for where it USED to be
    // and its burst is clipped by however far the map has moved.
    function scene(): Record<string, unknown>[] {
      return [control("root", null), control("scroll", "root", { transform: xform(0, 0) }), emitter("gold", "scroll", 937, 512)];
    }
    function scrollTo(y: number): Record<string, unknown>[] {
      return [control("scroll", "root", { transform: xform(0, y) })];
    }

    it("re-derives the rect on the fast path", () => {
      const { stage, renderer } = harness();
      const state = createMirrorState();
      keyframe(state, scene());
      renderer.reconcile(state);
      expect(el(stage, "gold").getAttribute(ATTR)).toBe("-944,-512,1936,1088");

      const before = mirrorWalkStats.affineFastPathVisits;
      update(state, scrollTo(-320));
      renderer.reconcile(state);
      // The emitter really did take the fast path (otherwise this proves nothing about it).
      expect(mirrorWalkStats.affineFastPathVisits).toBeGreaterThan(before);
      // It now renders 320px higher, so it has 320px less stage above it and 320 more below.
      expect(el(stage, "gold").getAttribute(ATTR)).toBe("-944,-192,1936,1088");
    });

  });

  describe("widescreen stretch", () => {
    it("reports the WIDENED stage and the node's own spread shift", () => {
      // Two independent ways to get this wrong, both of which clip the burst on a wide screen: budgeting
      // against the 16:9 box (600px of stage the emitter can reach but is not told about), and measuring
      // from the unshifted global (the emitter is a positional claimer — it renders at 937·F, not 937).
      const { stage, renderer } = harness();
      const state = createMirrorState();
      keyframe(state, [
        control("root", null, { anchorLeft: 0, anchorRight: 1 }),
        emitter("gold", "root", 937, 512)
      ]);
      renderer.setStretch(F);
      renderer.reconcile(state);

      const attr = el(stage, "gold").getAttribute(ATTR)!;
      const [x, , w, h] = attr.split(",").map(Number);
      expect(w).toBeGreaterThanOrEqual(MIRROR_MAX_DESIGN_WIDTH); // the widened stage, not 1920
      expect(h).toBe(1088);
      // The rect still spans the whole stage from where the node RENDERS (937·F ≈ 1229.8): its left edge
      // is at or left of the stage's origin, its right edge at or right of the stage's far side.
      const renderedX = 937 * F;
      expect(x).toBeLessThanOrEqual(-renderedX);
      expect(x + w).toBeGreaterThanOrEqual(MIRROR_MAX_DESIGN_WIDTH - renderedX);
      expect(attr).toBe("-1232,-512,2528,1088");
    });

    it("re-stamps when the stage widens under a resting emitter", () => {
      const { stage, renderer } = harness();
      const state = createMirrorState();
      keyframe(state, [control("root", null, { anchorLeft: 0, anchorRight: 1 }), emitter("gold", "root", 937, 512)]);
      renderer.reconcile(state);
      expect(el(stage, "gold").getAttribute(ATTR)).toBe("-944,-512,1936,1088");

      renderer.setStretch(F);
      renderer.reconcile(state);
      expect(el(stage, "gold").getAttribute(ATTR)).toBe("-1232,-512,2528,1088");
    });
  });

});
