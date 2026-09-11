import { afterEach, describe, expect, it, vi } from "vitest";

import { trailProfile } from "@/mirror/cardTrail";
import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// R11 B2 — THE TRAIL SCAFFOLD POOL.
//
// Every trail stroke needs the same tree: `div.mirror-trail > svg > (defs > linearGradient) + N paths`, plus the
// gradient's `<stop>`s. That is ~10 elements, and a 30-card reshuffle builds and destroys SIXTY of them inside
// about a second — ~600 element creations and their garbage, in the window the main thread has least to spare.
// They differ only in the gradient's id and in what is written into them, so a released one is reusable verbatim.
//
// This suite is about the INVARIANTS, because that is where a pool goes wrong: a reused scaffold must be as blank
// as a fresh one, must re-resolve its profile, must never be handed out twice, and must not become an unbounded
// hold on detached DOM.

type Raw = Record<string, unknown>;

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

const xf = (tx: number, ty: number) => ({
  xAxis: { x: 1, y: 0 },
  yAxis: { x: 0, y: 1 },
  origin: { x: tx, y: ty }
});

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

// One trail stroke's nodes: a root carrying the card's position, and a stroke pinned back to world space.
function strokeNodes(i: number, name = "OuterTrail", x = 400, y = 300): Raw[] {
  return [
    { id: `r${i}`, parentId: "Game", name: "CardTrailIronclad", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrailVfx", visible: true, transform: xf(x, y) },
    { id: `s${i}`, parentId: `r${i}`, name, nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true, transform: xf(-x, -y) }
  ];
}

function show(state: MirrorState, renderer: MirrorRenderer, nodes: Raw[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts: nodes,
      orderedIds: ["Game", ...nodes.map((n) => n.id as string)]
    })!
  );
  renderer.reconcile(state);
}

function seed(state: MirrorState, renderer: MirrorRenderer): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: [ROOT],
      orderedIds: ["Game"]
    })!
  );
  renderer.reconcile(state);
}

function svgCreates(): { count: () => number; restore: () => void } {
  const spy = vi.spyOn(document, "createElementNS");
  return {
    count: () => spy.mock.calls.filter((c) => c[1] === "svg").length,
    restore: () => spy.mockRestore()
  };
}

function gradientIds(stage: HTMLElement): string[] {
  return [...stage.querySelectorAll(".mirror-trail linearGradient")].map((g) => g.getAttribute("id") ?? "");
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("trailPool — reuse", () => {
  it("builds no new scaffolding for the second wave of trails", () => {
    // Eight, i.e. a mass shuffle — which is both the case the pool exists for and the case where every removal
    // takes the immediate teardown path. A handful of strokes torn down at once are CONDEMNED for adoption
    // instead, and a condemned record keeps its scaffold until `sweepCondemned` runs at the end of the reconcile;
    // see the ordering note on releaseTrailScaffold.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    seed(state, renderer);

    const first: Raw[] = [];
    for (let i = 0; i < 8; i++) {
      first.push(...strokeNodes(i));
    }
    show(state, renderer, first);
    expect(stage.querySelectorAll(".mirror-trail")).toHaveLength(8);

    // Tear them all down…
    show(state, renderer, []);
    expect(stage.querySelectorAll(".mirror-trail")).toHaveLength(0);

    // …and build eight more. Nothing should be constructed.
    const spy = svgCreates();
    const second: Raw[] = [];
    for (let i = 10; i < 18; i++) {
      second.push(...strokeNodes(i));
    }
    show(state, renderer, second);
    expect(stage.querySelectorAll(".mirror-trail")).toHaveLength(8);
    expect(spy.count(), "every scaffold came out of the pool").toBe(0);
    spy.restore();
  });

  it("hands a reused scaffold out blank — no stale ribbon from the previous card", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    seed(state, renderer);

    const wave = (base: number, x = 400): Raw[] => {
      const nodes: Raw[] = [];
      for (let i = 0; i < 8; i++) {
        nodes.push(...strokeNodes(base + i, "OuterTrail", x, 300));
      }
      return nodes;
    };
    show(state, renderer, wave(0));
    for (let step = 1; step <= 4; step++) {
      show(state, renderer, wave(0, 400 + step * 60));
    }
    const painted = stage.querySelector('[data-node-id="s0"] .mirror-trail path')!.getAttribute("d");
    expect(painted, "the first trails really drew something").not.toBeNull();

    show(state, renderer, []);
    show(state, renderer, wave(100));
    const fresh = stage.querySelector('[data-node-id="s100"] .mirror-trail path')!.getAttribute("d");
    expect(fresh, "a comet stretching back to the last card's path would be the pool bug").toBeNull();
  });

  it("re-resolves the profile when a scaffold crosses from outer to inner", () => {
    // Outer and inner carry different authored band alphas AND different band widths. A pooled scaffold that kept
    // the previous profile's `fill-opacity` would render the wrong trail — this is the invariant the pre-pool
    // re-resolve existed for, and it has to survive pooling.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    seed(state, renderer);

    const wave = (base: number, name: string): Raw[] => {
      const nodes: Raw[] = [];
      for (let i = 0; i < 8; i++) {
        nodes.push(...strokeNodes(base + i, name));
      }
      return nodes;
    };
    show(state, renderer, wave(0, "OuterTrail"));
    const outerAlphas = [...stage.querySelectorAll('[data-node-id="s0"] .mirror-trail path')].map((p) =>
      p.getAttribute("fill-opacity")
    );
    show(state, renderer, []);
    show(state, renderer, wave(100, "InnerTrail"));
    const innerAlphas = [...stage.querySelectorAll('[data-node-id="s100"] .mirror-trail path')].map((p) =>
      p.getAttribute("fill-opacity")
    );

    expect(outerAlphas.every((a) => a != null)).toBe(true);
    expect(innerAlphas.every((a) => a != null)).toBe(true);
    expect(innerAlphas, "the reused paths carry the NEW profile's band alphas").not.toEqual(outerAlphas);
  });
});

