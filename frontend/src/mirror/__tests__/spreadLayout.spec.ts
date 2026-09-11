// THE WIDE-SCREEN SPREAD ALGEBRA, as a pure function.
//
// `spreadLayout.ts` is the ONE copy of the squeeze-field rules both mirror backends place nodes with (the DOM
// walk's `visit`, the canvas walk in `buildDrawList`). Its whole reason to exist is that two transcriptions could
// not stay in step — so these are the tests that pin the algebra itself, with no renderer, no DOM and no browser
// anywhere near them: plain nodes in, plain numbers out.
//
// The two load-bearing properties:
//   * AT 16:9 IT IS THE IDENTITY. `spreadFactor === 1` must leave every node at dx 0 with no width override, on
//     every branch. That is what makes a 16:9 viewer provably unaffected by any of this.
//   * AT 2100x900 IT IS NOT. Each branch claims its own documented share of the widening budget, and the shares
//     compose down a chain the way the walk threads them.

import { describe, expect, it } from "vitest";
import { normalizeParticleSpecConfig } from "@godot-scene-web/html/runtime";

import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH, MIRROR_MAX_DESIGN_WIDTH, type MirrorNode } from "@/mirror/sceneTree";
import {
  applyDrawnFieldRebase,
  childParentWidth,
  computeSpread,
  containerHAlignFactor,
  createSpreadOut,
  fieldDxAtCenter,
  fieldDxAtOriginX,
  rootSpreadCtx,
  spreadCenterGx,
  spreadDrawBox,
  type SpreadCtx,
  type SpreadEnv,
  type SpreadOut
} from "@/mirror/spreadLayout";

/**
 * The widened stage this file measures against — derived exactly as `MirrorView.design` derives it, so the
 * numbers below are the ones a real 2100x900 viewer gets: a 2100x900 viewport wants `round(2100/900·1080)` =
 * 2520 design px, which is also the cap (`MIRROR_MAX_DESIGN_WIDTH`), and `F = designW / 1920`.
 */
const DESIGN_W = Math.min(MIRROR_MAX_DESIGN_WIDTH, Math.round((2100 / 900) * MIRROR_DESIGN_HEIGHT));
const F = DESIGN_W / MIRROR_DESIGN_WIDTH;
/** The whole widening budget the root hands down at F — ~600 design px of extra stage. */
const BUDGET = (F - 1) * MIRROR_DESIGN_WIDTH;

function mkNode(id: string, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId: null,
    name: id,
    nodeType: "Godot.Control",
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
    localRect: { x: 0, y: 0, width: 100, height: 100 },
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
    fillColor: null,
    range: null,
    text: null,
    intentFrames: null,
    linePoints: null,
    lineWidth: null,
    lineColor: null,
    ...over
  };
}

/** The "no exceptions apply" env: every scene-identity rule says no, no owner, no follower. */
function plainEnv(over: Partial<SpreadEnv> = {}): SpreadEnv {
  return {
    isBackgroundSceneRoot: () => false,
    isPreviewContainer: () => false,
    forcesCenterClaim: () => false,
    ownerDx: (_ownerId, fallbackDx) => fallbackDx,
    remoteFollowerDx: () => null,
    ...over
  };
}

function at(x: number, y = 0): number[] {
  return [1, 0, 0, 1, x, y];
}

/** Run one node through the algebra and hand back a FRESH result (never the shared scratch). */
function run(
  node: MirrorNode,
  ctx: SpreadCtx,
  g: readonly number[],
  spreadFactor: number,
  env: SpreadEnv = plainEnv()
): SpreadOut {
  const out = createSpreadOut();
  computeSpread(node.id, node, ctx, g, spreadDrawBox(node), spreadFactor, env, out);
  return { ...out };
}

/** The ctx a child inherits from a parent's result — the same threading both walks do. */
function childCtx(parent: MirrorNode, ctx: SpreadCtx, out: SpreadOut, parentGlobal: readonly number[]): SpreadCtx {
  return {
    parentDx: out.childParentDx,
    deltaParentWidth: out.childDeltaParentWidth,
    anchorDelta: out.childAnchorDelta,
    rideDx: out.childRideDx,
    parentDxProp: out.childParentDxProp,
    parentWidth: childParentWidth(parent, ctx.parentWidth),
    parentGlobal,
    containerChildAlign: out.childContainerAlign,
    containerChildVertical: out.childContainerVertical
  };
}

