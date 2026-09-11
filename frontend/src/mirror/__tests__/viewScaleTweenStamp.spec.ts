import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import { resolveSceneInfo } from "@/mirror/canvas/hitTest";
import {
  createMirrorRenderer,

  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// WS-SHOP (round 6) web twin of the native ViewScaler endpoint-stamp fix: a GROUP (the shop SlotsContainer) parked
// entirely off-stage while a client-replayed TRANSFORM tween slides it on-screen must render at the merchant group
// scale for the WHOLE slide — applyViewScalePass re-measures it from the stashed tween ENDPOINT global. A parked group
// with NO tween (the closed shop) must stay un-scaled (the P4 phantom fix).

const MERCHANT = "res://scenes/merchant/merchant_inventory.tscn";

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

// The shop scene root (carries the merchant sceneFilePath → the SlotsContainer child resolves relPath "SlotsContainer").
function shopRoot(): Record<string, unknown> {
  return {
    id: "shop",
    parentId: null,
    name: "MerchantInventory",
    nodeType: "Control",
    sceneFilePath: MERCHANT,
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } },
    visible: true
  };
}

// The shop rug + all items as one group, PARKED at local y=−1000 (the closed shop) with a real 1747×978 box.
function slotsContainer(localY: number): Record<string, unknown> {
  return {
    id: "SlotsContainer",
    parentId: "shop",
    name: "SlotsContainer",
    nodeType: "TextureRect",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 118, y: localY } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 1747, y: 978 } },
    visible: true
  };
}

function fullLocal(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "shop", upserts: nodes, orderedIds: order })!
  );
}

function hintsOnly(state: MirrorState, hints: unknown[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "shop", hints })!);
}

function el(stage: HTMLElement, id: string): HTMLElement {
  return stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
}

function matrixCount(transform: string): number {
  return (transform.match(/matrix\(/g) ?? []).length;
}

function firstFactor(transform: string): number {
  const m = /matrix\(([^)]*)\)/.exec(transform);
  return m ? Number(m[1].split(",")[0].trim()) : Number.NaN;
}

// A transform tween hint sliding the SlotsContainer to `endLocalY` (the END LOCAL transform, lifted by the parent).
function slideHint(endLocalY: number): Record<string, unknown> {
  return { targetId: "SlotsContainer", property: "position", durationMs: 300, trans: "Expo", ease: "Out", endTransform: [1, 0, 0, 1, 118, endLocalY] };
}

