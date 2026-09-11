import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  commitConfirmTap,
  confirmTap,
  confirmedRelicTarget,
  forgetConfirmedRelic,
  hideConfirmTap,
  setConfirmBelowOverlay,
  setConfirmCommit,
  showConfirmTap,
  __resetConfirmTapForTest,
  __setConfirmSpritesForTest,
  type ConfirmSprites
} from "@/mirror/confirmTap";
import MirrorConfirmButton from "@/mirror/MirrorConfirmButton.vue";
import { createInputCapture, type InputCapture } from "@/mirror/inputCapture";
import {
  confirmTapEligible,
  createMirrorRenderer,

  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import type { MirrorInputMessage } from "@/mirror/mirrorClient";
import { mirrorSettings } from "@/mirror/mirrorSettings";

// CONFIRM TAP — the client-side confirm button for choices a tap cannot take back (confirmTap.ts).
//
// Three separable halves, tested as three blocks:
//   1. ELIGIBILITY  — which widgets the feature owns (mirrorRenderer.confirmTapEligible / confirmTapTarget),
//                     including the two gated cases: a reward-screen card vs any other card, and a MULTIPLAYER
//                     treasure relic vs the singleplayer one.
//   2. GESTURE      — a tap on an eligible widget NEVER clicks; the button's commit clicks at the coordinate the
//                     focus hover already went to; every un-focus path takes the button down.
//   3. STACKING     — whether a modal overlay paints over the option (mirrorRenderer.coverAbove), which is what
//                     decides if the button sits above the mirror tree or under it.

// --- fixtures ---------------------------------------------------------------------------------------------------

const SPRITES: ConfirmSprites = {
  button: { pageUrl: "/res/atlas.png", region: { x: 0, y: 0, width: 10, height: 10 }, margin: { x: 0, y: 0, width: 0, height: 0 } },
  outline: { pageUrl: "/res/atlas.png", region: { x: 0, y: 0, width: 10, height: 10 }, margin: { x: 0, y: 0, width: 0, height: 0 } },
  tick: { pageUrl: "/res/atlas.png", region: { x: 0, y: 0, width: 10, height: 10 }, margin: { x: 0, y: 0, width: 0, height: 0 } }
};

function nodeOf(id: string, nodeType: string, name = id) {
  return { id, name, nodeType };
}

describe("confirm tap — eligibility", () => {
  const notHand = () => false;
  const noScene = () => false;
  const rewardScreen = () => true;

  it("owns the four screens the player cannot undo, and nothing else", () => {
    expect(confirmTapEligible(nodeOf("o", "Godot.NEventOptionButton"), notHand, noScene)).toBe("event");
    expect(confirmTapEligible(nodeOf("r", "Godot.NRestSiteButton"), notHand, noScene)).toBe("rest");
    for (const shop of ["NMerchantRelic", "NMerchantPotion", "NMerchantCard", "NMerchantCardRemoval"]) {
      expect(confirmTapEligible(nodeOf("s", `Godot.${shop}`), notHand, noScene)).toBe("shop");
    }
    // Not a choice that spends anything: the post-combat reward LIST rows open a screen, they don't take a reward.
    expect(confirmTapEligible(nodeOf("b", "Godot.NRewardButton"), notHand, noScene)).toBeNull();
    expect(confirmTapEligible(undefined, notHand, noScene)).toBeNull();
  });

  it("takes a card ONLY on the card-reward screen — never a hand, deck or grid card", () => {
    expect(confirmTapEligible(nodeOf("c", "Godot.NCard"), notHand, rewardScreen)).toBe("reward");
    // A hand card is played by dragging and is recoverable; a deck/grid card is a browse.
    expect(confirmTapEligible(nodeOf("c", "Godot.NCard"), () => true, rewardScreen)).toBeNull();
    expect(confirmTapEligible(nodeOf("c", "Godot.NCard"), notHand, noScene)).toBeNull();
  });

  it("drops the shop's card-removal service once it has been used", () => {
    // Every other shop item leaves the tree when bought; the removal SERVICE stays on the carpet with its `Cost`
    // hidden. Live-verified A/B: `Cost` visible while the service is available, `visible: false` after it is used.
    const coin = nodeOf("coin", "Godot.NMerchantCardRemoval");
    expect(confirmTapEligible(coin, notHand, noScene, () => true)).toBe("shop");
    expect(confirmTapEligible(coin, notHand, noScene, () => false)).toBeNull();
    // Every OTHER shop slot is unaffected by that signal (they have no such spent state).
    expect(confirmTapEligible(nodeOf("p", "Godot.NMerchantPotion"), notHand, noScene, () => false)).toBe("shop");
  });

  it("takes MULTIPLAYER treasure relics only — the singleplayer holder shares its corner with Skip", () => {
    expect(
      confirmTapEligible(nodeOf("h1", "Godot.NTreasureRoomRelicHolder", "MultiplayerRelicHolder1"), notHand, noScene)
    ).toBe("relic");
    expect(
      confirmTapEligible(nodeOf("h0", "Godot.NTreasureRoomRelicHolder", "SingleplayerRelicHolder"), notHand, noScene)
    ).toBeNull();
  });
});

// --- the shared state module ------------------------------------------------------------------------------------

describe("confirm tap — state", () => {
  beforeEach(() => {
    __resetConfirmTapForTest();
    __setConfirmSpritesForTest(SPRITES);
  });
  afterEach(__resetConfirmTapForTest);

  it("refuses to show without resolved sprites, so a widget is never left uncommittable", () => {
    __setConfirmSpritesForTest(null);
    showConfirmTap("opt-1", "event");
    expect(confirmTap.targetId).toBeNull();
  });

  it("commits through the registered handler and takes itself down", () => {
    const commit = vi.fn();
    setConfirmCommit(commit);
    showConfirmTap("opt-1", "event");
    expect(confirmTap.targetId).toBe("opt-1");

    commitConfirmTap();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(confirmTap.targetId).toBeNull();

    // Nothing to commit with no button up.
    commitConfirmTap();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("will not re-offer a relic this client already selected, but will offer another one", () => {
    setConfirmCommit(() => {});
    showConfirmTap("relic-a", "relic");
    commitConfirmTap();
    expect(confirmedRelicTarget()).toBe("relic-a");

    // Focusing the selected relic again: no button (the vote is already on it).
    showConfirmTap("relic-a", "relic");
    expect(confirmTap.targetId).toBeNull();

    // A different relic is still a live choice — and confirming it MOVES the latch, so the first one is offerable
    // again (a treasure vote can be changed, so exactly one relic is "already selected" at a time).
    showConfirmTap("relic-b", "relic");
    expect(confirmTap.targetId).toBe("relic-b");
    commitConfirmTap();
    showConfirmTap("relic-a", "relic");
    expect(confirmTap.targetId).toBe("relic-a");
  });

  it("keeps the latch relic-only, so a shop purchase that failed can be re-confirmed", () => {
    setConfirmCommit(() => {});
    showConfirmTap("potion-1", "shop");
    commitConfirmTap();
    expect(confirmedRelicTarget()).toBeNull();
    showConfirmTap("potion-1", "shop");
    expect(confirmTap.targetId).toBe("potion-1");
  });

  it("drops the stacking verdict when the target changes, and the latch when its room is gone", () => {
    showConfirmTap("opt-1", "event");
    confirmTap.belowOverlay = true;
    showConfirmTap("opt-2", "event");
    expect(confirmTap.belowOverlay).toBe(false);

    setConfirmCommit(() => {});
    showConfirmTap("relic-a", "relic");
    commitConfirmTap();
    forgetConfirmedRelic();
    expect(confirmedRelicTarget()).toBeNull();
  });
});

// --- the gesture ------------------------------------------------------------------------------------------------

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {}
  } as DOMRect;
}

function touchEvent(type: string, clientX: number, clientY: number): MouseEvent {
  const ev = new MouseEvent(type, { button: 0, clientX, clientY, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "pointerType", { value: "touch" });
  Object.defineProperty(ev, "pointerId", { value: 1 });
  return ev;
}

function mouseEvent(type: string, clientX: number, clientY: number): MouseEvent {
  return new MouseEvent(type, { button: 0, clientX, clientY, bubbles: true, cancelable: true });
}

describe("confirm tap — gesture", () => {
  let stage: HTMLElement;
  let sent: MirrorInputMessage[];
  let capture: InputCapture;
  let frames: FrameRequestCallback[];
  let clock = 0;

  // The renderer's answers, stubbed: this block is about the GESTURE, and eligibility has its own block above.
  // C2: classification is COORDINATE-authoritative — each eligible widget is a GAME-space box, and the capture's
  // `confirmTapAt` getter answers from these, exactly like mirrorRenderer.confirmTapAt answers from the true
  // hit boxes. The DOM stack (stubTouchStack) still resolves `top` for the ordinary two-step branches and the
  // blocking-button veto — the point of the model is that the two can now DISAGREE, like they do live.
  interface EligibleBox {
    id: string;
    kind: "reward" | "event" | "shop" | "relic" | "rest";
    retapActivates?: boolean;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }
  let eligibleBoxes: EligibleBox[];

  /** The whole stage is this widget's box — for tests where WHERE the tap lands is not the point. */
  function eligibleEverywhere(id: string, kind: EligibleBox["kind"]): void {
    eligibleBoxes = [{ id, kind, minX: 0, minY: 0, maxX: 1920, maxY: 1080 }];
  }

  function activeRemovalEverywhere(): void {
    eligibleBoxes = [{ id: "removal", kind: "shop", retapActivates: true, minX: 0, minY: 0, maxX: 1920, maxY: 1080 }];
  }

  function confirmAtStub(x: number, y: number): { id: string; kind: EligibleBox["kind"]; retapActivates?: boolean } | null {
    for (let i = eligibleBoxes.length - 1; i >= 0; i--) {
      const b = eligibleBoxes[i];
      if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) {
        return { id: b.id, kind: b.kind, ...(b.retapActivates ? { retapActivates: true } : {}) };
      }
    }
    return null;
  }

  function stubTouchStack(...touchIds: string[]): void {
    const els = touchIds.map((id) => {
      const el = document.createElement("div");
      el.setAttribute("data-touch-id", id);
      return el;
    });
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => els;
  }

  /** The stack stops at a plain blocking button (Skip / End Turn) — `ids` empty, `blocked` true. */
  function stubTouchBlock(): void {
    const el = document.createElement("div");
    el.setAttribute("data-touch-block", "1");
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [el];
  }

  function makeCapture(confirmTapOn = true, tapToFocusOn?: boolean): void {
    capture?.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {
      confirmTap: () => confirmTapOn,
      ...(tapToFocusOn === undefined ? {} : { tapToFocus: () => tapToFocusOn }),
      confirmTapAt: (x, y) => confirmAtStub(x, y)
    });
  }

  function tap(x = 480, y = 270): void {
    stage.dispatchEvent(touchEvent("pointerdown", x, y));
    stage.dispatchEvent(touchEvent("pointerup", x, y));
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    frames = [];
    clock = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    __resetConfirmTapForTest();
    __setConfirmSpritesForTest(SPRITES);
    eligibleBoxes = [];
    stage = document.createElement("div");
    document.body.appendChild(stage);
    // Half-scale of the 1920x1080 design space, like the sibling inputCapture spec.
    stage.getBoundingClientRect = () => rect(0, 0, 960, 540);
    makeCapture();
  });

  afterEach(() => {
    capture.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetConfirmTapForTest();
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it("a tap on an eligible option FOCUSES it and raises the button — no click, ever", () => {
    eligibleEverywhere("reward-card", "reward");
    stubTouchStack("reward-card");

    tap();
    expect(sent.every((m) => m.kind === "hover")).toBe(true);
    expect(confirmTap.targetId).toBe("reward-card");

    // Re-tapping the same option only moves the cursor to where the finger landed — it must not commit, which is
    // the whole point: a finger bounce cannot spend the reward.
    clock += 1000; // well past TAP_ARM_DEBOUNCE_MS, so this is a genuine re-tap, not a swallowed bounce
    tap(600, 300);
    expect(sent.some((m) => m.kind === "click")).toBe(false);
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 1200, coordY: 600 });
    expect(confirmTap.targetId).toBe("reward-card");
  });

  it("uses the active removal coin's delayed retap only with both settings positively enabled", () => {
    for (const settings of [
      { confirm: true, focus: true, clicks: 1 },
      { confirm: true, focus: false, clicks: 0 },
      { confirm: false, focus: true, clicks: 1 },
      { confirm: false, focus: false, clicks: 2 },
    ]) {
      __resetConfirmTapForTest();
      __setConfirmSpritesForTest(SPRITES);
      makeCapture(settings.confirm, settings.focus);
      activeRemovalEverywhere();
      stubTouchStack("removal");
      tap();
      expect(confirmTap.targetId).toBe(settings.confirm ? "removal" : null);
      clock += 201; // the active-retap route preserves the ordinary armed-tap debounce.
      tap();
      expect(sent.filter((message) => message.kind === "click" && message.button === "left")).toHaveLength(settings.clicks);
      expect(confirmTap.targetId).toBe(settings.confirm && !settings.focus ? "removal" : null);
    }
  });

  it("debounces an active removal retap for 200ms before activating it once", () => {
    makeCapture(true, true);
    activeRemovalEverywhere();
    stubTouchStack("removal");
    tap();
    clock += 199;
    tap();
    expect(sent.some((message) => message.kind === "click")).toBe(false);
    clock += 2;
    tap();
    expect(sent.filter((message) => message.kind === "click" && message.button === "left")).toHaveLength(1);
  });

  it("uses the authoritative removal hit when the focused coin is absent from the touch stack", () => {
    makeCapture(false, true);
    activeRemovalEverywhere();
    // Focus animation/decorative wrappers can change this stack between taps. The game-space service classifier,
    // rather than either transient stamp, proves both taps name the same coin.
    stubTouchStack("coin-decoration");
    tap();
    clock += 201;
    stubTouchStack("focused-wrapper");
    tap();

    expect(sent.filter((message) => message.kind === "click" && message.button === "left")).toHaveLength(1);
  });

  it("keeps the removal focus arm after confirm UI liveness hides it", () => {
    makeCapture(true, true);
    activeRemovalEverywhere();
    stubTouchStack("coin-decoration");
    tap();
    expect(confirmTap.targetId).toBe("removal");

    hideConfirmTap(); // renderer liveness/setting hides the UI; this is not an input cancellation.
    expect(confirmTap.targetId).toBeNull();
    clock += 201;
    stubTouchStack("focused-wrapper");
    tap();

    expect(sent.filter((message) => message.kind === "click" && message.button === "left")).toHaveLength(1);
  });

  it("clears a removal focus arm on cancellation, a drag, another target, or a spent service", () => {
    makeCapture(false, true);
    activeRemovalEverywhere();
    stubTouchStack("removal");

    const requireFreshFocus = () => {
      sent = [];
      clock += 201;
      tap();
      expect(sent.some((message) => message.kind === "click" && message.button === "left")).toBe(false);
    };

    tap();
    stage.dispatchEvent(touchEvent("pointerdown", 480, 270));
    stage.dispatchEvent(touchEvent("pointercancel", 480, 270));
    requireFreshFocus();

    stage.dispatchEvent(touchEvent("pointerdown", 480, 270));
    stage.dispatchEvent(touchEvent("pointermove", 520, 270)); // cross touch slop: this is a drag, never a retap
    stage.dispatchEvent(touchEvent("pointerup", 520, 270));
    requireFreshFocus();

    eligibleBoxes = [];
    stubTouchStack("other-target");
    clock += 201;
    tap();
    activeRemovalEverywhere();
    stubTouchStack("removal");
    requireFreshFocus();

    eligibleBoxes = []; // the coin's Cost disappeared while its old decoration is still stamped
    stubTouchStack("removal");
    clock += 201;
    tap();
    expect(sent.some((message) => message.kind === "click" && message.button === "left")).toBe(false);
  });

  it("clears the removal focus arm when the confirm button commits", () => {
    makeCapture(true, true);
    activeRemovalEverywhere();
    stubTouchStack("removal");
    tap();
    commitConfirmTap();

    sent = [];
    clock += 201;
    tap();
    expect(sent.some((message) => message.kind === "click" && message.button === "left")).toBe(false);
  });

  it("keeps an unwired tap-to-focus getter confirm-only for repeated removal taps", () => {
    activeRemovalEverywhere();
    stubTouchStack("removal");
    tap();
    clock += 201;
    tap();
    expect(sent.some((message) => message.kind === "click")).toBe(false);
    expect(confirmTap.targetId).toBe("removal");
  });

  it("keeps the confirm-button route for the active removal service", () => {
    activeRemovalEverywhere();
    stubTouchStack("removal");
    tap();
    const before = sent.length;
    commitConfirmTap();
    expect(sent.slice(before)).toEqual([{ kind: "click", button: "left", coordX: 960, coordY: 540 }]);
  });

  it("keeps the remove-picker's immediate card block across both touch settings", () => {
    for (const settings of [
      { confirm: true, focus: true },
      { confirm: true, focus: false },
      { confirm: false, focus: true },
      { confirm: false, focus: false },
    ]) {
      __resetConfirmTapForTest();
      __setConfirmSpritesForTest(SPRITES);
      makeCapture(settings.confirm, settings.focus);
      eligibleBoxes = []; // exact picker cards are blocks, never confirm targets.
      stubTouchBlock();
      tap();
      expect(sent.filter((message) => message.kind === "click" && message.button === "left")).toHaveLength(1);
      expect(confirmTap.targetId).toBeNull();
    }
  });

  it("keeps confirm-tap interception ahead of already-focused one-tap activation", () => {
    capture.dispose();
    sent = [];
    eligibleEverywhere("reward-card", "reward");
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {
      isFocused: (id) => id === "reward-card",
      confirmTap: () => true,
      confirmTapAt: (x, y) => confirmAtStub(x, y)
    });
    stubTouchStack("reward-card");

    tap();
    expect(sent.some((message) => message.kind === "click")).toBe(false);
    expect(confirmTap.targetId).toBe("reward-card");
  });

  it("a Fake Merchant relic focuses without a click, and only its button commits at the focus coordinate", () => {
    // The event's NFakeMerchantInventory uses the normal NMerchantRelic leaf, so it is deliberately the existing
    // `shop` kind rather than a new event-only input path. The renderer-specific test below pins that real tree
    // shape; this one pins the gesture firewall once that classifier answer reaches inputCapture.
    eligibleEverywhere("fake-merchant-relic", "shop");
    stubTouchStack("fake-merchant-relic");

    tap(480, 270);
    expect(sent.every((m) => m.kind === "hover")).toBe(true);
    expect(confirmTap.targetId).toBe("fake-merchant-relic");
    const beforeCommit = sent.length;
    commitConfirmTap();

    // Exactly one left click, at the focus coordinate — a view-scaled option grows once focused, so re-resolving a
    // client point after the fact would land somewhere else entirely.
    expect(sent.slice(beforeCommit)).toEqual([{ kind: "click", button: "left", coordX: 960, coordY: 540 }]);
    expect(confirmTap.targetId).toBeNull();
  });

  it("takes the button down on every way the option stops being focused", () => {
    // …a tap on empty space (a coordinate outside every eligible box, nothing stamped there).
    eligibleEverywhere("opt-1", "event");
    stubTouchStack("opt-1");
    tap();
    expect(confirmTap.targetId).toBe("opt-1");
    eligibleBoxes = [];
    stubTouchStack();
    clock += 1000;
    tap();
    expect(confirmTap.targetId).toBeNull();

    // …a tap that arms a DIFFERENT, non-eligible widget.
    eligibleEverywhere("opt-1", "event");
    stubTouchStack("opt-1");
    clock += 1000;
    tap();
    expect(confirmTap.targetId).toBe("opt-1");
    eligibleBoxes = [];
    stubTouchStack("some-card");
    clock += 1000;
    tap();
    expect(confirmTap.targetId).toBeNull();

    // …a cancelled gesture (the OS stole the pointer).
    eligibleEverywhere("opt-1", "event");
    stubTouchStack("opt-1");
    clock += 1000;
    tap();
    expect(confirmTap.targetId).toBe("opt-1");
    stage.dispatchEvent(touchEvent("pointerdown", 480, 270));
    stage.dispatchEvent(touchEvent("pointercancel", 480, 270));
    expect(confirmTap.targetId).toBeNull();
  });

  it("follows the MOUSE off the option, and is never raised by a mouse hover", () => {
    eligibleEverywhere("opt-1", "event");
    stubTouchStack("opt-1");
    tap();
    expect(confirmTap.targetId).toBe("opt-1");

    // A plain mouse hover still over the option leaves it alone…
    stage.dispatchEvent(mouseEvent("pointermove", 480, 270));
    frames.splice(0).forEach((cb) => cb(0));
    expect(confirmTap.targetId).toBe("opt-1");

    // …and off it un-focuses in the game, so the button goes with it.
    stubTouchStack("something-else");
    stage.dispatchEvent(mouseEvent("pointermove", 700, 270));
    frames.splice(0).forEach((cb) => cb(0));
    expect(confirmTap.targetId).toBeNull();

    // A mouse hovering ONTO an eligible option never raises it — a mouse user clicks directly.
    stubTouchStack("opt-1");
    stage.dispatchEvent(mouseEvent("pointermove", 480, 270));
    frames.splice(0).forEach((cb) => cb(0));
    expect(confirmTap.targetId).toBeNull();
  });

  it("falls back to the ordinary two-step tap when the sprites never resolved", () => {
    __setConfirmSpritesForTest(null);
    eligibleEverywhere("opt-1", "event");
    stubTouchStack("opt-1");

    tap(); // arm
    clock += 1000;
    tap(); // …and the two-step's own commit, because there is no button to press
    expect(confirmTap.targetId).toBeNull();
    expect(sent.some((m) => m.kind === "click" && m.button === "left")).toBe(true);
  });

  it("is off when the setting is off: an eligible option goes back to the two-step tap", () => {
    makeCapture(false);
    eligibleEverywhere("opt-1", "event");
    stubTouchStack("opt-1");

    tap();
    expect(confirmTap.targetId).toBeNull();
    expect(sent.some((m) => m.kind === "click")).toBe(false); // armed by tapToFocus, not clicked
    clock += 1000;
    tap();
    expect(sent.some((m) => m.kind === "click" && m.button === "left")).toBe(true);
  });

  it("owns its widgets even with Tap to focus OFF — one tap focuses, the button commits", () => {
    capture.dispose();
    sent = [];
    eligibleEverywhere("opt-1", "event");
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {
      tapToFocus: () => false,
      confirmTap: () => true,
      confirmTapAt: (x, y) => confirmAtStub(x, y)
    });
    stubTouchStack("opt-1");

    tap();
    expect(sent.some((m) => m.kind === "click")).toBe(false);
    expect(confirmTap.targetId).toBe("opt-1");

    // …while a NON-eligible widget still presses on the first tap, exactly as that setting says.
    eligibleBoxes = [];
    stubTouchStack("plain-card");
    clock += 1000;
    tap();
    expect(sent.some((m) => m.kind === "click" && m.button === "left")).toBe(true);
  });

  it("is inert when unwired (no getters): the pre-existing tap path is untouched", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m));
    stubTouchStack("opt-1");
    tap();
    clock += 1000;
    tap();
    expect(confirmTap.targetId).toBeNull();
    expect(sent.filter((m) => m.kind === "click")).toHaveLength(1);
  });

  it("no phantom button: a stamped overhang OUTSIDE the widget's true box never raises it (rest-site Label)", () => {
    // The option's true box is the top-left quadrant; the DOM stamp (the Label's oversized box) claims the tap
    // anyway — the live rest-site shape, where the caption's box hangs a full widget-height below the button.
    eligibleBoxes = [{ id: "rest-opt", kind: "rest", minX: 0, minY: 0, maxX: 1920, maxY: 418 }];
    stubTouchStack("rest-opt");

    tap(480, 250); // design (960, 500) — below the true box, inside the stamped overhang
    expect(confirmTap.targetId).toBeNull(); // no button for a tap the game never focuses
    expect(sent.some((m) => m.kind === "click")).toBe(false); // first tap arms the two-step, it never clicks

    // …while the same stamp INSIDE the true box raises it.
    clock += 1000;
    tap(480, 100); // design (960, 200)
    expect(confirmTap.targetId).toBe("rest-opt");
  });

  it("an UNSTAMPED pixel inside an eligible box still focuses + raises — never the immediate click", () => {
    eligibleEverywhere("opt-1", "event");
    stubTouchStack(); // nothing stamped here (the gap between two stamped descendants)

    tap();
    expect(sent.every((m) => m.kind === "hover")).toBe(true);
    expect(confirmTap.targetId).toBe("opt-1");
  });

  it("a plain blocking button on top wins: immediate click even where an eligible box lies underneath", () => {
    eligibleEverywhere("reward-card", "reward");
    stubTouchBlock(); // the Skip button's data-touch-block is the topmost claim

    tap();
    expect(sent.some((m) => m.kind === "click" && m.button === "left")).toBe(true);
    expect(confirmTap.targetId).toBeNull();
  });

  it("a slop-crossed DRAG on an eligible option never presses — release still on it ends as focus + button", () => {
    eligibleEverywhere("opt-1", "event");
    stubTouchStack("opt-1");

    // Stage is half-scale, so the CSS slop floor is 10 CSS px = 20 design px; travel 30 CSS px to classify a drag.
    stage.dispatchEvent(touchEvent("pointerdown", 480, 270));
    stage.dispatchEvent(touchEvent("pointermove", 510, 270));
    stage.dispatchEvent(touchEvent("pointerup", 510, 270));

    expect(sent.some((m) => m.kind === "click")).toBe(false); // no press, no release, no full click
    expect(confirmTap.targetId).toBe("opt-1");
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 1020, coordY: 540 });
  });

  it("a drag that rolls OFF the option ends as a bare hover — it must not press what the finger stopped on", () => {
    eligibleBoxes = [{ id: "opt-1", kind: "event", minX: 0, minY: 0, maxX: 1000, maxY: 1080 }];
    stubTouchStack("opt-1");

    stage.dispatchEvent(touchEvent("pointerdown", 480, 270)); // design (960, 540) — inside
    stage.dispatchEvent(touchEvent("pointermove", 540, 270)); // design (1080, 540) — outside
    stage.dispatchEvent(touchEvent("pointerup", 540, 270));

    expect(sent.some((m) => m.kind === "click")).toBe(false);
    expect(confirmTap.targetId).toBeNull();
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 1080, coordY: 540 });
  });

  it("a fast double-tap is two focuses, never a commit", () => {
    eligibleEverywhere("reward-card", "reward");
    stubTouchStack("reward-card");

    tap();
    clock += 50; // well inside any debounce — the second tap of a finger bounce
    tap(485, 272);
    expect(sent.every((m) => m.kind === "hover")).toBe(true);
    expect(confirmTap.targetId).toBe("reward-card");
  });
});

