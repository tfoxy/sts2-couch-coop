import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trailProfile } from "@/mirror/cardTrail";
import {
  createMirrorRenderer,
  mirrorWalkStats,
  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorCardFlightHint,
  type MirrorState
} from "@/mirror/sceneTree";

// R11/R14b — THE MASS-FLIGHT TRAIL DIET.
//
// A 1-2 card flight keeps the authored ribbon. A 30-card discard→draw reshuffle is the other case: 60 ribbons on
// screen at once, each rebuilt and rewritten once per stroke per rAF, with a cost
// linear in (strokes × bands × points). The diet arms on 12 LIVE STROKES and degrades the trail in four bounded
// steps — point cap, band count, gradient-stop freeze, paint rate.
//
// R16 AMENDMENT TO THAT CONTRACT: the untouched window is now 1-2 CARDS. The trail-SURFACE diet (its own spec)
// ships `short,noblend` ON and arms at 6 live strokes = 3 cards — the measured onset of the compositing lag — so
// a 3-card flight is no longer pixel-identical to the authored trails BY DECISION (R16 phone matrix). THIS suite
// pins the current combined path: the mass diet's 12-stroke threshold remains unchanged, while the surface policy
// supplies its current brightness compensation from three cards onward.
//
// R14b pins the two things that were wrong with the R11 shape:
//   * it counted FLIGHTS, so a stroke painting without an armed flight hint was invisible to the threshold — on
//     the real host, where flights were being dropped, the diet never armed at all;
//   * the band collapse dropped the narrow bands' alpha on the floor, and the bands are a decomposition of ONE
//     cross-section curve, so the comet lost 87% of its brightness rather than 2/3 of its cost.
//
// The FIRST test here is the one that makes the whole round safe: below the threshold, not one line of it runs.

type Raw = Record<string, unknown>;

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

const xf = (tx: number, ty: number) => ({
  xAxis: { x: 1, y: 0 },
  yAxis: { x: 0, y: 1 },
  origin: { x: tx, y: ty }
});

const box = { position: { x: 0, y: 0 }, size: { x: 100, y: 140 } };

// One flying card's full wire subtree, in the shape a recording shows: the VFX node itself, a trail root carrying
// two `NCardTrail` strokes under `Trails`, and a decorative `Sprites` branch of particle emitters and sprites.
// Everything under the trail carries `canvasBlendMode: 1` (the additive material), which is what makes each one
// its own compositor surface.
// R13: the node that FLIES depends on the kind — a spawned VFX silhouette for a shuffle, the real played card for a
// discard — while everything under the trail root is identical either way. The diet keys on the flight COUNT.
type FlightKind = "shuffle" | "discard";

