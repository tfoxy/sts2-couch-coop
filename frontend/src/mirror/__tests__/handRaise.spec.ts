import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// READABLE-HAND MODE, renderer half. Everything here is asserted through the ELEMENT's `translate` — the one
// property the pass writes — because that is exactly what a player sees and what the input inverse must undo.

const RAISE = 119; // HAND_RAISE_PX (the centre card's overhang below the 1080 viewport floor)
const CONTAINER_Y = 1080; // CardHolderContainer is anchored bottom-centre
const FOCUS_Y = -209; // the pose the game snaps a focused holder to
const FAN_Y = -50; // the resting fan's centre-card y

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function node(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 16 } },
    visible: true,
    ...over
  };
}

function at(x: number, y: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } };
}

function el(stage: HTMLElement, id: string): HTMLElement {
  const found = stage.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  if (!found) throw new Error(`no element for ${id}`);
  return found;
}

// A minimal combat hand: PlayerHand → CardHolderContainer → one holder per entry (each with its Hitbox + a card),
// plus a creature carrying the two HUD groups the mode moves.
function handScene(holders: { id: string; y: number }[], over: Record<string, Record<string, unknown>> = {}) {
  const nodes: Record<string, unknown>[] = [
    node("PlayerHand", null, { nodeType: "NPlayerHand", ...over.PlayerHand }),
    node("CardHolderContainer", "PlayerHand", { transform: at(960, CONTAINER_Y) })
  ];
  for (const h of holders) {
    nodes.push(node(h.id, "CardHolderContainer", { nodeType: "NHandCardHolder", transform: at(0, h.y) }));
    nodes.push(
      node(`${h.id}Hitbox`, h.id, {
        name: "Hitbox",
        mouseFilter: 0,
        transform: at(0, 0),
        localRect: { position: { x: -150, y: -211 }, size: { x: 300, y: 422 } }
      })
    );
    nodes.push(node(`${h.id}Card`, h.id, { nodeType: "NCard", name: "Card" }));
  }
  return nodes;
}

function rect(x: number, y: number, w: number, h: number): Record<string, unknown> {
  return { position: { x, y }, size: { x: w, y: h } };
}

// One creature, laid out like the real scene (creature-local px, the space its children stream in). `reticleTop`
// is the SelectionReticle's own y — the game re-places it per creature to wrap its drawn height, which is exactly
// why the HUD shift is measured rather than constant.
function creatureScene(id = "Creature", reticleTop = -179): Record<string, unknown>[] {
  const n = (suffix: string) => `${id}${suffix}`;
  return [
    node(id, null, { nodeType: "NCreature", name: "Creature", sceneFilePath: "res://scenes/combat/creature.tscn" }),
    node(n("Reticle"), id, { name: "SelectionReticle", transform: at(-129, reticleTop), localRect: rect(0, 0, 252, 178) }),
    node(n("Hb"), id, {
      name: "HealthBar",
      sceneFilePath: "res://scenes/combat/creature_state_display.tscn",
      transform: at(0, 7)
    }),
    node(n("Power"), n("Hb"), { name: "PowerContainer", transform: at(-115, 18), localRect: rect(0, 0, 0, 0) }),
    node(n("HpHit"), n("Hb"), { name: "HpBarHitbox", mouseFilter: 0, transform: at(-138, -6), localRect: rect(0, 0, 258, 26) }),
    node(n("Intents"), id, {
      name: "Intents",
      nodeType: "HBoxContainer",
      transform: at(-491, -230),
      localRect: rect(0, 0, 1000, 40)
    }),
    node(n("Intent0"), n("Intents"), { name: "Intent" })
  ];
}

function build(renderer: MirrorRenderer, nodes: Record<string, unknown>[]): MirrorState {
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
  renderer.reconcile(state);
  return state;
}

