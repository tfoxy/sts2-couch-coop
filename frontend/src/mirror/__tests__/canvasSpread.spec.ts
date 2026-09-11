// THE CANVAS BACKEND'S WIDE-SCREEN SPREAD, and the readable-hand raise's input inverse.
//
// `spreadLayout.spec.ts` pins the algebra itself; this file pins the WIRING — that the draw-list walk threads the
// spread context the way the DOM walk threads it, that a node's `dx` reaches its DRAWN placement and nothing else,
// and that the hit surfaces the same walk builds agree with what it painted. That last one is the whole point of
// building both in one walk: a hit test that disagrees with the paint sends taps to the wrong card.
//
// The raise half asserts the property the mode cannot ship without: the offsets that MOVE a hand card and the
// stamps that UN-MOVE a pointer on it are exact inverses, so a tap where the card is drawn resolves to the game
// point the card really occupies.

import { describe, expect, it } from "vitest";

import { createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList, type CapturedGlobal } from "@/mirror/canvas/buildDrawList";
import { createSpreadAudit, formatSpreadAudit, type SpreadAudit } from "@/mirror/canvas/spreadAudit";
import { hitStack } from "@/mirror/canvas/hitTest";
import { planCanvasHandRaise, type HandRaiseTweenEnv } from "@/mirror/canvas/handRaise";
import {
  HAND_CONTAINER_NAME,
  HAND_HOLDER_TYPE,
  HAND_RAISE_PX,
  HAND_RAISE_RAMP_END_Y,
  HAND_RAISE_RAMP_START_Y,
  HAND_ROOT_TYPE
} from "@/mirror/mirrorRenderer";
import { remapRaiseInverse, type RaiseInputStamp } from "@/mirror/raiseInverse";
import { createMirrorState, MIRROR_DESIGN_WIDTH, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";
import { fieldDxAtOriginX } from "@/mirror/spreadLayout";

/** 2100x900 letterboxes to a 2520-wide design box — the widest the mirror ever goes. */
const F = 2520 / MIRROR_DESIGN_WIDTH;
const BUDGET = (F - 1) * MIRROR_DESIGN_WIDTH;

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

/** A state whose `orderedIds` is a pre-order DFS (parents before children), which is what the producer streams. */
function mkState(nodes: MirrorNode[]): MirrorState {
  const state = createMirrorState();
  for (const node of nodes) {
    state.nodes.set(node.id, node);
  }
  state.orderedIds = nodes.map((n) => n.id);
  return state;
}

function build(state: MirrorState, spreadFactor: number) {
  return buildDrawList(state, createDrawList<string>(), { spreadFactor, assert: true });
}

function entry(result: ReturnType<typeof build>, id: string) {
  const found = result.hitEntries.find((e) => e.nodeId === id);
  if (!found) {
    throw new Error(`no hit entry for ${id}`);
  }
  return found;
}

/**
 * The stage ROOT the anchor algebra needs: a 0/1-anchored Control covering the design frame, so its children
 * inherit a real anchor frame to claim against. A BOXLESS root would hand them `anchorDelta: 0` (a zero-size
 * parent's box never resizes, so Godot would never move its anchored children) and every HUD widget would ride
 * instead — which is correct, and is exactly why the shape matters here.
 */
function frameRoot(): MirrorNode {
  return mkNode("root", null, {
    anchorLeft: 0,
    anchorRight: 1,
    localRect: { x: 0, y: 0, width: 1920, height: 1080 },
    transform: [1, 0, 0, 1, 0, 0]
  });
}

describe("canvas spread — the walk", () => {
  it("is the identity at 16:9: every hit surface is drawn where the game has it", () => {
    const state = mkState([
      mkNode("root", null, { localRect: null, transform: [1, 0, 0, 1, 0, 0] }),
      mkNode("hud", "root", { mouseFilter: 0, anchorLeft: 1, anchorRight: 1, transform: [1, 0, 0, 1, 1700, 40] }),
      mkNode("world", "root", { nodeType: "Godot.Sprite2D", transform: [1, 0, 0, 1, 600, 500] })
    ]);
    const result = build(state, 1);
    for (const e of result.hitEntries) {
      expect(e.spreadDx, e.nodeId).toBe(0);
      expect(e.renderedWidth, e.nodeId).toBe(0);
      expect(e.spreadProp, e.nodeId).toBe(false);
      expect(e.mFinal, e.nodeId).toEqual(e.mGame);
    }
  });

  it("shifts the DRAWN placement and leaves the GAME placement alone at 2520", () => {
    const state = mkState([
      frameRoot(),
      mkNode("hud", "root", { mouseFilter: 0, anchorLeft: 1, anchorRight: 1, transform: [1, 0, 0, 1, 1700, 40] })
    ]);
    const e = entry(build(state, F), "hud");
    // The game still has it at 1700 — that is what a tap must send.
    expect(e.mGame[4]).toBe(1700);
    // …and it is DRAWN hugging the widened right edge.
    expect(e.spreadDx).toBeCloseTo(BUDGET, 6);
    expect(e.mFinal[4]).toBeCloseTo(1700 + BUDGET, 6);
    // Only X moves: the spread is entirely horizontal.
    expect(e.mFinal[5]).toBe(e.mGame[5]);
  });

  it("never spreads a subtree TWICE — a child's absolute claim replaces its parent's, it does not add to it", () => {
    // A boxless pass-through group takes its own origin claim and passes the budget through, so its child
    // measures its OWN absolute claim in the same frame. If the walk composed children against the SHIFTED parent
    // the child would land at (its own claim + its parent's).
    const state = mkState([
      mkNode("root", null, { localRect: null, transform: [1, 0, 0, 1, 0, 0] }),
      mkNode("group", "root", { localRect: null, transform: [1, 0, 0, 1, 400, 0] }),
      // No `mouse_filter`: this is WORLD content, so it claims the field at its own centre rather than riding
      // its entity's shift the way a boxed Control (a card's energy icon) does.
      mkNode("sprite", "group", {
        nodeType: "Godot.Sprite2D",
        localRect: { x: -50, y: -50, width: 100, height: 100 },
        transform: [1, 0, 0, 1, 500, 300]
      })
    ]);
    const e = entry(build(state, F), "sprite");
    // Its own centre claim, and nothing of the group's.
    expect(e.spreadDx).toBeCloseTo(fieldDxAtOriginX(900, F), 6);
    expect(e.mFinal[4]).toBeCloseTo(900 + fieldDxAtOriginX(900, F), 6);
  });

  it("publishes the stretched width of a widened anchored span", () => {
    const state = mkState([
      frameRoot(),
      mkNode("bar", "root", {
        mouseFilter: 0,
        anchorLeft: 0,
        anchorRight: 1,
        localRect: { x: 0, y: 0, width: 1920, height: 80 },
        transform: [1, 0, 0, 1, 0, 0]
      })
    ]);
    const e = entry(build(state, F), "bar");
    expect(e.spreadDx).toBeCloseTo(0, 6);
    expect(e.renderedWidth).toBeCloseTo(1920 + BUDGET, 6);
  });

  it("the hit test agrees with the PAINT at a wide viewport", () => {
    const state = mkState([
      frameRoot(),
      mkNode("hud", "root", {
        mouseFilter: 0,
        anchorLeft: 1,
        anchorRight: 1,
        localRect: { x: 0, y: 0, width: 120, height: 60 },
        transform: [1, 0, 0, 1, 1700, 40]
      })
    ]);
    const result = build(state, F);
    const drawnX = 1700 + BUDGET + 60; // the middle of where it is DRAWN
    expect(hitStack(result.hitEntries, drawnX, 70).map((e) => e.nodeId)).toContain("hud");
    // …and NOT where the game has it, which on a widened stage is empty stage.
    expect(hitStack(result.hitEntries, 1760, 70).map((e) => e.nodeId)).not.toContain("hud");
  });

  it("writes each node's shift back for the caller to retain", () => {
    const state = mkState([
      frameRoot(),
      mkNode("hud", "root", { anchorLeft: 1, anchorRight: 1, transform: [1, 0, 0, 1, 1700, 40] })
    ]);
    const out = new Map<string, number>();
    buildDrawList(state, createDrawList<string>(), { spreadFactor: F, spreadDxOut: out, assert: true });
    expect(out.get("hud")).toBeCloseTo(BUDGET, 6);
    // …and it is CLEARED per build, so a node that left the scene cannot answer for one that arrives.
    buildDrawList(mkState([mkNode("root", null)]), createDrawList<string>(), {
      spreadFactor: F,
      spreadDxOut: out,
      assert: true
    });
    expect(out.has("hud")).toBe(false);
  });

  it("an owner-anchored floater rides the OWNER's shift, from the caller's registry", () => {
    // A tooltip is hit-test EXCLUDED (it already tracks its owner), so its shift is read off the write-back map
    // rather than off a hit entry — which is also how the renderer's own registry answers the NEXT frame.
    const state = mkState([
      frameRoot(),
      mkNode("tip", "root", { anchorOwnerId: "card-7", mouseFilter: 0, transform: [1, 0, 0, 1, 300, 200] })
    ]);
    const out = new Map<string, number>();
    buildDrawList(state, createDrawList<string>(), {
      spreadFactor: F,
      assert: true,
      spreadDxOut: out,
      spreadRegistry: { ownerDx: (ownerId) => (ownerId === "card-7" ? 250 : 0), followerShift: () => 0 }
    });
    expect(out.get("tip")).toBe(250);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R6 M2 — AN ANIMATED NODE CLAIMS THE FIELD WHERE IT IS DRAWN
// ---------------------------------------------------------------------------------------------------------------
//
// The walk measures the squeeze field at a node's TRUE pose. A `transformOverride` says where the client is drawing
// it this frame, and the two field branches are functions of the claimer's own rendered X — so on a widened stage
// the pre-fix walk drew a flying card at `flightX + dx(pre-flight pose)`, an error of `(sampleX − frozenX)·(F − 1)`
// that snapped away when the settle re-emit let the walk re-derive the shift. That is the user's U6a report, and it
// is invisible at 16:9 because every dx is 0 there.
describe("canvas spread — the DRAWN-pose field claim", () => {
  /**
   * A card the way the wire streams one: a boxless HOLDER that claims the field for itself (mode 1) with the
   * card's own art as a boxed Control child, which RIDES the holder's claim rather than taking its own. Streamed
   * in `"local"` space (the modern producer), so the child composes against whatever pose the holder is drawn at.
   */
  function movedState(): MirrorState {
    return mkState(
      [
        frameRoot(),
        mkNode("holder", "root", { localRect: null, transform: [1, 0, 0, 1, 600, 800] }),
        mkNode("art", "holder", {
          mouseFilter: 0,
          localRect: { x: 0, y: 0, width: 200, height: 100 },
          transform: [1, 0, 0, 1, 0, 0]
        })
      ]
    );
  }

  /** The card is in the air, headed for x = 1400: the sampler publishes an absolute rendered global for it. */
  const FLOWN: ReadonlyMap<string, readonly number[]> = new Map([["holder", [1, 0, 0, 1, 1400, 300]]]);
  /** The FROZEN pre-flight claim the pre-fix walk kept using — the producer suppresses the streamed transform. */
  const FROZEN_DX = fieldDxAtOriginX(600, F);

  function buildMoved(
    overrides: ReadonlyMap<string, readonly number[]> | null,
    spreadFactor = F,
    dxOut: Map<string, number> | null = null
  ) {
    return buildDrawList(movedState(), createDrawList<string>(), {
      spreadFactor,
      transformOverrides: overrides,
      spreadDxOut: dxOut,
      assert: true
    });
  }

  function holderDx(overrides: ReadonlyMap<string, readonly number[]> | null, spreadFactor = F): number {
    const out = new Map<string, number>();
    buildMoved(overrides, spreadFactor, out);
    return out.get("holder")!;
  }

  it("draws a flown card at the field's own answer for WHERE IT IS, not where the game left it", () => {
    expect(holderDx(FLOWN)).toBeCloseTo(fieldDxAtOriginX(1400, F), 6);
    // The holder is a pass-through positioner, so its drawn x is exactly the field's `x·F`.
    expect(entry(buildMoved(FLOWN), "art").mFinal[4]).toBeCloseTo(1400 * F, 6);
  });

  it("never touches the GAME placement — a tap on a flying card is still answered in 1920 space", () => {
    const current = entry(buildMoved(FLOWN), "art");
    // The streamed pose, not the flight sample: `gGame` is override-blind by construction.
    expect(current.mGame[4]).toBe(600);
  });

  it("the card's PARTS ride the corrected claim — the entity cannot tear in the air", () => {
    expect(entry(buildMoved(FLOWN), "art").spreadDx).toBeCloseTo(fieldDxAtOriginX(1400, F), 6);
  });

  it("is the identity at 16:9, and for a node with no override at all", () => {
    // At F = 1 the spread walk short-circuits whole — it does not even touch the write-back map.
    const at169 = new Map<string, number>();
    buildMoved(FLOWN, 1, at169);
    expect(at169.size).toBe(0);
    const flat = buildMoved(FLOWN, 1);
    for (const e of flat.hitEntries) {
      expect(e.spreadDx, e.nodeId).toBe(0);
    }
    // …so the flown card is drawn at the sample itself, with no shift on top of it.
    expect(entry(flat, "art").mFinal[4]).toBe(1400);
    // …and a node NOTHING is animating keeps the walked claim on either setting.
    expect(holderDx(null)).toBeCloseTo(FROZEN_DX, 6);
  });

  it("banks the CORRECTED shift for the next build's registry (and the comet's head)", () => {
    // `spreadDxOut` is what `ownerDx` and `cardTrailState`'s head sampler read on the NEXT build, so the comet
    // stays glued to the card as corrected rather than to the pose the walk froze.
    expect(holderDx(FLOWN)).toBeCloseTo(fieldDxAtOriginX(1400, F), 6);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A MOVED SUBTREE'S OWN CLAIMS — the Aug-29 defect
// ---------------------------------------------------------------------------------------------------------------
//
// The block above proves the case its round was written for: a node CARRYING a transform override re-claims the
// field where it is drawn, and its Control children RIDE that corrected claim. Both of those nodes are correct
// today and were correct before this round.
//
// What neither of them is, is the card. A tween targets a zero-size HOLDER that paints nothing; the pixels belong
// to descendants, and a descendant that is not a Control (a `Sprite2D`, a particle anchor — 44 of the 546 nodes in
// a recorded combat frame) does NOT ride: it claims the field for ITSELF, at its own `gGame`, which the producer
// FREEZES for the tween's whole window. So the card was drawn `travel · (F − 1)` from where it belonged for the
// length of every hand animation and snapped when the settle delta thawed the walk — 8 / 16 / 24 design px for a
// three-card focus at F = 1.3125, measured off the player's own screenshots.
//
// The fix threads "am I drawn away from my streamed pose" down the walk instead of asking one node about itself.
describe("canvas spread — a moved subtree's own claims", () => {
  /** The card as the wire streams it: a boxless holder, a boxless group under it, and a SELF-CLAIMING sprite. */
  function cardState(): MirrorState {
    return mkState(
      [
        frameRoot(),
        mkNode("holder", "root", { localRect: null, transform: [1, 0, 0, 1, 600, 800] }),
        // A Control part, for the contrast: it rides.
        mkNode("frame", "holder", {
          mouseFilter: 0,
          localRect: { x: 0, y: 0, width: 300, height: 422 },
          transform: [1, 0, 0, 1, -150, -211]
        }),
        mkNode("fx", "holder", { localRect: null, transform: [1, 0, 0, 1, 0, 0] }),
        // No anchors, no `mouseFilter`, a real box: the POSITIONAL CLAIMER branch, mode 2.
        mkNode("sprite", "fx", {
          nodeType: "Godot.Sprite2D",
          localRect: { x: 0, y: 0, width: 300, height: 422 },
          transform: [1, 0, 0, 1, -150, -211]
        })
      ]
    );
  }

  /** The holder is being tweened from x = 600 to x = 1400 — 800 design px of travel, the producer silent. */
  const MOVED: ReadonlyMap<string, readonly number[]> = new Map([["holder", [1, 0, 0, 1, 1400, 300]]]);
  /** The sprite sits at holder-local -150 and is 300 wide, so its own drawn CENTRE is the holder's own x. */
  const SPRITE_CENTRE_X = 1400;

  function buildCard(spreadFactor = F, audit: SpreadAudit | null = null) {
    const dx = new Map<string, number>();
    const drawn = new Map<string, CapturedGlobal>();
    buildDrawList(cardState(), createDrawList<string>(), {
      spreadFactor,
      transformOverrides: MOVED,
      spreadDxOut: dx,
      captureGlobals: { ids: new Set(["holder", "frame", "fx", "sprite"]), out: drawn },
      spreadAudit: audit,
      assert: true
    });
    return { dx, drawn };
  }

  it("a painted descendant claims the field where IT is drawn, not where the wire left it", () => {
    const { dx, drawn } = buildCard();
    // Mode 2, evaluated at the sprite's own DRAWN centre — which the holder's move carries to 1400.
    expect(dx.get("sprite")).toBeCloseTo(fieldDxAtOriginX(SPRITE_CENTRE_X, F), 6);
    // …so its pixels land at the drawn origin plus that shift, and the card is where the game will say it is.
    expect(drawn.get("sprite")!.g[4]).toBeCloseTo(1400 - 150 + fieldDxAtOriginX(SPRITE_CENTRE_X, F), 6);
  });

  it("the card does not TEAR: the rider and the self-claimer take the same shift", () => {
    const { dx } = buildCard();
    expect(dx.get("sprite")).toBeCloseTo(dx.get("frame")!, 6);
    expect(dx.get("fx")).toBeCloseTo(dx.get("holder")!, 6);
  });

  it("is inert at 16:9, where there is no field to claim", () => {
    const { dx } = buildCard(1);
    expect(dx.size).toBe(0);
  });

  it("the stage-wide audit is what would have caught it, and it is silent once fixed", () => {
    const clean = createSpreadAudit();
    buildCard(F, clean);
    expect(clean.checked).toBeGreaterThan(0);
    expect(clean.moved, "the holder and its three descendants are all drawn off their streamed pose").toBe(4);
    expect(formatSpreadAudit(clean)).toContain("0 mis-claimed");
    expect(clean.rows.filter((r) => r.reason === "drawn-pose")).toHaveLength(0);

  });
});

// ---------------------------------------------------------------------------------------------------------------
// READABLE-HAND RAISE
// ---------------------------------------------------------------------------------------------------------------

/** A minimal combat hand: root → container → N holders, each with its 300x422 Hitbox. */
function handState(holderYs: number[], over: { rootModulate?: MirrorNode["modulate"] } = {}): MirrorState {
  const nodes: MirrorNode[] = [
    mkNode("root", null, { localRect: null }),
    mkNode("hand", "root", {
      nodeType: `Combat.${HAND_ROOT_TYPE}`,
      localRect: null,
      modulate: over.rootModulate ?? null
    }),
    mkNode(HAND_CONTAINER_NAME, "hand", { name: HAND_CONTAINER_NAME, localRect: null, transform: [1, 0, 0, 1, 960, 1080] })
  ];
  holderYs.forEach((y, i) => {
    nodes.push(
      mkNode(`holder${i}`, HAND_CONTAINER_NAME, {
        nodeType: `Combat.${HAND_HOLDER_TYPE}`,
        localRect: null,
        zIndex: null,
        transform: [1, 0, 0, 1, 300 * i, y]
      })
    );
    // The holder is a zero-size anchor; its Hitbox is the real 300x422 footprint, at holder-local (-150,-211).
    // The streamed matrix is parent-relative — the identity here.
    nodes.push(
      mkNode(`hit${i}`, `holder${i}`, {
        name: "Hitbox",
        mouseFilter: 0,
        localRect: { x: -150, y: -211, width: 300, height: 422 },
        transform: [1, 0, 0, 1, 0, 0]
      })
    );
  });
  return mkState(nodes);
}

const RESTING = { enabled: true, heldCardId: null, heldMode: "drag" as const };

describe("canvas readable-hand raise", () => {
  it("is empty with the mode off — which is provably the identity on both halves", () => {
    const plan = planCanvasHandRaise(handState([-50, -50]), { ...RESTING, enabled: false });
    expect(plan.offsets.size).toBe(0);
    expect(plan.movedRectDy.size).toBe(0);
  });

  it("lifts every resting holder by the full overhang, and moves its hit box with it", () => {
    const plan = planCanvasHandRaise(handState([-50, -50, -50]), RESTING);
    expect(plan.liftPx).toBe(HAND_RAISE_PX);
    expect(plan.offsets.get("holder1")).toEqual({ dx: 0, dy: -HAND_RAISE_PX });
    expect(plan.movedRectDy.get("hit1")).toBe(-HAND_RAISE_PX);
    // The fan's SHAPE must not change: every card rides the same lift.
    expect(plan.offsets.get("holder0")).toEqual(plan.offsets.get("holder2"));
  });

  it("leaves a FOCUSED holder exactly where the game put it", () => {
    // -209 is the pose the game snaps a focused holder to; the ramp is 1 there, so the lift is 0.
    const plan = planCanvasHandRaise(handState([-50, -209]), RESTING);
    expect(plan.offsets.has("holder1")).toBe(false);
    expect(plan.movedRectDy.has("hit1")).toBe(false);
    // …and its neighbour is still up.
    expect(plan.offsets.get("holder0")).toEqual({ dx: 0, dy: -HAND_RAISE_PX });
  });

  it("stands aside for a drag, a dimmed hand, and this client's own finger", () => {
    const dragged = handState([-50, -50]);
    // The game reparents a dragged holder off the container onto the hand ROOT.
    dragged.nodes.set("holder1", { ...dragged.nodes.get("holder1")!, parentId: "hand" });
    expect(planCanvasHandRaise(dragged, RESTING).offsets.size).toBe(0);

    const dimmed = handState([-50, -50], { rootModulate: { r: 0.5, g: 0.5, b: 0.5, a: 1, html: "#808080" } });
    expect(planCanvasHandRaise(dimmed, RESTING).offsets.size).toBe(0);

    const held = planCanvasHandRaise(handState([-50, -50]), { enabled: true, heldCardId: "holder0", heldMode: "drag" });
    expect(held.offsets.size).toBe(0);
    // …but a long-press PEEK keeps the hand up behind the peeked card.
    const peeked = planCanvasHandRaise(handState([-50, -50]), { enabled: true, heldCardId: "holder0", heldMode: "peek" });
    expect(peeked.offsets.size).toBeGreaterThan(0);
  });

  it("the raise and its input inverse are exact inverses (the round trip)", () => {
    const state = handState([-50, -50]);
    const plan = planCanvasHandRaise(state, RESTING);
    // The stamps are built from the SAME collection the renderer builds them from: the walk's own hit entries,
    // carrying the TRUE game placement, plus the plan's dy.
    const built = buildDrawList(state, createDrawList<string>(), { cosmeticOffsets: plan.offsets, assert: true });
    const stamps: RaiseInputStamp[] = built.hitEntries
      .filter((e) => plan.movedRectDy.has(e.nodeId))
      .map((e) => ({
        transform: e.mGame,
        localRect: e.localRect,
        spreadDx: e.spreadDx,
        dy: plan.movedRectDy.get(e.nodeId)!
      }));
    expect(stamps).toHaveLength(2);

    const target = built.hitEntries.find((e) => e.nodeId === "hit1")!;
    const dy = plan.movedRectDy.get("hit1")!;
    expect(dy).toBe(-HAND_RAISE_PX);
    // A finger lands in the middle of the card WHERE IT IS DRAWN — i.e. at the painted placement.
    const drawn = { x: target.mFinal[4], y: target.mFinal[5] };
    const mapped = remapRaiseInverse(drawn.x, drawn.y, stamps);
    // …and resolves to the point the game actually has there: the drawn point un-shifted by exactly the raise.
    expect(mapped.x).toBeCloseTo(drawn.x, 6);
    expect(mapped.y).toBeCloseTo(drawn.y - dy, 6);
    // Which is the card's TRUE placement — the exact inverse of the offset the plan drew it with.
    expect(mapped.y).toBeCloseTo(target.mGame[5], 6);
  });

  it("an empty stamp list is the identity, so the mode being off cannot move a pointer", () => {
    for (const [x, y] of [
      [0, 0],
      [960, 540],
      [1919, 1079]
    ]) {
      expect(remapRaiseInverse(x, y, [])).toEqual({ x, y });
    }
  });

  it("the cosmetic offset never reaches the game placement", () => {
    const state = handState([-50, -50]);
    const plan = planCanvasHandRaise(state, RESTING);
    const result = buildDrawList(state, createDrawList<string>(), {
      cosmeticOffsets: plan.offsets,
      assert: true
    });
    const e = entry(result, "hit1");
    // Drawn a lift higher…
    expect(e.mFinal[5]).toBeCloseTo(e.mGame[5] - HAND_RAISE_PX, 6);
    // …while `mGame` — what a tap sends — is the container's y plus the holder's, untouched by the offset.
    expect(e.mGame[5]).toBeCloseTo(1080 - 50, 6);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// READABLE-HAND RAISE — THE LIVE TWEEN ENDPOINT (S1/D1)
// ---------------------------------------------------------------------------------------------------------------
//
// The ramp is a function of ONE number: where a holder sits in its container. A tween-owned holder ships no
// transform at all (the producer suppresses it for the tween's whole window), so the streamed answer is stale or
// absent for the length of a cancelled play's return — and the endpoint is the only honest source. These cases pin
// the leg and, just as importantly, pin that it is SKIPPED WHOLE when no evaluator is threaded (which is what makes
// the feature's absence, and its `raiseEndpoint` kill switch, byte-identical to not having it).
//
// H10: this is the CANVAS half only. The DOM backend's own endpoint preference is under live investigation and is
// deliberately untouched — see the guard block in `handRaise.holderLocalY`.

/** The container's global y in `handState` — the holders' transforms are parent-relative to it. */
const CONTAINER_GLOBAL_Y = 1080;

/**
 * A stand-in for the renderer's `raiseTweenEnv`. `endpoints` are GLOBAL 6-tuples keyed by node id (absent ⇒ the
 * evaluator answers "nothing is taking this node anywhere"); `asked` records every id the pass consulted, so a
 * test can assert the leg was not reached at all.
 */
function tweenEnv(endpoints: Record<string, number[]>, parentGlobalY: number | null = CONTAINER_GLOBAL_Y) {
  const asked: string[] = [];
  const env: HandRaiseTweenEnv = {
    transformEndpointInto(nodeId, out6) {
      asked.push(nodeId);
      const end = endpoints[nodeId];
      if (!end) {
        return false;
      }
      for (let i = 0; i < 6; i++) {
        out6[i] = end[i];
      }
      return true;
    },
    parentGlobalY: () => parentGlobalY
  };
  return { env, asked };
}

/** `handState` with one holder's streamed matrix replaced — `null` is the tween-suppressed frame. */
function withHolderTransform(state: MirrorState, id: string, transform: number[] | null): MirrorState {
  state.nodes.set(id, { ...state.nodes.get(id)!, transform });
  return state;
}

describe("canvas readable-hand raise: the live tween endpoint", () => {
  it("rides the ramp DOWN on a tween-suppressed holder instead of holding the full lift", () => {
    // The defect, stated as a pair. A holder mid-return-tween ships no transform; its endpoint is the focused pose.
    const suppressed = withHolderTransform(handState([-50, -50]), "holder1", null);
    // WITHOUT the evaluator: the resting fan is the only guess available, so the card takes the whole overhang.
    expect(planCanvasHandRaise(suppressed, RESTING).offsets.get("holder1")).toEqual({ dx: 0, dy: -HAND_RAISE_PX });

    // WITH it: the endpoint says the card is headed for the focus pose, where the ramp is 1 and the lift is 0.
    const { env } = tweenEnv({ holder1: [1, 0, 0, 1, 300, CONTAINER_GLOBAL_Y + HAND_RAISE_RAMP_END_Y] });
    const planned = planCanvasHandRaise(suppressed, RESTING, env);
    expect(planned.offsets.has("holder1")).toBe(false);
    // …and its neighbour, which nothing is tweening, still comes up the full lift.
    expect(planned.offsets.get("holder0")).toEqual({ dx: 0, dy: -HAND_RAISE_PX });
  });

  it("checks the ENDPOINT FIRST — a stale streamed pose under a live tween never wins", () => {
    // The holder still carries its pre-tween fan matrix (the producer froze it); the tween is taking it to focus.
    const { env } = tweenEnv({ holder0: [1, 0, 0, 1, 0, CONTAINER_GLOBAL_Y + HAND_RAISE_RAMP_END_Y] });
    const plan = planCanvasHandRaise(handState([-50, -50]), RESTING, env);
    expect(plan.offsets.has("holder0")).toBe(false); // the endpoint's answer
    expect(plan.offsets.get("holder1")).toEqual({ dx: 0, dy: -HAND_RAISE_PX }); // the streamed one, for the rest
  });

  it("interpolates the ramp at the endpoint, not at 0 or 1", () => {
    // Halfway along the ramp span: the lift is halved, and it is the ENDPOINT that puts it there.
    const midY = (HAND_RAISE_RAMP_START_Y + HAND_RAISE_RAMP_END_Y) / 2;
    const { env } = tweenEnv({ holder0: [1, 0, 0, 1, 0, CONTAINER_GLOBAL_Y + midY] });
    const plan = planCanvasHandRaise(withHolderTransform(handState([-50, -50]), "holder0", null), RESTING, env);
    expect(plan.offsets.get("holder0")).toEqual({ dx: 0, dy: Math.round(-HAND_RAISE_PX * 0.5) });
  });

  it("falls through to the streamed legs when nothing is genuinely live", () => {
    // An evaluator that answers false for every node (settled, alpha-only, a card flight) must leave the pass
    // exactly where it was — the same behaviour the kill switch reaches by not threading an env at all.
    const { env, asked } = tweenEnv({});
    const state = handState([-50, -209]);
    expect(planCanvasHandRaise(state, RESTING, env).offsets).toEqual(planCanvasHandRaise(handState([-50, -209]), RESTING).offsets);
    expect(asked).toEqual(["holder0", "holder1"]); // it WAS consulted — it simply had nothing to say
  });

  it("skips the endpoint leg when the parent has no composed global", () => {
    // No frame to measure a global endpoint in ⇒ the endpoint is unusable, exactly as the DOM twin treats a record
    // with no `cParentGlobal`. The streamed legs answer instead.
    const { env } = tweenEnv({ holder0: [1, 0, 0, 1, 0, CONTAINER_GLOBAL_Y + HAND_RAISE_RAMP_END_Y] }, null);
    const plan = planCanvasHandRaise(handState([-50, -50]), RESTING, env);
    expect(plan.offsets.get("holder0")).toEqual({ dx: 0, dy: -HAND_RAISE_PX });
  });

  it("never consults the evaluator for a holder outside the fan, or with the mode off", () => {
    // A dragged holder is reparented onto the hand ROOT and keeps the game's pose — no ramp, no endpoint, and the
    // drag gate has already zeroed the lift besides.
    const dragged = handState([-50, -50]);
    dragged.nodes.set("holder0", { ...dragged.nodes.get("holder0")!, parentId: "hand" });
    const dragEnv = tweenEnv({ holder0: [1, 0, 0, 1, 0, CONTAINER_GLOBAL_Y + HAND_RAISE_RAMP_END_Y] });
    expect(planCanvasHandRaise(dragged, RESTING, dragEnv.env).offsets.size).toBe(0);
    expect(dragEnv.asked).toEqual([]);

    const offEnv = tweenEnv({ holder0: [1, 0, 0, 1, 0, CONTAINER_GLOBAL_Y] });
    expect(planCanvasHandRaise(handState([-50, -50]), { ...RESTING, enabled: false }, offEnv.env).offsets.size).toBe(0);
    expect(offEnv.asked).toEqual([]);
  });

  it("an endpoint at or past the resting fan clamps to the full lift, like any other pose", () => {
    // The ramp is clamped at both ends, so an endpoint BELOW the fan (a card being tucked away) cannot produce a
    // negative ramp and over-lift the card.
    const { env } = tweenEnv({ holder0: [1, 0, 0, 1, 0, CONTAINER_GLOBAL_Y - HAND_RAISE_RAMP_START_Y] });
    const plan = planCanvasHandRaise(withHolderTransform(handState([-50, -50]), "holder0", null), RESTING, env);
    expect(plan.offsets.get("holder0")).toEqual({ dx: 0, dy: -HAND_RAISE_PX });
  });
});

// THE POOLED CHILD CONTEXT (R2 B2). The wide-screen branch used to allocate a fresh `SpreadCtx` per node, which
// on a 2712x1220 phone is ~1500 short-lived objects per build and the walk's largest single contribution to the
// 4.4 % the collector took on the Aug-28 combat trace. The pool is a stack indexed by walk DEPTH, and the only
// way that can be wrong is if a context outlives the child recursion it was built for — so this asserts the
// shape a broken pool would break: siblings at DIFFERENT depths, whose contexts would alias if the stack ever
// handed out the same slot twice, and a deep descendant that reads its ancestor's claim after a sibling subtree
// has been walked in between.
describe("the walk's pooled spread context", () => {
  // Each chain claims a DIFFERENT anchor fraction, which is what makes this discriminating: a pool that handed
  // two depths the same slot would leave one chain reading the previous chain's `parentDx`, and with distinct
  // fractions that is a distinct number. (An earlier version of this test used three right-anchored chains, and
  // a deliberately broken pool passed it — every chain's leftovers happened to compute the same dx.)
  const FRACTIONS = [
    { id: "quarter", claim: 0.25, depth: 1 },
    { id: "full", claim: 1, depth: 3 },
    { id: "half", claim: 0.5, depth: 2 }
  ] as const;

  function chain(id: string, claim: number, depth: number): MirrorNode[] {
    const out: MirrorNode[] = [];
    let parent = "root";
    for (let i = 0; i <= depth; i++) {
      const nodeId = i === 0 ? id : `${id}_${i}`;
      out.push(
        mkNode(nodeId, parent, {
          anchorLeft: claim,
          anchorRight: claim,
          localRect: { x: 0, y: 0, width: 100, height: 40 },
          transform: [1, 0, 0, 1, claim * 1800, 100 + i * 40]
        })
      );
      parent = nodeId;
    }
    return out;
  }

  function idsOf(id: string, depth: number): string[] {
    return Array.from({ length: depth + 1 }, (_, i) => (i === 0 ? id : `${id}_${i}`));
  }

  it("keeps every branch's claim intact across sibling subtrees of unequal depth", () => {
    // Three chains of depth 1, 3 and 2 under one frame root: walking them in that order drives the pool's cursor
    // up and back down twice and re-uses the shallower slots for the chain after.
    const mixed = build(mkState([frameRoot(), ...FRACTIONS.flatMap((f) => chain(f.id, f.claim, f.depth))]), F);

    for (const f of FRACTIONS) {
      // The oracle: the same chain built ALONE, where no sibling can have touched the pool between its levels.
      const alone = build(mkState([frameRoot(), ...chain(f.id, f.claim, f.depth)]), F);
      for (const nodeId of idsOf(f.id, f.depth)) {
        expect({ nodeId, dx: entry(mixed, nodeId).spreadDx }).toEqual({
          nodeId,
          dx: entry(alone, nodeId).spreadDx
        });
      }
    }
    // …and not vacuous: the three chains really do land on three different shifts, so an alias would show.
    const dxOf = (id: string) => entry(mixed, id).spreadDx;
    expect(dxOf("quarter")).toBeCloseTo(0.25 * BUDGET, 6);
    expect(dxOf("half")).toBeCloseTo(0.5 * BUDGET, 6);
    expect(dxOf("full")).toBeCloseTo(BUDGET, 6);
    // …including at the DEEP end, which is where a stale slot would be read.
    expect(dxOf("full_3")).toBeCloseTo(BUDGET, 6);
  });

  it("gives the same answer on the second build as on the first, with the pool warm", () => {
    // A pooled object carries the PREVIOUS build's values until it is re-filled, so a field that stopped being
    // assigned would read as correct once and stale forever after. Two builds of the same state catch that.
    const nodes = [
      frameRoot(),
      mkNode("hud", "root", {
        anchorLeft: 1,
        anchorRight: 1,
        localRect: { x: 0, y: 0, width: 200, height: 80 },
        transform: [1, 0, 0, 1, 1700, 60]
      }),
      mkNode("icon", "hud", {
        localRect: { x: 0, y: 0, width: 40, height: 40 },
        transform: [1, 0, 0, 1, 1720, 80]
      })
    ];
    const state = mkState(nodes);
    const first = build(state, F);
    const second = build(state, F);
    for (const id of ["hud", "icon"]) {
      expect({ id, dx: entry(second, id).spreadDx }).toEqual({ id, dx: entry(first, id).spreadDx });
    }
  });
});
