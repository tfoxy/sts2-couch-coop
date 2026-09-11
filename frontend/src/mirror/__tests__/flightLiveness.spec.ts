import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,


  __setFlightLogForTest,
  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import {
  applySceneDelta,
  cardFlightParseDrops,
  createMirrorState,
  parseSceneDelta,
  __resetCardFlightParseDropsForTest,
  type MirrorCardFlightHint,
  type MirrorState
} from "@/mirror/sceneTree";

// R12 WS-B — FLIGHT LIVENESS, AND THE COUNTERS THAT WOULD HAVE FOUND IT.
//
// THE INCIDENT. A phone trace showed a 30-card reshuffle whose cards crawled across the screen in 4-8 Hz steps
// instead of flying. The declarative replay (R11) had silently never run — a producer gate upstream had stopped
// emitting `cardFlights[]` — and the client could not say so: the only flight series was `flightsPeak`, which reads
// 0 both for "no shuffle is happening" and for "every shuffle is broken". Two things come out of that:
//
//   1. THE COUNTERS (`describe` #2 below). Each link of the chain — hint parsed → hint received → hint matched →
//      flight armed → handed to the compositor → integrated per frame → retired — is separately counted, so one
//      `JSON.stringify(window.__mirrorWalkStats)` names the missing link instead of implying one.
//
//   2. THE LIVENESS SPEC (`describe` #1). Once a flight is armed, the renderer owns its motion for the whole
//      window: the pose comes from a closed form on the client's own clock and NOTHING in the loop consults the
//      wire. That is already true (refreshAnimDeadlines publishes `flightDueAt = now` while any flight is live,
//      scheduleTick takes the min and goes straight to rAF, runScheduledTick services flights and re-arms from the
//      recomputed deadline) — these specs exist so a future scheduler edit cannot quietly re-couple it to delta
//      arrivals, which is the shape of the bug that has to stay impossible even when the producer gate breaks
//      again. Every one of them delivers exactly ONE reconcile and then goes wire-silent for the whole flight.

type Raw = Record<string, unknown>;

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

const xf = (tx: number, ty: number) => ({
  xAxis: { x: 1, y: 0 },
  yAxis: { x: 0, y: 1 },
  origin: { x: tx, y: ty }
});

const box = { position: { x: 0, y: 0 }, size: { x: 100, y: 140 } };

// The representative flight cardFlight.spec / mirrorRendererPressure.spec drive: right-to-left across the board,
// arcing up, inside the range the producer can emit.
function hint(overrides: Partial<MirrorCardFlightHint> = {}): MirrorCardFlightHint {
  return {
    targetId: "41",
    trailId: "42",
    start: [300, 880],
    end: [1620, 880],
    control: [960, 280],
    basis: [1, 0, 0, 1],
    speed0: 1.18,
    accel: 2.3,
    duration: 1.4,
    scale0: 1,
    windowMs: 3600,
    kind: "shuffle",
    rot0: 0,
    ...overrides
  };
}

