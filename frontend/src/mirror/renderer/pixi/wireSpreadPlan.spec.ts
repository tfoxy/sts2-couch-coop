// `rustWireSpreadPatch`'s planner against the build itself: a span re-posed by its per-node drawn deltas must draw
// exactly what a full build of the moved scene draws (commands' node matrices, hit `mFinal`/`mGame`/`spreadDx`, and
// the banked spread shifts), on a widened stage and at 16:9 under an inherited cosmetic offset.
import { describe, expect, it } from "vitest";
import { createDrawList } from "@godot-scene-web/canvas";

import { affineInverse, affineMul, type Affine } from "@/mirror/affine";
import { buildDrawList, type CosmeticOffset } from "@/mirror/canvas/buildDrawList";
import { resolveSceneInfo } from "@/mirror/canvas/hitTest";
import { spreadSceneIdentityEnv } from "@/mirror/renderer/staticBackgroundPolicy";
import { createMirrorState, MIRROR_DESIGN_WIDTH, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";
import { planWireSpread, type WireSpreadPlan, type WireSpreadRefusal } from "./wireSpreadPlan";

const F = 2520 / MIRROR_DESIGN_WIDTH;

function mkNode(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
  return { id, parentId, name: id, nodeType: "Godot.Control", showBehindParent: false, clipChildren: 0, clipContents: false,
    ninePatchMargins: null, font: null, richBoldFont: null, richItalicFont: null, richBoldItalicFont: null,
    richBoldFontSizePx: null, richItalicFontSizePx: null, richBoldItalicFontSizePx: null, richBoldFontSpacingPx: null,
    richItalicFontSpacingPx: null, richBoldItalicFontSpacingPx: null, textWrap: null, shadow: null, richText: false,
    shaderId: null, materialRef: null, shaderParams: null, textureStretchMode: null, textureFlipH: false, textureFlipV: false,
    particleSpec: null, particleEmitting: false, particleRestartEpoch: 0, spineSceneResPath: null, spineNodePath: null,
    spineAnimations: null, spineSkelResPath: null, sceneFilePath: null, mouseFilter: null, anchorLeft: null, anchorRight: null,
    anchorOwnerId: null, containerLayout: null, contentKey: null, spineCurrentAnim: null, spineSkin: null, spineMat: null,
    spinePaused: false, spineTrackTime: 0, spineLooping: true, pinnedLoopAnim: null, outline: null,
    transform: [1, 0, 0, 1, 0, 0], localRect: { x: 0, y: 0, width: 100, height: 100 }, visible: true, focused: false,
    opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, pivotX: 0, pivotY: 0, zIndex: null, textureUrl: null, textureRegion: null,
    textureMargin: null, ninePatch: false, modulate: null, selfModulate: null,
    fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffffff" }, range: null, text: null, intentFrames: null, linePoints: null,
    lineWidth: null, lineColor: null, ...over } as MirrorNode;
}

const rot = (deg: number, k: number, x: number, y: number): Affine => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r) * k, s = Math.sin(r) * k;
  return [c, s, -s, c, x, y];
};
/** A uniform scale `k` about local point (cx, cy), then placed at (x, y). */
const pulse = (k: number, cx: number, cy: number, x: number, y: number): Affine => [k, 0, 0, k, x + cx - k * cx, y + cy - k * cy];

