import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PROCEED_GLOW_TOKEN } from "@/mirror/animAttributes";
import {
  createMirrorRenderer,

  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterAll(() => {
});

// R10-B2 — the proceed button's additive glow (bridge-mod Sts2ProceedGlow). Its own alpha sweeps 0.75 → 0.25 →
// 0.75 on two 0.5s LINEAR legs, FOREVER, on every screen that shows Proceed: the sole churner on a treasure room's
// wire (60.1 deltas/s) and 91% of a card-reward screen's.
//
// The producer pins the alpha at the loop's own resting value (PinnedAlpha = LoopMaxAlpha = 0.75) and keeps the RGB
// streaming, so the client cannot re-animate that alpha — it is baked into the streamed colour the element's own
// `opacity` carries. The replay therefore MULTIPLIES it: the animSelf child (which wraps the node's paint) sweeps
// opacity 1 ↔ 0.25/0.75, and 0.75 × [1 … 1/3] is exactly the 0.75 ↔ 0.25 sweep against whatever RGB is live.
//
// Fixture numbers come off a recorded wire (.sts2/bench/r8-treasure-open.ndjson): `Image/Outline`, a leaf
// TextureRect painting a 391×188 atlas region additively, behind its parent. Its `selfModulate` alpha is shown
// here as the producer would pin it (#ffcc00bf = 191/255, the 8-bit encoding of 0.75).
const PINNED_SELF_MODULATE = "#ffcc00bf";
const PINNED_ALPHA = 191 / 255;
const IDENTITY = { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 } };

function outlineUpsert(pinnedLoopAnim: string | null, selfModulateHtml = PINNED_SELF_MODULATE) {
  return {
    id: "outline",
    parentId: "image",
    name: "Outline",
    nodeType: "Godot.TextureRect",
    transform: { ...IDENTITY, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 296, y: 155 } },
    texture: { resourcePath: "res://images/atlases/compressed_0.png" },
    textureRegion: { position: { x: 1502, y: 510 }, size: { x: 391, y: 188 } },
    textureMargin: { position: { x: 1, y: 2 }, size: { x: 2, y: 4 } },
    textureStretchMode: 5,
    material: { resourcePath: "res://themes/canvas_item_material_additive_shared.tres" },
    canvasBlendMode: 1,
    showBehindParent: true,
    modulate: { html: "#ffffffff" },
    selfModulate: { html: selfModulateHtml },
    mouseFilter: 2,
    visible: true,
    pinnedLoopAnim
  };
}

function proceedDelta(pinnedLoopAnim: string | null) {
  return parseSceneDelta({
    type: "scene-delta",
    full: true,
    screenType: "run",
    orderedIds: ["proceed", "image", "outline"],
    upserts: [
      {
        id: "proceed",
        parentId: null,
        name: "ProceedButton",
        nodeType: "MegaCrit.Sts2.Core.Nodes.CommonUi.NProceedButton",
        sceneFilePath: "res://scenes/ui/proceed_button.tscn",
        transform: { ...IDENTITY, origin: { x: 1500, y: 900 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 296, y: 155 } },
        visible: true
      },
      {
        id: "image",
        parentId: "proceed",
        name: "Image",
        nodeType: "Godot.TextureRect",
        transform: { ...IDENTITY, origin: { x: 0, y: 0 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 296, y: 155 } },
        texture: { resourcePath: "res://images/atlases/compressed_0.png" },
        textureRegion: { position: { x: 1, y: 185 }, size: { x: 381, y: 178 } },
        textureStretchMode: 5,
        mouseFilter: 2,
        visible: true
      },
      outlineUpsert(pinnedLoopAnim)
    ]
  })!;
}

