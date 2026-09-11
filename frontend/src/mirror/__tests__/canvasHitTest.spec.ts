// HIT SURFACES for the single-canvas stage: which nodes become one, what a point resolves to, and the two
// ancestor walks the entries carry.
//
// `resolveSceneInfo` / `resolveTouchInfo` are restatements of closures inside `mirrorRenderer` (they close over the
// renderer's live node map, so they cannot be exported as-is). They call the SAME exported tables and predicates,
// so only the walk is duplicated — and the walk is CROSS-CHECKED here against what the DOM backend actually stamps
// on its elements (`data-scene-file` / `data-scene-node-path` / `data-scene-root-id` / `data-touch-id` /
// `data-touch-block`), over a scene shaped to exercise every branch of both.

import { beforeEach, describe, expect, it } from "vitest";

import { createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import {
  createHitMemo,
  hitStack,
  resolveSceneInfo,
  resolveTouchInfo,
  sceneIdentityOf,
  type HitEntry
} from "@/mirror/canvas/hitTest";
import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

function wireNode(
  id: string,
  parentId: string | null,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } },
    visible: true,
    mouseFilter: 0,
    ...over
  };
}

function at(x: number, y: number, w = 100, h = 100): Record<string, unknown> {
  return {
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } },
    localRect: { position: { x: 0, y: 0 }, size: { x: w, y: h } }
  };
}

function stateOf(nodes: Record<string, unknown>[]): MirrorState {
  const state = createMirrorState();
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
  return state;
}

function entriesOf(nodes: Record<string, unknown>[]): { state: MirrorState; entries: HitEntry[] } {
  const state = stateOf(nodes);
  const list = createDrawList<string>();
  const build = buildDrawList(state, list);
  return { state, entries: build.hitEntries };
}

// --- who becomes a surface --------------------------------------------------------------------------------------

describe("hit-surface eligibility", () => {
  it("takes every placed node — mouse_filter is a FLAG on the entry, not the gate", () => {
    const { entries } = entriesOf([
      wireNode("stop", null, { ...at(0, 0), mouseFilter: 0 }),
      wireNode("pass", null, { ...at(100, 0), mouseFilter: 1 }),
      wireNode("ignore", null, { ...at(200, 0), mouseFilter: 2 }),
      wireNode("notAControl", null, { ...at(300, 0), mouseFilter: null }),
      wireNode("boxless", null, { mouseFilter: 0, localRect: null })
    ]);
    // Wave 2b: an IGNORE node is still a surface. A combat hand card and all of its art are IGNORE, and the DOM
    // backend's z-stack is unfiltered too ("`.mirror-node` is `pointer-events: auto` for every node") — gating on
    // mouse_filter made the whole hand unresolvable to a tap. What still has no entry is a node with no BOX.
    expect(entries.map((e) => e.nodeId)).toEqual(["stop", "pass", "ignore", "notAControl"]);
    // …and the flag the one consumer that does want the old gate reads (`interactiveRects`).
    expect(entries.map((e) => e.mouseVisible)).toEqual([true, true, false, false]);
  });

  it("drops an invisible node and everything under an invisible ancestor", () => {
    const { entries } = entriesOf([
      wireNode("Root", null, at(0, 0, 400, 400)),
      wireNode("self", "Root", { ...at(0, 0), visible: false }),
      wireNode("box", "Root", { ...at(100, 0), visible: false }),
      wireNode("under", "box", at(100, 0))
    ]);
    expect(entries.map((e) => e.nodeId)).toEqual(["Root"]);
  });

  it("drops the hit-test-excluded shapes: remote followers, echo copies, owner-anchored floaters", () => {
    const { entries } = entriesOf([
      wireNode("cursor", null, { ...at(0, 0), nodeType: "MegaCrit.Sts2.Core.Nodes.Multiplayer.NRemoteMouseCursor" }),
      wireNode("echo", null, { ...at(100, 0), nodeType: "MegaCrit.Sts2.Core.Nodes.NCardPreviewContainer" }),
      wireNode("tip", null, { ...at(200, 0), anchorOwnerId: "someone" }),
      wireNode("plain", null, at(300, 0))
    ]);
    expect(entries.map((e) => e.nodeId)).toEqual(["plain"]);
  });

  it("emits entries in paint order, so a backwards scan is topmost-first", () => {
    const { entries } = entriesOf([
      wireNode("under", null, at(0, 0)),
      wireNode("over", null, at(0, 0)),
      wireNode("raised", null, { ...at(0, 0), zIndex: 5 })
    ]);
    expect(entries.map((e) => e.nodeId)).toEqual(["under", "over", "raised"]);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].order).toBeGreaterThan(entries[i - 1].order);
    }
  });
});

