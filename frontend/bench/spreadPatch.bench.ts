// R21 B2 — WHAT THE WIDESCREEN PATCH TIER IS WORTH, as a number, in process.
//
//   cd frontend && npm run bench:mirror -- bench/spreadPatch.bench.ts
//
// The round's causal control was a live Firefox measurement: same scene, same instance, only the window width
// changed. At a 1878x954 content viewport (a maximized 1920x1080 desktop browser, aspect 1.97) the transform tier
// refused every frame with `spread` and all 295 frames ran a full `buildDrawList` — 15 ms of JS each. Narrowing the
// same window below 16:9 patched 94% of frames at 1 ms. That measurement cannot be re-run offline, so this bench
// measures the thing UNDER it that can be: on a widened stage, what does one animated frame cost as a REBUILD, and
// what does the same frame cost as a PATCH?
//
// It is deliberately NOT a renderer bench. `buildDrawList` and `listPatch` are pure, so timing them directly leaves
// no compositor, no GL, no jsdom layout and no rAF scheduling in the number — the ratio it reports is the ratio the
// live frame inherits, and the absolute milliseconds are node's, not Firefox's. Both are stated as such below.

import { describe, it } from "vitest";

import { createDrawList, createGlyphsView, createNinePatchView, createQuadView } from "@godot-scene-web/canvas";

import { buildDrawList, type DrawListBuild, type LocalAnim } from "@/mirror/canvas/buildDrawList";
import {
  applyTransformPlan,
  createTransformScratch,
  planTransform,
  type PatchAnimFrame,
  type TransformOutcome,
  type TransformPatchEnv
} from "@/mirror/canvas/listPatch";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

/** A maximized 1920x1080 desktop browser: ~1878x954 content viewport, so the design box is ~2126 wide. */
const MAXIMIZED = ((1878 / 954) * 1080) / 1920;

function node(over: Record<string, unknown>): Record<string, unknown> {
  return {
    parentId: null,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } },
    visible: true,
    ...over
  };
}

function at(x: number, y: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } };
}

/**
 * A combat-shaped scene: four creatures with a bobbing intent each, plus a hand and a HUD, padded with plain
 * quads to the node count the profiled combat actually carried (the round's own profile put `buildDrawList` at
 * 20 ms over a tree whose cost was "proportional to node count, not a hot function").
 */
function combatScene(pad: number): { state: MirrorState; anims: (phase: number) => Map<string, LocalAnim> } {
  const upserts: Record<string, unknown>[] = [
    node({ id: "Root", name: "Root", localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } })
  ];
  const holders: string[] = [];
  for (let c = 0; c < 4; c++) {
    const x = 420 + c * 340;
    upserts.push(
      node({ id: `Creature${c}`, parentId: "Root", name: "Creature", nodeType: "Godot.Sprite2D", transform: at(x, 460) }),
      node({
        id: `Intent${c}`,
        parentId: `Creature${c}`,
        name: "Intent",
        nodeType: "NIntent",
        sceneFilePath: "res://scenes/combat/intent.tscn",
        transform: at(0, -180),
        localRect: { position: { x: 0, y: 0 }, size: { x: 120, y: 120 } }
      }),
      node({
        id: `IntentHolder${c}`,
        parentId: `Intent${c}`,
        name: "IntentHolder",
        localRect: { position: { x: 0, y: 0 }, size: { x: 120, y: 120 } }
      }),
      node({
        id: `IntentIcon${c}`,
        parentId: `IntentHolder${c}`,
        name: "Intent",
        nodeType: "TextureRect",
        localRect: { position: { x: 0, y: 0 }, size: { x: 64, y: 64 } },
        fillColor: { r: 1, g: 1, b: 1, a: 1 }
      }),
      node({
        id: `IntentCount${c}`,
        parentId: `IntentHolder${c}`,
        name: "IntentCount",
        nodeType: "Godot.Label",
        transform: at(4, 70),
        localRect: { position: { x: 0, y: 0 }, size: { x: 40, y: 24 } },
        text: { text: "12" }
      })
    );
    holders.push(`IntentHolder${c}`);
  }
  for (let i = 0; i < pad; i++) {
    upserts.push(
      node({
        id: `Pad${i}`,
        parentId: "Root",
        name: "Pad",
        nodeType: "Godot.Sprite2D",
        transform: at(60 + (i % 37) * 48, 80 + ((i / 37) | 0) * 26),
        localRect: { position: { x: 0, y: 0 }, size: { x: 44, y: 22 } },
        fillColor: { r: 0.6, g: 0.7, b: 0.9, a: 1 }
      })
    );
  }
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: upserts.map((u) => u.id as string),
      upserts
    })!
  );
  return {
    state,
    anims: (phase: number) => {
      const map = new Map<string, LocalAnim>();
      for (let i = 0; i < holders.length; i++) {
        // The intent bob: a PARENT-space translate, i.e. exactly the delta whose `v` is zero and whose whole span
        // therefore takes one multiplier even on a widened stage.
        map.set(holders[i], { pre: [1, 0, 0, 1, 0, -9 - 8 * Math.cos(phase + i)], post: null });
      }
      return map;
    }
  };
}