// A volatile (non-keyframe) delta. `parentId` is restated on every upsert because the wire does: the client
// rebuilds its parent/child index from it on every delta, so an upsert that omitted it would orphan the node.
function move(renderer: MirrorRenderer, state: MirrorState, upserts: Record<string, unknown>[]): void {
  const withParents = upserts.map((u) => ({
    parentId: state.nodes.get(u.id as string)?.parentId ?? null,
    // The box, too: a volatile upsert REPLACES a node's rect (only a handful of fields are sticky — see
    // mergeNode), so a holder whose box was dropped would stop rendering a transform at all, and a transform is
    // what a tween arms on.
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 16 } },
    ...u
  }));
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: withParents })!);
  renderer.reconcile(state);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("readable-hand mode — the hand raise", () => {
  it("DOM provenance requires paint and the same current hand-hitbox footprint", () => {
    const { stage, renderer } = harness();
    stage.style.width = "1920px";
    stage.style.height = "1080px";
    Object.defineProperty(stage, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 1920, height: 1080 }),
    });
    renderer.setRaiseHandCards(true);
    build(renderer, handScene([{ id: "fourth", y: FAN_Y }, { id: "neighbour", y: FAN_Y + 500 }]));
    const card = el(stage, "fourthCard");
    const neighbourCard = el(stage, "neighbourCard");
    const stamp = renderer.raiseInputStamps().find((candidate) => candidate.ownerId === "fourth");
    if (!stamp) throw new Error("missing fourth hand stamp");
    const x = stamp.transform[4] + stamp.localRect.x + stamp.localRect.width / 2;
    const y = stamp.transform[5] + stamp.localRect.y + stamp.localRect.height / 2 + stamp.dy;
    const aura = document.createElement("div");
    aura.setAttribute("data-node-id", "fourthCard"); // aura deliberately has no data-paints marker
    const paint = document.createElement("div");
    paint.setAttribute("data-node-id", "fourthCard");
    paint.setAttribute("data-paints", "1");
    card.append(aura, paint);
    const neighbourPaint = document.createElement("div");
    neighbourPaint.setAttribute("data-node-id", "neighbourCard");
    neighbourPaint.setAttribute("data-paints", "1");
    neighbourCard.append(neighbourPaint);
    (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => [aura];
    expect(renderer.raisedHandVisualClaimAt?.(x, y)).toBeNull();
    (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => [paint];
    expect(renderer.raisedHandVisualClaimAt?.(x, y)).toEqual({ ownerId: "fourth" });
    // The touch bridge is intentionally independent of glow/pixel probing, but only names a live in-fan holder
    // reached from the exact NCard touch target.
    expect(renderer.raisedHandTouchTargetClaim?.("fourthCard")).toEqual({ ownerId: "fourth" });
    expect(renderer.raisedHandTouchTargetClaim?.("missing-card")).toBeNull();
    // A glow can paint well beyond the card but may not nominate a raised correction on its own.
    expect(renderer.raisedHandVisualClaimAt?.(x, y - 1000)).toBeNull();
    // A foreground neighbour glow cannot borrow the fourth holder's footprint, but it also cannot hide the
    // lower fourth card that genuinely owns this point.
    (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => [neighbourPaint, paint];
    expect(renderer.raisedHandVisualClaimAt?.(x, y)).toEqual({ ownerId: "fourth" });
    (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => [];
    expect(renderer.raisedHandVisualClaimAt?.(x, y)).toBeNull();
  });

  it("bridges an exact top touch target after its focused holder settles at native dy zero", () => {
    const { renderer } = harness();
    renderer.setRaiseHandCards(true);
    build(renderer, handScene([
      { id: "focused", y: FOCUS_Y },
      { id: "neighbour", y: FAN_Y },
    ]));

    const stamps = renderer.raiseInputStamps();
    expect(stamps.find((stamp) => stamp.ownerId === "focused")?.dy).toBe(0);
    expect(stamps.find((stamp) => stamp.ownerId === "neighbour")?.dy).toBe(-RAISE);
    // The raised-mode map remains non-empty because the neighbour is lifted, but the focused hitbox is not in it.
    // A new top-card touch must nevertheless retain the focused holder through delayed drag classification.
    expect(renderer.raisedHandTouchTargetClaim?.("focusedCard")).toEqual({ ownerId: "focused" });
  });

  it("does nothing at all while the setting is off", () => {
    const { stage, renderer } = harness();
    build(renderer, [...handScene([{ id: "h0", y: FAN_Y }]), ...creatureScene()]);

    expect(el(stage, "h0").style.translate).toBe("");
    expect(el(stage, "CreatureHb").style.translate).toBe("");
    expect(renderer.raiseInputStamps()).toEqual([]);
  });

  it("raises every resting fan card by the SAME amount, so the fan keeps its shape", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    // A five-card fan: the outer cards sit LOWER than the centre one (the arc), but all lift equally.
    build(renderer, handScene([
      { id: "h0", y: 10 },
      { id: "h1", y: -30 },
      { id: "h2", y: FAN_Y },
      { id: "h3", y: -30 },
      { id: "h4", y: 10 }
    ]));

    for (const id of ["h0", "h1", "h2", "h3", "h4"]) {
      expect(el(stage, id).style.translate).toBe(`0px ${-RAISE}px`);
    }
  });

  it("leaves a FOCUSED card at the game's own pose, and ramps it back as the game un-focuses it", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]));

    // h1 focuses: the game snaps it to FOCUS_Y. Its raise cancels exactly; its neighbour keeps the full lift.
    move(renderer, state, [{ id: "h1", transform: at(0, FOCUS_Y) }]);
    expect(el(stage, "h1").style.translate).toBe("0px");
    expect(el(stage, "h0").style.translate).toBe(`0px ${-RAISE}px`);

    // Half way back down the un-focus travel, the lift is half applied — a continuous ramp, not a step.
    move(renderer, state, [{ id: "h1", transform: at(0, -137) }]);
    const half = Number(/(-?\d+)px$/.exec(el(stage, "h1").style.translate)![1]);
    expect(half).toBeGreaterThan(-RAISE);
    expect(half).toBeLessThan(0);

    // Settled back in the fan: the full lift again.
    move(renderer, state, [{ id: "h1", transform: at(0, FAN_Y) }]);
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);
  });

  it("drops the whole hand while a card is DRAGGED (the game reparents the held holder onto the hand root)", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]));
    expect(el(stage, "h0").style.translate).toBe(`0px ${-RAISE}px`);

    move(renderer, state, [{ id: "h1", parentId: "PlayerHand", transform: at(700, 500) }]);
    expect(el(stage, "h0").style.translate).toBe("0px");
    expect(el(stage, "h1").style.translate).toBe("0px");

    // Dropped back into the hand → the whole fan comes back up.
    move(renderer, state, [{ id: "h1", parentId: "CardHolderContainer", transform: at(0, FAN_Y) }]);
    expect(el(stage, "h0").style.translate).toBe(`0px ${-RAISE}px`);
  });

  it("drops the hand while a targeting arrow is up (a targeted card OR a potion being aimed)", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, [
      ...handScene([{ id: "h0", y: FAN_Y }]),
      node("Arrow", null, { nodeType: "NTargetingArrow", visible: false })
    ]);
    expect(el(stage, "h0").style.translate).toBe(`0px ${-RAISE}px`);

    move(renderer, state, [{ id: "Arrow", visible: true }]);
    expect(el(stage, "h0").style.translate).toBe("0px");

    move(renderer, state, [{ id: "Arrow", visible: false }]);
    expect(el(stage, "h0").style.translate).toBe(`0px ${-RAISE}px`);
  });

  it("stops raising once the game deliberately dims the hand (the multiplayer end-turn wait)", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }]));
    expect(el(stage, "h0").style.translate).toBe(`0px ${-RAISE}px`);

    // The game greys the hand root to 0.5 and lowers it: we must not fight that, or the cards it is hiding would
    // stay readable.
    move(renderer, state, [{ id: "PlayerHand", modulate: { r: 0.5, g: 0.5, b: 0.5, a: 1 } }]);
    expect(el(stage, "h0").style.translate).toBe("0px");

    move(renderer, state, [{ id: "PlayerHand", modulate: { r: 1, g: 1, b: 1, a: 1 } }]);
    expect(el(stage, "h0").style.translate).toBe(`0px ${-RAISE}px`);
  });

  it("toggles live, with no reconcile in between", () => {
    const { stage, renderer } = harness();
    build(renderer, handScene([{ id: "h0", y: FAN_Y }]));
    expect(el(stage, "h0").style.translate).toBe("");

    renderer.setRaiseHandCards(true);
    expect(el(stage, "h0").style.translate).toBe(`0px ${-RAISE}px`);

    renderer.setRaiseHandCards(false);
    expect(el(stage, "h0").style.translate).toBe("0px");
  });

  it("reports whether a combat hand is on screen (the HUD toggle button's gate)", () => {
    const { renderer } = harness();
    build(renderer, creatureScene());
    expect(renderer.handPresent()).toBe(false);

    const { renderer: r2 } = harness();
    build(r2, handScene([{ id: "h0", y: FAN_Y }]));
    expect(r2.handPresent()).toBe(true);
  });

  it("anchors the client control in CombatPileContainer and reports later modal covers", () => {
    const { stage, renderer } = harness();
    const nodes = [
      node("CombatUi", null, { localRect: rect(0, 0, 1920, 1080) }),
      node("Piles", "CombatUi", {
        nodeType: "NCombatPilesContainer",
        sceneFilePath: "res://scenes/combat/combat_piles_container.tscn",
        localRect: rect(0, 0, 1920, 1080)
      }),
      ...handScene([{ id: "h0", y: FAN_Y }]),
      node("MapScreen", null, { localRect: rect(0, 0, 1920, 1080) }),
      node("Backstop", "MapScreen", {
        localRect: rect(0, 0, 1920, 1080),
        fillColor: { r: 0, g: 0, b: 0, a: 0.9, html: "#000000e6" }
      })
    ];
    build(renderer, nodes);
    renderer.setConfirmCoverWatch(true);
    renderer.reconcile(build(renderer, nodes));

    const layer = renderer.handRaiseUiLayer();
    expect(layer).toMatchObject({ present: true, anchorId: "Piles", covered: true, backend: "dom" });
    expect(layer.domTarget).toBe(el(stage, "Piles"));
  });
});