/** The anchored stage, a targeting arrow (a box-less group of rotated sprite segments) and a creature with a reticle. */
function scene(over: Record<string, Affine> = {}, extra: MirrorNode[] = []): MirrorNode[] {
  const t = (id: string, fallback: Affine) => over[id] ?? fallback;
  return [
    mkNode("stage", null, { anchorLeft: 0, anchorRight: 1, localRect: { x: 0, y: 0, width: 1920, height: 1080 }, fillColor: null }),
    mkNode("targets", "stage", { nodeType: "Godot.Node2D", localRect: null, fillColor: null }),
    mkNode("arrow", "targets", { nodeType: "Godot.Node2D", localRect: null, fillColor: null, transform: t("arrow", [1, 0, 0, 1, 0, 0]) }),
    ...[0, 1, 2].map((i) => mkNode(`seg${i}`, "arrow", { nodeType: "Godot.Sprite2D", localRect: { x: -20, y: -10, width: 40, height: 20 },
      transform: t(`seg${i}`, rot(20 * i - 15, 1 + 0.1 * i, 700 + 160 * i, 600 - 70 * i)) })),
    mkNode("creature", "stage", { nodeType: "Godot.Node2D", localRect: null, fillColor: null, transform: t("creature", [1, 0, 0, 1, 1400, 640]) }),
    mkNode("reticle", "creature", { anchorLeft: 0, anchorRight: 0, mouseFilter: 0, localRect: { x: 0, y: 0, width: 200, height: 200 },
      fillColor: null, transform: t("reticle", [1, 0, 0, 1, -100, -100]) }),
    ...[0, 1, 2, 3].map((i) => mkNode(`border${i}`, "reticle", { anchorLeft: 0, anchorRight: 0,
      localRect: { x: 0, y: 0, width: 40, height: 40 }, transform: [1, 0, 0, 1, (i % 2) * 160, Math.floor(i / 2) * 160] })),
    ...extra,
  ];
}

function stateOf(nodes: MirrorNode[]): MirrorState {
  const state = createMirrorState();
  for (const node of nodes) state.nodes.set(node.id, node);
  state.orderedIds = nodes.map((node) => node.id);
  return state;
}

function built(nodes: MirrorNode[], factor: number, offsets: ReadonlyMap<string, CosmeticOffset> | null) {
  const state = stateOf(nodes);
  const dx = new Map<string, number>(), modes = new Map<string, number>();
  const build = buildDrawList(state, createDrawList<string>(), { spreadFactor: factor, spreadDxOut: dx, spreadFieldModeOut: modes,
    cosmeticOffsets: offsets, assert: true });
  return { state, build, dx, modes };
}

function gameGlobal(nodes: ReadonlyMap<string, MirrorNode>, id: string): Affine {
  const chain: MirrorNode[] = [];
  for (let node = nodes.get(id); node; node = node.parentId ? nodes.get(node.parentId) : undefined) chain.push(node);
  let pose: Affine = [1, 0, 0, 1, 0, 0];
  for (let i = chain.length - 1; i >= 0; i--) pose = affineMul(pose, chain[i].transform as Affine);
  return pose;
}

type Options = { factor?: number; offsets?: Record<string, CosmeticOffset>; ownerReads?: string[]; followerPoints?: number[];
  extra?: MirrorNode[]; bank?: (dx: Map<string, number>) => void };

function plan(root: string, moved: Affine, options: Options = {}) {
  const factor = options.factor ?? F;
  const offsets = new Map(Object.entries(options.offsets ?? {}));
  const before = built(scene({}, options.extra), factor, offsets);
  const after = built(scene({ [root]: moved }, options.extra), factor, offsets);
  const gOld = gameGlobal(before.state.nodes, root), gNew = gameGlobal(after.state.nodes, root);
  const delta = affineMul(gNew, affineInverse(gOld)!);
  options.bank?.(before.dx);
  const result = planWireSpread({ rootId: root, before: before.state.nodes, after: after.state.nodes, order: before.build.order,
    gOld, gNew, delta, drawnRoot: before.build.nodePaintInputs.get(root)?.global ?? null, spreadFactor: factor,
    dx: factor === 1 ? new Map() : before.dx, ownerReads: new Set(options.ownerReads ?? []), followerPoints: options.followerPoints ?? [],
    hitsOf: (id) => before.build.hitEntries.filter((entry) => entry.nodeId === id),
    clipRanges: before.build.clipRanges,
    sceneEnv: spreadSceneIdentityEnv((id) => resolveSceneInfo(id, after.state.nodes)), ancestorCache: new Map() });
  return { before, after, delta, result };
}

const close = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Array.from(a).every((value, i) => Math.abs(value - b[i]) <= 1e-9 * Math.max(1, Math.abs(value), Math.abs(b[i])));

