import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,
  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { affineMul, nodeMatrix, IDENTITY_AFFINE, type Affine } from "@/mirror/affine";
import { applySceneDelta, createMirrorState, MIRROR_MAX_DESIGN_WIDTH, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// A Godot Transform2D envelope with the given basis + origin (identity basis unless overridden).
function xform(tx: number, ty: number, a = 1, b = 0, c = 0, d = 1): Record<string, unknown> {
  return { xAxis: { x: a, y: b }, yAxis: { x: c, y: d }, origin: { x: tx, y: ty } };
}

// A localRect envelope at origin with the given size.
function box(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}

// Parse a `matrix(a, b, c, d, e, f)` CSS transform (ignoring any trailing `scale(...)`); identity when absent.
function parseMatrix(transform: string): Affine {
  const m = /matrix\(([^)]*)\)/.exec(transform);
  if (!m) return [...IDENTITY_AFFINE] as Affine;
  const n = m[1].split(",").map((v) => Number(v.trim()));
  return [n[0], n[1], n[2], n[3], n[4], n[5]];
}

// The element's ON-SCREEN matrix: multiply its CSS transform by every ancestor's, up to (excluding) the stage.
function composedMatrix(el: HTMLElement, stage: HTMLElement): Affine {
  let acc: Affine = [...IDENTITY_AFFINE] as Affine;
  let cur: HTMLElement | null = el;
  while (cur && cur !== stage) {
    acc = affineMul(parseMatrix(cur.style.transform), acc);
    cur = cur.parentElement;
  }
  return acc;
}

// Like composedMatrix, but multiplies EVERY `matrix(...)` in each element's transform (in CSS order), not just the
// first. A view-scaled element's transform is `matrix(<stamp>) matrix(<base>)`, so composedMatrix (first-match-only)
// would report the stamp alone; the view-scale assertions need the real rendered transform.
function composedMatrixAll(el: HTMLElement, stage: HTMLElement): Affine {
  let acc: Affine = [...IDENTITY_AFFINE] as Affine;
  let cur: HTMLElement | null = el;
  while (cur && cur !== stage) {
    let own: Affine = [...IDENTITY_AFFINE] as Affine;
    for (const m of cur.style.transform.matchAll(/matrix\(([^)]*)\)/g)) {
      const n = m[1].split(",").map((v) => Number(v.trim()));
      own = affineMul(own, [n[0], n[1], n[2], n[3], n[4], n[5]]);
    }
    acc = affineMul(own, acc);
    cur = cur.parentElement;
  }
  return acc;
}

// The element's composed CSS opacity: product of its own and every ancestor's `opacity`, up to (excluding) the stage.
function composedOpacity(el: HTMLElement, stage: HTMLElement): number {
  let acc = 1;
  let cur: HTMLElement | null = el;
  while (cur && cur !== stage) {
    const o = cur.style.opacity;
    acc *= o === "" ? 1 : Number(o);
    cur = cur.parentElement;
  }
  return acc;
}

function approx(a: Affine, b: Affine): void {
  for (let i = 0; i < 6; i++) {
    expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-6);
  }
}

// Builds the DOM the reconciler renders into: a stage + a shared <defs> for tint/HSV filters.
function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function rawNode(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "NinePatchRect",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 16 } },
    visible: true,
    ...over
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
}

function volatile(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

function el(stage: HTMLElement, id: string): HTMLElement | null {
  return stage.querySelector(`[data-node-id="${id}"]`);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("createMirrorRenderer", () => {
  it("builds an element per visible node on the first (structural) reconcile", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("a", null), rawNode("b", null)], ["a", "b"]);

    renderer.reconcile(state);

    expect(el(stage, "a")).not.toBeNull();
    expect(el(stage, "b")).not.toBeNull();
    expect(el(stage, "a")!.style.width).toBe("100px");
  });

  it("stamps data-touch-id on a widget's content but NOT on its decorative overlays", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // An event option (touch target) with a real content child + two oversized decorative overlays. A SECOND
    // visible option keeps the R8 lone-option leg out of play (a lone option would Block instead of Target).
    full(
      state,
      [
        rawNode("opt", null, { nodeType: "NEventOptionButton", name: "AncientEventOptionButton" }),
        rawNode("img", "opt", { name: "Image" }),
        rawNode("red", "opt", { name: "RedFlash" }),
        rawNode("blue", "opt", { name: "BlueFlash" }),
        rawNode("opt2", null, { nodeType: "NEventOptionButton", name: "OtherOption" })
      ],
      ["opt", "img", "red", "blue", "opt2"]
    );

    renderer.reconcile(state);

    // The widget root + its content carry the widget id; the decorative flashes carry nothing (so they can't
    // occlude a neighbour's tap).
    expect(el(stage, "opt")!.getAttribute("data-touch-id")).toBe("opt");
    expect(el(stage, "img")!.getAttribute("data-touch-id")).toBe("opt");
    expect(el(stage, "red")!.getAttribute("data-touch-id")).toBeNull();
    expect(el(stage, "blue")!.getAttribute("data-touch-id")).toBeNull();
  });

  it("does NOT stamp data-touch-id on a card inside a hover-preview container", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A real HAND card (under an NHandCardHolder), plus a hover-PREVIEW echo: an NCard (with content) nested in a
    // preview container. The real card must be under a hand container to be a touch target (see hand-card gating).
    full(
      state,
      [
        rawNode("holder", null, { nodeType: "NHandCardHolder", name: "Holder" }),
        rawNode("grid", "holder", { nodeType: "NCard", name: "Card" }),
        rawNode("gridArt", "grid", { name: "Frame" }),
        rawNode("prev", null, { nodeType: "NGridCardPreviewContainer", name: "Preview" }),
        rawNode("prevCard", "prev", { nodeType: "NCard", name: "Card" }),
        rawNode("prevArt", "prevCard", { name: "Frame" })
      ],
      ["holder", "grid", "gridArt", "prev", "prevCard", "prevArt"]
    );

    renderer.reconcile(state);

    // The real hand card is tappable; the preview echo (card + its content) carries no touch id, so it can't
    // occlude the hand card beneath it.
    expect(el(stage, "grid")!.getAttribute("data-touch-id")).toBe("grid");
    expect(el(stage, "gridArt")!.getAttribute("data-touch-id")).toBe("grid");
    expect(el(stage, "prevCard")!.getAttribute("data-touch-id")).toBeNull();
    expect(el(stage, "prevArt")!.getAttribute("data-touch-id")).toBeNull();
  });

  it("stamps data-touch-id on BOTH a HAND card and a deck-dialog / reward card (arm-first), but isHandCard splits them", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A HAND card (NCard under NHandCardHolder → NPlayerHand) and a DECK-DIALOG card (NCard under a popup dialog,
    // no hand ancestor). BOTH are touch targets now (arm-first): a tap hovers/focuses, a re-tap clicks. Only the
    // hand card is a HAND card (isHandCard), which is what still gates the gesture machine's peek/lift/unselect.
    full(
      state,
      [
        rawNode("hand", null, { nodeType: "NPlayerHand", name: "Hand" }),
        rawNode("holder", "hand", { nodeType: "NHandCardHolder", name: "Holder" }),
        rawNode("handCard", "holder", { nodeType: "NCard", name: "Card" }),
        rawNode("handArt", "handCard", { name: "Frame" }),
        rawNode("dialog", null, { nodeType: "NDeckViewDialog", name: "Deck" }),
        rawNode("deckCard", "dialog", { nodeType: "NCard", name: "Card" }),
        rawNode("deckArt", "deckCard", { name: "Frame" })
      ],
      ["hand", "holder", "handCard", "handArt", "dialog", "deckCard", "deckArt"]
    );

    renderer.reconcile(state);

    // Both cards + their content carry their OWN card id (the deck card is now a touch target too).
    expect(el(stage, "handCard")!.getAttribute("data-touch-id")).toBe("handCard");
    expect(el(stage, "handArt")!.getAttribute("data-touch-id")).toBe("handCard");
    expect(el(stage, "deckCard")!.getAttribute("data-touch-id")).toBe("deckCard");
    expect(el(stage, "deckArt")!.getAttribute("data-touch-id")).toBe("deckCard");

    // The predicates: both are cards by leaf + touch targets, but only the hand card is a hand card.
    expect(renderer.isHandCard("handCard")).toBe(true);
    expect(renderer.isHandCard("handArt")).toBe(true); // a descendant is also under the hand
    expect(renderer.isHandCard("deckCard")).toBe(false);
    expect(renderer.isCardTouchTarget("handCard")).toBe(true);
    expect(renderer.isCardTouchTarget("deckCard")).toBe(true); // still an NCard record by leaf type
    expect(renderer.isHandCard("nope")).toBe(false);
  });

  it("stamps data-touch-id on the #9 shop card + treasure relic + the R20 card-removal coin (arm-first)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("shop", null, { nodeType: "NMerchantRoom", name: "Shop" }),
        rawNode("merchantCard", "shop", { nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantCard", name: "Slot" }),
        rawNode("mcArt", "merchantCard", { name: "Art" }),
        rawNode(
          "treasureRelic",
          "shop",
          { nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.TreasureRoomRelic.NTreasureRoomRelicHolder", name: "Holder" }
        ),
        rawNode("trArt", "treasureRelic", { name: "Art" }),
        // R20 — the Card Removal Service coin, in the shape the wire streams it (see
        // .sts2/bench/audit-shop-open.ndjson): an NMerchantCardRemoval root with the NClickableControl "Hitbox"
        // child every other shop slot has. Neither leaf ends in "Button", so before the type was listed
        // computeTouchInfo returned null, BOTH attributes were stripped, and inputCapture's `if (!top)` guard fired
        // before the tapToFocus check — one tap was one full click, unlike every other item on the carpet.
        rawNode(
          "removal",
          "shop",
          { nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantCardRemoval", name: "MerchantCardRemoval" }
        ),
        rawNode("removalVisual", "removal", { name: "Visual" }),
        rawNode("removalHitbox", "removal", { nodeType: "MegaCrit.Sts2.Core.Nodes.GodotExtensions.NClickableControl", name: "Hitbox" })
      ],
      ["shop", "merchantCard", "mcArt", "treasureRelic", "trArt", "removal", "removalVisual", "removalHitbox"]
    );
    renderer.reconcile(state);
    expect(el(stage, "merchantCard")!.getAttribute("data-touch-id")).toBe("merchantCard");
    expect(el(stage, "mcArt")!.getAttribute("data-touch-id")).toBe("merchantCard");
    expect(el(stage, "treasureRelic")!.getAttribute("data-touch-id")).toBe("treasureRelic");
    expect(el(stage, "trArt")!.getAttribute("data-touch-id")).toBe("treasureRelic");
    // The coin, its art and its hitbox all carry the coin's id — and NOTHING carries data-touch-block, which is the
    // other way a tap would go straight through as a click.
    expect(el(stage, "removal")!.getAttribute("data-touch-id")).toBe("removal");
    expect(el(stage, "removalVisual")!.getAttribute("data-touch-id")).toBe("removal");
    expect(el(stage, "removalHitbox")!.getAttribute("data-touch-id")).toBe("removal");
    expect(el(stage, "removal")!.hasAttribute("data-touch-block")).toBe(false);
    expect(el(stage, "removalHitbox")!.hasAttribute("data-touch-block")).toBe(false);
  });

  it("R8: an event-option node whose owning scene is proceed_button.tscn stamps data-touch-block (immediate press), not data-touch-id", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("options", null, { nodeType: "Godot.HBoxContainer", name: "OptionsContainer" }),
        // A REGULAR option: same NEventOptionButton type, but its owning scene is the ordinary option button —
        // stays a touch target (arm-first).
        rawNode("regular", "options", {
          nodeType: "NEventOptionButton",
          name: "RegularOption",
          sceneFilePath: "res://scenes/ui/event_option_button.tscn"
        }),
        rawNode("regularText", "regular", { name: "Text" }),
        // The Proceed option: SAME NEventOptionButton type, but its owning scene stays proceed_button.tscn (the
        // shared NProceedButton scene) — must press immediately (block), never arm-first.
        rawNode("proceed", "options", {
          nodeType: "NEventOptionButton",
          name: "ProceedOption",
          sceneFilePath: "res://scenes/ui/proceed_button.tscn"
        }),
        rawNode("proceedText", "proceed", { name: "Text" })
      ],
      ["options", "regular", "regularText", "proceed", "proceedText"]
    );

    renderer.reconcile(state);

    expect(el(stage, "regular")!.getAttribute("data-touch-id")).toBe("regular");
    expect(el(stage, "regularText")!.getAttribute("data-touch-id")).toBe("regular");
    expect(el(stage, "regular")!.getAttribute("data-touch-block")).toBeNull();

    expect(el(stage, "proceed")!.getAttribute("data-touch-id")).toBeNull();
    expect(el(stage, "proceedText")!.getAttribute("data-touch-id")).toBeNull();
    expect(el(stage, "proceed")!.getAttribute("data-touch-block")).toBe("1");
    expect(el(stage, "proceedText")!.getAttribute("data-touch-block")).toBe("1");
  });

  it("R8 lone-option leg: the only effectively-visible event option presses immediately (block), hidden siblings don't count", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("options", null, { nodeType: "Godot.HBoxContainer", name: "OptionsContainer" }),
        // A resolved event's final "Continue": REGULAR event_option_button.tscn (live-verified — the
        // proceed_button.tscn key never fires for it), but the ONLY visible option → no choice to preview → block.
        rawNode("continue", "options", {
          nodeType: "NEventOptionButton",
          name: "ContinueOption",
          sceneFilePath: "res://scenes/ui/event_option_button.tscn"
        }),
        rawNode("spent", "options", {
          nodeType: "NEventOptionButton",
          name: "SpentOption",
          visible: false,
          sceneFilePath: "res://scenes/ui/event_option_button.tscn"
        })
      ],
      ["options", "continue", "spent"]
    );

    renderer.reconcile(state);

    expect(el(stage, "continue")!.getAttribute("data-touch-id")).toBeNull();
    expect(el(stage, "continue")!.getAttribute("data-touch-block")).toBe("1");
  });

  it("handChoiceActive is true only while a from-hand choose-a-card screen is effectively visible (#12)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    void stage;
    // No choice screen → inactive.
    full(state, [rawNode("hand", null, { nodeType: "NPlayerHand", name: "Hand" })], ["hand"]);
    renderer.reconcile(state);
    expect(renderer.handChoiceActive()).toBe(false);

    // A visible NChooseACardSelectionScreen → active.
    full(
      state,
      [
        rawNode("root", null, { nodeType: "Node", name: "Root" }),
        rawNode("screen", "root", {
          nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.NChooseACardSelectionScreen",
          name: "ChooseACard"
        })
      ],
      ["root", "screen"]
    );
    renderer.reconcile(state);
    expect(renderer.handChoiceActive()).toBe(true);

    // Hidden screen → inactive again.
    full(
      state,
      [
        rawNode("root", null, { nodeType: "Node", name: "Root" }),
        rawNode("screen", "root", {
          nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.NChooseACardSelectionScreen",
          name: "ChooseACard",
          visible: false
        })
      ],
      ["root", "screen"]
    );
    renderer.reconcile(state);
    expect(renderer.handChoiceActive()).toBe(false);

    // The card GRID selection screen is NOT a hand-choice.
    full(
      state,
      [
        rawNode("root", null, { nodeType: "Node", name: "Root" }),
        rawNode("grid", "root", {
          nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.NCardGridSelectionScreen",
          name: "Grid"
        })
      ],
      ["root", "grid"]
    );
    renderer.reconcile(state);
    expect(renderer.handChoiceActive()).toBe(false);
  });

  it("stamps a card grid's SCROLLBAR (and its thumb) as a touch BLOCK (R11 WS-S §4)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("root", null, { nodeType: "Node", name: "Root" }),
        rawNode("grid", "root", { nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCardGrid", name: "CardGrid" }),
        rawNode("bar", "grid", {
          nodeType: "MegaCrit.Sts2.Core.Nodes.GodotExtensions.NScrollbar",
          name: "Scrollbar"
        }),
        rawNode("track", "bar", { nodeType: "Godot.TextureRect", name: "TrackBody" }),
        rawNode("handle", "bar", {
          nodeType: "MegaCrit.Sts2.Core.Nodes.CommonUi.NScrollbarTrain",
          name: "Handle"
        })
      ],
      ["root", "grid", "bar", "track", "handle"]
    );
    renderer.reconcile(state);
    // The whole strip is a block: a press here is spoken for, so the input side must neither arm a pan on it nor
    // let the hit-test fall through to the cards behind it.
    for (const id of ["bar", "track", "handle"]) {
      const el = stage.querySelector(`[data-node-id="${id}"]`);
      expect(el?.getAttribute("data-touch-block")).not.toBeNull();
      expect(el?.getAttribute("data-touch-id")).toBeNull();
    }
    // R21 — and WHICH block it is, which is the fact the eager-scroll claim could not previously ask for. The
    // track and its body are the bar's; the HANDLE is called out separately because a finger there is a deliberate
    // grab (it drags at once) while a finger on the track is not (it defers — see eagerScroll's BAR_TAP_SLOP_PX).
    expect(stage.querySelector('[data-node-id="bar"]')?.getAttribute("data-touch-block")).toBe("bar");
    expect(stage.querySelector('[data-node-id="track"]')?.getAttribute("data-touch-block")).toBe("bar");
    expect(stage.querySelector('[data-node-id="handle"]')?.getAttribute("data-touch-block")).toBe("thumb");
  });

  it("mapDrawingToolActive follows the tool button's GLOW texture, not its tint (R11 WS-M)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    void stage;
    const tools = (iconTexture: string, over: Record<string, unknown> = {}): Record<string, unknown>[] => [
      rawNode("map", null, { nodeType: "NMapScreen", name: "MapScreen", ...over }),
      rawNode("drawButton", "map", { nodeType: "Godot.Button", name: "DrawButton" }),
      rawNode("icon", "drawButton", {
        nodeType: "Godot.TextureRect",
        name: "Icon",
        texture: { resourcePath: iconTexture },
        // A hover BRIGHTENS the icon without arming it — which is exactly why selfModulate can't be the signal.
        selfModulate: { html: "#57c4ffff" }
      })
    ];

    // Put away: the plain quill texture, however tinted.
    full(state, tools("res://images/packed/map/drawing_quill.png"), ["map", "drawButton", "icon"]);
    renderer.reconcile(state);
    expect(renderer.mapDrawingToolActive()).toBe(false);

    // Armed: the icon swaps to the *_glow variant.
    full(state, tools("res://images/packed/map/drawing_quill_glow.png"), ["map", "drawButton", "icon"]);
    renderer.reconcile(state);
    expect(renderer.mapDrawingToolActive()).toBe(true);

    // The eraser arms the same way.
    full(state, tools("res://images/packed/map/drawing_eraser_glow.png"), ["map", "drawButton", "icon"]);
    renderer.reconcile(state);
    expect(renderer.mapDrawingToolActive()).toBe(true);

    // A retained-but-hidden map screen never reports an armed tool.
    full(state, tools("res://images/packed/map/drawing_quill_glow.png", { visible: false }), ["map", "drawButton", "icon"]);
    renderer.reconcile(state);
    expect(renderer.mapDrawingToolActive()).toBe(false);
  });

  it("KEEPS element identity for unchanged nodes across a volatile-only delta (the incremental win)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("a", null), rawNode("b", null)], ["a", "b"]);
    renderer.reconcile(state);

    const aBefore = el(stage, "a")!;
    const bBefore = el(stage, "b")!;

    // Volatile-only upsert for "b" (empty name) — "a" is NOT in the delta, so it keeps its object identity and
    // must be skipped (same element, untouched). "b" updates in place (same element, new position).
    volatile(state, [rawNode("b", null, { name: "", localRect: { position: { x: 7, y: 9 }, size: { x: 40, y: 8 } } })]);
    renderer.reconcile(state);

    expect(el(stage, "a")).toBe(aBefore); // unchanged node → same element, not recreated
    expect(el(stage, "b")).toBe(bBefore); // changed node → same element, mutated in place
    expect(el(stage, "b")!.style.width).toBe("40px");
  });

  it("updates a changed CHILD even when its parent keeps object identity (deep change)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("p", null), rawNode("c", "p")], ["p", "c"]);
    renderer.reconcile(state);
    const cBefore = stage.querySelector('[data-node-id="c"]') as HTMLElement;
    expect(cBefore).not.toBeNull();

    // Only the child "c" is upserted; the parent "p" is NOT re-sent (keeps its object). The reconciler must
    // still descend to "c" and update it — skipping at the unchanged "p" would lose the change.
    volatile(state, [rawNode("c", "p", { name: "", localRect: { position: { x: 0, y: 0 }, size: { x: 55, y: 8 } } })]);
    renderer.reconcile(state);

    const cAfter = stage.querySelector('[data-node-id="c"]') as HTMLElement;
    expect(cAfter).toBe(cBefore);
    expect(cAfter.style.width).toBe("55px");
  });

  it("applies every change when several deltas coalesce into one reconcile", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("a", null), rawNode("b", null)], ["a", "b"]);
    renderer.reconcile(state);

    // Two volatile deltas with NO reconcile between them (Vue coalesces watcher runs); changedIds accumulates.
    volatile(state, [rawNode("a", null, { name: "", localRect: { position: { x: 0, y: 0 }, size: { x: 11, y: 8 } } })]);
    volatile(state, [rawNode("b", null, { name: "", localRect: { position: { x: 0, y: 0 }, size: { x: 22, y: 8 } } })]);
    renderer.reconcile(state);

    expect((el(stage, "a") as HTMLElement).style.width).toBe("11px");
    expect((el(stage, "b") as HTMLElement).style.width).toBe("22px");
  });

  it("toggles visibility via display without recreating the element", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("a", null)], ["a"]);
    renderer.reconcile(state);
    const aBefore = el(stage, "a")!;
    expect(aBefore.style.display).toBe("");

    volatile(state, [rawNode("a", null, { name: "", visible: false })]);
    renderer.reconcile(state);
    expect(el(stage, "a")).toBe(aBefore);
    expect(aBefore.style.display).toBe("none");

    volatile(state, [rawNode("a", null, { name: "", visible: true })]);
    renderer.reconcile(state);
    expect(aBefore.style.display).toBe("");
  });

  it("removes elements for nodes dropped on a structural delta", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("a", null), rawNode("b", null)], ["a", "b"]);
    renderer.reconcile(state);
    expect(el(stage, "b")).not.toBeNull();

    // Removal carries orderedIds (structural).
    applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", removedIds: ["b"], orderedIds: ["a"] })!);
    renderer.reconcile(state);

    expect(el(stage, "a")).not.toBeNull();
    expect(el(stage, "b")).toBeNull();
  });

  it("nests a clip_children node's descendants inside the clipper element", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("flat", null),
        rawNode("clipper", null, {
          clipChildren: 1,
          texture: { resourcePath: "res://images/ui/combat/health_bar.png", resourceType: "Texture2D" },
          ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 }
        }),
        rawNode("fill", "clipper")
      ],
      ["flat", "clipper", "fill"]
    );
    renderer.reconcile(state);

    const clipper = el(stage, "clipper")!;
    expect(clipper.style.overflow).toBe("hidden");
    // The clip child renders INSIDE the clipper; the flat sibling does not.
    expect(clipper.querySelector('[data-node-id="fill"]')).not.toBeNull();
    expect(clipper.querySelector('[data-node-id="flat"]')).toBeNull();
  });

  // A clip AndDraw container's self_modulate must NOT cascade onto its nested children (the reward-row
  // over-darkening): its own paint + tint move to a backmost `.mirror-clip-self` SIBLING of the children.
  function buildTintedClipper(state: MirrorState): void {
    full(
      state,
      [
        rawNode("clipper", null, {
          clipChildren: 2, // AndDraw: clips children AND paints its own texture
          ninePatch: true,
          texture: { resourcePath: "res://images/ui/combat/health_bar.png", resourceType: "Texture2D" },
          ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 },
          selfModulate: { r: 0.31, g: 0.31, b: 0.31, a: 1 } // → tint 0.31, own-paint only in Godot
        }),
        rawNode("fill", "clipper")
      ],
      ["clipper", "fill"]
    );
  }

  it("does not leak a clip container's self_modulate tint onto its nested children", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    buildTintedClipper(state);
    renderer.reconcile(state);

    const clipper = el(stage, "clipper")!;
    // Container carries the clip + NO tint filter (the leak source) and NO own texture paint.
    expect(clipper.style.overflow).toBe("hidden");
    expect(clipper.style.filter).toBe("");
    expect(clipper.style.borderImageSource).toBe("");

    // The own paint + tint live on the self-paint layer instead.
    const clipSelf = clipper.querySelector(":scope > .mirror-clip-self") as HTMLElement | null;
    expect(clipSelf).not.toBeNull();
    expect(clipSelf!.style.filter).toContain("mtint-16_16_16");
    expect(clipSelf!.style.borderImageSource).toContain("/res/images/ui/combat/health_bar.png");

    // The nested child is a SIBLING of the self-paint layer (not its descendant), so the tint can't cascade
    // onto it, and it carries no inherited tint filter of its own.
    const fill = clipper.querySelector('[data-node-id="fill"]') as HTMLElement;
    expect(fill).not.toBeNull();
    expect(clipSelf!.contains(fill)).toBe(false);
    expect(fill.style.filter).toBe("");
    // Paint order: the self-paint layer is BEHIND the nested child.
    const kids = [...clipper.children];
    expect(kids.indexOf(clipSelf!)).toBeLessThan(kids.indexOf(fill));
  });

  it("creates no self-paint layer for a CLIP_ONLY container with no own paint", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("clipper", null, { clipChildren: 1, ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 } }),
        rawNode("fill", "clipper")
      ],
      ["clipper", "fill"]
    );
    renderer.reconcile(state);

    const clipper = el(stage, "clipper")!;
    expect(clipper.querySelector(":scope > .mirror-clip-self")).toBeNull();
  });

  it("tears down the self-paint layer when the node stops being a clip container", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    buildTintedClipper(state);
    renderer.reconcile(state);
    expect(el(stage, "clipper")!.querySelector(":scope > .mirror-clip-self")).not.toBeNull();

    // Re-send the node as a plain (non-clip) node → the self-paint layer is removed.
    full(
      state,
      [
        rawNode("clipper", null, {
          clipChildren: 0,
          texture: { resourcePath: "res://images/ui/combat/health_bar.png", resourceType: "Texture2D" }
        })
      ],
      ["clipper"]
    );
    renderer.reconcile(state);
    expect(el(stage, "clipper")!.querySelector(":scope > .mirror-clip-self")).toBeNull();
  });
});

