// R2 — WHAT AN OVERLAY DOES WHEN THE GAME PAINTS SOMETHING OPAQUE OVER IT.
//
// Every overlay element paints above the WHOLE canvas, so with a full-screen dialog open the combat screen's own
// labels keep painting over it — the second half of the user's U1 report, and NOT a clip problem: nothing is out
// of bounds, something opaque was simply painted in front. The only answer available to a DOM layer above one
// canvas element is to stop drawing what the game has covered.
//
// So there are two halves, and they are tested apart because they land apart: the WALK measures the backstop (a
// number on the build, on either setting, changing nothing in the list), and the OVERLAY decides what to do about
// it (the current backstop policy is enabled; its dimmed treatment is
// R7's answer to the first of that flip's two named residuals; the evidence lives at the lever in canvasRenderer).

import { afterEach, describe, expect, it } from "vitest";

import { createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import { createMirrorOverlay, type MirrorOverlay } from "@/mirror/canvas/overlay";
import type { OverlayRecord } from "@/mirror/canvas/paintSpec";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorNode,
  type MirrorState
} from "@/mirror/sceneTree";

function mkNode(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.ColorRect",
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
    localRect: { x: 0, y: 0, width: 1920, height: 1080 },
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
    fillColor: { r: 0, g: 0, b: 0, a: 0.851, html: "#000000d9" } as never,
    range: null,
    text: null,
    intentFrames: null,
    linePoints: null,
    lineWidth: null,
    lineColor: null,
    ...over
  };
}

function orderOf(nodes: MirrorNode[], spreadFactor = 1): number {
  const state: MirrorState = createMirrorState();
  for (const node of nodes) {
    state.nodes.set(node.id, node);
  }
  state.orderedIds = nodes.map((n) => n.id);
  state.revision = 1;
  return buildDrawList(state, createDrawList<string>(), { spreadFactor }).backstopOrder;
}

const LABEL = () =>
  mkNode("Label", null, {
    nodeType: "Godot.Label",
    fillColor: null,
    localRect: { x: 0, y: 0, width: 200, height: 40 },
    text: { text: "combat" } as never
  });

describe("the walk measures the backstop", () => {
  it("answers -1 for a screen that paints no full-stage fill — every plain combat frame", () => {
    expect(orderOf([LABEL()])).toBe(-1);
  });

  it("finds the deck view's own #000000d9 sheet, whose alpha is deliberately under 1", () => {
    // The game DIMS what is behind a sheet rather than replacing it, which is why the threshold is 0.7.
    expect(orderOf([LABEL(), mkNode("Sheet", null)])).toBeGreaterThan(0);
  });

  it("refuses a fill the player can still see through", () => {
    expect(orderOf([LABEL(), mkNode("Sheet", null, { fillColor: { r: 0, g: 0, b: 0, a: 0.5 } as never })])).toBe(-1);
  });

  it("composes the node's own cascade into that alpha", () => {
    // A backstop under a half-faded screen is a half-faded backstop — the same rule `coverAbove` applies up the
    // ancestor chain, except the walk already has the answer.
    const faded = mkNode("Sheet", null, { modulate: { r: 1, g: 1, b: 1, a: 0.5 } as never });
    expect(orderOf([LABEL(), faded])).toBe(-1);
  });

  it("refuses a fill that does not span the stage", () => {
    const small = mkNode("Panel", null, { localRect: { x: 0, y: 0, width: 800, height: 600 } });
    expect(orderOf([LABEL(), small])).toBe(-1);
  });

  it("refuses a rotated one, which is not a stage-spanning rectangle", () => {
    const spun = mkNode("Sheet", null, { transform: [0, 1, -1, 0, 1080, 0] });
    expect(orderOf([LABEL(), spun])).toBe(-1);
  });

  it("takes the LAST backstop, so a sheet over a sheet is decided by the topmost", () => {
    const first = mkNode("Under", null);
    const label = LABEL();
    const second = mkNode("Over", null);
    const order = orderOf([first, label, second]);
    const state = createMirrorState();
    for (const node of [first, label, second]) {
      state.nodes.set(node.id, node);
    }
    state.orderedIds = ["Under", "Label", "Over"];
    state.revision = 1;
    const build = buildDrawList(state, createDrawList<string>(), {});
    expect(order).toBe(build.order.orderOf("Over"));
  });

  // --- and on a WIDENED stage, where the sheet is not the width the wire authored -----------------------------
  //
  // F = 2520/1920 = 1.3125, the user's own viewport. The two branches below are the same 1920 sheet under the same
  // widening and they must answer OPPOSITELY, which is the whole reason the test takes a width rather than a
  // factor: one of them is stretched to 2520 by the anchor algebra and covers the stage; the other is re-centred
  // by half the widening, is NOT stretched, and genuinely leaves 300 px of game visible down each side.

  const F = 2520 / 1920;

  /** The anchor frame a stretched child claims against — a boxless root would hand it `anchorDelta: 0`. */
  const FRAME_ROOT = () =>
    mkNode("root", null, {
      nodeType: "Control",
      fillColor: null,
      anchorLeft: 0,
      anchorRight: 1,
      localRect: { x: 0, y: 0, width: 1920, height: 1080 }
    });

  it("finds a 0/1-anchored sheet the spread STRETCHED across the widened stage", () => {
    // Authored 1920 wide, painted 2520 wide. Before the width was plumbed through, this answered -1 — a dialog
    // with no backstop at the one viewport where the user reported labels painting over it.
    const sheet = mkNode("Sheet", "root", { anchorLeft: 0, anchorRight: 1 });
    expect(orderOf([FRAME_ROOT(), LABEL(), sheet], F)).toBeGreaterThan(0);
  });

  it("still refuses the 0/0 sheet the spread RE-CENTRED instead of widening", () => {
    // `spreadLayout`'s `fullCanvas` branch: shifted +300 and left 1920 wide, so it covers [300, 2220] of 2520.
    // Detecting this would be a false positive, and a false positive here HIDES the dialog's own text.
    const sheet = mkNode("Sheet", "root", { anchorLeft: 0, anchorRight: 0 });
    expect(orderOf([FRAME_ROOT(), LABEL(), sheet], F)).toBe(-1);
  });

  it("is unmoved at 16:9, where there is no widening to learn about", () => {
    const sheet = mkNode("Sheet", "root", { anchorLeft: 0, anchorRight: 1 });
    expect(orderOf([FRAME_ROOT(), LABEL(), sheet])).toBeGreaterThan(0);
  });

  it("changes nothing in the list itself", () => {
    const nodes = [LABEL(), mkNode("Sheet", null)];
    const state = createMirrorState();
    for (const node of nodes) {
      state.nodes.set(node.id, node);
    }
    state.orderedIds = nodes.map((n) => n.id);
    state.revision = 1;
    const list = createDrawList<string>();
    const build = buildDrawList(state, list, {});
    // The measurement is a number ON the build; the commands and the record union are what they always were.
    expect(build.stats.commands).toBe(list.count);
    expect(build.overlayRecords.map((r) => r.id)).toEqual(["Label"]);
  });
});

