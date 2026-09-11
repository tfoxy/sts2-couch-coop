import { mount } from "@vue/test-utils";
import { beforeAll, describe, expect, it } from "vitest";

import MirrorView from "@/mirror/MirrorView.vue";
import { MAP_POINT_PULSE_TOKEN, pinnedLoopBinding, pinnedLoopPhaseMs } from "@/mirror/animAttributes";
import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import { createDrawList } from "@godot-scene-web/canvas";
import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import { createIdleAnimSample, resolveIdleAnim, sampleIdleAnim } from "@/mirror/canvas/idleAnim";
import { placementBox } from "@/mirror/nodeStyles";

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

// A map point as the producer streams it with the R12b fold ON: the point root, then the pulsing icon container
// PINNED to its resting scale (basis = a pure rotation — the per-point random tilt survives) and carrying the
// `pinnedLoopAnim` token, then the icon that rides the container. Numbers taken off a real recorded wire
// (.sts2/ws-churn/fix-ON-map.ndjson) so the pivot algebra below is checked against the real thing.
function mapPointDelta(pinnedLoopAnim: string | null) {
  return parseSceneDelta({
    type: "scene-delta",
    full: true,
    screenType: "run",
    orderedIds: ["point", "iconContainer", "icon"],
    upserts: [
      {
        id: "point",
        parentId: null,
        name: "NormalMapPoint",
        nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.Map.NNormalMapPoint",
        sceneFilePath: "res://scenes/ui/normal_map_point.tscn",
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 445.4, y: 971.76 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 56, y: 56 } },
        visible: true
      },
      {
        id: "iconContainer",
        parentId: "point",
        name: "IconContainer",
        nodeType: "Godot.Control",
        // Pinned: |xAxis| == 1 (the pulse divided out), origin = pivot - R*pivot for pivot (28, 28).
        transform: {
          xAxis: { x: 0.99997884, y: 0.0065023587 },
          yAxis: { x: -0.0065023587, y: 0.99997884 },
          origin: { x: 0.1826477, y: -0.18145752 }
        },
        localRect: { position: { x: 0, y: 0 }, size: { x: 56, y: 56 } },
        visible: true,
        pinnedLoopAnim
      },
      {
        id: "icon",
        parentId: "iconContainer",
        name: "Icon",
        nodeType: "Godot.TextureRect",
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: -18, y: -18 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 92, y: 92 } },
        visible: true
      }
    ]
  })!;
}

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function mapState(pinnedLoopAnim: string | null): MirrorState {
  const state = createMirrorState();
  applySceneDelta(state, mapPointDelta(pinnedLoopAnim));
  return state;
}