function moverNode(i: number, kind: FlightKind): Raw {
  return kind === "discard"
    ? { id: `f${i}`, parentId: "Game", name: "Card", nodeType: "NCard", visible: true, transform: xf(0, 0), localRect: box }
    : { id: `f${i}`, parentId: "Game", name: "VfxCardFlyShuffle", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardFlyShuffleVfx", visible: true, transform: xf(0, 0), localRect: box };
}

function cardNodes(i: number, kind: FlightKind = "shuffle"): Raw[] {
  const t = `t${i}`;
  return [
    moverNode(i, kind),
    { id: t, parentId: "Game", name: "CardTrailIronclad", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx", visible: true, transform: xf(0, 0) },
    { id: `${t}-Trails`, parentId: t, name: "Trails", nodeType: "Godot.Node2D", visible: true, transform: xf(0, 0) },
    { id: `${t}-outer`, parentId: `${t}-Trails`, name: "OuterTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(0, 0), canvasBlendMode: 1 },
    { id: `${t}-inner`, parentId: `${t}-Trails`, name: "InnerTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(0, 0), canvasBlendMode: 1 },
    { id: `${t}-Sprites`, parentId: t, name: "Sprites", nodeType: "Godot.Node2D", visible: true, transform: xf(0, 0) },
    {
      id: `${t}-sparks`,
      parentId: `${t}-Sprites`,
      name: "BigSparks",
      nodeType: "Godot.CpuParticles2D",
      visible: true,
      transform: xf(0, 0),
      canvasBlendMode: 1,
      particleSpec: {
        kind: "CPUParticles2D",
        amount: 64,
        lifetime: 1,
        oneShot: false,
        scaleMin: 1,
        scaleMax: 1,
        emissionShape: 0,
        texture: { resourcePath: "res://images/packed/vfx/small_card_silhouette.png", resourceType: "Texture2D", resourceName: "" },
        blendMode: 1
      },
      particleEmitting: true
    },
    { id: `${t}-glint`, parentId: `${t}-Sprites`, name: "Sprite2D2", nodeType: "Godot.Sprite2D", visible: true, transform: xf(0, 0), localRect: box, canvasBlendMode: 1 }
  ];
}

function hint(i: number, overrides: Partial<MirrorCardFlightHint> = {}, kind: FlightKind = "shuffle"): MirrorCardFlightHint {
  return {
    targetId: `f${i}`,
    trailId: `t${i}`,
    // A flat, purely horizontal flight: the ribbon's normals are then vertical, so a path's X coordinates are
    // sampled head positions and nothing else.
    start: [300, 880],
    end: [1620, 880],
    control: [960, 880],
    basis: [1, 0, 0, 1],
    speed0: 1.18,
    accel: 2.3,
    duration: 1.4,
    scale0: 1,
    windowMs: 3600,
    kind,
    rot0: kind === "discard" ? -0.35 : 0,
    ...overrides
  };
}

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

let clock = 0;
let rafCb: FrameRequestCallback | null = null;
let timers: { id: number; at: number; cb: () => void }[] = [];
let nextTimerId = 1;

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

// Run `cards` concurrent flights for `frames` 16ms frames and return the harness plus a per-stroke record of every
// `d` the renderer wrote. Deterministic: same clock, same hints, same order.
function runShuffle(
  cards: number,
  frames: number,
  kindAt: (i: number) => FlightKind = () => "shuffle"
): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
  document.body.innerHTML = "";
  clock = 0;
  rafCb = null;
  timers = [];
  const { stage, renderer } = harness();
  const state = createMirrorState();
  const nodes: Raw[] = [ROOT];
  for (let i = 0; i < cards; i++) {
    nodes.push(...cardNodes(i, kindAt(i)));
  }
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
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts: [],
      cardFlights: Array.from({ length: cards }, (_, i) => hint(i, {}, kindAt(i)))
    })!
  );
  renderer.reconcile(state);
  for (let f = 1; f <= frames; f++) {
    flushRaf(f * 16);
  }
  return { stage, renderer, state };
}

function strokePaths(stage: HTMLElement, id: string): SVGPathElement[] {
  return [...stage.querySelectorAll(`[data-node-id="${id}"] .mirror-trail path`)] as SVGPathElement[];
}

// Every band's `d` for one stroke — the full DOM state the diet is allowed (or not) to change.
function ribbonState(stage: HTMLElement, id: string): Array<string | null> {
  return strokePaths(stage, id).map((p) => p.getAttribute("d"));
}

// The `fill-opacity` actually on the DRAWN bands — the stack a viewer sees. A band the diet dropped keeps whatever
// it last carried, but it has no `d`, so it contributes nothing and is not read here.
function bandAlphas(stage: HTMLElement, id: string): number[] {
  return strokePaths(stage, id)
    .filter((p) => p.getAttribute("d") != null)
    .map((p) => Number(p.getAttribute("fill-opacity")));
}

