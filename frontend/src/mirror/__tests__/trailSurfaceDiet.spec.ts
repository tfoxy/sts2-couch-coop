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

// R16 — THE TRAIL-SURFACE DIET.
//
// R15 measured, on a phone, what a 3+-card flight actually costs: each comet paints TWO SVG ribbon strokes, each
// hosted in an element carrying `mix-blend-mode: plus-lighter`, so each is its own compositor render surface sized
// to the arc it paints. The per-frame compositing of those surfaces (AREA × COUNT) is the dominant term, and the
// paint-rate / band / point diets do not touch it — they make a surface cheaper to FILL, which is not the bill.
//
// The shipped policy shortens and de-blends at the fixed six-stroke boundary. It keeps both strokes, preserving
// the comet's layered read while reducing the active surface cost.
// The arming unit is LIVE STROKES and the threshold is 6 — three cards, the felt and measured onset, deliberately
// below the mass diet's 12. The FIRST test here is the one that makes the round safe: at four strokes, with every
// lever set, the rendered DOM is byte-identical to a run with the whole mechanism switched off.

type Raw = Record<string, unknown>;

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

const xf = (tx: number, ty: number) => ({
  xAxis: { x: 1, y: 0 },
  yAxis: { x: 0, y: 1 },
  origin: { x: tx, y: ty }
});

const box = { position: { x: 0, y: 0 }, size: { x: 100, y: 140 } };

// One flying card's full wire subtree: the mover, a trail root carrying the two `NCardTrail` strokes under
// `Trails`, and the decorative `Sprites` branch. Everything under the trail carries `canvasBlendMode: 1` — which
// is precisely what makes each one its own compositor surface, and therefore what `noblend` is aimed at.
function cardNodes(i: number): Raw[] {
  const t = `t${i}`;
  return [
    { id: `f${i}`, parentId: "Game", name: "VfxCardFlyShuffle", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardFlyShuffleVfx", visible: true, transform: xf(0, 0), localRect: box },
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

function hint(i: number): MirrorCardFlightHint {
  return {
    targetId: `f${i}`,
    trailId: `t${i}`,
    // A flat, purely horizontal flight: the ribbon's normals are then vertical, so a path's X coordinates ARE the
    // sampled head positions — which is what makes `bandXs` a truthful measure of the comet's length.
    start: [300, 880],
    end: [1620, 880],
    control: [960, 880],
    basis: [1, 0, 0, 1],
    speed0: 1.18,
    accel: 2.3,
    duration: 1.4,
    scale0: 1,
    windowMs: 3600,
    kind: "shuffle",
    rot0: 0
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

// Run `cards` concurrent flights for `frames` 16ms frames. Deterministic: same clock, same hints, same order.
function runShuffle(cards: number, frames: number): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
  document.body.innerHTML = "";
  clock = 0;
  rafCb = null;
  timers = [];
  const { stage, renderer } = harness();
  const state = createMirrorState();
  const nodes: Raw[] = [ROOT];
  for (let i = 0; i < cards; i++) {
    nodes.push(...cardNodes(i));
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
      cardFlights: Array.from({ length: cards }, (_, i) => hint(i))
    })!
  );
  renderer.reconcile(state);
  for (let f = 1; f <= frames; f++) {
    flushRaf(f * 16);
  }
  return { stage, renderer, state };
}

// Trails with NO card-flight hint: the strokes' own transforms stream, exactly as they do for any card whose hint
// never landed. 40ms per step so the mass diet's own 30Hz paint cap can never hide a repaint. ONE stroke per root,
// so `strokes` is literally the live-stroke count the threshold reads.
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

// Retire every flight but the first `keep` — the end of a volley: the movers go, the survivors keep flying.
function retireTo(state: MirrorState, renderer: MirrorRenderer, keep: number, total: number): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts: [],
      removedIds: Array.from({ length: total - keep }, (_, i) => `f${i + keep}`),
      orderedIds: ["Game", ...Array.from({ length: keep }, (_, i) => cardNodes(i).map((n) => n.id as string)).flat()]
    })!
  );
  renderer.reconcile(state);
}