describe("readable-hand mode — the creature HUD", () => {
  it("moves the health-bar group above the reticle and the intents up to clear it", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    build(renderer, creatureScene());

    // Authored geometry: reticle top -179, first power row ends at 7+18+40 = 65 ⇒ -244; intents bottom -190 must
    // sit 21px above the shifted hp-bar top (7-244) ⇒ -68.
    expect(el(stage, "CreatureHb").style.translate).toBe("0px -244px");
    expect(el(stage, "CreatureIntents").style.translate).toBe("0px -68px");
  });

  it("MEASURES the shift per creature — a taller creature's reticle sits higher, so its HUD moves further", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    // The reticle the game re-placed to wrap a big enemy: 99px higher than the authored default.
    build(renderer, [...creatureScene("Small", -179), ...creatureScene("Big", -278)]);

    expect(el(stage, "SmallHb").style.translate).toBe("0px -244px");
    expect(el(stage, "BigHb").style.translate).toBe("0px -343px");
    // The intents keep the same 21px gap above each one's own hp bar.
    expect(el(stage, "SmallIntents").style.translate).toBe("0px -68px");
    expect(el(stage, "BigIntents").style.translate).toBe("0px -167px");
  });

  it("keeps the HUD up while a card is dragged — that is the point of moving it", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, [...handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]), ...creatureScene()]);

    move(renderer, state, [{ id: "h1", parentId: "PlayerHand", transform: at(700, 500) }]);
    expect(el(stage, "h0").style.translate).toBe("0px"); // the hand went down…
    expect(el(stage, "CreatureHb").style.translate).toBe("0px -244px"); // …the health bars did not
    expect(el(stage, "CreatureIntents").style.translate).toBe("0px -68px");
  });

  it("only moves groups that really are a creature's (same names elsewhere are left alone)", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    build(renderer, [
      node("SomeScreen", null, { sceneFilePath: "res://scenes/screens/settings_screen.tscn" }),
      node("otherHb", "SomeScreen", { name: "HealthBar" }),
      node("otherIntents", "SomeScreen", { name: "Intents" })
    ]);

    expect(el(stage, "otherHb").style.translate).toBe("");
    expect(el(stage, "otherIntents").style.translate).toBe("");
  });
});