/** Every node of the span: patched pose == rebuilt pose, hits included, and the bank moves to the rebuilt shifts. */
function expectExact(root: string, moved: Affine, options: Options = {}): WireSpreadPlan {
  const { before, after, delta, result } = plan(root, moved, options);
  if ("reason" in result) throw new Error(`refused: ${result.reason} at ${result.id}`);
  const span = before.build.order.entries.get(root)!;
  for (let order = span.spanStart; order < span.spanEnd; order++) {
    const id = before.build.order.ids[order];
    const step = result.nodeDeltas?.get(id) ?? result.uniform;
    const was = before.build.nodePaintInputs.get(id)!.global, now = after.build.nodePaintInputs.get(id)!.global;
    expect([id, close(affineMul(step, was), now)], `${id}: ${affineMul(step, was)} vs ${now}`).toEqual([id, true]);
    if ((options.factor ?? F) !== 1) expect([id, result.dx.get(id) ?? before.dx.get(id)]).toEqual([id, after.dx.get(id)]);
    const hitWas = before.build.hitEntries.find((entry) => entry.nodeId === id);
    const hitNow = after.build.hitEntries.find((entry) => entry.nodeId === id);
    if (hitWas && hitNow) {
      expect(close(affineMul(step, hitWas.mFinal), hitNow.mFinal)).toBe(true);
      expect(close(affineMul(delta, hitWas.mGame), hitNow.mGame)).toBe(true);
      expect(result.dx.get(id) ?? hitWas.spreadDx).toBeCloseTo(hitNow.spreadDx, 9);
    }
  }
  return result;
}

const refusalOf = (root: string, moved: Affine, options: Options = {}) => {
  const { result } = plan(root, moved, options);
  return "reason" in result ? (result as WireSpreadRefusal).reason : null;
};