describe("map-point pulse (producer-pinned loop replay)", () => {
  it("carries the token off the wire onto the retained node", () => {
    expect(mapState(MAP_POINT_PULSE_TOKEN).nodes.get("iconContainer")!.pinnedLoopAnim).toBe(MAP_POINT_PULSE_TOKEN);
    // Absent on the wire (the overwhelming majority of nodes, and a map point once you travel to it) → null.
    expect(mapState(null).nodes.get("iconContainer")!.pinnedLoopAnim).toBeNull();
  });

  it("runs the pulse on the flagged node and NOT on its unflagged neighbours", () => {
    const wrapper = mount(MirrorView, { props: { state: mapState(MAP_POINT_PULSE_TOKEN), revision: 1 } });

    const container = wrapper.find('[data-node-id="iconContainer"]').element as HTMLElement;
    expect(container.style.animation).toContain("spirectl-pivot-pulse");
    // 2*pi/4 = 1570.796ms period → a 785.398ms `alternate` half-leg, easeInOutSine so the two legs form a real sine.
    expect(container.style.animation).toContain("785.398");
    expect(container.style.animation).toContain("alternate");
    expect(container.style.animation).toContain("infinite");
    // The sweep endpoints are the pulse's extrema: 1.2 ± 0.25.
    expect(container.style.getPropertyValue("--spirectl-pulse-from")).toBe("0.95");
    expect(container.style.getPropertyValue("--spirectl-pulse-to")).toBe("1.45");

    // The point root and the icon are NOT flagged — only the container scales, and the icons ride it via the DOM
    // nesting. A pulse on them would double-apply.
    for (const id of ["point", "icon"]) {
      const el = wrapper.find(`[data-node-id="${id}"]`).element as HTMLElement;
      expect(el.style.animation).toBe("");
    }
  });

  it("composes with the baked matrix instead of rewriting `transform` (the WS-A geometry-epoch invariant)", () => {
    const pulsing = mount(MirrorView, { props: { state: mapState(MAP_POINT_PULSE_TOKEN), revision: 1 } });
    const still = mount(MirrorView, { props: { state: mapState(null), revision: 1 } });

    const pulsingEl = pulsing.find('[data-node-id="iconContainer"]').element as HTMLElement;
    const stillEl = still.find('[data-node-id="iconContainer"]').element as HTMLElement;

    // Byte-identical placement: the pulse rides `scale:`/`translate:` (set outside the style map), so the baked
    // matrix — the value every epoch-cached geometry structure is derived from — is untouched.
    expect(pulsingEl.style.transform).toBe(stillEl.style.transform);
    expect(pulsingEl.style.transform).toContain("matrix(");
    expect(pulsingEl.style.transform).not.toContain("scale(");
    // ...and so is the hit-test/geometry box, which is why a pulsing node's tap target doesn't grow with it (in
    // the game the clickable box is the map POINT, which never scales).
    expect(pulsingEl.style.width).toBe(stillEl.style.width);
    expect(pulsingEl.style.height).toBe(stillEl.style.height);
  });

  it("anchors the scale at the node's pivot via the paired translate", () => {
    const wrapper = mount(MirrorView, { props: { state: mapState(MAP_POINT_PULSE_TOKEN), revision: 1 } });
    const el = wrapper.find('[data-node-id="iconContainer"]').element as HTMLElement;

    // The container's element matrix maps its local pivot (28, 28) essentially back onto (28, 28) — that is what a
    // Godot Control's pivot-anchored transform DOES (the tilt rotates about the pivot, so the pivot is its fixed
    // point). The translate endpoints must therefore be (1 - k)·28 on both axes.
    const from = Number(el.style.getPropertyValue("--spirectl-pulse-from-x").replace("px", ""));
    const to = Number(el.style.getPropertyValue("--spirectl-pulse-to-x").replace("px", ""));
    expect(from).toBeCloseTo((1 - 0.95) * 28, 3);
    expect(to).toBeCloseTo((1 - 1.45) * 28, 3);
    expect(Number(el.style.getPropertyValue("--spirectl-pulse-from-y").replace("px", ""))).toBeCloseTo(from, 3);
    expect(Number(el.style.getPropertyValue("--spirectl-pulse-to-y").replace("px", ""))).toBeCloseTo(to, 3);
  });

  it("stops the pulse when the node leaves the travelable set", () => {
    // Driven through the renderer directly (not the Vue wrapper) so the second walk is SYNCHRONOUS — MirrorView
    // schedules its re-walk on a rAF tick, which jsdom does not run.
    const { renderer } = harness();
    const state = mapState(MAP_POINT_PULSE_TOKEN);
    renderer.reconcile(state);
    const el = document.querySelector('[data-node-id="iconContainer"]') as HTMLElement;
    expect(el.style.animation).toContain("spirectl-pivot-pulse");

    // Travelling to a node clears `_isEnabled` on every point → the producer stops shipping the token. This is the
    // ONE upsert the whole fold costs, so it must actually land. (A volatile-only upsert with the field ABSENT is
    // exactly what the producer sends — mergeNode takes it from the upsert, so it must clear, not carry forward.)
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [{ id: "iconContainer", parentId: "point" }]
      })!
    );
    expect(state.nodes.get("iconContainer")!.pinnedLoopAnim).toBeNull();
    renderer.reconcile(state);

    expect(el.style.animation).toBe("");
    expect(el.style.getPropertyValue("scale")).toBe("");
    expect(el.style.getPropertyValue("translate")).toBe("");
  });

});

describe("pinnedLoopBinding", () => {
  it("maps the map-point token onto the pinned sweep", () => {
    const b = pinnedLoopBinding(MAP_POINT_PULSE_TOKEN, "n1", 10, 20)!;
    expect(b.kind).toBe("pivotPulse");
    expect(b.scaleFrom).toBeCloseTo(0.95, 10);
    expect(b.scaleTo).toBeCloseTo(1.45, 10);
    expect(b.durationMs).toBeCloseTo(1570.7963267948966, 6);
    expect(b.pivotX).toBe(10);
    expect(b.pivotY).toBe(20);
  });

  it("returns null for an unknown token so a newer producer degrades to the rest pose", () => {
    expect(pinnedLoopBinding("someFutureLoop", "n1", 0, 0)).toBeNull();
  });

  it("gives each node a stable, in-range, DESYNCED phase", () => {
    const period = 1570.7963267948966;
    // Stable across calls: a re-style must never jump a node's phase mid-sine.
    expect(pinnedLoopPhaseMs("815825701623", period)).toBe(pinnedLoopPhaseMs("815825701623", period));
    // In range, and different per node — every map point starts its pulse at a random phase, so the points on a
    // map visibly breathe out of step; lockstep would read as one blinking group.
    const phases = ["1", "2", "3", "815825701623", "815825701624", "999999999"].map((id) =>
      pinnedLoopPhaseMs(id, period)
    );
    for (const p of phases) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(period);
    }
    expect(new Set(phases).size).toBe(phases.length);
  });
});