// HOW the lift moves. Three causes, three timings — and picking the wrong one is visible: the game TELEPORTS a
// focused card to its focus pose, so easing the lift there makes a focus in this mode feel unlike the same focus
// with the mode off. See handRaiseTransition.
describe("readable-hand mode — how the lift MOVES", () => {
  // The renderer's tween replay is deadline-scheduled (a timer parks until the earliest deadline, then asks for the
  // rAF that mutates), so both halves are modelled against one fake clock. Same harness as mirrorTween.spec.
  let clock = 0;
  let rafCb: FrameRequestCallback | null = null;
  let timers: { id: number; at: number; cb: () => void }[] = [];
  let nextTimerId = 1;

  beforeEach(() => {
    document.body.innerHTML = "";
    clock = 0;
    rafCb = null;
    timers = [];
    nextTimerId = 1;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      rafCb = null;
    });
    vi.stubGlobal("setTimeout", (cb: () => void, ms?: number) => {
      const id = nextTimerId++;
      timers.push({ id, at: clock + (ms ?? 0), cb });
      return id;
    });
    vi.stubGlobal("clearTimeout", (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function flushRaf(atMs: number): void {
    clock = atMs;
    for (let guard = 0; guard < 8; guard++) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      timers = timers.filter((t) => t.at > clock);
      for (const timer of due) timer.cb();
    }
    const cb = rafCb;
    rafCb = null;
    cb?.(atMs);
  }

  // A transform-endpoint hint, the shape the producer sends (endTransform is always GLOBAL).
  function hint(targetId: string, endY: number, durationMs = 400): Record<string, unknown> {
    return { targetId, property: "position", durationMs, trans: "Cubic", ease: "Out", endTransform: [1, 0, 0, 1, 960, endY] };
  }

  function hints(renderer: MirrorRenderer, state: MirrorState, list: Record<string, unknown>[]): void {
    applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", hints: list })!);
    renderer.reconcile(state);
  }

  it("TELEPORTS the lift when the game teleports the card (a focus)", () => {
    const { stage, renderer } = harness();
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]));
    renderer.setRaiseHandCards(true); // the mode arriving is OUR motion — the class ease plays it, inline stays clear

    move(renderer, state, [{ id: "h1", transform: at(0, FOCUS_Y) }]);
    expect(el(stage, "h1").style.translate).toBe("0px");
    // Instant, and stated inline so it beats the class rule's own ease.
    expect(el(stage, "h1").style.transition).toContain("translate 0s");
    // The neighbour didn't move, so nothing was written to it at all.
    expect(el(stage, "h0").style.transition).toBe("");
  });

  it("EASES the lift when the mode itself is what changed, and never re-asserts mid-ease", () => {
    const { stage, renderer } = harness();
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]));

    // Toggling on is our own motion: leave the `.mirror-hand-raisable` class transition to play it.
    renderer.setRaiseHandCards(true);
    expect(el(stage, "h0").style.transition).toBe("");

    // A reconcile one frame into that ease must NOT write a transition — an inline write lands mid-ease and snaps
    // the card to the end value, which is how "the raise doesn't animate" bugs happen.
    move(renderer, state, [{ id: "h1", transform: at(0, FAN_Y) }]);
    expect(el(stage, "h0").style.transition).toBe("");

    // Same for a drag lowering the hand, and for the return that raises it again.
    move(renderer, state, [{ id: "h1", parentId: "PlayerHand", transform: at(700, 500) }]);
    expect(el(stage, "h0").style.transition).toBe("");
    move(renderer, state, [{ id: "h1", parentId: "CardHolderContainer", transform: at(0, FAN_Y) }]);
    expect(el(stage, "h0").style.transition).toBe("");
  });

  it("rides the TWEEN'S own curve while a tween owns the holder (the un-focus)", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]));
    move(renderer, state, [{ id: "h1", transform: at(0, FOCUS_Y) }]);

    // The game tweens the focused card back into the fan. Both channels must arrive together, or the lift and the
    // slide fight each other and the card reads as overshooting.
    hints(renderer, state, [hint("h1", FAN_Y, 400)]);
    flushRaf(16);
    const transition = el(stage, "h1").style.transition;
    expect(transition).toContain("transform 400ms");
    expect(transition).toContain("translate 400ms");
    // …and the lift is already at the endpoint's value, not a frame behind it.
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);
  });

  it("drops a refocused holder's stale unfocus lift during its deferred prime", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]));

    // h1 focused, then began returning to the fan. That old channel owns both a resting endpoint and the full
    // readable-hand lift — the state a rapid focus handoff interrupts in the recorded repro.
    move(renderer, state, [{ id: "h1", transform: at(0, FOCUS_Y) }]);
    hints(renderer, state, [hint("h1", FAN_Y, 400)]);
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);
    expect(el(stage, "h1").style.transition).toContain("translate 400ms");

    // The next focus declares its start (and endpoint) at the game focus pose. Its arm waits for rAF; before the
    // fix this prime kept the old resting endpoint, so the raise pass left -119px composed onto this focused pose.
    hints(renderer, state, [
      {
        ...hint("h1", FOCUS_Y, 475),
        startTransform: [1, 0, 0, 1, 0, FOCUS_Y]
      }
    ]);
    expect(el(stage, "h1").style.translate).toBe("0px");
    expect(el(stage, "h1").style.transition).toBe("translate 0s");

    // The deferred arm retains the focused pose and cannot resurrect the superseded unfocus timing.
    flushRaf(16);
    expect(el(stage, "h1").style.translate).toBe("0px");
    expect(el(stage, "h1").style.transition).toContain("transform 475ms");
    expect(el(stage, "h1").style.transition).toContain("translate 0s");
  });

  it("arms a primed focus-to-fan return with matching transform and raise timing", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]));
    move(renderer, state, [{ id: "h1", transform: at(0, FOCUS_Y) }]);

    // A declared start defers the arm. While primed, this remains the native focus pose with no cosmetic lift.
    hints(renderer, state, [
      {
        ...hint("h1", FAN_Y, 400),
        startTransform: [1, 0, 0, 1, 0, FOCUS_Y]
      }
    ]);
    expect(el(stage, "h1").style.translate).toBe("0px");
    // The prime cancelled the preceding transition, but its desired lift has not changed, so compare-before-write
    // deliberately leaves it alone instead of re-starting a zero-distance translate animation.
    expect(el(stage, "h1").style.transition).toBe("none");

    // The arm changes the owned pose to the fan endpoint. Its same-rAF raise pass changes translate with the
    // transform's exact timing, rather than leaving it on the earlier focus clock for a frame.
    flushRaf(16);
    const transition = el(stage, "h1").style.transition;
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);
    expect(transition).toContain("transform 400ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(transition).toContain("translate 400ms cubic-bezier(0.33, 1, 0.68, 1)");
  });

  it("coalesces same-holder primed arms before their deferred flush", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h1", y: FAN_Y }]));
    const start = [1, 0, 0, 1, 0, FOCUS_Y];

    // Both transform hints arrive before the shared rAF arm. The second is the producer's newest endpoint/timing;
    // the first must not briefly open an obsolete transform/raise curve in the same flush.
    hints(renderer, state, [
      { ...hint("h1", FAN_Y, 679), startTransform: start },
      { ...hint("h1", FAN_Y, 406), startTransform: start }
    ]);
    flushRaf(16);

    const transition = el(stage, "h1").style.transition;
    expect(transition).toContain("transform 406ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(transition).toContain("translate 406ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);
    // `noteArm` closes a previously open row as `superseded`; no such row proves the stale closure did not arm.
    expect(renderer.landingLog().rows.filter((row) => row.id === "h1" && row.closedBy === "superseded")).toEqual([]);
  });

  it("dual-primes an initial transform-only return before publishing its paired endpoints", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h1", y: FAN_Y }]));
    move(renderer, state, [{ id: "h1", transform: at(0, FOCUS_Y) }]);
    const holder = el(stage, "h1");
    const computed = vi.spyOn(window, "getComputedStyle");

    hints(renderer, state, [hint("h1", FAN_Y, 400)]);
    expect(computed.mock.calls.filter(([target]) => target === holder)).toHaveLength(1);
    expect(holder.style.transition).toContain("transform 400ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(holder.style.transition).toContain("translate 400ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(holder.style.translate).toBe(`0px ${-RAISE}px`);
  });

  it("dual-primes an active same-offset return when a new transform arm retargets it", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h1", y: FAN_Y }]));
    move(renderer, state, [{ id: "h1", transform: at(0, FOCUS_Y) }]);
    hints(renderer, state, [hint("h1", FAN_Y, 679)]);
    const holder = el(stage, "h1");
    const computed = vi.spyOn(window, "getComputedStyle");

    // The target stays at the fan's full lift, but its transform gets a fresh shorter arm while the old raise is
    // live. This is the only same-target path allowed to read and restart translate.
    hints(renderer, state, [hint("h1", FAN_Y, 406)]);
    expect(computed.mock.calls.filter(([target]) => target === holder)).toHaveLength(1);
    expect(holder.style.transition).toContain("transform 406ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(holder.style.transition).toContain("translate 406ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(holder.style.translate).toBe(`0px ${-RAISE}px`);
  });

  it("leaves a settled same-offset rearm on the ordinary compare-before-write path", () => {
    const { stage, renderer } = harness();
    renderer.setUiScaling(false); // keep the scale pass out of this no-layout-read assertion
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h1", y: FAN_Y }]));
    move(renderer, state, [{ id: "h1", transform: at(0, FOCUS_Y) }]);
    hints(renderer, state, [hint("h1", FAN_Y, 400)]);
    flushRaf(420);
    flushRaf(436); // timer wake then its tick rAF expire the first tween-derived raise deadline
    // The producer's ordinary settle re-emits the resting fan pose; without it the retained focused stream would
    // correctly make the next return a changed raise target rather than the steady same-target case under test.
    move(renderer, state, [{ id: "h1", transform: at(0, FAN_Y) }]);
    const holder = el(stage, "h1");
    const computed = vi.spyOn(window, "getComputedStyle");
    const translate = vi.spyOn(holder.style, "translate", "set");

    hints(renderer, state, [hint("h1", FAN_Y, 406)]);
    expect(computed.mock.calls.filter(([target]) => target === holder)).toHaveLength(0);
    expect(translate).not.toHaveBeenCalled();
    expect(holder.style.translate).toBe(`0px ${-RAISE}px`);
  });

  it("raises a card RETURNING from a cancelled play with the rest of the hand (its transform is SUPPRESSED)", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]));

    // Dragged into the play zone: the game reparents the holder onto the hand root and the whole hand drops.
    move(renderer, state, [{ id: "h1", parentId: "PlayerHand", transform: at(700, 400) }]);
    expect(el(stage, "h0").style.translate).toBe("0px");

    // Released back over the hand — the play is cancelled, so the game reparents the holder home and TWEENS it into
    // the fan. For that tween's whole window the producer suppresses the holder's transform (it ships none at all),
    // so the endpoint is the only thing that says where the card is going. Reading the absent transform instead
    // left this one card at the game's pose, unraised, while every other card came up — and then jumped it into
    // place at the settle.
    move(renderer, state, [{ id: "h1", parentId: "CardHolderContainer" }]);
    hints(renderer, state, [hint("h1", FAN_Y, 400)]);
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);
    expect(el(stage, "h0").style.translate).toBe(`0px ${-RAISE}px`);
  });

  it("holds the lift until the SETTLE puts the focus pose on the element, then drops it in that same frame", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]));

    // A tween is live on the holder heading for the RESTING fan (the neighbour push the game runs on every layout
    // refresh), and the game then teleports this card to its focus pose mid-window. The pin holds the element at
    // the endpoint and stashes the fresh pose as a catch-up, so for those frames the card is still drawn in the fan.
    hints(renderer, state, [hint("h1", FAN_Y, 400)]);
    flushRaf(16);
    move(renderer, state, [{ id: "h1", transform: at(0, FOCUS_Y) }]);
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);

    // Past the tween's clock but BEFORE the settle: a reconcile here used to read the (already fresh) transform and
    // release the lift a frame early, dropping the card the whole 119px to its true fan position — half of it below
    // the viewport floor — and only then teleporting it up to the focus pose. That two-step move IS the "position
    // transition" a focus must not have.
    clock = 500;
    renderer.reconcile(state);
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);

    // The settle applies the catch-up pose AND re-runs the raise pass, so both land together and instantly.
    flushRaf(520);
    expect(el(stage, "h1").style.translate).toBe("0px");
    expect(el(stage, "h1").style.transition).toContain("translate 0s");
  });

  it("keeps a returning holder's endpoint lift through the one settle-time hand pass", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    // This retained streamed pose produces the live failure's -42px ramp. The tween endpoint is the resting fan,
    // whose proper lift is -119px; the producer has not re-emitted that resting pose when tickTweens fires.
    const state = build(renderer, handScene([{ id: "h1", y: -158 }]));
    expect(el(stage, "h1").style.translate).toBe("0px -42px");

    hints(renderer, state, [hint("h1", FAN_Y, 400)]);
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);

    // No fresh stream landed under the pin, so the DOM element remains at its endpoint. First cross the wall-clock
    // deadline without running the scheduled settle tick: the record still owns the painted CSS channel, and an
    // intervening reconcile must not rewrite -119px back to the retained -158px stream.
    const translate = vi.spyOn(el(stage, "h1").style, "translate", "set");
    clock = 410;
    renderer.reconcile(state);
    expect(translate).not.toHaveBeenCalled();
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);

    // The tick then exposes that endpoint through its one settle-time hand pass as well.
    flushRaf(420);
    expect(translate).not.toHaveBeenCalled();
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);
    // The ordinary fan-pose re-emit is a no-op too — its stream now agrees with the endpoint this settle retained.
    move(renderer, state, [{ id: "h1", transform: at(0, FAN_Y) }]);
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);
  });

  it("assumes the resting fan for a suppressed holder whose endpoint has not landed yet", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]));

    // The first few frames of a return: back in the container, transform suppressed, no endpoint yet. The pose the
    // ramp exists for — the focus — is a TELEPORT and is always streamed, so a suppressed holder is never focused.
    move(renderer, state, [{ id: "h1", parentId: "PlayerHand", transform: at(700, 400) }]);
    move(renderer, state, [{ id: "h1", parentId: "CardHolderContainer" }]);
    expect(el(stage, "h1").style.translate).toBe(`0px ${-RAISE}px`);
  });
});

