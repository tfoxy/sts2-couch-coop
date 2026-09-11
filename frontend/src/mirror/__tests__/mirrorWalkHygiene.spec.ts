import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,




  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import { __resetAtlasCacheForTest } from "@/mirror/atlasBaker";
import type { LoadedSpineClip } from "@/mirror/spineClip";

// R10-PERF4 WS-3 — WALK & STYLE HYGIENE, items 2 and 3.
//
//   • item 2: applyTipScalePass is gated on the geometry epoch, so a tooltip that isn't
//     moving costs nothing per reconcile instead of a full re-measure + transform re-write.
//   • item 3: a hidden subtree is built on reveal, including its paint sub-layers.
//
// The reveal MECHANISM is what these specs pin, not just the outcome: an ancestor's visible flip must produce a
// childCtx that fails BOTH identity tests, so every descendant re-visits — including across the pin skip and the
// recurse-only fast path, the two paths that exist precisely to NOT re-visit a clean node.

const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

type Raw = Record<string, unknown>;

const rect = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });
const xf = (tx: number, ty: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function full(state: MirrorState, nodes: Raw[]): void {
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
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

function hintsOnly(state: MirrorState, hints: unknown[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", hints })!);
}

function el(stage: HTMLElement, id: string): HTMLElement {
  const found = stage.querySelector(`[data-node-id="${id}"]`);
  expect(found, `element ${id}`).not.toBeNull();
  return found as HTMLElement;
}

// --- the dialog scene ------------------------------------------------------------------------------------------
//
// Game
//  ├─ Combat            (always visible — the control group: its sub-layers must be built either way)
//  │   └─ CombatIcon    (atlas sprite)
//  └─ Deck              (the DIALOG — `visible` flips)
//      ├─ Inner         (an interior group, so the flip has to CASCADE two levels)
//      │   ├─ DeckIcon      (atlas sprite)
//      │   ├─ DeckShader    (WebGL shader node → data-godot-shader-* markers + .mirror-shader-self)
//      │   └─ DeckParticles (particle node → data-godot-particle-* markers + .mirror-particle-self)
//      └─ DeckSpine     (spine clip node → <canvas class="mirror-spine-canvas">)

function atlasSprite(id: string, parentId: string, x: number): Raw {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Sprite2D",
    visible: true,
    transform: xf(x, 100),
    localRect: rect(0, 0, 48, 48),
    texture: { resourcePath: "res://images/atlas.png", resourceType: "Texture2D" },
    textureRegion: { position: { x: 4, y: 8 }, size: { x: 48, y: 48 } }
  };
}

function shaderSprite(id: string, parentId: string): Raw {
  return {
    id,
    parentId,
    name: id,
    nodeType: "TextureRect",
    visible: true,
    transform: xf(400, 200),
    localRect: rect(0, 0, 200, 280),
    texture: { resourcePath: "res://images/card.png", resourceType: "Texture2D" },
    shader: { resourcePath: "res://shaders/card_ripple.gdshader", resourceType: "Shader" },
    shaderParameters: [{ name: "strength", kind: "number", number: 0.5 }]
  };
}

function particleEmitter(id: string, parentId: string): Raw {
  return {
    id,
    parentId,
    name: id,
    nodeType: "GPUParticles2D",
    visible: true,
    transform: xf(320, 540),
    particleSpec: {
      kind: "GPUParticles2D",
      amount: 4,
      lifetime: 2,
      oneShot: false,
      scaleMin: 1,
      scaleMax: 1,
      emissionShape: 0,
      texture: { resourcePath: "res://images/vfx/glow.png", resourceType: "Texture2D", resourceName: "" }
    }
  };
}

function spineSprite(id: string, parentId: string): Raw {
  return {
    id,
    parentId,
    name: "SpineSprite",
    nodeType: "SpineSprite",
    visible: true,
    transform: xf(960, 540),
    spine: {
      sceneResPath: "res://scenes/merchant/characters/ironclad_merchant.tscn",
      nodePath: "Visuals/SpineSprite",
      animations: ["idle_loop"]
    },
    spineCurrentAnim: "idle_loop",
    spineTrackTime: 0
  };
}

function scene(deckVisible: boolean): Raw[] {
  return [
    { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true },
    { id: "Combat", parentId: "Game", name: "Combat", nodeType: "Godot.Control", visible: true },
    atlasSprite("CombatIcon", "Combat", 100),
    { id: "Deck", parentId: "Game", name: "Deck", nodeType: "Godot.Control", visible: deckVisible },
    { id: "Inner", parentId: "Deck", name: "Inner", nodeType: "Godot.Control", visible: true },
    atlasSprite("DeckIcon", "Inner", 600),
    shaderSprite("DeckShader", "Inner"),
    particleEmitter("DeckParticles", "Inner"),
    spineSprite("DeckSpine", "Deck")
  ];
}

function spineCanvases(stage: HTMLElement): number {
  return stage.querySelectorAll("canvas.mirror-spine-canvas").length;
}

beforeEach(() => {
  document.body.innerHTML = "";
  // Stage C's current atlas placeholder is a page-crop div.
  __resetAtlasCacheForTest();
  loadSpineClipMock.mockReset();
  loadSpineClipMock.mockReturnValue(new Promise<LoadedSpineClip>(() => {})); // never resolves — no async paint
});

describe("R10-PERF4 WS-3 item 3 — hidden subtree reveal", () => {
  it("keeps a hidden dialog out of the DOM while rendering its visible sibling", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, scene(false));
    renderer.reconcile(state);

    expect(el(stage, "CombatIcon").querySelector(".mirror-atlas-page")).not.toBeNull();
    expect(stage.querySelector('[data-node-id="Deck"]')).toBeNull();
    expect(stage.querySelector('[data-node-id="DeckIcon"]')).toBeNull();
  });

  it("REVEAL: flipping the dialog visible builds every current paint layer", () => {
    // Deferred build → reveal.
    const lazy = harness();
    const lazyState = createMirrorState();
    full(lazyState, scene(false));
    lazy.renderer.reconcile(lazyState);
    update(lazyState, [{ id: "Deck", parentId: "Game", name: "Deck", nodeType: "Godot.Control", visible: true }]);
    lazy.renderer.reconcile(lazyState);

    expect(el(lazy.stage, "DeckIcon").querySelector(".mirror-atlas-page")).not.toBeNull();
    expect(spineCanvases(lazy.stage)).toBe(1);
    expect(el(lazy.stage, "DeckShader").hasAttribute("data-godot-shader-webgl")).toBe(true);
    expect(el(lazy.stage, "DeckParticles").hasAttribute("data-godot-particle-runtime")).toBe(true);
    expect(lazy.stage.querySelectorAll(".mirror-shader-self").length).toBe(1);
    expect(lazy.stage.querySelectorAll(".mirror-particle-self").length).toBe(1);
    expect(el(lazy.stage, "Deck").style.display).toBe("");

  });

  it("REVEAL under a tween-PINNED ancestor: the pin skip must not swallow the ancestor-hidden flip (hazard a)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, scene(false));
    renderer.reconcile(state);
    expect(stage.querySelectorAll(".mirror-atlas-page")).toHaveLength(1);

    // Arm a real transform tween on the dialog's PARENT so every descendant walks with ctx.pinnedAncestor = true.
    hintsOnly(state, [
      { targetId: "Game", property: "position", durationMs: 5000, trans: "Cubic", ease: "Out", endTransform: [1, 0, 0, 1, 40, 0] }
    ]);
    renderer.reconcile(state);

    // Now reveal. Only `Deck` is upserted, so DeckIcon is NOT in the dirty set and reaches the skip gate with
    // pinnedAncestor set — the exact shape the pin skip was built to short-circuit.
    update(state, [{ id: "Deck", parentId: "Game", name: "Deck", nodeType: "Godot.Control", visible: true }]);
    renderer.reconcile(state);

    expect(el(stage, "DeckIcon").querySelector(".mirror-atlas-page")).not.toBeNull();
    expect(el(stage, "DeckShader").hasAttribute("data-godot-shader-webgl")).toBe(true);
  });

  it("REVEAL cannot be swallowed by the recurse-only fast path (hazard b) — the flip forces real visits", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, scene(false));
    renderer.reconcile(state);

    // Steady state: an unrelated volatile delta leaves the dialog subtree entirely alone (skipped, not fast-pathed).
    mirrorWalkStats.reset();
    update(state, [atlasSprite("CombatIcon", "Combat", 101)]);
    renderer.reconcile(state);
    const idleVisits = mirrorWalkStats.visits;

    // The reveal: every node under Deck must take a REAL visit (fastPathVisits cannot absorb them, because the
    // fast path requires ctxSame and ancestorHidden just changed).
    mirrorWalkStats.reset();
    update(state, [{ id: "Deck", parentId: "Game", name: "Deck", nodeType: "Godot.Control", visible: true }]);
    renderer.reconcile(state);
    // Deck + Inner + DeckIcon + DeckShader + DeckParticles + DeckSpine, plus Game on the way down = 7 real visits,
    // where the idle delta only ever reached Game + Combat + CombatIcon.
    expect(idleVisits).toBeLessThanOrEqual(3);
    expect(mirrorWalkStats.visits).toBe(7);
    expect(mirrorWalkStats.fastPathVisits).toBe(0); // the flip cannot be absorbed by the recurse-only path
    expect(mirrorWalkStats.styledNodes).toBeGreaterThanOrEqual(6);
  });

});