// Every X coordinate in a band's path — the ribbon's extent along a horizontal flight.
function bandXs(d: string | null): number[] {
  return [...(d ?? "").matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
}

beforeEach(() => {
  document.body.innerHTML = "";
  clock = 0;
  rafCb = null;
  timers = [];
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
  document.body.innerHTML = "";
});

describe("trail mass diet — below its threshold", () => {
  it("keeps all three bands at six strokes, with the current surface brightness compensation", () => {
    const { stage } = runShuffle(3, 12);
    expect(ribbonState(stage, "t0-outer").filter((d) => d != null)).toHaveLength(3);
    const profile = trailProfile("OuterTrail");
    expect(bandAlphas(stage, "t0-outer")).toEqual(
      profile.bands.map((band) => Math.round(band.alpha * profile.baseAlpha * 1.3 * 10000) / 10000)
    );
  });
});

describe("trail mass diet — armed above the threshold", () => {
  it("collapses to TWO bands, and band 0 is the SAME widest band", () => {
    const light = runShuffle(3, 12);
    const widestOfThree = ribbonState(light.stage, "t0-outer")[0];

    const heavy = runShuffle(8, 12);
    const bands = ribbonState(heavy.stage, "t0-outer");
    expect(bands[0], "band 0 is the widest — the one carrying the glow read").toBe(widestOfThree);
    expect(bands[1], "…and a core band survives: one band alone is a cross-section the texture never has").not.toBeNull();
    expect(bands[2], "the third is not built at all — no geometry loop, no `d`, no write").toBeNull();
  });

  it("caps the point list below the tier's own cap, never above it", () => {
    // The `d` is one M plus (2n-1) Ls plus Z for n points, so counting commands counts points.
    const light = runShuffle(3, 40);
    const heavy = runShuffle(8, 40);
    const count = (d: string | null) => (d ?? "").split(/[ML]/).length - 1;
    const lightPoints = count(ribbonState(light.stage, "t0-outer")[0]);
    const heavyPoints = count(ribbonState(heavy.stage, "t0-outer")[0]);
    expect(heavyPoints).toBeLessThan(lightPoints);
    expect(heavyPoints / 2, "the mass cap is 16 points").toBeLessThanOrEqual(16);
  });

  it("spends those 16 points on the WHOLE arc (R14a decimation), not on its newest end", () => {
    // The budget bounds the point COUNT; the comet is still the length the card actually flew. Same flight, same
    // frame, so the dieted ribbon must span what the undieted one spans — the difference is sample density.
    const light = runShuffle(3, 40);
    const heavy = runShuffle(8, 40);
    const span = (stage: HTMLElement) => {
      const xs = bandXs(ribbonState(stage, "t0-outer")[0]);
      return { min: Math.min(...xs), max: Math.max(...xs) };
    };
    const full = span(light.stage);
    const dieted = span(heavy.stage);
    expect(dieted.min, "the tail is where the flight started").toBeCloseTo(full.min, 0);
    // The head is within ONE 30Hz window of the undieted one — that residual is the paint-rate cap (the ribbon on
    // screen is up to 33ms of card motion old), not comet the budget threw away.
    expect((dieted.max - dieted.min) / (full.max - full.min)).toBeGreaterThan(0.85);
  });

  it("freezes the along-length gradient ramp after the stroke's first paint", () => {
    const { stage, state, renderer } = runShuffle(8, 12);
    const gradient = stage.querySelector('[data-node-id="t0-outer"] .mirror-trail linearGradient')!;
    const stops = [...gradient.querySelectorAll("stop")];
    expect(stops.length, "the ramp was synced once").toBeGreaterThan(0);
    const spies = stops.map((s) => vi.spyOn(s, "setAttribute"));
    for (let f = 13; f <= 24; f++) {
      flushRaf(f * 16);
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
    void state;
    void renderer;
  });

  it("R13: the threshold does not read KINDS — six discards, and 3 + 3, arm it identically", () => {
    // Six cards is twelve strokes either way. The cost the diet exists to bound is how many ribbons are being
    // rebuilt per frame, which does not care what is on the other end of them.
    const allDiscards = runShuffle(6, 12, () => "discard");
    expect(ribbonState(allDiscards.stage, "t0-outer")[0], "the discards really painted").not.toBeNull();
    expect(ribbonState(allDiscards.stage, "t0-outer")[2], "the narrowest band is dropped").toBeNull();

    const mixed = runShuffle(6, 12, (i) => (i < 3 ? "shuffle" : "discard"));
    expect(ribbonState(mixed.stage, "t0-outer")[2], "a shuffle in the mixed batch").toBeNull();
    expect(ribbonState(mixed.stage, "t5-outer")[2], "…and a discard in the same batch").toBeNull();

    // …and the untouched-below-the-threshold contract at the top of this file holds for either kind.
    const light = runShuffle(3, 12, () => "discard");
    expect(ribbonState(light.stage, "t0-outer").filter((d) => d != null)).toHaveLength(3);
  });

  it("restores every band and every authored alpha once the hold expires", () => {
    const { stage, state, renderer } = runShuffle(8, 6);
    expect(ribbonState(stage, "t0-outer")[2]).toBeNull();

    // Retire all but two flights by removing their VFX targets — the renderer drops the flights that were driving
    // them, which is exactly what the end of a reshuffle looks like.
    const survivors = new Set(["f0", "f1"]);
    const removed = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `f${i}`).filter((id) => !survivors.has(id));
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [],
        removedIds: removed,
        orderedIds: ["Game", ...[0, 1].flatMap((i) => cardNodes(i).map((n) => n.id as string))]
      })!
    );
    renderer.reconcile(state);
    // Past the 800ms hold (see TRAIL_MASS_HOLD_MS) — the two survivors are still flying, so the ribbon is still
    // being repainted when the diet lifts.
    for (let f = 7; f <= 70; f++) {
      flushRaf(f * 16);
    }
    const bands = ribbonState(stage, "t0-outer");
    expect(bands[1], "the narrow bands are painted again").not.toBeNull();
    expect(bands[2]).not.toBeNull();
    const profile = trailProfile("OuterTrail");
    expect(bandAlphas(stage, "t0-outer"), "…at the authored per-band alphas, not the compensated ones").toEqual(
      profile.bands.map((band) => Math.round(band.alpha * profile.baseAlpha * 10000) / 10000)
    );
  });

  it("HOLDS the collapse for 800ms after the last over-threshold frame", () => {
    // Strokes expire one at a time as a reshuffle drains, so the raw count crosses the threshold repeatedly in the
    // last few hundred ms of a burst. Without the hold each crossing would be a visible re-brightening step (and a
    // rewrite of every band). The hold makes it happen once.
    const { stage, state, renderer } = runShuffle(8, 6);
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [],
        removedIds: [2, 3, 4, 5, 6, 7].map((i) => `f${i}`),
        orderedIds: ["Game", ...[0, 1].flatMap((i) => cardNodes(i).map((n) => n.id as string))]
      })!
    );
    renderer.reconcile(state);
    for (let f = 7; f <= 40; f++) {
      flushRaf(f * 16); // 640ms — under the hold
    }
    expect(ribbonState(stage, "t0-outer")[2], "still collapsed inside the hold window").toBeNull();
  });
});

