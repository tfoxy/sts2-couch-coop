import { nextTick, shallowRef } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  isCombatBackgroundSceneRoot,
  isEventBackgroundSceneRoot,
  isRoomBackgroundSubtreeRoot,
  isStaticBackgroundSuppressibleRoot,
  mirrorWalkStats,
  staticBgTargetPathOf,
  tryParseEventBackgroundSceneId,



  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { MIRROR_RENDERER_KEY } from "@/mirror/rendererKey";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import StaticBackground from "@/mirror/StaticBackground.vue";
import { __setStillDecoderForTest } from "@/mirror/stillDecode";
import { __setStageBackendForTest, requestedStageBackend, type StageBackend } from "@/mirror/rendererFactory";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorState
} from "@/mirror/sceneTree";

// "Static background": the host-rendered PNG of the combat room's background, and what the renderer does with the
// LIVE bg subtree while it is on screen. Two contracts live here, and R12 split them apart deliberately:
//
//   * the BUILD HOLD (R12, renderer-owned) — while the setting is on and this room's picture is unconfirmed OR
//     shown, the combat bg scene root is folded into `visit`'s `hidden`, so it is never built at all: no elements,
//     no atlas/spine canvases, no gsw shader/particle bindings, nothing queued for the idle hatchery. Derived from
//     the WIRE plus mirrorSettings, so the very first walk that sees a new room's root already holds it.
//   * the SHOWN-SIGNAL suppression (Stage-A, component-owned) — `display:none` + gsw's effect-suspend stamp on a
//     root that exists after a fail-open recovery.
//
// Fail-open is the invariant across both: setting off, decode failure, or watchdog ⇒ the live subtree.
// The root-matching rule (convention path + BgContainer under CombatSceneContainer, covering EventRoom-wrapped
// combat and excluding the non-combat screens) is pinned here too, over wire-shaped deltas.

const UNDERDOCKS_BG = "res://scenes/backgrounds/underdocks/underdocks_background.tscn";
const UNDERDOCKS_LAYER = "res://scenes/backgrounds/underdocks/layers/underdocks_bg_00_c.tscn";
const SPIRE_BG = "res://scenes/backgrounds/spire/spire_background.tscn";
const NEOW_BG = "res://scenes/events/background_scenes/neow.tscn";
const TEZCATARA_BG = "res://scenes/events/background_scenes/tezcatara.tscn";

function rawNode(id: string, parentId: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Node2D",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } },
    visible: true,
    fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#334455" },
    ...over
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!
  );
}

// A PLAIN combat room: CombatRoom > CombatSceneContainer > BgContainer > <bg root> (+ one mounted layer), plus an
// unrelated sibling. The same wire shape the producer streams (names + sceneFilePath are what the matcher reads).
function combatNodes(bgId = "bg", scenePath = UNDERDOCKS_BG, layerPath = UNDERDOCKS_LAYER): Record<string, unknown>[] {
  return [
    rawNode("room", null, { name: "CombatRoom" }),
    rawNode("csc", "room", { name: "CombatSceneContainer" }),
    rawNode("bgc", "csc", { name: "BgContainer" }),
    rawNode(bgId, "bgc", { name: "UnderdocksBackground", sceneFilePath: scenePath }),
    rawNode("layer0", bgId, { name: "UnderdocksBg00C", sceneFilePath: layerPath }),
    rawNode("hero", "room", { name: "Hero" })
  ];
}

const COMBAT_ORDER = ["room", "csc", "bgc", "bg", "layer0", "hero"];

// An EVENT screen: EventRoom > layout > <backdrop root> (+ one child), plus unrelated UI. The backdrop mounts
// directly (no BgContainer/CombatSceneContainer chain) — that is the event convention.
function eventNodes(bgId = "neowbg", scenePath = NEOW_BG): Record<string, unknown>[] {
  return [
    rawNode("eventroom", null, { name: "EventRoom" }),
    rawNode("layout", "eventroom", { name: "AncientEventLayout" }),
    rawNode(bgId, "layout", { name: "NeowBackground", sceneFilePath: scenePath }),
    rawNode("fog", bgId, { name: "Fog" }),
    rawNode("options", "eventroom", { name: "Options" })
  ];
}

const EVENT_ORDER = ["eventroom", "layout", "neowbg", "fog", "options"];

const MERCHANT_ROOM = "res://scenes/rooms/merchant_room.tscn";

// The SHOP: the backdrop is an INLINE subtree (SceneContainer/BgContainer) of the room scene — the interactive
// merchant button and inventory are OUTSIDE it and must stay live.
function shopNodes(): Record<string, unknown>[] {
  return [
    rawNode("mroom", null, { name: "MerchantRoom", sceneFilePath: MERCHANT_ROOM }),
    rawNode("scont", "mroom", { name: "SceneContainer" }),
    rawNode("mbgc", "scont", { name: "BgContainer" }),
    rawNode("mfire", "mbgc", { name: "fire" }),
    rawNode("mbutton", "scont", { name: "MerchantButton" }),
    rawNode("minv", "mroom", { name: "Inventory", sceneFilePath: "res://scenes/merchant/merchant_inventory.tscn" })
  ];
}

const SHOP_ORDER = ["mroom", "scont", "mbgc", "mfire", "mbutton", "minv"];

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function el(stage: HTMLElement, id: string): HTMLElement {
  return stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = "";
  mirrorSettings.staticBgEnabled = true;
  mirrorSettings.staticBgFailed = false;
  mirrorWalkStats.reset();
});

afterEach(() => {
  mirrorSettings.staticBgEnabled = true;
  mirrorSettings.staticBgFailed = false;
  __setStillDecoderForTest(null);
});

