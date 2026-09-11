import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { affineMul, type Affine } from "@/mirror/affine";
import {
  createTrailPoints,
  isTrailTeleport,
  resetTrailPoints,
  TRAIL_TELEPORT_DIST
} from "@/mirror/cardTrail";
import {
  createMirrorRenderer,
  mirrorWalkStats,

  __setFlightLogForTest,
  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorCardFlightHint,
  type MirrorState
} from "@/mirror/sceneTree";

// R14f — THE TRAIL FRAME, AND WHO OWNS IT.
//
// A synthesized ribbon is a POINT HISTORY: each head sample is converted into some space at the instant it is taken
// and then left there for up to 800ms. Nothing may change that space underneath the stored points — do it and every
// one of them silently means a different place, which is drawn as a self-crossing polygon fanned across the stage
// rather than a comet. Two separate mechanisms used to change it:
//
//   1. THE SPACE ITSELF was re-derived from the node's composed global on every walk visit. That global is a
//      product of two wire values with independent freeze windows — the comet root's pose and the stroke's own
//      counter-transform — so when the producer freezes one of them (which is exactly what it does for the length
//      of a flight) the product sweeps away from the world identity the game holds these nodes at, DURING the life
//      of a point list. The fix is a LATCH: the space is taken once per history and `visit` places the node from it
//      until the history drains.
//
//   2. TWO WRITERS. The R14c root drive set the same space from its own rule while the walk was still setting it
//      from the stream, and the walk's HEAD sampler (whose guard consulted the set of trail ROOTS, and so never
//      fired for a stroke) went on appending the producer's answer for "where is the card" into a history the
//      flight was already driving with its own. Now the latch is the single source of the space, and
//      `flightOwnedStrokes` makes the flight the single source of the head.
//
// And one thing that is NOT a frame problem but produces the same picture: the comet subtree ARRIVES at the
// un-posed scene origin one delta before the producer places it, so the first two samples are ~2100px apart and
// the game's own subdivision rule fills the gap with a band across the whole stage. That is the teleport cut.

type Raw = Record<string, unknown>;

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

const xf = (tx: number, ty: number) => ({
  xAxis: { x: 1, y: 0 },
  yAxis: { x: 0, y: 1 },
  origin: { x: tx, y: ty }
});

const box = { position: { x: 0, y: 0 }, size: { x: 100, y: 140 } };
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