describe("spreadLayout — the field", () => {
  it("is the identity at spreadFactor 1", () => {
    expect(fieldDxAtOriginX(0, 1)).toBe(0);
    expect(fieldDxAtOriginX(960, 1)).toBe(0);
    expect(fieldDxAtOriginX(1920, 1)).toBe(0);
  });

  it("shifts a game X by gameX·(F−1), clamped to the design viewport", () => {
    expect(fieldDxAtOriginX(0, 1.5)).toBeCloseTo(0, 6);
    expect(fieldDxAtOriginX(960, 1.5)).toBeCloseTo(480, 6);
    expect(fieldDxAtOriginX(1920, 1.5)).toBeCloseTo(960, 6);
    // Out-of-bounds content (a >1920-wide bg's off-screen edge) must not over-shift.
    expect(fieldDxAtOriginX(4000, 1.5)).toBeCloseTo(960, 6);
    expect(fieldDxAtOriginX(-500, 1.5)).toBeCloseTo(0, 6);
  });

  it("evaluates the CENTRE field through the node's own basis", () => {
    const node = mkNode("n", { localRect: { x: 0, y: 0, width: 200, height: 100 } });
    // Origin at 400, box 200 wide → centre at 500.
    expect(spreadCenterGx(at(400), node, { x: 0, y: 0 })).toBeCloseTo(500, 6);
    expect(fieldDxAtCenter(at(400), node, { x: 0, y: 0 }, 1.5)).toBeCloseTo(250, 6);
    // A node SCALED by 2 has its centre twice as far from its origin.
    expect(spreadCenterGx([2, 0, 0, 2, 400, 0], node, { x: 0, y: 0 })).toBeCloseTo(600, 6);
    // A box-less node anchors at its origin.
    expect(spreadCenterGx(at(400), node, null)).toBeCloseTo(400, 6);
  });
});

describe("spreadLayout — containerHAlignFactor", () => {
  it("maps the streamed BoxContainer hint to its horizontal redistribution", () => {
    expect(containerHAlignFactor(null)).toBeNull();
    expect(containerHAlignFactor("")).toBeNull();
    expect(containerHAlignFactor("grid")).toBeNull();
    expect(containerHAlignFactor("hbox-begin")).toBe(0);
    expect(containerHAlignFactor("hbox-center")).toBe(0.5);
    expect(containerHAlignFactor("hbox-end")).toBe(1);
    // A vertical box redistributes nothing horizontally, but is still INTERCEPTED (0, never null) so its child
    // does not run the Godot-ignored anchor algebra.
    expect(containerHAlignFactor("vbox-center")).toBe(0);
    expect(containerHAlignFactor("vbox-begin")).toBe(0);
  });
});

describe("spreadLayout — identity at 16:9", () => {
  const root = rootSpreadCtx(1, [1, 0, 0, 1, 0, 0]);

  it("hands the root a zero budget", () => {
    expect(root.deltaParentWidth).toBe(0);
    expect(root.anchorDelta).toBe(0);
    expect(root.parentWidth).toBe(MIRROR_DESIGN_WIDTH);
  });

  it("leaves EVERY branch's node at dx 0 with no width override", () => {
    const cases: MirrorNode[] = [
      mkNode("plain"),
      mkNode("boxless", { localRect: null }),
      mkNode("anchored", { anchorLeft: 0, anchorRight: 1 }),
      mkNode("pinned", { anchorLeft: 0, anchorRight: 0 }),
      mkNode("control", { mouseFilter: 0 }),
      mkNode("floater", { anchorOwnerId: "someone" }),
      mkNode("hbox", { containerLayout: "hbox-center", anchorLeft: 0, anchorRight: 1 })
    ];
    for (const node of cases) {
      // Even an env whose every exception FIRES cannot move a node at F = 1.
      const env = plainEnv({
        isBackgroundSceneRoot: () => true,
        isPreviewContainer: () => true,
        forcesCenterClaim: () => true,
        ownerDx: () => 999,
        remoteFollowerDx: () => 777
      });
      const out = run(node, root, at(400), 1, env);
      expect(out.dx, node.id).toBe(0);
      expect(out.renderWidthOverride, node.id).toBe(0);
      expect(out.fieldMode, node.id).toBe(0);
      expect(out.spreadMode, node.id).toBe(false);
      expect(out.childContainerAlign, node.id).toBeNull();
      expect(out.childDeltaParentWidth, node.id).toBe(0);
      expect(out.childParentDx, node.id).toBe(0);
      expect(out.childRideDx, node.id).toBe(0);
    }
  });
});

