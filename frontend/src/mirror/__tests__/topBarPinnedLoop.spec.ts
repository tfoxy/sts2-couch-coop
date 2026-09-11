import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TOP_BAR_DECK_ROCK_TOKEN,
  TOP_BAR_MAP_ROCK_TOKEN,
  TOP_BAR_SPIN_TOKEN
} from "@/mirror/animAttributes";
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

// R10-B2 — the three top-bar icon loops the R13 producer folds out of the wire (bridge-mod Sts2TopBarFold), named
// on `RuntimeSceneNodeDelta.PinnedLoopAnim` and replayed here on the browser's own clock.
//
// The fixtures below are the REAL nodes, taken off a recorded wire (.sts2/bench/r8-map-live.ndjson): each button's
// `Control/Icon` is an atlas-sprite `Godot.TextureRect` with an HSV shader material, whose element the mirror
// sizes to the texture REGION and positions with a baked matrix. Two consequences the tests pin:
//   * the loop cannot ride that element (an individual `rotate:` over a baked matrix ORBITS the icon), so it rides
//     the animSelf self-layer child — and the icon's paint sub-layer has to move INSIDE that child or
//     the animation would move an empty box;
//   * the pivot is measured in REGION px, not node px (see nodeStyles' elementLocalPoint).
// The producer pins ONLY the rotation and keeps streaming position + scale live — that is what fixed the WS-D
// mispositioning bug — so the headline assertion here is that the element's own style is byte-untouched by the
// token.
interface ButtonFixture {
  scene: string;
  nodeType: string;
  controlOrigin: { x: number; y: number };
  controlRect: { w: number; h: number };
  iconOrigin: { x: number; y: number };
  iconRect: { w: number; h: number };
  region: { x: number; y: number; w: number; h: number };
  // The authored `pivot_offset` mapped into the element's (region-px) space — what `transform-origin` must be.
  expectPivot: { x: number; y: number };
}

const BUTTONS: Record<string, ButtonFixture> = {
  // top_bar_deck_button.tscn: Control/Icon 72×72 painting a 114×98 region, keep-aspect (stretch 5), pivot (36,34).
  // fit = 72/114 → cx = 0, cy = 5.0526 ⇒ pivot maps to (36/fit, (34 − cy)/fit) = (57, 45.8333).
  [TOP_BAR_DECK_ROCK_TOKEN]: {
    scene: "res://scenes/ui/top_bar/top_bar_deck_button.tscn",
    nodeType: "MegaCrit.Sts2.Core.Nodes.TopBar.NTopBarDeckButton",
    controlOrigin: { x: 0, y: 0 },
    controlRect: { w: 80, h: 80 },
    iconOrigin: { x: 4, y: 4 },
    iconRect: { w: 72, h: 72 },
    region: { x: 1920, y: 423, w: 114, h: 98 },
    expectPivot: { x: 57, y: 45.8333 }
  },
  // top_bar_map_button.tscn: Control/Icon 80×64 painting a 114×104 region, pivot (42,32).
  // fit = 64/104 → cx = 4.9231, cy = 0 ⇒ (60.25, 52).
  [TOP_BAR_MAP_ROCK_TOKEN]: {
    scene: "res://scenes/ui/top_bar/top_bar_map_button.tscn",
    nodeType: "MegaCrit.Sts2.Core.Nodes.TopBar.NTopBarMapButton",
    controlOrigin: { x: 0, y: 8 },
    controlRect: { w: 80, h: 64 },
    iconOrigin: { x: 0, y: 0 },
    iconRect: { w: 80, h: 64 },
    region: { x: 1920, y: 317, w: 114, h: 104 },
    expectPivot: { x: 60.25, y: 52 }
  },
  // top_bar_settings_button.tscn: Control/Icon 64×64 painting a 114×110 region, pivot (32,33).
  // fit = 64/114 → cx = 0, cy = 1.1228 ⇒ (57, 56.7812).
  [TOP_BAR_SPIN_TOKEN]: {
    scene: "res://scenes/ui/top_bar/top_bar_settings_button.tscn",
    nodeType: "MegaCrit.Sts2.Core.Nodes.TopBar.NTopBarPauseButton",
    controlOrigin: { x: 8, y: 8 },
    controlRect: { w: 64, h: 64 },
    iconOrigin: { x: 0, y: 0 },
    iconRect: { w: 64, h: 64 },
    region: { x: 1920, y: 205, w: 114, h: 110 },
    expectPivot: { x: 57, y: 56.7812 }
  }
};