// ---- R14b — the brightness half of the collapse ---------------------------------------------------------------
//
// The bands are a 3-step midpoint decomposition of ONE cross-section alpha curve, so what a point on the centre
// line ends up with is their SUM (0.784 × default_color for the outer trail). Dropping bands without their alpha
// is therefore a dimming, not a coarsening — 0.101/0.784 = 13% of the authored brightness on the R11 one-band
// rung. Compensation folds the dropped alpha into the narrowest survivor: same total, coarser staircase.

describe("trail mass diet — alpha compensation", () => {
  const OUTER = trailProfile("OuterTrail");
  const q4 = (v: number) => Math.round(v * 10000) / 10000;
  const authoredSum = OUTER.bands.reduce((sum, band) => sum + band.alpha, 0); // 0.784

  it("folds the dropped band's alpha into the narrowest KEPT band", () => {
    const { stage } = runShuffle(8, 12);
    const alphas = bandAlphas(stage, "t0-outer");
    expect(alphas, "two bands drawn, two alphas in force").toHaveLength(2);
    expect(alphas[0], "the widest band keeps its own authored share with the surface boost").toBe(q4(0.101 * OUTER.baseAlpha * 1.3));
    expect(alphas[1], "the kept core carries the dropped alpha with the surface boost").toBe(q4(0.683 * OUTER.baseAlpha * 1.3));
    expect(alphas[0] + alphas[1], "…so the stack preserves its compensated brightness").toBeCloseTo(
      authoredSum * OUTER.baseAlpha * 1.3,
      4
    );
  });

  it("writes `fill-opacity` on the state EDGES only, not once per paint", () => {
    // The attribute is a constant of (profile, band count, compensation) — R11 A0a hoisted it out of the paint
    // loop for that reason, and making it state-dependent must not put it back in.
    const { stage } = runShuffle(8, 12);
    const spies = strokePaths(stage, "t0-outer").map((p) => vi.spyOn(p, "setAttribute"));
    for (let f = 13; f <= 30; f++) {
      flushRaf(f * 16);
    }
    for (const spy of spies) {
      expect(spy.mock.calls.filter((c) => c[0] === "fill-opacity"), "the state did not change").toHaveLength(0);
      spy.mockRestore();
    }
  });
});

// ---- R14b — the threshold counts STROKES ----------------------------------------------------------------------
//
// A stroke paints whether or not a flight hint ever arrived for it: `visit` samples its head from the streamed
// parent transform, and the ribbon costs the same geometry build and the same writes either way. Keying the diet
// on `activeFlights` therefore left a whole class of load unmeasured — and on the real host, where flight hints
// were being dropped, it left the diet unarmed for the entire reshuffle it was written for.