function envFor(_state: MirrorState, build: DrawListBuild, now: Map<string, LocalAnim>, dx: Map<string, number>): TransformPatchEnv {
  const none = new Set<string>();
  return {
    orderIds: build.order.ids,
    spanOf: (id) => build.order.entries.get(id),
    animFrames: build.localAnimFrames as ReadonlyMap<string, PatchAnimFrame>,
    animNowOf: (id) => now.get(id) ?? null,
    rangeOf: (id) => build.ranges.get(id),
    isViewScaleCandidate: (id) => build.viewScaleCandidates.has(id),
    isOverlayClipped: (id) => build.overlayClipped.has(id),
    isClipper: (id) => build.clipRanges.has(id),
    hasCosmeticOffset: () => false,
    isCaptured: (id) => none.has(id),
    hasTransformOverride: () => false,
    hasTrailQuad: (id) => build.trailQuadIds.has(id),
    isTextDrawn: (id) => build.textQuadIds.has(id),
    spreadDxOf: (id) => dx.get(id) ?? 0,
    backstopOrder: build.backstopOrder
  };
}

function p50(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("R21 B2 — a widened stage's animated frame, rebuilt vs patched", () => {
  it("reports both arms", () => {
    const { state, anims } = combatScene(900);
    const outcome: TransformOutcome = { ok: false, bail: null, roots: 0, commands: 0, records: 0, hits: 0, visited: 0 };
    const work = createTransformScratch(createQuadView(), createNinePatchView(), createGlyphsView());

    const frames = 240;
    const warmup = 40;

    // ARM A — what every animated frame did at aspect > 16:9 before this round: a full rebuild.
    const rebuildList = createDrawList<string>();
    const rebuildMs: number[] = [];
    for (let f = 0; f < frames + warmup; f++) {
      const t0 = performance.now();
      buildDrawList(state, rebuildList, {
        localAnims: anims(f * 0.11),
        spreadFactor: MAXIMIZED,
        spreadDxOut: new Map<string, number>()
      });
      if (f >= warmup) rebuildMs.push(performance.now() - t0);
    }

    // ARM B — the same frames as patches, with a rebuild every `PATCH_TRANSFORM_CHAIN_MAX` links exactly as the
    // renderer's chain bound forces. Timed END TO END so the amortised rebuild is IN the number rather than
    // subtracted out of it.
    const patchList = createDrawList<string>();
    const dx = new Map<string, number>();
    let build = buildDrawList(state, patchList, { localAnims: anims(0), spreadFactor: MAXIMIZED, spreadDxOut: dx });
    const patchMs: number[] = [];
    let patched = 0;
    let rebuilt = 0;
    let chain = 0;
    let bail: string | null = null;
    for (let f = 0; f < frames + warmup; f++) {
      const now = anims(f * 0.11);
      const t0 = performance.now();
      if (chain >= 15) {
        build = buildDrawList(state, patchList, { localAnims: now, spreadFactor: MAXIMIZED, spreadDxOut: dx });
        chain = 0;
        if (f >= warmup) rebuilt++;
      } else {
        const env = envFor(state, build, now, dx);
        planTransform(env, patchList, work, outcome);
        if (outcome.ok) {
          applyTransformPlan(env, patchList, build.overlayRecords, build.hitEntries, work, outcome);
          chain++;
          if (f >= warmup) patched++;
        } else {
          bail = outcome.bail;
          build = buildDrawList(state, patchList, { localAnims: now, spreadFactor: MAXIMIZED, spreadDxOut: dx });
          chain = 0;
          if (f >= warmup) rebuilt++;
        }
      }
      if (f >= warmup) patchMs.push(performance.now() - t0);
    }

    const result = {
      nodes: state.nodes.size,
      commands: rebuildList.count,
      spreadFactor: Number(MAXIMIZED.toFixed(4)),
      frames,
      rebuildOnlyMsP50: Number(p50(rebuildMs).toFixed(3)),
      patchArmMsP50: Number(p50(patchMs).toFixed(3)),
      patchArmMsMean: Number((patchMs.reduce((a, b) => a + b, 0) / patchMs.length).toFixed(3)),
      patchedFrames: patched,
      rebuiltFrames: rebuilt,
      firstBail: bail
    };
    // `process.stdout.write`, not `console.log`: vitest swallows a passing test body's console output, and the
    // whole point of this file is the line it prints. Same trick `mirrorReplay.bench.ts` uses.
    process.stdout.write(`BENCH_RESULT ${JSON.stringify(result)}\n`);
  });
});