describe("createMirrorRenderer nested DOM tree", () => {
  it("nests each node's element INSIDE its parent's element (DOM mirrors the Godot tree)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("p", null, { transform: xform(100, 100) }),
        rawNode("c", "p", { transform: xform(50, 30) }),
        rawNode("g", "c", { transform: xform(10, 10) })
      ],
      ["p", "c", "g"]
    );
    renderer.reconcile(state);

    const p = el(stage, "p")!;
    const c = el(stage, "c")!;
    const g = el(stage, "g")!;
    expect(p.parentElement).toBe(stage); // root under the stage
    expect(c.parentElement).toBe(p); // nested
    expect(g.parentElement).toBe(c); // deeply nested
    // Each element receives its streamed local transform.
    expect(parseMatrix(c.style.transform).slice(4)).toEqual([50, 30]);
    expect(parseMatrix(g.style.transform).slice(4)).toEqual([10, 10]);
  });

  it("gives a BOXLESS container (children only, no own box) an element with pointer-events:none", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // "grp" has NO localRect/rect/text/clip/particle/spine — but it has a child, so it becomes a transform group.
    full(
      state,
      [
        { id: "grp", parentId: null, name: "grp", nodeType: "Node2D", visible: true }, // no box
        rawNode("kid", "grp", { transform: xform(20, 30) })
      ],
      ["grp", "kid"]
    );
    renderer.reconcile(state);

    const grp = el(stage, "grp");
    expect(grp).not.toBeNull(); // the container DOES get an element now (it's the group)
    expect(grp!.style.pointerEvents).toBe("none"); // …but non-interactive, so it never steals a child's hit
    expect(grp!.contains(el(stage, "kid")!)).toBe(true); // the child nests inside it
  });

  it("SCROLL-AS-ONE: moving a parent rewrites exactly ONE transform; the rigid descendant is byte-identical", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("p", null, { transform: xform(100, 100) }), rawNode("c", "p", { transform: xform(50, 30) })], ["p", "c"]);
    renderer.reconcile(state);
    const c = el(stage, "c")!;
    const cBefore = c.style.transform;

    // Scroll p by (+100, 0); c moves rigidly with it while its local transform stays unchanged.
    volatile(state, [
      rawNode("p", null, { name: "", transform: xform(200, 100) }),
      rawNode("c", "p", { name: "", transform: xform(50, 30) })
    ]);
    renderer.reconcile(state);

    expect(parseMatrix(el(stage, "p")!.style.transform).slice(4)).toEqual([200, 100]); // parent moved
    expect(el(stage, "c")!.style.transform).toBe(cBefore); // descendant: relative placement unchanged → byte-identical
  });

  it("orders behind-parent children BEFORE the node's own paint (sub-layers), normal children AFTER", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A parent with own paint (fillColor → self-layer), one behind child, one normal child.
    full(
      state,
      [
        rawNode("p", null, { fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000" } }),
        rawNode("behind", "p", { showBehindParent: true }),
        rawNode("front", "p", {})
      ],
      ["p", "behind", "front"]
    );
    renderer.reconcile(state);

    const p = el(stage, "p")!;
    const selfLayer = p.querySelector(":scope > .mirror-clip-self")!;
    const kids = [...p.children];
    const iBehind = kids.indexOf(el(stage, "behind")!);
    const iSelf = kids.indexOf(selfLayer);
    const iFront = kids.indexOf(el(stage, "front")!);
    // Paint order: behind-child, then the node's own paint, then the normal child.
    expect(iBehind).toBeLessThan(iSelf);
    expect(iSelf).toBeLessThan(iFront);
  });

  it("PARITY: each element's composed on-screen matrix + opacity match the local-transform oracle", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A nested tree with transforms, modulate (cascading opacity + tint), self_modulate, and a clip node.
    const R = rawNode("R", null, {
      transform: xform(50, 60),
      localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } },
      modulate: { r: 1, g: 1, b: 1, a: 0.8, html: "#ffffff" }
    });
    const A = rawNode("A", "R", {
      transform: xform(20, 20),
      localRect: { position: { x: 0, y: 0 }, size: { x: 40, y: 40 } },
      clipChildren: 1,
      modulate: { r: 0.5, g: 0.6, b: 0.7, a: 0.5, html: "#8099b3" } // tint + half alpha
    });
    const L = rawNode("L", "A", {
      transform: xform(20, 20, 2, 0, 0, 2), // scale 2
      localRect: { position: { x: 5, y: 5 }, size: { x: 10, y: 10 } },
      selfModulate: { r: 1, g: 1, b: 1, a: 0.5, html: "#ffffff" }
    });
    full(state, [R, A, L], ["R", "A", "L"]);
    renderer.reconcile(state);

    // Oracle: the on-screen matrix composes the local transforms and each node's local rect.
    const oracle = (g: Affine, lrx: number, lry: number) => nodeMatrix(g, { x: lrx, y: lry });
    approx(composedMatrix(el(stage, "R")!, stage), oracle([1, 0, 0, 1, 50, 60], 0, 0));
    approx(composedMatrix(el(stage, "A")!, stage), oracle([1, 0, 0, 1, 70, 80], 0, 0));
    approx(composedMatrix(el(stage, "L")!, stage), oracle([2, 0, 0, 2, 90, 100], 5, 5));

    // Composed opacity of the LEAF equals the old ownOpacity = ∏(ancestor modulate.a) × own modulate.a × selfAlpha.
    // R=0.8, A=0.5, L=(1 × 0.5) → 0.8 × 0.5 × 0.5 = 0.2.
    expect(composedOpacity(el(stage, "L")!, stage)).toBeCloseTo(0.2, 6);
  });

  it("ATLAS PARENT: the paint fit rides the canvas, never the container — nested children keep exact globals", () => {
    // The map-legend regression: a keep-aspect atlas TextureRect with children baked `scale(fit)` (+ centering
    // offset) into its element transform, shrinking every DOM-nested descendant by the fit factor.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const P = rawNode("P", null, {
      nodeType: "TextureRect",
      transform: xform(100, 200),
      localRect: { position: { x: 0, y: 0 }, size: { x: 50, y: 100 } },
      texture: { resourcePath: "res://images/atlases/ui_atlas_0.png" },
      textureRegion: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } },
      textureStretchMode: 5 // keep-aspect-centered → fit 0.5, cy 25
    });
    const C = rawNode("C", "P", {
      transform: xform(10, 20),
      localRect: { position: { x: 0, y: 0 }, size: { x: 20, y: 20 } }
    });
    full(state, [P, C], ["P", "C"]);
    renderer.reconcile(state);

    const p = el(stage, "P")!;
    // Container: pure placement (lr box, no fit scale) — the frame the child is re-based against.
    expect(p.style.transform).toBe("matrix(1, 0, 0, 1, 100, 200)");
    expect(p.style.width).toBe("50px");
    expect(p.style.height).toBe("100px");
    // The fit lives on the atlas SPRITE element itself (Stage C: the unbaked placeholder is a page-crop div —
    // same placement contract the canvas carried), which nests inside the self-paint wrapper (own-paint group).
    const canvas = p.querySelector(":scope > .mirror-clip-self > .mirror-atlas-page") as HTMLElement;
    expect(canvas).not.toBeNull();
    expect(canvas.style.transform).toBe("translate(0px, 25px) scale(0.5)");
    expect(canvas.style.width).toBe("100px");
    expect(canvas.style.height).toBe("100px");
    // The nested child composes to its exact placement — unaffected by the parent's paint fit.
    approx(composedMatrix(el(stage, "C")!, stage), nodeMatrix([1, 0, 0, 1, 110, 220], { x: 0, y: 0 }));
  });

  it("ATLAS PARENT: self_modulate dims the node's OWN canvas paint, never the nested children (map-icon dim)", () => {
    // The map-icon regression: an interior TextureRect dimmed via self_modulate.a=0.5 rendered its atlas canvas
    // at full opacity because the canvas sat OUTSIDE the self-paint layer that carried the alpha.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const P = rawNode("P", null, {
      nodeType: "TextureRect",
      transform: xform(100, 200),
      localRect: { position: { x: 0, y: 0 }, size: { x: 50, y: 100 } },
      texture: { resourcePath: "res://images/atlases/ui_atlas_0.png" },
      textureRegion: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } },
      textureStretchMode: 5,
      selfModulate: { r: 1, g: 1, b: 1, a: 0.5, html: "#ffffff80" }
    });
    const C = rawNode("C", "P", {
      transform: xform(110, 220),
      localRect: { position: { x: 0, y: 0 }, size: { x: 20, y: 20 } }
    });
    full(state, [P, C], ["P", "C"]);
    renderer.reconcile(state);

    const p = el(stage, "P")!;
    const selfLayer = p.querySelector(":scope > .mirror-clip-self") as HTMLElement;
    expect(selfLayer).not.toBeNull();
    expect(selfLayer.style.opacity).toBe("0.5"); // selfAlpha on the paint group…
    // …which contains the sprite paint (the Stage-C page-crop placeholder div here — jsdom never bakes a blob).
    expect(selfLayer.querySelector(":scope > .mirror-atlas-page")).not.toBeNull();
    expect(p.style.opacity).toBe("1"); // modulate.a (the cascading channel) untouched
    expect(composedOpacity(el(stage, "C")!, stage)).toBeCloseTo(1, 6); // children never inherit selfAlpha
  });
});

