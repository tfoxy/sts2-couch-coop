import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,
  __resetAtlasDecodeGateForTest,





  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import {
  onAtlasRegionsReady,
  __regionWaitersForTest,
  __resetAtlasCacheForTest,
  __setAtlasPageSizeForTest
} from "@/mirror/atlasBaker";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// R10-PERF6 WS-P2 — MAP-OPEN PAINT DIET: the staggered reveal and atlas-region warm-up in the dark.
//
// Both come out of the same measurement (the `perf5-map-open` fixture, real atlases served, headless Chromium):
// the frame that opens the map is PAINT-bound — ~733 display-item paints plus the raster they schedule, the worst
// presented-frame gap of the whole run — and, when the map's regions are still unbaked, every one of its ~740
// sprites mounts a <canvas> (743 promoted compositor layers) that a landing bake then swaps for a div (801
// targeted re-styles across ~30 extra walks). The pulse, by contrast, was measured INNOCENT: its three map points
// are composited (`ActiveScaleAnimation` layers, no demoting ancestor) and a settled map costs zero main-thread
// paint, so nothing here touches the pulse.
//
// The properties these specs pin:
//   1. a big reveal is SPLIT — the reveal frame shows a first budget and holds the rest with `display:none` on a
//      handful of subtree roots, and the reveal ROOT itself is never held;
//   2. COMPLETENESS — draining releases every held root, even with no further wire traffic, and a full walk
//      flushes the holds outright; nothing can be left invisible;
//   3. a hold can only ever SUPPRESS paint: a node the game hid while it was held stays hidden after release;
//   4. small reveals stay atomic;
//   5. the hatchery warms a hidden sprite's region blob with NO waiter registered (a bake must never re-style an
//      invisible node).

type Raw = Record<string, unknown>;

const xf = (tx: number, ty: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });
const rect = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });
const rgba = (r: number, g: number, b: number, a: number) => ({ r, g, b, a, html: "#ff0000" });

function node(id: string, parentId: string | null, over: Raw = {}): Raw {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.Control",
    transform: xf(0, 0),
    localRect: rect(0, 0, 100, 16),
    visible: true,
    ...over
  };
}

function boxed(id: string, parentId: string, x: number, y: number, over: Raw = {}): Raw {
  return node(id, parentId, {
    nodeType: "Godot.ColorRect",
    transform: xf(x, y),
    localRect: rect(0, 0, 40, 24),
    fillColor: rgba(1, 0, 0, 1),
    ...over
  });
}

// An ATLAS SPRITE: a texture plus a region, the shape `paintsAtlasCanvas` recognises.
function sprite(id: string, parentId: string, region: { x: number; y: number }): Raw {
  return node(id, parentId, {
    nodeType: "Godot.TextureRect",
    transform: xf(region.x, region.y),
    localRect: rect(0, 0, 32, 32),
    texture: { resourcePath: "res://images/atlases/ui_atlas_0.png" },
    textureRegion: { position: { x: region.x, y: region.y }, size: { x: 32, y: 32 } }
  });
}

let created: MirrorRenderer[] = [];

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  const renderer = createMirrorRenderer(stage, defs);
  created.push(renderer);
  return { stage, renderer };
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

// ONE query for the whole stage, reused by every lookup in an assertion. Per-id `querySelector` calls looked
// harmless and were not: this scene has 600+ nodes and the file asserts over all of them repeatedly, which under
// jsdom is slow enough to blow vitest's 5s per-test timeout when the suite runs in parallel (it passed in
// isolation and failed in the full run — the worst kind of flake).
function elMap(stage: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const node of stage.querySelectorAll<HTMLElement>("[data-node-id]")) {
    const id = node.getAttribute("data-node-id");
    if (id != null && !out.has(id)) out.set(id, node);
  }
  return out;
}

function el(stage: HTMLElement, id: string): HTMLElement | null {
  return stage.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
}

function hiddenIds(stage: HTMLElement, ids: string[]): string[] {
  const map = elMap(stage);
  return ids.filter((id) => map.get(id)?.style.display === "none");
}

// --- the scene -------------------------------------------------------------------------------------------------
//
// Screen (the node whose `visible` flips)
//  └─ Map
//      ├─ Group0 … Group19   (20 groups)
//      │    └─ Point0..Point29 (30 leaves each)  → 20 × 31 + 2 = 624 wire nodes under Screen
//
// Deliberately shaped like the real map: ONE huge container under the screen root, whose children are the natural
// stagger unit. A partition that only ever held the screen's direct children would hold `Map` whole and stagger
// nothing — this scene is what makes that failure visible.
const GROUPS = 20;
const POINTS = 30;