function outlineDelta(pinnedLoopAnim: string | null, selfModulateHtml = PINNED_SELF_MODULATE) {
  return parseSceneDelta({
    type: "scene-delta",
    full: false,
    screenType: "run",
    upserts: [outlineUpsert(pinnedLoopAnim, selfModulateHtml)]
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

function proceedState(pinnedLoopAnim: string | null): MirrorState {
  const state = createMirrorState();
  applySceneDelta(state, proceedDelta(pinnedLoopAnim));
  return state;
}

function outlineEl(stage: HTMLElement): HTMLElement {
  return stage.querySelector('[data-node-id="outline"]') as HTMLElement;
}

function animSelfOf(el: HTMLElement): HTMLElement | null {
  return el.querySelector(":scope > .mirror-anim-self");
}

describe("proceed glow (producer-pinned loop replay)", () => {
  it("carries the token off the wire onto the retained node", () => {
    expect(proceedState(PROCEED_GLOW_TOKEN).nodes.get("outline")!.pinnedLoopAnim).toBe(PROCEED_GLOW_TOKEN);
    // Focused / pressed / disabled → the loop is dead and the producer stops naming it (those alphas stream live).
    expect(proceedState(null).nodes.get("outline")!.pinnedLoopAnim).toBeNull();
  });

  it("sweeps opacity on an animSelf child that WRAPS the glow's paint", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(proceedState(null));
    const el = outlineEl(stage);
    expect(animSelfOf(el)).toBeNull();

    renderer.reconcile(proceedState(PROCEED_GLOW_TOKEN));
    const el2 = outlineEl(stage);
    const animSelf = animSelfOf(el2)!;
    expect(animSelf).not.toBeNull();
    // The glow's atlas placeholder is INSIDE the animated layer — a child's opacity multiplies its
    // parent's, which is the whole mechanism; animating a sibling would fade nothing.
    expect(animSelf.querySelector(".mirror-atlas-page")).not.toBeNull();
    expect(el2.querySelector(":scope > .mirror-atlas-page")).toBeNull();

    // Two 500ms LINEAR legs (Tween's default transition), alternate + infinite: one `alternate` iteration is
    // LoopLegMs, and the value-keyed keyframe carries the exact endpoints 1 ↔ 0.25/0.75 = 0.33333.
    expect(animSelf.style.animation).toContain("spirectl-glow-pulse-1-0p33333");
    expect(animSelf.style.animation).toContain("500ms");
    expect(animSelf.style.animation).toContain("linear");
    expect(animSelf.style.animation).toContain("alternate");
    expect(animSelf.style.animation).toContain("infinite");
    // No rotation is involved, so no pivot/transform-origin is written at all.
    expect(animSelf.style.transformOrigin).toBe("");
  });

  it("keeps the element's own opacity at the streamed (pinned) alpha, and its style byte-untouched", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(proceedState(null));
    const el = outlineEl(stage);
    const before = el.style.cssText;
    // modulate.a (1) × self_modulate.a (the pinned 0.75, 8-bit encoded) — the value the child's sweep multiplies.
    expect(Number(el.style.opacity)).toBeCloseTo(PINNED_ALPHA, 5);
    expect(el.style.mixBlendMode).toBe("plus-lighter"); // the additive material stays on the element

    renderer.reconcile(proceedGlowState());
    expect(el.style.cssText).toBe(before);
    expect(Number(el.style.opacity)).toBeCloseTo(PINNED_ALPHA, 5);
    expect(el.style.animation).toBe("");
    // Composed: 0.75 × [1 … 1/3] = the 0.75 ↔ 0.25 sweep on screen, against whatever RGB the producer streams.
    expect(PINNED_ALPHA * (0.25 / 0.75)).toBeCloseTo(0.25, 2);
  });

  it("keeps streaming the glow's RGB while the loop runs (only the alpha was folded)", () => {
    const { stage, renderer } = harness();
    const state = proceedState(PROCEED_GLOW_TOKEN);
    renderer.reconcile(state);
    const el = outlineEl(stage);
    const animSelf = animSelfOf(el)!;
    const running = animSelf.style.animation;

    // A real colour change (the producer emits it with the alpha still pinned) must reach the browser — and must
    // NOT restart the shimmer: the signature is the token alone for this kind, so a re-style is inert.
    applySceneDelta(state, outlineDelta(PROCEED_GLOW_TOKEN, "#ff0000bf"));
    renderer.reconcile(state);
    expect(animSelf.style.animation).toBe(running);
    expect(Number(el.style.opacity)).toBeCloseTo(PINNED_ALPHA, 5);
  });

  it("is idempotent across a re-emit and tears down on clear", () => {
    const { stage, renderer } = harness();
    const state = proceedState(PROCEED_GLOW_TOKEN);
    renderer.reconcile(state);
    const el = outlineEl(stage);
    const animSelf = animSelfOf(el)!;

    animSelf.style.animation = "sentinel-untouched 1ms linear";
    applySceneDelta(state, outlineDelta(PROCEED_GLOW_TOKEN));
    renderer.reconcile(state);
    expect(animSelf.style.animation).toBe("sentinel-untouched 1ms linear");

    // The button gets focused → `OnFocus` kills the loop and one-shots the alpha to 1; the producer stops naming
    // the loop and streams that alpha live. The replay has to get out of the way completely.
    applySceneDelta(state, outlineDelta(null, "#ffcc00ff"));
    renderer.reconcile(state);
    expect(animSelf.style.animation).toBe("");
    expect(animSelfOf(el)).toBe(animSelf); // layer kept (with the paint), only the animation goes
    expect(animSelf.querySelector(".mirror-atlas-page")).not.toBeNull();
    expect(Number(el.style.opacity)).toBeCloseTo(1, 5);
  });

});

// The glow reached the way the producer ships it: the full tree with the loop absent, then the single volatile
// upsert that names it once the button is enabled + unfocused + pulsing.
function proceedGlowState(): MirrorState {
  const state = createMirrorState();
  applySceneDelta(state, proceedDelta(null));
  applySceneDelta(state, outlineDelta(PROCEED_GLOW_TOKEN));
  return state;
}