describe("isCombatBackgroundSceneRoot — the matching rule", () => {
  it("matches the plain combat chain and the EventRoom-wrapped one; leaves every non-combat mount alone", () => {
    const state = createMirrorState();
    full(
      state,
      [
        ...combatNodes(),
        // EventRoom-WRAPPED combat: extra ancestors above CombatSceneContainer must not matter.
        rawNode("eventroom", null, { name: "EventRoom" }),
        rawNode("wrap", "eventroom", { name: "EventCombatWrap" }),
        rawNode("csc2", "wrap", { name: "CombatSceneContainer" }),
        rawNode("bgc2", "csc2", { name: "BgContainer" }),
        rawNode("bg2", "bgc2", { name: "UnderdocksBackground", sceneFilePath: UNDERDOCKS_BG }),
        // A background-convention scene mounted OUTSIDE any CombatSceneContainer (RestSite/Merchant/MainMenu
        // shape) must NOT match — those screens keep their live subtree.
        rawNode("rest", null, { name: "RestSiteRoom" }),
        rawNode("restbg", "rest", { name: "Background", sceneFilePath: UNDERDOCKS_BG }),
        // An EVENT backdrop (different convention entirely).
        rawNode("neow", "rest", { sceneFilePath: "res://scenes/events/background_scenes/neow.tscn" })
      ],
      [...COMBAT_ORDER, "eventroom", "wrap", "csc2", "bgc2", "bg2", "rest", "restbg", "neow"]
    );
    const nodes = state.nodes;
    expect(isCombatBackgroundSceneRoot(nodes.get("bg")!, nodes)).toBe(true);
    expect(isCombatBackgroundSceneRoot(nodes.get("bg2")!, nodes)).toBe(true);
    expect(isCombatBackgroundSceneRoot(nodes.get("restbg")!, nodes)).toBe(false);
    expect(isCombatBackgroundSceneRoot(nodes.get("neow")!, nodes)).toBe(false);
    // The per-layer sub-scene (one directory deeper, no back-referenced stem) never matches.
    expect(isCombatBackgroundSceneRoot(nodes.get("layer0")!, nodes)).toBe(false);
    // Containers themselves are not roots.
    expect(isCombatBackgroundSceneRoot(nodes.get("bgc")!, nodes)).toBe(false);
  });
});

// ================================================================================================================
// R12 — THE BUILD HOLD. The contract this round inverted: the subtree the picture replaces is never BUILT, rather
// than built and then hidden. Everything below runs with the shipped defaults (hold ON, dormancy ON).
// ================================================================================================================
describe("static-background BUILD HOLD", () => {
  it("PENDING ⇒ the bg root and its whole subtree are never built (no shown signal at all)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);

    // The blast radius is exactly the bg subtree: no root element, no layer element, no canvases anywhere under it.
    expect(el(stage, "bg")).toBeNull();
    expect(el(stage, "layer0")).toBeNull();
    // …and the rest of the room is completely untouched.
    expect(el(stage, "hero")).not.toBeNull();
    expect(el(stage, "bgc")).not.toBeNull();
    // The instrumentation that PROVES it (a bench reading 0 here is a fail-open run).
    expect(mirrorWalkStats.staticBgHoldSkippedBuilds).toBeGreaterThan(0);
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(1);
    expect(mirrorWalkStats.staticBgHoldExpiries).toBe(0);
  });

  it("a SUCCESSFUL decode keeps it held — releasing there would build exactly what the image replaces", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);

    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "bg")).toBeNull();
    expect(el(stage, "layer0")).toBeNull();
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(1);
  });

  it("decode FAILURE (staticBgFailed) builds the live subtree on the very next full walk — fail-open", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "bg")).toBeNull();

    // The latch StaticBackground.vue flips on a decode error / its watchdog. MirrorView's watcher forces exactly
    // this walk (a HELD root is skip-clean, so only `structural` can see the release).
    mirrorSettings.staticBgFailed = true;
    renderer.reconcile(state, { forceTextures: true });
    expect(el(stage, "bg")).not.toBeNull();
    expect(el(stage, "bg").style.display).toBe("");
    expect(el(stage, "layer0")).not.toBeNull();
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(0);
  });

  it("setting OFF keeps the live subtree built", () => {
    mirrorSettings.staticBgEnabled = false;
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);

    expect(el(stage, "bg")).not.toBeNull();
    expect(el(stage, "bg").style.display).toBe("");
    expect(el(stage, "layer0")).not.toBeNull();
    expect(mirrorWalkStats.staticBgHoldSkippedBuilds).toBe(0);
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(0);
  });

  it("an out-of-chain combat-convention mount is untouched; an event backdrop IS covered now", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [
        ...combatNodes(),
        rawNode("rest", null, { name: "RestSiteRoom" }),
        rawNode("restbg", "rest", { name: "Background", sceneFilePath: UNDERDOCKS_BG }),
        rawNode("neow", "rest", { sceneFilePath: NEOW_BG })
      ],
      [...COMBAT_ORDER, "rest", "restbg", "neow"]
    );
    renderer.reconcile(state);

    expect(el(stage, "bg")).toBeNull(); // the combat one IS held
    expect(el(stage, "restbg")).not.toBeNull(); // combat convention OUTSIDE the chain stays live (RestSite shape)
    expect(el(stage, "neow")).toBeNull(); // the event backdrop rides the same hold since the events extension
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(2);
  });

  // THE highest-risk detail in the design. The idle hatchery's whole job is to pre-build dormant markers, so
  // without `setDormant`'s `queue` parameter it would silently re-create the entire problem — at idle, which is
  // exactly when a bench looks clean and a phone does not.
  it("the idle hatchery must NOT pre-build a held root (while still hatching everything else)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A genuinely hidden sibling subtree gives the hatchery real work, so the drain below proves it RAN.
    full(
      state,
      [
        ...combatNodes(),
        rawNode("dialog", "room", { name: "Dialog", visible: false }),
        rawNode("dialogChild", "dialog", { name: "DialogBody" })
      ],
      [...COMBAT_ORDER, "dialog", "dialogChild"]
    );
    renderer.reconcile(state);
    expect(el(stage, "bg")).toBeNull();
    expect(el(stage, "dialog")).toBeNull();

    for (let i = 0; i < 32 && renderer.__drainDormantHatchForTest(0); i++) {
      /* drain to empty */
    }
    // The hatchery did its job on the ordinary hidden subtree…
    expect(el(stage, "dialog")).not.toBeNull();
    expect(el(stage, "dialogChild")).not.toBeNull();
    // …and never touched the held one.
    expect(el(stage, "bg")).toBeNull();
    expect(el(stage, "layer0")).toBeNull();
  });

  // The second half of the same hazard: a bg root that was ALREADY a queued dormant marker when the hold engaged
  // (it arrived invisible under a kill-switched client, then the switch came back). `setDormant`'s "already a
  // marker" early return would leave the stale queue entry standing, and the drain would build it at idle.
  it("retracts a queue entry a bg root earned BEFORE the hold engaged", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const hiddenBg = combatNodes().map((n) => (n.id === "bg" ? { ...n, visible: false } : n));
    full(state, hiddenBg, COMBAT_ORDER);
    renderer.reconcile(state); // dormant (invisible) AND queued for the hatchery
    renderer.reconcile(state, { forceTextures: true });
    for (let i = 0; i < 32 && renderer.__drainDormantHatchForTest(0); i++) {
      /* drain to empty */
    }
    expect(el(stage, "bg")).toBeNull();
    expect(el(stage, "layer0")).toBeNull();
  });

  // The session envelope's descriptor lands one deferred host hop after the delta that mounts the new room, so the
  // renderer must hold that root on its introduction walk without waiting for a component callback.
  it("ROOM-CHANGE RACE: the new room's root is held on the walk that introduces it, with no component involvement", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    renderer.setStaticBackgroundShown(UNDERDOCKS_BG); // room A's image is up

    // Room B arrives on the wire. The component still believes A; the renderer does not care.
    full(state, combatNodes("bg", SPIRE_BG, "res://scenes/backgrounds/spire/layers/spire_bg_00_c.tscn"), COMBAT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "bg")).toBeNull();
    expect(el(stage, "layer0")).toBeNull();
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(1);
  });

  // The belt guards an UNRESOLVED room, and nothing else. Confirming the picture used to only DELETE the deadline,
  // so the next full walk found none and started a fresh clock — and the walk after that expiry fired it, building
  // the subtree under the picture. Live combat runs full walks (keyframe / bail / fixup / occlusion / staticBg)
  // constantly, so every combat longer than the belt regressed. `staticBgHoldMs = 0` makes any armed belt fire on
  // the very next walk, which is a strictly stronger probe than waiting the real 8s out.
  it("a CONFIRMED room is belt-exempt — the clock must not re-arm after the image lands", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state); // held; a belt is armed while the room is still unresolved

    renderer.setStaticBackgroundShown(UNDERDOCKS_BG); // …and now it is resolved
    for (let i = 0; i < 4; i++) {
      renderer.reconcile(state, { forceTextures: true });
    }
    expect(el(stage, "bg")).toBeNull();
    expect(el(stage, "layer0")).toBeNull();
    expect(mirrorWalkStats.staticBgHoldExpiries).toBe(0);
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(1);
  });

});