describe("wide-screen anchor re-layout (setStretch)", () => {
  const F = MIRROR_MAX_DESIGN_WIDTH / 1920; // 1.3125 — the widest stretch (2520/1920); the squeeze field factor
  const DESIGN_W = MIRROR_MAX_DESIGN_WIDTH; // 2520
  const DELTA = (F - 1) * 1920; // 600 — the root's parent-width delta the anchor fractions budget against

  // The on-screen center-x of a node's box: composed origin + half its (composed-scaled) local width.
  function centerX(node: HTMLElement, stage: HTMLElement, localWidth: number): number {
    const m = composedMatrix(node, stage);
    return m[4] + m[0] * (localWidth / 2);
  }

  // A combat-like tree mirroring the live DOM, each node carrying the two anchor fractions the producer streams
  // (offsets cancel in the delta, so only anchors matter): a FULL-anchored (0..1) frame + fill + bg image (stretch
  // to fill), a CENTER-anchored (0.5/0.5) hand holding two cards that RIDE its re-center, a LEFT-anchored (0/0)
  // pile, a RIGHT-anchored (1/1) end-turn, and a partial-anchored (0..1) relic bar (widens in place). The cards are
  // NON-anchored (null) — they ride their parent verbatim, the "art rides the container" case.
  function combatTree(state: MirrorState): void {
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("backstop", "frame", { nodeType: "ColorRect", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("bgImage", "frame", { nodeType: "TextureRect", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("hand", "frame", { nodeType: "Control", transform: xform(960, 900), localRect: box(0, 0), anchorLeft: 0.5, anchorRight: 0.5 }),
      rawNode("cardL", "hand", { nodeType: "NCard", transform: xform(-420, -100), localRect: box(160, 220) }),
      rawNode("cardR", "hand", { nodeType: "NCard", transform: xform(260, -100), localRect: box(160, 220) }),
      rawNode("pile", "frame", { nodeType: "Control", transform: xform(15, 980), localRect: box(80, 80), anchorLeft: 0, anchorRight: 0 }),
      rawNode("endTurn", "frame", { nodeType: "Control", transform: xform(1604, 980), localRect: box(220, 80), anchorLeft: 1, anchorRight: 1 }),
      rawNode("relics", "frame", { nodeType: "Control", transform: xform(12, 20), localRect: box(1808, 84), anchorLeft: 0, anchorRight: 1 })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
  }

  it("is a no-op at factor 1 (16:9)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    combatTree(state);
    renderer.setStretch(1);
    renderer.reconcile(state);
    expect(centerX(el(stage, "cardL")!, stage, 160)).toBeCloseTo(620, 4);
    expect(centerX(el(stage, "cardR")!, stage, 160)).toBeCloseTo(1300, 4);
    expect(centerX(el(stage, "endTurn")!, stage, 220)).toBeCloseTo(1714, 4);
    expect(el(stage, "backstop")!.style.width).toBe("1920px"); // no widen at f=1
    expect(el(stage, "relics")!.style.width).toBe("1808px");
  });

  it("stretches full-anchored (0..1) frames/fills/images to the stage width without shifting them", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    combatTree(state);
    renderer.setStretch(F);
    renderer.reconcile(state);
    const stageW = `${DESIGN_W}px`;
    // full-anchored → the painted box grows to fill; the origin stays put (anchorLeft 0 → dx 0). The TextureRect is
    // NO LONGER excluded — Godot stretches a full-anchored image too, so it widens like the rest.
    for (const id of ["frame", "backstop", "bgImage"]) {
      expect(el(stage, id)!.style.width).toBe(stageW);
      expect(composedMatrix(el(stage, id)!, stage)[4]).toBeCloseTo(0, 6);
      expect(composedMatrix(el(stage, id)!, stage)[0]).toBeCloseTo(1, 6); // grown via width, NOT a transform scale
    }
  });

  it("hugs a right-anchored (1/1) HUD to the right edge (shift by Δparent, no widen)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    combatTree(state);
    renderer.setStretch(F);
    renderer.reconcile(state);
    expect(composedMatrix(el(stage, "endTurn")!, stage)[4]).toBeCloseTo(1604 + DELTA, 3);
    expect(el(stage, "endTurn")!.style.width).toBe("220px"); // (1−1)·Δ → no widen
  });

  it("keeps a left-anchored (0/0) HUD pinned to the left (no shift, no widen)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    combatTree(state);
    renderer.setStretch(F);
    renderer.reconcile(state);
    expect(composedMatrix(el(stage, "pile")!, stage)[4]).toBeCloseTo(15, 4);
    expect(el(stage, "pile")!.style.width).toBe("80px");
  });

  it("re-centers a 0/0-anchored FULL-CANVAS box (map parchment tile) while small 0/0 boxes stay pinned", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // The map screen chain: a stretched full-span frame whose 0/0-anchored children are (a) a 1920-wide parchment
    // TILE — background ART authored for the whole canvas, must re-CENTER (½Δ) with the map's 0.5-anchored content
    // (paths/rooms/legend), NOT pin left — and (b) a small 80px pile that keeps its authored corner.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("tile", "frame", { nodeType: "TextureRect", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 0 }),
      rawNode("pile", "frame", { nodeType: "Control", transform: xform(15, 980), localRect: box(80, 80), anchorLeft: 0, anchorRight: 0 })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    expect(composedMatrix(el(stage, "tile")!, stage)[4]).toBeCloseTo(DELTA / 2, 3); // centered: [300, 2220] on 2520
    expect(el(stage, "tile")!.style.width).toBe("1920px"); // translated, never stretched (art isn't distorted)
    expect(el(stage, "tile")!.getAttribute("data-spread-w")).toBeNull();
    expect(el(stage, "tile")!.getAttribute("data-spread-mode")).toBeNull(); // an anchored translation for pointerMap
    expect(Number(el(stage, "tile")!.getAttribute("data-spread-dx"))).toBeCloseTo(DELTA / 2, 3);
    expect(composedMatrix(el(stage, "pile")!, stage)[4]).toBeCloseTo(15, 4); // small 0/0 box keeps its corner
  });

  it("R3-Q4: re-centers a full-frame card-PREVIEW container (+ backdrop + off-center preview card) on ½Δ, rigidly", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A focused card's linked-card preview: a full-frame 0/1 NCardPreviewContainer under the scene frame holding a
    // full-frame backdrop and an OFF-CENTER preview card. The container must re-center on ½Δ and CONSUME the budget so
    // the backdrop AND the card ride the SAME rigid shift (no drift) — the card would otherwise take its own claim.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("preview", "frame", { nodeType: "NCardPreviewContainer", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("backdrop", "preview", { nodeType: "TextureRect", transform: xform(0, 0), localRect: box(1920, 1080) }),
      rawNode("card", "preview", { nodeType: "NCard", transform: xform(1320, 400), localRect: box(160, 220) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    // backdrop + card ride the SAME ½Δ: their composed origins shift by exactly ½Δ off their native x.
    expect(Number(el(stage, "preview")!.getAttribute("data-spread-dx"))).toBeCloseTo(DELTA / 2, 3);
    expect(Number(el(stage, "backdrop")!.getAttribute("data-spread-dx"))).toBeCloseTo(DELTA / 2, 3);
    expect(Number(el(stage, "card")!.getAttribute("data-spread-dx"))).toBeCloseTo(DELTA / 2, 3);
    // rigid ride (anchored translation), not the positional field.
    expect(el(stage, "card")!.getAttribute("data-spread-mode")).toBeNull();
  });

  it("R3-Q4: a NARROW preview container (Messy 1355) rides its parent's shift (not ½Δ) but still consumes", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // NMessyCardPreviewContainer streams 1355×762 (confirmed from recordings) — narrower than the 1920 frame, so it
    // must NOT over-center on ½Δ; it rides the parent (dx 0 here) while STILL consuming so the inner card doesn't drift.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("messy", "frame", { nodeType: "NMessyCardPreviewContainer", transform: xform(0, 0), localRect: box(1355, 762), anchorLeft: 0, anchorRight: 1 }),
      rawNode("card", "messy", { nodeType: "NCard", transform: xform(1320, 400), localRect: box(160, 220) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    // narrow container rides parent (dx 0), not ½Δ; card rides it rigidly (consume), not its own 1400·rate claim.
    expect(Number(el(stage, "messy")!.getAttribute("data-spread-dx") ?? "0")).toBeCloseTo(0, 3);
    expect(Number(el(stage, "card")!.getAttribute("data-spread-dx") ?? "0")).toBeCloseTo(0, 3);
    expect(el(stage, "card")!.getAttribute("data-spread-mode")).toBeNull();
  });

  // ---- WS-3 map DRAWING TOOLS (twin of the native SpreadWalkTests DrawingTools legs) ------------------------------

  // The map screen's draw/erase/clear palette: a small 0/0-anchored NinePatchRect whose anchor claim would be 0, so it
  // would stay a FIXED distance from the stage's LEFT edge while the map's own content (the full-canvas parchment tile
  // + the 0.5-anchored paths/rooms/legend) re-centers on ½Δ. Matched by SCENE IDENTITY it claims 0.5 instead, so it
  // keeps its position relative to the centered map; its span is 0 so the whole subtree rides that ONE shift rigidly.
  function mapScreenTree(state: MirrorState): void {
    const nodes = [
      rawNode("MapScreen", null, {
        nodeType: "Control",
        sceneFilePath: "res://scenes/screens/map/map_screen.tscn",
        transform: xform(0, 0),
        localRect: box(1920, 1080),
        anchorLeft: 0,
        anchorRight: 1
      }),
      // the full-canvas parchment tile — the centered map content the palette must stay matched to (½Δ).
      rawNode("MapTile", "MapScreen", { nodeType: "TextureRect", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 0 }),
      rawNode("DrawingTools", "MapScreen", { nodeType: "NinePatchRect", transform: xform(56, 972), localRect: box(208, 68), anchorLeft: 0, anchorRight: 0 }),
      rawNode("HBoxContainer", "DrawingTools", { nodeType: "HBoxContainer", transform: xform(66, 976), localRect: box(188, 60), mouseFilter: 2 }),
      rawNode("DrawButton", "HBoxContainer", { nodeType: "Control", transform: xform(66, 976), localRect: box(60, 60), mouseFilter: 0 }),
      // a genuine bottom-left CORNER widget on the same screen: it must KEEP its corner (the rule is identity-scoped,
      // not "every small 0/0 box on the map").
      rawNode("Back", "MapScreen", { nodeType: "Control", transform: xform(15, 980), localRect: box(80, 80), anchorLeft: 0, anchorRight: 0 }),
      // a same-NAMED node under a DIFFERENT scene: the name is only a pre-filter, so this one must not re-center.
      rawNode("OtherScreen", null, {
        nodeType: "Control",
        sceneFilePath: "res://scenes/screens/deck_view_screen.tscn",
        transform: xform(0, 0),
        localRect: box(1920, 1080),
        anchorLeft: 0,
        anchorRight: 1
      }),
      rawNode("otherTools", "OtherScreen", { name: "DrawingTools", nodeType: "NinePatchRect", transform: xform(56, 972), localRect: box(208, 68), anchorLeft: 0, anchorRight: 0 })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
  }

  it("WS-3: re-centers the map DrawingTools palette on ½Δ (matched to the centered map content), subtree rigid", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    mapScreenTree(state);
    renderer.setStretch(F);
    renderer.reconcile(state);
    // the palette claims 0.5 — exactly the ½Δ the full-canvas parchment tile re-centers on.
    expect(Number(el(stage, "DrawingTools")!.getAttribute("data-spread-dx"))).toBeCloseTo(DELTA / 2, 3);
    expect(Number(el(stage, "MapTile")!.getAttribute("data-spread-dx"))).toBeCloseTo(DELTA / 2, 3);
    // BOTH WS-3 halves land on this one node: the ½Δ spread shift AND the 1.35 view-scale stamp about the SHIFTED
    // centre (160+½Δ = 460) → left edge 460 + 1.35·(356−460) = 319.6, still far inside the 2520-wide stage.
    const toolsM = composedMatrixAll(el(stage, "DrawingTools")!, stage);
    expect(toolsM[0]).toBeCloseTo(1.35, 6);
    expect(toolsM[4]).toBeCloseTo(319.6, 6);
    // span 0 ⇒ deltaW 0: the panel is TRANSLATED, never widened, and its buttons ride the SAME shift rigidly.
    expect(el(stage, "DrawingTools")!.style.width).toBe("208px");
    expect(el(stage, "DrawingTools")!.getAttribute("data-spread-w")).toBeNull();
    for (const id of ["HBoxContainer", "DrawButton"]) {
      expect(Number(el(stage, id)!.getAttribute("data-spread-dx"))).toBeCloseTo(DELTA / 2, 3);
      expect(el(stage, id)!.getAttribute("data-spread-mode")).toBeNull(); // an anchored translation, not the field
    }
    // NEGATIVE legs: an ordinary 0/0 corner widget on the same screen keeps its corner, and a same-NAMED node under a
    // different scene file is untouched (the match is scene identity, not the name alone).
    expect(composedMatrixAll(el(stage, "Back")!, stage)[4]).toBeCloseTo(15, 4);
    expect(composedMatrixAll(el(stage, "Back")!, stage)[0]).toBeCloseTo(1, 6); // and it is not view-scaled either
    expect(Number(el(stage, "otherTools")!.getAttribute("data-spread-dx") ?? "0")).toBeCloseTo(0, 3);
    expect(composedMatrixAll(el(stage, "otherTools")!, stage)[0]).toBeCloseTo(1, 6);
  });

  // ---- R19 6b MAIN-MENU FOCUS RIBBONS (twin of the native SpreadWalkTests MenuReticle legs) ---------------------

  // The main menu's focus ribbons: two 40x40 0/0-anchored TextureRects, DIRECT children of the menu root, whose
  // origins the game rewrites each frame to flank the focused option in the 0.5/0.5 option column. Too small for the
  // fullCanvas seam, so the anchor algebra claims 0 for them and they strand ½Δ left of the option they mark.
  // Shape from a live lobby recording (.sts2/bench/ws7-charselect-hostready.ndjson).
  function mainMenuTree(state: MirrorState): void {
    const nodes = [
      rawNode("MainMenu", null, {
        nodeType: "Control",
        sceneFilePath: "res://scenes/screens/main_menu.tscn",
        transform: xform(0, 0),
        localRect: box(1920, 1080),
        anchorLeft: 0,
        anchorRight: 1
      }),
      // the option column — the centered content the ribbons must stay matched to (½Δ).
      rawNode("MainMenuTextButtons", "MainMenu", { nodeType: "VBoxContainer", transform: xform(826, 315), localRect: box(269, 450), anchorLeft: 0.5, anchorRight: 0.5 }),
      rawNode("ButtonReticleLeft", "MainMenu", { nodeType: "TextureRect", transform: xform(636, 633), localRect: box(40, 40), anchorLeft: 0, anchorRight: 0 }),
      rawNode("ButtonReticleRight", "MainMenu", { nodeType: "TextureRect", transform: xform(859, 618), localRect: box(40, 40), anchorLeft: 0, anchorRight: 0 }),
      // a genuine top-left CORNER widget on the same screen: it must KEEP its corner.
      rawNode("ChangeProfileButton", "MainMenu", { nodeType: "Control", transform: xform(40, 40), localRect: box(172, 64), anchorLeft: 0, anchorRight: 0 }),
      // a same-NAMED ribbon under a DIFFERENT scene: the name is only a pre-filter.
      rawNode("OtherMenu", null, {
        nodeType: "Control",
        sceneFilePath: "res://scenes/screens/character_select.tscn",
        transform: xform(0, 0),
        localRect: box(1920, 1080),
        anchorLeft: 0,
        anchorRight: 1
      }),
      rawNode("otherReticle", "OtherMenu", { name: "ButtonReticleLeft", nodeType: "TextureRect", transform: xform(636, 633), localRect: box(40, 40), anchorLeft: 0, anchorRight: 0 }),
      // right scene file + right name but NESTED (relPath "Wrapper/ButtonReticleLeft") → no match.
      rawNode("Wrapper", "MainMenu", { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("nestedReticle", "Wrapper", { name: "ButtonReticleLeft", nodeType: "TextureRect", transform: xform(636, 633), localRect: box(40, 40), anchorLeft: 0, anchorRight: 0 })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
  }

  it("R19 6b: the menu focus ribbons ride the option column's ½Δ instead of stranding left", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    mainMenuTree(state);
    renderer.setStretch(F);
    renderer.reconcile(state);
    // the option column re-centers; the ribbons now claim the same 0.5.
    expect(Number(el(stage, "MainMenuTextButtons")!.getAttribute("data-spread-dx"))).toBeCloseTo(DELTA / 2, 3);
    for (const id of ["ButtonReticleLeft", "ButtonReticleRight"]) {
      expect(Number(el(stage, id)!.getAttribute("data-spread-dx"))).toBeCloseTo(DELTA / 2, 3);
      expect(el(stage, id)!.getAttribute("data-spread-mode")).toBeNull(); // an anchored translation, not the field
      expect(el(stage, id)!.getAttribute("data-spread-w")).toBeNull(); // span 0 ⇒ translated, never widened
      expect(el(stage, id)!.style.width).toBe("40px");
    }
    expect(composedMatrixAll(el(stage, "ButtonReticleLeft")!, stage)[4]).toBeCloseTo(636 + DELTA / 2, 4);
    // NEGATIVE legs: an ordinary 0/0 corner widget keeps its corner; a same-NAMED ribbon under another scene file and
    // a NESTED one are untouched (the match is the full scene-identity tuple, not the name alone).
    expect(Number(el(stage, "ChangeProfileButton")!.getAttribute("data-spread-dx") ?? "0")).toBeCloseTo(0, 3);
    expect(Number(el(stage, "otherReticle")!.getAttribute("data-spread-dx") ?? "0")).toBeCloseTo(0, 3);
    expect(Number(el(stage, "nestedReticle")!.getAttribute("data-spread-dx") ?? "0")).toBeCloseTo(0, 3);
  });

  it("widens a partial-anchored (0..1) bar in place (RelicInventory: grows, doesn't shift)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    combatTree(state);
    renderer.setStretch(F);
    renderer.reconcile(state);
    expect(composedMatrix(el(stage, "relics")!, stage)[4]).toBeCloseTo(12, 4); // anchorLeft 0 → no shift
    expect(el(stage, "relics")!.style.width).toBe(`${1808 + DELTA}px`); // (1−0)·Δ widen
  });

  it("spreads a center-anchored (0.5/0.5) hand's cards per-position on the field (pass-through group)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    combatTree(state);
    renderer.setStretch(F);
    renderer.reconcile(state);
    // The zero-size hand is a PASS-THROUGH group (it passes the widening budget through), so each card takes its OWN
    // positional claim at its center: renderedCenter = gameCenter·F. Cards spread WIDER than 16:9 (the user goal).
    expect(centerX(el(stage, "cardL")!, stage, 160)).toBeCloseTo(620 * F, 3); // 813.75
    expect(centerX(el(stage, "cardR")!, stage, 160)).toBeCloseTo(1300 * F, 3); // 1706.25
    const gap = centerX(el(stage, "cardR")!, stage, 160) - centerX(el(stage, "cardL")!, stage, 160);
    expect(gap).toBeCloseTo((1300 - 620) * F, 3); // 892.5 — the gap GREW (680 → 892.5), i.e. the cards spread out
    // Each card keeps its native width + scale (translated on the field, never internally stretched).
    expect(composedMatrix(el(stage, "cardL")!, stage)[0]).toBeCloseTo(1, 6);
    expect(el(stage, "cardL")!.style.width).toBe("160px");
  });

  it("gives anchored boxes under a zero-size group positional claims (creature hitbox/healthbar ride the field)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // The live combat chain: full-span scene → zero-size 0.5/0.5 EnemyContainer (pass-through) → boxless Creature
    // (pass-through) → a non-anchored visual + ANCHORED boxed parts (Hitbox / healthbar). The anchored parts face a
    // ZERO-SIZE frame — their anchors are meaningless (the frame never resizes), so they must take positional field
    // claims like the visual, NOT the anchor algebra (which would strand them at dx 0 while the visual shifts —
    // the "healthbar 300px left of the enemy" live regression).
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("enemies", "frame", { nodeType: "Control", transform: xform(1128, 300), localRect: box(0, 0), anchorLeft: 0.5, anchorRight: 0.5 }),
      rawNode("creature", "enemies", { nodeType: "Control", transform: xform(272, 200), localRect: box(0, 0) }),
      rawNode("visual", "creature", { nodeType: "Sprite2D", transform: xform(-100, -120), localRect: box(200, 300) }),
      rawNode("hitbox", "creature", { nodeType: "Control", transform: xform(-120, -120), localRect: box(240, 300), anchorLeft: 0, anchorRight: 0 }),
      rawNode("healthbar", "creature", { nodeType: "Control", transform: xform(-110, 200), localRect: box(220, 30), anchorLeft: 0.5, anchorRight: 0.5 })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    // Every CONTROL part rides the creature's ONE field shift dx = 1400·(F−1) (the pass-through group's own claim).
    const dx = 1400 * (F - 1); // 437.5
    expect(composedMatrix(el(stage, "visual")!, stage)[4]).toBeCloseTo(1300 + dx, 3);
    expect(composedMatrix(el(stage, "hitbox")!, stage)[4]).toBeCloseTo(1280 + dx, 3);
    expect(composedMatrix(el(stage, "healthbar")!, stage)[4]).toBeCloseTo(1290 + dx, 3);
    // Positional claims: no widening, and the field mode is stamped for the input side.
    expect(el(stage, "hitbox")!.style.width).toBe("240px");
    expect(el(stage, "hitbox")!.getAttribute("data-spread-mode")).toBe("prop");
    // An anchored box under a REAL resizing frame keeps the anchor algebra and does NOT stamp prop.
    combatTree(state);
    renderer.reconcile(state);
    expect(el(stage, "pile")!.getAttribute("data-spread-mode")).toBeNull();
  });

  it("rides CORNER-placed Control parts on their entity's shift, while Node2D content keeps its own field claim", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // The card case: an OFF-CENTER anchored boxed Control (the energy cost at the card's corner) must ride the
    // holder's ONE dx — a per-part own-center claim gave it a visibly different shift (drifted ~25px off the card).
    // A Node2D child (an arrow segment / world sprite) is world-placed and keeps its own field claim.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("holder", "frame", { nodeType: "NHandCardHolder", transform: xform(1400, 900), localRect: box(0, 0) }),
      // Anchored boxed Control centered at 1300 — 100 game px LEFT of the holder origin (energy-icon analog).
      rawNode("badge", "holder", { nodeType: "TextureRect", transform: xform(-125, -50), localRect: box(50, 50), anchorLeft: 0, anchorRight: 0 }),
      // Node2D sprite centered at 1300 — same offset, but WORLD content → own field claim.
      rawNode("segment", "holder", { nodeType: "Sprite2D", transform: xform(-125, -500), localRect: box(50, 50) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    const holderDx = 1400 * (F - 1); // 437.5 — the pass-through group's own claim
    const ownDx = 1300 * (F - 1); // 406.25 — what an own-center claim would give
    expect(composedMatrix(el(stage, "badge")!, stage)[4]).toBeCloseTo(1275 + holderDx, 3); // rides the entity
    expect(Number(el(stage, "badge")!.getAttribute("data-spread-dx"))).toBeCloseTo(holderDx, 3);
    expect(composedMatrix(el(stage, "segment")!, stage)[4]).toBeCloseTo(1275 + ownDx, 3); // own field claim
    expect(Number(el(stage, "segment")!.getAttribute("data-spread-dx"))).toBeCloseTo(ownDx, 3);
  });

  it("stamps data-spread-mode='prop' on riders inside a claimed subtree (deep card art carries its holder's field)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A press lands on the PAINTED DESCENDANT (card art), not the claiming holder — pointerMap reads the mode off
    // the element it hits, so riders inside a positional subtree must inherit the prop stamp (and the exact dx).
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("hand", "frame", { nodeType: "Control", transform: xform(960, 900), localRect: box(0, 0), anchorLeft: 0.5, anchorRight: 0.5 }),
      rawNode("card", "hand", { nodeType: "NCard", transform: xform(-420, -100), localRect: box(160, 220) }),
      rawNode("art", "card", { nodeType: "TextureRect", transform: xform(10, 20), localRect: box(140, 100), anchorLeft: 0, anchorRight: 0 })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    const dx = 620 * (F - 1); // the card claims at its center (620); the art rides that exact shift
    expect(el(stage, "art")!.getAttribute("data-spread-mode")).toBe("prop");
    expect(Number(el(stage, "art")!.getAttribute("data-spread-dx"))).toBeCloseTo(dx, 3);
    expect(composedMatrix(el(stage, "art")!, stage)[4]).toBeCloseTo(550 + dx, 3);
  });

  it("places non-Control content (VFX / world sprite) on the field at its own center", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A full-anchored VFX layer (widens, passes Δ down) holding a non-Control sprite authored near 1920-center.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("vfxLayer", "frame", { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      // No anchors → world "content"; placed on the field at its own center (renderedCenter = gameCenter·F).
      rawNode("vfx", "vfxLayer", { nodeType: "GpuParticles2D", transform: xform(900, 500), localRect: box(80, 80) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    // center 940 → dx = 940·(F−1) = 293.75; origin renders at 900 + 293.75; the box CENTER lands at 940·F.
    expect(composedMatrix(el(stage, "vfx")!, stage)[4]).toBeCloseTo(900 + 940 * (F - 1), 3);
    expect(centerX(el(stage, "vfx")!, stage, 80)).toBeCloseTo(940 * F, 3);
  });

  it("centers an oversized (>1920) center-covering background at its center and keeps it covering the stage", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // The combat parallax bg: a 2764.8-wide TextureRect (wider than the viewport, so it covers with margin),
    // authored centered on 1920 (origin −422.4 → center 960), UNDER a zero-size boxless BgContainer (pass-through).
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("bgContainer", "frame", { nodeType: "Control", transform: xform(0, 0), localRect: box(0, 0) }),
      rawNode("bg", "bgContainer", { nodeType: "TextureRect", transform: xform(-422.4, 0), localRect: box(2764.8, 1080) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    // Claims at its CENTER (960 → dx = ½Δ = 300), NOT its origin — so the box stays centered on the wider stage.
    const m = composedMatrix(el(stage, "bg")!, stage);
    expect(centerX(el(stage, "bg")!, stage, 2764.8)).toBeCloseTo(960 * F, 3); // = 1260 = stage center (2520/2)
    // Width is NOT stretched (a positional claimer translates, never widens): it still fully covers [0, 2520].
    expect(el(stage, "bg")!.style.width).toBe("2764.8px");
    expect(m[4]).toBeLessThanOrEqual(0); // rendered left edge at/left of 0
    expect(m[4] + 2764.8).toBeGreaterThanOrEqual(DESIGN_W); // rendered right edge at/right of the stage width
  });

  it("shifts an owner-anchored floater (HoverTip) by its OWNER's shift and rides its subtree", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A right-anchored button (the owner, hugs the right edge → +Δ) and, in a SEPARATE un-shifted container (like
    // /root/Game/HoverTipsContainer, anchored 0/0), a tooltip authored at the owner's NATIVE x carrying
    // anchorOwnerId=owner, with a nested label that must ride it — the whole tip tracks the button.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("owner", "frame", { nodeType: "Control", transform: xform(1700, 20), localRect: box(120, 60), anchorLeft: 1, anchorRight: 1 }),
      rawNode("tips", "frame", { nodeType: "Control", transform: xform(0, 0), localRect: box(0, 0), anchorLeft: 0, anchorRight: 0 }),
      rawNode("tooltip", "tips", { nodeType: "NHoverTipSet", transform: xform(1700, 110), localRect: box(360, 80), anchorOwnerId: "owner" }),
      rawNode("tipLabel", "tooltip", { nodeType: "Label", transform: xform(10, 10), localRect: box(340, 40) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    // Owner hugs the right edge (+Δ). The tooltip rides the SAME shift (NOT the center-fallback's +½Δ), and its
    // nested label rides it too.
    expect(composedMatrix(el(stage, "owner")!, stage)[4]).toBeCloseTo(1700 + DELTA, 3);
    expect(composedMatrix(el(stage, "tooltip")!, stage)[4]).toBeCloseTo(1700 + DELTA, 3);
    expect(composedMatrix(el(stage, "tipLabel")!, stage)[4]).toBeCloseTo(1710 + DELTA, 3);
    expect(el(stage, "tooltip")!.style.width).toBe("360px"); // a tooltip doesn't widen
  });

  it("leaves an owner-anchored floater unshifted (and un-centered) when its owner is absent", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("tips", "frame", { nodeType: "Control", transform: xform(0, 0), localRect: box(0, 0), anchorLeft: 0, anchorRight: 0 }),
      rawNode("tooltip", "tips", { nodeType: "NHoverTipSet", transform: xform(1700, 110), localRect: box(360, 80), anchorOwnerId: "ghost" })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    // Unknown owner → no shift; and an owner-anchored node opts OUT of the center-fallback, so it isn't +½Δ either.
    expect(composedMatrix(el(stage, "tooltip")!, stage)[4]).toBeCloseTo(1700, 3);
  });

  it("R5 H1: a floater under a shift-claiming ancestor rides ONLY the owner's Δ (no ParentDx double-count)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // The tips live under a positional-claimer world sprite (a shift-claiming ancestor → non-zero ParentDx). The
    // floater must ride ONLY the owner's Δ; the pre-R5 `parentDx + ownerDx` strands it far right.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("owner", "frame", { nodeType: "Control", transform: xform(1700, 20), localRect: box(120, 60), anchorLeft: 1, anchorRight: 1 }),
      rawNode("tipHost", "frame", { nodeType: "Sprite2D", transform: xform(800, 500), localRect: box(100, 100) }),
      rawNode("tooltip", "tipHost", { nodeType: "NHoverTipSet", transform: xform(900, -390), localRect: box(360, 80), anchorOwnerId: "owner" }),
      rawNode("tipLabel", "tooltip", { nodeType: "Label", transform: xform(10, 10), localRect: box(340, 40) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    expect(composedMatrix(el(stage, "owner")!, stage)[4]).toBeCloseTo(1700 + DELTA, 3);
    // Rides the owner's Δ alone — NOT 1700 + DELTA + tipHost's own claim.
    expect(composedMatrix(el(stage, "tooltip")!, stage)[4]).toBeCloseTo(1700 + DELTA, 3);
    expect(composedMatrix(el(stage, "tipLabel")!, stage)[4]).toBeCloseTo(1710 + DELTA, 3);
  });

  it("R5 H2: a floater on a 0×0 holder follows the holder's painting card child (not the holder origin)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A 0×0 NHandCardHolder (owner) whose pass-through claim rides its ORIGIN (1000), and a painting card child whose
    // own positional claim is at its centre (900). The tip must follow the CARD's Δ, not the holder's.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("hand", "frame", { nodeType: "Control", transform: xform(960, 900), localRect: box(0, 0), anchorLeft: 0.5, anchorRight: 0.5 }),
      rawNode("holder", "hand", { nodeType: "NHandCardHolder", transform: xform(40, -50), localRect: box(0, 0) }),
      rawNode("card", "holder", { nodeType: "Label", transform: xform(-180, -50), localRect: box(160, 220), text: { text: "Strike" } }),
      rawNode("tips", "frame", { nodeType: "Control", transform: xform(0, 0), localRect: box(0, 0), anchorLeft: 0, anchorRight: 0 }),
      rawNode("tooltip", "tips", { nodeType: "NHoverTipSet", transform: xform(1000, 500), localRect: box(360, 80), anchorOwnerId: "holder" })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    const cardDx = 900 * (F - 1); // the card's own centre claim (820 + 80 = 900)
    expect(composedMatrix(el(stage, "card")!, stage)[4]).toBeCloseTo(820 + cardDx, 3);
    // Tooltip follows the card's Δ (1000 + cardDx), NOT the 0×0 holder-origin Δ (1000 + 1000·(F−1)).
    expect(composedMatrix(el(stage, "tooltip")!, stage)[4]).toBeCloseTo(1000 + cardDx, 3);
  });

  // R8 (WS-1): the corner piles + the leaf-detected treasure relic actually reach the DOM with the right stamp.
  // Vectors are the real design boxes (draw (15,985), discard (1826,985) — 16:37-10 combat recording; R9 adds the
  // exhaust pile at (1830,800), measured from the 16:40-09 recording).
  it("R8/R9: the three combat piles render 1.25× pinned to their own screen edge", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const nodes = [
      rawNode("draw", null, {
        nodeType: "MegaCrit.Sts2.Core.Nodes.Combat.NDrawPileButton",
        sceneFilePath: "res://scenes/combat/draw_pile.tscn",
        transform: xform(15, 985),
        localRect: box(80, 80)
      }),
      rawNode("drawIcon", "draw", { nodeType: "TextureRect", transform: xform(15, 985), localRect: box(80, 80) }),
      rawNode("discard", null, {
        nodeType: "MegaCrit.Sts2.Core.Nodes.Combat.NDiscardPileButton",
        sceneFilePath: "res://scenes/combat/discard_pile.tscn",
        transform: xform(1826, 985),
        localRect: box(80, 80)
      }),
      // R9: the mid-right exhaust pile — right-anchored but NOT in a corner, so it takes the middleRight EDGE pivot.
      rawNode("exhaust", null, {
        nodeType: "MegaCrit.Sts2.Core.Nodes.Combat.NExhaustPileButton",
        sceneFilePath: "res://scenes/combat/exhaust_pile.tscn",
        transform: xform(1830, 800),
        localRect: box(80, 80)
      })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.reconcile(state);

    const drawM = composedMatrixAll(el(stage, "draw")!, stage);
    expect(drawM[0]).toBeCloseTo(1.25, 6);
    expect(drawM[4]).toBeCloseTo(15, 6); // bottom-LEFT corner pinned: x unchanged
    expect(drawM[5]).toBeCloseTo(965, 6); // grows UP from 1065: top 985 → 965
    // The icon child rides the parent stamp (it gets no stamp of its own — only the scene ROOT carries the rule).
    expect(composedMatrixAll(el(stage, "drawIcon")!, stage)[0]).toBeCloseTo(1.25, 6);

    const discardM = composedMatrixAll(el(stage, "discard")!, stage);
    expect(discardM[0]).toBeCloseTo(1.25, 6);
    expect(discardM[4]).toBeCloseTo(1806, 6); // bottom-RIGHT corner pinned at 1906: left 1826 → 1806
    expect(discardM[5]).toBeCloseTo(965, 6);

    const exhaustM = composedMatrixAll(el(stage, "exhaust")!, stage);
    expect(exhaustM[0]).toBeCloseTo(1.25, 6);
    expect(exhaustM[4]).toBeCloseTo(1810, 6); // right EDGE pinned at 1910: left 1830 → 1810
    expect(exhaustM[5]).toBeCloseTo(790, 6); // splays symmetrically about y=840: top 800 → 790 (NOT bottom-pinned)
  });

  // R9 (WS-B): the deck dialog's "View Upgrades" toggle reaches the DOM with its (R10 WS-F) 1.35 bottom-left stamp. This is the
  // NAME pre-filter path end-to-end (VIEW_SCALE_CANDIDATE_NAMES → computeSceneInfo → the file-scoped entry): the node
  // has no sceneFilePath of its own, so a root-file-only pre-filter would silently never stamp it.
  it("R9/R10: the deck dialog's View Upgrades toggle renders 1.35× pinned to its bottom-left corner", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const nodes = [
      rawNode("DeckViewScreen", null, {
        nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.NDeckViewScreen",
        sceneFilePath: "res://scenes/screens/deck_view_screen.tscn",
        transform: xform(0, 0),
        localRect: box(1920, 1080)
      }),
      // (16,1012)-(212.5,1060) — measured from .sts2/bench/wscrisp-deckdialog.ndjson.
      rawNode("ViewUpgrades", "DeckViewScreen", {
        nodeType: "MarginContainer",
        transform: xform(16, 1012),
        localRect: box(196.5, 48)
      }),
      rawNode("Upgrades", "ViewUpgrades", {
        nodeType: "MegaCrit.Sts2.Core.Nodes.Ui.NUpgradePreviewTickbox",
        transform: xform(20.5, 1012),
        localRect: box(187.5, 48)
      }),
      // A sibling sort button on the same dialog must stay untouched.
      rawNode("ObtainedSorter", "DeckViewScreen", {
        nodeType: "MegaCrit.Sts2.Core.Nodes.Ui.NCardViewSortButton",
        sceneFilePath: "res://scenes/screens/deck_view_screen/deck_view_sort_button.tscn",
        transform: xform(396, 181),
        localRect: box(250, 42)
      })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.reconcile(state);

    // R10 WS-F: the deck factor is its own constant now and moved 1.25 → 1.35 (VIEW_SCALE_VIEW_UPGRADES_DECK).
    const m = composedMatrixAll(el(stage, "ViewUpgrades")!, stage);
    expect(m[0]).toBeCloseTo(1.35, 6);
    expect(m[4]).toBeCloseTo(16, 6); // bottom-LEFT corner pinned: x unchanged
    expect(m[5]).toBeCloseTo(995.2, 6); // grows UP from 1060: top 1012 → 1060 − 1.35·48
    // The interior tickbox rides the parent stamp — it gets no stamp of its own (that would double-scale the row).
    expect(composedMatrixAll(el(stage, "Upgrades")!, stage)[0]).toBeCloseTo(1.35, 6);
    // Non-regression: neither the screen root nor a sibling control is scaled.
    expect(composedMatrixAll(el(stage, "DeckViewScreen")!, stage)[0]).toBeCloseTo(1, 6);
    expect(composedMatrixAll(el(stage, "ObtainedSorter")!, stage)[0]).toBeCloseTo(1, 6);
  });

  it("WS6: the rewards PANEL renders 1.2× as one group and its rows ride that stamp (no per-row stamp)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // Geometry from .sts2/bench/audit-rewards.ndjson: RewardsScreen (root, rewards_screen.tscn) → Rewards (plain
    // child, 526×640 at (696,236)) → RewardContainerMask → RewardsContainer → NRewardButton rows (402×86).
    const nodes = [
      rawNode("RewardsScreen", null, { nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.NRewardsScreen", sceneFilePath: "res://scenes/screens/rewards_screen.tscn", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("Rewards", "RewardsScreen", { nodeType: "Control", transform: xform(696, 236), localRect: box(526, 640) }),
      rawNode("RewardContainerMask", "Rewards", { nodeType: "Control", transform: xform(758, 400), localRect: box(402, 400) }),
      rawNode("RewardsContainer", "RewardContainerMask", { nodeType: "VBoxContainer", transform: xform(758, 400), localRect: box(402, 400) }),
      rawNode("row0", "RewardsContainer", { nodeType: "MegaCrit.Sts2.Core.Nodes.Rewards.NRewardButton", sceneFilePath: "res://scenes/rewards/reward_button.tscn", transform: xform(758, 400), localRect: box(402, 86) }),
      rawNode("row1", "RewardsContainer", { nodeType: "MegaCrit.Sts2.Core.Nodes.Rewards.NRewardButton", sceneFilePath: "res://scenes/rewards/reward_button.tscn", transform: xform(758, 496), localRect: box(402, 86) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.reconcile(state);

    // The PANEL carries the single stamp: 1.2 about its own centre (959, 556) → top-left (643.4, 172).
    const panel = composedMatrixAll(el(stage, "Rewards")!, stage);
    expect(panel[0]).toBeCloseTo(1.2, 6);
    expect(panel[4]).toBeCloseTo(643.4, 5);
    expect(panel[5]).toBeCloseTo(172, 5);
    // Each row rides that one stamp — it is still rendered 1.2×, but it carries NO stamp of its own (which is what
    // used to let a row parked below the scroll mask be clamped back into view on its own).
    for (const row of ["row0", "row1"]) {
      expect(composedMatrixAll(el(stage, row)!, stage)[0]).toBeCloseTo(1.2, 6);
      expect(el(stage, row)!.style.transform.match(/matrix\(/g)?.length ?? 0).toBe(1);
    }
    // Non-regression: the screen root itself is not scaled.
    expect(composedMatrixAll(el(stage, "RewardsScreen")!, stage)[0]).toBeCloseTo(1, 6);
  });

  it("R8: the treasure relic HOLDER renders 1.25× from its bottom centre and its vote icons ride it", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const nodes = [
      rawNode("room", null, { nodeType: "NTreasureRoom", sceneFilePath: "res://scenes/rooms/treasure_room.tscn", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      // Holder box (800,600)-(1000,900): pivot = bottom centre (900,900) → grows up/out about it.
      // The holder is an INSTANCE of treasure_relic_holder.tscn, so it DOES carry a sceneFilePath. That file is
      // deliberately absent from VIEW_SCALE_ROOT_FILES — if it were there, the walk's table branch would shadow the
      // leaf branch below and the holder would never be stamped on web.
      rawNode("holder", "room", {
        nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.TreasureRoomRelic.NTreasureRoomRelicHolder",
        sceneFilePath: "res://scenes/ui/treasure_relic_holder.tscn",
        transform: xform(800, 600),
        localRect: box(200, 300)
      }),
      rawNode("relicArt", "holder", { nodeType: "TextureRect", transform: xform(800, 600), localRect: box(200, 300) }),
      // The co-op vote widget is a CHILD of the holder — it must ride the holder's stamp, never carry its own.
      rawNode("vote", "holder", {
        nodeType: "MegaCrit.Sts2.Core.Nodes.NMultiplayerVoteContainer",
        sceneFilePath: "res://scenes/ui/multiplayer_vote_container.tscn",
        transform: xform(850, 560),
        localRect: box(100, 40)
      }),
      // The SAME vote-container scene elsewhere on the screen must stay un-scaled (it is reused by the map + end turn).
      rawNode("otherVote", "room", {
        nodeType: "MegaCrit.Sts2.Core.Nodes.NMultiplayerVoteContainer",
        sceneFilePath: "res://scenes/ui/multiplayer_vote_container.tscn",
        transform: xform(100, 100),
        localRect: box(100, 40)
      })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.reconcile(state);

    const holderM = composedMatrixAll(el(stage, "holder")!, stage);
    expect(holderM[0]).toBeCloseTo(1.25, 6);
    // pivot (900,900): top-left (800,600) → (900 + 1.25·(−100), 900 + 1.25·(−300)) = (775, 525).
    expect(holderM[4]).toBeCloseTo(775, 6);
    expect(holderM[5]).toBeCloseTo(525, 6);
    // Children (art + vote icons) inherit the holder's stamp exactly once.
    expect(composedMatrixAll(el(stage, "relicArt")!, stage)[0]).toBeCloseTo(1.25, 6);
    expect(composedMatrixAll(el(stage, "vote")!, stage)[0]).toBeCloseTo(1.25, 6);
    // The unrelated vote container elsewhere is untouched.
    const otherM = composedMatrixAll(el(stage, "otherVote")!, stage);
    expect(otherM[0]).toBeCloseTo(1, 6);
    expect(otherM[4]).toBeCloseTo(100, 6);
    expect(otherM[5]).toBeCloseTo(100, 6);
  });

  it("places a grabbed card (reparented directly under Hand) on the field, matching the re-centered hand", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A grabbed card whose holder the game reparented straight under `Hand` (outside the center-anchored
    // `CardHolderContainer`). With the field, both the container (a pass-through group) and the grabbed card (a
    // positional claimer) land on the SAME map — the card's center is 960 (viewport center) → dx = ½Δ — so the
    // grabbed card no longer strands ~½Δ left of the re-centered hand. Its nested art rides it rigidly.
    const nodes = [
      rawNode("frame", null, { name: "frame", nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("hand", "frame", { name: "Hand", nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("container", "hand", { name: "CardHolderContainer", nodeType: "Control", transform: xform(960, 900), localRect: box(0, 0), anchorLeft: 0.5, anchorRight: 0.5 }),
      rawNode("inHand", "container", { name: "NHandCardHolder-CARD_SPITE", nodeType: "NCard", transform: xform(-80, -100), localRect: box(160, 220) }),
      // The grabbed card: same `NHandCardHolder*` convention, but its parent is `Hand` itself, not the container.
      rawNode("grabbed", "hand", { name: "NHandCardHolder-CARD_STRIKE_IRONCLAD", nodeType: "NCard", transform: xform(880, 600), localRect: box(160, 220) }),
      rawNode("grabbedArt", "grabbed", { name: "Frame", nodeType: "TextureRect", transform: xform(0, 0), localRect: box(160, 220) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    const shift = 0.5 * DELTA; // the field shift of a box centered on 960: 960·(F−1) = ½Δ
    // The zero-size container is a pass-through group; its own origin (960) field-shift is +½Δ.
    expect(composedMatrix(el(stage, "container")!, stage)[4]).toBeCloseTo(960 + shift, 3);
    // The grabbed card (center 960) claims +½Δ on the field, matching the hand — not stranded at 880.
    expect(composedMatrix(el(stage, "grabbed")!, stage)[4]).toBeCloseTo(880 + shift, 3);
    // Its nested art rides rigidly (no tearing between the holder and its card face).
    expect(composedMatrix(el(stage, "grabbedArt")!, stage)[4]).toBeCloseTo(880 + shift, 3);
    // The card keeps its native width/scale — it translates on the field, it doesn't widen.
    expect(composedMatrix(el(stage, "grabbed")!, stage)[0]).toBeCloseTo(1, 6);
    expect(el(stage, "grabbed")!.style.width).toBe("160px");
  });

  it("places a normal in-hand card (under CardHolderContainer) on the field via the pass-through container", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // The normal in-hand card (parent = the container). The zero-size container passes the budget through, so the
    // card takes its own positional claim (center 960 → ½Δ), exactly like the reparented grabbed one.
    const nodes = [
      rawNode("frame", null, { name: "frame", nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("hand", "frame", { name: "Hand", nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("container", "hand", { name: "CardHolderContainer", nodeType: "Control", transform: xform(960, 900), localRect: box(0, 0), anchorLeft: 0.5, anchorRight: 0.5 }),
      rawNode("inHand", "container", { name: "NHandCardHolder-CARD_SPITE", nodeType: "NCard", transform: xform(-80, -100), localRect: box(160, 220) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    expect(composedMatrix(el(stage, "inHand")!, stage)[4]).toBeCloseTo(880 + 0.5 * DELTA, 3);
  });

  it("stamps data-spread-w (gameWidth,renderedWidth) on widened boxes and clears it at factor 1", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    combatTree(state);
    renderer.setStretch(F);
    renderer.reconcile(state);
    // A full-anchored fill widens 1920 → 1920+Δ; the partial-anchored relic bar widens 1808 → 1808+Δ.
    expect(el(stage, "backstop")!.getAttribute("data-spread-w")).toBe(`1920,${1920 + DELTA}`);
    expect(el(stage, "relics")!.getAttribute("data-spread-w")).toBe(`1808,${1808 + DELTA}`);
    // A left-anchored pile (no widening) and a right-anchored button (shift, no widen) carry no width pair.
    expect(el(stage, "pile")!.getAttribute("data-spread-w")).toBeNull();
    expect(el(stage, "endTurn")!.getAttribute("data-spread-w")).toBeNull();
    // Reset to 16:9 (forceTextures makes it a structural re-walk, as MirrorView does) → the pair is removed.
    renderer.setStretch(1);
    renderer.reconcile(state, { forceTextures: true });
    expect(el(stage, "backstop")!.getAttribute("data-spread-w")).toBeNull();
    expect(el(stage, "relics")!.getAttribute("data-spread-w")).toBeNull();
  });

  it("clears the CACHED spread attributes (dx/paints/w/mode) when the stretch resets to factor 1 (forceTextures)", () => {
    // Stage-1 record-cached idempotent attr writes must still CLEAR when the value goes to absent — the risk of
    // caching is a stuck "already applied" that skips the removeAttribute. Exercise all four cache slots.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    combatTree(state);
    renderer.setStretch(F);
    renderer.reconcile(state);
    // At F: a positional claimer (a hand card) carries data-spread-dx + data-spread-mode=prop; a widened anchor box
    // (backstop) carries data-spread-w.
    const cardL = el(stage, "cardL")!;
    expect(cardL.getAttribute("data-spread-dx")).not.toBeNull();
    expect(cardL.getAttribute("data-spread-mode")).toBe("prop");
    expect(el(stage, "backstop")!.getAttribute("data-spread-w")).not.toBeNull();

    // Reset to 16:9 with a structural re-walk (as MirrorView does) → every cached spread attr clears to absent.
    renderer.setStretch(1);
    renderer.reconcile(state, { forceTextures: true });
    expect(cardL.getAttribute("data-spread-dx")).toBeNull();
    expect(cardL.getAttribute("data-spread-mode")).toBeNull();
    expect(el(stage, "backstop")!.getAttribute("data-spread-w")).toBeNull();
    // data-node-type is idempotently re-stamped (cache keeps it correct), never lost.
    expect(cardL.getAttribute("data-node-type")).toBe("NCard");
    // data-paints is spread-independent: a painting node keeps it, a non-painter never gets it. The cache preserves
    // the correct value across the flip (backstop is a boxless ColorRect with no fillColor → paints nothing).
    expect(el(stage, "backstop")!.getAttribute("data-paints")).toBeNull();
  });

  it("stamps data-paints only on nodes with visible own paint", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        rawNode("group", null, { nodeType: "Control", localRect: box(200, 200) }),
        rawNode("fill", "group", {
          nodeType: "ColorRect",
          fillColor: { r: 1, g: 0, b: 0, a: 1, html: "#ff0000" },
          localRect: box(80, 80)
        }),
        rawNode("empty", "group", { nodeType: "Control", localRect: box(10, 10) })
      ],
      ["group", "fill", "empty"]
    );
    renderer.reconcile(state);
    expect(el(stage, "fill")!.getAttribute("data-paints")).toBe("1"); // a filled ColorRect paints
    expect(el(stage, "empty")!.getAttribute("data-paints")).toBeNull(); // a boxless-ish Control paints nothing
    expect(el(stage, "group")!.getAttribute("data-paints")).toBeNull(); // a pure container paints nothing
  });

  it("withholds data-paints from card AURA layers (glow/flash) so they never anchor the pointer map", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A card's always-on cyan glow (NCardHighlight) and its draw/play Flash are HUGE mostly-transparent boxes that
    // overhang other frames' content (the creature powers behind the hand) — they must render but never decide the
    // game↔stage map; the card's real art (Frame) still anchors presses on the card itself.
    full(
      state,
      [
        rawNode("holder", null, { nodeType: "NHandCardHolder", transform: xform(960, 900), localRect: box(0, 0) }),
        rawNode("frame", "holder", { nodeType: "TextureRect", transform: xform(-80, -150), localRect: box(160, 220), texture: { resourcePath: "res://images/cards/frame.png" } }),
        rawNode("glow", "holder", { nodeType: "NCardHighlight", transform: xform(-300, -300), localRect: box(600, 760), texture: { resourcePath: "res://images/cards/glow.png" } }),
        rawNode("flash", "holder", { nodeType: "TextureRect", name: "Flash", transform: xform(-150, -250), localRect: box(300, 560), texture: { resourcePath: "res://images/cards/flash.png" } })
      ],
      ["holder", "frame", "glow", "flash"]
    );
    renderer.reconcile(state);
    expect(el(stage, "frame")!.getAttribute("data-paints")).toBe("1"); // real card art anchors
    expect(el(stage, "glow")!.getAttribute("data-paints")).toBeNull(); // aura renders but never anchors
    expect(el(stage, "flash")!.getAttribute("data-paints")).toBeNull();
    // Still rendered (excluded from ANCHORING only): both carry their texture like any painted node.
    expect(el(stage, "glow")).not.toBeNull();
    expect(el(stage, "flash")).not.toBeNull();
  });

  it("spreads two creatures under a zero-size EnemyContainer per-position, each subtree rigid", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // The real combat chain: a full-anchored frame → a 0.5/0.5-anchored zero-size EnemyContainer (a PASS-THROUGH
    // positioner) → two boxed Creature positional claimers at different X, the left one carrying a spine child.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("enemyContainer", "frame", { nodeType: "Control", transform: xform(960, 400), localRect: box(0, 0), anchorLeft: 0.5, anchorRight: 0.5 }),
      rawNode("creatureL", "enemyContainer", { nodeType: "NCreature", transform: xform(-360, 0), localRect: box(200, 300) }),
      rawNode("spineL", "creatureL", { nodeType: "Sprite2D", transform: xform(50, 100), localRect: box(100, 200) }),
      rawNode("creatureR", "enemyContainer", { nodeType: "NCreature", transform: xform(240, 0), localRect: box(200, 300) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    // Each creature takes its OWN center claim: renderedOrigin = origin + center·(F−1). Left (center 700) shifts
    // LESS than right (center 1300) — the pair spreads apart as the screen widens.
    const shiftL = 700 * (F - 1); // 218.75
    const shiftR = 1300 * (F - 1); // 406.25
    expect(composedMatrix(el(stage, "creatureL")!, stage)[4]).toBeCloseTo(600 + shiftL, 3);
    expect(composedMatrix(el(stage, "creatureR")!, stage)[4]).toBeCloseTo(1200 + shiftR, 3);
    expect(shiftL).toBeLessThan(shiftR);
    // The subtree under each creature rides rigidly: spineL takes creatureL's shift exactly (no per-child re-spread).
    expect(composedMatrix(el(stage, "spineL")!, stage)[4]).toBeCloseTo(650 + shiftL, 3);
    expect(el(stage, "creatureL")!.getAttribute("data-spread-mode")).toBe("prop");
  });

  it("spreads hand cards under a zero-size CardHolderContainer without skewing each card's internal art", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // Hand/CardHolderContainer (zero-size pass-through) → two NHandCardHolder positional claimers; the left holds a
    // frame + art the game authored at the holder's own x. The internal art must ride the holder with NO relative skew.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("cardHolders", "frame", { nodeType: "Control", transform: xform(960, 900), localRect: box(0, 0), anchorLeft: 0.5, anchorRight: 0.5 }),
      rawNode("holderL", "cardHolders", { nodeType: "NCard", transform: xform(-260, -100), localRect: box(160, 220) }),
      rawNode("holderLart", "holderL", { nodeType: "TextureRect", transform: xform(0, 0), localRect: box(160, 220) }),
      rawNode("holderR", "cardHolders", { nodeType: "NCard", transform: xform(140, -100), localRect: box(160, 220) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    const shiftL = (700 + 80) * (F - 1); // holderL center 780 → 243.75
    const shiftR = (1100 + 80) * (F - 1); // holderR center 1180 → 368.75
    expect(composedMatrix(el(stage, "holderL")!, stage)[4]).toBeCloseTo(700 + shiftL, 3);
    expect(composedMatrix(el(stage, "holderR")!, stage)[4]).toBeCloseTo(1100 + shiftR, 3);
    expect(shiftL).toBeLessThan(shiftR); // the cards spread apart
    // The internal art rides the holder with the SAME shift — no relative skew between the card frame and its face.
    expect(composedMatrix(el(stage, "holderLart")!, stage)[4]).toBeCloseTo(
      composedMatrix(el(stage, "holderL")!, stage)[4],
      6
    );
  });

  it("places each targeting-arrow segment on the field per-position (base near card, head near target)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // boxless NTargetManager → boxless NTargetingArrow (both PASS-THROUGH) → boxed Sprite2D segments at different X.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      { id: "targetManager", parentId: "frame", name: "targetManager", nodeType: "NTargetManager", transform: xform(0, 0), visible: true },
      { id: "targetingArrow", parentId: "targetManager", name: "targetingArrow", nodeType: "NTargetingArrow", transform: xform(0, 0), visible: true },
      rawNode("segBase", "targetingArrow", { nodeType: "Sprite2D", transform: xform(600, 700), localRect: box(24, 24) }),
      rawNode("segHead", "targetingArrow", { nodeType: "Sprite2D", transform: xform(1400, 300), localRect: box(24, 24) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    const shiftBase = (600 + 12) * (F - 1); // 191.25
    const shiftHead = (1400 + 12) * (F - 1); // 441.25
    expect(composedMatrix(el(stage, "segBase")!, stage)[4]).toBeCloseTo(600 + shiftBase, 3);
    expect(composedMatrix(el(stage, "segHead")!, stage)[4]).toBeCloseTo(1400 + shiftHead, 3);
    expect(shiftBase).toBeLessThan(shiftHead); // segments land under the field, not on one rigid arrow-wide shift
  });

  it("stamps data-spread-mode=prop on positional claimers / pass-through groups, not on anchor-algebra nodes", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    combatTree(state);
    renderer.setStretch(F);
    renderer.reconcile(state);
    // Positional content (a card) and a pass-through group (the zero-size hand) → prop.
    expect(el(stage, "cardL")!.getAttribute("data-spread-mode")).toBe("prop");
    expect(el(stage, "hand")!.getAttribute("data-spread-mode")).toBe("prop");
    // Anchor-algebra HUD (full-span fill, right-hug button, left pile, partial relic bar) → NOT prop.
    expect(el(stage, "backstop")!.getAttribute("data-spread-mode")).toBeNull();
    expect(el(stage, "endTurn")!.getAttribute("data-spread-mode")).toBeNull();
    expect(el(stage, "pile")!.getAttribute("data-spread-mode")).toBeNull();
    expect(el(stage, "relics")!.getAttribute("data-spread-mode")).toBeNull();
  });

  it("exposes visible mouse-visible (Stop/Pass) Control game rects + spreadDx via the interactive-rects provider", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      // A right-anchored Stop panel (shift +Δ) → included, with its GAME rect (unshifted) + spreadDx.
      rawNode("panel", "frame", { nodeType: "Control", transform: xform(1500, 100), localRect: box(300, 200), anchorLeft: 1, anchorRight: 1, mouseFilter: 0 }),
      // A PASS control is included too: Godot fires hover for Stop AND Pass, and the game's tooltip-only elements
      // (relics, the Gold/HP counters) are Pass — they must offend the near-miss pass like any button.
      rawNode("passThru", "frame", { nodeType: "Control", transform: xform(10, 10), localRect: box(50, 50), anchorLeft: 0, anchorRight: 0, mouseFilter: 1 }),
      // Excluded: mouse-Ignore, hidden, and filterless (non-Control).
      rawNode("ignored", "frame", { nodeType: "Control", transform: xform(30, 30), localRect: box(50, 50), anchorLeft: 0, anchorRight: 0, mouseFilter: 2 }),
      rawNode("hiddenStop", "frame", { nodeType: "Control", transform: xform(20, 20), localRect: box(50, 50), mouseFilter: 0, visible: false })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    const rects = renderer.interactiveRects();
    const ids = rects.map((r) => r.id);
    expect(ids).toContain("panel");
    expect(ids).toContain("passThru"); // Pass = hover-reactive (tooltip-only elements)
    expect(ids).not.toContain("frame"); // mouseFilter null (not a Control filter)
    expect(ids).not.toContain("ignored"); // mouse-Ignore is invisible to the mouse
    expect(ids).not.toContain("hiddenStop"); // not visible
    const panel = rects.find((r) => r.id === "panel")!;
    expect(panel.transform[4]).toBeCloseTo(1500, 6); // the TRUE (unshifted) game-space origin
    expect(panel.localRect.width).toBe(300);
    expect(panel.spreadDx).toBeCloseTo(DELTA, 3); // rendered rect = game rect shifted by +Δ (right-anchored)
  });

  it("lifts an interactive-rect's transform through the parent chain", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    // Mirror the remote-cursor LOCAL-space test: the panel's raw transform (300,50) is PARENT-RELATIVE; the provider
    // must lift it through its offset parent bar (1200,50) → global origin 1500 (like liftEndpointToGlobal).
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("bar", "frame", { nodeType: "Control", transform: xform(1200, 50), localRect: box(720, 1030), anchorLeft: 0, anchorRight: 1 }),
      rawNode("panel", "bar", { nodeType: "Control", transform: xform(300, 50), localRect: box(300, 200), anchorLeft: 1, anchorRight: 1, mouseFilter: 0 })
    ];
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
    renderer.setStretch(F);
    renderer.reconcile(state);
    const panel = renderer.interactiveRects().find((r) => r.id === "panel")!;
    expect(panel.transform[4]).toBeCloseTo(1500, 6); // lifted: 1200 (bar) + 300 (panel) = 1500 game-space
    expect(panel.transform[5]).toBeCloseTo(100, 6); // 50 + 50
  });

  it("endTurnBoxAt returns the end-turn scene's UNION game box for an inside point, null outside / wrong scene (R4 change 2)", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    const nodes = [
      // The end-turn INSTANCED-SCENE root: a boxy container that is NOT itself mouse-visible (no mouseFilter) —
      // only its descendants emit interactive rects, so the box must be the UNION over what the scene owns.
      rawNode("et", null, {
        nodeType: "Control",
        transform: xform(1600, 980),
        localRect: box(280, 80),
        sceneFilePath: "res://scenes/combat/end_turn_button.tscn"
      }),
      // Visuals (Stop) covers the top band; Label (Pass) extends the union to the button's bottom edge.
      rawNode("visuals", "et", { nodeType: "Control", transform: xform(0, 0), localRect: box(280, 60), mouseFilter: 0 }),
      rawNode("label", "et", { nodeType: "Control", transform: xform(20, 60), localRect: box(240, 20), mouseFilter: 1 }),
      // An eligible Stop control owned by a DIFFERENT scene never matches (the scene-file suffix gate).
      rawNode("pile", null, {
        nodeType: "Control",
        transform: xform(100, 980),
        localRect: box(120, 80),
        mouseFilter: 0,
        sceneFilePath: "res://scenes/combat/draw_pile.tscn"
      })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.reconcile(state);
    // Inside the LABEL band only → still the full union (1600..1880 × 980..1060), never a Label-only box.
    expect(renderer.endTurnBoxAt(1700, 1050)).toEqual({ minX: 1600, minY: 980, maxX: 1880, maxY: 1060 });
    expect(renderer.endTurnBoxAt(1740, 1000)).toEqual({ minX: 1600, minY: 980, maxX: 1880, maxY: 1060 });
    expect(renderer.endTurnBoxAt(1740, 900)).toBeNull(); // above the button → miss
    expect(renderer.endTurnBoxAt(150, 1000)).toBeNull(); // inside the draw pile (wrong scene) → miss
  });

  it("anchors a remote cursor to the Stop control under its game point (never itself), and centers it in dead space", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      // A right-anchored Stop panel (hugs the right edge → shift +Δ = 480).
      rawNode("panel", "frame", { nodeType: "Control", transform: xform(1500, 100), localRect: box(300, 200), anchorLeft: 1, anchorRight: 1, mouseFilter: 0 }),
      // The teammate's cursor, true game point (1600,150) sits inside the panel's game rect [1500..1800]x[100..300].
      // It is itself a Stop control with a box over its own point, so the ONLY way it lands on the panel's shift
      // (not 0) is the self/echo/floater exclusion working.
      rawNode("cursor", "frame", { nodeType: "NRemoteMouseCursor", transform: xform(1600, 150), localRect: box(24, 24), mouseFilter: 0 })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    expect(composedMatrix(el(stage, "cursor")!, stage)[4]).toBeCloseTo(1600 + DELTA, 3);
    // Move the cursor into empty board space (no Stop control under it) → a POSITIONAL claim at its own game point
    // (the same field unclaimed world content rides): dx = 400·(F−1) = 125.
    volatile(state, [rawNode("cursor", "frame", { nodeType: "NRemoteMouseCursor", transform: xform(400, 800), localRect: box(24, 24), mouseFilter: 0 })]);
    renderer.reconcile(state);
    expect(composedMatrix(el(stage, "cursor")!, stage)[4]).toBeCloseTo(400 + 400 * (F - 1), 3);
  });

  it("anchors a remote cursor through the parent lift", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // In "local" space every stored transform is PARENT-RELATIVE: the Stop panel's raw transform (300,50) only
    // covers the cursor's game point (1600,150) once lifted through its offset parent bar (1200,50) → global
    // (1500,100)+300x200. Anchoring must therefore compose candidates via cParentGlobal, not use the raw matrix.
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("bar", "frame", { nodeType: "Control", transform: xform(1200, 50), localRect: box(720, 1030), anchorLeft: 0, anchorRight: 1 }),
      rawNode("panel", "bar", { nodeType: "Control", transform: xform(300, 50), localRect: box(300, 200), anchorLeft: 1, anchorRight: 1, mouseFilter: 0 }),
      rawNode("cursor", "frame", { nodeType: "NRemoteMouseCursor", transform: xform(1600, 150), localRect: box(24, 24), mouseFilter: 0 })
    ];
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
    renderer.setStretch(F);
    renderer.reconcile(state);
    // The right-anchored panel shifts by its parent's full widening (+Δ); the cursor over it rides the same shift.
    expect(composedMatrix(el(stage, "cursor")!, stage)[4]).toBeCloseTo(1600 + DELTA, 3);
  });

  it("gives a remote follower a short transform transition (smoothing) but not a normal node", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("remote", "frame", { nodeType: "NRemoteMouseCursor", transform: xform(500, 500), localRect: box(24, 24), mouseFilter: 0 }),
      rawNode("arrow", "frame", { nodeType: "NTargetingArrow", transform: xform(500, 500), localRect: box(24, 24) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F);
    renderer.reconcile(state);
    expect(el(stage, "remote")!.style.transition).toBe("transform 80ms linear");
    expect(el(stage, "arrow")!.style.transition).toBe("");
  });

  // ---- BoxContainer re-layout (card-reward "Skip" fix) --------------------------------------------------------
  // The real card-reward-picker chain (cardpick-live.ndjson): a full-anchored frame → a full-width (0/1)
  // HBoxContainer `RewardAlternatives` (carrying the containerLayout hint) → a 0/0-anchored boxed Skip button whose
  // 276-wide box sits at global x 822, i.e. CENTERED in the 1920 frame (822 = (1920−276)/2). A real Godot
  // BoxContainer IGNORES the child's anchors and re-lays out its packed row when its box widens — the fix.
  function rewardTree(state: MirrorState, containerLayout: string | null): void {
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("rewards", "frame", { nodeType: "HBoxContainer", transform: xform(0, 884), localRect: box(1920, 73), anchorLeft: 0, anchorRight: 1, mouseFilter: 2, containerLayout }),
      rawNode("skip", "rewards", { nodeType: "NCardRewardAlternativeButton", transform: xform(822, 884), localRect: box(276, 73), anchorLeft: 0, anchorRight: 0 })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
  }

  const F125 = 1.25; // the task's factor: Δ = 480, so a center HBox moves the Skip center 960 → 1200
  const D125 = (F125 - 1) * 1920; // 480

  it("re-centers a boxed 0/0 child of a CENTER-aligned HBoxContainer on the widened frame (Skip 960 → 1200)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    rewardTree(state, "hbox-center");
    renderer.setStretch(F125);
    renderer.reconcile(state);
    // The HBox itself widens to the stage width WITHOUT shifting (0/1 anchor algebra)...
    expect(composedMatrix(el(stage, "rewards")!, stage)[4]).toBeCloseTo(0, 4);
    expect(el(stage, "rewards")!.style.width).toBe(`${1920 + D125}px`);
    // ...and the boxed 0/0 Skip child rides ½·Δ (center re-layout), NOT the anchor pin (which strands it at 960).
    expect(Number(el(stage, "skip")!.getAttribute("data-spread-dx"))).toBeCloseTo(0.5 * D125, 3);
    expect(centerX(el(stage, "skip")!, stage, 276)).toBeCloseTo(1200, 3);
    expect(el(stage, "skip")!.getAttribute("data-spread-w")).toBeNull(); // rides, never widens
    expect(el(stage, "skip")!.getAttribute("data-spread-mode")).toBeNull(); // anchor flavor (fixed translation)
  });

  it("packs a begin-aligned HBoxContainer to the left and an end-aligned one to the right", () => {
    const begin = harness();
    const beginState = createMirrorState();
    rewardTree(beginState, "hbox-begin");
    begin.renderer.setStretch(F125);
    begin.renderer.reconcile(beginState);
    expect(centerX(el(begin.stage, "skip")!, begin.stage, 276)).toBeCloseTo(960, 3); // begin: no shift

    const end = harness();
    const endState = createMirrorState();
    rewardTree(endState, "hbox-end");
    end.renderer.setStretch(F125);
    end.renderer.reconcile(endState);
    expect(centerX(el(end.stage, "skip")!, end.stage, 276)).toBeCloseTo(960 + D125, 3); // end: rides the full Δ
  });

  it("rides a VBoxContainer child on the box's own shift (no horizontal redistribution)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    rewardTree(state, "vbox-center");
    renderer.setStretch(F125);
    renderer.reconcile(state);
    // A vertical box's alignment is its VERTICAL packing — nothing horizontal; the box didn't shift, so the child
    // stays at 960. The intercept still fires (the child does NOT run its own Godot-ignored 0/0 anchor algebra).
    expect(centerX(el(stage, "skip")!, stage, 276)).toBeCloseTo(960, 3);
  });

  it("re-centers a FULL-WIDTH vbox child as background art (map parchment tile, ½·Δ)", () => {
    // The real map chain (probe-current.ndjson): TheMap (0/1) → VBoxContainer MapBg (1920×3240 strip,
    // "vbox-begin") → 0/0 TextureRect tiles spanning the container's FULL pre-widen width. Godot lays a vbox
    // child across the box's whole width (cross-axis fill), so a full-width tile is background ART: it
    // re-CENTERS (the fullCanvas convention) instead of stranding left — consistent with Drawings/MapLegend.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 1 }),
      rawNode("mapbg", "frame", { nodeType: "NMapBg", transform: xform(0, -1415), localRect: box(1920, 3240), anchorLeft: 0, anchorRight: 1, mouseFilter: 2, containerLayout: "vbox-begin" }),
      rawNode("maptop", "mapbg", { nodeType: "TextureRect", transform: xform(0, -1415), localRect: box(1920, 1080), anchorLeft: 0, anchorRight: 0, mouseFilter: 2 })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.setStretch(F125);
    renderer.reconcile(state);
    // The strip itself widens without shifting (0/1 anchor algebra)...
    expect(composedMatrix(el(stage, "mapbg")!, stage)[4]).toBeCloseTo(0, 4);
    expect(el(stage, "mapbg")!.style.width).toBe(`${1920 + D125}px`);
    // ...and the full-width tile re-centers by ½·Δ (left margin = right margin), riding without widening.
    expect(Number(el(stage, "maptop")!.getAttribute("data-spread-dx"))).toBeCloseTo(0.5 * D125, 3);
    expect(el(stage, "maptop")!.getAttribute("data-spread-w")).toBeNull();
    expect(el(stage, "maptop")!.getAttribute("data-spread-mode")).toBeNull();
  });

  it("keeps the OLD anchor behavior when the containerLayout hint is absent (old recordings unchanged)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    rewardTree(state, null);
    renderer.setStretch(F125);
    renderer.reconcile(state);
    // No hint → the 0/0 Skip runs the anchor algebra and is pinned LEFT (center stranded at 960, the bug).
    expect(centerX(el(stage, "skip")!, stage, 276)).toBeCloseTo(960, 3);
    expect(Number(el(stage, "skip")!.getAttribute("data-spread-dx")) || 0).toBeCloseTo(0, 3);
  });
});

// --- setHeldCard: the touch-drag cosmetic card lift (never affects the coordinate sent to the game) ----------

describe("setHeldCard (touch card cosmetic lift)", () => {
  // A card at game-space box [540..700, 800..1020] plus a non-card sibling at [200..250, 200..250], both under a
  // full-canvas frame. No setStretch call — factor stays 1 (16:9, no spread), so gNode === node.transform verbatim.
  function sceneWithCard(state: MirrorState): void {
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080) }),
      rawNode("card", "frame", { nodeType: "NCard", transform: xform(540, 800), localRect: box(160, 220) }),
      rawNode("other", "frame", { nodeType: "TextureRect", transform: xform(200, 200), localRect: box(50, 50) })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
  }

  // Re-upserts a node as a FRESH object at the SAME position (id-preserving), so `visit` treats it as changed
  // (`record.lastNode !== node`) and doesn't skip-clean it. A real drag streams a fresh node every frame the game
  // moves the card; calling setHeldCard alone never forces a re-render on its own.
  function reRender(state: MirrorState, id: string, nodeType: string, tx: number, ty: number, w: number, h: number): void {
    volatile(state, [rawNode(id, "frame", { nodeType, transform: xform(tx, ty), localRect: box(w, h) })]);
  }

  // The tooltip lift is applied one frame late (a debounced rAF) so it can transition; stub rAF so the test can flush
  // that frame deterministically (the card lift itself is written synchronously, so the drag tests don't need this).
  let rafCb: FrameRequestCallback | null = null;
  beforeEach(() => {
    rafCb = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      rafCb = null;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  function flushRaf(): void {
    const cb = rafCb;
    rafCb = null;
    cb?.(0);
  }

  // The game's play-zone line for a card grabbed at design-Y `grabY` (NMouseCardPlay: base 0.75·1080 = 810, tightened
  // toward the grab point). A finger with Y strictly ABOVE this (smaller Y) is "in the play zone" (being played).
  // Cards are grabbed low in the hand (~900, below the line ⇒ threshold pins to base 810); the ABOVE/BELOW constants
  // must be read against THAT threshold, so a test MUST grab at HAND_GRAB_Y first before moving above/below.
  const HAND_GRAB_Y = 900; // where a hand card is picked up (below the line ⇒ threshold = base 810)
  const PLAY_ZONE_ABOVE_Y = 300; // well above the line (300 < 810)
  const PLAY_ZONE_BELOW_Y = 1040; // back down in the hand, below the line

  it("lifts a dragged card straight off the pickup and keeps it lifted across re-renders", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCard(state);
    renderer.reconcile(state);
    expect(el(stage, "card")!.style.translate || "").toBe(""); // untouched before anything is held

    // Grab the card in the hand (below the play-zone line, not yet "in play"): it lifts IMMEDIATELY off the pickup,
    // applied straight from setHeldCard (no wait for a re-render).
    renderer.setHeldCard("card", 620, 900);
    const lifted = el(stage, "card")!.style.translate;
    const m = /^0px (-?[\d.]+)px$/.exec(lifted);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(0);

    // And it stays lifted when the game streams the dragged card's next frame (a re-render re-asserts the lift).
    reRender(state, "card", "NCard", 540, 800, 160, 220);
    renderer.reconcile(state);
    expect(el(stage, "card")!.style.translate).toBe(lifted);

    // A normal reconcile (still held, finger unmoved) must not clear the lift — applyStyleMap never manages the
    // `translate` property, only this gate does.
    reRender(state, "card", "NCard", 540, 800, 160, 220);
    renderer.reconcile(state);
    expect(el(stage, "card")!.style.translate).toBe(lifted);

    // Release clears it (no reconcile needed).
    renderer.setHeldCard(null, 0, 0);
    expect(el(stage, "card")!.style.translate).toBe("0px");
  });

  it("never lifts a non-NCard node even when it's the held id", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCard(state);
    renderer.reconcile(state);

    renderer.setHeldCard("other", 220, 220); // inside "other"'s box (200..250, 200..250)
    reRender(state, "other", "TextureRect", 200, 200, 50, 50);
    renderer.reconcile(state);
    expect(el(stage, "other")!.style.translate || "").toBe("");
  });

  it("clears the PREVIOUS held card's lift immediately when the held id changes, with no reconcile needed", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCard(state);
    renderer.reconcile(state);

    renderer.setHeldCard("card", 620, 900);
    reRender(state, "card", "NCard", 540, 800, 160, 220);
    renderer.reconcile(state);
    expect(el(stage, "card")!.style.translate).not.toBe("0px");

    renderer.setHeldCard(null, 0, 0); // release — no reconcile call before the assertion
    expect(el(stage, "card")!.style.translate).toBe("0px");
  });

  it("peek raises the card immediately even when the finger is well below its box (issue 1)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCard(state);
    renderer.reconcile(state);

    // A PEEK raises unconditionally (regardless of the finger's play-zone position) — and immediately, with NO
    // re-render (the finger is still). A still, focused card sits well below the play-zone line.
    renderer.setHeldCard("card", 620, 1400, "peek"); // finger far below the line
    const lifted = el(stage, "card")!.style.translate;
    expect(/^0px -[\d.]+px$/.test(lifted)).toBe(true);
    expect(lifted).not.toBe("0px");
  });

  it("uses a smaller lift for peek than for drag (the game already raises a focused card)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCard(state);
    renderer.reconcile(state);

    // Drag engage: the full drag lift.
    renderer.setHeldCard("card", 620, 900, "drag");
    reRender(state, "card", "NCard", 540, 800, 160, 220);
    renderer.reconcile(state);
    const dragLift = el(stage, "card")!.style.translate;

    // Switch the SAME card to peek: the (smaller) peek lift, applied immediately from setHeldCard.
    renderer.setHeldCard("card", 620, 900, "peek");
    const peekLift = el(stage, "card")!.style.translate;

    const dragPx = Number(/-([\d.]+)px/.exec(dragLift)![1]);
    const peekPx = Number(/-([\d.]+)px/.exec(peekLift)![1]);
    expect(dragPx).toBe(300); // ?cardLift default
    expect(peekPx).toBe(120); // ?cardPeekLift default
    expect(peekPx).toBeLessThan(dragPx);
  });

  it("DROPS a dragged card back to rest when it's carried below the play-zone line after entering it (phase-5 issue 1)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCard(state);
    renderer.reconcile(state);

    // Grab in the hand → lifted off the pickup.
    renderer.setHeldCard("card", 620, 900, "drag");
    expect(el(stage, "card")!.style.translate).not.toBe("0px");

    // Drag UP into the play zone → still lifted (and now latched as "entered the play zone").
    renderer.setHeldCard("card", 620, PLAY_ZONE_ABOVE_Y, "drag");
    const lifted = el(stage, "card")!.style.translate;
    expect(lifted).not.toBe("0px");

    // Drag BACK DOWN toward the hand (below the line): the game returns the card to rest, so the mirror DROPS the lift
    // immediately — with NO release and NO card re-render (a card that isn't being played is never lifted).
    renderer.setHeldCard("card", 620, PLAY_ZONE_BELOW_Y, "drag");
    expect(el(stage, "card")!.style.translate).toBe("0px");

    // Drag UP again → it re-lifts (the card is being played once more).
    renderer.setHeldCard("card", 620, PLAY_ZONE_ABOVE_Y, "drag");
    expect(el(stage, "card")!.style.translate).toBe(lifted);
  });

  it("keeps a dragged card lifted while it stays above the play-zone line, even on a far-horizontal fast drag (no bob)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCard(state);
    renderer.reconcile(state);

    // Grab in the hand, then drag UP across the play-zone line (latching heldEnteredPlayZone).
    renderer.setHeldCard("card", 620, HAND_GRAB_Y, "drag");
    renderer.setHeldCard("card", 620, PLAY_ZONE_ABOVE_Y, "drag");
    const lifted = el(stage, "card")!.style.translate;
    expect(lifted).not.toBe("0px");

    // Fast horizontal drag: the finger races FAR from the (lagging) card but stays ABOVE the line — the gate is a
    // horizontal Y line, not the card box, so the lift never toggles (the old distance heuristic's "bob" is gone).
    renderer.setHeldCard("card", 1800, PLAY_ZONE_ABOVE_Y, "drag");
    expect(el(stage, "card")!.style.translate).toBe(lifted);
    reRender(state, "card", "NCard", 540, 800, 160, 220);
    renderer.reconcile(state);
    expect(el(stage, "card")!.style.translate).toBe(lifted);
  });

  // A scene with the card + the (persistent) NTargetManager → NTargetingArrow subtree; the arrow's own `visible`
  // flag models targeting on/off (it's hidden until an attack card is aimed).
  function sceneWithCardAndArrow(state: MirrorState, arrowVisible: boolean): void {
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080) }),
      rawNode("card", "frame", { nodeType: "NCard", transform: xform(540, 800), localRect: box(160, 220) }),
      rawNode("targetMgr", "frame", { nodeType: "NTargetManager", transform: xform(0, 0), localRect: box(1, 1), visible: true }),
      rawNode("arrow", "targetMgr", { nodeType: "NTargetingArrow", transform: xform(0, 0), localRect: box(1, 1), visible: arrowVisible })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
  }

  it("drops the drag lift when a targeting arrow appears, so the card sits static with the arrow tip at the finger (issue 2)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCardAndArrow(state, false); // arrow hidden — not targeting
    renderer.reconcile(state);

    // Grab an attack card in the hand, then drag it up into the play zone → lifted.
    renderer.setHeldCard("card", 620, HAND_GRAB_Y, "drag");
    renderer.setHeldCard("card", 620, PLAY_ZONE_ABOVE_Y, "drag");
    reRender(state, "card", "NCard", 540, 800, 160, 220);
    renderer.reconcile(state);
    expect(el(stage, "card")!.style.translate).not.toBe("0px");

    // Targeting begins: the NTargetingArrow becomes visible → the lift drops on the reconcile that shows it, even
    // though the card node itself didn't move (applyHeldLift fires from the arrow's visibility flip).
    volatile(state, [rawNode("arrow", "targetMgr", { nodeType: "NTargetingArrow", transform: xform(0, 0), localRect: box(1, 1), visible: true })]);
    renderer.reconcile(state);
    expect(el(stage, "card")!.style.translate).toBe("0px");
  });

  it("a peek lift is NOT dropped by targeting (peek stays raised regardless)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCardAndArrow(state, true); // arrow visible — but a peek ignores targeting
    renderer.reconcile(state);

    renderer.setHeldCard("card", 620, 900, "peek");
    expect(el(stage, "card")!.style.translate).not.toBe("0px"); // peek lifts unconditionally
  });

  it("TRANSITIONS a card tooltip (NHoverTipSet) up with the card: at rest first, lifted on the next frame (issues 3 + phase-5)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCard(state);
    renderer.reconcile(state);

    // Peek the card (lifts it), THEN the game spawns the tooltip (as it does on focus). It appears as a new node, so
    // it's visited and picked up. A distractor settings tooltip (a different `N*HoverTip` type) must be ignored.
    renderer.setHeldCard("card", 620, 900, "peek");
    const cardLift = el(stage, "card")!.style.translate;
    expect(cardLift).not.toBe("0px");

    const withTips = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080) }),
      rawNode("card", "frame", { nodeType: "NCard", transform: xform(540, 800), localRect: box(160, 220) }),
      rawNode("tip", "frame", { nodeType: "NHoverTipSet", transform: xform(720, 800), localRect: box(300, 200) }),
      rawNode("settingsTip", "frame", { nodeType: "NMsaaHoverTip", transform: xform(0, 0), localRect: box(80, 40) })
    ];
    full(state, withTips, withTips.map((n) => n.id as string));
    renderer.reconcile(state);

    // The freshly-created tooltip paints at REST this frame (its lift is deferred), and carries the same 140ms
    // `translate` transition as the card, so it SLIDES up rather than popping to the destination.
    const tip = el(stage, "tip")!;
    expect(tip.style.translate).toBe("0px");
    expect(tip.classList.contains("mirror-card-liftable")).toBe(true);
    expect(el(stage, "settingsTip")!.style.translate || "").toBe(""); // a non-card tooltip is never touched

    // Next frame: the deferred rAF raises it to the card's lift (transitioning from the rest it just painted).
    flushRaf();
    expect(tip.style.translate).toBe(cardLift);

    // Release → the tooltip settles back down (immediately, cleared on the id-change).
    renderer.setHeldCard(null, 0, 0);
    expect(tip.style.translate).toBe("0px");
  });

  // R10-PERF4 WS-2 — idempotent lift writes. `setHeldCard` runs on EVERY finger move (~60/s) and `visit` re-asserts
  // the lift on every re-visit of the held card, so the lift path must cost nothing when the decision hasn't moved.
  it("arms NO lift frame while nothing has to move (no tooltip on screen)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCard(state);
    renderer.reconcile(state);

    renderer.setHeldCard("card", 620, HAND_GRAB_Y, "drag");
    expect(el(stage, "card")!.style.translate).not.toBe("0px"); // the card itself still lifts synchronously
    expect(rafCb).toBeNull(); // ...but with no tooltip tracked there is nothing to defer

    // A stream of drag-motion updates at the same lift state stays silent too.
    renderer.setHeldCard("card", 621, HAND_GRAB_Y, "drag");
    renderer.setHeldCard("card", 622, HAND_GRAB_Y, "drag");
    expect(rafCb).toBeNull();
  });

  it("arms no further lift frame once the tooltip already carries the current lift", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    sceneWithCard(state);
    renderer.reconcile(state);
    renderer.setHeldCard("card", 620, 900, "peek");

    const withTip = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080) }),
      rawNode("card", "frame", { nodeType: "NCard", transform: xform(540, 800), localRect: box(160, 220) }),
      rawNode("tip", "frame", { nodeType: "NHoverTipSet", transform: xform(720, 800), localRect: box(300, 200) })
    ];
    full(state, withTip, withTip.map((n) => n.id as string));
    renderer.reconcile(state);
    flushRaf(); // the deferred raise lands
    const tip = el(stage, "tip")!;
    expect(tip.style.translate).toBe(el(stage, "card")!.style.translate);

    // Further finger reports at the same peek lift: the tooltip is already where it belongs, so no frame is armed.
    renderer.setHeldCard("card", 621, 901, "peek");
    expect(rafCb).toBeNull();
    // ...and neither does a re-render of the held card (visit re-asserts the lift every time it is visited).
    reRender(state, "card", "NCard", 540, 800, 160, 220);
    renderer.reconcile(state);
    expect(rafCb).toBeNull();
    expect(tip.style.translate).toBe(el(stage, "card")!.style.translate);
  });
});