const IDENTITY = { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 } };

function buttonDelta(fx: ButtonFixture, pinnedLoopAnim: string | null) {
  return parseSceneDelta({
    type: "scene-delta",
    full: true,
    screenType: "run",
    orderedIds: ["button", "control", "icon"],
    upserts: [
      {
        id: "button",
        parentId: null,
        name: "Button",
        nodeType: fx.nodeType,
        sceneFilePath: fx.scene,
        transform: { ...IDENTITY, origin: { x: 400, y: 0 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 80, y: 80 } },
        visible: true
      },
      {
        id: "control",
        parentId: "button",
        name: "Control",
        nodeType: "Godot.Control",
        transform: { ...IDENTITY, origin: fx.controlOrigin },
        localRect: { position: { x: 0, y: 0 }, size: { x: fx.controlRect.w, y: fx.controlRect.h } },
        mouseFilter: 2,
        visible: true
      },
      iconUpsert(fx, pinnedLoopAnim)
    ]
  })!;
}

// The animated `Control/Icon` itself. Also used on its own as a follow-up (volatile) upsert: the producer re-emits
// just this node when the loop starts/stops, exactly like the map-point fold's single-upsert token flip.
function iconUpsert(fx: ButtonFixture, pinnedLoopAnim: string | null) {
  return {
    id: "icon",
    parentId: "control",
    name: "Icon",
    nodeType: "Godot.TextureRect",
    // The producer divided the rotation out (Sts2TopBarFold.PinRestRotation): the basis is the identity and the
    // origin is the LIVE laid-out position — position/scale keep streaming, only the rotation is pinned.
    transform: { ...IDENTITY, origin: fx.iconOrigin },
    localRect: { position: { x: 0, y: 0 }, size: { x: fx.iconRect.w, y: fx.iconRect.h } },
    texture: { resourcePath: "res://images/atlases/ui_atlas_0.png" },
    textureRegion: {
      position: { x: fx.region.x, y: fx.region.y },
      size: { x: fx.region.w, y: fx.region.h }
    },
    textureMargin: { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } },
    textureStretchMode: 5,
    material: { resourcePath: `${fx.scene}::ShaderMaterial_0` },
    shader: { resourcePath: "res://shaders/hsv.gdshader" },
    shaderParameters: [
      { name: "h", kind: "number", number: 1 },
      { name: "s", kind: "number", number: 1 },
      { name: "v", kind: "number", number: 1 }
    ],
    mouseFilter: 2,
    visible: true,
    pinnedLoopAnim
  };
}