// A decode failure opens the live path. These cases cover the existing-element writer after that fail-open recovery:
// a later successful static image may still suppress the rebuilt root without waiting for another scene walk.
describe("renderer suppression after fail-open — root-only display:none, gated on the shown-signal", () => {
  beforeEach(() => {
    mirrorSettings.staticBgFailed = true;
  });

  it("does NOT suppress anything before the image is confirmed shown", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "bg").style.display).toBe("");
    expect(el(stage, "layer0").style.display).toBe("");
  });

  it("suppresses the matched root (and ONLY the root element) once shown, immediately — no walk needed", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);

    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);
    expect(el(stage, "bg").style.display).toBe("none");
    // Root-only: the layer child's own display stays untouched (the cascade hides it), siblings untouched.
    expect(el(stage, "layer0").style.display).toBe("");
    expect(el(stage, "hero").style.display).toBe("");
    expect(el(stage, "bgc").style.display).toBe("");
  });

  it("clearing the signal (fetch failure / image gone) restores the live subtree — fail-open", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);

    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);
    expect(el(stage, "bg").style.display).toBe("none");
    renderer.setStaticBackgroundShown(null);
    expect(el(stage, "bg").style.display).toBe("");
  });

  it("setting OFF ⇒ no suppression, even with a shown signal", () => {
    mirrorSettings.staticBgEnabled = false;
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);

    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);
    expect(el(stage, "bg").style.display).toBe("");
  });

  it("a root that WALKS IN while the signal holds is suppressed on its first visit (room re-entry)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("lobby", null)], ["lobby"]);
    renderer.reconcile(state);

    renderer.setStaticBackgroundShown(UNDERDOCKS_BG); // image already confirmed from the previous room
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "bg").style.display).toBe("none");
    expect(el(stage, "hero").style.display).toBe("");
  });

  it("suppression survives further walks (a volatile re-style must not resurrect the root)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);

    full(state, combatNodes(), COMBAT_ORDER); // a fresh keyframe re-visits everything
    renderer.reconcile(state);
    expect(el(stage, "bg").style.display).toBe("none");
  });
});