// --- hitStack -----------------------------------------------------------------------------------------------------

describe("hitStack", () => {
  it("returns every surface under the point, topmost first", () => {
    const { entries } = entriesOf([
      wireNode("back", null, at(0, 0, 400, 400)),
      wireNode("mid", null, at(50, 50, 200, 200)),
      wireNode("front", null, at(80, 80, 40, 40))
    ]);
    expect(hitStack(entries, 100, 100).map((e) => e.nodeId)).toEqual(["front", "mid", "back"]);
    expect(hitStack(entries, 300, 300).map((e) => e.nodeId)).toEqual(["back"]);
    expect(hitStack(entries, 900, 900)).toEqual([]);
  });

  it("respects a ROTATED box's real corners, not its AABB", () => {
    // A 100x100 box rotated 45 degrees about its origin: (99, 1) is inside the AABB and outside the box.
    const c = Math.SQRT1_2;
    const { entries } = entriesOf([
      wireNode("card", null, {
        transform: { xAxis: { x: c, y: c }, yAxis: { x: -c, y: c }, origin: { x: 100, y: 0 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } }
      })
    ]);
    expect(hitStack(entries, 100, 50).map((e) => e.nodeId)).toEqual(["card"]);
    expect(hitStack(entries, 180, 5)).toEqual([]);
  });

  it("does NOT hit a node whose ancestor clip excludes the point — the browser's overflow:hidden, reproduced", () => {
    const { entries } = entriesOf([
      wireNode("Clipper", null, { ...at(0, 0, 100, 100), clipContents: true }),
      // A child that sticks out to x 200 — the game parks content outside its container to hide it.
      wireNode("Parked", "Clipper", at(0, 0, 300, 100))
    ]);
    const inside = hitStack(entries, 50, 50).map((e) => e.nodeId);
    expect(inside).toEqual(["Parked", "Clipper"]);
    // x = 200 is inside `Parked`'s own box but outside the clip: neither is hit.
    const outside = hitStack(entries, 200, 50).map((e) => e.nodeId);
    expect(outside).toEqual([]);
  });

  it("honours a one-axis clip's horizontal outset while keeping the vertical axis exact", () => {
    const nodes = [
      wireNode("EventRoot", null, {
        ...at(0, 0, 1920, 1080),
        sceneFilePath: "res://scenes/events/ancient_event_layout.tscn"
      }),
      wireNode("ContentContainer", "EventRoot", { ...at(380, 320, 1160, 720), clipContents: true }),
      wireNode("Options", "ContentContainer", at(-380, -20, 1920, 200))
    ];
    const { entries } = entriesOf(nodes);
    // Outside the container on x, but inside the 380px outset the clip-axis table grants this scene identity.
    expect(hitStack(entries, 100, 400).map((e) => e.nodeId)).toContain("Options");
    // The VERTICAL axis is untouched: below the container's bottom edge nothing inside it is hit.
    expect(hitStack(entries, 100, 1060).map((e) => e.nodeId)).not.toContain("Options");
  });
});

// --- the two ancestor walks, cross-checked against the DOM backend ----------------------------------------------