// The nodes a flight moves: the VFX itself (the only one with a box, i.e. the only one the mirror places), the
// boxless trail root, and one of the trail's strokes.
function flightNodes(): Raw[] {
  return [
    { id: "41", parentId: "Game", name: "VfxCardFlyShuffle", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardFlyShuffleVfx", visible: true, transform: xf(0, 0), localRect: box },
    { id: "42", parentId: "Game", name: "CardTrailIronclad", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx", visible: true, transform: xf(0, 0) },
    { id: "43", parentId: "42", name: "Trails", nodeType: "Godot.Node2D", visible: true, transform: xf(0, 0) },
    { id: "44", parentId: "43", name: "OuterTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(0, 0) }
  ];
}

// R13 — the DISCARD's mover, which is a different animal from the shuffle's. The shuffle flies a spawned VFX node
// that exists only for the sweep; a discard flies the REAL card the player just played — an ordinary streamed
// Control with a full card face, already on screen, with a box of its own and no trail. The producer suppresses its
// whole subtree for the window and then FREES it, so the flight's end arrives as a removal rather than a settle.
const DISCARD_CARD_ID = "51";

function cardNode(x = 0, y = 0): Raw {
  return {
    id: DISCARD_CARD_ID,
    parentId: "Game",
    name: "Card",
    nodeType: "NCard",
    visible: true,
    transform: xf(x, y),
    localRect: box
  };
}

function discardHint(overrides: Partial<MirrorCardFlightHint> = {}): MirrorCardFlightHint {
  return hint({ targetId: DISCARD_CARD_ID, trailId: null, kind: "discard", rot0: -0.35, ...overrides });
}

// One VOLATILE-ONLY upsert of the flight VFX's pose — the shape the producer streams while it is NOT suppressing
// the node, i.e. the whole wire of the degraded path. `name` is deliberately absent (that is what marks an upsert
// volatile-only and sends it through `mergeNode`'s static carry-forward); `parentId`, `transform` and `localRect`
// ride it because none of those three is a carried-forward static field.
function streamedPose(x: number, y: number): Raw {
  return { id: "41", parentId: "Game", visible: true, transform: xf(x, y), localRect: box };
}

function seed(state: MirrorState, nodes: Raw[]): void {
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
}

function deliver(state: MirrorState, body: Raw): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts: [],
      ...body
    })!
  );
}

function translation(stage: HTMLElement, id: string): [number, number] | null {
  const el = stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null;
  const m = el?.style.transform.match(/matrix\(([^)]+)\)/);
  if (!m) {
    return null;
  }
  const parts = m[1].split(",").map(Number);
  return [parts[4], parts[5]];
}

interface FakeAnimation {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  currentTime: number;
  cancelled: number;
  onfinish: (() => void) | null;
  cancel(): void;
}

