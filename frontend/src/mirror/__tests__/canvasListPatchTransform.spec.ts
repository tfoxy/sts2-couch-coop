// TIER 3, THE TRANSFORM ARM — checked against the ONLY oracle that means anything: a rebuild.
//
// `canvasListPatch.spec` can assert the alpha arm's arithmetic directly, because `k = A'/A` is a number a test can
// write down. A re-pose is not like that. The claim is "the patched list is the list `buildDrawList` would have
// written at this phase", and the honest way to check a claim of that shape is to write both lists and compare
// every float — which is what almost every arm here does. A hand-computed expected matrix would only prove the
// test and the patcher share an author.
//
// So the shape is: build at phase A into one list, patch it to phase B, build FRESH at phase B into another, and
// require the two arenas to agree. Everything the walk does downstream of the pose — descendants composing against
// `gRaw`, atlas regions, injected overlay quads, the placement on every record — is covered by that comparison
// without the test naming any of it.
//
// The refusal arms are the other half, and they are checked the opposite way: each one is set up to be the ONLY
// thing wrong, the plan is asked for by name, and both arenas are snapshotted to prove a refusal writes nothing.

import { describe, expect, it } from "vitest";

import { createDrawList, createGlyphsView, createNinePatchView, createQuadView } from "@godot-scene-web/canvas";

import { buildDrawList, type DrawListBuild, type LocalAnim } from "@/mirror/canvas/buildDrawList";
import {
  applyTransformPlan,
  applySourcePlan,
  createPatchScratch,
  createTransformScratch,
  planSource,
  planTransform,
  type PatchAnimFrame,
  type PatchBailReason,
  type PatchOutcome,
  type SourcePatch,
  type SourcePatchTarget,
  type TransformOutcome,
  type TransformPatchEnv
} from "@/mirror/canvas/listPatch";
import type { TextGlyphBlock, TextGlyphSource } from "@/mirror/canvas/paintSpec";
import { createMirrorState, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";

// --- the scene ---------------------------------------------------------------------------------------------------

function mkNode(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.TextureRect",
    showBehindParent: false,
    clipChildren: 0,
    clipContents: false,
    ninePatchMargins: null,
    font: null,
    richBoldFont: null,
    richItalicFont: null,
    richBoldItalicFont: null,
    richBoldFontSizePx: null,
    richItalicFontSizePx: null,
    richBoldItalicFontSizePx: null,
    richBoldFontSpacingPx: null,
    richItalicFontSpacingPx: null,
    richBoldItalicFontSpacingPx: null,
    textWrap: null,
    shadow: null,
    richText: false,
    shaderId: null,
    materialRef: null,
    shaderParams: null,
    textureStretchMode: null,
    textureFlipH: false,
    textureFlipV: false,
    particleSpec: null,
    particleEmitting: false,
    particleRestartEpoch: 0,
    spineSceneResPath: null,
    spineNodePath: null,
    spineAnimations: null,
    spineSkelResPath: null,
    sceneFilePath: null,
    mouseFilter: null,
    anchorLeft: null,
    anchorRight: null,
    anchorOwnerId: null,
    containerLayout: null,
    contentKey: null,
    spineCurrentAnim: null,
    spineSkin: null,
    spineMat: null,
    spinePaused: false,
    spineTrackTime: 0,
    spineLooping: true,
    pinnedLoopAnim: null,
    outline: null,
    transform: [1, 0, 0, 1, 0, 0],
    localRect: { x: 0, y: 0, width: 100, height: 40 },
    visible: true,
    focused: false,
    opacity: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    pivotX: 0,
    pivotY: 0,
    zIndex: null,
    textureUrl: null,
    textureRegion: null,
    textureMargin: null,
    ninePatch: false,
    modulate: null,
    selfModulate: null,
    fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" } as never,
    range: null,
    text: null,
    intentFrames: null,
    linePoints: null,
    lineWidth: null,
    lineColor: null,
    ...over
  };
}

function mkState(nodes: MirrorNode[]): MirrorState {
  const state = createMirrorState();
  for (const node of nodes) {
    state.nodes.set(node.id, node);
  }
  state.orderedIds = nodes.map((n) => n.id);
  state.revision = 1;
  return state;
}

/**
 * THE INTENT SHAPE THIS TIER EXISTS FOR, in miniature.
 *
 * `Holder` is what the bob moves; under it sit a sprite (a plain quad), a LABEL (an overlay record — the reason
 * refusing overlays would have made the whole arm worth nothing on the real screen) and a hit-visible button. The
 * fourth node is a sibling that must NOT move, which is what makes a whole-arena comparison discriminating.
 */
function intentScene(): MirrorState {
  return mkState([
    mkNode("Root", null, { localRect: { x: 0, y: 0, width: 1920, height: 1080 } }),
    mkNode("Elsewhere", "Root", { transform: [1, 0, 0, 1, 40, 40] }),
    mkNode("Holder", "Root", { transform: [1, 0, 0, 1, 600, 300] }),
    mkNode("Sprite", "Holder", { transform: [1, 0, 0, 1, 8, 8] }),
    mkNode("Label", "Holder", {
      nodeType: "Godot.Label",
      fillColor: null,
      transform: [1, 0, 0, 1, 4, 60],
      text: { text: "12" } as never
    }),
    mkNode("Button", "Holder", { mouseFilter: 0, transform: [1, 0, 0, 1, 0, 90] })
  ]);
}

const BOB_A: LocalAnim = { pre: [1, 0, 0, 1, 0, -18], post: null };
const BOB_B: LocalAnim = { pre: [1, 0, 0, 1, 0, -3.5], post: null };
/** A node-local conjugation about (50, 20) — `idleAnim.postRotate`'s own shape, at 0.12 rad. */
const ROCK_B: LocalAnim = {
  pre: null,
  post: [0.99280864, 0.11971221, -0.11971221, 0.99280864, 2.75218, -5.59146]
};

/**
 * ONE LABEL'S SHAPED RUNS, faked without a wasm or a GL context.
 *
 * TWO RUNS OVER ONE SPAN, which is the shape an outlined label really has (`TextGlyphBlock.spreads`: the same
 * glyphs and the same pens drawn once dilated and once not). One run would not exercise the per-run loop in
 * `emitTextGlyphs`, and the per-run loop is exactly where a patcher that re-poses only the first run would hide.
 *
 * STATELESS AND SHARED between the patched and the rebuilt build, so the two lists differ by the patch and by
 * nothing else — the same discipline `patchAndRebuild` holds everywhere else.
 */