describe("trailPool — R14b: a scaffold must not carry the mass diet's alpha to its next user", () => {
  it("hands a scaffold released while the diet was armed back at AUTHORED opacity", () => {
    // The diet's collapsed stack folds the dropped bands' alpha into the narrowest survivor, so a scaffold
    // released mid-reshuffle reaches the free list carrying alphas no unarmed trail should ever paint with. The
    // acquire path's `fill-opacity` state tag is what catches it (see trailBandOpacityTag) — without it, a lone
    // discard flying after a reshuffle would draw itself with a reshuffle's compensated core.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { stage, renderer } = harness();
    const state = createMirrorState();
    seed(state, renderer);

    const wave = (base: number, count: number, x: number): Raw[] => {
      const nodes: Raw[] = [];
      for (let i = 0; i < count; i++) {
        nodes.push(...strokeNodes(base + i, "OuterTrail", x, 300));
      }
      return nodes;
    };
    const alphasOf = (id: string) =>
      [...stage.querySelectorAll(`[data-node-id="${id}"] .mirror-trail path`)].map((p) => ({
        drawn: p.getAttribute("d") != null,
        alpha: Number(p.getAttribute("fill-opacity"))
      }));

    // 14 strokes — over the 12-stroke threshold, so the diet is armed and the stack is compensated.
    for (let step = 0; step <= 4; step++) {
      clock = step * 40; // past the diet's 30Hz paint gate, so every step really repaints
      show(state, renderer, wave(0, 14, 400 + step * 60));
    }
    const profile = trailProfile("OuterTrail");
    const q4 = (v: number) => Math.round(v * 10000) / 10000;
    const armed = alphasOf("s0");
    expect(armed.filter((band) => band.drawn).map((band) => band.alpha), "the collapsed stack includes the current surface boost").toEqual([
      q4(0.101 * profile.baseAlpha * 1.3),
      q4(0.683 * profile.baseAlpha * 1.3)
    ]);

    // Tear them down: their scaffolds reach the pool with those alphas still on the paths…
    show(state, renderer, []);

    // …and a later, SMALL wave — past the diet's 800ms hold — reuses them.
    clock = 4000;
    const spy = svgCreates();
    for (let step = 0; step <= 4; step++) {
      clock = 4000 + step * 40;
      show(state, renderer, wave(100, 4, 400 + step * 60));
    }
    expect(spy.count(), "the second wave really came out of the pool").toBe(0);
    spy.restore();
    expect(
      alphasOf("s100").map((band) => band.alpha),
      "every band back at the authored profile"
    ).toEqual(profile.bands.map((band) => q4(band.alpha * profile.baseAlpha)));
    expect(alphasOf("s100").every((band) => band.drawn), "…and all three are drawn again").toBe(true);
  });
});

describe("trailPool — invariants", () => {
  it("never hands the same scaffold to two live trails", () => {
    // Every path's `fill` points at its own scaffold's gradient by id, so two live trails sharing one would paint
    // through the same ramp. Distinct ids across the live set is the observable form of "handed out once".
    const { stage, renderer } = harness();
    const state = createMirrorState();
    seed(state, renderer);

    for (let wave = 0; wave < 5; wave++) {
      const nodes: Raw[] = [];
      for (let i = 0; i < 6; i++) {
        nodes.push(...strokeNodes(wave * 10 + i));
      }
      show(state, renderer, nodes);
      const ids = gradientIds(stage);
      expect(ids).toHaveLength(6);
      expect(new Set(ids).size, `wave ${wave}: every live trail owns its own gradient`).toBe(6);
      show(state, renderer, []);
    }
  });

  it("bounds the free list — a huge wave does not leave unbounded detached DOM behind", () => {
    // 100 trails torn down at once can only file TRAIL_POOL_MAX (64) scaffolds; the next 100 therefore have to
    // build the remainder. If the cap were missing, the second wave would construct nothing at all.
    const { renderer } = harness();
    const state = createMirrorState();
    seed(state, renderer);

    const wave = (base: number): Raw[] => {
      const nodes: Raw[] = [];
      for (let i = 0; i < 100; i++) {
        nodes.push(...strokeNodes(base + i));
      }
      return nodes;
    };

    show(state, renderer, wave(0));
    show(state, renderer, []);

    const spy = svgCreates();
    show(state, renderer, wave(1000));
    const built = spy.count();
    spy.restore();
    expect(built, "100 wanted, at most 64 pooled").toBe(36);
  });
});
