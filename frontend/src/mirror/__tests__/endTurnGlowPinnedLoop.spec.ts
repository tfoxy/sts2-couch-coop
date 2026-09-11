import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  END_TURN_GLOW_TOKEN,
  PROCEED_GLOW_TOKEN,
  pinnedLoopAnchorsToDocument,
  pinnedLoopBinding,
  pinnedLoopFamily,
  pinnedLoopNodePivot,
  pinnedLoopRidesAnimSelf
} from "@/mirror/animAttributes";
import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterEach(() => { document.body.innerHTML = ""; });

// WS-A (idle-wire) — the END-TURN BUTTON glow pulse the R14 producer folds out of the wire (bridge-mod
// `Sts2EndTurnGlowFold`), named on `RuntimeSceneNodeDelta.PinnedLoopAnim` and replayed here on the browser's clock.
//
// It matters out of proportion to its size: the End Turn button lights up exactly when it is your turn, you have
// no playable card left and you have not ended the turn — i.e. while the combat is IDLE. Before the fold this one
// node kept an idle combat streaming, so no wire-quiet window ever opened for the DOM hatchery or the headless
// MaxFps backoff.
//
// THE LOOK: a two-channel pulse on `Visuals/GlowVfx`, both legs 1.5s and restarting together each iteration —
//     scale      0.5 → 1.4x  (Quart/Out)
//     modulate:a 0.4 → 0     (linear)
// Because both legs restart from their low end each iteration, the producer pins BOTH channels there (scale 0.5,
// modulate.a 0.4) and the client multiplies them back up on the animSelf self-layer.
//
// The fixture is the real node: a 512×256 `Godot.TextureRect` with the shared additive material, authored
// `pivot_offset` (256, 128) = its exact centre, streamed with the producer's pins already applied (the transform's
// basis carries scale 0.5, modulate.a is 0.4).

const GLOW_SCENE = "res://scenes/combat/end_turn_button.tscn";
const PINNED_SCALE = 0.5;
const PINNED_ALPHA = 0.4;

function glowUpsert(pinnedLoopAnim: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: "glowvfx",
    parentId: "visuals",
    name: "GlowVfx",
    nodeType: "Godot.TextureRect",
    // The producer's scale pin: `PinRestScale` leaves the node's placement and pulls the basis to 0.5 about the
    // authored centre pivot. Origin = pos + p - basis·p with pos (0,0), p (256,128) → (128, 64).
    transform: {
      xAxis: { x: PINNED_SCALE, y: 0 },
      yAxis: { x: 0, y: PINNED_SCALE },
      origin: { x: 128, y: 64 }
    },
    localRect: { position: { x: 0, y: 0 }, size: { x: 512, y: 256 } },
    texture: { resourcePath: "res://images/packed/combat_ui/end_turn_button_glow.png" },
    // The producer's alpha pin — modulate.a AND opacity move in lockstep (the watcher reads opacity as modulate.A).
    modulate: { r: 0.25, g: 0.875, b: 1, a: PINNED_ALPHA, html: "#40dfff66" },
    opacity: PINNED_ALPHA,
    mouseFilter: 2,
    visible: true,
    pinnedLoopAnim,
    ...extra
  };
}

function buttonDelta(pinnedLoopAnim: string | null) {
  const identity = { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 } };
  return parseSceneDelta({
    type: "scene-delta",
    full: true,
    screenType: "combat",
    orderedIds: ["button", "visuals", "glowvfx"],
    upserts: [
      {
        id: "button",
        parentId: null,
        name: "EndTurnButton",
        nodeType: "MegaCrit.Sts2.Core.Nodes.Combat.NEndTurnButton",
        sceneFilePath: GLOW_SCENE,
        transform: { ...identity, origin: { x: 1500, y: 800 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 260, y: 100 } },
        visible: true
      },
      {
        id: "visuals",
        parentId: "button",
        name: "Visuals",
        nodeType: "Godot.Control",
        transform: { ...identity, origin: { x: 0, y: 0 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 260, y: 100 } },
        mouseFilter: 2,
        visible: true
      },
      glowUpsert(pinnedLoopAnim)
    ]
  })!;
}