describe("WS-SHOP view-scale endpoint tween-stamp (web twin)", () => {
  let clock = 0;

  beforeEach(() => {
    document.body.innerHTML = "";
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a parked closed shop (no tween) stays un-scaled — the P4 phantom fix holds", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    fullLocal(state, [shopRoot(), slotsContainer(-1000)], ["shop", "SlotsContainer"]);
    renderer.reconcile(state);

    const t = el(stage, "SlotsContainer").style.transform;
    expect(matrixCount(t)).toBe(1); // only its own parked placement — no scale prepended
  });

  it("a parked group slid on-screen by a transform tween renders at the merchant group scale (endpoint stamp)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    fullLocal(state, [shopRoot(), slotsContainer(-1000)], ["shop", "SlotsContainer"]);
    renderer.reconcile(state);
    expect(matrixCount(el(stage, "SlotsContainer").style.transform)).toBe(1); // parked, un-scaled

    // The open slide: a transform tween to an on-screen local. The streamed box stays parked (hints-only delta) but
    // applyViewScalePass re-measures from the stashed endpoint global → the group renders scaled for the whole slide.
    hintsOnly(state, [slideHint(51)]);
    renderer.reconcile(state);

    const t = el(stage, "SlotsContainer").style.transform;
    expect(matrixCount(t)).toBe(2); // scale prepended ahead of the endpoint base
    expect(firstFactor(t)).toBeCloseTo(1.1, 5);
  });

  // WS6 — the reported defect: "the shop inventory often ends PARTIALLY closed, with the bottom of the panel visible
  // at the TOP of the screen". The producer suppresses per-frame transforms for a tween's window, so during the CLOSE
  // slide the streamed box still holds the OPEN position while the element's base transform is already the CLOSED
  // (off-stage) endpoint. Measuring the streamed box produced a stamp for the OPEN position that was composed onto the
  // CLOSED transform, dragging the panel back into view (with the pre-WS6 clamp, right to the top edge).
  it("a CLOSE slide is not stamped even though its STREAMED box is still on-stage", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    fullLocal(state, [shopRoot(), slotsContainer(80)], ["shop", "SlotsContainer"]); // OPEN and on-stage
    renderer.reconcile(state);
    expect(matrixCount(el(stage, "SlotsContainer").style.transform)).toBe(2); // open ⇒ scaled

    // The close slide: a transform tween back to the parked local. The streamed box does NOT move (hints-only delta).
    hintsOnly(state, [slideHint(-1000)]);
    renderer.reconcile(state);

    const t = el(stage, "SlotsContainer").style.transform;
    expect(matrixCount(t)).toBe(1); // no scale composed onto the closed endpoint → nothing dragged back on-stage
  });

  // A slide between two ON-STAGE positions is measured at the ENDPOINT — the transform the stamp is composed onto.
  it("an on-stage → on-stage slide is stamped at the ENDPOINT, not the stale streamed box", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    fullLocal(state, [shopRoot(), slotsContainer(80)], ["shop", "SlotsContainer"]);
    renderer.reconcile(state);

    hintsOnly(state, [slideHint(0)]);
    renderer.reconcile(state);

    const t = el(stage, "SlotsContainer").style.transform;
    expect(matrixCount(t)).toBe(2);
    expect(firstFactor(t)).toBeCloseTo(1.1, 5);
    // noClamp (WS6) ⇒ pure scale about the ENDPOINT box centre (0 + 978/2 = 489), so the design-space translate is
    // pivotY·(1−k) = 489·(−0.1) = −48.9. Measured at the stale streamed box (80 + 489 = 569) it would be −56.9.
    const m = /matrix\(([^)]*)\)/.exec(t)!;
    expect(Number(m[1].split(",")[5])).toBeCloseTo(-48.9, 3);
  });

  it("a parked group whose tween endpoint is ALSO off-stage never stamps (phantom stays fixed)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    fullLocal(state, [shopRoot(), slotsContainer(-1000)], ["shop", "SlotsContainer"]); // parked off-stage
    renderer.reconcile(state);

    // A tween whose endpoint is ALSO off-stage (e.g. a close-slide re-parking it) — the endpoint re-measure rejects it,
    // so a still-parked group with an off-stage endpoint stays un-scaled.
    hintsOnly(state, [slideHint(-2000)]);
    renderer.reconcile(state);

    expect(matrixCount(el(stage, "SlotsContainer").style.transform)).toBe(1);
  });
});

// M2 — THE CANVAS ARM reaches the same answer WITHOUT an endpoint substitution.
//
// The DOM needs one because its stamp is PREPENDED onto an element whose base transform the pin already holds at
// the tween's endpoint: measuring the streamed box there would mix two positions, and the shop CLOSE slide is the
// visible failure. The canvas walk has no element and no pin — it re-derives every node's pose from scratch each
// frame, and a replayed tween arrives as a `transformOverrides` entry that IS that pose. So "measure where you
// apply" is the same rule, expressed once instead of twice, and the two stages converge exactly at settle.
//
describe("the canvas arm measures the APPLIED pose (no endpoint substitution needed)", () => {
  function canvasStamps(localY: number, override?: readonly number[]) {
    const state = createMirrorState();
    fullLocal(state, [shopRoot(), slotsContainer(localY)], ["shop", "SlotsContainer"]);
    return buildDrawList(state, createDrawList<string>(), {
      assert: true,
      transformOverrides: override ? new Map([["SlotsContainer", override]]) : null,
      viewScaleEnv: {
        enabled: () => true,
        sceneOf: (id) => resolveSceneInfo(id, state.nodes)
      }
    }).viewScaleStamps;
  }

  it("a parked closed shop is not stamped — the P4 phantom fix holds here too", () => {
    expect(canvasStamps(-1000).size).toBe(0);
  });

  it("an on-screen shop is stamped at the merchant group scale", () => {
    const stamps = canvasStamps(51);
    expect(stamps.get("SlotsContainer")?.k).toBeCloseTo(1.1, 6);
  });

  it("mid-slide, the stamp follows the REPLAYED sample rather than the parked streamed box", () => {
    // The producer suppresses per-frame transforms for the tween window, so the streamed box is still parked
    // off-stage while the client's own replay has the panel half-way on.
    const stamps = canvasStamps(-1000, [1, 0, 0, 1, 118, 200]);
    const stamp = stamps.get("SlotsContainer");
    expect(stamp?.k).toBeCloseTo(1.1, 6);
    expect(stamp?.box).toEqual({ x: 118, y: 200, w: 1747, h: 978 });
  });

  it("…and a CLOSE slide stops being stamped as soon as the replay carries it off-stage", () => {
    expect(canvasStamps(51, [1, 0, 0, 1, 118, -1400]).size).toBe(0);
  });
});
