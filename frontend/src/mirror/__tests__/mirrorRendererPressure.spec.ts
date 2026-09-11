import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetMirrorFramePressureForTest, mirrorFramePressure } from "@/mirror/framePressure";
import {
  createMirrorRenderer,

  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorCardFlightHint,
  type MirrorState
} from "@/mirror/sceneTree";

// THE RENDERER'S ARMED-WORK SUPPLIER — the host half of the Aug-19 encode-stall fix.
//
// THE DEFECT, restated as what these specs must catch. gsw's static-surface encode asks the mirror "are you
// busy?" before spending a `toBlob`, and on a phone that call is a synchronous GPU→CPU readback. The Aug-19
// Moto G86 trace caught two of them at 285 ms and 1,163 ms — and the answer the mirror gave was derived purely
// from FRAME RECENCY, i.e. from frames the mirror had produced. A 1,163 ms task suppresses those frames. So the
// signal reported QUIET during the two recovery gaps (362 ms and 674 ms with no frames at all) — the jam
// manufacturing its own idle reading, at exactly the moment another readback was the worst possible thing to
// spend. The same encodes cost 6-13 ms each once the animation ended.
//
// The renderer's answer is a supplier that reports what is ARMED rather than what has RUN, which a blocked main
// thread cannot fake. What each spec below is guarding, in order of what would hurt:
//   1. it must hold pressure ACROSS a gap longer than the 250 ms recency window (that gap IS the bug);
//   2. it must go quiet on its own afterwards — a supplier that latched would leave gsw draining only at its
//      `busyMaxDeferMs` bound, i.e. re-introduce the standing live-canvas cost the whole swap exists to remove;
//   3. it must EXCLUDE the continuous animators (spine clips, intent glyphs), because an idle combat screen runs
//      those forever and the fleet has to be able to freeze on an idle combat screen;
//   4. dispose must unregister, or a torn-down renderer keeps answering for the next one.

type Raw = Record<string, unknown>;

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

const xf = (tx: number, ty: number) => ({
  xAxis: { x: 1, y: 0 },
  yAxis: { x: 0, y: 1 },
  origin: { x: tx, y: ty }
});

const box = { position: { x: 0, y: 0 }, size: { x: 100, y: 140 } };

const rect = (x: number, y: number, w: number, h: number) => ({
  position: { x, y },
  size: { x: w, y: h }
});

// The same representative flight cardFlight.spec drives: right-to-left across the board, arcing up, inside the
// game's own RNG box.
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

// The three nodes a flight moves: the VFX itself, the trail root that copies its pose, and one of the trail's
// strokes (cardFlight.spec's `flightNodes`).
function flightNodes(): Raw[] {
  return [
    { id: "41", parentId: "Game", name: "VfxCardFlyShuffle", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardFlyShuffleVfx", visible: true, transform: xf(0, 0), localRect: box },
    { id: "42", parentId: "Game", name: "CardTrailIronclad", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx", visible: true, transform: xf(0, 0) },
    { id: "43", parentId: "42", name: "Trails", nodeType: "Godot.Node2D", visible: true, transform: xf(0, 0) },
    { id: "44", parentId: "43", name: "OuterTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(0, 0) }
  ];
}

// A continuously-cycling enemy-intent glyph — the "idle combat screen is never actually still" fixture
// (intentSteps.spec's `glyph`). Four frames at 15 fps, forever.
function intentGlyph(): Raw {
  return {
    id: "glyph",
    parentId: "Game",
    name: "Intent",
    nodeType: "Sprite2D",
    visible: true,
    transform: xf(100, 100),
    localRect: rect(0, 0, 48, 51),
    intentFrames: {
      animationName: "attack",
      fps: 15,
      frames: [
        { atlasPath: "res://atlases/intent_atlas.png", region: rect(0, 0, 48, 51) },
        { atlasPath: "res://atlases/intent_atlas.png", region: rect(48, 0, 48, 51) },
        { atlasPath: "res://atlases/intent_atlas.png", region: rect(96, 0, 48, 51) },
        { atlasPath: "res://atlases/intent_atlas.png", region: rect(144, 0, 48, 51) }
      ]
    }
  };
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

function deliverFlight(state: MirrorState, h: MirrorCardFlightHint): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts: [],
      cardFlights: [h]
    })!
  );
}

// The recency window is 250 ms (framePressure.ts). Every assertion below is taken a full second past the last
// frame the loop produced, i.e. deep inside the region where recency alone reads QUIET — which is precisely the
// region the traced 362/674 ms jank gaps fell into.
const PAST_THE_WINDOW_MS = 1000;