describe("spreadLayout — non-identity at 2100x900", () => {
  const root = rootSpreadCtx(F, [1, 0, 0, 1, 0, 0]);

  it("opens a real budget at the root", () => {
    expect(DESIGN_W).toBe(2520);
    expect(F).toBeCloseTo(1.3125, 9);
    expect(root.deltaParentWidth).toBeCloseTo(BUDGET, 6);
    expect(BUDGET).toBeCloseTo(600, 6); // 600 design px of extra stage at 2100x900
  });

  it("a 0/1-anchored Control pins left and STRETCHES by the whole budget", () => {
    const node = mkNode("stretch", { anchorLeft: 0, anchorRight: 1, localRect: { x: 0, y: 0, width: 1920, height: 100 } });
    const out = run(node, root, at(0), F);
    expect(out.dx).toBeCloseTo(0, 6);
    expect(out.renderWidthOverride).toBeCloseTo(1920 + BUDGET, 6);
    expect(out.childDeltaParentWidth).toBeCloseTo(BUDGET, 6);
    expect(out.fieldMode).toBe(0); // the anchor algebra is not a function of the node's own X
  });

  it("a 1/1-anchored Control hugs the right edge and does not stretch", () => {
    const node = mkNode("right", { anchorLeft: 1, anchorRight: 1, localRect: { x: 0, y: 0, width: 200, height: 100 } });
    const out = run(node, root, at(1720), F);
    expect(out.dx).toBeCloseTo(BUDGET, 6);
    expect(out.renderWidthOverride).toBe(0);
  });

  it("a 0.5/0.5-anchored Control re-centres on half the budget", () => {
    const node = mkNode("centre", { anchorLeft: 0.5, anchorRight: 0.5, localRect: { x: 0, y: 0, width: 200, height: 100 } });
    const out = run(node, root, at(860), F);
    expect(out.dx).toBeCloseTo(0.5 * BUDGET, 6);
  });

  it("a small 0/0-anchored corner widget KEEPS its corner", () => {
    const node = mkNode("corner", { anchorLeft: 0, anchorRight: 0, localRect: { x: 0, y: 0, width: 208, height: 68 } });
    expect(run(node, root, at(20), F).dx).toBeCloseTo(0, 6);
  });

  it("…but a 0/0-anchored box that covers the WHOLE frame is background art and re-centres", () => {
    const node = mkNode("art", { anchorLeft: 0, anchorRight: 0, localRect: { x: 0, y: 0, width: 1920, height: 1080 } });
    expect(run(node, root, at(0), F).dx).toBeCloseTo(0.5 * BUDGET, 6);
  });

  it("the scene-identity exception forces the same 0.5 claim on a small 0/0 widget", () => {
    const node = mkNode("DrawingTools", { anchorLeft: 0, anchorRight: 0, localRect: { x: 0, y: 0, width: 208, height: 68 } });
    const env = plainEnv({ forcesCenterClaim: (id) => id === "DrawingTools" });
    expect(run(node, root, at(20), F, env).dx).toBeCloseTo(0.5 * BUDGET, 6);
  });

  it("a boxless pass-through group takes its ORIGIN field claim and PASSES the budget through", () => {
    const group = mkNode("group", { localRect: null });
    const out = run(group, root, at(600), F);
    expect(out.dx).toBeCloseTo(fieldDxAtOriginX(600, F), 6);
    expect(out.fieldMode).toBe(1);
    expect(out.spreadMode).toBe(true);
    // The budget survives for the children — each measures its OWN absolute claim…
    expect(out.childDeltaParentWidth).toBeCloseTo(BUDGET, 6);
    expect(out.childParentDx).toBe(0); // …against the INHERITED baseline, not the group's own shift
    // …but the group's zero-size box is no anchor frame, and boxed Control children ride its ONE claim.
    expect(out.childAnchorDelta).toBe(0);
    expect(out.childRideDx).toBeCloseTo(out.dx, 6);
  });

  it("world content claims the field at its own CENTRE and CONSUMES the budget", () => {
    const sprite = mkNode("sprite", { nodeType: "Godot.Sprite2D", localRect: { x: -50, y: -50, width: 100, height: 100 } });
    const out = run(sprite, root, at(600), F);
    expect(out.dx).toBeCloseTo(fieldDxAtOriginX(600, F), 6); // centred box → centre IS the origin
    expect(out.fieldMode).toBe(2);
    expect(out.childDeltaParentWidth).toBe(0);
    expect(out.childParentDx).toBeCloseTo(out.dx, 6);
  });

  it("a boxed Control under a zero anchor-frame RIDES its entity's one shift", () => {
    // The card holder is a boxless group; its EnergyIcon is a boxed Control with no usable anchor frame.
    const holder = mkNode("holder", { localRect: null });
    const holderOut = run(holder, root, at(700), F);
    const kidCtx = childCtx(holder, root, holderOut, at(700));

    const icon = mkNode("EnergyIcon", { mouseFilter: 0, anchorLeft: 0, anchorRight: 0, localRect: { x: 0, y: 0, width: 40, height: 40 } });
    const iconOut = run(icon, kidCtx, at(660), F);
    expect(iconOut.dx).toBeCloseTo(holderOut.dx, 6); // the WHOLE entity moves as one — no per-part drift
    expect(iconOut.spreadMode).toBe(true);
    expect(iconOut.fieldMode).toBe(0); // its dx is the holder's claim, not its own X
  });

  it("a widened H-box re-lays its packed row out, and its children ignore their own anchors", () => {
    const box = mkNode("Row", {
      anchorLeft: 0,
      anchorRight: 1,
      containerLayout: "hbox-end",
      localRect: { x: 0, y: 0, width: 1920, height: 120 }
    });
    const boxOut = run(box, root, at(0), F);
    expect(boxOut.childContainerAlign).toBe(1);
    expect(boxOut.childContainerVertical).toBe(false);

    const kidCtx = childCtx(box, root, boxOut, at(0));
    // A 0/0-anchored child (the reward screen's "Skip") would strand LEFT under the anchor algebra; the box's
    // own end-alignment carries it the whole way instead.
    const skip = mkNode("Skip", { anchorLeft: 0, anchorRight: 0, localRect: { x: 0, y: 0, width: 200, height: 60 } });
    const skipOut = run(skip, kidCtx, at(1600), F);
    expect(skipOut.dx).toBeCloseTo(BUDGET, 6);
    expect(skipOut.renderWidthOverride).toBe(0);
    expect(skipOut.childDeltaParentWidth).toBe(0); // consumed — the child's subtree rides this ONE shift
  });

  it("a widened V-box's full-width child is background art and re-centres (cross-axis fill)", () => {
    const box = mkNode("Strip", {
      anchorLeft: 0,
      anchorRight: 1,
      containerLayout: "vbox-begin",
      localRect: { x: 0, y: 0, width: 1920, height: 1080 }
    });
    const boxOut = run(box, root, at(0), F);
    expect(boxOut.childContainerAlign).toBe(0);
    expect(boxOut.childContainerVertical).toBe(true);
    const kidCtx = childCtx(box, root, boxOut, at(0));

    const tile = mkNode("MapTop", { localRect: { x: 0, y: 0, width: 1920, height: 360 } });
    expect(run(tile, kidCtx, at(0), F).dx).toBeCloseTo(0.5 * BUDGET, 6);
    const narrow = mkNode("Legend", { localRect: { x: 0, y: 0, width: 300, height: 200 } });
    expect(run(narrow, kidCtx, at(0), F).dx).toBeCloseTo(0, 6); // a v-box's factor is 0 — ride the box
  });

  it("the event-background root re-centres and consumes, so its flames stay matched", () => {
    const bg = mkNode("EventBg", { localRect: { x: 0, y: 0, width: 1920, height: 1080 } });
    const env = plainEnv({ isBackgroundSceneRoot: (n) => n.id === "EventBg" });
    const out = run(bg, root, at(0), F, env);
    expect(out.dx).toBeCloseTo(0.5 * BUDGET, 6);
    expect(out.childDeltaParentWidth).toBe(0);
    expect(out.childRideDx).toBeCloseTo(out.dx, 6);
    expect(out.spreadMode).toBe(false);
  });

  it("a full-frame preview container re-centres; a narrower one rides its parent", () => {
    const env = plainEnv({ isPreviewContainer: (n) => n.name === "Preview" });
    const full = mkNode("full", { name: "Preview", localRect: { x: 0, y: 0, width: 1920, height: 1080 } });
    expect(run(full, root, at(0), F, env).dx).toBeCloseTo(0.5 * BUDGET, 6);
    const narrow = mkNode("narrow", { name: "Preview", localRect: { x: 0, y: 0, width: 989, height: 1080 } });
    expect(run(narrow, root, at(0), F, env).dx).toBeCloseTo(0, 6);
    // Both CONSUME the budget — that is the half of the branch that fixes the card-off-backdrop drift.
    expect(run(narrow, root, at(0), F, env).childDeltaParentWidth).toBe(0);
  });

  it("an owner-anchored floater OVERRIDES whatever the generic branches decided", () => {
    const tip = mkNode("HoverTip", { anchorOwnerId: "card-7", anchorLeft: 0, anchorRight: 1, localRect: { x: 0, y: 0, width: 400, height: 300 } });
    const env = plainEnv({ ownerDx: (ownerId) => (ownerId === "card-7" ? 321 : 0) });
    const out = run(tip, root, at(200), F, env);
    expect(out.dx).toBe(321);
    expect(out.renderWidthOverride).toBe(0); // the stretch the anchor algebra had just claimed is taken back
    expect(out.fieldMode).toBe(0); // the OWNER's shift — a tween endpoint keeps it verbatim
    expect(out.childParentDx).toBe(321);
  });

  it("a remote follower rides the shift of the content under its game point", () => {
    const cursor = mkNode("NRemoteMouseCursor", { localRect: null });
    const env = plainEnv({ remoteFollowerDx: (_n, gx) => gx / 2 });
    const out = run(cursor, root, at(900, 400), F, env);
    expect(out.dx).toBe(450);
    expect(out.fieldMode).toBe(0);
    expect(out.spreadMode).toBe(false);
  });
});