describe("planWireSpread (rustWireSpreadPatch)", () => {
  it("re-poses a rotated, scaled arrow segment at its new field claim", () => {
    const result = expectExact("seg1", rot(40, 1.3, 900, 520));
    expect(result.dx.has("seg1")).toBe(true);
    expect(result.reposed).toBe(true);
  });

  it("re-poses every nested claimer when the arrow group itself turns", () => {
    const result = expectExact("arrow", rot(-12, 0.9, 140, -60));
    // The group claims at its origin, each segment at its own centre: four different shifts.
    expect(new Set(["arrow", "seg0", "seg1", "seg2"].map((id) => result.dx.get(id))).size).toBe(4);
  });

  it("keeps a reticle's ridden shift under a pulsing scale, and moves it with its creature", () => {
    const pulsed = expectExact("reticle", pulse(1.08, 100, 100, -100, -100));
    expect(pulsed.dx.size).toBe(0);
    expect(pulsed.nodeDeltas?.size).toBeGreaterThan(0); // the scale turns about the SHIFTED pose
    const moved = expectExact("creature", [1, 0, 0, 1, 1250, 610]);
    for (const id of ["creature", "reticle", "border0", "border3"]) expect(moved.dx.has(id)).toBe(true);
  });

  it("is exact under an inherited cosmetic offset, widened and at 16:9", () => {
    const offsets = { creature: { dx: 12, dy: -40 } };
    expectExact("reticle", pulse(0.94, 100, 100, -100, -100), { offsets });
    const flat = expectExact("reticle", pulse(0.94, 100, 100, -100, -100), { offsets, factor: 1 });
    expect(flat.nodeDeltas).toBeNull();
    expect(flat.reposed).toBe(true); // T(O)·D·T(−O), where a plain wire patch drew D
    expect(expectExact("reticle", [1, 0, 0, 1, -90, -100], { offsets, factor: 1 }).reposed).toBe(false);
  });

  it("follows each claimer across the field's clamp at 1920 and at 0", () => {
    const right = expectExact("seg2", rot(70, 1.6, 1935, 300));
    expect(right.dx.get("seg2")).toBeCloseTo(MIRROR_DESIGN_WIDTH * (F - 1), 9);
    expectExact("seg0", rot(-80, 2, -25, 700));
    // The group swings its segments across both edges at once.
    expectExact("arrow", rot(35, 1.4, 1100, -200));
    expectExact("arrow", rot(-35, 1.4, -800, 300));
  });

  it("refuses what a re-walk cannot answer for", () => {
    const floater = mkNode("tip", "reticle", { anchorOwnerId: "seg0", localRect: { x: 0, y: 0, width: 30, height: 30 } });
    expect(refusalOf("reticle", pulse(1.05, 100, 100, -100, -100), { extra: [floater] })).toBe("wire-spread-floater");
    const follower = mkNode("cursor", "arrow", { nodeType: "Game.NRemoteTargetingIndicator", localRect: { x: 0, y: 0, width: 10, height: 10 } });
    expect(refusalOf("arrow", [1, 0, 0, 1, 30, 0], { extra: [follower] })).toBe("wire-spread-follower");
    // A floater elsewhere resolved against a node whose shift moves; any follower resolution at all.
    expect(refusalOf("seg1", rot(10, 1, 950, 560), { ownerReads: ["seg1"] })).toBe("wire-spread-owner");
    expect(refusalOf("seg1", rot(10, 1, 950, 560), { ownerReads: ["border2"] })).toBeNull();
    // A follower resolved at a point a span hit covers, before or after the move; one elsewhere does not matter.
    // (A painting, mouse-visible hit is what a follower resolves against.)
    const badge = [mkNode("badge", "reticle", { mouseFilter: 0, localRect: { x: 0, y: 0, width: 200, height: 200 } })];
    expect(refusalOf("reticle", pulse(1.05, 100, 100, -100, -100), { extra: badge, followerPoints: [1400, 640, 0] })).toBe("wire-spread-follower-hit");
    expect(refusalOf("creature", [1, 0, 0, 1, 1100, 640], { extra: badge, followerPoints: [1050, 640, 0] })).toBe("wire-spread-follower-hit");
    expect(refusalOf("creature", [1, 0, 0, 1, 1100, 640], { extra: badge, followerPoints: [200, 200, 0] })).toBeNull();
    // A moved shift with a clipper in the span; a non-translation over an offset owner inside it.
    const clipper = mkNode("clip", "arrow", { localRect: { x: 0, y: 0, width: 50, height: 50 }, clipContents: true, nodeType: "Godot.Sprite2D" });
    expect(refusalOf("arrow", [1, 0, 0, 1, 30, 0], { extra: [clipper] })).toBe("wire-spread-clip");
    // A bank this re-walk does not reproduce (here: tampered) is never trusted.
    expect(refusalOf("seg1", rot(10, 1, 950, 560), { bank: (dx) => dx.set("arrow", 3) })).toBe("wire-spread-context");
    expect(refusalOf("seg1", rot(10, 1, 950, 560), { bank: (dx) => dx.set("seg1", 3) })).toBe("wire-spread-context");
  });

  // An offset owner BELOW the root rides its parent's drawn linear, which the move turns: no refusal, and exact.
  it.each([[F], [1]])("re-poses a rotate/scale delta over an offset owner below the root exactly (stretch %s)", (factor) => {
    const offsets = { reticle: { dx: 6, dy: -20 }, border2: { dx: -4, dy: 9 }, creature: { dx: 3, dy: -12 } };
    expectExact("creature", rot(7, 1.1, 1380, 660), { offsets, factor });
    expectExact("reticle", pulse(1.08, 100, 100, -100, -100), { offsets, factor });
    expectExact("arrow", rot(-9, 0.92, 60, -40), { offsets: { seg1: { dx: 5, dy: -7 } }, factor });
  });

  it("leaves a pure Y move of a claimer as one uniform delta", () => {
    const result = expectExact("seg1", rot(5, 1.1, 860, 400 + 70));
    expect(result.dx.size).toBe(0);
    expect(result.nodeDeltas).toBeNull();
  });
});