// AUG-14 DORMANCY DECLARATION. `display:none` alone hid the bg subtree from the VIEWER but not from gsw: every
// shader/particle binding under it stayed live (a full GL draw per tick, the animation loop alive for a
// TIME-reading shader, a getBoundingClientRect for a screen-space one), and none of them could ever be disposed —
// gsw's 30s sweep only reaches DORMANT bindings, and nothing was declaring dormancy. The suppressed root now also
// carries gsw's EFFECTS_SUSPENDED_ATTR, which is ancestor-scoped (`closest()`), so one stamp parks the subtree.
// A held root has no element to stamp and needs none because it owns no bindings. This suite exercises the writer
// after fail-open has rebuilt a live root.
describe("static-background suppression declares dormancy to gsw", () => {
  const SUSPENDED = "data-godot-effects-suspended";

  beforeEach(() => {
    mirrorSettings.staticBgFailed = true;
  });

  it("stamps the effect-suspend marker on the suppressed root, and ONLY there", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "bg").hasAttribute(SUSPENDED)).toBe(false);

    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);
    expect(el(stage, "bg").getAttribute(SUSPENDED)).toBe("static-bg");
    // Ancestor-scoped, so the stamp belongs on the root alone — never on the children it already covers, and
    // never on anything outside the suppressed subtree.
    expect(el(stage, "layer0").hasAttribute(SUSPENDED)).toBe(false);
    expect(el(stage, "bgc").hasAttribute(SUSPENDED)).toBe(false);
    expect(el(stage, "hero").hasAttribute(SUSPENDED)).toBe(false);
  });

  it("takes the marker back off when the suppression lifts, and the subtree repaints", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);

    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);
    expect(el(stage, "bg").getAttribute(SUSPENDED)).toBe("static-bg");

    renderer.setStaticBackgroundShown(null); // fail-open: the live subtree comes back
    expect(el(stage, "bg").hasAttribute(SUSPENDED)).toBe(false);
    expect(el(stage, "bg").style.display).toBe("");
    // …and a later walk keeps it awake (the stamp must not creep back on a re-style).
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "bg").hasAttribute(SUSPENDED)).toBe(false);
    expect(el(stage, "bg").style.display).toBe("");
  });

  // The defect this fixes: a settled combat re-styles NOTHING, so a stamp that only landed inside the walk's
  // `!hidden && !cull && selfDirty` block would never land. Both writers sit outside it — this is the walk one.
  it("a root that WALKS IN while the signal holds is stamped on its first visit", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("lobby", null)], ["lobby"]);
    renderer.reconcile(state);

    renderer.setStaticBackgroundShown(UNDERDOCKS_BG); // image already confirmed from the previous room
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "bg").getAttribute(SUSPENDED)).toBe("static-bg");

    // The signal clearing while the tree is settled must take it off through the same helper.
    renderer.setStaticBackgroundShown(null);
    expect(el(stage, "bg").hasAttribute(SUSPENDED)).toBe(false);
  });

  it("setting OFF ⇒ no stamp at all (the gate and the marker are the same decision)", () => {
    mirrorSettings.staticBgEnabled = false;
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);

    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);
    expect(el(stage, "bg").hasAttribute(SUSPENDED)).toBe(false);
    expect(el(stage, "bg").style.display).toBe("");
  });

  // The attribute has TWO independent owners now (the occlusion gate and this one). gsw reads PRESENCE, not value,
  // so neither may strip a stamp the other still wants — the occlusion gate's disengage in particular used to be a
  // blind `removeAttribute`.
  it("coexists with the occlusion gate: a dialog opening and closing never un-parks the bg subtree", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // The combat chain plus a dialog whose full-stage opaque Stop backdrop is a tier-1 cover.
    const cover = [
      rawNode("dialog", null, { name: "Dialog" }),
      rawNode("scrim", "dialog", {
        nodeType: "Godot.ColorRect",
        localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } },
        fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000ff" },
        mouseFilter: 0
      })
    ];
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);
    expect(el(stage, "bg").getAttribute(SUSPENDED)).toBe("static-bg");

    // Dialog opens. Several walks: the occlusion gate engages only after its hysteresis.
    full(state, [...combatNodes(), ...cover], [...COMBAT_ORDER, "dialog", "scrim"]);
    for (let i = 0; i < 4; i++) {
      renderer.reconcile(state);
    }
    const occludedRoot = stage.querySelector('[data-godot-effects-suspended="occluded"]');
    expect(occludedRoot, "the dialog should have gated a covered root").not.toBeNull();
    expect(el(stage, "bg").getAttribute(SUSPENDED)).toBe("static-bg");

    // Dialog closes: the occlusion gate disengages — and must leave the bg root's own claim alone.
    full(state, combatNodes(), COMBAT_ORDER);
    for (let i = 0; i < 4; i++) {
      renderer.reconcile(state);
    }
    expect(stage.querySelector('[data-godot-effects-suspended="occluded"]')).toBeNull();
    expect(el(stage, "bg").getAttribute(SUSPENDED)).toBe("static-bg");
    expect(el(stage, "bg").style.display).toBe("none");
  });

  // …and the same-ELEMENT case, which is the one that actually needed fixing: when a cover's earlier-painting
  // sibling IS the bg root, both gates claim the attribute on one element. The occlusion gate's disengage used to
  // be a blind `removeAttribute`, which would have un-parked a subtree that is still `display:none`.
  it("two owners on ONE element: the occlusion gate disengaging leaves the bg gate's claim standing", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // The scrim is the bg root's own later-painting sibling, so `bg` is the covered root the occlusion pass picks.
    const covered = [
      ...combatNodes(),
      rawNode("scrim", "bgc", {
        nodeType: "Godot.ColorRect",
        localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } },
        fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000ff" },
        mouseFilter: 0
      })
    ];
    full(state, covered, [...COMBAT_ORDER, "scrim"]);
    for (let i = 0; i < 4; i++) {
      renderer.reconcile(state);
    }
    expect(el(stage, "bg").getAttribute(SUSPENDED)).toBe("occluded");

    // The static image lands while the cover is up: same element, second owner.
    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);
    expect(el(stage, "bg").hasAttribute(SUSPENDED)).toBe(true);

    // Cover goes away. The occlusion gate disengages — the bg gate does not.
    full(state, combatNodes(), COMBAT_ORDER);
    for (let i = 0; i < 4; i++) {
      renderer.reconcile(state);
    }
    expect(el(stage, "bg").getAttribute(SUSPENDED)).toBe("static-bg");
    expect(el(stage, "bg").style.display).toBe("none");

    // Only when the LAST owner lets go does the subtree wake and repaint.
    renderer.setStaticBackgroundShown(null);
    expect(el(stage, "bg").hasAttribute(SUSPENDED)).toBe(false);
    expect(el(stage, "bg").style.display).toBe("");
  });

  it("a root that leaves the tree does not resurrect a stale stamp when it comes back", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);
    expect(el(stage, "bg").getAttribute(SUSPENDED)).toBe("static-bg");

    // Room change: the bg root is gone (its element + record are torn down), then combat returns.
    full(state, [rawNode("lobby", null)], ["lobby"]);
    renderer.reconcile(state);
    expect(el(stage, "bg")).toBeNull();

    full(state, combatNodes(), COMBAT_ORDER);
    renderer.reconcile(state);
    // Re-derived from scratch on the first visit of the NEW element — same answer, freshly stamped.
    expect(el(stage, "bg").getAttribute(SUSPENDED)).toBe("static-bg");
    expect(el(stage, "bg").style.display).toBe("none");
  });
});