describe("spreadLayout — spreadDrawBox", () => {
  it("prefers the node's own box", () => {
    const node = mkNode("n", { localRect: { x: 3, y: 4, width: 10, height: 10 } });
    expect(spreadDrawBox(node)).toBe(node.localRect); // the box ITSELF, not a copy of its origin
  });

  it("gives the box-less paint kinds the zero origin, and everything else nothing", () => {
    expect(spreadDrawBox(mkNode("plain", { localRect: null }))).toBeNull();
    expect(spreadDrawBox(mkNode("line", { localRect: null, linePoints: [] }))).toEqual({ x: 0, y: 0 });
    expect(spreadDrawBox(mkNode("fx", { localRect: null, particleSpec: normalizeParticleSpecConfig({ kind: "GPUParticles2D" }) }))).toEqual({ x: 0, y: 0 });
    expect(spreadDrawBox(mkNode("trail", { localRect: null, nodeType: "NCardTrail" }))).toEqual({ x: 0, y: 0 });
  });
});

describe("spreadLayout — childParentWidth", () => {
  it("passes the budget-granting frame's width through a zero-size positioner", () => {
    expect(childParentWidth(mkNode("g", { localRect: null }), 1920)).toBe(1920);
    expect(childParentWidth(mkNode("g", { localRect: { x: 0, y: 0, width: 0, height: 0 } }), 1920)).toBe(1920);
    expect(childParentWidth(mkNode("b", { localRect: { x: 0, y: 0, width: 640, height: 480 } }), 1920)).toBe(640);
  });
});