const GLYPH_BLOCK: TextGlyphBlock = {
  runCount: 2,
  origins: Float32Array.from([2, 30, 2, 30]),
  spans: Int32Array.from([0, 3, 0, 3]),
  colors: Float32Array.from([0, 0, 0, 0.5, 1, 1, 1, 1]),
  spreads: Float32Array.from([1.5, 0]),
  slots: Int32Array.from([11, 12, 13]),
  positions: Float32Array.from([0, 0, 7.5, 0, 15, 0]),
  pixelsPerEm: 20,
  blockScale: 1.24
};

const glyphSource: TextGlyphSource = { blockFor: () => GLYPH_BLOCK };

// --- the harness -------------------------------------------------------------------------------------------------

type List = ReturnType<typeof createDrawList<string>>;

function buildInto(state: MirrorState, list: List, anims: Map<string, LocalAnim> | null, extra = {}): DrawListBuild {
  return buildDrawList(state, list, { localAnims: anims, assert: true, ...extra });
}

function newOutcome(): TransformOutcome {
  return { ok: false, bail: null, roots: 0, commands: 0, records: 0, hits: 0, visited: 0 };
}

interface EnvOverrides {
  viewScaleCandidates?: Set<string>;
  overlayClipped?: Set<string>;
  cosmeticOffsets?: Set<string>;
  captured?: Set<string>;
  transformOverrides?: Set<string>;
  trailQuads?: Set<string>;
  backstopOrder?: number;
  animFrames?: Map<string, PatchAnimFrame>;
  /** The `spreadDxOut` the build wrote — the renderer's `spreadDxByNode`, retained between builds. */
  spreadDx?: Map<string, number>;
  /** …or an instrumented reader, for the arm that proves a translating anim never asks. */
  spreadDxOf?: (id: string) => number;
  /** The build's canvas-drawn labels, overridden — `THE GLYPH TERM`'s `textScale` refusal reads this. */
  textDrawn?: Set<string>;
  /** …or an instrumented reader, for the twin arm that proves a translating anim never asks THIS either. */
  isTextDrawn?: (id: string) => boolean;
}

function envFor(
  _state: MirrorState,
  build: DrawListBuild,
  now: Map<string, LocalAnim>,
  over: EnvOverrides = {}
): TransformPatchEnv {
  const none = new Set<string>();
  const dx = over.spreadDx ?? new Map<string, number>();
  return {
    orderIds: build.order.ids,
    spanOf: (id) => build.order.entries.get(id),
    animFrames: over.animFrames ?? (build.localAnimFrames as ReadonlyMap<string, PatchAnimFrame>),
    animNowOf: (id) => now.get(id) ?? null,
    rangeOf: (id) => build.ranges.get(id),
    isViewScaleCandidate: (id) => (over.viewScaleCandidates ?? build.viewScaleCandidates).has(id),
    isOverlayClipped: (id) => (over.overlayClipped ?? build.overlayClipped).has(id),
    isClipper: (id) => build.clipRanges.has(id),
    hasCosmeticOffset: (id) => (over.cosmeticOffsets ?? none).has(id),
    isCaptured: (id) => (over.captured ?? none).has(id),
    hasTransformOverride: (id) => (over.transformOverrides ?? none).has(id),
    hasTrailQuad: (id) => (over.trailQuads ?? build.trailQuadIds).has(id),
    isTextDrawn: over.isTextDrawn ?? ((id) => (over.textDrawn ?? build.textQuadIds).has(id)),
    spreadDxOf: over.spreadDxOf ?? ((id) => dx.get(id) ?? 0),
    backstopOrder: over.backstopOrder ?? build.backstopOrder
  };
}

function scratch() {
  return createTransformScratch(createQuadView(), createNinePatchView(), createGlyphsView());
}

/**
 * Build at `from`, re-pose to `to`, and hand back the patched list beside a list built FRESH at `to`.
 *
 * The two builds run against the SAME state and the same options, so every difference between the arenas is the
 * patcher's doing and nothing else's.
 */
function patchAndRebuild(
  state: MirrorState,
  from: Map<string, LocalAnim> | null,
  to: Map<string, LocalAnim>,
  over: EnvOverrides = {},
  spreadFactor = 1,
  /** Extra `buildDrawList` options, given to BOTH builds — a source handed to only one would prove nothing. */
  buildExtra: Record<string, unknown> = {}
): {
  patched: List;
  rebuilt: List;
  build: DrawListBuild;
  control: DrawListBuild;
  out: TransformOutcome;
  spreadDx: Map<string, number>;
} {
  // ITS OWN MAP PER BUILD, mirroring the renderer: `spreadDxByNode` is cleared and refilled by every build, so the
  // patch env must read the map the list it is editing was written with — not one a later build has re-keyed.
  const spreadDx = new Map<string, number>();
  const patched = createDrawList<string>();
  const build = buildInto(state, patched, from, { spreadFactor, spreadDxOut: spreadDx, ...buildExtra });
  const env = envFor(state, build, to, { spreadDx, ...over });
  const out = newOutcome();
  const work = scratch();
  planTransform(env, patched, work, out);
  if (out.ok) {
    applyTransformPlan(env, patched, build.overlayRecords, build.hitEntries, work, out);
  }
  const rebuilt = createDrawList<string>();
  const control = buildInto(state, rebuilt, to.size > 0 ? to : null, {
    spreadFactor,
    spreadDxOut: new Map<string, number>(),
    ...buildExtra
  });
  return { patched, rebuilt, build, control, out, spreadDx };
}

/**
 * The arenas are `Float32Array`, so the honest tolerance is a MULTIPLE OF THE LAST BIT and not a fixed number of
 * decimals. A patch and a rebuild reach the same matrix by different associations of the same multiplies, and at a
 * widened stage the coordinates are large — one ULP at x ≈ 1700 is 1.2e-4, which a `toBeCloseTo(_, 4)` reads as a
 * failure while a 6-px error at x ≈ 3 sails through it. Three ULPs, floored at one ULP of 1.0, is both stricter
 * where it matters and stable where it does not.
 *
 * It is nowhere near loose enough to hide the thing these arms exist to catch: dropping the per-node spread term
 * misplaces a node by `(dx_i − dx_root) · |v|`, which is tens of DESIGN PIXELS — nine orders of magnitude above
 * this floor. The mutation check in the round's notes is the evidence for that, not this comment.
 */
const F32_ULP = 2 ** -23;