// --- the CANVAS arm (R5) ----------------------------------------------------------------------------------------
//
// Same producer token, same binding, same endpoints — a different way of putting them on screen. The DOM backend
// composes `scale:` + a paired `translate:` on the element that already carries the baked matrix; the canvas
// backend conjugates a uniform scale in the node's OWN local space and right-multiplies it onto the node's global.
// The two are the same affine (see `idleAnim.ts`'s header), and what these tests pin is the consequence the map
// actually depends on: the icon GROWS but does not MOVE, whatever is stacked above it.

describe("map-point pulse — the canvas arm", () => {
  const CENTRE_X = 28;
  const CENTRE_Y = 28;

  function containerNode(state: MirrorState) {
    return state.nodes.get("iconContainer")!;
  }

  function pulsePlan(state: MirrorState) {
    const node = containerNode(state);
    const box = placementBox(node)!;
    return resolveIdleAnim(node, null, box);
  }

  /** The design-space image of the container's own pivot, at `phase`, under an optional ancestor scale. */
  function pivotAt(state: MirrorState, phase: number | null, ancestorScale = 1): [number, number] {
    const localAnims = new Map<string, { pre: null; post: number[] }>();
    if (phase !== null) {
      const out = createIdleAnimSample();
      sampleIdleAnim(pulsePlan(state)!.plan, phase, out);
      localAnims.set("iconContainer", { pre: null, post: [...out.post] });
    }
    const point = state.nodes.get("point")!;
    state.nodes.set("point", {
      ...point,
      transform: [ancestorScale, 0, 0, ancestorScale, point.transform![4], point.transform![5]]
    });
    const build = buildDrawList(state, createDrawList<string>(), {
      localAnims: localAnims.size > 0 ? localAnims : null
    });
    const m = build.hitEntries.find((e) => e.nodeId === "iconContainer")!.mFinal;
    return [m[0] * CENTRE_X + m[2] * CENTRE_Y + m[4], m[1] * CENTRE_X + m[3] * CENTRE_Y + m[5]];
  }

  it("resolves through the producer's own token, and pivots at the container's centre", () => {
    const resolved = pulsePlan(mapState(MAP_POINT_PULSE_TOKEN))!;
    expect(resolved.plan.kind).toBe("pivotPulse");
    expect([resolved.plan.pivotX, resolved.plan.pivotY]).toEqual([CENTRE_X, CENTRE_Y]);
    // The wire family's clock is unknowable and permanently running, so its phase rides the shared timeline.
    expect(resolved.anchor).toBe("document");
  });

  it("sweeps the pinned scale endpoints", () => {
    const plan = pulsePlan(mapState(MAP_POINT_PULSE_TOKEN))!.plan;
    const binding = pinnedLoopBinding(MAP_POINT_PULSE_TOKEN, "iconContainer", 0, 0)!;
    const out = createIdleAnimSample();
    sampleIdleAnim(plan, 0, out);
    expect(out.post[0]).toBeCloseTo(binding.scaleFrom!, 9);
    sampleIdleAnim(plan, 0.5, out);
    expect(out.post[0]).toBeCloseTo(binding.scaleTo!, 9);
  });

  it("holds the pulse's CENTRE fixed through the whole cycle", () => {
    const rest = pivotAt(mapState(MAP_POINT_PULSE_TOKEN), null);
    for (const phase of [0, 0.25, 0.5, 0.75]) {
      const at = pivotAt(mapState(MAP_POINT_PULSE_TOKEN), phase);
      expect(at[0]).toBeCloseTo(rest[0], 6);
      expect(at[1]).toBeCloseTo(rest[1], 6);
    }
  });

  it("composes INSIDE whatever is stamped above it", () => {
    // A view-scale stamp is a design-space matrix LEFT-multiplied onto the node's drawn pose, which is exactly
    // what an ancestor's own matrix is — so a scaling ancestor tests the same composition the map's enlarged-item
    // stamp would. The centre still does not move: the pulse's fixed point is fixed in every space above it.
    const rest = pivotAt(mapState(MAP_POINT_PULSE_TOKEN), null, 1.25);
    const pulsed = pivotAt(mapState(MAP_POINT_PULSE_TOKEN), 0.4, 1.25);
    expect(pulsed[0]).toBeCloseTo(rest[0], 6);
    expect(pulsed[1]).toBeCloseTo(rest[1], 6);
  });

  it("resolves NOTHING when the point carries no token", () => {
    expect(pulsePlan(mapState(null))).toBeNull();
  });

});
