// CROSS-BACKEND PARITY FOR THE RAISE — the assertion that was impossible to write before the policy was shared.
//
// The readable-hand raise used to exist twice: `mirrorRenderer` decided it for the DOM stage and
// `canvas/handRaise` decided it again for the canvas stage, with the same formula written out in both. A user
// then reported that the canvas stage draws a creature's HP bar and powers HIGHER than the DOM stage does (U3b),
// and no test in the repo could compare the two — each spec asserted its own backend against its own numbers.
//
// This file runs ONE scene through BOTH backends and asserts they agree:
//
//   1. the same nodes move by the same dy (now true by construction — `raise/handRaisePlan` is the only decider,
//      and this pins that neither backend has re-grown a private one);
//   2. and the shift lands at the same HEIGHT ON SCREEN, which is a different claim: the DOM applies it as a CSS
//      `translate` (parent space, riding the ancestor chain) and the canvas as a design-space cosmetic offset.
//      Those two agree only while the chain is the identity — the case every recorded frame happened to be, and
//      the reason two rounds of live probes could not reproduce the report. With a creature the chain SCALES, the
//      old canvas arithmetic under-moves or over-moves by exactly `dy·(k−1)`.

import { beforeEach, describe, expect, it } from "vitest";

import { createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import { planCanvasHandRaise } from "@/mirror/canvas/handRaise";
import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import type { Affine } from "@/mirror/affine";

const RAISE = 119; // HAND_RAISE_PX
const CONTAINER_Y = 1080; // CardHolderContainer is anchored bottom-centre
const FAN_Y = -50; // the resting fan's centre-card y

/** The authored creature's two shifts — `reticleTop − (powerTop + 40)`, and the intents' gap above the result. */
const HB_DY = -244;
const INTENTS_DY = -68;

const RESTING = { enabled: true, heldCardId: null, heldMode: "drag" as const };

// --- the fixture, in WIRE shape so ONE state can feed both backends --------------------------------------------

function node(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: at(0, 0),
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 16 } },
    visible: true,
    ...over
  };
}

function at(x: number, y: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } };
}

/** A uniformly scaled placement — what a creature drawn at anything but its authored size composes into. */
function scaledAt(k: number, x: number, y: number): Record<string, unknown> {
  return { xAxis: { x: k, y: 0 }, yAxis: { x: 0, y: k }, origin: { x, y } };
}

function rect(x: number, y: number, w: number, h: number): Record<string, unknown> {
  return { position: { x, y }, size: { x: w, y: h } };
}

/**
 * One combat scene: a one-card hand and one creature carrying the two HUD groups the mode moves.
 *
 * `creatureTransform` is the creature ROOT's own placement — the term the two backends can only agree on when the
 * offset is expressed in the same space it is.
 */
function combatScene(creatureTransform: Record<string, unknown>): Record<string, unknown>[] {
  return [
    node("PlayerHand", null, { nodeType: "NPlayerHand" }),
    node("CardHolderContainer", "PlayerHand", { transform: at(960, CONTAINER_Y) }),
    node("h0", "CardHolderContainer", { nodeType: "NHandCardHolder", transform: at(960, CONTAINER_Y + FAN_Y) }),
    node("h0Hitbox", "h0", {
      name: "Hitbox",
      mouseFilter: 0,
      transform: at(960, CONTAINER_Y + FAN_Y),
      localRect: rect(-150, -211, 300, 422)
    }),
    node("Creature", null, {
      nodeType: "NCreature",
      name: "Creature",
      sceneFilePath: "res://scenes/combat/creature.tscn",
      transform: creatureTransform
    }),
    node("CreatureReticle", "Creature", {
      name: "SelectionReticle",
      transform: at(-129, -179),
      localRect: rect(0, 0, 252, 178)
    }),
    node("CreatureHb", "Creature", {
      name: "HealthBar",
      sceneFilePath: "res://scenes/combat/creature_state_display.tscn",
      transform: at(0, 7)
    }),
    node("CreaturePower", "CreatureHb", { name: "PowerContainer", transform: at(-115, 18), localRect: rect(0, 0, 0, 0) }),
    // The hp bar's own hover box: a mouse-visible DESCENDANT of the moved group, so it is where both backends can
    // be asked "at what height did you draw this?" in the same units.
    node("CreatureHpHit", "CreatureHb", {
      name: "HpBarHitbox",
      mouseFilter: 0,
      transform: at(-138, -6),
      localRect: rect(0, 0, 258, 26)
    }),
    node("CreatureIntents", "Creature", {
      name: "Intents",
      nodeType: "HBoxContainer",
      transform: at(-491, -230),
      localRect: rect(0, 0, 1000, 40)
    })
  ];
}