function expectArenasAgree(a: List, b: List, ulps = 3): void {
  expect(a.count).toBe(b.count);
  expect(a.floats.length).toBe(b.floats.length);
  for (let i = 0; i < b.floats.length; i++) {
    const tol = ulps * F32_ULP * Math.max(1, Math.abs(b.floats[i]));
    expect(Math.abs(a.floats[i] - b.floats[i]), `float[${i}] ${a.floats[i]} vs ${b.floats[i]}`).toBeLessThanOrEqual(tol);
  }
  for (let i = 0; i < b.ints.length; i++) {
    expect(a.ints[i], `int[${i}]`).toBe(b.ints[i]);
  }
}

/** The source handle is outside the Float32/Int32 arenas, so compare it explicitly. */
function expectTexturesAgree(a: List, b: List): void {
  expect(a.count).toBe(b.count);
  for (let index = 0; index < a.count; index++) {
    expect(a.textureAt(index), `texture[${index}]`).toBe(b.textureAt(index));
  }
}

function maxArenaRelativeDifference(a: List, b: List): number {
  expect(a.count).toBe(b.count);
  expect(a.floats.length).toBe(b.floats.length);
  let worst = 0;
  for (let index = 0; index < a.floats.length; index++) {
    worst = Math.max(worst, Math.abs(a.floats[index] - b.floats[index]) / Math.max(1, Math.abs(b.floats[index])));
  }
  return worst;
}

/** Overlay records and hit entries are the two transform surfaces outside a draw-list arena. */
function maxPoseRelativeDifference(a: DrawListBuild, b: DrawListBuild): number {
  expect(a.overlayRecords.length).toBe(b.overlayRecords.length);
  expect(a.hitEntries.length).toBe(b.hitEntries.length);
  let worst = 0;
  for (let index = 0; index < a.overlayRecords.length; index++) {
    const got = a.overlayRecords[index];
    const want = b.overlayRecords[index];
    expect(got.id).toBe(want.id);
    for (let element = 0; element < 6; element++) {
      worst = Math.max(worst, Math.abs(got.transform[element] - want.transform[element]) / Math.max(1, Math.abs(want.transform[element])));
    }
  }
  for (let index = 0; index < a.hitEntries.length; index++) {
    const got = a.hitEntries[index];
    const want = b.hitEntries[index];
    expect(got.nodeId).toBe(want.nodeId);
    for (let element = 0; element < 6; element++) {
      worst = Math.max(worst, Math.abs(got.mFinal[element] - want.mFinal[element]) / Math.max(1, Math.abs(want.mFinal[element])));
    }
  }
  return worst;
}

function snapshot(list: List): { floats: Float32Array; ints: Int32Array; count: number } {
  return { floats: list.floats.slice(), ints: list.ints.slice(), count: list.count };
}

/** Set up one root's span to be refused for exactly one reason, and ask for the name. */
function refusalFor(
  over: EnvOverrides,
  to = new Map([["Holder", BOB_B]]),
  buildExtra: Record<string, unknown> = {}
): { bail: PatchBailReason | null; wrote: boolean } {
  const state = intentScene();
  const list = createDrawList<string>();
  const build = buildInto(state, list, new Map([["Holder", BOB_A]]), buildExtra);
  const before = snapshot(list);
  const out = newOutcome();
  const work = scratch();
  planTransform(envFor(state, build, to, over), list, work, out);
  const after = snapshot(list);
  const wrote =
    after.count !== before.count ||
    after.floats.some((v, i) => v !== before.floats[i]) ||
    after.ints.some((v, i) => v !== before.ints[i]);
  return { bail: out.ok ? null : out.bail, wrote };
}

// --- 1-4: the rebuild comparison, which is the oracle -------------------------------------------------------------

describe("a re-posed span is the span a rebuild would have written", () => {
  it("moves a PRE translate — the intent bob, whose whole subtree rides it", () => {
    const state = intentScene();
    const { patched, rebuilt, out } = patchAndRebuild(state, new Map([["Holder", BOB_A]]), new Map([["Holder", BOB_B]]));
    expect(out.ok).toBe(true);
    expect(out.roots).toBe(1);
    expect(out.commands).toBeGreaterThan(0);
    expectArenasAgree(patched, rebuilt);
  });

  it("moves a POST conjugation — a rotation about the node's own pivot, not about the design origin", () => {
    const state = intentScene();
    const { patched, rebuilt, out } = patchAndRebuild(state, new Map([["Holder", BOB_A]]), new Map([["Holder", ROCK_B]]));
    expect(out.ok).toBe(true);
    expectArenasAgree(patched, rebuilt);
  });

  it("returns a DROPPED-OUT node to rest, because the root set is the banked map and not this frame's samples", () => {
    // The node stopped animating. Nothing in `animNowOf` names it, so its pose composes with pre = post = null —
    // which is the rest pose, and is exactly what a rebuild with no `localAnims` writes. Take the root set from
    // this frame's samples instead and the node keeps the last bob it was caught at.
    const state = intentScene();
    const { patched, rebuilt, out } = patchAndRebuild(state, new Map([["Holder", BOB_A]]), new Map());
    expect(out.ok).toBe(true);
    expect(out.roots).toBe(1);
    expectArenasAgree(patched, rebuilt);
  });

  it("moves a span whose label is drawn as glyph runs", () => {
    // Canvas text puts a label in the list as `glyphs`, which the span validator refused under the name
    // `polyline`. See `THE GLYPH TERM`: a run's `m` is `record.transform · inner` with `inner` a function of the
    // LABEL's own layout, so `D · m` is exactly what a rebuild writes — which is what the arenas say here.
    const state = intentScene();
    const { patched, rebuilt, out, build } = patchAndRebuild(
      state,
      new Map([["Holder", BOB_A]]),
      new Map([["Holder", BOB_B]]),
      {},
      1,
      { glyphSource }
    );
    // NOT A VACUOUS PASS. If the glyph source were refused (or the seam renamed) both lists would hold the same
    // zero runs and the comparison would prove nothing about glyphs at all.
    expect(build.stats.textGlyphRuns).toBe(2);
    let runs = 0;
    for (let i = 0; i < patched.count; i++) {
      if (patched.kindNameAt(i) === "glyphs") runs++;
    }
    expect(runs).toBe(2);
    expect(out.ok).toBe(true);
    expect(out.bail).toBeNull();
    expectArenasAgree(patched, rebuilt);
  });

  it("holds over a chain of glyph re-poses, so a run cannot drift off the rebuild one frame at a time", () => {
    // The chain is where a patcher that re-reads its own output through the wrong offsets shows up: `readGlyphs`
    // and `patchGlyphsTransform` address the same six floats, and a mismatch between them compounds per link.
    const state = intentScene();
    const list = createDrawList<string>();
    const build = buildInto(state, list, new Map([["Holder", BOB_A]]), { glyphSource });
    const work = scratch();
    const out = newOutcome();
    for (let i = 1; i <= 12; i++) {
      const now = new Map([["Holder", { pre: [1, 0, 0, 1, 0, -18 + i], post: null } as LocalAnim]]);
      const env = envFor(state, build, now);
      planTransform(env, list, work, out);
      expect(out.ok, `link ${i}`).toBe(true);
      applyTransformPlan(env, list, build.overlayRecords, build.hitEntries, work, out);
    }
    const rebuilt = createDrawList<string>();
    buildInto(state, rebuilt, new Map([["Holder", { pre: [1, 0, 0, 1, 0, -6], post: null } as LocalAnim]]), {
      glyphSource
    });
    expectArenasAgree(list, rebuilt);
  });

  it("writes nothing at all when the pose did not move", () => {
    const state = intentScene();
    const list = createDrawList<string>();
    const build = buildInto(state, list, new Map([["Holder", BOB_A]]));
    const before = snapshot(list);
    const out = newOutcome();
    const work = scratch();
    planTransform(envFor(state, build, new Map([["Holder", BOB_A]])), list, work, out);
    expect(out.ok).toBe(true);
    expect(out.roots).toBe(0);
    expect(snapshot(list).floats).toEqual(before.floats);
  });
});