describe("flight liveness — an armed flight runs on the CLIENT's clock, not the wire's", () => {
  let clock = 0;
  let rafCb: FrameRequestCallback | null = null;
  let timers: { id: number; at: number; cb: () => void }[] = [];
  let nextTimerId = 1;
  let renderer: MirrorRenderer | null = null;
  let animations: FakeAnimation[] = [];
  const realAnimate = (Element.prototype as unknown as { animate?: unknown }).animate;

  // jsdom has no `Element.animate`, so the compositor branch is only reachable with a recording stub
  // (cardFlight.spec's). Installed per-test rather than in beforeEach: its ABSENCE is itself one of the cases.
  function installAnimate(): void {
    (Element.prototype as unknown as { animate: unknown }).animate = function (
      keyframes: Keyframe[],
      options: KeyframeAnimationOptions
    ) {
      const anim: FakeAnimation = {
        keyframes: [...keyframes],
        options,
        currentTime: 0,
        cancelled: 0,
        onfinish: null,
        cancel() {
          this.cancelled++;
        }
      };
      animations.push(anim);
      return anim;
    };
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    clock = 0;
    rafCb = null;
    timers = [];
    nextTimerId = 1;
    animations = [];
    mirrorWalkStats.reset();
    __resetCardFlightParseDropsForTest();
    __setFlightLogForTest(false);
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
    renderer?.dispose();
    renderer = null;
    __setFlightLogForTest(false);
    if (realAnimate === undefined) {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    } else {
      (Element.prototype as unknown as { animate: unknown }).animate = realAnimate;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function harness(): HTMLElement {
    const stage = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(defs);
    document.body.append(stage, svg);
    renderer = createMirrorRenderer(stage, defs);
    return stage;
  }

  // The renderer's loop is deadline-scheduled: a setTimeout park, then the rAF that mutates. Both halves run
  // against the same fake clock (the cardFlight.spec / mirrorTween.spec harness).
  function flushRaf(atMs: number): void {
    clock = atMs;
    for (let guard = 0; guard < 8; guard++) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
      if (due.length === 0) {
        break;
      }
      timers = timers.filter((t) => t.at > clock);
      for (const timer of due) {
        timer.cb();
      }
    }
    const cb = rafCb;
    rafCb = null;
    cb?.(atMs);
  }

  function arm(h = hint(), nodes = flightNodes()): { stage: HTMLElement; state: MirrorState } {
    const stage = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...nodes]);
    renderer!.reconcile(state);
    deliver(state, { cardFlights: [h] });
    renderer!.reconcile(state);
    return { stage, state };
  }

  // ---- 1. THE HEADLINE: total wire silence, and the cards still fly --------------------------------------------

  it("keeps ticking for a whole flight with ZERO further reconciles (compositor path)", () => {
    installAnimate();
    arm();
    expect(mirrorWalkStats.flightsArmed, "vacuity guard: a flight really did arm").toBe(1);
    expect(mirrorWalkStats.flightCssAnimStarted).toBe(1);

    // From here on NOTHING is delivered and `reconcile` is never called again. Every wakeup below must come from
    // the renderer's own deadline loop.
    let wakeups = mirrorWalkStats.tickWakeups;
    let steps = mirrorWalkStats.flightSteps;
    let ticked = 0;
    for (let t = 16; t <= 2000; t += 16) {
      flushRaf(t);
      if (mirrorWalkStats.flightSteps === steps) {
        break; // the flight has landed; the loop is free to park from here
      }
      expect(mirrorWalkStats.flightSteps, `a step at t=${t}`).toBe(steps + 1);
      expect(mirrorWalkStats.tickWakeups, `a wakeup at t=${t}`).toBeGreaterThan(wakeups);
      steps = mirrorWalkStats.flightSteps;
      wakeups = mirrorWalkStats.tickWakeups;
      ticked++;
    }

    // ~1.2 s of flight at one step per 16 ms frame. The exact number is the closed form's business; what this
    // pins is that it is a per-FRAME series and not a per-DELTA one (which would have been 0 — nothing arrived).
    expect(ticked, "the flight was integrated on every frame of its life").toBeGreaterThan(60);
    expect(mirrorWalkStats.flightRetired.done, "and it landed").toBe(1);
    expect(mirrorWalkStats.flightRetired.pinExpired, "not by running out of window").toBe(0);
    expect(mirrorWalkStats.flightRetired.noEl + mirrorWalkStats.flightRetired.noRecord).toBe(0);
  });

  it("a delta that re-ships the node's FROZEN transform cannot stall the loop either", () => {
    // The other half of wire-independence: the producer's last streamed pose for a suppressed node is its
    // PRE-flight one. Reconciling it mid-flight must neither move the card back nor take the loop's deadline away.
    const { stage, state } = arm();
    for (let t = 16; t <= 320; t += 16) {
      flushRaf(t);
    }
    const before = translation(stage, "41")!;
    deliver(state, { upserts: [streamedPose(0, 0)] });
    renderer!.reconcile(state);
    expect(translation(stage, "41"), "the frozen streamed transform must not win").toEqual(before);

    const steps = mirrorWalkStats.flightSteps;
    for (let t = 336; t <= 640; t += 16) {
      flushRaf(t);
    }
    expect(mirrorWalkStats.flightSteps - steps, "the loop kept its own cadence").toBeGreaterThan(15);
    expect(translation(stage, "41")![0]).toBeGreaterThan(before[0]);
  });

  // ---- R13: the second kind, on the same chain ----------------------------------------------------------------

  it("arms a DISCARD from one reconcile and flies it wire-silent for the whole window", () => {
    installAnimate();
    arm(discardHint(), [cardNode()]);
    expect(mirrorWalkStats.flightsArmed, "it armed like any other flight").toBe(1);
    expect(mirrorWalkStats.discardFlightsArmed, "…and is counted as its own kind").toBe(1);
    expect(mirrorWalkStats.flightHintUnmatched, "the real card matched a mirrored record").toBe(0);
    expect(mirrorWalkStats.flightCssAnimStarted).toBe(1);

    // Nothing is delivered from here and `reconcile` is never called again. The card the player just played is
    // suppressed at the producer for `windowMs`, so if the loop needed the wire it would freeze mid-air.
    let steps = mirrorWalkStats.flightSteps;
    let ticked = 0;
    for (let t = 16; t <= 2000; t += 16) {
      flushRaf(t);
      if (mirrorWalkStats.flightSteps === steps) {
        break;
      }
      expect(mirrorWalkStats.flightSteps, `a step at t=${t}`).toBe(steps + 1);
      steps = mirrorWalkStats.flightSteps;
      ticked++;
    }
    expect(ticked, "integrated on every frame of its life").toBeGreaterThan(60);
    expect(mirrorWalkStats.flightRetired.done, "and it landed").toBe(1);
  });

  it("retires a discard cleanly when the card is FREED mid-flight, leaving no fill:forwards residue", () => {
    // A discard does not settle — the card is gone at the far end, so the flight's real terminator is a
    // `removedIds`. `dropCardFlightsFor` has to reach `stopFlightCssAnimation`, or a `fill: forwards` effect
    // outlives the node and keeps overriding whatever element the renderer hands out next.
    installAnimate();
    const { stage, state } = arm(discardHint(), [cardNode()]);
    flushRaf(16);
    flushRaf(32);
    expect(animations).toHaveLength(1);
    expect(animations[0].cancelled, "still flying").toBe(0);

    deliver(state, { removedIds: [DISCARD_CARD_ID], orderedIds: ["Game"] });
    renderer!.reconcile(state);
    expect(mirrorWalkStats.flightRetired.noRecord).toBe(1);
    expect(mirrorWalkStats.flightRetired.pinExpired).toBe(0);
    expect(animations[0].cancelled, "the effect went with the node").toBe(1);

    // The card comes back (a new hand is dealt into the same id space). It must place from its OWN streamed
    // transform — a surviving effect would have pinned it to the discard pile for the life of the document.
    deliver(state, { upserts: [cardNode(640, 300)], orderedIds: ["Game", DISCARD_CARD_ID] });
    renderer!.reconcile(state);
    for (let t = 48; t <= 96; t += 16) {
      flushRaf(t);
    }
    expect(translation(stage, DISCARD_CARD_ID), "placed by the wire, not by a ghost animation").toEqual([640, 300]);
    expect(animations, "and no second animation was registered — no hint came with it").toHaveLength(1);
  });
});