// --- item 2 -----------------------------------------------------------------------------------------------------

function tipScene(state: MirrorState, cardX: number): void {
  full(state, [
    {
      id: "tips",
      parentId: null,
      name: "tips",
      nodeType: "HoverTips.NHoverTipSet",
      transform: xf(100, 200),
      localRect: rect(0, 0, 400, 300),
      visible: true
    },
    {
      id: "card",
      parentId: "tips",
      name: "card",
      nodeType: "NHoverTipCardContainer",
      transform: xf(cardX, 660),
      localRect: rect(0, 0, 360, 122),
      visible: true,
      fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" }
    }
  ]);
}

function matrixCount(transform: string): number {
  return (transform.match(/matrix\(/g) ?? []).length;
}

describe("R10-PERF4 WS-3 item 2 — the tip-scale pass runs once per geometry epoch", () => {
  it("re-runs only when the tooltip actually moves; a cosmetic-only delta skips it", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    tipScene(state, 1040);
    renderer.reconcile(state);
    // The pass composed its scale onto the tip root (2 matrices: the 1.2× stamp, then the root's own placement).
    expect(matrixCount(el(stage, "tips").style.transform)).toBe(2);

    // A COSMETIC-only delta on the tip child (modulate, no geometry): the pass must not re-run.
    mirrorWalkStats.reset();
    update(state, [
      {
        id: "card",
        parentId: "tips",
        name: "card",
        nodeType: "NHoverTipCardContainer",
        transform: xf(1040, 660),
        localRect: rect(0, 0, 360, 122),
        visible: true,
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" },
        modulate: { r: 1, g: 1, b: 1, a: 0.9, html: "#ffffff" }
      }
    ]);
    const runsBefore = mirrorWalkStats.geomPassRuns;
    renderer.reconcile(state);
    // Two epoch-gated passes share the counters; a clean epoch skips BOTH, so runs must not advance at all.
    expect(mirrorWalkStats.geomPassRuns).toBe(runsBefore);
    expect(mirrorWalkStats.geomPassSkips).toBeGreaterThanOrEqual(2);
    // …and the composed scale is still standing (nothing rewrote the base transform, so nothing wiped it).
    expect(matrixCount(el(stage, "tips").style.transform)).toBe(2);

    // A MOVE of the tip child bumps the epoch (setGDesign) → the pass re-runs and re-composes.
    mirrorWalkStats.reset();
    update(state, [
      {
        id: "card",
        parentId: "tips",
        name: "card",
        nodeType: "NHoverTipCardContainer",
        transform: xf(900, 660),
        localRect: rect(0, 0, 360, 122),
        visible: true,
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" }
      }
    ]);
    renderer.reconcile(state);
    expect(mirrorWalkStats.geomPassRuns).toBeGreaterThanOrEqual(2);
    expect(matrixCount(el(stage, "tips").style.transform)).toBe(2);
  });

});