// --- isCardTouchTarget: the touch long-press "peek" gate (only combat CARDS trigger a peek) --------------------

describe("isCardTouchTarget (touch peek gate)", () => {
  it("returns true for an NCard record, false for a non-card and an unknown id", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    const nodes = [
      rawNode("frame", null, { nodeType: "Control", transform: xform(0, 0), localRect: box(1920, 1080) }),
      rawNode("card", "frame", { nodeType: "NCard", transform: xform(540, 800), localRect: box(160, 220) }),
      rawNode("other", "frame", { nodeType: "TextureRect", transform: xform(200, 200), localRect: box(50, 50) }),
      rawNode("removal", "frame", {
        nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantCardRemoval",
        transform: xform(1370, 678),
        localRect: box(218, 218)
      })
    ];
    full(state, nodes, nodes.map((n) => n.id as string));
    renderer.reconcile(state);

    expect(renderer.isCardTouchTarget("card")).toBe(true);
    expect(renderer.isCardTouchTarget("other")).toBe(false);
    expect(renderer.isCardTouchTarget("nope")).toBe(false);
    // R20: the card-removal coin arms on the first tap (TOUCH_TARGET_TYPES) but is deliberately NOT a card. This
    // predicate drives the non-hand long-press RIGHT-CLICK, which exists to open an item's DETAIL dialog; the
    // removal service has no detail view, so a right-click there is a no-op at best. Same separation NRewardButton
    // and NTreasureRoomRelicHolder already have. Native twin: TouchTargetScan.IsCard.
    expect(renderer.isCardTouchTarget("removal")).toBe(false);
  });
});