describe("readable-hand mode — the input inverse it publishes", () => {
  it("publishes one stamp per moved hit surface, carrying the offset it was drawn at", () => {
    const { renderer } = harness();
    renderer.setRaiseHandCards(true);
    build(renderer, [...handScene([{ id: "h0", y: FAN_Y }]), ...creatureScene()]);

    const stamps = renderer.raiseInputStamps();
    const offsets = stamps.map((s) => s.dy).sort((a, b) => a - b);
    // The card's hit box (raised), and the health bar's hover box (shifted with its group).
    expect(offsets).toEqual([-244, -RAISE]);
    const card = stamps.find((s) => s.dy === -RAISE)!;
    expect(card.localRect).toEqual({ x: -150, y: -211, width: 300, height: 422 });
  });

  it("publishes NOTHING once the hand is down again, so input goes back to byte-identical", () => {
    const { renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]));
    expect(renderer.raiseInputStamps()).toHaveLength(2);

    move(renderer, state, [{ id: "h1", parentId: "PlayerHand", transform: at(700, 500) }]);
    expect(renderer.raiseInputStamps()).toEqual([]);
  });

  it("hands each interactive rect its own drawn offset (what the near-miss pass reads)", () => {
    const { renderer } = harness();
    renderer.setRaiseHandCards(true);
    build(renderer, [...handScene([{ id: "h0", y: FAN_Y }]), ...creatureScene()]);

    const byId = new Map(renderer.interactiveRects().map((r) => [r.id, r.raiseDy]));
    expect(byId.get("h0Hitbox")).toBe(-RAISE);
    expect(byId.get("CreatureHpHit")).toBe(-244);
  });
});

