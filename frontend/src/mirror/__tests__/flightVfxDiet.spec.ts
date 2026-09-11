import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// The mass-flight trail surface policy.
//
// The GPU story of a 30-card reshuffle is compositing, and it does not appear in a JS profile at all. Each flying
// card spawns 11 nodes; six carry `canvasBlendMode: 1` → `mix-blend-mode: plus-lighter`, and every such element is
// its own compositor render surface. Combat's steady state is ~106 surfaces (42 blended); 30 cards add ~180 more
// for about a second. That is the 2.7× step change behind a 145%-busy GPU process, not the trail maths.
//
// The current path drops blending for the full flight-owned surface once enough trail strokes are active.

type Raw = Record<string, unknown>;

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

const xf = (tx: number, ty: number) => ({
  xAxis: { x: 1, y: 0 },
  yAxis: { x: 0, y: 1 },
  origin: { x: tx, y: ty }
});

const box = { position: { x: 0, y: 0 }, size: { x: 100, y: 140 } };

// R13: which node is FLYING depends on the kind — a spawned VFX silhouette for a shuffle, the real played card for
// a discard. Everything below it (the comet, the sparkle garnish) is the same subtree either way, which is the
// point: the diet keys on how many flights are in the air and never on what is flying.
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

function hint(i: number, kind: FlightKind = "shuffle"): MirrorCardFlightHint {
  return {
    targetId: `f${i}`,
    trailId: `t${i}`,
    start: [300, 880],
    end: [1620, 880],
    control: [960, 280],
    basis: [1, 0, 0, 1],
    speed0: 1.18,
    accel: 2.3,
    duration: 1.4,
    scale0: 1,
    windowMs: 3600,
    kind,
    rot0: kind === "discard" ? -0.35 : 0
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
let timers: { id: number; at: number; cb: () => void }[] = [];
let nextTimerId = 1;

function shuffle(
  cards: number,
  kindAt: (i: number) => FlightKind = () => "shuffle"
): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState; nodes: Raw[] } {
  document.body.innerHTML = "";
  clock = 0;
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
      cardFlights: Array.from({ length: cards }, (_, i) => hint(i, kindAt(i)))
    })!
  );
  renderer.reconcile(state);
  return { stage, renderer, state, nodes };
}

// `applyCardFlights` runs AFTER the walk that built the nodes, so the diet cannot arm until the NEXT reconcile.
// One frame of full-fidelity sparkle at the start of a reshuffle is the documented, accepted cost of not inventing
// a second walk pass — the fallback (arming from `state.pendingCardFlights` before the walk) is noted, not built.
function settle(state: MirrorState, renderer: MirrorRenderer): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: [] })!
  );
  renderer.reconcile(state);
}

function blendOf(stage: HTMLElement, id: string): string {
  const el = stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null;
  return el?.style.mixBlendMode ?? "<no element>";
}

function run(cards: number): { stage: HTMLElement; state: MirrorState; renderer: MirrorRenderer } {
  const h = shuffle(cards);
  settle(h.state, h.renderer);
  return h;
}

beforeEach(() => {
  document.body.innerHTML = "";
  clock = 0;
  timers = [];
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (_cb: FrameRequestCallback) => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
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

describe("flight trail surface policy", () => {
  it("drops only comet-stroke blending once three flights provide six active trail strokes", () => {
    const { stage } = run(3);
    expect(blendOf(stage, "t0-sparks")).toBe("plus-lighter");
    expect(blendOf(stage, "t0-glint")).toBe("plus-lighter");
    expect(blendOf(stage, "t0-outer")).toBe("");
  });

  it("drops the full flight-owned surface at the mass-flight threshold", () => {
    const { stage } = run(8);
    expect(blendOf(stage, "t0-sparks")).toBe("");
    expect(blendOf(stage, "t0-glint")).toBe("");
    expect(blendOf(stage, "t0-outer")).toBe("");
    expect(blendOf(stage, "t0-inner")).toBe("");
  });

  it("builds frame 0 of a flight WITHOUT the diet (applyCardFlights runs after the walk)", () => {
    // Documented ordering, not a bug: the hints are consumed after the walk that built the nodes, so the diet can
    // only arm from the next reconcile. One frame of full-fidelity sparkle at the start of a reshuffle.
    const { stage, state, renderer } = shuffle(8);
    expect(blendOf(stage, "t0-sparks"), "frame 0: still blended").toBe("plus-lighter");
    settle(state, renderer);
    expect(blendOf(stage, "t0-sparks"), "frame 1: dieted").toBe("");
  });

  it("is kind-blind for six discards and a mixed batch", () => {
    // Each flight carries two trail strokes, so either batch reaches the current six-stroke threshold.
    //
    // The fixture pairs every flight with a comet so the diet has something to act on. Whether the producer
    // actually ships a trail with a discard is its business — a trail-less flight simply gives the diet nothing to
    // do, and still counts toward the threshold for the flights that do have one.
    const allDiscards = shuffle(6, () => "discard");
    settle(allDiscards.state, allDiscards.renderer);
    expect(blendOf(allDiscards.stage, "t0-sparks"), "six discards reach the threshold").toBe("");
    expect(blendOf(allDiscards.stage, "t0-outer")).toBe("");

    const mixed = shuffle(6, (i) => (i < 3 ? "shuffle" : "discard"));
    settle(mixed.state, mixed.renderer);
    expect(blendOf(mixed.stage, "t0-sparks"), "3 + 3 reaches the same threshold").toBe("");
    expect(blendOf(mixed.stage, "t5-sparks"), "…for both halves of the batch").toBe("");

    // …and the safety contract from the top of this file is kind-blind too: three of either is untouched.
    const light = shuffle(3, () => "discard");
    settle(light.state, light.renderer);
    expect(blendOf(light.stage, "t0-sparks")).toBe("plus-lighter");
  });

  it("restores blending for free when the last flight retires", () => {
    const { stage, state, renderer } = run(8);
    expect(blendOf(stage, "t0-sparks")).toBe("");

    // Tear the flight VFX nodes down — the end of a reshuffle.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [],
        removedIds: Array.from({ length: 8 }, (_, i) => `f${i}`),
        orderedIds: ["Game", ...Array.from({ length: 8 }, (_, i) => cardNodes(i).slice(1).map((n) => n.id as string)).flat()]
      })!
    );
    renderer.reconcile(state);
    settle(state, renderer);
    expect(blendOf(stage, "t0-sparks"), "the ordinary style path put it back").toBe("plus-lighter");
  });
});