function iconDelta(fx: ButtonFixture, pinnedLoopAnim: string | null) {
  return parseSceneDelta({
    type: "scene-delta",
    full: false,
    screenType: "run",
    upserts: [iconUpsert(fx, pinnedLoopAnim)]
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

function buttonState(fx: ButtonFixture, pinnedLoopAnim: string | null): MirrorState {
  const state = createMirrorState();
  applySceneDelta(state, buttonDelta(fx, pinnedLoopAnim));
  return state;
}

function iconEl(stage: HTMLElement): HTMLElement {
  return stage.querySelector('[data-node-id="icon"]') as HTMLElement;
}

function animSelfOf(el: HTMLElement): HTMLElement | null {
  return el.querySelector(":scope > .mirror-anim-self");
}

function originNumbers(el: HTMLElement): number[] {
  return (el.style.transformOrigin.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

describe.each([
  [TOP_BAR_DECK_ROCK_TOKEN, "deck"],
  [TOP_BAR_MAP_ROCK_TOKEN, "map"],
  [TOP_BAR_SPIN_TOKEN, "settings"]
])("top-bar %s (producer-pinned loop replay)", (token, label) => {
  const fx = BUTTONS[token];

  it(`carries the ${label} token off the wire onto the retained node`, () => {
    expect(buttonState(fx, token).nodes.get("icon")!.pinnedLoopAnim).toBe(token);
    // Screen closed → the producer stops naming the loop and nothing is pinned.
    expect(buttonState(fx, null).nodes.get("icon")!.pinnedLoopAnim).toBeNull();
  });

  it("grows an animSelf child ON DEMAND and moves the icon's paint inside it", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(buttonState(fx, null));
    const el = iconEl(stage);
    // No loop named → no self layer at all; the atlas placeholder is the element's own direct child.
    expect(animSelfOf(el)).toBeNull();
    expect(el.querySelector(":scope > .mirror-atlas-page")).not.toBeNull();

    renderer.reconcile(iconState(fx, token));
    const animSelf = animSelfOf(el);
    expect(animSelf).not.toBeNull();
    // THE paint check: the atlas placeholder is now a child of the animated layer, so the loop actually moves pixels.
    // (Before the nesting it was animSelf's sibling and the rock animated an empty 0-paint box.)
    expect(animSelf!.querySelector(".mirror-atlas-page")).not.toBeNull();
    expect(el.querySelector(":scope > .mirror-atlas-page")).toBeNull();
  });

  it("runs the loop on animSelf, never on the element itself", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(buttonState(fx, token));
    const el = iconEl(stage);
    const animSelf = animSelfOf(el)!;
    expect(el.style.animation).toBe("");
    expect(animSelf.style.animation).not.toBe("");
    // The pivot is the authored `pivot_offset` mapped into the element's REGION-px space.
    const [ox, oy] = originNumbers(animSelf);
    expect(ox).toBeCloseTo(fx.expectPivot.x, 3);
    expect(oy).toBeCloseTo(fx.expectPivot.y, 3);
    expect(animSelf.style.animation).toContain("infinite");
  });

  // THE regression assertion for the mispositioning fix: the fold exists so that position + scale keep STREAMING.
  // A client-side write to the element's own transform (the WS-D pin) is what broke the deck/settings icons, so the
  // element's inline style must be byte-identical with and without the token — before and after it arrives.
  it("leaves the element's own transform/position/inline style byte-untouched", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(buttonState(fx, null));
    const el = iconEl(stage);
    const before = el.style.cssText;
    const beforeTransform = el.style.transform;
    expect(beforeTransform).toContain("matrix(");

    renderer.reconcile(iconState(fx, token));
    expect(el.style.cssText).toBe(before);
    expect(el.style.transform).toBe(beforeTransform);
    expect(el.style.getPropertyValue("rotate")).toBe("");
    expect(el.style.getPropertyValue("scale")).toBe("");
    expect(el.style.getPropertyValue("translate")).toBe("");
    expect(el.style.left).toBe("0px");
    expect(el.style.top).toBe("0px");

    // ...and identical to a renderer that never saw the token at all (a second, independent instance).
    const other = harness();
    other.renderer.reconcile(buttonState(fx, null));
    expect(el.style.cssText).toBe(iconEl(other.stage).style.cssText);
  });

  it("is idempotent: a re-emit of the same token does not restart the loop", () => {
    const { stage, renderer } = harness();
    const state = buttonState(fx, token);
    renderer.reconcile(state);
    const animSelf = animSelfOf(iconEl(stage))!;
    const applied = animSelf.style.animation;
    expect(applied).not.toBe("");

    // A sentinel proves the second pass never re-applied: a re-apply would overwrite it (and, on a live page,
    // restart the sine mid-sweep — a visible jerk).
    animSelf.style.animation = "sentinel-untouched 1ms linear";
    applySceneDelta(state, iconDelta(fx, token)); // fresh node object → selfDirty, the pass really does run
    renderer.reconcile(state);
    expect(animSelf.style.animation).toBe("sentinel-untouched 1ms linear");

    // Restore + prove the same walk still reaches the apply when the signature actually changes (token cleared).
    animSelf.style.animation = applied;
    applySceneDelta(state, iconDelta(fx, null));
    renderer.reconcile(state);
    expect(animSelf.style.animation).toBe("");
  });

  it("tears down cleanly when the screen closes (token → null), keeping the layer", () => {
    const { stage, renderer } = harness();
    const state = buttonState(fx, token);
    renderer.reconcile(state);
    const el = iconEl(stage);
    const animSelf = animSelfOf(el)!;
    expect(animSelf.style.animation).not.toBe("");
    const elStyle = el.style.cssText;

    applySceneDelta(state, iconDelta(fx, null));
    expect(state.nodes.get("icon")!.pinnedLoopAnim).toBeNull();
    renderer.reconcile(state);

    expect(animSelf.style.animation).toBe("");
    expect(animSelf.style.transformOrigin).toBe("");
    expect(animSelf.style.getPropertyValue("rotate")).toBe("");
    // The layer itself STAYS (with the paint inside): an un-animated wrapper renders identically, and re-parenting
    // the paint on every screen open/close would churn the DOM for nothing.
    expect(animSelfOf(el)).toBe(animSelf);
    expect(animSelf.querySelector(".mirror-atlas-page")).not.toBeNull();
    // The element itself never moved through any of it.
    expect(el.style.cssText).toBe(elStyle);
  });

});

// A state whose icon carries the token, reached the way the producer does it: the full tree first (loop absent),
// then the single volatile upsert that names the loop when the screen opens.
function iconState(fx: ButtonFixture, token: string | null): MirrorState {
  const state = createMirrorState();
  applySceneDelta(state, buttonDelta(fx, null));
  applySceneDelta(state, iconDelta(fx, token));
  return state;
}

describe("top-bar loop keyframes (the producer's own constants)", () => {
  it("rocks the DECK icon at ±0.12 rad over 2π/4 s", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(buttonState(BUTTONS[TOP_BAR_DECK_ROCK_TOKEN], TOP_BAR_DECK_ROCK_TOKEN));
    const anim = animSelfOf(iconEl(stage))!.style.animation;
    // 0.12 rad = 6.8755° (Sts2TopBarFold.DeckRockAmplitudeRad), value-keyed into the literal keyframe's name.
    expect(anim).toContain("spirectl-rock-6p8755");
    // DeckRockPeriodMs = 2000π/4 = 1570.796ms; one `alternate` iteration is the HALF period.
    expect(anim).toContain("785.398");
    expect(anim).toContain("alternate");
    expect(anim).toContain("cubic-bezier(0.37, 0, 0.63, 1)"); // easeInOutSine → the two legs form a true sine
  });

  it("rocks the MAP icon at the same amplitude over 2×0.8s", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(buttonState(BUTTONS[TOP_BAR_MAP_ROCK_TOKEN], TOP_BAR_MAP_ROCK_TOKEN));
    const anim = animSelfOf(iconEl(stage))!.style.animation;
    expect(anim).toContain("spirectl-rock-6p8755");
    // MapRockPeriodMs = 2 × MapRockLegMs(800) → an 800ms alternate leg, matching the tween's two Sine/InOut legs.
    expect(anim).toContain("800ms");
    expect(anim).toContain("alternate");
  });

  it("spins the SETTINGS icon at a constant 1 rad/s (one turn per 2π s)", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(buttonState(BUTTONS[TOP_BAR_SPIN_TOKEN], TOP_BAR_SPIN_TOKEN));
    const anim = animSelfOf(iconEl(stage))!.style.animation;
    expect(anim).toContain("spirectl-rotate");
    expect(anim).toContain("6283.185"); // SpinPeriodMs = 2000π
    expect(anim).toContain("linear"); // `_icon.Rotation += delta` — constant speed, no easing
    expect(anim).not.toContain("alternate"); // a full turn, not an oscillation
  });
});