// --- the overlay's half -----------------------------------------------------------------------------------------

let overlay: MirrorOverlay | null = null;

afterEach(() => {
  overlay?.dispose();
  overlay = null;
  document.body.innerHTML = "";
});

function mountOverlay(): HTMLElement {
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  stage.appendChild(canvas);
  document.body.appendChild(stage);
  overlay = createMirrorOverlay(stage, canvas);
  return overlay.container;
}

function nodesOf(): Map<string, MirrorNode> {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: ["label", "creature"],
      upserts: [
        {
          id: "label",
          parentId: null,
          name: "label",
          nodeType: "Godot.Label",
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 50 } },
          visible: true,
          text: { text: "combat" }
        },
        {
          id: "creature",
          parentId: null,
          name: "creature",
          nodeType: "Godot.Sprite2D",
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 50 } },
          visible: true
        }
      ]
    })!
  );
  return state.nodes;
}

function record(over: Partial<OverlayRecord> = {}): OverlayRecord {
  return {
    id: "label",
    kind: "text",
    transform: [1, 0, 0, 1, 0, 0],
    w: 100,
    h: 50,
    order: 10,
    opacity: 1,
    tintR: 1,
    tintG: 1,
    tintB: 1,
    coveredAbove: false,
    clip: null,
    ...over
  };
}

describe("the overlay acts on it", () => {
  it("does nothing at all without an order — which is the default", () => {
    const container = mountOverlay();
    const counts = overlay!.reconcile([record()], nodesOf()).counts;
    expect(container.querySelector('[data-node-id="label"]')).not.toBeNull();
    expect(counts.backstopWithheld).toBe(0);
  });

  it("drops a label the game covered", () => {
    const container = mountOverlay();
    overlay!.setBackstop(50);
    const counts = overlay!.reconcile([record({ order: 10 })], nodesOf()).counts;
    expect(container.querySelector('[data-node-id="label"]')).toBeNull();
    expect(counts.backstopWithheld).toBe(1);
  });

  it("leaves the DIALOG'S OWN text alone — it paints after the backstop", () => {
    const container = mountOverlay();
    overlay!.setBackstop(50);
    const counts = overlay!.reconcile([record({ order: 90 })], nodesOf()).counts;
    expect(container.querySelector('[data-node-id="label"]')).not.toBeNull();
    expect(counts.backstopWithheld).toBe(0);
  });

  it("HIDES a covered spine rather than dropping it — that element IS the pixels", () => {
    const container = mountOverlay();
    overlay!.setBackstop(50);
    overlay!.reconcile([record({ id: "creature", kind: "spine", order: 10 })], nodesOf());
    const el = container.querySelector<HTMLElement>('[data-node-id="creature"]');
    expect(el).not.toBeNull();
    expect(el!.style.visibility).toBe("hidden");
  });

  it("never folds its count into the HOIST RULE's", () => {
    // `withheld` is M2's acceptance number and a before/after comparison; a second meaning inside it would make
    // that comparison a redefinition.
    mountOverlay();
    overlay!.setBackstop(50);
    const counts = overlay!.reconcile([record({ order: 10 })], nodesOf()).counts;
    expect(counts.withheld).toBe(0);
    expect(counts.backstopWithheld).toBe(1);
  });

  it("goes back to leaving everything alone when the order is cleared", () => {
    const container = mountOverlay();
    overlay!.setBackstop(50);
    overlay!.reconcile([record({ order: 10 })], nodesOf());
    overlay!.setBackstop(null);
    overlay!.reconcile([record({ order: 10 })], nodesOf());
    expect(container.querySelector('[data-node-id="label"]')).not.toBeNull();
  });

  it("counts the backstop's hides on their OWN row, not on the draw-list quad's", () => {
    // `fxHidden` means "a draw-list quad paints this surface instead". Folding the backstop's hides into it made
    // it a sum of two unrelated facts, so a dialog screen read as the M2/A2 wiring hiding surfaces it had never
    // drawn. The backstop's population is `backstopWithheld`.
    mountOverlay();
    overlay!.setBackstop(50);
    const counts = overlay!.reconcile([record({ id: "creature", kind: "spine", order: 10 })], nodesOf()).counts;
    expect(counts.backstopWithheld).toBe(1);
    expect(counts.fxHidden).toBe(0);
  });
});
