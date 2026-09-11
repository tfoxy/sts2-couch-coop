import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { affineInverse, affineMul, type Affine } from "@/mirror/affine";
import { isCardTrailNode, isCardTrailRootNode } from "@/mirror/cardTrail";
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

// R14c — THE COMET ROOT AS A CLIENT-DRIVEN TRANSFORM CARRIER.
//
// The trail scene is `NCardTrailVfx` (root) → two inner `Node2D` groups → the two `NCardTrail` ribbon strokes on one
// side and the spark emitters / card silhouettes on the other. The root follows the flying card every frame, which
// used to mean the PRODUCER re-sent its pose ~30 times per card (measured: 23% of a reshuffle window's wire) purely
// so the descendants that stream their own world-space poses relative to it would land in the right place.
//
// This round makes the client own it. Two changes, and the specs below are split along them:
//
//   1. CLASSIFICATION (unlevered). The root gets a placement box, so its element carries the comet's matrix and the
//      walk re-bases its children against it. That is a pure re-distribution of the same on-screen matrix between a
//      parent element and its children — the first case pins it to ≤1e-6.
//
//   2. THE DRIVE (default on). Every frame of a flight writes the integrated pose onto the root,
//      through the same pin channel the card itself uses. The two ribbons are the ONE part of the comet that must
//      not ride it — their point history is a trail of places the card has BEEN — so each is counter-pinned to the
//      identity GLOBAL through the driven root, which keeps the space they are painted in world-fixed while their
//      parent moves under them.

type Raw = Record<string, unknown>;

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

const xf = (tx: number, ty: number) => ({
  xAxis: { x: 1, y: 0 },
  yAxis: { x: 0, y: 1 },
  origin: { x: tx, y: ty }
});

const box = { position: { x: 0, y: 0 }, size: { x: 100, y: 140 } };

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