describe("trail mass diet — armed by STROKES, not by flights", () => {
  // Trails with NO card-flight hint: the strokes' own transforms stream, exactly as they do for any card whose
  // hint never landed. Advance the clock 40ms per step so the diet's own 30Hz paint cap never hides a repaint.
  function runStreamed(strokes: number, steps: number): { stage: HTMLElement; renderer: MirrorRenderer } {
    document.body.innerHTML = "";
    clock = 0;
    rafCb = null;
    timers = [];
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const wave = (step: number): Raw[] => {
      const out: Raw[] = [];
      const x = 300 + step * 60;
      for (let i = 0; i < strokes; i++) {
        out.push(
          { id: `r${i}`, parentId: "Game", name: "CardTrailIronclad", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx", visible: true, transform: xf(x, 880) },
          { id: `s${i}`, parentId: `r${i}`, name: "OuterTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(-x, -880) }
        );
      }
      return out;
    };
    const ids = ["Game", ...wave(0).map((n) => n.id as string)];
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        upserts: [ROOT, ...wave(0)],
        orderedIds: ids
      })!
    );
    renderer.reconcile(state);
    for (let step = 1; step <= steps; step++) {
      clock = step * 40;
      applySceneDelta(
        state,
        parseSceneDelta({
          type: "scene-delta",
          full: false,
          screenType: "run",
          upserts: wave(step),
          orderedIds: ids
        })!
      );
      renderer.reconcile(state);
    }
    return { stage, renderer };
  }

  it("arms on 14 streamed strokes with not one flight in the air", () => {
    mirrorWalkStats.reset();
    const { stage } = runStreamed(14, 8);
    expect(mirrorWalkStats.flightsPeak, "no hint ever armed a flight").toBe(0);
    expect(ribbonState(stage, "s0")[0], "the streamed trails really painted").not.toBeNull();
    expect(ribbonState(stage, "s0")[2], "…and the diet collapsed them anyway").toBeNull();
    expect(mirrorWalkStats.flightDietFrames, "it was the diet that did it").toBeGreaterThan(0);
  });

  it("leaves 8 streamed strokes completely alone", () => {
    mirrorWalkStats.reset();
    const { stage } = runStreamed(8, 8);
    expect(ribbonState(stage, "s0").filter((d) => d != null), "all three authored bands").toHaveLength(3);
    expect(mirrorWalkStats.flightDietFrames).toBe(0);
  });
});

describe("trail mass diet — the paint-rate cap", () => {
  // Count the `d` writes one stroke's widest band takes over a fixed span of wall clock.
  function pathWritesOver(cards: number, spanFrames: number): number {
    const { stage } = runShuffle(cards, 12);
    const path = strokePaths(stage, "t0-outer")[0];
    const spy = vi.spyOn(path, "setAttribute");
    for (let f = 13; f <= 12 + spanFrames; f++) {
      flushRaf(f * 16);
    }
    const writes = spy.mock.calls.filter((c) => c[0] === "d").length;
    spy.mockRestore();
    return writes;
  }

  it("halves the repaint rate under a mass shuffle and leaves a light one at frame rate", () => {
    // The flight-driven paint was completely UNGATED: once per stroke per rAF. `TRAIL_REPAINT_MIN_MS` only ever
    // covered the ageing repaint in tickTrails. Under the diet it coalesces onto a ~30Hz grid, which halves the
    // geometry build, the `d` string and the attribute write all at once.
    const light = pathWritesOver(3, 12); // 192ms at 60Hz
    const heavy = pathWritesOver(8, 12);
    expect(light, "a 1-3 card flight still repaints every frame").toBeGreaterThan(8);
    expect(heavy, "…a mass shuffle repaints at ~30Hz").toBeLessThanOrEqual(8);
    expect(heavy, "…and is deferred, never dropped").toBeGreaterThan(2);
  });

  it("never lets the ribbon fall behind its own point list for more than one window", () => {
    // Deferred, never dropped: a sample the gate skipped is picked up by the animation loop's deadline, so the
    // ribbon that is finally on screen is the one the uncapped renderer would have drawn.
    const { stage } = runShuffle(8, 30);
    const before = ribbonState(stage, "t0-outer")[0];
    for (let f = 31; f <= 36; f++) {
      flushRaf(f * 16);
    }
    expect(ribbonState(stage, "t0-outer")[0], "the deferred paint landed").not.toBe(before);
  });
});

// ---- R11 C2 — the instrumentation the A/B is read off ---------------------------------------------------------
//
// Fields only. The bench reads `window.__mirrorWalkStats` defensively and ADDING a field is explicitly safe, so
// what these tests protect is the four-edit idiom itself: declared, initialised, incremented at the site, and —
// the one that is easy to get wrong — zeroed by `reset()`, because the PEAKs are high-water marks over a
// measurement window and a stale one makes every later window read as if it were shuffling too.