// ---- 2. THE COUNTERS ------------------------------------------------------------------------------------------

describe("flight liveness — the counters name which link of the chain is missing", () => {
  let clock = 0;
  let rafCb: FrameRequestCallback | null = null;
  let timers: { id: number; at: number; cb: () => void }[] = [];
  let nextTimerId = 1;
  let renderer: MirrorRenderer | null = null;
  const realAnimate = (Element.prototype as unknown as { animate?: unknown }).animate;

  beforeEach(() => {
    document.body.innerHTML = "";
    clock = 0;
    rafCb = null;
    timers = [];
    nextTimerId = 1;
    mirrorWalkStats.reset();
    __resetCardFlightParseDropsForTest();
    __setFlightLogForTest(false);
    // NO `Element.animate` stub anywhere in this block: jsdom's native state is the `noWaapi` case, and the
    // stepped fallback it forces is what most of these assertions run on.
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
    renderer?.dispose();
    renderer = null;
    __setFlightLogForTest(false);
    if (realAnimate === undefined) {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    } else {
      (Element.prototype as unknown as { animate: unknown }).animate = realAnimate;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function harness(): HTMLElement {
    const stage = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(defs);
    document.body.append(stage, svg);
    renderer = createMirrorRenderer(stage, defs);
    return stage;
  }

  function flushRaf(atMs: number): void {
    clock = atMs;
    for (let guard = 0; guard < 8; guard++) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
      if (due.length === 0) {
        break;
      }
      timers = timers.filter((t) => t.at > clock);
      for (const timer of due) {
        timer.cb();
      }
    }
    const cb = rafCb;
    rafCb = null;
    cb?.(atMs);
  }

  function arm(h = hint(), nodes = flightNodes()): { stage: HTMLElement; state: MirrorState } {
    const stage = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...nodes]);
    renderer!.reconcile(state);
    deliver(state, { cardFlights: [h] });
    renderer!.reconcile(state);
    return { stage, state };
  }

  it("jsdom has no Element.animate, so the flight is counted as `noWaapi` and still completes", () => {
    // The most important property of the whole failure-reason split: a compositor miss is NOT a regression. The
    // flight falls back to the stepped integrator — the pre-R11 shipped behaviour — and the counter is the only
    // thing that changes.
    expect(typeof (Element.prototype as unknown as { animate?: unknown }).animate).not.toBe("function");
    arm();
    expect(mirrorWalkStats.cardFlightHintsReceived).toBe(1);
    expect(mirrorWalkStats.flightsArmed).toBe(1);
    expect(mirrorWalkStats.flightCssAnimStarted).toBe(0);
    expect(mirrorWalkStats.flightCssAnimFailed.noWaapi).toBe(1);
    for (let t = 16; t <= 2000; t += 16) {
      flushRaf(t);
    }
    expect(mirrorWalkStats.flightRetired.done, "it flew anyway").toBe(1);
    expect(mirrorWalkStats.flightSteps).toBeGreaterThan(60);
  });

  it("`boxless`: a target with no placement box of its own", () => {
    // The trail's inner `Trails` group is a bare Node2D — the mirror gives a boxless node no element transform at
    // all, so there is nothing to animate. Pointing a hint at it is the cheapest way to reach the geometry failure,
    // and it is a real one: `nodeTransformForGlobal` returning null is what the keyframe builder gives up on.
    // (The trail ROOT is deliberately NOT boxless any more — R14c makes it the comet's transform carrier.)
    //
    // The stub is REQUIRED here: without it `noWaapi` is decided first and the keyframe builder is never reached,
    // which is itself the reason the six reasons are tested in order of where they short-circuit.
    (Element.prototype as unknown as { animate: unknown }).animate = () => ({
      cancel() {},
      currentTime: 0,
      onfinish: null
    });
    arm(hint({ targetId: "43", trailId: null }));
    expect(mirrorWalkStats.flightsArmed, "it still armed — only the compositor hand-off failed").toBe(1);
    expect(mirrorWalkStats.flightCssAnimFailed.boxless).toBeGreaterThan(0);
  });

  it("`flightHintUnmatched`: a hint for a node this client has never mirrored", () => {
    arm(hint({ targetId: "not-a-node", trailId: null }));
    expect(mirrorWalkStats.cardFlightHintsReceived, "the hint DID arrive").toBe(1);
    expect(mirrorWalkStats.flightHintUnmatched).toBe(1);
    expect(mirrorWalkStats.flightsArmed).toBe(0);
  });

  it("R13: discardFlightsArmed is the SUBSET, so a mixed batch splits", () => {
    // A reshuffle plus a played card in the same delta: `flightsArmed` counts everything, the new counter counts
    // only the discards, and the shuffle count is the difference. That subtraction is how the batch log reads.
    harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...flightNodes(), cardNode()]);
    renderer!.reconcile(state);
    deliver(state, { cardFlights: [hint(), discardHint()] });
    renderer!.reconcile(state);
    expect(mirrorWalkStats.flightsArmed).toBe(2);
    expect(mirrorWalkStats.discardFlightsArmed).toBe(1);
    expect(mirrorWalkStats.flightsArmed - mirrorWalkStats.discardFlightsArmed, "…so shuffles read as 1").toBe(1);
  });

  it("R13: reset() zeroes the new counter with the rest of the flight block", () => {
    arm(discardHint(), [cardNode()]);
    expect(mirrorWalkStats.discardFlightsArmed).toBe(1);
    mirrorWalkStats.reset();
    expect(mirrorWalkStats.discardFlightsArmed).toBe(0);
  });

  it("`cardFlightParseDrops`: a malformed hint never reaches the renderer, so the PARSER counts it", () => {
    // The one failure no renderer counter can see. `duration <= 0` is rejected by the strict normalizer, which is
    // also why `flightCssAnimFailed.degenerate` is not reachable from a wire hint — only from a mid-flight rebake.
    const before = cardFlightParseDrops();
    const stage = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...flightNodes()]);
    renderer!.reconcile(state);
    deliver(state, { cardFlights: [{ ...hint(), duration: 0 }, { ...hint(), basis: [1, 0, 0] }] });
    renderer!.reconcile(state);
    expect(cardFlightParseDrops() - before).toBe(2);
    expect(mirrorWalkStats.cardFlightParseDrops - before, "and the walk-stats gauge reads through").toBe(2);
    expect(mirrorWalkStats.cardFlightHintsReceived, "nothing reached the renderer").toBe(0);
    expect(stage.querySelector('[data-node-id="41"]')).not.toBeNull();
  });

  it("`flightNodesStreamed` names the DEGRADED path: flight nodes moving on the wire's clock", () => {
    // THE PHONE'S SYMPTOM, as one number. With the producer gate stuck the host keeps streaming the flight VFX's
    // per-frame transform and sends no hint at all — so the cards travel, choppily, at the delta rate. Nothing
    // else in the dump distinguishes that from a healthy idle scene.
    harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...flightNodes()]);
    renderer!.reconcile(state);
    const seedCount = mirrorWalkStats.flightNodesStreamed;

    for (let i = 1; i <= 5; i++) {
      deliver(state, { upserts: [streamedPose(i * 40, 880)] });
      renderer!.reconcile(state);
    }
    expect(mirrorWalkStats.flightNodesStreamed - seedCount, "one per streamed pose").toBe(5);
    expect(mirrorWalkStats.cardFlightHintsReceived, "…and not one hint to explain the motion").toBe(0);
  });

  it("…and goes silent the moment a flight owns the node", () => {
    // The counter must not fire on the HEALTHY path, or it says nothing. Once the pin is taken, a re-ship of the
    // node's frozen transform is overridden rather than applied — which is the whole point of the pin.
    const { state } = arm();
    const armed = mirrorWalkStats.flightNodesStreamed;
    for (let i = 1; i <= 5; i++) {
      deliver(state, { upserts: [streamedPose(i * 40, 880)] });
      renderer!.reconcile(state);
    }
    expect(mirrorWalkStats.flightNodesStreamed - armed).toBe(0);
  });

  it("`flightRetired.noRecord`: a flight whose node is removed mid-air", () => {
    const { state } = arm();
    flushRaf(16);
    deliver(state, { removedIds: ["41"], orderedIds: ["Game", "42", "43", "44"] });
    renderer!.reconcile(state);
    expect(mirrorWalkStats.flightRetired.noRecord).toBe(1);
    expect(mirrorWalkStats.flightRetired.done).toBe(0);
  });

  it("`?flightLog=1` emits exactly ONE line per batch, and nothing at all when off", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    __setFlightLogForTest(false);
    arm();
    for (let t = 16; t <= 2000; t += 16) {
      flushRaf(t);
    }
    expect(info, "default OFF — a phone reshuffles constantly").not.toHaveBeenCalled();

    renderer!.dispose();
    document.body.innerHTML = "";
    mirrorWalkStats.reset();
    clock = 0;
    timers = [];
    rafCb = null;
    __setFlightLogForTest(true);
    arm();
    expect(info, "the line lands on the batch's CLOSING edge, not its opening one").not.toHaveBeenCalled();
    for (let t = 16; t <= 2000; t += 16) {
      flushRaf(t);
    }
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(line).toContain("[mirror] flight batch:");
    expect(line).toContain("1 hints → 1 armed");
    expect(line, "R13: the batch names its kind split").toContain("(1 shuffle / 0 discard");
    expect(line).toContain("retired noRecord 0 / noEl 0 / pinExpired 0 / done 1");
  });

  it("R13: …and the batch line reports a discard as a discard", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    __setFlightLogForTest(true);
    arm(discardHint(), [cardNode()]);
    for (let t = 16; t <= 2000; t += 16) {
      flushRaf(t);
    }
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain("(0 shuffle / 1 discard");
  });
});