// --- 5: the two things that are NOT in the arenas ------------------------------------------------------------------

describe("the surfaces a list comparison cannot see", () => {
  it("re-places the OVERLAY RECORDS, which is where the bob's own pixels live", () => {
    // The IntentHolder subtree is a sprite, a particle overlay and a text overlay. An arm that refused overlays
    // would refuse the bob on every frame and patch exactly nothing on the screen it was built for.
    const state = intentScene();
    const patched = createDrawList<string>();
    const build = buildInto(state, patched, new Map([["Holder", BOB_A]]));
    const label = build.overlayRecords.find((r) => r.id === "Label")!;
    const wasY = label.transform[5];

    const env = envFor(state, build, new Map([["Holder", BOB_B]]));
    const out = newOutcome();
    const work = scratch();
    planTransform(env, patched, work, out);
    applyTransformPlan(env, patched, build.overlayRecords, build.hitEntries, work, out);
    expect(out.records).toBe(1);

    const control = buildInto(state, createDrawList<string>(), new Map([["Holder", BOB_B]]));
    const want = control.overlayRecords.find((r) => r.id === "Label")!;
    expect(label.transform[5]).not.toBe(wasY);
    for (let i = 0; i < 6; i++) {
      expect(label.transform[i], `record m[${i}]`).toBeCloseTo(want.transform[i], 4);
    }
  });

  it("re-poses hitEntries.mFinal and leaves mGame ALONE — a tap still sends the pose the game believes in", () => {
    const state = intentScene();
    const patched = createDrawList<string>();
    const build = buildInto(state, patched, new Map([["Holder", BOB_A]]));
    const hit = build.hitEntries.find((e) => e.nodeId === "Button")!;
    const gameBefore = [...hit.mGame];

    const env = envFor(state, build, new Map([["Holder", BOB_B]]));
    const out = newOutcome();
    const work = scratch();
    planTransform(env, patched, work, out);
    applyTransformPlan(env, patched, build.overlayRecords, build.hitEntries, work, out);
    expect(out.hits).toBeGreaterThan(0);

    const control = buildInto(state, createDrawList<string>(), new Map([["Holder", BOB_B]]));
    const want = control.hitEntries.find((e) => e.nodeId === "Button")!;
    for (let i = 0; i < 6; i++) {
      expect(hit.mFinal[i], `mFinal[${i}]`).toBeCloseTo(want.mFinal[i], 4);
    }
    // THE HIT-GRID INVARIANT. A local anim never reaches `gGame`, so this is untouched on BOTH arms.
    expect([...hit.mGame]).toEqual(gameBefore);
    expect([...hit.mGame]).toEqual([...want.mGame]);
  });

  it("leaves a node OUTSIDE the span exactly where it was, in the list and in its hit entry", () => {
    const state = intentScene();
    const patched = createDrawList<string>();
    const build = buildInto(state, patched, new Map([["Holder", BOB_A]]));
    const range = build.ranges.get("Elsewhere")!;
    const before = snapshot(patched).floats.slice(
      patched.floatOffsetAt(range.start),
      patched.floatOffsetAt(range.paintEnd - 1) + 16
    );
    const env = envFor(state, build, new Map([["Holder", BOB_B]]));
    const out = newOutcome();
    const work = scratch();
    planTransform(env, patched, work, out);
    applyTransformPlan(env, patched, build.overlayRecords, build.hitEntries, work, out);
    const after = snapshot(patched).floats.slice(
      patched.floatOffsetAt(range.start),
      patched.floatOffsetAt(range.paintEnd - 1) + 16
    );
    expect([...after]).toEqual([...before]);
  });
});

// --- 5b: THE SPREAD TERM (R21 B2) ---------------------------------------------------------------------------------
//
// The tier used to refuse `spreadFactor !== 1` outright, which cost every maximized desktop browser its idle frames
// (a 1920x1080 window's content viewport is ~1878x954, aspect 1.97). The claim under test is the algebra that
// replaced the refusal: `gFinal_i = outer · T(dx_i, 0) · gRaw_i`, so `D_i = T((dx_i − dx_root)·v) · D_root` with
// `v = A_outer·e₁ − A_D·(A_outer·e₁)` — zero for a translating anim, non-zero the moment the delta rotates or
// scales. The oracle is the same one the rest of this file uses and the only one worth anything: a REBUILD.
//
// THE SCENE MATTERS. A positional claimer spreads its whole subtree RIGIDLY (one `rideDx`), which would make the
// per-node term identically zero and the arm vacuous. So the animated root here is a BOXLESS PASS-THROUGH GROUP,
// whose children each claim their own absolute shift off the squeeze field — and the arms assert that the two
// children's `dx` really do differ before believing anything else.