// --- the button ---------------------------------------------------------------------------------------------------

describe("confirm tap — the button", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    __resetConfirmTapForTest();
    __setConfirmSpritesForTest(SPRITES);
  });
  afterEach(__resetConfirmTapForTest);

  async function mountButton() {
    const wrapper = mount(MirrorConfirmButton, { attachTo: document.body });
    await nextTick();
    return wrapper;
  }

  it("renders nothing until a choice is focused, and sits in the authored bottom-right slot", async () => {
    const wrapper = await mountButton();
    expect(wrapper.find('[data-testid="mirror-confirm-button"]').exists()).toBe(false);

    showConfirmTap("opt-1", "event");
    await nextTick();
    const button = wrapper.get('[data-testid="mirror-confirm-button"]');
    // The authored root rect: 200x110, its right edge 40px PAST the viewport edge, 244px up from the bottom. It is
    // placed in the design-space stage, so a widened stage re-anchors it exactly like the game's own HUD.
    expect(button.attributes("style")).toContain("right: -40px");
    expect(button.attributes("style")).toContain("bottom: 244px");
    expect(button.attributes("style")).toContain("width: 200px");
    wrapper.unmount();
  });

  it("paints above the mirror tree normally, and sinks under it while a modal covers the option", async () => {
    const wrapper = await mountButton();
    showConfirmTap("opt-1", "event");
    await nextTick();
    expect(wrapper.get('[data-testid="mirror-confirm-button"]').attributes("style")).toContain("z-index: 10");

    setConfirmBelowOverlay(true);
    await nextTick();
    const style = wrapper.get('[data-testid="mirror-confirm-button"]').attributes("style");
    // Under a modal it must be BOTH invisible-on-top and untappable — it dims with the content it belongs to.
    expect(style).toContain("z-index: -1");
    expect(style).toContain("pointer-events: none");
    wrapper.unmount();
  });

  it("comes back when it is re-shown INSIDE the exit slide (the 'sometimes never reappears' bug)", async () => {
    const wrapper = await mountButton();
    showConfirmTap("opt-1", "event");
    await nextTick();
    await new Promise((r) => requestAnimationFrame(() => r(null))); // the one-frame park→enter defer
    await nextTick();
    const slidIn = () => wrapper.get('[data-testid="mirror-confirm-button"]').attributes("style");
    expect(slidIn()).toContain("translate: 0px 0");

    // Hide, then re-show well inside the 350ms slide-out: the exit is reversed, NOT cancelled half-way — which is
    // what used to leave the button mounted but parked off-screen until a full hide/show cycle completed.
    hideConfirmTap();
    await nextTick();
    expect(slidIn()).toContain("translate: 180px 0");
    showConfirmTap("opt-2", "event");
    await nextTick();
    expect(slidIn()).toContain("translate: 0px 0");
    wrapper.unmount();
  });

  it("commits on RELEASE, like the real button's ButtonReleased action", async () => {
    const commit = vi.fn();
    setConfirmCommit(commit);
    const wrapper = await mountButton();
    showConfirmTap("opt-1", "event");
    await nextTick();

    const button = wrapper.get('[data-testid="mirror-confirm-button"]');
    await button.trigger("pointerdown");
    expect(commit).not.toHaveBeenCalled(); // still held: the press animation runs, nothing is spent yet
    await button.trigger("pointerup");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(confirmTap.targetId).toBeNull();
    wrapper.unmount();
  });

  it("swallows its own pointer events so a tap on it never also reaches the game", async () => {
    const wrapper = await mountButton();
    showConfirmTap("opt-1", "event");
    await nextTick();

    // The mirror's inputCapture listens on the STAGE, i.e. on an ancestor — a bubbling pointerdown from the button
    // would be read as a tap on whatever is behind it.
    const seen: string[] = [];
    document.body.addEventListener("pointerdown", () => seen.push("down"));
    document.body.addEventListener("pointerup", () => seen.push("up"));
    const button = wrapper.get('[data-testid="mirror-confirm-button"]');
    await button.trigger("pointerdown");
    await button.trigger("pointerup");
    expect(seen).toEqual([]);
    wrapper.unmount();
  });
});