// `rustTweenRootPatch`: the same planner over an override root. The override is the root's absolute rendered pose;
// the span's game globals stay, its rendered ones move by `Δ`, and every field claim re-bases at the drawn pose.
describe("planWireSpread over a tween root (rustTweenRootPatch)", () => {
  /** A hand holder (box-less) with a face, a positional gem claimer and a hitbox, on the anchored stage. */
  const holderScene = (): MirrorNode[] => [
    mkNode("stage", null, { anchorLeft: 0, anchorRight: 1, localRect: { x: 0, y: 0, width: 1920, height: 1080 }, fillColor: null }),
    mkNode("hand", "stage", { nodeType: "Godot.Control", localRect: null, fillColor: null }),
    mkNode("holder", "hand", { nodeType: "Game.NHandCardHolder", localRect: null, fillColor: null, transform: [1, 0, 0, 1, 900, 880] }),
    mkNode("face", "holder", { anchorLeft: 0, anchorRight: 0, mouseFilter: 0, localRect: { x: -80, y: -110, width: 160, height: 220 } }),
    mkNode("gem", "holder", { nodeType: "Godot.Sprite2D", localRect: { x: -12, y: -12, width: 24, height: 24 }, transform: [1, 0, 0, 1, 40, -90] }),
    mkNode("faceLabel", "face", { anchorLeft: 0, anchorRight: 0, localRect: { x: 0, y: 0, width: 120, height: 30 }, transform: [1, 0, 0, 1, 20, 150] }),
  ];
  const builtWith = (override: Affine, factor: number, offsets: Map<string, CosmeticOffset>) => {
    const state = stateOf(holderScene());
    const dx = new Map<string, number>();
    const build = buildDrawList(state, createDrawList<string>(), { spreadFactor: factor, spreadDxOut: dx,
      transformOverrides: new Map([["holder", override]]), cosmeticOffsets: offsets, assert: true });
    return { state, build, dx };
  };

  it.each([[F, null], [F, { dx: 0, dy: -60 }], [1, { dx: 8, dy: -60 }]] as const)(
    "re-poses a pick-up sample exactly (stretch %s, holder offset %j)", (factor, lift) => {
    const offsets = new Map(lift ? [["holder", lift as CosmeticOffset]] : []);
    // Two samples of an Expo-Out pick-up: up, shrinking toward 0.8, across the field.
    for (const [from, to] of [[[0.95, 0, 0, 0.95, 905, 860], [0.84, 0, 0, 0.84, 930, 812]], [[1, 0, 0, 1, 1880, 880], [0.8, 0.05, -0.05, 0.8, 1990, 830]]] as Array<[Affine, Affine]>) {
      const before = builtWith(from, factor, offsets), after = builtWith(to, factor, offsets);
      const g = gameGlobal(before.state.nodes, "holder");
      const result = planWireSpread({ rootId: "holder", before: before.state.nodes, after: before.state.nodes,
        order: before.build.order, gOld: g, gNew: g, delta: affineMul(to, affineInverse(from)!), rendered: { old: from, now: to },
        gameDelta: [1, 0, 0, 1, 0, 0], tag: "tween-root", drawnRoot: before.build.nodePaintInputs.get("holder")!.global,
        spreadFactor: factor, dx: factor === 1 ? new Map() : before.dx, ownerReads: new Set(), followerPoints: [],
        hitsOf: () => undefined, clipRanges: before.build.clipRanges,
        sceneEnv: spreadSceneIdentityEnv((id) => resolveSceneInfo(id, before.state.nodes)), ancestorCache: new Map() });
      if ("reason" in result) throw new Error(`refused: ${result.reason} at ${result.id}`);
      for (const id of ["holder", "face", "gem", "faceLabel"]) {
        const step = result.nodeDeltas?.get(id) ?? result.uniform;
        const was = before.build.nodePaintInputs.get(id)!.global, now = after.build.nodePaintInputs.get(id)!.global;
        expect([id, close(affineMul(step, was), now)], `${id}: ${affineMul(step, was)} vs ${now}`).toEqual([id, true]);
        if (factor !== 1) expect([id, result.dx.get(id) ?? before.dx.get(id)]).toEqual([id, after.dx.get(id)]);
        const hitWas = before.build.hitEntries.find((entry) => entry.nodeId === id), hitNow = after.build.hitEntries.find((entry) => entry.nodeId === id);
        if (hitWas && hitNow) {
          expect(close(affineMul(step, hitWas.mFinal), hitNow.mFinal)).toBe(true);
          expect(hitWas.mGame).toEqual(hitNow.mGame); // an override never reaches the game pose
        }
      }
      // Inside the field the gem claims a new shift; the second pair sits past the clamp at 1920 on both sides.
      expect(result.dx.has("gem")).toBe(factor !== 1 && from[4] < 1500);
    }
  });
});