describe("readable-hand mode — the hand-choice (sustain/discard) gate", () => {
  it("stands aside while a hand-choice prompt is up, and returns when it closes", () => {
    const { stage, renderer } = harness();
    renderer.setRaiseHandCards(true);
    const state = build(renderer, [
      ...handScene([{ id: "h0", y: FAN_Y }]),
      // The in-hand SELECT mode's one exclusive node: player_hand.tscn's backstop, visible only during the
      // sustain/discard/exhaust family of prompts. NAME is the signal (it is a plain ColorRect).
      node("SelectModeBackstop", "PlayerHand", { name: "SelectModeBackstop", visible: true })
    ]);

    // The prompt owns the hand's layout — no raise, no stamps.
    expect(el(stage, "h0").style.translate).toBe("");
    expect(renderer.raiseInputStamps()).toEqual([]);

    // The prompt closes → the resting fan lifts again.
    move(renderer, state, [{ id: "SelectModeBackstop", name: "SelectModeBackstop", visible: false }]);
    expect(el(stage, "h0").style.translate).toBe(`0px ${-RAISE}px`);
    expect(renderer.raiseInputStamps()).toHaveLength(1);
  });
});

describe("readable-hand mode — raise-input stamps", () => {
  it("publishes each hand stamp with its holder ownership", () => {
    const { renderer } = harness();
    renderer.setRaiseHandCards(true);
    build(renderer, handScene([{ id: "h0", y: FAN_Y }]));

    const stamps = renderer.raiseInputStamps();
    expect(stamps).toHaveLength(1);
    expect(stamps[0].ownerId).toBe("h0");
  });

  it("orders hand stamps by the holder's zIndex, z-lifted (focused) LAST — wire order alone lies at focus onset", () => {
    const { renderer } = harness();
    renderer.setRaiseHandCards(true);
    // h0 comes FIRST in wire order but carries the focus z-lift (zIndex 1, streamed ~245ms before the sibling
    // reorder catches up — capture b3-pool-recycle), so its stamp must still arbitrate topmost, i.e. LAST.
    const spread = handScene([
      { id: "h0", y: FAN_Y },
      { id: "h1", y: FAN_Y }
    ]);
    for (const n of spread) {
      if (n.id === "h0") {
        n.zIndex = 1;
        n.transform = at(-160, FAN_Y);
      }
      if (n.id === "h0Hitbox") n.transform = at(0, 0);
    }
    build(renderer, spread);
    expect(renderer.raiseInputStamps().map((s) => s.ownerId)).toEqual(["h1", "h0"]);
  });

  it("keeps a holder the game took out of the fan in the per-pixel registry", () => {
    const { renderer } = harness();
    renderer.setRaiseHandCards(true);
    // A creature is in the scene on purpose: its HUD shift keeps the moved-rect set non-empty, which is what makes
    // the hand stamps keep publishing after the hand's own lift has dropped to 0. Without it the whole registry
    // empties and this hazard cannot be reached at all — which is precisely why it survived to a live run.
    const state = build(renderer, [
      ...handScene([{ id: "h0", y: FAN_Y }, { id: "h1", y: FAN_Y }]),
      ...creatureScene()
    ]);
    expect(renderer.raiseInputStamps().flatMap((s) => s.ownerId ?? [])).toEqual(["h0", "h1"]);

    // h1 is SELECTED: the game reparents its holder off the container onto the hand root and parks it in the play
    // position. It keeps its 300x422 hitbox, so it stays a governed hand rect — but the game will not focus it, and
    // an anchor there swallowed every tap within its 30-local-px margin (live: four H6 points, 2026-08-26).
    move(renderer, state, [{ id: "h1", parentId: "PlayerHand", transform: at(700, 400) }]);
    const stamps = renderer.raiseInputStamps();
    // Still published, so the translation inverse continues to use the complete raised surface registry.
    expect(stamps.flatMap((s) => s.ownerId ?? [])).toEqual(["h0", "h1"]);

    // Cancelled: the holder comes home to the container and is targetable again.
    move(renderer, state, [
      { id: "h1", parentId: "CardHolderContainer", transform: at(0, FAN_Y) }
    ]);
    expect(renderer.raiseInputStamps().flatMap((s) => s.ownerId ?? [])).toEqual(["h0", "h1"]);
  });

  it("marks every governed hand hitbox rect `raiseGoverned` (the widescreen near-miss exemption)", () => {
    const { renderer } = harness();
    renderer.setRaiseHandCards(true);
    build(renderer, [...handScene([{ id: "h0", y: FAN_Y }]), ...creatureScene()]);

    const byId = new Map(renderer.interactiveRects().map((r) => [r.id, r.raiseGoverned]));
    expect(byId.get("h0Hitbox")).toBe(true);
    expect(byId.get("CreatureHpHit")).toBe(false);
  });
});