// --- mirrorWalkStats: the Stage-1 walk instrumentation seam (a benchmark reads this exact shape) --------------

describe("mirrorWalkStats (walk instrumentation)", () => {
  it("counts a structural keyframe as a full walk and styles every visible node", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    mirrorWalkStats.reset();
    full(state, [rawNode("a", null), rawNode("b", "a")], ["a", "b"]);
    renderer.reconcile(state);
    expect(mirrorWalkStats.fullWalks).toBe(1); // structural (firstBuild)
    expect(mirrorWalkStats.updateWalks).toBe(0);
    expect(mirrorWalkStats.visits).toBe(2); // both nodes fully visited
    expect(mirrorWalkStats.styledNodes).toBe(2); // both ran the paint restyle
    expect(mirrorWalkStats.skippedSubtrees).toBe(0); // nothing skipped on a structural walk
  });

  it("styles only the changed node and skips clean sibling subtrees on a deep volatile change", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    // A p→c→g chain plus a clean sibling subtree s→s2.
    full(
      state,
      [rawNode("p", null), rawNode("c", "p"), rawNode("g", "c"), rawNode("s", null), rawNode("s2", "s")],
      ["p", "c", "g", "s", "s2"]
    );
    renderer.reconcile(state);

    mirrorWalkStats.reset();
    // Change ONLY the deep child g (fresh object; its ancestors p/c keep object identity).
    volatile(state, [rawNode("g", "c", { name: "", localRect: box(33, 8) })]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.updateWalks).toBe(1);
    expect(mirrorWalkStats.fullWalks).toBe(0);
    // g runs the restyle; its clean ancestors p/c are descended THROUGH (dirty path) but not styled.
    expect(mirrorWalkStats.styledNodes).toBe(1);
    // The clean sibling subtree (s + its child s2) is skip-cleaned as ONE subtree — a real per-walk win.
    expect(mirrorWalkStats.skippedSubtrees).toBeGreaterThan(0);
  });

  it("is exposed on window for the benchmark seam", () => {
    expect((window as unknown as Record<string, unknown>).__mirrorWalkStats).toBe(mirrorWalkStats);
  });
});