function stateOf(nodes: Record<string, unknown>[]): MirrorState {
  const state = createMirrorState();
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
  return state;
}

// --- the DOM arm -----------------------------------------------------------------------------------------------

function domHarness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function domEl(stage: HTMLElement, id: string): HTMLElement {
  const found = stage.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  if (!found) {
    throw new Error(`no element for ${id}`);
  }
  return found;
}

/** `matrix(a, b, c, d, e, f)` → the six numbers; anything else (including "") is the identity. */
function parseMatrix(css: string): Affine {
  const m = /matrix\(([^)]+)\)/.exec(css);
  if (!m) {
    return [1, 0, 0, 1, 0, 0];
  }
  const n = m[1].split(",").map((p) => Number(p.trim()));
  return [n[0], n[1], n[2], n[3], n[4], n[5]];
}

/** `0px -244px` → the same as a matrix; "" / "0px" is the identity. */
function parseTranslate(css: string): Affine {
  const parts = css.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return [1, 0, 0, 1, 0, 0];
  }
  return [1, 0, 0, 1, parseFloat(parts[0]) || 0, parts.length > 1 ? parseFloat(parts[1]) || 0 : 0];
}

function mul(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

/**
 * WHERE THE DOM ACTUALLY DRAWS A NODE, composed from the element chain: for each element from the stage down,
 * `used = used · translate · matrix`.
 *
 * The ORDER is the CSS one and it is the whole point of this file: the individual `translate` property applies
 * BEFORE the element's own `transform`, so a raise written as `translate` is a vector in the PARENT's basis and
 * picks up every ancestor's scale. (jsdom does no layout, so this reads the inline styles the renderer wrote —
 * which is exactly what a browser would compose.)
 */
function domDrawn(stage: HTMLElement, id: string): Affine {
  const chain: HTMLElement[] = [];
  for (let el: HTMLElement | null = domEl(stage, id); el && el !== stage; el = el.parentElement) {
    chain.unshift(el);
  }
  let used: Affine = [1, 0, 0, 1, 0, 0];
  for (const el of chain) {
    used = mul(used, mul(parseTranslate(el.style.translate), parseMatrix(el.style.transform)));
  }
  return used;
}

/**
 * How far the raise MOVED a node on each backend — the comparison that is actually apples-to-apples.
 *
 * Absolute drawn origins are not: the DOM carries a node's own `localRect` offset in its element layout and the
 * canvas carries it in the paint box, so the two baselines differ by that rect on any node that has one. The
 * DELTA between the same backend's raised and un-raised frame cancels it, and the delta IS the claim — "both
 * stages move this surface by the same number of screen px".
 */
function raiseDelta(scene: Record<string, unknown>[], id: string): { dom: number; canvas: number } {
  const state = stateOf(scene);
  const up = domHarness();
  up.renderer.setRaiseHandCards(true);
  up.renderer.reconcile(state);
  const down = domHarness();
  down.renderer.reconcile(stateOf(scene));

  const plan = planCanvasHandRaise(state, RESTING);
  return {
    dom: domDrawn(up.stage, id)[5] - domDrawn(down.stage, id)[5],
    canvas:
      canvasDrawn(state, id, plan.offsets)[5] -
      canvasDrawn(state, id, new Map())[5]
  };
}

// --- the canvas arm --------------------------------------------------------------------------------------------

/** Build the canvas draw list with the plan's offsets applied, and answer one hit surface's DRAWN affine. */
function canvasDrawn(
  state: MirrorState,
  id: string,
  offsets: ReadonlyMap<string, { dx: number; dy: number }>,
): Affine {
  const result = buildDrawList(state, createDrawList<string>(), {
    cosmeticOffsets: offsets,
    assert: true
  });
  const found = result.hitEntries.find((e) => e.nodeId === id);
  if (!found) {
    throw new Error(`no hit entry for ${id}`);
  }
  return found.mFinal as Affine;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("raise parity — the two backends decide the same raise", () => {
  it("moves the same nodes by the same dy (identity creature chain)", () => {
    const state = stateOf(combatScene(at(500, 600)));
    const { stage, renderer } = domHarness();
    renderer.setRaiseHandCards(true);
    renderer.reconcile(state);

    const canvas = planCanvasHandRaise(state, RESTING);
    // Every node the canvas plan moves is moved by the same amount on the DOM element…
    for (const [id, offset] of canvas.offsets) {
      expect([id, domEl(stage, id).style.translate]).toEqual([id, `0px ${offset.dy}px`]);
    }
    // …and the set itself is the one the mode is for: the fan card, the state display, the intents.
    expect([...canvas.offsets].map(([id, o]) => [id, o.dy]).sort()).toEqual([
      ["CreatureHb", HB_DY],
      ["CreatureIntents", INTENTS_DY],
      ["h0", -RAISE]
    ]);
  });

  it("publishes the same moved hit surfaces, at the same dy, to both input inverses", () => {
    const state = stateOf(combatScene(at(500, 600)));
    const { renderer } = domHarness();
    renderer.setRaiseHandCards(true);
    renderer.reconcile(state);

    const canvas = planCanvasHandRaise(state, RESTING);
    expect([...canvas.movedRectDy].sort()).toEqual([
      ["CreatureHpHit", HB_DY],
      ["h0Hitbox", -RAISE]
    ]);
    // The DOM's own stamps carry the same offsets over the same surfaces (it publishes rects, not ids).
    expect(renderer.raiseInputStamps().map((s) => s.dy).sort((a, b) => a - b)).toEqual([HB_DY, -RAISE]);
  });
});

describe("raise parity — the shift lands at the same height (U3b's mechanism)", () => {
  // The creature is drawn at 2x: its HUD group's own shift is measured in CREATURE-LOCAL px, so on screen it must
  // move 2x that. The DOM does it for free (a CSS `translate` rides the ancestor scale); the canvas has to say so.
  const SCALE = 2;

  it("agrees with the DOM on a SCALED creature — the case the identity chain hid", () => {
    const scene = combatScene(scaledAt(SCALE, 500, 600));
    expect(planCanvasHandRaise(stateOf(scene), RESTING).offsets.get("CreatureHb")?.dy).toBe(HB_DY);

    const moved = raiseDelta(scene, "CreatureHpHit");
    expect(moved.canvas).toBeCloseTo(moved.dom, 6);
    // …and that shared answer is the creature-local shift taken through the creature's own scale.
    expect(moved.canvas).toBeCloseTo(SCALE * HB_DY, 6);
  });

  it("the HAND rides the same rule — a scaled hand container moves its cards by the scaled lift", () => {
    // The hand is authored at scale 1, so this is a guard rather than a live case: the holder's ramp is measured
    // in CONTAINER-local px exactly as the creature's shift is in creature-local px, and both must be applied the
    // same way. A backend that special-cased one of them would fail here.
    const scene = combatScene(at(500, 600)).map((n) =>
      n.id === "CardHolderContainer" ? { ...n, transform: scaledAt(0.5, 960, CONTAINER_Y) } : n
    );
    const moved = raiseDelta(scene, "h0Hitbox");
    expect(moved.canvas).toBeCloseTo(moved.dom, 6);
    expect(moved.canvas).toBeCloseTo(0.5 * -RAISE, 6);
  });
});