/** 2100x900 letterboxes to a 2520-wide design box — the widest the mirror ever goes. */
const WIDEST = 2520 / 1920;
/** THE CASE THIS ROUND EXISTS FOR: a maximized 1920x1080 desktop browser, whose content viewport is ~1878x954. */
const MAXIMIZED = ((1878 / 954) * 1080) / 1920;
/** …and the shallow end, where `dx` is small enough that a wrong sign is still a visible drift. */
const NARROW = 1.05;

/**
 * A boxless positioner with two SPREAD-INDEPENDENT painted children, far apart on the field.
 *
 * `Group` paints nothing and has no box, so it passes the widening budget through and each `Sprite2D` claims the
 * field at its OWN centre. `Far` is deliberately near the right edge: the further apart the two claims, the larger
 * `dx_far − dx_near`, and the larger the error a dropped per-node term leaves for the comparison to find.
 */
function spreadScene(): MirrorState {
  return mkState([
    // BOXLESS AND PAINTLESS, both of them. A boxed painting root is a positional claimer: it would CONSUME the
    // widening budget and hand its whole subtree one rigid `rideDx`, which is a legal spread and a vacuous test.
    mkNode("Root", null, { fillColor: null, localRect: null }),
    mkNode("Group", "Root", { fillColor: null, localRect: null, transform: [1, 0, 0, 1, 100, 200] }),
    mkNode("Near", "Group", {
      nodeType: "Godot.Sprite2D",
      localRect: { x: -40, y: -40, width: 80, height: 80 },
      transform: [1, 0, 0, 1, 200, 100]
    }),
    mkNode("Far", "Group", {
      nodeType: "Godot.Sprite2D",
      localRect: { x: -40, y: -40, width: 80, height: 80 },
      transform: [1, 0, 0, 1, 1600, 140]
    }),
    mkNode("Tag", "Group", {
      nodeType: "Godot.Label",
      fillColor: null,
      transform: [1, 0, 0, 1, 1600, 220],
      text: { text: "12" } as never
    }),
    mkNode("Knob", "Group", { mouseFilter: 0, transform: [1, 0, 0, 1, 1600, 300] })
  ]);
}

/** A post conjugation with a real linear part — the case `v` is non-zero for, and the one a bob is not. */
const SPIN_A: LocalAnim = { pre: null, post: [0.99939083, 0.0348995, -0.0348995, 0.99939083, 0, 0] };
const SPIN_B: LocalAnim = { pre: null, post: [0.99026807, 0.13917310, -0.13917310, 0.99026807, 0, 0] };