function glowDelta(pinnedLoopAnim: string | null) {
  return parseSceneDelta({
    type: "scene-delta",
    full: false,
    screenType: "combat",
    upserts: [glowUpsert(pinnedLoopAnim)]
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

function buttonState(pinnedLoopAnim: string | null): MirrorState {
  const state = createMirrorState();
  applySceneDelta(state, buttonDelta(pinnedLoopAnim));
  return state;
}

function glowState(pinnedLoopAnim: string | null): MirrorState {
  const state = buttonState(null);
  applySceneDelta(state, glowDelta(pinnedLoopAnim));
  return state;
}

function glowEl(stage: HTMLElement): HTMLElement {
  return stage.querySelector('[data-node-id="glowvfx"]') as HTMLElement;
}

function animSelfOf(el: HTMLElement): HTMLElement | null {
  return el.querySelector(":scope > .mirror-anim-self");
}

describe("endTurnGlow binding (the vocabulary the producer names)", () => {
  it("is its own kill-switch family, separate from the proceed glow", () => {
    expect(pinnedLoopFamily(END_TURN_GLOW_TOKEN)).toBe("endTurnGlow");
    // Two different producer folds on two different screens remain independent.
    expect(pinnedLoopFamily(PROCEED_GLOW_TOKEN)).toBe("glow");
  });

  it("maps to presentation's pulseScaleFade with the producer's RATIO endpoints", () => {
    const binding = pinnedLoopBinding(END_TURN_GLOW_TOKEN, "glowvfx", 0, 0)!;
    expect(binding.kind).toBe("pulseScaleFade");
    expect(binding.durationMs).toBe(1500);
    // The producer pins scale 0.5 / alpha 0.4 into the stream, so the client can only MULTIPLY: 0.7/0.5 = 1.4 and
    // 0/0.4 = 0, each starting at 1 = the pinned value itself (Sts2EndTurnGlowFold.Replay*).
    expect(binding.scaleFrom).toBe(1);
    expect(binding.scaleTo).toBeCloseTo(1.4, 10);
    expect(binding.alphaFrom).toBe(1);
    expect(binding.alphaTo).toBe(0);
  });

  it("rides the animSelf self-layer and needs no explicit pivot", () => {
    // `pulseScaleFade` drives the `transform:` SHORTHAND and an opacity that must MULTIPLY the element's own, so
    // it can never ride the element (which carries the baked matrix AND the pinned alpha).
    expect(pinnedLoopRidesAnimSelf(END_TURN_GLOW_TOKEN)).toBe(true);
    // The authored `pivot_offset` (256,128) IS the centre of the 512×256 rect, which is animSelf's own default
    // `transform-origin` — so no pivot, and therefore no pivot in the loop's signature (a re-layout can never
    // restart a running pulse).
    expect(pinnedLoopNodePivot(END_TURN_GLOW_TOKEN)).toBeNull();
  });

  it("does NOT anchor to the document timeline (unlike every other pinned loop)", () => {
    // The host starts this loop at a KNOWN instant — the frame the button turns shiny, which is the frame the producer
    // starts naming the token. Anchoring to the shared timeline would drop it into a random point of a cycle that
    // ENDS at opacity 0, so a glow that just lit up could render absent and then pop.
    expect(pinnedLoopAnchorsToDocument(END_TURN_GLOW_TOKEN)).toBe(false);
    expect(pinnedLoopAnchorsToDocument(PROCEED_GLOW_TOKEN)).toBe(true);
    // …and it carries no phase offset either, for the same reason (there is exactly one end-turn button).
    expect(pinnedLoopBinding(END_TURN_GLOW_TOKEN, "glowvfx", 0, 0)!.delayMs).toBeUndefined();
  });
});

describe("endTurnGlow replay (renderer)", () => {
  it("carries the token off the wire onto the retained node", () => {
    expect(buttonState(END_TURN_GLOW_TOKEN).nodes.get("glowvfx")!.pinnedLoopAnim).toBe(END_TURN_GLOW_TOKEN);
    // Not idle-waiting → the producer stops naming the loop, and the fade-to-0 streams live instead.
    expect(buttonState(null).nodes.get("glowvfx")!.pinnedLoopAnim).toBeNull();
  });

  it("grows an animSelf child on demand and runs the pulse there, never on the element", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(buttonState(null));
    const el = glowEl(stage);
    expect(animSelfOf(el)).toBeNull();

    renderer.reconcile(glowState(END_TURN_GLOW_TOKEN));
    const animSelf = animSelfOf(el)!;
    expect(animSelf).not.toBeNull();
    expect(el.style.animation).toBe("");
    expect(animSelf.style.animation).toContain("spirectl-pulse-scale-fade");
    expect(animSelf.style.animation).toContain("1500ms");
    expect(animSelf.style.animation).toContain("infinite");
    // The loop SNAPS back to its start each cycle (both tween legs carry `.From()`), so it must never alternate.
    expect(animSelf.style.animation).not.toContain("alternate");
  });

  it("injects LITERAL, compositor-eligible keyframes for the ratio endpoints", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(buttonState(END_TURN_GLOW_TOKEN));
    void glowEl(stage);
    const sheet = document.getElementById("spirectl-presentation-animations-literal")?.textContent ?? "";
    // Value-keyed literal rule: no var()/calc(), so Chrome can run the whole idle turn's pulse off the main thread.
    expect(sheet).toContain("@keyframes spirectl-pulse-scale-fade-1-1p4-1-0");
    expect(sheet).toContain("from { opacity: 1; transform: scale(1); }");
    expect(sheet).toContain("to { opacity: 0; transform: scale(1.4); }");
    expect(sheet).not.toContain("var(--spirectl-pulse-scale-from");
  });

  // THE regression assertion, same shape as the top-bar fold's: the producer pinned only the loop's two channels
  // and keeps streaming everything else, so the token must not MOVE the node. A client-side write to the element's
  // own transform is exactly the WS-D mispositioning bug. (The node's PAINT does move — into the animated layer,
  // asserted separately below — because otherwise the pulse would scale an empty box.)
  const PLACEMENT_KEYS = ["transform", "transformOrigin", "left", "top", "width", "height", "opacity"] as const;

  it("leaves the element's own placement + pinned colour untouched", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(buttonState(null));
    const el = glowEl(stage);
    const before = Object.fromEntries(PLACEMENT_KEYS.map((k) => [k, el.style[k]]));

    renderer.reconcile(glowState(END_TURN_GLOW_TOKEN));
    expect(Object.fromEntries(PLACEMENT_KEYS.map((k) => [k, el.style[k]]))).toEqual(before);
    // The producer's scale pin is still the element's whole transform — the replay never writes one.
    expect(el.style.transform).toBe(`matrix(${PINNED_SCALE}, 0, 0, ${PINNED_SCALE}, 128, 64)`);
    // The element keeps the producer's pinned alpha; the animated child multiplies it, so the two together
    // give back the 0.4 → 0 fade against a live-streamed RGB.
    expect(el.style.opacity).toBe(String(PINNED_ALPHA));
  });

  it("moves the node's PAINT inside the animated layer (or the pulse would scale an empty box)", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(buttonState(null));
    const el = glowEl(stage);
    expect(el.style.backgroundImage).toContain("end_turn_button_glow.png");

    renderer.reconcile(glowState(END_TURN_GLOW_TOKEN));
    const animSelf = animSelfOf(el)!;
    expect(animSelf.style.backgroundImage).toContain("end_turn_button_glow.png");
    expect(el.style.backgroundImage).toBe("");
  });

  it("stops the pulse when the producer stops naming it (turn ended / a card became playable)", () => {
    const { stage, renderer } = harness();
    renderer.reconcile(buttonState(END_TURN_GLOW_TOKEN));
    const el = glowEl(stage);
    expect(animSelfOf(el)!.style.animation).not.toBe("");

    renderer.reconcile(glowState(null));
    // The self-layer is KEPT (an un-animated wrapper renders identically) but the loop is gone, so the node
    // renders at the pinned opening pose while the real 0.5s fade-to-0 streams live over the top.
    expect(animSelfOf(el)!.style.animation).toBe("");
  });

});