describe("StaticBackground.vue — decode gate + shown-signal ordering", () => {
  interface ShownCall {
    scenePath: string | null;
  }

  function fakeRenderer(calls: ShownCall[]): MirrorRenderer {
    return {
      setStaticBackgroundShown: (scenePath: string | null) => calls.push({ scenePath })
    } as unknown as MirrorRenderer;
  }

  function mountBg(
    calls: ShownCall[],
    descriptor: { scenePath: string; url: string } | null,
    state: MirrorState = createMirrorState()
  ) {
    return mount(StaticBackground, {
      props: { descriptor, state, revision: state.revision },
      global: { provide: { [MIRROR_RENDERER_KEY as symbol]: shallowRef(fakeRenderer(calls)) } }
    });
  }

  it("stage mode mounts with a null renderer without ever creating a DOM image, then queues the source bridge", async () => {
    const backendAtStart: StageBackend = requestedStageBackend();
    __setStageBackendForTest("canvas");
    const bridgeCalls: Array<{ scenePath: string; url: string }> = [];
    let ready: ((ok: boolean) => void) | undefined;
    const provided = shallowRef<MirrorRenderer | null>(null);
    const wrapper = mount(StaticBackground, {
      props: { descriptor: { scenePath: UNDERDOCKS_BG, url: "/bg/underdocks?v=1" }, state: createMirrorState(), revision: 0 },
      global: { provide: { [MIRROR_RENDERER_KEY as symbol]: provided } }
    });
    expect(wrapper.find('[data-testid="mirror-static-bg-image"]').exists()).toBe(false);

    provided.value = {
      setStaticBackgroundShown: () => {},
      setStaticBackgroundSource: (
        source: { scenePath: string; url: string } | null,
        callback?: (ok: boolean) => void
      ) => {
        if (source) bridgeCalls.push(source);
        ready = callback;
      }
    } as unknown as MirrorRenderer;
    await nextTick();
    expect(bridgeCalls).toEqual([{ scenePath: UNDERDOCKS_BG, url: "/bg/underdocks?v=1" }]);
    expect(wrapper.find('[data-testid="mirror-static-bg-image"]').exists()).toBe(false);

    ready!(true);
    await nextTick();
    expect(wrapper.find('[data-testid="mirror-static-bg-image"]').exists()).toBe(false);
    wrapper.unmount();
    __setStageBackendForTest(backendAtStart);
  });

  it("confirms shown only AFTER a successful decode, then renders the img", async () => {
    let pending: ((ok: boolean) => void) | null = null;
    __setStillDecoderForTest((_url, ready) => {
      pending = ready;
    });
    const calls: ShownCall[] = [];
    const url = "/bg/underdocks?layers=0123456789abcdef&v=1";
    const wrapper = mountBg(calls, { scenePath: UNDERDOCKS_BG, url });

    // Decode still in flight: nothing shown, nothing suppressed.
    expect(calls).toEqual([]);
    expect(wrapper.find('[data-testid="mirror-static-bg-image"]').exists()).toBe(false);

    pending!(true);
    await wrapper.vm.$nextTick();
    expect(calls).toEqual([{ scenePath: UNDERDOCKS_BG }]);
    const img = wrapper.get('[data-testid="mirror-static-bg-image"]');
    expect(img.attributes("src")).toBe(url);
    // REGRESSION PIN (resize/fullscreen z-order): beneath-everything is enforced by the most-negative inline
    // z-index, NOT DOM order — the reconciler's full-walk reorder (applyChildOrder) moves the mirror roots ahead
    // of foreign stage children, so a resize/fullscreen toggle used to leave this img painted ON TOP of the room.
    expect((img.element as HTMLElement).style.zIndex).toBe("-2147483648");
    wrapper.unmount();
    // Unmount clears the suppression (the live subtree returns).
    expect(calls[calls.length - 1]).toEqual({ scenePath: null });
  });

  it("a fetch/decode FAILURE clears the suppression and shows no image (fail-open)", async () => {
    __setStillDecoderForTest((_url, ready) => ready(false));
    const calls: ShownCall[] = [];
    const wrapper = mountBg(calls, { scenePath: UNDERDOCKS_BG, url: "/bg/underdocks?v=1" });
    await wrapper.vm.$nextTick();
    expect(calls[calls.length - 1]).toEqual({ scenePath: null });
    expect(mirrorSettings.staticBgFailed).toBe(true); // …and the host is told, so Stage B re-admits the subtree
    expect(wrapper.find('[data-testid="mirror-static-bg-image"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("setting OFF ⇒ no fetch, no image, suppression cleared", async () => {
    mirrorSettings.staticBgEnabled = false;
    const decoded: string[] = [];
    __setStillDecoderForTest((url, ready) => {
      decoded.push(url);
      ready(true);
    });
    const calls: ShownCall[] = [];
    const wrapper = mountBg(calls, { scenePath: UNDERDOCKS_BG, url: "/bg/underdocks?v=1" });
    await wrapper.vm.$nextTick();
    expect(decoded).toEqual([]);
    expect(calls[calls.length - 1]).toEqual({ scenePath: null });
    expect(wrapper.find('[data-testid="mirror-static-bg-image"]').exists()).toBe(false);
    wrapper.unmount();
  });

  // R12: the STAGE-B STEADY-STATE pin. With no bg root on the wire (the host is skipping the subtree) the
  // descriptor is the only source there is, and decode-before-swap still applies — nothing stale is on screen,
  // because the mounted room's picture IS the old image until the new one lands. See its wire-bearing twin below.
  it("keeps the OLD image until the NEW one decodes (room-change swap, no flash)", async () => {
    const readies: Array<(ok: boolean) => void> = [];
    __setStillDecoderForTest((_url, ready) => {
      readies.push(ready);
    });
    const calls: ShownCall[] = [];
    const first = { scenePath: UNDERDOCKS_BG, url: "/bg/underdocks?v=1" };
    const wrapper = mountBg(calls, first);
    readies[0](true);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="mirror-static-bg-image"]').attributes("src")).toBe(first.url);

    const second = { scenePath: SPIRE_BG, url: "/bg/spire?v=1" };
    await wrapper.setProps({ descriptor: second });
    // New decode pending: the OLD image is still up and the OLD suppression still holds.
    expect(wrapper.get('[data-testid="mirror-static-bg-image"]').attributes("src")).toBe(first.url);
    expect(calls[calls.length - 1]).toEqual({ scenePath: UNDERDOCKS_BG });

    readies[1](true);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="mirror-static-bg-image"]').attributes("src")).toBe(second.url);
    expect(calls[calls.length - 1]).toEqual({ scenePath: second.scenePath });
    wrapper.unmount();
  });

  it("derives the digest-less deterministic URL from the wire when the host sent no descriptor", async () => {
    __setStillDecoderForTest((_url, ready) => ready(true));
    const calls: ShownCall[] = [];
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    const wrapper = mountBg(calls, null, state);
    await wrapper.vm.$nextTick();
    const img = wrapper.get('[data-testid="mirror-static-bg-image"]');
    expect(img.attributes("src")).toBe("/bg/underdocks?v=1");
    expect(calls[calls.length - 1]).toEqual({ scenePath: UNDERDOCKS_BG });
    wrapper.unmount();
  });

  // R12 — the descriptor rides the session envelope, which the host republishes one deferred hop AFTER the delta
  // that mounted the new room. Under the build hold a stale descriptor would leave the PREVIOUS room's artwork as
  // the only thing on screen, with no decode for the mounted room ever starting.
  it("a STALE descriptor loses to the wire: the mounted room's URL is what gets decoded", async () => {
    const decoded: string[] = [];
    __setStillDecoderForTest((url, ready) => {
      decoded.push(url);
      ready(true);
    });
    const calls: ShownCall[] = [];
    const state = createMirrorState();
    // The wire says SPIRE; the envelope still says UNDERDOCKS.
    full(state, combatNodes("bg", SPIRE_BG, "res://scenes/backgrounds/spire/layers/spire_bg_00_c.tscn"), COMBAT_ORDER);
    const wrapper = mountBg(calls, { scenePath: UNDERDOCKS_BG, url: "/bg/underdocks?v=1" }, state);
    await wrapper.vm.$nextTick();
    expect(decoded).toEqual(["/bg/spire?v=1"]);
    expect(calls[calls.length - 1]).toEqual({ scenePath: SPIRE_BG });
    wrapper.unmount();
  });

  it("the descriptor WINS when the wire carries no bg root at all (the Stage-B steady state)", async () => {
    const decoded: string[] = [];
    __setStillDecoderForTest((_url, ready) => {
      decoded.push(url);
      ready(true);
    });
    const calls: ShownCall[] = [];
    const url = "/bg/underdocks?layers=0123456789abcdef&v=1";
    // Empty wire — a host that is skipping the bg subtree streams no root for it.
    const wrapper = mountBg(calls, { scenePath: UNDERDOCKS_BG, url }, createMirrorState());
    await wrapper.vm.$nextTick();
    expect(decoded).toEqual([url]);
    expect(calls[calls.length - 1]).toEqual({ scenePath: UNDERDOCKS_BG });
    wrapper.unmount();
  });

  // The wire-bearing twin of the decode-before-swap pin: when the WIRE has moved to another room, the image on
  // screen is the previous room's — and with the build hold engaged it is the ONLY thing on screen. It must go
  // immediately, before the new decode resolves (`.mirror-stage`'s #181818 shows in the gap).
  it("STALE-SHOWN GUARD: a wire room change drops the old image BEFORE the new one decodes", async () => {
    const readies: Array<(ok: boolean) => void> = [];
    __setStillDecoderForTest((_url, ready) => {
      readies.push(ready);
    });
    const calls: ShownCall[] = [];
    const state = createMirrorState();
    full(state, combatNodes(), COMBAT_ORDER);
    const wrapper = mountBg(calls, null, state);
    readies[0](true);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="mirror-static-bg-image"]').attributes("src")).toBe("/bg/underdocks?v=1");

    // The wire flips to another room; no descriptor at all, so the wire is the only source.
    full(state, combatNodes("bg", SPIRE_BG, "res://scenes/backgrounds/spire/layers/spire_bg_00_c.tscn"), COMBAT_ORDER);
    await wrapper.setProps({ revision: state.revision });
    expect(wrapper.find('[data-testid="mirror-static-bg-image"]').exists()).toBe(false);
    expect(calls[calls.length - 1]).toEqual({ scenePath: null });

    readies[1](true);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="mirror-static-bg-image"]').attributes("src")).toBe("/bg/spire?v=1");
    expect(calls[calls.length - 1]).toEqual({ scenePath: SPIRE_BG });
    wrapper.unmount();
  });

  // The bound that keeps a room from staying dark on a stalled fetch. Deliberately SHORTER than the renderer's own
  // belt, so the component always wins and `mirrorWalkStats.staticBgHoldExpiries` stays 0 in a healthy session.
  it("WATCHDOG: a decode that never settles latches staticBgFailed and clears the signal", async () => {
    vi.useFakeTimers();
    try {
      __setStillDecoderForTest(() => {
        /* never settles */
      });
      const calls: ShownCall[] = [];
      const state = createMirrorState();
      full(state, combatNodes(), COMBAT_ORDER);
      const wrapper = mountBg(calls, null, state);
      await nextTick();
      expect(mirrorSettings.staticBgFailed).toBe(false);

      vi.advanceTimersByTime(6000);
      await nextTick();
      expect(mirrorSettings.staticBgFailed).toBe(true);
      expect(calls[calls.length - 1]).toEqual({ scenePath: null });
      expect(wrapper.find('[data-testid="mirror-static-bg-image"]').exists()).toBe(false);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  // ==============================================================================================================
  // EVENT BACKDROPS in the component: the wire fallback can mint the exact digest-less event URL (the grammar is
  // fixed — no layer variants), and combat wins when both families are mounted.
  // ==============================================================================================================
  it("derives the /bg/events URL from the wire when the host sent no descriptor (event screen)", async () => {
    __setStillDecoderForTest((_url, ready) => ready(true));
    const calls: ShownCall[] = [];
    const state = createMirrorState();
    full(state, eventNodes(), EVENT_ORDER);
    const wrapper = mountBg(calls, null, state);
    await wrapper.vm.$nextTick();
    const img = wrapper.get('[data-testid="mirror-static-bg-image"]');
    expect(img.attributes("src")).toBe("/bg/events/neow?v=1");
    expect(calls[calls.length - 1]).toEqual({ scenePath: NEOW_BG });
    wrapper.unmount();
  });

  it("COMBAT WINS the wire scan when both families are mounted (EventRoom-wrapped combat)", async () => {
    const decoded: string[] = [];
    __setStillDecoderForTest((url, ready) => {
      decoded.push(url);
      ready(true);
    });
    const calls: ShownCall[] = [];
    const state = createMirrorState();
    // The event backdrop PRECEDES the combat chain in map order, so this also proves the scan does not
    // first-match-wins its way onto the event candidate.
    full(state, [...eventNodes(), ...combatNodes()], [...EVENT_ORDER, ...COMBAT_ORDER]);
    const wrapper = mountBg(calls, null, state);
    await wrapper.vm.$nextTick();
    expect(decoded).toEqual(["/bg/underdocks?v=1"]);
    expect(calls[calls.length - 1]).toEqual({ scenePath: UNDERDOCKS_BG });
    wrapper.unmount();
  });

  it("a STALE combat descriptor loses to the wire's event root (combat→event room change)", async () => {
    const decoded: string[] = [];
    __setStillDecoderForTest((url, ready) => {
      decoded.push(url);
      ready(true);
    });
    const calls: ShownCall[] = [];
    const state = createMirrorState();
    // The wire says the NEOW event screen; the envelope still says the previous combat room.
    full(state, eventNodes(), EVENT_ORDER);
    const wrapper = mountBg(calls, { scenePath: UNDERDOCKS_BG, url: "/bg/underdocks?v=1" }, state);
    await wrapper.vm.$nextTick();
    expect(decoded).toEqual(["/bg/events/neow?v=1"]);
    expect(calls[calls.length - 1]).toEqual({ scenePath: NEOW_BG });
    wrapper.unmount();
  });

});

// ================================================================================================================
// EVENT BACKDROPS — the static-background events extension. The strict convention predicate, the same build
// hold / suppression / belt / fail-open contracts as combat, and the wrapped-combat release (a confirmed COMBAT
// still must not leave an event backdrop on an armed belt).
// ================================================================================================================
describe("event backdrops — predicate", () => {
  it("matches exactly the strict convention", () => {
    const state = createMirrorState();
    full(
      state,
      [
        ...eventNodes(),
        rawNode("nested", "layout", { sceneFilePath: "res://scenes/events/background_scenes/neow/props.tscn" }),
        rawNode("shader", "layout", { sceneFilePath: "res://scenes/events/background_scenes/neow_water.gdshader" }),
        rawNode("layoutscene", "eventroom", { sceneFilePath: "res://scenes/events/ancient_event_layout.tscn" })
      ],
      [...EVENT_ORDER, "nested", "shader", "layoutscene"]
    );
    const nodes = state.nodes;
    expect(tryParseEventBackgroundSceneId(NEOW_BG)).toBe("neow");
    expect(tryParseEventBackgroundSceneId(TEZCATARA_BG)).toBe("tezcatara");
    expect(isEventBackgroundSceneRoot(nodes.get("neowbg")!)).toBe(true);
    expect(isStaticBackgroundSuppressibleRoot(nodes.get("neowbg")!, nodes)).toBe(true);
    // Nested sub-scenes / non-scenes / the event LAYOUT scene never qualify — the still replaces exactly one
    // published backdrop root.
    expect(isEventBackgroundSceneRoot(nodes.get("nested")!)).toBe(false);
    expect(isEventBackgroundSceneRoot(nodes.get("shader")!)).toBe(false);
    expect(isEventBackgroundSceneRoot(nodes.get("layoutscene")!)).toBe(false);
    expect(isEventBackgroundSceneRoot(nodes.get("fog")!)).toBe(false);

  });
});

describe("event backdrops — build hold + suppression", () => {
  it("the backdrop root and its subtree are never built while pending, and stay held once shown", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, eventNodes(), EVENT_ORDER);
    renderer.reconcile(state);

    expect(el(stage, "neowbg")).toBeNull();
    expect(el(stage, "fog")).toBeNull();
    // …and the rest of the event screen is untouched.
    expect(el(stage, "options")).not.toBeNull();
    expect(el(stage, "layout")).not.toBeNull();
    expect(mirrorWalkStats.staticBgHoldSkippedBuilds).toBeGreaterThan(0);
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(1);
    expect(mirrorWalkStats.staticBgHoldExpiries).toBe(0);

    // Decode confirms — held exactly like combat (releasing would build what the picture replaces).
    renderer.setStaticBackgroundShown(NEOW_BG);
    full(state, eventNodes(), EVENT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "neowbg")).toBeNull();
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(1);
    expect(mirrorWalkStats.staticBgHoldExpiries).toBe(0);
  });

  it("fail-open: staticBgFailed builds the live backdrop on the next full walk", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, eventNodes(), EVENT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "neowbg")).toBeNull();

    mirrorSettings.staticBgFailed = true;
    renderer.reconcile(state, { forceTextures: true });
    expect(el(stage, "neowbg")).not.toBeNull();
    expect(el(stage, "neowbg").style.display).toBe("");
    expect(el(stage, "fog")).not.toBeNull();
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(0);
  });

  // EventRoom-WRAPPED combat can keep the event backdrop mounted behind the fight. The combat still is what gets
  // confirmed, so without the release the event backdrop would sit on an armed belt whose expiry counts as a bug
  // report in a perfectly healthy wrapped combat — and the doctrine is that ANY non-zero expiry is a bug report.
  it("WRAPPED-COMBAT RELEASE: a confirmed combat still releases the event backdrop with no belt expiry", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [...eventNodes(), ...combatNodes()], [...EVENT_ORDER, ...COMBAT_ORDER]);
    renderer.reconcile(state);
    // Cold: both candidates hold (nothing confirmed yet — either could be the still's subject).
    expect(el(stage, "bg")).toBeNull();
    expect(el(stage, "neowbg")).toBeNull();
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(2);

    // The combat decode lands: the event backdrop releases (it is not the picture's subject) and builds live,
    // the combat root stays held, and NO expiry is ever counted.
    renderer.setStaticBackgroundShown(UNDERDOCKS_BG);
    renderer.reconcile(state, { forceTextures: true });
    expect(el(stage, "bg")).toBeNull();
    expect(el(stage, "neowbg")).not.toBeNull();
    expect(el(stage, "neowbg").style.display).toBe("");
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(1);
    expect(mirrorWalkStats.staticBgHoldExpiries).toBe(0);
  });

  // …but an EVENT room's own confirmed still must NOT release a newly-arriving event backdrop (event→event room
  // change keeps the R12 first-walk hold; the stale-shown guard clears the signal a flush later).
  it("an event→event room change keeps the new backdrop held while the OLD event image is still up", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, eventNodes(), EVENT_ORDER);
    renderer.reconcile(state);
    renderer.setStaticBackgroundShown(NEOW_BG); // room A's image is up

    // Room B (tezcatara) arrives on the wire; the component still believes A.
    full(state, eventNodes("neowbg", TEZCATARA_BG), EVENT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "neowbg")).toBeNull();
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(1);
  });

  it("shown-signal suppression + gsw dormancy stamp work on an event root after fail-open", () => {
    mirrorSettings.staticBgFailed = true;
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, eventNodes(), EVENT_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "neowbg").style.display).toBe("");

    renderer.setStaticBackgroundShown(NEOW_BG);
    expect(el(stage, "neowbg").style.display).toBe("none");
    expect(el(stage, "neowbg").getAttribute("data-godot-effects-suspended")).toBe("static-bg");
    // Root-only, exactly like combat.
    expect(el(stage, "fog").style.display).toBe("");
    expect(el(stage, "options").style.display).toBe("");

    renderer.setStaticBackgroundShown(null); // fail-open
    expect(el(stage, "neowbg").style.display).toBe("");
    expect(el(stage, "neowbg").hasAttribute("data-godot-effects-suspended")).toBe(false);
  });
});