describe("a widened stage re-poses through the per-node spread term", () => {
  it("publishes each root's own dx and its rebase flag, and both are inert at 16:9", () => {
    const state = spreadScene();
    const dx = new Map<string, number>();
    const wide = buildInto(state, createDrawList<string>(), new Map([["Group", SPIN_A]]), {
      spreadFactor: WIDEST,
      spreadDxOut: dx
    });
    const frame = wide.localAnimFrames.get("Group")!;
    expect(frame.spreadDx).toBe(dx.get("Group"));
    expect(frame.spreadDx).not.toBe(0);
    expect(frame.spreadRebased).toBe(false);
    // THE PRECONDITION THE WHOLE BLOCK RESTS ON: the two children claim DIFFERENT shifts, so the per-node term is
    // actually exercised rather than vacuously equal to the root's.
    expect(Math.abs(dx.get("Far")! - dx.get("Near")!)).toBeGreaterThan(50);

    const flat = buildInto(state, createDrawList<string>(), new Map([["Group", SPIN_A]]));
    expect(flat.localAnimFrames.get("Group")!.spreadDx).toBe(0);
    expect(flat.localAnimFrames.get("Group")!.spreadRebased).toBe(false);
  });

  for (const factor of [NARROW, MAXIMIZED, WIDEST]) {
    it(`agrees with a rebuild for a TRANSLATING bob at factor ${factor.toFixed(4)}`, () => {
      const state = spreadScene();
      const { patched, rebuilt, out } = patchAndRebuild(
        state,
        new Map([["Group", BOB_A]]),
        new Map([["Group", BOB_B]]),
        {},
        factor
      );
      expect(out.ok).toBe(true);
      expect(out.roots).toBe(1);
      expect(out.commands).toBeGreaterThan(0);
      expectArenasAgree(patched, rebuilt);
    });

    it(`agrees with a rebuild for a ROTATING post at factor ${factor.toFixed(4)}`, () => {
      const state = spreadScene();
      const { patched, rebuilt, out } = patchAndRebuild(
        state,
        new Map([["Group", SPIN_A]]),
        new Map([["Group", SPIN_B]]),
        {},
        factor
      );
      expect(out.ok).toBe(true);
      expectArenasAgree(patched, rebuilt);
    });

    it(`agrees with a rebuild for a SCALING post at factor ${factor.toFixed(4)}`, () => {
      // A uniform pulse about the node's own pivot — `idleAnim.pulseScale`'s shape. Its delta's linear part is a
      // scale, so `I − A` has a non-zero first column and the per-node term is live for a second reason than spin.
      const state = spreadScene();
      const { patched, rebuilt, out } = patchAndRebuild(
        state,
        new Map([["Group", { pre: null, post: [1.02, 0, 0, 1.02, -2, -4] }]]),
        new Map([["Group", { pre: null, post: [1.11, 0, 0, 1.11, -11, -22] }]]),
        {},
        factor
      );
      expect(out.ok).toBe(true);
      expectArenasAgree(patched, rebuilt);
    });
  }

  it("re-places the overlay record and the hit entry with THEIR OWN dx, not the root's", () => {
    // Neither of these is in the arenas, so the comparison above cannot see them — and both hang off a node whose
    // spread claim differs from the animated root's, which is exactly where a root-only delta goes wrong.
    const state = spreadScene();
    const spreadDx = new Map<string, number>();
    const patched = createDrawList<string>();
    const build = buildInto(state, patched, new Map([["Group", SPIN_A]]), {
      spreadFactor: WIDEST,
      spreadDxOut: spreadDx
    });
    const tag = build.overlayRecords.find((r) => r.id === "Tag")!;
    const knob = build.hitEntries.find((e) => e.nodeId === "Knob")!;
    const gameWas = [...knob.mGame];

    const env = envFor(state, build, new Map([["Group", SPIN_B]]), { spreadDx });
    const out = newOutcome();
    const work = scratch();
    planTransform(env, patched, work, out);
    expect(out.ok).toBe(true);
    applyTransformPlan(env, patched, build.overlayRecords, build.hitEntries, work, out);
    expect(out.records).toBeGreaterThan(0);
    expect(out.hits).toBeGreaterThan(0);

    const control = buildInto(state, createDrawList<string>(), new Map([["Group", SPIN_B]]), {
      spreadFactor: WIDEST,
      spreadDxOut: new Map<string, number>()
    });
    const wantTag = control.overlayRecords.find((r) => r.id === "Tag")!;
    const wantKnob = control.hitEntries.find((e) => e.nodeId === "Knob")!;
    for (let i = 0; i < 6; i++) {
      expect(tag.transform[i], `record m[${i}]`).toBeCloseTo(wantTag.transform[i], 3);
      expect(knob.mFinal[i], `mFinal[${i}]`).toBeCloseTo(wantKnob.mFinal[i], 3);
    }
    // EVERY hit entry, not just the named one — and `Far` is the discriminating case, because it is a positional
    // claimer whose own field shift differs from the animated group's. A `Knob`-only check passes against a
    // root-only delta (the boxed control RIDES its holder's claim, so its correction is zero); the sweep does not.
    expect(build.hitEntries.length).toBe(control.hitEntries.length);
    for (let e = 0; e < control.hitEntries.length; e++) {
      for (let i = 0; i < 6; i++) {
        expect(build.hitEntries[e].mFinal[i], `hit ${control.hitEntries[e].nodeId} mFinal[${i}]`).toBeCloseTo(
          control.hitEntries[e].mFinal[i],
          3
        );
      }
    }
    expect(spreadDx.get("Far")).not.toBe(spreadDx.get("Group"));
    // The hit-grid invariant survives a widened stage: a tap still sends true 1920-space.
    expect([...knob.mGame]).toEqual(gameWas);
    expect([...knob.mGame]).toEqual([...wantKnob.mGame]);
  });

  it("does not read the dx map at all when the delta is a pure translation", () => {
    // `v = (0, 0)` for a translating delta, which is what makes the widescreen path exactly as cheap as the 16:9
    // one. A reader that fired here would be a per-node map lookup on every node of every idle bob.
    const state = spreadScene();
    const spreadDx = new Map<string, number>();
    const list = createDrawList<string>();
    const build = buildInto(state, list, new Map([["Group", BOB_A]]), {
      spreadFactor: WIDEST,
      spreadDxOut: spreadDx
    });
    let reads = 0;
    const env = envFor(state, build, new Map([["Group", BOB_B]]), {
      spreadDx,
      spreadDxOf: (id) => {
        reads++;
        return spreadDx.get(id) ?? 0;
      }
    });
    const out = newOutcome();
    const work = scratch();
    planTransform(env, list, work, out);
    applyTransformPlan(env, list, build.overlayRecords, build.hitEntries, work, out);
    expect(out.ok).toBe(true);
    expect(out.commands).toBeGreaterThan(0);
    expect(reads).toBe(0);
  });

  it("holds over a full chain of re-poses at a widened factor", () => {
    // Each link measures from the pose the previous one BANKED, and the banked pose now carries `T(dx_root)`. A
    // `C` that dropped it would compound once per link instead of showing up as one frame's error.
    const state = spreadScene();
    const spreadDx = new Map<string, number>();
    const list = createDrawList<string>();
    const build = buildInto(state, list, new Map([["Group", SPIN_A]]), {
      spreadFactor: WIDEST,
      spreadDxOut: spreadDx
    });
    const work = scratch();
    const out = newOutcome();
    let last: Map<string, LocalAnim> = new Map([["Group", SPIN_A]]);
    for (let link = 1; link <= 15; link++) {
      const a = 0.2 * Math.cos((2 * Math.PI * link) / 15);
      last = new Map([["Group", { pre: null, post: [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0] }]]);
      const env = envFor(state, build, last, { spreadDx });
      planTransform(env, list, work, out);
      expect(out.ok, `link ${link}`).toBe(true);
      applyTransformPlan(env, list, build.overlayRecords, build.hitEntries, work, out);
    }
    const rebuilt = createDrawList<string>();
    buildInto(state, rebuilt, last, { spreadFactor: WIDEST, spreadDxOut: new Map<string, number>() });
    expectArenasAgree(list, rebuilt);
  });

  it("names `spread` when the span's field claims were re-derived from the DRAWN pose", () => {
    // `?spreadEndpoint` + a transform override on an ANCESTOR: `applyDrawnFieldRebase` then reads `gRaw`, which
    // carries the idle loop, so `dx` stops being anim-blind and no conjugation by a constant `T(dx)` is correct.
    const state = spreadScene();
    const spreadDx = new Map<string, number>();
    const list = createDrawList<string>();
    const build = buildInto(state, list, new Map([["Group", SPIN_A]]), {
      spreadFactor: WIDEST,
      spreadDxOut: spreadDx,
      // The override is on the ANCESTOR, so the anim root itself still publishes a frame — with the flag raised.
      transformOverrides: new Map([["Root", [1, 0, 0, 1, 12, 0]]])
    });
    expect(build.localAnimFrames.get("Group")!.spreadRebased).toBe(true);
    const before = snapshot(list);
    const out = newOutcome();
    planTransform(envFor(state, build, new Map([["Group", SPIN_B]]), { spreadDx }), list, scratch(), out);
    expect(out.ok).toBe(false);
    expect(out.bail).toBe("spread");
    expect(snapshot(list).floats).toEqual(before.floats);
  });
});

// --- 6: every refusal, by name -------------------------------------------------------------------------------------