const CROSS_CHECK_SCENE: Record<string, unknown>[] = [
  wireNode("Screen", null, { ...at(0, 0, 1920, 1080), sceneFilePath: "res://scenes/screens/combat_screen.tscn" }),

  // A hover-first widget: the whole subtree carries the widget's id, except the decorative overlay.
  wireNode("Hand", "Screen", at(0, 800, 900, 280)),
  wireNode("Card", "Hand", { ...at(0, 800, 240, 320), nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCard", sceneFilePath: "res://scenes/cards/card.tscn" }),
  wireNode("CardContainer", "Card", at(0, 800, 240, 320)),
  wireNode("TitleLabel", "CardContainer", at(0, 810, 240, 40)),
  wireNode("Highlight", "Card", at(-180, 620, 600, 600)),

  // A plain button BLOCKS, and beats a hover-first widget behind it.
  wireNode("Skip", "Screen", { ...at(1500, 900, 200, 80), nodeType: "MegaCrit.Sts2.Core.Nodes.Ui.NSkipButton" }),
  wireNode("SkipLabel", "Skip", at(1500, 910, 200, 60)),

  // A scrollbar's track and its handle report DIFFERENT block kinds.
  wireNode("Scrollbar", "Screen", { ...at(1800, 100, 40, 600), nodeType: "MegaCrit.Sts2.Core.Nodes.Ui.NScrollbar" }),
  wireNode("Train", "Scrollbar", { ...at(1800, 200, 40, 120), nodeType: "MegaCrit.Sts2.Core.Nodes.Ui.NScrollbarTrain" }),

  // An ECHO container above a touch target kills the whole subtree's touch identity.
  wireNode("Preview", "Screen", { ...at(600, 200, 300, 400), nodeType: "MegaCrit.Sts2.Core.Nodes.NCardPreviewContainer" }),
  wireNode("EchoCard", "Preview", { ...at(600, 200, 240, 320), nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCard" }),
  wireNode("EchoTitle", "EchoCard", at(600, 210, 240, 40)),

  // The end-of-event Proceed option: an NEventOptionButton whose SCENE is proceed_button.tscn ⇒ press immediately.
  wireNode("Proceed", "Screen", {
    ...at(700, 700, 400, 90),
    nodeType: "MegaCrit.Sts2.Core.Nodes.Events.NEventOptionButton",
    sceneFilePath: "res://scenes/ui/proceed_button.tscn"
  }),
  wireNode("ProceedLabel", "Proceed", at(700, 710, 400, 70)),

  // Two ordinary event options ⇒ both stay hover-first targets (the lone-option rule needs exactly one).
  wireNode("OptionA", "Screen", { ...at(400, 400, 500, 90), nodeType: "MegaCrit.Sts2.Core.Nodes.Events.NEventOptionButton" }),
  wireNode("OptionB", "Screen", { ...at(400, 500, 500, 90), nodeType: "MegaCrit.Sts2.Core.Nodes.Events.NEventOptionButton" })
];

describe("scene + touch resolution agrees with what the DOM backend stamps", () => {
  let stage: HTMLElement;
  let renderer: MirrorRenderer;

  beforeEach(() => {
    document.body.innerHTML = "";
    stage = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(defs);
    document.body.append(stage, svg);
    renderer = createMirrorRenderer(stage, defs);
  });

  function stamped(id: string): Record<string, string | null> {
    const el = stage.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
    if (!el) throw new Error(`no element for ${id}`);
    return {
      file: el.getAttribute("data-scene-file"),
      relPath: el.getAttribute("data-scene-node-path"),
      rootId: el.getAttribute("data-scene-root-id"),
      touchId: el.getAttribute("data-touch-id"),
      touchBlock: el.getAttribute("data-touch-block")
    };
  }

  it("matches node for node over a scene that exercises every branch", () => {
    const state = stateOf(CROSS_CHECK_SCENE);
    renderer.reconcile(state);

    const BLOCK_ATTR: Record<string, string> = { button: "1", bar: "bar", thumb: "thumb" };
    for (const node of CROSS_CHECK_SCENE) {
      const id = node.id as string;
      const dom = stamped(id);
      const scene = resolveSceneInfo(id, state.nodes);
      const touch = resolveTouchInfo(id, state.nodes);
      expect({ id, ...dom }).toEqual({
        id,
        file: scene?.file ?? null,
        relPath: scene?.relPath ?? null,
        rootId: scene?.rootId ?? null,
        touchId: touch?.kind === "target" ? touch.id : null,
        touchBlock: touch?.kind === "block" ? BLOCK_ATTR[touch.block] : null
      });
    }
  });

  it("resolves the branches it was built to exercise (so the agreement above is not vacuous)", () => {
    const state = stateOf(CROSS_CHECK_SCENE);
    expect(resolveSceneInfo("TitleLabel", state.nodes)).toEqual({
      file: "res://scenes/cards/card.tscn",
      rootId: "Card",
      relPath: "CardContainer/TitleLabel"
    });
    expect(resolveSceneInfo("Hand", state.nodes)).toEqual({
      file: "res://scenes/screens/combat_screen.tscn",
      rootId: "Screen",
      relPath: "Hand"
    });
    expect(resolveTouchInfo("TitleLabel", state.nodes)).toEqual({ kind: "target", id: "Card" });
    expect(resolveTouchInfo("Highlight", state.nodes)).toBeNull(); // decorative overlay — never owns a tap
    expect(resolveTouchInfo("SkipLabel", state.nodes)).toEqual({ kind: "block", block: "button" });
    expect(resolveTouchInfo("Scrollbar", state.nodes)).toEqual({ kind: "block", block: "bar" });
    expect(resolveTouchInfo("Train", state.nodes)).toEqual({ kind: "block", block: "thumb" });
    expect(resolveTouchInfo("EchoTitle", state.nodes)).toBeNull(); // an echo copy carries no identity
    expect(resolveTouchInfo("ProceedLabel", state.nodes)).toEqual({ kind: "block", block: "button" });
    expect(resolveTouchInfo("OptionA", state.nodes)).toEqual({ kind: "target", id: "OptionA" });
  });

  it("presses a LONE event option immediately, and arms it when there is a choice", () => {
    const two = stateOf([
      wireNode("A", null, { nodeType: "MegaCrit.Sts2.Core.Nodes.Events.NEventOptionButton" }),
      wireNode("B", null, { nodeType: "MegaCrit.Sts2.Core.Nodes.Events.NEventOptionButton" })
    ]);
    expect(resolveTouchInfo("A", two.nodes)).toEqual({ kind: "target", id: "A" });

    const one = stateOf([wireNode("A", null, { nodeType: "MegaCrit.Sts2.Core.Nodes.Events.NEventOptionButton" })]);
    expect(resolveTouchInfo("A", one.nodes)).toEqual({ kind: "block", block: "button" });
  });

  it("blocks a visible decision-grid card only after echo/decorative ancestry is settled", () => {
    const visible = stateOf([
      wireNode("Grid", null, { nodeType: "Godot.NCardGridSelectionScreen" }),
      wireNode("Card", "Grid", { nodeType: "Godot.NCard" }),
      wireNode("Art", "Card"),
      wireNode("Glow", "Card", { name: "CardGlow" }),
      wireNode("Preview", "Grid", { nodeType: "Godot.NCardPreviewContainer" }),
      wireNode("EchoCard", "Preview", { nodeType: "Godot.NCard" }),
      wireNode("EchoArt", "EchoCard")
    ]);
    expect(resolveTouchInfo("Art", visible.nodes)).toEqual({ kind: "block", block: "button" });
    expect(resolveTouchInfo("Glow", visible.nodes)).toBeNull();
    expect(resolveTouchInfo("EchoArt", visible.nodes)).toBeNull();

    const hidden = stateOf([
      wireNode("Grid", null, { nodeType: "Godot.NCardGridSelectionScreen", visible: false }),
      wireNode("Card", "Grid", { nodeType: "Godot.NCard" }),
      wireNode("Art", "Card")
    ]);
    expect(resolveTouchInfo("Art", hidden.nodes)).toEqual({ kind: "target", id: "Card" });
  });

  it("blocks only the exact visible remove-a-card picker hierarchy", () => {
    const exact = stateOf([
      wireNode("Picker", null, { nodeType: "Game.NDeckCardSelectScreen" }),
      wireNode("Grid", "Picker", { nodeType: "Game.NCardGrid" }),
      wireNode("Holder", "Grid", { nodeType: "Game.NGridCardHolder" }),
      wireNode("Card", "Holder", { nodeType: "Game.NCard" }),
      wireNode("Art", "Card"),
    ]);
    expect(resolveTouchInfo("Art", exact.nodes)).toEqual({ kind: "block", block: "button" });

    const hidden = stateOf([
      wireNode("Picker", null, { nodeType: "Game.NDeckCardSelectScreen", visible: false }),
      wireNode("Grid", "Picker", { nodeType: "Game.NCardGrid" }),
      wireNode("Holder", "Grid", { nodeType: "Game.NGridCardHolder" }),
      wireNode("Card", "Holder", { nodeType: "Game.NCard" }),
      wireNode("Art", "Card"),
    ]);
    expect(resolveTouchInfo("Art", hidden.nodes)).toEqual({ kind: "target", id: "Card" });

    for (const selector of ["NDeckUpgradeSelectScreen", "NDeckTransformSelectScreen", "NDeckEnchantSelectScreen", "NSimpleCardSelectScreen", "NCardGrid"]) {
      const derived = stateOf([
        wireNode("Picker", null, { nodeType: `Game.${selector}` }),
        wireNode("Grid", "Picker", { nodeType: "Game.NCardGrid" }),
        wireNode("Holder", "Grid", { nodeType: "Game.NGridCardHolder" }),
        wireNode("Card", "Holder", { nodeType: "Game.NCard" }),
        wireNode("Art", "Card"),
      ]);
      expect(resolveTouchInfo("Art", derived.nodes)).toEqual({ kind: "target", id: "Card" });
    }
  });

  it("uses the exact multiplayer player-state scene root as a fallback without stealing nested controls", () => {
    const state = stateOf([
      wireNode("RemotePlayerState", null, {
        sceneFilePath: "res://scenes/ui/multiplayer_player_state.tscn"
      }),
      wireNode("HpLabel", "RemotePlayerState"),
      wireNode("NestedOption", "RemotePlayerState", { nodeType: "Godot.NMerchantCard" }),
      wireNode("NestedOptionText", "NestedOption"),
      wireNode("NestedButton", "RemotePlayerState", { nodeType: "Godot.NSkipButton" }),
      wireNode("NestedButtonText", "NestedButton"),
      wireNode("SimilarButNotExact", null, {
        sceneFilePath: "res://scenes/ui/multiplayer_player_state_copy.tscn"
      }),
      wireNode("OtherLabel", "SimilarButNotExact")
    ]);
    expect(resolveTouchInfo("HpLabel", state.nodes)).toEqual({ kind: "target", id: "RemotePlayerState" });
    expect(resolveTouchInfo("NestedOptionText", state.nodes)).toEqual({ kind: "target", id: "NestedOption" });
    expect(resolveTouchInfo("NestedButtonText", state.nodes)).toEqual({ kind: "block", block: "button" });
    expect(resolveTouchInfo("OtherLabel", state.nodes)).toBeNull();
  });

  it("stamps the same immediate-grid block and multiplayer fallback in the DOM", () => {
    const state = stateOf([
      wireNode("Grid", null, { nodeType: "Godot.NCardGridSelectionScreen" }),
      wireNode("Card", "Grid", { nodeType: "Godot.NCard" }),
      wireNode("Art", "Card"),
      wireNode("RemotePlayerState", null, {
        sceneFilePath: "res://scenes/ui/multiplayer_player_state.tscn"
      }),
      wireNode("HpLabel", "RemotePlayerState")
    ]);
    renderer.reconcile(state);
    expect(stamped("Art")).toMatchObject({ touchId: null, touchBlock: "1" });
    expect(stamped("HpLabel")).toMatchObject({ touchId: "RemotePlayerState", touchBlock: null });
  });
});

// --- what an entry carries ----------------------------------------------------------------------------------------

describe("HitEntry contents", () => {
  it("carries the scene identity, the touch identity, the two matrices and the enclosing clips", () => {
    const { entries } = entriesOf([
      wireNode("Clipper", null, { ...at(0, 0, 400, 400), clipContents: true }),
      wireNode("Card", "Clipper", {
        ...at(50, 60, 240, 320),
        nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCard",
        sceneFilePath: "res://scenes/cards/card.tscn"
      })
    ]);
    const card = entries.find((e) => e.nodeId === "Card")!;
    expect(card.sceneFile).toBe("res://scenes/cards/card.tscn");
    expect(card.sceneRootId).toBe("Card");
    expect(card.touchOwnerId).toBe("Card");
    expect(card.touchBlock).toBeNull();
    expect(card.paints).toBe(false); // a boxed Control that draws nothing still takes input
    expect([...card.mFinal]).toEqual([...card.mGame]); // identical until the wide-screen spread lands (M1a)
    expect(card.clipScopeChain.map((s) => s.id)).toEqual(["Clipper"]);
    expect(card.clipScopeChain[0].spec).toMatchObject({ x: 0, y: 0, w: 400, h: 400 });
    // The clipper itself is OUTSIDE its own scope chain — its box IS the clip.
    expect(entries.find((e) => e.nodeId === "Clipper")!.clipScopeChain).toEqual([]);
  });
});

// --- the view-scale halo ----------------------------------------------------------------------------------------
//
// M2: an enlarged item is DRAWN bigger, so its `mFinal` box is bigger — and the hit test runs against `mFinal`,
// because the question a finger asks is "what did I touch on screen". Nothing in `hitTest.ts` had to change for
// that; this is the test that says the two really did land together.
describe("view-scale halo", () => {
  const DRAW_PILE = "res://scenes/combat/draw_pile.tscn";

  function pileScene(): Record<string, unknown>[] {
    return [
      wireNode("Root", null, at(0, 0, 1920, 1080)),
      // The combat draw pile: an 80x80 button at (15,985), scaled 1.25 about its own bottom-LEFT corner, so it
      // grows up and right into the empty corner the game left it in.
      wireNode("pile", "Root", { ...at(15, 985, 80, 80), sceneFilePath: DRAW_PILE })
    ];
  }

  function pileEntries(scaled: boolean): HitEntry[] {
    const state = stateOf(pileScene());
    return buildDrawList(state, createDrawList<string>(), {
      viewScaleEnv: scaled
        ? { enabled: () => true, sceneOf: (id) => resolveSceneInfo(id, state.nodes) }
        : null
    }).hitEntries;
  }

  it("a tap in the enlarged halo lands on the pile, and misses it un-scaled", () => {
    // (105,975) is outside the pre-scale box (x ends at 95, y starts at 985) and inside the 1.25x one
    // (x to 115, y from 965) — i.e. squarely in the halo the enlargement added.
    expect(hitStack(pileEntries(false), 105, 975).map((e) => e.nodeId)).toEqual(["Root"]);
    expect(hitStack(pileEntries(true), 105, 975).map((e) => e.nodeId)).toEqual(["pile", "Root"]);
  });

  it("the entry answers the halo tap with the TRUE game pose — mGame never grew", () => {
    const pile = pileEntries(true).find((e) => e.nodeId === "pile")!;
    expect([...pile.mGame]).toEqual([1, 0, 0, 1, 15, 985]);
    expect(pile.mFinal[0]).toBeCloseTo(1.25, 9);
    expect(pile.localRect).toMatchObject({ width: 80, height: 80 });
    // …which is exactly why the halo needs the coordinate INVERSE: the box grew on screen, the game's did not.
    expect([...pile.mFinal]).not.toEqual([...pile.mGame]);
  });
});

// THE PER-BUILD MEMO (`HitMemo`). Both ancestor walks ran per node per build and were 2.1 % + 1.4 % of frame
// self-time on the Aug-28 Moto G86 combat trace, almost all of it re-walking chains siblings share. The memo is
// only sound if it answers IDENTICALLY, so that is what these check — the equivalence first, then the two ways
// sharing an ancestor's answer could go wrong.
describe("the hit-test walk memo", () => {
  it("answers exactly what the un-memoized walks answer, node for node", () => {
    const state = stateOf(CROSS_CHECK_SCENE);
    const memo = createHitMemo();
    for (const node of CROSS_CHECK_SCENE) {
      const id = node.id as string;
      const scene = resolveSceneInfo(id, state.nodes);
      expect({ id, ...sceneIdentityOf(id, state.nodes, memo) }).toEqual({
        id,
        file: scene?.file,
        rootId: scene?.rootId
      });
      expect({ id, touch: resolveTouchInfo(id, state.nodes, memo) }).toEqual({
        id,
        touch: resolveTouchInfo(id, state.nodes)
      });
    }
  });

  it("gives the same answers in either visit order, warm or cold", () => {
    // The memo banks a whole chain per walk, so which node is asked FIRST decides what is cached when the next
    // arrives. A wrong sharing rule shows up as an order dependence and nowhere else.
    const state = stateOf(CROSS_CHECK_SCENE);
    const ids = CROSS_CHECK_SCENE.map((n) => n.id as string);
    const answersIn = (order: readonly string[]) => {
      const memo = createHitMemo();
      const out = new Map<string, unknown>();
      for (const id of order) out.set(id, resolveTouchInfo(id, state.nodes, memo));
      return out;
    };
    const forward = answersIn(ids);
    const backward = answersIn([...ids].reverse());
    for (const id of ids) expect({ id, a: forward.get(id) }).toEqual({ id, a: backward.get(id) });
  });

  it("does not lend a target's answer to the node that SET it… but does to the ones below", () => {
    const state = stateOf(CROSS_CHECK_SCENE);
    const memo = createHitMemo();
    // `Card` IS the target; `TitleLabel` inherits it. Asking the deep one first must not teach the memo that
    // `Card`'s own answer is something else, and asking `Card` first must still let `TitleLabel` share it.
    expect(resolveTouchInfo("TitleLabel", state.nodes, memo)).toEqual({ kind: "target", id: "Card" });
    expect(resolveTouchInfo("Card", state.nodes, memo)).toEqual({ kind: "target", id: "Card" });
    expect(resolveTouchInfo("CardContainer", state.nodes, memo)).toEqual({ kind: "target", id: "Card" });
  });

  it("never lends a DECORATIVE node's null to its siblings", () => {
    const state = stateOf(CROSS_CHECK_SCENE);
    const memo = createHitMemo();
    // `Highlight` is decorative and answers null; `CardContainer` is its sibling under the same `Card` and must
    // still answer the target. Banking `Highlight`'s answer for the shared ancestor would break exactly this.
    expect(resolveTouchInfo("Highlight", state.nodes, memo)).toBeNull();
    expect(resolveTouchInfo("CardContainer", state.nodes, memo)).toEqual({ kind: "target", id: "Card" });
    expect(resolveTouchInfo("Card", state.nodes, memo)).toEqual({ kind: "target", id: "Card" });
  });

  it("keeps the ECHO veto, which applies from ANYWHERE in the ancestry", () => {
    const state = stateOf(CROSS_CHECK_SCENE);
    const memo = createHitMemo();
    // `EchoCard` is a real touch target with an echo container ABOVE it — the case the walk deliberately does not
    // return early for, and the one a naive "share the target" memo would get wrong.
    expect(resolveTouchInfo("EchoTitle", state.nodes, memo)).toBeNull();
    expect(resolveTouchInfo("EchoCard", state.nodes, memo)).toBeNull();
    expect(resolveTouchInfo("Preview", state.nodes, memo)).toBeNull();
  });

  it("forgets everything on reset, because an ancestor swap moves the answers", () => {
    const two = stateOf([
      wireNode("A", null, { nodeType: "MegaCrit.Sts2.Core.Nodes.Events.NEventOptionButton" }),
      wireNode("B", null, { nodeType: "MegaCrit.Sts2.Core.Nodes.Events.NEventOptionButton" })
    ]);
    const one = stateOf([wireNode("A", null, { nodeType: "MegaCrit.Sts2.Core.Nodes.Events.NEventOptionButton" })]);
    const memo = createHitMemo();
    // The lone-option rule reads the WHOLE node map, so this answer is not a property of `A` at all — which is
    // why the memo's lifetime is one build and `buildDrawList` clears it at the top of each.
    expect(resolveTouchInfo("A", two.nodes, memo)).toEqual({ kind: "target", id: "A" });
    memo.reset();
    expect(resolveTouchInfo("A", one.nodes, memo)).toEqual({ kind: "block", block: "button" });
  });
});