// The real subtree shape: the root carries the comet's world pose and each inner group counter-marches it, so every
// LEAF below streams world-space coordinates. That counter
// march is why the classification change has to be exactly neutral — it composes into the leaves' globals either
// way, and the only question is which element carries which part of the product.
function trailNodes(x: number, y: number): Raw[] {
  return [
    { id: "41", parentId: "Game", name: "VfxCardFlyShuffle", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardFlyShuffleVfx", visible: true, transform: xf(x, y), localRect: box },
    { id: "42", parentId: "Game", name: "CardTrailIronclad", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx", visible: true, transform: xf(x, y) },
    { id: "43", parentId: "42", name: "Trails", nodeType: "Godot.Node2D", visible: true, transform: xf(-x, -y) },
    { id: "44", parentId: "43", name: "OuterTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(0, 0) },
    { id: "45", parentId: "43", name: "InnerTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(0, 0) },
    { id: "46", parentId: "42", name: "Sprites", nodeType: "Godot.Node2D", visible: true, transform: xf(-x, -y) },
    // A streamed leaf in that world space — the silhouette that trails the card. Its own global is the world point
    // it is drawn at, whatever the root is doing.
    { id: "47", parentId: "46", name: "Silhouette", nodeType: "Godot.Sprite2D", visible: true, transform: xf(x - 40, y - 25), localRect: box }
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

// The element's ON-SCREEN matrix: the product of every transform down the DOM chain from the stage. This is the
// only thing a pixel sees, and it is what the parity case compares — the nested DOM moves the SAME product between
// a parent element and its children, so "composed" is the invariant even when the individual matrices change.
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

function expectMatrixClose(actual: Affine, expected: Affine, label: string, eps = 1e-6): void {
  for (let i = 0; i < 6; i++) {
    expect(Math.abs(actual[i] - expected[i]), `${label}[${i}]: ${actual[i]} vs ${expected[i]}`).toBeLessThanOrEqual(eps);
  }
}

// The ribbon's CENTRELINE ends, mapped onto the stage. The gradient is `userSpaceOnUse` with its endpoints set to
// the ribbon's tail (x1,y1) and head (x2,y2) — the two sampled points themselves, with none of the ±normal
// half-width offsets the band polygons carry (those move as the trail grows, the centreline does not). The
// `.mirror-trail` wrapper adds no transform, so user space IS the stroke element's local space and the element's
// composed matrix is what turns these into stage coordinates.
function ribbonEnds(
  stage: HTMLElement,
  id: string
): { tail: [number, number]; head: [number, number] } | null {
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

describe("trailRootDrive — the comet root is a transform carrier (classification)", () => {
  let renderer: MirrorRenderer | null = null;

  function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
    const stage = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(defs);
    document.body.append(stage, svg);
    renderer = createMirrorRenderer(stage, defs);
    return { stage, renderer };
  }

  afterEach(() => {
    renderer?.dispose();
    renderer = null;
    document.body.innerHTML = "";
  });

  it("names the root by its type LEAF, and never confuses it with a stroke", () => {
    expect(isCardTrailRootNode({ nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx" })).toBe(true);
    expect(isCardTrailRootNode({ nodeType: "NCardTrailVfx" }), "a bare type reads the same").toBe(true);
    expect(isCardTrailRootNode({ nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail" }), "not a stroke").toBe(false);
    expect(isCardTrailRootNode({ nodeType: "Godot.Node2D" })).toBe(false);
    expect(isCardTrailRootNode({ nodeType: "" }), "an unnamed type is not a comet").toBe(false);
    expect(isCardTrailRootNode({ nodeType: "XNCardTrailVfx" }), "leaf match, not a suffix match").toBe(false);
    // …and the stroke predicate still refuses the root, which is what keeps the two roles apart everywhere else.
    expect(isCardTrailNode({ nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx" })).toBe(false);
  });

  it("(a) carries the comet's matrix on its own element — and every descendant's composed geometry is unchanged", () => {
    // THE PARITY CASE. Before this round the root had no box: its element carried no transform and each descendant
    // was placed at its OWN global, re-based against the frame above the root. Now the root carries that matrix and
    // the descendants are re-based against IT. The product down the DOM chain — the only thing a pixel sees — must
    // be bit-for-bit the same, i.e. every node still composes to `nodeMatrix(its own global, its own box origin)`,
    // which for this fixture (all boxes at local 0,0) IS its own global. ≤1e-6 across the whole subtree.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...trailNodes(700, 400)]);
    renderer.reconcile(state);

    // The classification itself: the root now carries a transform, and it is the comet's own global.
    expectMatrixClose(matrixOf(elementFor(stage, "42")), [1, 0, 0, 1, 700, 400], "the root's element");

    // …and the composed geometry of every node that PLACES is its own global, exactly as before the change. (The
    // two inner groups place nothing: a boxless node carries no matrix of its own in either arrangement, so it has
    // no geometry to compare — it simply hands its frame down, which is what the two assertions below say.)
    expectMatrixClose(composed(stage, "42"), [1, 0, 0, 1, 700, 400], "root composed");
    expectMatrixClose(composed(stage, "43"), composed(stage, "42"), "the Trails group adds nothing of its own");
    expectMatrixClose(composed(stage, "46"), composed(stage, "42"), "the Sprites group adds nothing of its own");
    expectMatrixClose(composed(stage, "44"), IDENTITY, "the outer stroke composed");
    expectMatrixClose(composed(stage, "45"), IDENTITY, "the inner stroke composed");
    expectMatrixClose(composed(stage, "47"), [1, 0, 0, 1, 660, 375], "the streamed silhouette composed");

    // Move the whole comet on the wire and re-check: the counter-marching groups keep every leaf world-placed, so
    // the invariant has to hold at more than one pose.
    update(state, trailNodes(1100, 250));
    renderer.reconcile(state);
    expectMatrixClose(matrixOf(elementFor(stage, "42")), [1, 0, 0, 1, 1100, 250], "the root's element (moved)");
    expectMatrixClose(composed(stage, "44"), IDENTITY, "the outer stroke composed (moved)");
    expectMatrixClose(composed(stage, "47"), [1, 0, 0, 1, 1060, 225], "the silhouette composed (moved)");
  });
});

describe("trailRootDrive — the flight drives the root", () => {
  let clock = 0;
  let rafCb: FrameRequestCallback | null = null;
  let timers: { id: number; at: number; cb: () => void }[] = [];
  let nextTimerId = 1;
  let renderer: MirrorRenderer | null = null;
  const realAnimate = (Element.prototype as unknown as { animate?: unknown }).animate;

  // jsdom has no `Element.animate`, so the compositor path is only reachable with a recording stub. Its ABSENCE is
  // the stepped-integrator path — both are exercised below, because both write the root.
  function installAnimate(): void {
    (Element.prototype as unknown as { animate: unknown }).animate = function () {
      return { currentTime: 0, cancel() {}, onfinish: null };
    };
  }

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

  // The renderer's loop is deadline-scheduled: a setTimeout park, then the rAF that mutates. Both halves run against
  // the same fake clock (the cardFlight.spec / flightLiveness.spec harness).
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

  function arm(h = hint()): { stage: HTMLElement; state: MirrorState } {
    const stage = harness();
    const state = createMirrorState();
    seed(state, [ROOT, ...trailNodes(300, 880)]);
    renderer!.reconcile(state);
    deliverFlight(state, h);
    renderer!.reconcile(state);
    return { stage, state };
  }

  // The scale a matrix's 2x2 applies (uniform for every basis this fixture uses) and the angle it rotates by.
  const scaleOf = (m: Affine) => Math.hypot(m[0], m[1]);
  const angleOf = (m: Affine) => Math.atan2(m[1], m[0]);

  it("(b) writes basis · R(rotation) at the pose — rotation YES, the flight's scale NO", () => {
    // The comet has no size of its own and the ribbons carry their authored widths, so the card's pop/shrink is the
    // CARD's alone: folding it into the root would breathe the whole trail (sparks, silhouettes) in and out. A
    // discard is the sharp case — its arc shrinks the card to a tenth within the first third — so the two matrices
    // are compared while they visibly disagree about scale but must still agree about angle and position.
    const { stage } = arm(hint({ kind: "discard", basis: [2, 0, 0, 2], rot0: 0.4 }));
    for (let t = 16; t <= 320; t += 16) {
      flushRaf(t);
    }
    const card = matrixOf(elementFor(stage, "41"));
    const root = matrixOf(elementFor(stage, "42"));

    expect(scaleOf(root), "the root keeps the hint's basis scale — no pop, no shrink").toBeCloseTo(2, 9);
    expect(scaleOf(card), "…while the card itself has visibly shrunk").toBeLessThan(2 * 0.9);
    expect(Math.abs(angleOf(root)), "the rotation IS carried").toBeGreaterThan(0.01);
    expect(angleOf(root), "…and it is the card's own angle").toBeCloseTo(angleOf(card), 9);
    expect(root[4], "the comet sits exactly on the card (x)").toBeCloseTo(card[4], 9);
    expect(root[5], "the comet sits exactly on the card (y)").toBeCloseTo(card[5], 9);
  });

  it("(c) drives the root on the COMPOSITOR path, where the card itself is not written per frame", () => {
    // On this path the browser owns the card's element (a WAAPI keyframe list), so the root is the only thing the
    // per-frame step writes — and it is written from the SAME closed form the keyframes were baked from.
    installAnimate();
    const { stage } = arm();
    expect(mirrorWalkStats.flightCssAnimStarted, "the compositor took the flight").toBe(1);

    const at0 = matrixOf(elementFor(stage, "42"));
    expect(at0[4], "frame 0 places the comet at the flight's start anchor").toBeCloseTo(300, 3);
    expect(at0[5]).toBeCloseTo(880, 3);

    for (let t = 16; t <= 320; t += 16) {
      flushRaf(t);
    }
    const at320 = matrixOf(elementFor(stage, "42"));
    expect(at320[4], "…and keeps moving it along the arc").toBeGreaterThan(at0[4] + 20);
    expect(at320[5], "…which bows upward (smaller y)").toBeLessThan(at0[5]);
    expect(mirrorWalkStats.trailRootDrives, "counted once for the flight, not once per frame").toBe(1);
    expect(mirrorWalkStats.flightSteps, "the per-frame step really ran").toBeGreaterThan(10);
  });

  it("(d) drives the root on the STREAMED-FALLBACK path, in lockstep with the card", () => {
    // No `Element.animate` here: the stepped integrator writes both elements, so the invariant is the strongest one
    // available — the comet root is exactly where the card is, every frame.
    const { stage } = arm();
    expect(mirrorWalkStats.flightCssAnimStarted, "no compositor — the stepped path").toBe(0);
    for (let t = 16; t <= 480; t += 16) {
      flushRaf(t);
      const card = matrixOf(elementFor(stage, "41"));
      const root = matrixOf(elementFor(stage, "42"));
      expect(root[4], `x at ${t}ms`).toBeCloseTo(card[4], 9);
      expect(root[5], `y at ${t}ms`).toBeCloseTo(card[5], 9);
    }
    expect(mirrorWalkStats.trailRootDrives).toBe(1);
  });

  it("(e) counter-pins each stroke to the identity GLOBAL, and dedups to one write while the pose holds", () => {
    // The counter-pin's contract is about the COMPOSED frame: whatever the root is doing, the space the ribbon is
    // painted in stays the world identity. The pin value is therefore the root's own inverse — which is a write per
    // frame while the card moves (a world-fixed child of a moving parent IS a counter-transform), and exactly ONE
    // write while it doesn't. The degenerate hint below (start == end == control) holds the pose still to prove the
    // second half; the moving case is the first half of this test and (f) below.
    const { stage } = arm();
    for (let t = 16; t <= 160; t += 16) {
      flushRaf(t);
    }
    const root = matrixOf(elementFor(stage, "42"));
    expect(root[4], "the root has moved off the start anchor").toBeGreaterThan(300);
    for (const stroke of ["44", "45"]) {
      const pinned = matrixOf(elementFor(stage, stroke));
      expectMatrixClose(pinned, affineInverse(root)!, `stroke ${stroke} is pinned to the root's inverse`);
      expectMatrixClose(composed(stage, stroke), IDENTITY, `stroke ${stroke} composes to the world identity`);
    }

    // …and the dedup: a still pose re-derives the identical string, so the element is written once and no more.
    document.body.innerHTML = "";
    renderer?.dispose();
    clock = 0;
    const still = arm(hint({ start: [640, 500], end: [640, 500], control: [640, 500] }));
    flushRaf(16);
    const strokeEl = elementFor(still.stage, "44");
    let writes = 0;
    const observer = new MutationObserver((records) => {
      writes += records.length;
    });
    observer.observe(strokeEl, { attributes: true, attributeFilter: ["style"] });
    for (let t = 32; t <= 160; t += 16) {
      flushRaf(t);
    }
    observer.takeRecords();
    observer.disconnect();
    expect(writes, "a constant pose re-derives a constant pin — the style cache absorbs it").toBe(0);
  });

  it("(f) keeps the synthesized ribbon WORLD-stable while the root moves under it", () => {
    // THE FAILURE THIS EXISTS FOR: pin the strokes to a constant element transform instead of the root's inverse and
    // the whole point history rides the card — the comet collapses onto the card it is supposed to trail behind. So
    // the assertion is made in STAGE coordinates: a point already laid down must not move when the root does.
    const { stage } = arm();
    for (let t = 16; t <= 200; t += 16) {
      flushRaf(t);
    }
    const early = ribbonEnds(stage, "44");
    expect(early, "the ribbon has been laid down").not.toBeNull();
    const cardEarly = matrixOf(elementFor(stage, "41"));
    expect(early!.head[0], "the head is under the card").toBeCloseTo(cardEarly[4], 1);
    expect(early!.head[1]).toBeCloseTo(cardEarly[5], 1);

    for (let t = 216; t <= 400; t += 16) {
      flushRaf(t);
    }
    const later = ribbonEnds(stage, "44")!;
    const cardLater = matrixOf(elementFor(stage, "41"));
    const rootMoved = cardLater[4] - cardEarly[4];
    expect(rootMoved, "the card (and the root under it) really moved on").toBeGreaterThan(40);
    // THE DISCRIMINATOR. The head follows the card; the TAIL — a point laid down frames ago — stays exactly where
    // it was put. A ribbon riding its parent would translate BOTH ends by `rootMoved`.
    expect(later.head[0], "the new head is under the card again").toBeCloseTo(cardLater[4], 1);
    expect(Math.abs(later.tail[0] - early!.tail[0]), "the tail did not ride the root").toBeLessThan(1);
    expect(Math.abs(later.tail[1] - early!.tail[1])).toBeLessThan(1);
  });

  it("(g) releases root and strokes when the producer's window closes, and streamed placement lands again", () => {
    // The drive borrows the ordinary pin channel, so the release is the ordinary one: past `windowMs` the pin is
    // dropped and the next streamed pose for the root (or a stroke) is written by the walk like any other node's.
    const { stage, state } = arm(hint({ windowMs: 120 }));
    flushRaf(16);
    expect(matrixOf(elementFor(stage, "42"))[4], "driven while the window is open").toBeGreaterThan(300);

    for (let t = 32; t <= 400; t += 16) {
      flushRaf(t);
    }
    // The producer resumes: a fresh pose for the whole comet, at a place the flight never went.
    update(state, trailNodes(1500, 120));
    renderer!.reconcile(state);
    expectMatrixClose(matrixOf(elementFor(stage, "42")), [1, 0, 0, 1, 1500, 120], "the root took the streamed pose");
    expectMatrixClose(composed(stage, "44"), IDENTITY, "and the stroke is world-placed by the wire again");
  });

});