describe("the refusals", () => {
  it("names `unknownAnim` for a node the last build published no frame for", () => {
    const state = intentScene();
    const list = createDrawList<string>();
    const build = buildInto(state, list, new Map([["Holder", BOB_A]]));
    // A frame keyed on a node that is NOT in the order at all — the shape a structural move leaves behind.
    const frames = new Map<string, PatchAnimFrame>([
      ["Ghost", build.localAnimFrames.get("Holder")! as PatchAnimFrame]
    ]);
    const out = newOutcome();
    planTransform(envFor(state, build, new Map([["Ghost", BOB_B]]), { animFrames: frames }), list, scratch(), out);
    expect(out.ok).toBe(false);
    expect(out.bail).toBe("unknownAnim");
  });

  it("names `nestedRoots` for a second animated root inside the span", () => {
    const state = intentScene();
    const to = new Map([
      ["Holder", BOB_B],
      ["Sprite", BOB_B]
    ]);
    const list = createDrawList<string>();
    const build = buildInto(state, list, new Map([
      ["Holder", BOB_A],
      ["Sprite", BOB_A]
    ]));
    const out = newOutcome();
    planTransform(envFor(state, build, to), list, scratch(), out);
    expect(out.ok).toBe(false);
    expect(out.bail).toBe("nestedRoots");
  });

  it("names `viewScale` for a candidate in the span — including one with no stamp YET", () => {
    // The set is candidates and not stamps on purpose: a node the anim moves INTO the design stage GAINS one.
    expect(refusalFor({ viewScaleCandidates: new Set(["Sprite"]) }).bail).toBe("viewScale");
  });

  it("names `clipRect` for a clipper in the span, and finds a PAINTLESS one", () => {
    // A clipper that draws nothing has no command range at all, so a kind test over the span's paint would miss
    // it entirely. The build's own `clipRanges` is the detector, which is why the refusal is keyed on that.
    const state = mkState([
      mkNode("Root", null, { localRect: { x: 0, y: 0, width: 1920, height: 1080 } }),
      mkNode("Holder", "Root", { transform: [1, 0, 0, 1, 600, 300] }),
      mkNode("Clipper", "Holder", { fillColor: null, clipContents: true, localRect: { x: 0, y: 0, width: 80, height: 30 } }),
      mkNode("Inside", "Clipper", { transform: [1, 0, 0, 1, 2, 2] })
    ]);
    const list = createDrawList<string>();
    const build = buildInto(state, list, new Map([["Holder", BOB_A]]));
    expect(build.clipRanges.has("Clipper")).toBe(true);
    expect(build.ranges.has("Clipper")).toBe(false); // it painted nothing: no range to inspect
    const out = newOutcome();
    planTransform(envFor(state, build, new Map([["Holder", BOB_B]])), list, scratch(), out);
    expect(out.ok).toBe(false);
    expect(out.bail).toBe("clipRect");
  });

  it("names `spanOffset` for a cosmetic offset BELOW the root, and allows the root's own", () => {
    // The root's own offset is inside `outer` and constant over the span; one further down is not.
    expect(refusalFor({ cosmeticOffsets: new Set(["Sprite"]) }).bail).toBe("spanOffset");
    expect(refusalFor({ cosmeticOffsets: new Set(["Holder"]) }).bail).toBeNull();
  });

  it("names `captured` for a node whose global the eager-scroll engine reads back", () => {
    expect(refusalFor({ captured: new Set(["Sprite"]) }).bail).toBe("captured");
    // …and for the ROOT too: a captured global is refused rather than left stale, wherever it sits.
    expect(refusalFor({ captured: new Set(["Holder"]) }).bail).toBe("captured");
  });

  it("names `backstop` when the stage backstop paints inside the span", () => {
    const state = intentScene();
    const list = createDrawList<string>();
    const build = buildInto(state, list, new Map([["Holder", BOB_A]]));
    const inside = build.order.orderOf("Sprite");
    const out = newOutcome();
    planTransform(envFor(state, build, new Map([["Holder", BOB_B]]), { backstopOrder: inside }), list, scratch(), out);
    expect(out.bail).toBe("backstop");
    // A backstop OUTSIDE the span decides nothing about it.
    expect(refusalFor({ backstopOrder: 0 }).bail).toBeNull();
  });

  it("names `trailQuad` for a comet's ribbon in the span", () => {
    expect(refusalFor({ trailQuads: new Set(["Sprite"]) }).bail).toBe("trailQuad");
  });

  it("names `overlayClip` for a record cropped against a real chain", () => {
    expect(refusalFor({ overlayClipped: new Set(["Label"]) }).bail).toBe("overlayClip");
  });

  it("names `spanOverride` for a DESCENDANT pinned to an absolute pose", () => {
    // The one way the `m = C · g` chain breaks from inside: an overridden descendant does not ride its parent, so
    // a rebuild would leave it where it is while a blanket left-multiply would move it.
    expect(refusalFor({ transformOverrides: new Set(["Sprite"]) }).bail).toBe("spanOverride");
  });

  it("does not ask `isTextDrawn` at all when the delta is a pure translation", () => {
    // The twin of the `spreadDxOf` arm above, and for the same reason: `THE GLYPH TERM`'s test is hoisted to the
    // ROOT because it is a property of the delta. A reader that fired here would be a set lookup on every node of
    // every idle bob — the case this tier exists to make free.
    let reads = 0;
    const { bail } = refusalFor(
      {
        isTextDrawn: (id) => {
          reads++;
          return id === "Label";
        }
      },
      new Map([["Holder", BOB_B]]),
      { glyphSource }
    );
    expect(bail).toBeNull();
    expect(reads).toBe(0);
  });

  it("names `textScale` for a canvas-drawn label under a delta that is NOT a pure translation", () => {
    // A rotation is a linear change, so it re-keys the raster path's digest and can re-route a label between the
    // two text backends. See `THE GLYPH TERM`: the refusal is the delta's, not the node's.
    const { bail, wrote } = refusalFor({}, new Map([["Holder", ROCK_B]]), { glyphSource });
    expect(bail).toBe("textScale");
    expect(wrote).toBe(false);
  });

  it("does NOT name `textScale` for the same rotation when no label is drawn on the canvas", () => {
    // THE CONTROL: without canvas-drawn text `textQuadIds` is empty, so
    // the identical delta over the identical scene patches. A refusal keyed on the node kind would fail here.
    expect(refusalFor({}, new Map([["Holder", ROCK_B]])).bail).toBeNull();
  });

  it("names `polyline` for a stroke in the span — its geometry is baked points, not a matrix", () => {
    const state = mkState([
      mkNode("Root", null, { localRect: { x: 0, y: 0, width: 1920, height: 1080 } }),
      mkNode("Holder", "Root", { transform: [1, 0, 0, 1, 600, 300] }),
      mkNode("Stroke", "Holder", {
        nodeType: "Godot.Line2D",
        fillColor: null,
        linePoints: [0, 0, 20, 20, 40, 30],
        lineWidth: 4,
        lineColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" } as never
      })
    ]);
    const list = createDrawList<string>();
    const build = buildInto(state, list, new Map([["Holder", BOB_A]]));
    expect(build.stats.polylines).toBeGreaterThan(0);
    const out = newOutcome();
    planTransform(envFor(state, build, new Map([["Holder", BOB_B]])), list, scratch(), out);
    expect(out.ok).toBe(false);
    expect(out.bail).toBe("polyline");
  });
});