// --- stacking ---------------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const box = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });
const xf = (tx: number, ty: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });
const rgba = (r: number, g: number, b: number, a: number) => ({ r, g, b, a, html: "" });

function node(id: string, parentId: string | null, extra: Raw = {}): Raw {
  return { id, parentId, name: id, nodeType: "Godot.Control", visible: true, ...extra };
}

// The shape of every STS2 overlay backstop: a full-stage flat-fill ColorRect.
function backstop(id: string, parentId: string | null, alpha = 0.851): Raw {
  return node(id, parentId, {
    nodeType: "Godot.ColorRect",
    transform: xf(0, 0),
    localRect: box(0, 0, 1920, 1080),
    fillColor: rgba(0, 0, 0, alpha),
    mouseFilter: 2
  });
}

function option(id: string, parentId: string): Raw {
  return node(id, parentId, {
    nodeType: "Godot.NEventOptionButton",
    transform: xf(400, 400),
    localRect: box(0, 0, 200, 80),
    fillColor: rgba(1, 0, 0, 1),
    mouseFilter: 0
  });
}

function fullDelta(state: MirrorState, nodes: Raw[]): void {
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

function rendererHarness(): MirrorRenderer {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return createMirrorRenderer(stage, defs);
}

describe("confirm tap — stacking (coverAbove)", () => {
  let renderer: MirrorRenderer;
  let state: MirrorState;

  beforeEach(() => {
    document.body.innerHTML = "";
    renderer = rendererHarness();
    state = createMirrorState();
  });
  afterEach(() => {
    renderer.dispose();
    mirrorSettings.backstopOcclusion = true;
  });

  // A screen's OWN backstop paints UNDER its content, so an option on that screen is NOT covered — this is what
  // keeps the button above a card-reward / shop-inventory scrim.
  const ownBackstopScene: Raw[] = [
    node("Game", null, { transform: xf(0, 0), localRect: box(0, 0, 1920, 1080) }),
    node("Screen", "Game"),
    backstop("ScreenBackstop", "Screen"),
    option("Option", "Screen")
  ];

  // A modal overlay (map / deck / a card or relic dialog / pause) paints AFTER the room, so it IS over the option.
  const modalScene: Raw[] = [...ownBackstopScene, node("MapScreen", "Game"), backstop("Backstop", "MapScreen")];

  it("is false for a screen's own backstop and true for a modal painted over the option", () => {
    fullDelta(state, ownBackstopScene);
    renderer.setConfirmCoverWatch(true);
    renderer.reconcile(state);
    expect(renderer.coverAbove("Option")).toBe(false);

    fullDelta(state, modalScene);
    renderer.reconcile(state);
    expect(renderer.coverAbove("Option")).toBe(true);
  });

  it("answers the same however the occlusion PERF settings are set — where a button paints is not a perf gate", () => {
    fullDelta(state, modalScene);
    renderer.setConfirmCoverWatch(true);

    // The three overlay backstops compose to 0.724 live, which is BELOW the generic cover floor the occlusion pass
    // uses when its own setting is off — the button must not start floating over the map because of that.
    mirrorSettings.backstopOcclusion = false;
    renderer.reconcile(state);
    expect(renderer.coverAbove("Option")).toBe(true);

    mirrorSettings.backstopOcclusion = true;
    renderer.reconcile(state);
    expect(renderer.coverAbove("Option")).toBe(true);
  });

  it("still answers with occlusion gating disabled entirely (`?occlude=off`)", () => {
    const off = rendererHarness();
    try {
      const offState = createMirrorState();
      fullDelta(offState, modalScene);
      off.setConfirmCoverWatch(true);
      off.reconcile(offState); // the watch arms the pre-filter; this walk populates the candidate set
      expect(off.coverAbove("Option")).toBe(true);
    } finally {
      off.dispose();
    }
  });

  it("is false for a widget that is not painted at all", () => {
    fullDelta(state, modalScene);
    renderer.setConfirmCoverWatch(true);
    renderer.reconcile(state);
    expect(renderer.coverAbove("nope")).toBe(false);
  });
});

// --- 4. THE TRUE BOX (S3/D3) ------------------------------------------------------------------------------------
//
// `confirmTapAt` is handed an already-resolved GAME point, so the box it tests has to be the GAME's — which in
// composing the slot's parent chain, because its streamed matrix is only its own link of it. Reading that matrix as
// a global is the bug class that once mis-boxed every confirm target under a
// placed parent; composing it off the RECORDS alone is a second one, because a record is only written once the
// walk has visited the node. These pin the composition and its one refusal.
describe("confirm tap — the true game-space box", () => {
  function shopNode(
    id: string,
    parentId: string | null,
    x: number,
    y: number,
    over: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      id,
      parentId,
      name: id,
      nodeType: "Godot.Control",
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } },
      localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 60 } },
      visible: true,
      ...over
    };
  }

  function localFull(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        upserts: nodes,
        orderedIds: order,
      })!
    );
  }

  function harness(): { renderer: MirrorRenderer } {
    const stage = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(defs);
    document.body.append(stage, svg);
    return { renderer: createMirrorRenderer(stage, defs) };
  }

  /** root → carpet(300,200) → row(100,50) → slot(40,10), so the slot's GAME origin is (440, 260). */
  function shopScene(state: MirrorState, slotParent = "row"): void {
    localFull(
      state,
      [
        shopNode("root", null, 0, 0),
        shopNode("carpet", "root", 300, 200),
        shopNode("row", "carpet", 100, 50),
        shopNode("slot", slotParent, 40, 10, { nodeType: "Godot.NMerchantRelic" })
      ],
      ["root", "carpet", "row", "slot"]
    );
  }

  function fakeMerchantScene(state: MirrorState): void {
    localFull(
      state,
      [
        shopNode("root", null, 0, 0),
        shopNode("inventory", "root", 300, 200, {
          nodeType: "Godot.NFakeMerchantInventory",
          sceneFilePath: "res://scenes/events/custom/fake_merchant_inventory.tscn"
        }),
        shopNode("relic", "inventory", 40, 10, { nodeType: "Godot.NMerchantRelic" })
      ],
      ["root", "inventory", "relic"]
    );
  }

  it("composes the whole parent chain — the slot answers at its GAME origin, not its local one", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    shopScene(state);
    renderer.reconcile(state);

    // Inside the composed box (440,260)-(540,320).
    expect(renderer.confirmTapAt(450, 270)).toEqual({ id: "slot", kind: "shop" });
    expect(renderer.confirmTapAt(539, 319)).toEqual({ id: "slot", kind: "shop" });
    // Its LOCAL origin (40,10) is not where the box is — reading the streamed matrix as a global would put it there.
    expect(renderer.confirmTapAt(45, 15)).toBeNull();
    // …and neither is the design corner, which is where an identity fallback would put it.
    expect(renderer.confirmTapAt(1, 1)).toBeNull();
  });

  it("classifies a Fake Merchant inventory relic as the ordinary shop confirm target", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    fakeMerchantScene(state);
    renderer.reconcile(state);

    // NFakeMerchantInventory is embedded in an event room, but its NMerchantRelic slot has the same irreversible
    // purchase semantics and true game-space box as a normal shop relic.
    expect(renderer.confirmTapAt(345, 215)).toEqual({ id: "relic", kind: "shop" });
    expect(renderer.confirmTapAt(500, 500)).toBeNull();
  });

  it("suspends a shop-removal confirmation while a visible decision grid is open, then restores it", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    const removalScene = (gridVisible: boolean): Record<string, unknown>[] => [
      shopNode("root", null, 0, 0),
      shopNode("removal", "root", 440, 260, { nodeType: "Godot.NMerchantCardRemoval" }),
      shopNode("Cost", "removal", 0, 0, { localRect: { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } } }),
      shopNode("grid", "root", 0, 0, { nodeType: "Godot.NCardGridSelectionScreen", visible: gridVisible }),
      shopNode("pickerCard", "grid", 600, 300, { nodeType: "Godot.NCard" })
    ];

    localFull(state, removalScene(true), ["root", "removal", "Cost", "grid", "pickerCard"]);
    renderer.reconcile(state);
    expect(renderer.confirmTapTarget("removal")).toBeNull();
    expect(renderer.confirmTapAt(450, 270)).toBeNull();

    localFull(state, removalScene(false), ["root", "removal", "Cost", "grid", "pickerCard"]);
    renderer.reconcile(state);
    expect(renderer.confirmTapTarget("removal")).toBe("shop");
    expect(renderer.confirmTapAt(450, 270)).toEqual({ id: "removal", kind: "shop", retapActivates: true });
  });

  it("suppresses confirms only for an exact visible remove-a-card picker, then restores them", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    const pickerScene = (pickerType: string, visible = true): Record<string, unknown>[] => [
      shopNode("root", null, 0, 0),
      shopNode("removal", "root", 440, 260, { nodeType: "Godot.NMerchantCardRemoval" }),
      shopNode("Cost", "removal", 0, 0, { localRect: { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } } }),
      shopNode("picker", "root", 0, 0, { nodeType: `Godot.${pickerType}`, visible }),
      shopNode("grid", "picker", 0, 0, { nodeType: "Godot.NCardGrid" }),
      shopNode("holder", "grid", 0, 0, { nodeType: "Godot.NGridCardHolder" }),
      shopNode("card", "holder", 600, 300, { nodeType: "Godot.NCard" }),
    ];

    localFull(state, pickerScene("NDeckCardSelectScreen"), ["root", "removal", "Cost", "picker", "grid", "holder", "card"]);
    renderer.reconcile(state);
    expect(renderer.confirmTapTarget("removal")).toBeNull();
    expect(renderer.confirmTapAt(450, 270)).toBeNull();

    localFull(state, pickerScene("NDeckCardSelectScreen", false), ["root", "removal", "Cost", "picker", "grid", "holder", "card"]);
    renderer.reconcile(state);
    expect(renderer.confirmTapAt(450, 270)).toEqual({ id: "removal", kind: "shop", retapActivates: true });

    localFull(state, pickerScene("NDeckUpgradeSelectScreen"), ["root", "removal", "Cost", "picker", "grid", "holder", "card"]);
    renderer.reconcile(state);
    expect(renderer.confirmTapAt(450, 270)).toEqual({ id: "removal", kind: "shop", retapActivates: true });
  });

  it("prefers the slot's own Hitbox child, composed the same way", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    localFull(
      state,
      [
        shopNode("root", null, 0, 0),
        shopNode("carpet", "root", 300, 200),
        shopNode("row", "carpet", 100, 50),
        shopNode("slot", "row", 40, 10, { nodeType: "Godot.NMerchantRelic" }),
        // The game's real hit surface, offset from the origin-anchored slot root — the reason the child is
        // preferred at all.
        shopNode("hit", "slot", 0, 0, {
          name: "Hitbox",
          localRect: { position: { x: -50, y: -30 }, size: { x: 100, y: 60 } }
        })
      ],
      ["root", "carpet", "row", "slot", "hit"]
    );
    renderer.reconcile(state);

    // The Hitbox box is (390,230)-(490,290): centred on the slot origin rather than starting at it.
    expect(renderer.confirmTapAt(395, 235)).toEqual({ id: "slot", kind: "shop" });
    // A point inside the ROOT box but outside the child's is not the game's hit surface.
    expect(renderer.confirmTapAt(535, 315)).toBeNull();
  });

  it("REFUSES an orphan rather than answering at the design origin", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    shopScene(state, "NotStreamedYet");
    renderer.reconcile(state);

    // A node whose chain names a parent the map does not hold has NO global. The identity is the tempting
    // fallback and the wrong one: it would put a live confirm box on the design corner, in the very coordinate
    // space a tap is answered from. Refusing degrades to the ordinary two-step tap, which is safe.
    expect(renderer.confirmTapAt(1, 1)).toBeNull();
    expect(renderer.confirmTapAt(45, 15)).toBeNull();
    expect(renderer.confirmTapAt(450, 270)).toBeNull();
  });

  it("answers a producer ROOT against the design origin, which really is its parent frame", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    localFull(state, [shopNode("slot", null, 40, 10, { nodeType: "Godot.NMerchantRelic" })], ["slot"]);
    renderer.reconcile(state);

    expect(renderer.confirmTapAt(45, 15)).toEqual({ id: "slot", kind: "shop" });
    expect(renderer.confirmTapAt(300, 300)).toBeNull();
  });

  it("composes a root child's matrix into its game-space box", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        upserts: [shopNode("root", null, 0, 0), shopNode("slot", "root", 440, 260, { nodeType: "Godot.NMerchantRelic" })],
        orderedIds: ["root", "slot"]
      })!
    );
    renderer.reconcile(state);

    expect(renderer.confirmTapAt(450, 270)).toEqual({ id: "slot", kind: "shop" });
  });
});
