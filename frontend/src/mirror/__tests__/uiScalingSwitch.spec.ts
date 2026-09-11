// THE READABILITY-SCALING MASTER SWITCH (`mirrorSettings.uiScaling`, the panel's "Enlarge small UI"), at the seam
// that actually applies it: `MirrorRenderer.setUiScaling`.
//
// The four families it covers are each pinned by their own suite (viewScale, hoverTipScale*, textScaleClasses,
// nodeStyles' clip branch). What is pinned HERE is the thing none of those can see — that flipping the switch on
// a LIVE renderer leaves nothing behind:
//
//   U1  OFF un-draws what was already stamped. Both scale passes write `el.style.transform` outside the style
//       cache, and `applyStyleMap` only writes a property whose cached value CHANGED — so a walk cannot clean a
//       stamped element and the flip has to restore the base itself. This is the regression that would otherwise
//       ship as "turning it off does nothing until the tooltip moves".
//   U2  OFF empties the view-scale INPUT registry, so the pointer stops being remapped off an enlarged item's halo.
//   U3  ON again re-registers and re-stamps (the items are resolved inside the walk, so this needs a reconcile).
//   U4  the TEXT half is the generated stylesheet, disabled and re-enabled in place.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import {
  installTextScaleSheet,
  textScaleEnabled,
  TEXT_SCALE_STYLE_ID,
  __resetTextScaleSheetForTest
} from "@/mirror/textScaleClasses";
import { setUiScalingEnabled } from "@/mirror/uiScaling";
import { VIEW_SCALE_PILE } from "@/mirror/viewScale";

const DRAW_PILE = "res://scenes/combat/draw_pile.tscn";

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}
function boxAt(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}
function el(stage: HTMLElement, id: string): HTMLElement {
  return stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
}
function matrixCount(transform: string): number {
  return (transform.match(/matrix\(/g) ?? []).length;
}

/**
 * One view-scale ITEM (the combat draw pile, 1.25 about its own bottom-left corner) and one HoverTip set — one of
 * each family that stamps a transform, so the restore is checked on both kinds of stamp.
 */
function scene(state: MirrorState): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: [
        {
          id: "pile",
          parentId: null,
          name: "pile",
          nodeType: "NDrawPileButton",
          sceneFilePath: DRAW_PILE,
          transform: xform(15, 985),
          localRect: boxAt(80, 80),
          visible: true,
          mouseFilter: 0,
          fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" }
        },
        {
          id: "tips",
          parentId: null,
          name: "tips",
          nodeType: "HoverTips.NHoverTipSet",
          transform: xform(100, 200),
          localRect: boxAt(400, 300),
          visible: true
        },
        {
          id: "card",
          parentId: "tips",
          name: "card",
          nodeType: "NHoverTipCardContainer",
          transform: xform(1040, 660),
          localRect: boxAt(360, 122),
          visible: true,
          fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" }
        }
      ],
      orderedIds: ["pile", "tips", "card"]
    })!
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  __resetTextScaleSheetForTest();
});

afterEach(() => {
  // The switch is a MODULE-level flag shared by every renderer in the process — leaving it off would silently
  // disable the enlargements for every later suite in this worker.
  setUiScalingEnabled(true);
  __resetTextScaleSheetForTest();
});

describe("U1 — OFF un-draws what is already stamped", () => {
  it("restores the view-scale item's and the tip root's base transform, with no walk in between", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    scene(state);
    renderer.reconcile(state);

    // Both are composed: the stamp matrix, then the node's own placement.
    expect(matrixCount(el(stage, "pile").style.transform)).toBe(2);
    expect(matrixCount(el(stage, "tips").style.transform)).toBe(2);

    renderer.setUiScaling(false);

    // …and both are back to their clean base — the reconcile that follows in real life is NOT what does this.
    expect(el(stage, "pile").style.transform).toBe("matrix(1, 0, 0, 1, 15, 985)");
    expect(el(stage, "tips").style.transform).toBe("matrix(1, 0, 0, 1, 100, 200)");
  });

  it("a reconcile AFTER the flip re-stamps nothing", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    scene(state);
    renderer.reconcile(state);
    renderer.setUiScaling(false);
    renderer.reconcile(state, { reason: "uiScale" });

    expect(matrixCount(el(stage, "pile").style.transform)).toBe(1);
    expect(matrixCount(el(stage, "tips").style.transform)).toBe(1);
  });
});

describe("U2 — OFF empties the pointer-side registry", () => {
  it("the view-scale input stamps go away, so no pointer is remapped off a halo", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    scene(state);
    renderer.reconcile(state);
    expect(renderer.viewScaleInputStamps().length).toBe(1);

    renderer.setUiScaling(false);
    expect(renderer.viewScaleInputStamps()).toEqual([]);
    renderer.reconcile(state, { reason: "uiScale" });
    expect(renderer.viewScaleInputStamps()).toEqual([]);
  });
});

describe("U3 — ON again re-registers and re-stamps", () => {
  it("needs the walk (items are resolved inside `visit`), and then both stamps are back", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    scene(state);
    renderer.reconcile(state);
    renderer.setUiScaling(false);
    renderer.reconcile(state, { reason: "uiScale" });

    renderer.setUiScaling(true);
    renderer.reconcile(state, { reason: "uiScale" });

    const pile = el(stage, "pile").style.transform;
    expect(matrixCount(pile)).toBe(2);
    expect(pile.startsWith(`matrix(${VIEW_SCALE_PILE}`)).toBe(true);
    expect(matrixCount(el(stage, "tips").style.transform)).toBe(2);
    expect(renderer.viewScaleInputStamps().length).toBe(1);
  });
});

describe("U4 — the TEXT half is the generated sheet", () => {
  it("disables and re-enables it in place, and answers `textScaleEnabled` accordingly", () => {
    const { renderer } = harness();
    installTextScaleSheet();
    const sheet = document.getElementById(TEXT_SCALE_STYLE_ID) as HTMLStyleElement;
    expect(sheet).toBeTruthy();
    expect(sheet.disabled).toBe(false);
    expect(textScaleEnabled()).toBe(true);

    renderer.setUiScaling(false);
    expect(sheet.disabled).toBe(true);
    expect(textScaleEnabled()).toBe(false);

    renderer.setUiScaling(true);
    expect(sheet.disabled).toBe(false);
    expect(textScaleEnabled()).toBe(true);
  });
});