function mapScene(screenVisible: boolean): Raw[] {
  const nodes: Raw[] = [node("Root", null), boxed("Hud", "Root", 0, 0)];
  nodes.push(node("Screen", "Root", { visible: screenVisible }), node("Map", "Screen"));
  for (let g = 0; g < GROUPS; g++) {
    nodes.push(node(`Group${g}`, "Map"));
    for (let p = 0; p < POINTS; p++) {
      nodes.push(boxed(`P${g}_${p}`, `Group${g}`, g * 50, p * 30));
    }
  }
  return nodes;
}

const ALL_MAP_IDS = (() => {
  const ids = ["Map"];
  for (let g = 0; g < GROUPS; g++) {
    ids.push(`Group${g}`);
    for (let p = 0; p < POINTS; p++) ids.push(`P${g}_${p}`);
  }
  return ids;
})();

function mount(nodes: Raw[]): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
  const { stage, renderer } = harness();
  const state = createMirrorState();
  full(state, nodes);
  renderer.reconcile(state);
  return { stage, renderer, state };
}

// Pre-build the hidden subtree exactly as the shipped idle hatchery does during the combat that precedes a map
// open. This is what gives the screen root an element — and therefore the
// hidden→visible display edge the stagger keys off. A reveal with NO pre-build is the cold case the hatchery
// exists to prevent: it BUILDS the subtree in the reveal walk, and the stagger deliberately leaves it alone.
function hatchAll(renderer: MirrorRenderer): void {
  let n = 0;
  // A real per-drain budget, not 0: with a zero budget the hatchery yields after a single element and a 600-node
  // scene needs 600+ re-entries of the drain, which dominates this file's runtime for no added coverage (the
  // scheduling itself is exercised by the hatchery's own specs).
  while (renderer.__drainDormantHatchForTest(50)) {
    expect(++n).toBeLessThan(2000);
  }
}

// Open the screen and reconcile — the reveal frame.
function reveal(renderer: MirrorRenderer, state: MirrorState): void {
  hatchAll(renderer);
  update(state, [node("Screen", "Root", { visible: true })]);
  renderer.reconcile(state);
}

// Release slices until nothing is held. Bounded, so a stalled drain fails as a test instead of hanging.
function releaseAll(renderer: MirrorRenderer, budgetNodes?: number): number {
  let slices = 0;
  while (renderer.__drainRevealStaggerForTest(budgetNodes) > 0) {
    slices++;
    expect(slices).toBeLessThan(200);
  }
  return slices + 1;
}

let unwire: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  __resetAtlasCacheForTest();
  // The page-settle waiters live in the RENDERER but subscribe into the baker's per-url listener sets, so the two
  // resets belong together: clearing one without the other leaves an orphan subscription across specs.
  __resetAtlasDecodeGateForTest();
  mirrorWalkStats.reset();
});

afterEach(() => {
  unwire?.();
  unwire = null;
  for (const r of created) r.dispose();
  created = [];
  document.body.innerHTML = "";
  __resetAtlasCacheForTest();
  __resetAtlasDecodeGateForTest();
});

// --- 1. the split ----------------------------------------------------------------------------------------------