// `refreshTrailSurfaceBlend` invalidates ids into `pendingFlightDietDirty`, which the NEXT reconcile drains — the
// same one-reconcile restyle latency the decor diet has. One empty delta is that reconcile.
function settle(state: MirrorState, renderer: MirrorRenderer): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: [] })!
  );
  renderer.reconcile(state);
}

function strokePaths(stage: HTMLElement, id: string): SVGPathElement[] {
  return [...stage.querySelectorAll(`[data-node-id="${id}"] .mirror-trail path`)] as SVGPathElement[];
}

// Every band's `d` for one stroke — the full geometry state the diet is allowed (or not) to change.
function ribbonState(stage: HTMLElement, id: string): Array<string | null> {
  return strokePaths(stage, id).map((p) => p.getAttribute("d"));
}

// The `fill-opacity` actually on the DRAWN bands — the stack a viewer sees.
function bandAlphas(stage: HTMLElement, id: string): number[] {
  return strokePaths(stage, id)
    .filter((p) => p.getAttribute("d") != null)
    .map((p) => Number(p.getAttribute("fill-opacity")));
}

// Every X coordinate in a band's path — the ribbon's extent along a horizontal flight.
function bandXs(d: string | null): number[] {
  return [...(d ?? "").matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
}

function bandSpan(stage: HTMLElement, id: string): number {
  const xs = bandXs(ribbonState(stage, id)[0]);
  return xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs);
}

function gradientStops(stage: HTMLElement, id: string): string[] {
  const el = stage.querySelector(`[data-node-id="${id}"] .mirror-trail linearGradient`);
  return [...(el?.querySelectorAll("stop") ?? [])].map(
    (s) => `${s.getAttribute("offset")}|${s.getAttribute("stop-opacity")}`
  );
}

function blendOf(stage: HTMLElement, id: string): string {
  const el = stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null;
  return el?.style.mixBlendMode ?? "<no element>";
}

const q4 = (v: number) => Math.round(v * 10000) / 10000;
const OUTER = trailProfile("OuterTrail");
const OUTER_ALPHAS = OUTER.bands.map((band) => q4(band.alpha * OUTER.baseAlpha));
const SURFACE_ALPHAS = OUTER.bands.map((band) => q4(Math.min(1, band.alpha * OUTER.baseAlpha * 1.3)));

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

describe("trail surface diet — the contract: two cards are untouched", () => {
  it("keeps the authored two-stroke comet below the boundary", () => {
    // Four strokes is two flying cards — the common case, still below the six-stroke boundary. Both ribbons keep
    // their geometry, authored alpha stack, gradient, and compositor blend.
    const { stage } = runShuffle(2, 12);
    expect(ribbonState(stage, "t0-outer"), "the outer stroke paints").toContainEqual(expect.stringContaining("M"));
    expect(ribbonState(stage, "t0-inner"), "the inner stroke paints").toContainEqual(expect.stringContaining("M"));
    expect(bandAlphas(stage, "t0-outer")).toEqual(OUTER_ALPHAS);
    expect(gradientStops(stage, "t0-outer")).not.toHaveLength(0);
    expect([blendOf(stage, "t0-outer"), blendOf(stage, "t0-inner")]).toEqual(["plus-lighter", "plus-lighter"]);
  });

});

describe("trail surface diet — the threshold is SIX strokes", () => {
  it("leaves 5 streamed strokes alone and arms on the 6th", () => {
    // The arming unit is live STROKES, not flights: a stroke costs its surface whether or not a hint ever armed a
    const five = runStreamed(5, 8);
    expect(bandAlphas(five.stage, "s0"), "five strokes: the authored outer stack").toEqual(OUTER_ALPHAS);

    const six = runStreamed(6, 8);
    expect(bandAlphas(six.stage, "s0"), "six strokes: the brightness-compensated authored stack").toEqual(
      SURFACE_ALPHAS
    );
  });

  it("arms on three flying cards", () => {
    // Three cards is six strokes, which is the felt and measured onset of the lag on a phone — and deliberately
    // below the mass diet's twelve, which only a full reshuffle reaches.
    const { stage } = runShuffle(3, 12);
    expect(bandAlphas(stage, "t0-outer")).toEqual(SURFACE_ALPHAS);
  });

  it("keeps both strokes for one flying card below the fixed boundary", () => {
    const { stage } = runShuffle(1, 12);
    expect(ribbonState(stage, "t0-outer")[0], "the lone card's comet is painted").not.toBeNull();
    expect(ribbonState(stage, "t0-inner")[0], "the inner stroke remains painted").not.toBeNull();
    expect(blendOf(stage, "t0-outer")).toBe("plus-lighter");
    expect(blendOf(stage, "t0-inner")).toBe("plus-lighter");
  });
});