// --- Stage 2: the recurse-only fast path for clean nodes on a dirty path -------------------------------------

describe("Stage 2 recurse-only fast path", () => {
  it("fast-paths a clean chain to reach a deep-child change (fastPathVisits 3, styledNodes 1) with parity intact", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // r → a → b → c → g, each a box with a distinct local transform so the composition oracle can verify nesting.
    full(
      state,
      [
        rawNode("r", null, { transform: xform(50, 60), localRect: box(100, 100) }),
        rawNode("a", "r", { transform: xform(20, 20), localRect: box(80, 80) }),
        rawNode("b", "a", { transform: xform(20, 20), localRect: box(60, 60) }),
        rawNode("c", "b", { transform: xform(20, 20), localRect: box(40, 40) }),
        rawNode("g", "c", { transform: xform(20, 20), localRect: box(20, 20) })
      ],
      ["r", "a", "b", "c", "g"]
    );
    renderer.reconcile(state);

    mirrorWalkStats.reset();
    // Move ONLY the deepest node g (fresh object; r/a/b/c keep object identity).
    volatile(state, [rawNode("g", "c", { name: "", transform: xform(50, 60), localRect: box(20, 20) })]);
    renderer.reconcile(state);

    // r, a, b are clean ancestors on the dirty path → recurse-only fast path (3). c is g's DIRECT parent
    // (changedParents) → excluded, so it does a full but NON-styling visit. Only g runs the paint restyle.
    expect(mirrorWalkStats.fastPathVisits).toBe(3);
    expect(mirrorWalkStats.styledNodes).toBe(1);

    // PARITY oracle: every element's composed on-screen matrix still equals its local-transform composition.
    approx(composedMatrix(el(stage, "r")!, stage), nodeMatrix([1, 0, 0, 1, 50, 60], { x: 0, y: 0 }));
    approx(composedMatrix(el(stage, "b")!, stage), nodeMatrix([1, 0, 0, 1, 90, 100], { x: 0, y: 0 }));
    approx(composedMatrix(el(stage, "c")!, stage), nodeMatrix([1, 0, 0, 1, 110, 120], { x: 0, y: 0 }));
    approx(composedMatrix(el(stage, "g")!, stage), nodeMatrix([1, 0, 0, 1, 160, 180], { x: 0, y: 0 })); // moved
  });

  it("restyles children when a parent's modulate TINT changes (inherited ctx changed ⇒ no fast path)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("p", null, { modulate: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" } }), rawNode("c", "p")], ["p", "c"]);
    renderer.reconcile(state);

    mirrorWalkStats.reset();
    // Change p's modulate TINT (RGB) → the composed childTint threaded to c changes, so c's inherited ctx changes.
    volatile(state, [rawNode("p", null, { name: "", modulate: { r: 0.5, g: 0.5, b: 0.5, a: 1, html: "#808080" } })]);
    renderer.reconcile(state);

    // p changed (restyled); c's ctx.tint changed ⇒ NOT clean ⇒ full visit (restyle), NOT the fast path.
    expect(mirrorWalkStats.fastPathVisits).toBe(0);
    expect(mirrorWalkStats.styledNodes).toBe(2);
    // c actually picked up the inherited tint (a filter) — proving it was re-styled, not skip-cleaned.
    expect(el(stage, "c")!.style.filter).toContain("mtint");
  });

  it("does NOT fast-path a parent whose direct child changed, so behindCount + child order stay correct", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A parent with own paint (self-layer) + one behind child + one normal child (mirrors the ordering test).
    full(
      state,
      [
        rawNode("p", null, { fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000" } }),
        rawNode("behind", "p", { showBehindParent: true }),
        rawNode("front", "p", {})
      ],
      ["p", "behind", "front"]
    );
    renderer.reconcile(state);

    mirrorWalkStats.reset();
    // Volatile-upsert the behind child (fresh object). Its DIRECT parent p is in changedParents → p must take the
    // FULL visit (recompute behindCount), never the fast path.
    volatile(state, [rawNode("behind", "p", { name: "", localRect: { position: { x: 0, y: 0 }, size: { x: 50, y: 12 } } })]);
    renderer.reconcile(state);

    // p is excluded from the fast path; the behind child restyles; the untouched front sibling is skip-cleaned.
    expect(mirrorWalkStats.fastPathVisits).toBe(0);
    expect(mirrorWalkStats.skippedSubtrees).toBeGreaterThan(0);

    // Order preserved: [behind child, the node's own paint (self-layer), normal child].
    const p = el(stage, "p")!;
    const selfLayer = p.querySelector(":scope > .mirror-clip-self")!;
    const kids = [...p.children];
    expect(kids.indexOf(el(stage, "behind")!)).toBeLessThan(kids.indexOf(selfLayer));
    expect(kids.indexOf(selfLayer)).toBeLessThan(kids.indexOf(el(stage, "front")!));
  });
});