describe("staggered reveal", () => {
  it("shows a first budget and holds the rest of a big reveal back", () => {
    const { stage, renderer, state } = mount(mapScene(false));
    reveal(renderer, state);

    // The reveal root is NEVER held — the screen itself must appear on the frame the game showed it.
    expect(el(stage, "Screen")!.style.display).not.toBe("none");
    expect(mirrorWalkStats.revealStaggerHolds).toBeGreaterThan(0);

    const held = hiddenIds(stage, ALL_MAP_IDS);
    expect(held.length).toBeGreaterThan(0);
    // …and a real chunk of the subtree DID paint on the reveal frame (this is a stagger, not a deferral).
    const shown = ALL_MAP_IDS.length - held.length;
    expect(shown).toBeGreaterThan(50);
    // The split lands INSIDE the one big container, not on it: holding `Map` whole would stagger nothing.
    expect(el(stage, "Map")!.style.display).not.toBe("none");
  });

  it("releases every held node — completeness, with no further wire traffic", () => {
    const { stage, renderer, state } = mount(mapScene(false));
    reveal(renderer, state);
    expect(hiddenIds(stage, ALL_MAP_IDS).length).toBeGreaterThan(0);

    // An explicit (small) budget so the slicing itself is exercised: the shipped budget would clear this test
    // scene in one frame, while the real map's 1,700 nodes take three.
    const slices = releaseAll(renderer, 60);
    expect(slices).toBeGreaterThan(1); // it really was spread over more than one frame
    expect(mirrorWalkStats.revealStaggerBatches).toBeGreaterThan(0);
    const shown = elMap(stage);
    for (const id of ALL_MAP_IDS) {
      expect(shown.get(id), `revealed ${id}`).toBeDefined();
      expect(shown.get(id)!.style.display, `display of ${id}`).not.toBe("none");
    }
  });

  it("holds only subtree ROOTS, so one release shows a whole group at once", () => {
    const { stage, renderer, state } = mount(mapScene(false));
    reveal(renderer, state);
    const heldBefore = hiddenIds(stage, ALL_MAP_IDS);
    // A held GROUP hides its points through the cascade, so the points themselves carry no `display:none` of
    // their own — the hold count is roots, not nodes.
    const heldGroups = heldBefore.filter((id) => id.startsWith("Group"));
    expect(heldGroups.length).toBeGreaterThan(0);
    expect(mirrorWalkStats.revealStaggerHolds).toBeLessThanOrEqual(GROUPS + 1);
    expect(mirrorWalkStats.revealStaggerHeldNodes).toBeGreaterThanOrEqual(heldGroups.length * (POINTS + 1));
  });

  it("never resurrects a node the game hid while it was held", () => {
    const { stage, renderer, state } = mount(mapScene(false));
    reveal(renderer, state);
    const heldGroup = hiddenIds(stage, ALL_MAP_IDS).find((id) => id.startsWith("Group"));
    expect(heldGroup).toBeDefined();

    // The game hides that group for its own reasons while the stagger still holds it.
    update(state, [node(heldGroup!, "Map", { visible: false })]);
    renderer.reconcile(state);
    releaseAll(renderer);

    const after = elMap(stage);
    expect(after.get(heldGroup!)!.style.display).toBe("none");
    // …and every group the game did NOT hide is shown.
    for (const id of ALL_MAP_IDS.filter((x) => x !== heldGroup)) {
      const isUnderHidden = id.startsWith(`${heldGroup!.replace("Group", "P")}_`);
      if (!isUnderHidden) {
        expect(after.get(id)!.style.display, `display of ${id}`).not.toBe("none");
      }
    }
  });

  it("a full walk flushes every hold", () => {
    const { stage, renderer, state } = mount(mapScene(false));
    reveal(renderer, state);
    expect(hiddenIds(stage, ALL_MAP_IDS).length).toBeGreaterThan(0);

    // A keyframe (the reconnect / screen-rewrite path) re-establishes the whole tree.
    const fresh = createMirrorState();
    full(fresh, mapScene(true));
    renderer.reconcile(fresh);

    const shown = elMap(stage);
    for (const id of ALL_MAP_IDS) {
      expect(shown.get(id)!.style.display, `display of ${id}`).not.toBe("none");
    }
  });

  it("leaves a SMALL reveal atomic", () => {
    const small: Raw[] = [node("Root", null), node("Screen", "Root", { visible: false }), node("Dlg", "Screen")];
    for (let i = 0; i < 20; i++) small.push(boxed(`D${i}`, "Dlg", i * 10, 0));
    const { stage, renderer, state } = mount(small);
    reveal(renderer, state);

    expect(mirrorWalkStats.revealStaggerHolds).toBe(0);
    for (let i = 0; i < 20; i++) {
      expect(el(stage, `D${i}`)!.style.display).not.toBe("none");
    }
  });

  it("drains from a TIMER when requestAnimationFrame never fires (backgrounded tab)", async () => {
    // The completeness contract's weakest point: a hold is `display:none`, and rAF is starved in a background
    // tab, so an rAF-only drain could leave part of the map permanently invisible. Here rAF is stubbed to never
    // call back — only the safety-net timeout can finish the reveal.
    const realRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (() => 1) as unknown as typeof globalThis.requestAnimationFrame;
    try {
      const { stage, renderer, state } = mount(mapScene(false));
      reveal(renderer, state);
      expect(hiddenIds(stage, ALL_MAP_IDS).length, "the reveal did hold nodes back").toBeGreaterThan(0);

      // Real timers, so this waits out the actual shipped fallback delay rather than a mocked one.
      const deadline = Date.now() + 4000;
      while (hiddenIds(stage, ALL_MAP_IDS).length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      const shown = elMap(stage);
      for (const id of ALL_MAP_IDS) {
        expect(shown.get(id)!.style.display, `display of ${id}`).not.toBe("none");
      }
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
  });

});

// --- 2. the atlas warm-up in the dark ---------------------------------------------------------------------------

describe("atlas region warm-up while hidden", () => {
  const REGION = { x: 64, y: 96 };
  const ATLAS = "/res/images/atlases/ui_atlas_0.png"; // the RESOLVED url the renderer keys the region by
  const wireRegion = { x: REGION.x, y: REGION.y, width: 32, height: 32 };

  function spriteScene(screenVisible: boolean): Raw[] {
    return [
      node("Root", null),
      node("Screen", "Root", { visible: screenVisible }),
      sprite("Icon", "Screen", REGION)
    ];
  }

  it("kicks the hidden sprite's region bake WITHOUT registering it as a waiter", () => {
    const { renderer } = mount(spriteScene(false));
    expect(mirrorWalkStats.atlasWarmedRegions).toBe(0); // nothing built yet — the node is dormant

    hatchAll(renderer);

    expect(mirrorWalkStats.atlasWarmedRegions).toBeGreaterThan(0);
    // The whole point of the null-waiter request: a bake that lands must NOT re-style an invisible node (that is
    // exactly the restyle storm this removes), so nobody is registered against the region.
    expect(__regionWaitersForTest(ATLAS, wireRegion)).toEqual([]);
  });

  it("a VISIBLE sprite still registers as a waiter (the reveal-time swap is untouched)", () => {
    const { renderer } = mount(spriteScene(true));
    void renderer;
    expect(__regionWaitersForTest(ATLAS, wireRegion)).toEqual(["Icon"]);
  });

  // Aug-20 — the RELEASE path is the reason the page-settle waiter has to exist. `releaseRevealBatch` writes
  // `display` and nothing else (a held subtree was already styled by the walk, so there is deliberately nothing to
  // recompute) — which means whatever placeholder the reveal walk chose is exactly what the player sees when the
  // hold lifts. A sprite that guessed "page" because its atlas had not decoded yet would therefore paint a whole
  // card atlas the moment its group is released. The settle waiter re-styles it while it is still held.
  it("a HELD reveal never exposes a stale page-crop div (the release writes display only)", () => {
    const BIG = { width: 4032, height: 4072 }; // a card atlas — over the page-crop size gate
    const scene = mapScene(false);
    for (let g = 0; g < GROUPS; g++) {
      scene.push(sprite(`Icon${g}`, `Group${g}`, REGION));
    }
    const { stage, renderer, state } = mount(scene);
    unwire = onAtlasRegionsReady((ids) => {
      renderer.markTextureDirty(ids);
      renderer.reconcile(state);
    });
    reveal(renderer, state);

    // A group the stagger is holding back, and the sprite inside it: the reveal walk styled it (holds suppress
    // paint, they do not skip the walk) with the page still undecoded, so it took the blind "page" guess.
    const heldGroup = hiddenIds(stage, ALL_MAP_IDS).find((id) => id.startsWith("Group"));
    expect(heldGroup, "the reveal held a group back").toBeDefined();
    const icon = el(stage, `Icon${heldGroup!.replace("Group", "")}`)!;
    expect(icon.querySelector("div.mirror-atlas-page"), "undecoded page ⇒ the guess").not.toBeNull();

    // The atlas decodes while the hold is still up.
    __setAtlasPageSizeForTest(ATLAS, BIG);
    expect(el(stage, heldGroup!)!.style.display, "still held").toBe("none");
    expect(stage.querySelectorAll("div.mirror-atlas-page").length, "swapped under the hold").toBe(0);

    // The release only un-hides — so what appears is the canvas the settle already put there.
    releaseAll(renderer);
    expect(el(stage, heldGroup!)!.style.display).not.toBe("none");
    expect(stage.querySelectorAll("div.mirror-atlas-page").length).toBe(0);
    expect(el(stage, `Icon${heldGroup!.replace("Group", "")}`)!.querySelector("canvas.mirror-atlas-canvas")).not.toBeNull();
  });
});