// --- 7: nothing is written on a bail --------------------------------------------------------------------------------

describe("a refusal leaves the previous frame's list exactly as it was", () => {
  const cases: [string, EnvOverrides][] = [
    ["viewScale", { viewScaleCandidates: new Set(["Sprite"]) }],
    ["spanOffset", { cosmeticOffsets: new Set(["Sprite"]) }],
    ["captured", { captured: new Set(["Sprite"]) }],
    ["trailQuad", { trailQuads: new Set(["Sprite"]) }],
    ["overlayClip", { overlayClipped: new Set(["Label"]) }],
    ["spanOverride", { transformOverrides: new Set(["Sprite"]) }],
    ["textScale", { textDrawn: new Set(["Label"]) }]
  ];
  for (const [name, over] of cases) {
    it(`writes not one float on \`${name}\``, () => {
      const { bail, wrote } = refusalFor(over, name === "textScale" ? new Map([["Holder", ROCK_B]]) : undefined);
      expect(bail).toBe(name);
      // The whole reason planning and applying are two functions: a plan that refused on the LAST root would
      // otherwise leave a frame the renderer cannot fix by rebuilding.
      expect(wrote).toBe(false);
    });
  }
});

// --- 8: the chain ----------------------------------------------------------------------------------------------------

describe("a chain of re-poses", () => {
  it("stays on the rebuild's answer over the whole chain bound, rather than drifting off it", () => {
    // Each link measures its multiplier from the pose the previous link BANKED, so an error would compound. Fifteen
    // links of a bob sampled at 30 fps is half a second, which is the window the bound exists to cap.
    const state = intentScene();
    const list = createDrawList<string>();
    const build = buildInto(state, list, new Map([["Holder", BOB_A]]));
    const work = scratch();
    const out = newOutcome();
    let last: Map<string, LocalAnim> = new Map([["Holder", BOB_A]]);
    for (let link = 1; link <= 15; link++) {
      const dy = -(8 + 10 * Math.cos((2 * Math.PI * link) / 15));
      last = new Map([["Holder", { pre: [1, 0, 0, 1, 0, dy], post: null }]]);
      const env = envFor(state, build, last);
      planTransform(env, list, work, out);
      expect(out.ok, `link ${link}`).toBe(true);
      applyTransformPlan(env, list, build.overlayRecords, build.hitEntries, work, out);
    }
    const rebuilt = createDrawList<string>();
    buildInto(state, rebuilt, last);
    expectArenasAgree(list, rebuilt);
  });

  it("matches forced rebuilds for 600 transform links while intent sources wrap", () => {
    // This is the strict-canvas chain's actual shape: an idle transform and a
    // resident intent source patch share a list, while overlay records and hit
    // entries still exist as semantic metadata despite no overlay host being
    // mounted. Three source frames wrap 200 times over 600 links.
    const state = intentScene();
    const sprite = state.nodes.get("Sprite")!;
    sprite.fillColor = null;
    sprite.textureUrl = "intent-0";
    sprite.textureRegion = { x: 0, y: 0, width: 48, height: 51 };
    sprite.localRect = { x: 0, y: 0, width: 48, height: 51 };

    const list = createDrawList<string>();
    const initial = new Map<string, LocalAnim>([["Holder", BOB_A]]);
    const build = buildInto(state, list, initial);
    const range = build.ranges.get("Sprite")!;
    expect(range.paintEnd).toBe(range.start + 1);
    const transformWork = scratch();
    const sourceWork = createPatchScratch(createQuadView(), createNinePatchView());
    const transformOut = newOutcome();
    const sourceOut: PatchOutcome = { patched: false, bail: null, quads: 0, nodes: 0, visited: 0 };
    let worstArenaRelative = 0;
    let worstPoseRelative = 0;
    let wraps = 0;
    const rebuildCheckpoints = new Set([1, 15, 120, 300, 600]);

    for (let link = 1; link <= 600; link++) {
      const frame = link % 3;
      if (frame === 0) wraps++;
      const phase = (2 * Math.PI * link) / 47;
      const now = new Map<string, LocalAnim>([["Holder", { pre: [1, 0, 0, 1, 0, -10 - 8 * Math.cos(phase)], post: null }]]);
      const region = { x: frame * 48, y: 0, width: 48, height: 51 };
      const replacement = { ...sprite, textureUrl: `intent-${frame}`, textureRegion: region };
      const env = envFor(state, build, now);

      // Renderer order: validate both sides, then source and transform mutate
      // the same list atomically. A source frame changing dimensions would be
      // refused here and force a complete rebuild instead.
      planTransform(env, list, transformWork, transformOut);
      expect(transformOut.ok, `transform link ${link}`).toBe(true);
      planSource(
        [{ id: "Sprite", range, texture: replacement.textureUrl!, srcX: region.x, srcY: region.y, srcW: region.width, srcH: region.height } satisfies SourcePatch<string>],
        list as SourcePatchTarget<string>,
        sourceWork,
        sourceOut
      );
      expect(sourceOut, `source link ${link}`).toMatchObject({ patched: true, bail: null, quads: 0, nodes: 0 });
      applySourcePlan(list as SourcePatchTarget<string>, sourceWork, sourceOut);
      applyTransformPlan(env, list, build.overlayRecords, build.hitEntries, transformWork, transformOut);

      if (rebuildCheckpoints.has(link)) {
        // These forced builds are the oracle, including the final link after
        // 200 source wraps. The intermediate checkpoints make a monotonic
        // accumulation bug visible before the final phase happens to cancel.
        const rebuilt = createDrawList<string>();
        const control = buildInto(state, rebuilt, now, {
          frameSubstitutes: frame === 0 ? null : new Map([["Sprite", replacement]])
        });
        expectTexturesAgree(list, rebuilt);
        expectArenasAgree(list, rebuilt);
        worstArenaRelative = Math.max(worstArenaRelative, maxArenaRelativeDifference(list, rebuilt));
        worstPoseRelative = Math.max(worstPoseRelative, maxPoseRelativeDifference(build, control));
      }
    }

    expect(wraps).toBe(200);
    // Quantified numerical budget. This 600-link corpus peaks at 2.052e-7
    // relative in the Float32 arena (under three ULP); record/hit matrices
    // are bit-identical. The production strict path rebuilds at this bound.
    expect(worstArenaRelative).toBeLessThanOrEqual(3 * F32_ULP);
    expect(worstPoseRelative).toBe(0);
  });
});