describe("mirrorRenderer — the armed-work pressure supplier", () => {
  let clock = 0;
  let rafCb: FrameRequestCallback | null = null;
  let timers: { id: number; at: number; cb: () => void }[] = [];
  let nextTimerId = 1;
  let renderer: MirrorRenderer | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    clock = 0;
    rafCb = null;
    timers = [];
    nextTimerId = 1;
    // Reset BEFORE any renderer is built: this clears the supplier registry too, so a renderer created below is
    // the only thing answering. (Doing it after would silently unregister the thing under test.)
    __resetMirrorFramePressureForTest();
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

  // The renderer's animation loop is deadline-scheduled (a setTimeout park, then the rAF that mutates); model
  // both halves against the same fake clock (cardFlight.spec / mirrorTween.spec's harness).
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

  function startFlight(): MirrorState {
    const state = createMirrorState();
    seed(state, [ROOT, ...flightNodes()]);
    renderer!.reconcile(state);
    deliverFlight(state, hint());
    renderer!.reconcile(state);
    return state;
  }

  it("holds pressure across a gap the jank itself created — a live flight outlasts the recency window", () => {
    harness();
    startFlight();
    flushRaf(16); // one integrator frame: the loop runs, and notes a frame as it goes

    // A full second after the last produced frame. Recency is long since quiet here — this is the exact reading
    // the trace's 674 ms gap produced, and the whole reason another readback got spent into the jam.
    expect(mirrorFramePressure(clock + PAST_THE_WINDOW_MS)).toBe(true);
    // Armed work is STATE, not recency, so it does not decay with the clock. A pressure reading that expired
    // would just be the same bug with a longer fuse.
    expect(mirrorFramePressure(clock + 100_000)).toBe(true);
  });

  it("goes quiet once the last flight retires and its trail has aged out", () => {
    // THE ANTI-LATCH TEST, and the one that bounds the risk of the whole change: a supplier that never returned
    // false would leave gsw draining one surface per `busyMaxDeferMs`, i.e. 72 live canvases freezing over
    // minutes — worse than the stall it replaced.
    harness();
    startFlight();

    for (let t = 16; t <= 500; t += 16) {
      flushRaf(t);
    }
    expect(mirrorFramePressure(clock + PAST_THE_WINDOW_MS), "still mid-flight").toBe(true);

    // Out past everything the flight arms: the ~1.4 s arc, the shrink, the producer window that holds the
    // transform pin (3.6 s here), and the 0.8 s ramp over which the comet's trail points expire.
    for (let t = 516; t <= 6000; t += 16) {
      flushRaf(t);
    }
    expect(mirrorFramePressure(clock + PAST_THE_WINDOW_MS)).toBe(false);
    // …and it stays quiet: nothing re-arms on its own, so the fleet can actually freeze.
    expect(mirrorFramePressure(clock + 100_000)).toBe(false);
  });

  it("an idle combat scene reports QUIET with compositor-driven glyphs", () => {
    // THE EXCLUSION, pinned. `activeSpine`/`activeIntents` are deliberately NOT in the supplier: a settled
    // combat screen animates both continuously, so counting them would make pressure PERMANENT and the fleet
    // would never freeze — the exact regression the swap exists to prevent (measured: 11 → 87.5 fps for the
    // fleet). They call `noteMirrorFrame()` while they tick, so the recency term already covers them; what they
    // must not have is immunity to jank, because they are not what jams the thread.
    harness();
    const state = createMirrorState();
    seed(state, [ROOT, intentGlyph()]);
    renderer!.reconcile(state);

    flushRaf(16);
    expect(mirrorFramePressure(clock + PAST_THE_WINDOW_MS)).toBe(false);
    // Let its compositor animation run while the renderer stays parked.
    for (let t = 32; t <= 1200; t += 16) {
      flushRaf(t);
    }
    expect(timers).toHaveLength(0);
    expect(mirrorFramePressure(clock + PAST_THE_WINDOW_MS)).toBe(false);
  });

  it("dispose() unregisters — a torn-down renderer stops answering for the next one", () => {
    // Also the non-vacuity proof for the first spec: the same instant flips to quiet purely because the
    // supplier went away, so the `true` above was the supplier speaking and not a stale recency reading.
    harness();
    startFlight();
    flushRaf(16);
    const at = clock + PAST_THE_WINDOW_MS;
    expect(mirrorFramePressure(at)).toBe(true);

    renderer!.dispose();
    expect(mirrorFramePressure(at)).toBe(false);

    renderer = null; // afterEach must not dispose twice
  });
});