// --- R6 M1: the field at the pose a node is DRAWN at ------------------------------------------------------------
//
// `computeSpread` measures at the node's TRUE pose, which is where the game has it. While a client-side animation
// moves the node — and while the producer FREEZES its streamed transform for the tween's whole window — that is the
// wrong place to measure a claim that is a function of the claimer's own rendered X. These pin the correction: the
// two field modes follow the drawn pose, and nothing else in the algebra moves.
describe("spreadLayout — applyDrawnFieldRebase", () => {
  const root = rootSpreadCtx(F, [1, 0, 0, 1, 0, 0]);

  /** Walk a node at `gWalk` and then re-base it at `gDrawn` — the two calls the canvas walk makes back to back. */
  function rebased(
    node: MirrorNode,
    ctx: SpreadCtx,
    gWalk: readonly number[],
    gDrawn: readonly number[],
    spreadFactor: number,
    env: SpreadEnv = plainEnv()
  ): SpreadOut {
    const out = createSpreadOut();
    const box = spreadDrawBox(node);
    computeSpread(node.id, node, ctx, gWalk, box, spreadFactor, env, out);
    applyDrawnFieldRebase(out, node, gDrawn, box, spreadFactor);
    return { ...out };
  }

  /** A boxless pass-through group — the ORIGIN field, mode 1. */
  const group = mkNode("group", { localRect: null });
  /** World content with a real box and no Control markers — the CENTRE field, mode 2. Centre sits +100 of origin. */
  const sprite = mkNode("sprite", { nodeType: "Godot.Sprite2D", localRect: { x: 0, y: 0, width: 200, height: 100 } });

  it("MODE 1 follows the drawn ORIGIN: a group animated from 600 to 1400 claims the field at 1400", () => {
    const out = rebased(group, root, at(600), at(1400), F);
    expect(out.dx).toBeCloseTo(fieldDxAtOriginX(1400, F), 6);
    // …and the whole point: the DRAWN x is the field's own answer, `x·F`, not `x + dx(600)`.
    expect(1400 + out.dx).toBeCloseTo(1400 * F, 6);
    // The pre-fix number, for the size of the defect: ~262 px of misprediction on this 800px flight.
    expect(1400 + fieldDxAtOriginX(600, F) - 1400 * F).toBeCloseTo(-(1400 - 600) * (F - 1), 6);
  });

  it("MODE 2 follows the drawn CENTRE, through the DRAWN basis", () => {
    const out = rebased(sprite, root, at(600), at(1400), F);
    expect(out.dx).toBeCloseTo(fieldDxAtOriginX(1500, F), 6); // 1400 origin + 100 half-width
    // A sample that also SCALES the node moves its centre with it: at 2x the centre is 200 px out, not 100.
    const scaled = rebased(sprite, root, at(600), [2, 0, 0, 2, 1400, 0], F);
    expect(scaled.dx).toBeCloseTo(fieldDxAtOriginX(1600, F), 6);
  });

  it("MODE 0 is left alone — a rider, an anchored Control, a floater and a follower all keep the walked shift", () => {
    const cases: { node: MirrorNode; env?: SpreadEnv }[] = [
      { node: mkNode("anchored", { anchorLeft: 1, anchorRight: 1, localRect: { x: 0, y: 0, width: 200, height: 100 } }) },
      { node: mkNode("tip", { anchorOwnerId: "card-7" }), env: plainEnv({ ownerDx: () => 321 }) },
      { node: mkNode("NRemoteMouseCursor", { localRect: null }), env: plainEnv({ remoteFollowerDx: () => 450 }) }
    ];
    for (const { node, env } of cases) {
      const walked = createSpreadOut();
      const box = spreadDrawBox(node);
      computeSpread(node.id, node, root, at(600), box, F, env ?? plainEnv(), walked);
      const before = { ...walked };
      applyDrawnFieldRebase(walked, node, at(1400), box, F);
      expect(walked, node.id).toEqual(before);
    }
  });

  it("is inert at 16:9 — F = 1 leaves a moved node at dx 0", () => {
    const out = rebased(group, rootSpreadCtx(1, [1, 0, 0, 1, 0, 0]), at(600), at(1400), 1);
    expect(out.dx).toBe(0);
    expect(out.fieldMode).toBe(0);
  });

  it("is a NO-OP when the drawn pose IS the walked pose (a latched stroke, a settled tween)", () => {
    const walked = createSpreadOut();
    const box = spreadDrawBox(group);
    computeSpread(group.id, group, root, at(600), box, F, plainEnv(), walked);
    const before = { ...walked };
    applyDrawnFieldRebase(walked, group, at(600), box, F);
    expect(walked).toEqual(before);
  });

  it("carries the RIDE claim along, so a card's parts move with the card", () => {
    // Mode 2 hands its own dx down as BOTH the children's baseline and the rigid-ride shift: a card's energy icon
    // and frame art ride `childRideDx`, and if that kept the pre-flight value the card would tear in the air.
    const out = rebased(sprite, root, at(600), at(1400), F);
    expect(out.childRideDx).toBeCloseTo(out.dx, 6);
    expect(out.childParentDx).toBeCloseTo(out.dx, 6);
  });

  it("…but the EQUALITY GUARD leaves a pass-through group's inherited baseline alone", () => {
    // A mode-1 group's `childParentDx` is deliberately its PARENT's shift (each child claims the field for
    // itself). It never equalled the group's own dx, so the re-base must not drag it along.
    const ctx: SpreadCtx = { ...root, parentDx: 77 };
    const out = rebased(group, ctx, at(600), at(1400), F);
    expect(out.childParentDx).toBe(77);
    expect(out.childRideDx).toBeCloseTo(out.dx, 6);
    expect(out.dx).not.toBeCloseTo(77, 6);
  });
});