describe("R11 counters", () => {
  it("counts paints, path writes, peaks, diet frames and pool hits", () => {
    mirrorWalkStats.reset();
    runShuffle(8, 20);
    expect(mirrorWalkStats.trailPaints, "ribbons rebuilt").toBeGreaterThan(0);
    expect(mirrorWalkStats.trailPathWrites, "…and the `d` writes they produced").toBeGreaterThan(0);
    expect(mirrorWalkStats.trailPointsPeak, "the longest point list seen").toBeGreaterThan(1);
    expect(mirrorWalkStats.trailStrokesPeak, "16 strokes for 8 cards").toBeGreaterThan(8);
    expect(mirrorWalkStats.flightsPeak).toBe(8);
    expect(mirrorWalkStats.flightDietFrames, "the diet armed").toBeGreaterThan(0);
    expect(mirrorWalkStats.trailScaffoldAcquires, "16 strokes = 16 scaffolds").toBeGreaterThanOrEqual(16);
    expect(mirrorWalkStats.flightPlacementSeamHits, "the flight asked the placement seam").toBeGreaterThan(0);
  });

  it("leaves flightDietFrames at zero for a 1-3 card flight", () => {
    // The diet's contract, stated as a counter: below the threshold not one line of it executes.
    mirrorWalkStats.reset();
    runShuffle(3, 20);
    expect(mirrorWalkStats.flightDietFrames).toBe(0);
    expect(mirrorWalkStats.trailPaints, "…while the trails were painting the whole time").toBeGreaterThan(0);
  });

  it("zeroes every new field on reset, PEAKS included", () => {
    runShuffle(8, 20);
    mirrorWalkStats.reset();
    for (const key of [
      "trailPaints",
      "trailPathWrites",
      "trailPointsPeak",
      "trailStrokesPeak",
      "flightsPeak",
      "flightDietFrames",
      "trailScaffoldAcquires",
      "trailScaffoldReuses",
      "flightPlacementSeamHits"
    ] as const) {
      expect(mirrorWalkStats[key], key).toBe(0);
    }
  });

  it("reuses pooled scaffolds across two waves of a shuffle", () => {
    mirrorWalkStats.reset();
    const { state, renderer } = runShuffle(8, 6);
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [],
        removedIds: Array.from({ length: 8 }, (_, i) => [`f${i}`, `t${i}`, `t${i}-Trails`, `t${i}-outer`, `t${i}-inner`, `t${i}-Sprites`, `t${i}-sparks`, `t${i}-glint`]).flat(),
        orderedIds: ["Game"]
      })!
    );
    renderer.reconcile(state);
    const before = mirrorWalkStats.trailScaffoldReuses;
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [ROOT, ...Array.from({ length: 8 }, (_, i) => cardNodes(100 + i)).flat()],
        orderedIds: ["Game", ...Array.from({ length: 8 }, (_, i) => cardNodes(100 + i).map((n) => n.id as string)).flat()]
      })!
    );
    renderer.reconcile(state);
    expect(mirrorWalkStats.trailScaffoldReuses - before, "the second wave came out of the free list").toBe(16);
  });
});

// ---- R15 — the re-raster FILL proxy ---------------------------------------------------------------------------
//
// `trailPathWrites` counts `setAttribute("d")` calls: it prices the string and the attribute, and says nothing
// about how much SURFACE each one dirties — but an SVG re-raster is paid in pixels. `trailPathBboxAreaSum` is that
// missing axis: the painted ribbon's bounding box in design px², times the bands rewritten with it, accumulated
// ONLY on paints that actually rewrite geometry. It is what lets the matrix read the band collapse and the point
// cap as FILL rather than as call counts. Counter only — nothing in the render path reads it.

describe("R15 counters — the trail re-raster fill proxy", () => {
  it("accumulates painted ribbon area during a flight, and resets with the window", () => {
    mirrorWalkStats.reset();
    expect(mirrorWalkStats.trailPathBboxAreaSum, "nothing has painted yet").toBe(0);
    runShuffle(8, 20);
    expect(mirrorWalkStats.trailPaints, "the ribbons really rebuilt").toBeGreaterThan(0);
    expect(mirrorWalkStats.trailPathWrites, "…and rewrote their `d`").toBeGreaterThan(0);
    expect(mirrorWalkStats.trailPathBboxAreaSum, "so the fill proxy grew with them").toBeGreaterThan(0);
    mirrorWalkStats.reset();
    expect(mirrorWalkStats.trailPathBboxAreaSum, "…and a window reset zeroes it").toBe(0);
  });

});