// THE FIXTURE IS THE FROZEN-STROKE SHAPE, deliberately. `trailRootDrive.spec.ts` uses the arrangement in which
// every level below the comet root counter-marches it, so the strokes compose to the world identity no matter what
// the root does — which is precisely why its pixel-parity case could not see this round's bug. The r13-reshuffle-30
// capture shows the other one: the two ribbons stream a transform ONCE, when the comet is instantiated, and never
// again, so their composed global IS the root's and rides it for the whole flight.
function comet(x: number, y: number): Raw[] {
  return [
    { id: "41", parentId: "Game", name: "VfxCardFlyShuffle", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardFlyShuffleVfx", visible: true, transform: xf(x, y), localRect: box },
    ...rootOnly(x, y),
    { id: "43", parentId: "42", name: "Trails", nodeType: "Godot.Node2D", visible: true, transform: xf(0, 0) },
    { id: "44", parentId: "43", name: "OuterTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(0, 0) },
    { id: "45", parentId: "43", name: "InnerTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(0, 0) }
  ];
}

// The producer's flight window: ONLY the comet root keeps streaming. Everything under it is frozen at what the
// instantiation delta seeded, which is what makes the composed stroke global sweep with the root.
function rootOnly(x: number, y: number): Raw[] {
  return [
    { id: "42", parentId: "Game", name: "CardTrailIronclad", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx", visible: true, transform: xf(x, y) }
  ];
}

// …and the card itself, which the walk places from the wire when no flight owns it.
function cardOnly(x: number, y: number): Raw[] {
  return [
    { id: "41", parentId: "Game", name: "VfxCardFlyShuffle", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardFlyShuffleVfx", visible: true, transform: xf(x, y), localRect: box }
  ];
}

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

function update(state: MirrorState, nodes: Raw[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!
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

function elementFor(stage: HTMLElement, id: string): HTMLElement {
  const el = stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null;
  expect(el, `element for node ${id}`).not.toBeNull();
  return el!;
}

function matrixOf(el: HTMLElement): Affine {
  const match = el.style.transform.match(/matrix\(([^)]+)\)/);
  if (!match) {
    return [...IDENTITY] as Affine;
  }
  const p = match[1].split(",").map((s) => Number(s.trim()));
  return [p[0], p[1], p[2], p[3], p[4], p[5]];
}

// The product of every element transform from the stage down to this node — the only thing a pixel sees, and the
// space the ribbon's SVG user coordinates are read in (the `.mirror-trail` wrapper adds no transform of its own).
function composed(stage: HTMLElement, id: string): Affine {
  const chain: HTMLElement[] = [];
  for (let cur: HTMLElement | null = elementFor(stage, id); cur && cur !== stage; cur = cur.parentElement) {
    chain.push(cur);
  }
  let m: Affine = [...IDENTITY] as Affine;
  for (let i = chain.length - 1; i >= 0; i--) {
    m = affineMul(m, matrixOf(chain[i]));
  }
  return m;
}

// Every point of the ribbon's centreline, ON STAGE. The gradient is `userSpaceOnUse` with its endpoints at the
// history's tail and head, so those two are what a stored point moving would show up in; the path's own extent is
// what a mixed-frame history blows up.
function ribbonEnds(stage: HTMLElement, id: string): { tail: [number, number]; head: [number, number] } | null {
  const gradient = elementFor(stage, id).querySelector(".mirror-trail linearGradient");
  const x1 = gradient?.getAttribute("x1");
  if (gradient == null || x1 == null) {
    return null; // nothing painted yet
  }
  const m = composed(stage, id);
  const toStage = (x: number, y: number): [number, number] => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5]
  ];
  return {
    tail: toStage(Number(x1), Number(gradient.getAttribute("y1"))),
    head: toStage(Number(gradient.getAttribute("x2")), Number(gradient.getAttribute("y2")))
  };
}

// The ribbon's on-stage bounding box, from its `d`. A coherent comet is bounded by the arc it was laid along; a
// history whose points are in two different spaces spans the whole stage and then some, which is the artifact.
function ribbonStageExtent(stage: HTMLElement, id: string): number {
  const d = elementFor(stage, id).querySelector(".mirror-trail path")?.getAttribute("d");
  if (!d) {
    return 0;
  }
  const m = composed(stage, id);
  const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const sx = m[0] * nums[i] + m[2] * nums[i + 1] + m[4];
    const sy = m[1] * nums[i] + m[3] * nums[i + 1] + m[5];
    minX = Math.min(minX, sx);
    maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy);
    maxY = Math.max(maxY, sy);
  }
  return Math.max(maxX - minX, maxY - minY);
}

describe("cardTrail — the teleport cut", () => {
  it("calls a jump no motion could have made a teleport, and an ordinary step not", () => {
    const points = createTrailPoints();
    expect(isTrailTeleport(points, 900, 500), "an empty history is never discontinuous").toBe(false);
    points.xy.push(900, 500);
    points.spawnMs.push(0);
    expect(isTrailTeleport(points, 940, 520), "one frame of a fast flight").toBe(false);
    expect(isTrailTeleport(points, 900 + TRAIL_TELEPORT_DIST - 1, 500), "just inside the threshold").toBe(false);
    expect(isTrailTeleport(points, 900 + TRAIL_TELEPORT_DIST + 1, 500), "past it").toBe(true);
    // …and diagonally, i.e. it is a DISTANCE and not a per-axis test.
    expect(isTrailTeleport(points, 900 + TRAIL_TELEPORT_DIST, 500 + TRAIL_TELEPORT_DIST)).toBe(true);
  });

  it("resets the history in place, so the record's arrays survive", () => {
    const points = createTrailPoints();
    const xy = points.xy;
    points.xy.push(1, 2, 3, 4);
    points.spawnMs.push(0, 16);
    resetTrailPoints(points);
    expect(points.xy, "same array object — the record holds it").toBe(xy);
    expect(points.xy.length).toBe(0);
    expect(points.spawnMs.length).toBe(0);
  });
});

describe("trail frame coherence", () => {
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
    mirrorWalkStats.reset();
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

  // The producer's stream during a flight, on the frozen-stroke shape: the comet root is re-posed along the arc
  // and NOTHING under it is re-sent. `startAt` lets a caller keep streaming after a flight has armed.
  function streamRootAlong(state: MirrorState, from: number, to: number, step: number, atMs: () => number, y = 880): void {
    const done = (x: number) => (step > 0 ? x > to : x < to);
    for (let x = from; !done(x); x += step) {
      clock = atMs();
      update(state, [...rootOnly(x, y), ...cardOnly(x, y)]);
      renderer!.reconcile(state);
    }
  }

  it("(a) a frozen stroke under a moving root keeps its laid-down points exactly where they were put", () => {
    // THE REGRESSION, in its purest form. Nothing here is driven — the walk is the only thing writing — and the
    // wire is the r13 capture's shape: the comet root sweeps, the ribbon's own transform never comes again. Before
    // the latch, the stroke's composed global WAS the root's, so the ribbon's whole user space swept with the card
    // and every point already stored swept with it: the ribbon rode the card instead of trailing it, and each walk
    // visit re-interpreted the history in a new space.
    const stage = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...comet(300, 880)]);
    renderer!.reconcile(state);

    const frameAtSeed = composed(stage, "44");
    streamRootAlong(state, 360, 660, 60, () => clock + 16);
    const early = ribbonEnds(stage, "44");
    expect(early, "the walk laid a ribbon down").not.toBeNull();

    // THE INVARIANT: the space did not move.
    for (let i = 0; i < 6; i++) {
      expect(composed(stage, "44")[i], `composed[${i}] after 300px of root travel`).toBeCloseTo(frameAtSeed[i], 9);
    }
    // …and the head is under the comet root, i.e. the ribbon is still SAMPLING the card and not merely frozen.
    const rootNow = composed(stage, "42");
    expect(early!.head[0], "the head tracks the root").toBeCloseTo(rootNow[4], 1);

    // Now move the root on and re-check the TAIL — the discriminator. A ribbon whose space rides the root
    // translates both ends together; a coherent one leaves the old point exactly where it was laid.
    streamRootAlong(state, 720, 1080, 60, () => clock + 16);
    const later = ribbonEnds(stage, "44")!;
    expect(composed(stage, "42")[4], "the root really moved on").toBeGreaterThan(rootNow[4] + 300);
    expect(Math.abs(later.tail[0] - early!.tail[0]), "the tail did not ride the root (x)").toBeLessThan(1);
    expect(Math.abs(later.tail[1] - early!.tail[1]), "the tail did not ride the root (y)").toBeLessThan(1);
    expect(later.head[0], "…while the head kept following it").toBeCloseTo(composed(stage, "42")[4], 1);
    // …and the whole ribbon stays bounded by the travel it actually recorded, not by the stage.
    expect(ribbonStageExtent(stage, "44"), "no fan").toBeLessThan(1000);
  });

  it("(b) the un-posed instantiation delta never becomes a band across the stage", () => {
    // The comet subtree arrives at the scene origin and is placed on the NEXT delta. Its first two head samples are
    // therefore (0,0) and the source pile, ~2100px apart, and `appendTrailPoint` (the game's rule, verbatim) would
    // subdivide that into a straight ribbon across the whole screen. The teleport cut drops the orphan seed.
    const stage = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...comet(0, 0)]); // instantiated, not yet placed
    renderer!.reconcile(state);
    clock += 16;
    update(state, [...rootOnly(1877, 1046), ...cardOnly(1877, 1046)]); // …and now placed, at the draw pile
    renderer!.reconcile(state);
    expect(mirrorWalkStats.trailTeleportCuts, "the jump was recognised").toBeGreaterThan(0);

    streamRootAlong(state, 1817, 1577, -60, () => clock + 16);
    const ends = ribbonEnds(stage, "44")!;
    expect(ends.tail[0], "the ribbon starts at the pile, NOT at the design origin").toBeGreaterThan(1500);
    expect(ribbonStageExtent(stage, "44"), "…so no corner-to-corner streak").toBeLessThan(600);
  });

  it("(c) a LATE arm never re-interprets the points the walk already laid down", () => {
    // The producer streams the comet for a few deltas before the hint reaches the client (the r12 flight-liveness
    // ordering). Those samples are already in the history when the drive takes over, so the drive must adopt the
    // space they are in rather than establishing the world identity as a second one.
    const stage = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...comet(300, 880)]);
    renderer!.reconcile(state);
    streamRootAlong(state, 360, 600, 60, () => clock + 16);
    const beforeArm = ribbonEnds(stage, "44");
    expect(beforeArm, "the walk got there first").not.toBeNull();
    const frameBeforeArm = composed(stage, "44");

    deliverFlight(state, hint({ start: [600, 880] }));
    renderer!.reconcile(state);
    flushRaf(clock + 16);
    expect(mirrorWalkStats.trailRootDrives, "the drive took the comet").toBe(1);

    for (let i = 0; i < 8; i++) {
      flushRaf(clock + 16);
    }
    const afterArm = ribbonEnds(stage, "44")!;
    for (let i = 0; i < 6; i++) {
      expect(composed(stage, "44")[i], `composed[${i}] across the arm`).toBeCloseTo(frameBeforeArm[i], 6);
    }
    expect(Math.abs(afterArm.tail[0] - beforeArm!.tail[0]), "the pre-arm tail did not move (x)").toBeLessThan(1);
    expect(Math.abs(afterArm.tail[1] - beforeArm!.tail[1]), "the pre-arm tail did not move (y)").toBeLessThan(1);
    expect(ribbonStageExtent(stage, "44"), "no fan across the seam").toBeLessThan(1200);
  });

  it("(d) the flight is the SOLE head sampler while it owns a ribbon", () => {
    // Two samplers, one history: the flight's integrated pose and the producer's (frozen, or merely lagging) root
    // pose are two different answers to "where is the card", and interleaving them zig-zags the ribbon between
    // them. The walk's guard used to ask whether the STROKE was a trail ROOT, which is never true — so the only
    // thing that ever hid the second sampler was the pin-skip the R14c drive happens to put over the whole comet
    // subtree. The frame invariant keeps the flight as the sole sampler.
    const stage = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...comet(300, 880)]);
    renderer!.reconcile(state);
    deliverFlight(state, hint());
    renderer!.reconcile(state);
    for (let i = 0; i < 10; i++) {
      flushRaf(clock + 16);
    }
    const flown = composed(stage, "41");
    expect(flown[4], "the card has flown well past the start anchor").toBeGreaterThan(340);

    // The producer contradicts it, twice, from far behind the flight — exactly the shape of a frozen root under a
    // card the client is already flying.
    for (let i = 0; i < 2; i++) {
      clock += 16;
      update(state, rootOnly(300 + i, 880));
      renderer!.reconcile(state);
    }
    const ends = ribbonEnds(stage, "44")!;
    expect(ends.head[0], "the head is where the FLIGHT says, not where the wire does").toBeCloseTo(flown[4], 0);
    expect(ends.tail[0], "…and the ribbon starts at the arc's own start, not at a re-visited stale pose")
      .toBeGreaterThanOrEqual(299);
    expect(mirrorWalkStats.trailTeleportCuts, "no discontinuity was introduced for the cut to clean up").toBe(0);
  });

  it("(e) pin expiry mid-paint leaves the ribbon exactly where it was painting", () => {
    // `tickTweens` releases the flight's transform pin on `windowMs`, which can (and for a short window does) land
    // while the comet is still collapsing. The walk then places the stroke again from the wire — so its placement
    // has to reproduce the space the pin was holding, or a still-visible ribbon jumps at the seam.
    const stage = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...comet(300, 880)]);
    renderer!.reconcile(state);
    deliverFlight(state, hint({ windowMs: 120 }));
    renderer!.reconcile(state);
    for (let i = 0; i < 6; i++) {
      flushRaf(clock + 16);
    }
    const pinnedFrame = composed(stage, "44");
    const pinned = ribbonEnds(stage, "44");
    expect(pinned, "a ribbon is painting").not.toBeNull();

    // Past the window: the pin drops, and the producer resumes with a pose the flight never went to.
    flushRaf(clock + 200);
    clock += 16;
    update(state, [...rootOnly(1500, 120), ...cardOnly(1500, 120)]);
    renderer!.reconcile(state);

    for (let i = 0; i < 6; i++) {
      expect(composed(stage, "44")[i], `composed[${i}] across the pin release`).toBeCloseTo(pinnedFrame[i], 6);
    }
    const after = ribbonEnds(stage, "44")!;
    expect(Math.abs(after.tail[0] - pinned!.tail[0]), "the tail held across the release").toBeLessThan(1);
    expect(Math.abs(after.tail[1] - pinned!.tail[1])).toBeLessThan(1);
  });

  it("(f) the frame is released once the history drains, so an idle trail tracks the stream again", () => {
    // The latch may not be a permanent lease: a trail whose points have all expired holds nothing that a new space
    // could move, and a comet re-used at a new pose must be free to take it. The release is on the loop, after the
    // collapse has been painted — never in the middle of a burst of samples.
    const stage = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...comet(300, 880)]);
    renderer!.reconcile(state);
    streamRootAlong(state, 360, 600, 60, () => clock + 16);
    expect(ribbonEnds(stage, "44"), "a history exists").not.toBeNull();

    // Let every point age out (TRAIL_POINT_DURATION_MS = 800), then re-pose the whole comet somewhere else.
    flushRaf(clock + 1200);
    flushRaf(clock + 16);
    clock += 16;
    update(state, [...rootOnly(1500, 300), ...cardOnly(1500, 300)]);
    renderer!.reconcile(state);
    streamRootAlong(state, 1440, 1200, -60, () => clock + 16, 300);

    const reposed = ribbonEnds(stage, "44")!;
    expect(reposed.head[0], "the re-latched ribbon samples the comet at its NEW pose").toBeGreaterThan(1100);
    expect(reposed.head[1]).toBeCloseTo(300, 0);
    expect(ribbonStageExtent(stage, "44"), "and holds nothing from the old one").toBeLessThan(600);
  });
});