// ================================================================================================================
// ROOM BACKDROPS — the shop's inline-subtree family. The still replaces exactly SceneContainer/BgContainer of a
// table room; everything else in the room (merchant button, inventory) stays live and interactive.
// ================================================================================================================
describe("room backdrops — predicate + build hold + suppression", () => {
  it("matches exactly the table subtree, keyed on the ROOM scene path", () => {
    const state = createMirrorState();
    full(state, shopNodes(), SHOP_ORDER);
    const nodes = state.nodes;
    expect(isRoomBackgroundSubtreeRoot(nodes.get("mbgc")!, nodes)).toBe(true);
    expect(staticBgTargetPathOf(nodes.get("mbgc")!, nodes)).toBe(MERCHANT_ROOM);
    // The room root, the container, the fire child, and out-of-table BgContainers never match.
    expect(isRoomBackgroundSubtreeRoot(nodes.get("mroom")!, nodes)).toBe(false);
    expect(isRoomBackgroundSubtreeRoot(nodes.get("scont")!, nodes)).toBe(false);
    expect(isRoomBackgroundSubtreeRoot(nodes.get("mfire")!, nodes)).toBe(false);

  });

  it("holds ONLY the backdrop subtree; the merchant button and inventory build live", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, shopNodes(), SHOP_ORDER);
    renderer.reconcile(state);

    expect(el(stage, "mbgc")).toBeNull();
    expect(el(stage, "mfire")).toBeNull();
    expect(el(stage, "mbutton")).not.toBeNull();
    expect(el(stage, "minv")).not.toBeNull();
    expect(mirrorWalkStats.staticBgHeldRoots).toBe(1);
    expect(mirrorWalkStats.staticBgHoldExpiries).toBe(0);

    // Shown (the descriptor names the ROOM path) keeps it held; fail-open rebuilds.
    renderer.setStaticBackgroundShown(MERCHANT_ROOM);
    full(state, shopNodes(), SHOP_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "mbgc")).toBeNull();

    mirrorSettings.staticBgFailed = true;
    renderer.reconcile(state, { forceTextures: true });
    expect(el(stage, "mbgc")).not.toBeNull();
    expect(el(stage, "mfire")).not.toBeNull();
  });

  it("shown-signal suppression stamps the SUBTREE root after fail-open", () => {
    mirrorSettings.staticBgFailed = true;
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, shopNodes(), SHOP_ORDER);
    renderer.reconcile(state);
    expect(el(stage, "mbgc").style.display).toBe("");

    renderer.setStaticBackgroundShown(MERCHANT_ROOM);
    expect(el(stage, "mbgc").style.display).toBe("none");
    expect(el(stage, "mbgc").getAttribute("data-godot-effects-suspended")).toBe("static-bg");
    expect(el(stage, "mbutton").style.display).toBe("");
    expect(el(stage, "minv").style.display).toBe("");

    renderer.setStaticBackgroundShown(null);
    expect(el(stage, "mbgc").style.display).toBe("");
  });
});