describe("trail surface diet — current path", () => {
  it("three cards arm it: strokes de-blend and the comet shortens — the R16 contract amendment", () => {
    // The R11 contract said 1-3 cards look exactly as authored; R16 moves that window to 1-2 BY DECISION (the
    // measured lag onset IS three cards). This is the pin that makes the new boundary explicit: at 3 cards the
    // shipped default is ARMED — both strokes still paint (no `single`), but composite un-blended and shorter.
    // 40 frames = 640ms: past the 400ms shipped lifetime (so `short` has points to expire) and well inside the
    // fixture flight's ~1120ms safe sampling window (see the WP-A timing note).
    const armed = runShuffle(3, 40);
    settle(armed.state, armed.renderer);
    expect(blendOf(armed.stage, "t0-outer"), "outer stroke host de-blended").toBe("");
    expect(blendOf(armed.stage, "t0-inner"), "inner stroke host de-blended").toBe("");
    expect(ribbonState(armed.stage, "t0-inner")[0], "inner still paints (single is not shipped)").not.toBeNull();
  });
});

describe("trail surface diet — `short` (the surface AREA)", () => {
  it("shortens the painted arc while armed", () => {
    const armed = bandSpan(runShuffle(3, 40).stage, "t0-outer");
    expect(armed, "the shortened comet still paints").toBeGreaterThan(0);
  });

  it("grows back once the hold expires — and not one frame before", () => {
    // Both arms are the SAME lever on the SAME trajectory sampled at the SAME frame; the only difference is
    // whether the diet is still armed there. `held` keeps all three cards in the air, so the 400ms window never
    // lifts; `lifted` retires the volley at frame 6, which expires the hold at ~896ms. What the comparison
    // isolates is the lift itself, and nothing about the card's own acceleration.
    //
    // FRAME 62 (992ms) is chosen, not arbitrary. The flight's arc ends at ~704ms — phase 2 parks the mover on the
    // target and only its scale moves — so 704ms is the last head sample either arm can ever take. Sampling later
    // than ~1104ms would find the held arm's 400ms window entirely past that and its comet fully collapsed, which
    // measures the collapse rather than the lift.
    const held = runShuffle(3, 62);

    const lifted = runShuffle(3, 6);
    retireTo(lifted.state, lifted.renderer, 1, 3);
    for (let f = 7; f <= 62; f++) {
      flushRaf(f * 16);
    }

    const stillShort = bandSpan(held.stage, "t0-outer");
    expect(stillShort, "the held arm is still painting").toBeGreaterThan(0);
    // Measured 2.06× — the tail the 400ms window was cutting, handed back.
    expect(bandSpan(lifted.stage, "t0-outer") / stillShort, "the comet keeps its tail again").toBeGreaterThan(1.3);
  });

});

describe("trail surface diet — `noblend` (the surfaces themselves)", () => {
  it("de-blends the STROKE hosts and leaves the decor's blending alone", () => {
    // The orthogonality pin. R11's decor diet covers the sparkle branch and explicitly exempts the strokes; this
    // one covers exactly the strokes. Three flights is below the decor diet's own threshold of six, so the sparks
    // here are un-dieted — and stay blended, which is what makes the two id sets provably disjoint.
    const { stage, state, renderer } = runShuffle(3, 12);
    settle(state, renderer);
    expect(blendOf(stage, "t0-outer"), "the outer stroke stops being a surface").toBe("");
    expect(blendOf(stage, "t0-inner"), "…and so does the inner").toBe("");
    expect(blendOf(stage, "t0-sparks"), "the decor is not this diet's business").toBe("plus-lighter");
    expect(blendOf(stage, "t0-glint")).toBe("plus-lighter");
  });

  it("boosts every band by the fixed compensation factor, clamped at 1", () => {
    // Source-over white equals additive over black and reads dimmer over anything else; one multiplier is the
    // whole compensation, and the RMSE harness is the judge of the number.
    const { stage } = runShuffle(3, 12);
    expect(bandAlphas(stage, "t0-outer")).toEqual(
      OUTER.bands.map((band) => q4(Math.min(1, band.alpha * OUTER.baseAlpha * 1.3)))
    );
  });

  it("restores the blend when the hold expires without repainting the last gradient", () => {
    const { stage, state, renderer } = runShuffle(3, 12);
    settle(state, renderer);
    expect(blendOf(stage, "t0-outer")).toBe("");

    retireTo(state, renderer, 1, 3);
    // Past the ~992ms hold, and inside the survivor's own flight (which runs to ~1204ms) so the ribbon is still
    // being repainted when the diet lifts.
    for (let f = 13; f <= 70; f++) {
      flushRaf(f * 16);
    }
    settle(state, renderer);
    expect(blendOf(stage, "t0-outer"), "the ordinary style path put it back").toBe("plus-lighter");
    expect(bandAlphas(stage, "t0-outer"), "the last painted gradient remains until a new ribbon paint").toEqual(
      SURFACE_ALPHAS
    );
  });
});

describe("trail surface diet — composed with the mass diet", () => {
  it("collapses to two authored bands, boosted and clamped, on a de-blended stroke", () => {
    // Twelve strokes is both thresholds at once. The mass diet folds the dropped authored band into the narrower
    // survivor; the surface policy then applies its fixed brightness compensation.
    const { stage, state, renderer } = runShuffle(6, 12);
    settle(state, renderer);

    const boosted = (v: number) => q4(Math.min(1, v * 1.3));
    expect(bandAlphas(stage, "t0-outer")).toEqual([
      boosted(OUTER.bands[0].alpha * OUTER.baseAlpha),
      boosted((OUTER.bands[1].alpha + OUTER.bands[2].alpha) * OUTER.baseAlpha)
    ]);
    expect(ribbonState(stage, "t0-outer")[2], "the mass diet dropped the narrowest band").toBeNull();
    expect(ribbonState(stage, "t0-inner")[0], "the current path retains both strokes").not.toBeNull();
    expect(blendOf(stage, "t0-outer"), "…on a host that is no longer a surface").toBe("");
  });
});

describe("trail surface diet — the standing-surface gauge", () => {
  it("accumulates while strokes are live and zeroes with the window", () => {
    mirrorWalkStats.reset();
    expect(mirrorWalkStats.trailSurfaceAreaPeak, "nothing has painted yet").toBe(0);
    runShuffle(3, 20);
    expect(mirrorWalkStats.trailSurfaceAreaPeak, "three comets are standing on screen").toBeGreaterThan(0);
    mirrorWalkStats.reset();
    expect(mirrorWalkStats.trailSurfaceAreaPeak).toBe(0);
  });

  it("hands the whole standing sum back on teardown, so a later window measures only itself", () => {
    // The sum is maintained as a DELTA, which is the one way this gauge can be wrong: a stroke torn down without
    // handing its contribution back would leave a permanent floor under every later window's peak.
    const { state, renderer } = runShuffle(3, 20);
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [],
        removedIds: Array.from({ length: 3 }, (_, i) => cardNodes(i).map((n) => n.id as string)).flat(),
        orderedIds: ["Game"]
      })!
    );
    renderer.reconcile(state);

    mirrorWalkStats.reset();
    for (let f = 21; f <= 30; f++) {
      flushRaf(f * 16);
    }
    expect(mirrorWalkStats.trailSurfaceAreaPeak, "nothing is standing").toBe(0);

    // One card back, in the SAME renderer: its peak must be its own two strokes and nothing inherited.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [ROOT, ...cardNodes(100)],
        orderedIds: ["Game", ...cardNodes(100).map((n) => n.id as string)],
        cardFlights: [hint(100)]
      })!
    );
    renderer.reconcile(state);
    for (let f = 31; f <= 50; f++) {
      flushRaf(f * 16);
    }
    const lone = mirrorWalkStats.trailSurfaceAreaPeak;
    expect(lone, "the lone card really painted").toBeGreaterThan(0);

    mirrorWalkStats.reset();
    runShuffle(3, 20);
    expect(lone, "…and it is far below what three cards stand up").toBeLessThan(
      mirrorWalkStats.trailSurfaceAreaPeak / 2
    );
  });
});
