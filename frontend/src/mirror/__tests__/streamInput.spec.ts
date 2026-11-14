import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MirrorInputMessage } from "@/mirror/mirrorClient";
import {
  createStreamInput,
  type StreamInput,
  type StreamInputClient,
  type StreamInputOptions,
  type StreamGamePoint
} from "@/mirror/streamInput";
import type { ConfirmTapController } from "@/stream-ext/confirmTap";
import type { HeldCardController } from "@/stream-ext/heldCard";
import type { ExtensionFrame, ItemMeta, ItemQuery } from "@godot-scene-web/render-stream-client";
import { createPointerTargetModule } from "@/stream-ext/pointerTargets";
import { RS_GROUP_CARD_REWARD_CARD, RS_GROUP_HAND_HOLDER } from "@/stream-ext/groups";
import { MULTIPLAYER_PLAYER_STATE_SCENE_FILE } from "@/mirror/renderer/interactionPolicy";

const modality = vi.hoisted(() => ({
  current: "unknown" as "unknown" | "touch" | "pointer",
  listeners: new Set<(next: "unknown" | "touch" | "pointer") => void>()
}));
vi.mock("@/inputModality", () => ({
  lastPressModality: () => modality.current,
  onPressModalityChange: (listener: (next: "unknown" | "touch" | "pointer") => void) => {
    modality.listeners.add(listener);
    return () => modality.listeners.delete(listener);
  }
}));

// INP2 — the render-stream input channel. These specs pin the two things the increment owns: the mapping (every
// pointer event goes through INP1's `clientToGame`, so a raised card's tap reaches its game centre, and a letterbox
// bar maps to nothing) and the send path (the SAME coordinate-only MirrorInputMessage the old mirror's inputCapture
// emits). The INP1 pointer-mapping maths itself is covered by GSW's own tests; here the stub client supplies the
// mapped answer, which is exactly the seam the channel must not skip.

let stage: HTMLElement;
let sent: MirrorInputMessage[];
let capture: StreamInput;
let frames: FrameRequestCallback[];

function flushFrames(): void {
  const pending = frames.splice(0);
  for (const cb of pending) cb(0);
}

function pointerEvent(
  type: string,
  init: { clientX: number; clientY: number; button?: number; pointerId?: number; pointerType?: string }
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    button: init.button ?? 0
  }) as Event;
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return event;
}

const touch = (type: string, init: { clientX: number; clientY: number; pointerId?: number }) =>
  pointerEvent(type, { ...init, pointerType: "touch" });

/** A mapping that refuses everything outside the 0..1000 square (the letterbox / off-canvas region). */
const inside = (x: number, y: number) => x >= 0 && y >= 0 && x <= 1000 && y <= 1000;

type StubMap = (clientX: number, clientY: number) => { x: number; y: number; item: number | null } | null;

/**
 * A client whose mapping is an explicit, non-identity function, so a test can tell mapped from raw coordinates. A
 * null answer is a point the mapping refuses (a letterbox bar, off the canvas).
 */
function stubClient(map: StubMap): StreamInputClient {
  return {
    clientToGame: (clientX, clientY): StreamGamePoint | null => {
      const p = map(clientX, clientY);
      return p === null ? null : { point: { x: p.x, y: p.y }, item: p.item, drawn: { x: clientX, y: clientY } };
    }
  };
}

function makeInput(options: {
  map?: StubMap;
  items?: Record<number, Partial<ItemMeta>>;
  parents?: Record<number, number>;
  tapToFocus?: () => boolean;
  clock?: () => number;
  heldCard?: HeldCardController;
  raiseHeldCard?: () => boolean;
  unfocusOnRelease?: () => boolean;
  confirmTap?: ConfirmTapController;
  confirmTapEnabled?: () => boolean;
  confirmButtonReady?: () => boolean;
  resolveTarget?: StreamInputOptions["resolveTarget"];
} = {}): void {
  const map = options.map ?? ((x, y) => ({ x, y, item: null }));
  let client: StreamInputClient | null = stubClient(map);
  const policy = createPointerTargetModule();
  const query = {
    meta: (id: number) => options.items?.[id] ? { id, node: true, groups: [], meta: {}, ...options.items[id] } : null,
    parent: (id: number) => options.parents?.[id] ?? null,
    children: (id: number) => Uint32Array.from(
      Object.entries(options.parents ?? {}).filter(([, parent]) => parent === id).map(([child]) => Number(child))
    )
  } as ItemQuery;
  policy.extension.beforeDraw?.({ query } as never);
  capture = createStreamInput({
    stage,
    getClient: () => client,
    send: (m) => sent.push(m),
    tapToFocus: options.tapToFocus,
    touchPolicy: policy,
    now: options.clock,
    heldCard: options.heldCard,
    raiseHeldCard: options.raiseHeldCard,
    unfocusOnRelease: options.unfocusOnRelease,
    confirmTap: options.confirmTap,
    confirmTapEnabled: options.confirmTapEnabled,
    confirmButtonReady: options.confirmButtonReady,
    ...(options.resolveTarget ? { resolveTarget: options.resolveTarget } : {})
  });
  void client;
}

/** A fake held-card controller: `handCardFor` answers with the same item id when `isHand` says so. */
function heldController(isHand: (item: number | null) => boolean): { controller: HeldCardController; setHeld: ReturnType<typeof vi.fn> } {
  const setHeld = vi.fn();
  return {
    controller: {
      handCardFor: (item) => (isHand(item) ? item : null),
      setHeld,
      dispose: vi.fn()
    } as HeldCardController,
    setHeld
  };
}

/** A fake confirm-tap controller that classifies `item` as `hit`, and records show/hide. */
function confirmController(hit: { id: number; kind: "shop"; retapActivates?: boolean } | null): { controller: ConfirmTapController; show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> } {
  const show = vi.fn();
  const hide = vi.fn();
  return {
    controller: {
      classify: () => hit,
      show,
      hide,
      dispose: vi.fn(),
      commit: () => { hide(); return true; },
      state: { targetId: null, kind: null, rect: null, belowOverlay: false }
    } as ConfirmTapController,
    show,
    hide
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  stage = document.createElement("div");
  document.body.appendChild(stage);
  sent = [];
  modality.current = "unknown";
  modality.listeners.clear();
});

afterEach(() => {
  capture?.dispose();
  vi.unstubAllGlobals();
});

describe("createStreamInput — mapping + send path", () => {
  it("maps a hover through clientToGame and sends the GAME-space coordinate (never the raw client point)", () => {
    // 2x scale proves the channel sends what clientToGame returned, not the event's clientX/clientY.
    makeInput({ map: (x, y) => ({ x: x * 2, y: y * 2, item: null }) });
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 480, clientY: 270 }));
    flushFrames();
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]);
  });

  it("coalesces hover to one send per animation frame", () => {
    makeInput({ map: (x, y) => ({ x, y, item: null }) });
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 10, clientY: 10 }));
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 20, clientY: 20 }));
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 30, clientY: 30 }));
    expect(sent).toEqual([]);
    flushFrames();
    expect(sent).toEqual([{ kind: "hover", coordX: 30, coordY: 30 }]);
  });

  it("a mouse press+release sends the press edge then the release edge at mapped coordinates", () => {
    makeInput({ map: (x, y) => ({ x: x * 2, y: y * 2, item: null }) });
    stage.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 50 }));
    stage.dispatchEvent(pointerEvent("pointerup", { clientX: 100, clientY: 50 }));
    expect(sent).toEqual([
      { kind: "click", button: "left", pressed: true, coordX: 200, coordY: 100 },
      { kind: "click", button: "left", pressed: false, coordX: 200, coordY: 100 }
    ]);
  });

  it("flushes a pending move hover BEFORE the press edge (a fast move→down in one frame)", () => {
    makeInput({ map: (x, y) => ({ x: x * 2, y: y * 2, item: null }) });
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 50 })); // hover pending on rAF
    stage.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 50 })); // flush + press
    stage.dispatchEvent(pointerEvent("pointerup", { clientX: 100, clientY: 50 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 200, coordY: 100 },
      { kind: "click", button: "left", pressed: true, coordX: 200, coordY: 100 },
      { kind: "click", button: "left", pressed: false, coordX: 200, coordY: 100 }
    ]);
  });

  it("a mouse drag sends press, the coalesced hover stream, then release", () => {
    makeInput({ map: (x, y) => ({ x: x * 2, y: y * 2, item: null }) });
    stage.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 50, clientY: 50 }));
    flushFrames();
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 80, clientY: 80 }));
    flushFrames();
    stage.dispatchEvent(pointerEvent("pointerup", { clientX: 80, clientY: 80 }));
    expect(sent).toEqual([
      { kind: "click", button: "left", pressed: true, coordX: 0, coordY: 0 },
      { kind: "hover", coordX: 100, coordY: 100 },
      { kind: "hover", coordX: 160, coordY: 160 },
      { kind: "click", button: "left", pressed: false, coordX: 160, coordY: 160 }
    ]);
  });

  it("a touch tap hovers the point, then sends a single full click when tapToFocus is off", () => {
    // The hover first: a hover-first widget (character select) ignores a press the cursor never reached, and a
    // finger, unlike a mouse, never travelled there.
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), tapToFocus: () => false });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 640, coordY: 360 },
      { kind: "click", button: "left", coordX: 640, coordY: 360 }
    ]);
  });

  it("with tapToFocus on, a touch tap arms the hit item (hover) and a later re-tap of it commits", () => {
    let clock = 0;
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), items: { 7: { class: "NCard" } }, tapToFocus: () => true, clock: () => clock });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]);

    clock = 250; // past TAP_ARM_DEBOUNCE_MS: this is a deliberate re-tap, not a finger bounce
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 640, coordY: 360 },
      { kind: "hover", coordX: 640, coordY: 360 },
      { kind: "click", button: "left", coordX: 640, coordY: 360 }
    ]);
  });

  it("with tapToFocus on, a re-tap of the armed item inside the debounce window is swallowed", () => {
    let clock = 0;
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), items: { 7: { class: "NCard" } }, tapToFocus: () => true, clock: () => clock });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    clock = 50; // still inside the 200ms debounce
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]);
  });

  it("a touch drag past the slop sends hover + press at the start, the hover stream, then release", () => {
    makeInput({ map: (x, y) => ({ x, y, item: 7 }) });
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 100 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 200, clientY: 100 })); // past 8px slop → press
    flushFrames();
    expect(sent.slice(0, 3)).toEqual([
      { kind: "hover", coordX: 100, coordY: 100 },
      { kind: "click", button: "left", pressed: true, coordX: 100, coordY: 100 },
      { kind: "hover", coordX: 200, coordY: 100 }
    ]);
    stage.dispatchEvent(touch("pointerup", { clientX: 200, clientY: 100 }));
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", pressed: false, coordX: 200, coordY: 100 });
  });

  it("right-click (contextmenu) is a full right click at the mapped point, and the browser menu is suppressed", () => {
    makeInput({ map: (x, y) => ({ x: x * 2, y, item: null }) });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 400, clientY: 200 });
    stage.dispatchEvent(event);
    expect(sent).toEqual([{ kind: "click", button: "right", coordX: 800, coordY: 200 }]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("a wheel tick is a full wheel click at the mapped point", () => {
    makeInput({ map: (x, y) => ({ x, y, item: null }) });
    stage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 100, clientY: 100, deltaY: -120 }));
    expect(sent).toEqual([{ kind: "click", button: "wheel-up", coordX: 100, coordY: 100 }]);
    stage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 100, clientY: 100, deltaY: 120 }));
    expect(sent.at(-1)).toEqual({ kind: "click", button: "wheel-down", coordX: 100, coordY: 100 });
  });
});

describe("createStreamInput — mapping cannot be skipped", () => {
  it("sends the OVERRIDE-inverted game point for a tap on a raised item (the INP1 inverse)", () => {
    // A raised card: the drawn centre is (960, 540), but the game has it 119px lower — clientToGame inverts the
    // hit item's override. The channel must send the INVERTED point; sending the raw client point is the sabotage.
    makeInput({ map: (x, y) => ({ x, y: y + 119, item: 7 }), tapToFocus: () => false });
    stage.dispatchEvent(touch("pointerdown", { clientX: 960, clientY: 540 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 960, clientY: 540 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 659 },
      { kind: "click", button: "left", coordX: 960, coordY: 659 }
    ]);
    expect(sent[1].coordY).not.toBe(540);
  });

  it("sends nothing for a point the mapping refuses (a letterbox bar)", () => {
    const client = {
      clientToGame: () => null
    };
    capture = createStreamInput({
      stage,
      getClient: () => client,
      send: (m) => sent.push(m)
    });
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 5, clientY: 5 }));
    stage.dispatchEvent(pointerEvent("pointerdown", { clientX: 5, clientY: 5 }));
    stage.dispatchEvent(pointerEvent("pointerup", { clientX: 5, clientY: 5 }));
    flushFrames();
    expect(sent).toEqual([]);
  });

  it("sends nothing while no client is mounted (a view-only stage)", () => {
    capture = createStreamInput({
      stage,
      getClient: () => null,
      send: (m) => sent.push(m)
    });
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(pointerEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(pointerEvent("pointerup", { clientX: 480, clientY: 270 }));
    flushFrames();
    expect(sent).toEqual([]);
  });
});

describe("createStreamInput — touch target parity", () => {
  function tap(x = 640, y = 360): void {
    stage.dispatchEvent(touch("pointerdown", { clientX: x, clientY: y }));
    stage.dispatchEvent(touch("pointerup", { clientX: x, clientY: y }));
  }

  it.each([
    ["card", { script: "res://ui/cards/NCard.cs" }],
    ["reward row", { class: "MegaCrit.Sts2.Core.Nodes.Rewards.NRewardButton" }],
    ["reward card", { groups: [RS_GROUP_CARD_REWARD_CARD] }],
    ["hand holder", { groups: [RS_GROUP_HAND_HOLDER] }]
  ] satisfies [string, Partial<ItemMeta>][])("focuses a %s first, then clicks its owning widget across child hits", (_name, meta) => {
    let clock = 0;
    makeInput({
      map: (x, y) => ({ x, y, item: x < 650 ? 8 : 9 }),
      items: { 7: meta, 8: { class: "Control" }, 9: { class: "Label" } },
      parents: { 8: 7, 9: 7 }, tapToFocus: () => true, clock: () => clock
    });
    tap();
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]);
    clock = 250;
    tap(660);
    expect(sent.slice(1)).toEqual([
      { kind: "hover", coordX: 660, coordY: 360 },
      { kind: "click", button: "left", coordX: 660, coordY: 360 }
    ]);
  });

  it.each([
    ["Proceed", { class: "NProceedButton", scene: "res://scenes/ui/proceed_button.tscn" }],
    ["event Proceed", { class: "NEventOptionButton", scene: "res://scenes/ui/proceed_button.tscn" }],
    ["relic", { script: "res://ui/NRelic.cs" }],
    ["potion", { class: "NPotionHolder" }],
    ["map button", { class: "NMapButton" }],
    ["deck back button", { class: "NBackButton" }],
    ["map node", { class: "NMapPoint" }],
    ["treasure chest", { class: "NTreasureRoomChest" }],
    ["unclassified item", {}]
  ] satisfies [string, Partial<ItemMeta>][])("clicks %s on the first tap with focus-first enabled", (_name, meta) => {
    makeInput({ map: (x, y) => ({ x, y, item: 8 }), items: { 7: meta }, parents: { 8: 7 }, tapToFocus: () => true });
    tap();
    expect(sent).toEqual([
      { kind: "hover", coordX: 640, coordY: 360 },
      { kind: "click", button: "left", coordX: 640, coordY: 360 }
    ]);
  });

  it("focuses a remote player's HP label first and clicks on a re-tap after debounce", () => {
    let clock = 0;
    const scene = MULTIPLAYER_PLAYER_STATE_SCENE_FILE;
    makeInput({
      map: (x, y) => ({ x, y, item: 8 }),
      items: { 7: { class: "Control", scene, path: "." }, 8: { class: "Label", scene, path: "HP/Label" } },
      parents: { 8: 7 }, tapToFocus: () => true, clock: () => clock
    });
    tap();
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]);
    clock = 250;
    tap();
    expect(sent.slice(1)).toEqual([
      { kind: "hover", coordX: 640, coordY: 360 },
      { kind: "click", button: "left", coordX: 640, coordY: 360 }
    ]);
  });

  it("focuses the reward card beside its holder's Hitbox before clicking", () => {
    let clock = 0;
    makeInput({
      map: (x, y) => ({ x, y, item: 8 }),
      items: { 7: { groups: [RS_GROUP_CARD_REWARD_CARD] }, 8: { class: "NClickableControl" } },
      parents: { 7: 6, 8: 6 }, tapToFocus: () => true, clock: () => clock
    });
    tap();
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]);
    clock = 250;
    tap();
    expect(sent.filter((m) => m.kind === "click")).toHaveLength(1);
  });

  it("clicks End Turn first and then parks at the mapped stage centre without a target stamp", () => {
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({ left: 20, top: 10, width: 1000, height: 500 } as DOMRect);
    makeInput({
      map: (x, y) => ({ x: x * 2, y: y * 2, item: 8 }),
      items: { 7: { scene: "res://scenes/combat/end_turn_button.tscn" } }, parents: { 8: 7 },
      tapToFocus: () => true,
      resolveTarget: () => ({ key: 8, identity: { item: 8, instanceId: "123" }, local: { x: 1, y: 2 } })
    });
    tap();
    expect(sent).toEqual([
      { kind: "hover", coordX: 1280, coordY: 720, targetInstance: "123", localX: 1, localY: 2 },
      { kind: "click", button: "left", coordX: 1280, coordY: 720, targetInstance: "123", localX: 1, localY: 2 },
      { kind: "hover", coordX: 1040, coordY: 520 }
    ]);
  });

  it("clicks an already-hovered card immediately, bypassing the arm and debounce", () => {
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), items: { 7: { class: "NCard" } }, tapToFocus: () => true, clock: () => 0 });
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 640, clientY: 360 }));
    flushFrames();
    sent.length = 0;
    tap();
    expect(sent).toEqual([
      { kind: "hover", coordX: 640, coordY: 360 },
      { kind: "click", button: "left", coordX: 640, coordY: 360 }
    ]);
  });

  it("keeps a committed card ready for the next tap without another arm", () => {
    let clock = 0;
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), items: { 7: { class: "NCard" } }, tapToFocus: () => true, clock: () => clock });
    tap();
    clock = 250;
    tap();
    sent.length = 0;
    tap();
    expect(sent).toEqual([
      { kind: "hover", coordX: 640, coordY: 360 },
      { kind: "click", button: "left", coordX: 640, coordY: 360 }
    ]);
  });
});

describe("createStreamInput — reward-list auto-focus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function rewards() {
    const policy = createPointerTargetModule();
    let rows = [20, 30];
    let visible = true;
    let seq = 0;
    const items: ItemMeta[] = [
      { id: 10, node: true, class: "NRewardsScreen", groups: [], meta: {} },
      ...rows.flatMap((id) => [
        { id, node: true, class: "NRewardButton", groups: [], meta: {} },
        { id: id + 1, node: true, class: "Control", path: "Hitbox", groups: [], meta: {} }
      ])
    ];
    const rect = (id: number) => {
      const index = rows.indexOf(id - 1);
      return index < 0 ? null : { x: 100, y: 200 + index * 100, w: 200, h: 40 };
    };
    const hitTest = (x: number, y: number) => rows.map((id) => id + 1).find((id) => {
      const r = rect(id)!;
      return visible && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    }) ?? null;
    const query: ItemQuery = {
      meta: (id) => items.find((item) => item.id === id) ?? null,
      parent: (id) => id === 10 ? null : id % 10 === 0 ? 10 : id - 1,
      children: (id) => Uint32Array.from(id === 10 ? rows : rows.includes(id) ? [id + 1] : []),
      rect, subtreeRect: () => null, visible: () => visible,
      transform: () => [1, 0, 0, 1, 0, 0], hitTest
    };
    policy.extension.onItemMeta!({ form: "full", items });
    capture = createStreamInput({
      stage,
      getClient: () => stubClient((x, y) => ({ x: x / 2, y: y / 2, item: hitTest(x / 2, y / 2) })),
      send: (message) => sent.push(message), tapToFocus: () => true, touchPolicy: policy, now: () => Date.now()
    });
    const draw = (nextRows = rows, nextVisible = visible) => {
      rows = nextRows;
      visible = nextVisible;
      policy.extension.beforeDraw!({ seq: ++seq, query, overrides: { effective: () => [1, 0, 0, 1, 0, 0] } } as unknown as ExtensionFrame);
    };
    return { draw };
  }

  function tap(y = 440): void {
    stage.dispatchEvent(touch("pointerdown", { clientX: 400, clientY: y }));
    stage.dispatchEvent(touch("pointerup", { clientX: 400, clientY: y }));
  }

  it("readies the first row on entry and the replacement after a claim for one-tap real clicks", () => {
    modality.current = "touch";
    const list = rewards();
    list.draw();
    expect(sent).toEqual([{ kind: "hover", coordX: 200, coordY: 220 }]);
    tap();
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 200, coordY: 220 });
    sent.length = 0;
    list.draw([30]);
    expect(sent).toEqual([{ kind: "hover", coordX: 200, coordY: 220 }]);
    tap();
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 200, coordY: 220 });
    expect(sent.filter((message) => message.kind === "click")).toHaveLength(1);
  });

  it("retains focus-first and debounce for an unfocused row, canceling the pending correction", () => {
    modality.current = "touch";
    const list = rewards();
    list.draw();
    sent.length = 0;
    tap(640);
    expect(sent).toEqual([{ kind: "hover", coordX: 200, coordY: 320 }]);
    vi.advanceTimersByTime(800);
    expect(sent).toHaveLength(1); // the coordinator must not steal focus back
    tap(640);
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 200, coordY: 320 });
  });

  it("does not auto-focus merely because pointer mode becomes touch on an unchanged list", () => {
    modality.current = "pointer";
    const list = rewards();
    list.draw();
    modality.current = "touch";
    list.draw();
    expect(sent).toEqual([]);
    tap();
    expect(sent).toEqual([{ kind: "hover", coordX: 200, coordY: 220 }]);
  });

  it("keeps a stationary hovered row ready after the bounded settle checks finish", () => {
    modality.current = "touch";
    const list = rewards();
    list.draw();
    vi.advanceTimersByTime(5000);
    sent.length = 0;
    tap();
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 200, coordY: 220 });
  });

  it("drops readiness on a pointer transition and focus elsewhere", () => {
    modality.current = "touch";
    const list = rewards();
    list.draw();
    modality.current = "pointer";
    for (const listener of modality.listeners) listener("pointer");
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 900, clientY: 900 }));
    stage.dispatchEvent(pointerEvent("pointerdown", { clientX: 900, clientY: 900 }));
    stage.dispatchEvent(pointerEvent("pointerup", { clientX: 900, clientY: 900 }));
    sent.length = 0;
    modality.current = "touch";
    tap();
    expect(sent).toEqual([{ kind: "hover", coordX: 200, coordY: 220 }]);
  });

  it("retires readiness when the reward screen closes", () => {
    modality.current = "touch";
    const list = rewards();
    list.draw();
    list.draw([], false);
    modality.current = "pointer";
    list.draw([20, 30], true);
    modality.current = "touch";
    sent.length = 0;
    tap();
    expect(sent).toEqual([{ kind: "hover", coordX: 200, coordY: 220 }]);
  });

  it("unsubscribes snapshots and modality changes and cancels settle work on disposal", () => {
    modality.current = "touch";
    const list = rewards();
    list.draw();
    capture.dispose();
    expect(modality.listeners.size).toBe(0);
    sent.length = 0;
    list.draw([30]);
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });
});

describe("createStreamInput — held-card lift (raiseHeldCard / unfocusOnRelease)", () => {
  it("a still hold on a hand card becomes a peek: focus + lift, no play on release", () => {
    vi.useFakeTimers();
    try {
      const held = heldController((item) => item === 7);
      makeInput({ map: (x, y) => ({ x, y, item: 7 }), heldCard: held.controller });
      stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 900 }));
      expect(held.setHeld).not.toHaveBeenCalled(); // still below PEEK_MS

      vi.advanceTimersByTime(100);
      expect(held.setHeld).toHaveBeenCalledWith(7, 900, "peek");
      expect(sent).toContainEqual({ kind: "hover", coordX: 640, coordY: 900 });

      stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 900 }));
      expect(held.setHeld).toHaveBeenLastCalledWith(null, 900, "drag"); // lift cleared
      expect(sent.filter((m) => m.kind === "click")).toEqual([]); // a peek never plays the card
    } finally {
      vi.useRealTimers();
    }
  });

  it("a peek release un-focuses by re-hovering the seat centre only when unfocusOnRelease is on", () => {
    vi.useFakeTimers();
    try {
      const held = heldController((item) => item === 7);
      makeInput({
        map: (x, y) => ({ x, y, item: 7 }),
        heldCard: held.controller,
        unfocusOnRelease: () => false
      });
      stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 900 }));
      vi.advanceTimersByTime(100);
      const before = sent.length;
      stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 900 }));
      // No extra hover beyond the peek's own focus hover (off ⇒ no un-focus).
      expect(sent.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not peek a hand card while raiseHeldCard is off", () => {
    vi.useFakeTimers();
    try {
      const held = heldController((item) => item === 7);
      makeInput({ map: (x, y) => ({ x, y, item: 7 }), heldCard: held.controller, raiseHeldCard: () => false });
      stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 900 }));
      vi.advanceTimersByTime(100);
      expect(held.setHeld).not.toHaveBeenCalled();
      stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 900 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a touch drag on a hand card lifts it above the fingertip, then clears on release", () => {
    const held = heldController((item) => item === 7);
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), heldCard: held.controller });
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 900 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 200, clientY: 300 })); // past the slop → drag
    flushFrames();
    expect(held.setHeld).toHaveBeenCalledWith(7, 300, "drag");
    stage.dispatchEvent(touch("pointerup", { clientX: 200, clientY: 300 }));
    expect(held.setHeld).toHaveBeenLastCalledWith(null, 0, "drag");
  });

  it("does not lift a touch drag on a non-hand card", () => {
    const held = heldController(() => false);
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), heldCard: held.controller });
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 900 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 200, clientY: 300 }));
    flushFrames();
    expect(held.setHeld).not.toHaveBeenCalled();
    stage.dispatchEvent(touch("pointerup", { clientX: 200, clientY: 300 }));
  });
});

describe("createStreamInput — confirm tap", () => {
  it("a tap on a confirm-eligible widget focuses + shows the button, and commit re-sends the click", () => {
    const confirm = confirmController({ id: 8, kind: "shop" });
    makeInput({
      map: (x, y) => ({ x, y, item: 8 }),
      confirmTap: confirm.controller,
      confirmTapEnabled: () => true,
      tapToFocus: () => true
    });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]); // focus only — no bare tap
    expect(confirm.show).toHaveBeenCalledWith(8, "shop");

    capture.commitConfirm();
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 640, coordY: 360 });
    expect(confirm.hide).toHaveBeenCalled();
  });

  it("a tap outside a confirm-eligible widget is a normal tap even with confirmTap on", () => {
    const confirm = confirmController(null);
    makeInput({
      map: (x, y) => ({ x, y, item: 5 }),
      confirmTap: confirm.controller,
      confirmTapEnabled: () => true,
      tapToFocus: () => false
    });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 640, coordY: 360 },
      { kind: "click", button: "left", coordX: 640, coordY: 360 }
    ]);
    expect(confirm.show).not.toHaveBeenCalled();
  });

  it("a confirm-eligible tap is a normal tap when confirmTap is off", () => {
    const confirm = confirmController({ id: 8, kind: "shop" });
    makeInput({
      map: (x, y) => ({ x, y, item: 8 }),
      confirmTap: confirm.controller,
      confirmTapEnabled: () => false,
      tapToFocus: () => false
    });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 640, coordY: 360 },
      { kind: "click", button: "left", coordX: 640, coordY: 360 }
    ]);
    expect(confirm.show).not.toHaveBeenCalled();
  });

  it("commitConfirm with no button up sends nothing", () => {
    makeInput({ map: (x, y) => ({ x, y, item: null }) });
    capture.commitConfirm();
    expect(sent).toEqual([]);
  });
});

describe("createStreamInput — a press that went out is always released", () => {
  it("a mouse press inside released outside the picture sends the release at the last mapped point", () => {
    makeInput({ map: (x, y) => (inside(x, y) ? { x: x * 2, y: y * 2, item: null } : null) });
    stage.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 100 }));
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 400, clientY: 300 }));
    flushFrames();
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 1200, clientY: 300 })); // off the picture
    flushFrames();
    stage.dispatchEvent(pointerEvent("pointerup", { clientX: 1300, clientY: 300 })); // capture still delivers it
    expect(sent).toEqual([
      { kind: "click", button: "left", pressed: true, coordX: 200, coordY: 200 },
      { kind: "hover", coordX: 800, coordY: 600 },
      { kind: "click", button: "left", pressed: false, coordX: 800, coordY: 600 }
    ]);
  });

  it("a mouse press released outside with no motion releases at the press point", () => {
    makeInput({ map: (x, y) => (inside(x, y) ? { x, y, item: null } : null) });
    stage.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 100 }));
    stage.dispatchEvent(pointerEvent("pointerup", { clientX: -50, clientY: 100 }));
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", pressed: false, coordX: 100, coordY: 100 });
  });

  it("a touch drag that slides off the picture stays a drag and releases at the last mapped point", () => {
    const held = heldController((item) => item === 7);
    makeInput({ map: (x, y) => (inside(x, y) ? { x, y, item: 7 } : null), heldCard: held.controller });
    stage.dispatchEvent(touch("pointerdown", { clientX: 990, clientY: 500 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 995, clientY: 500 })); // inside, below the slop
    stage.dispatchEvent(touch("pointermove", { clientX: 1100, clientY: 480 })); // past the slop, already off
    flushFrames();
    // The slop is measured on the raw travel, so the press goes out (at the start) though the move maps nowhere.
    expect(sent).toEqual([
      { kind: "hover", coordX: 990, coordY: 500 },
      { kind: "click", button: "left", pressed: true, coordX: 990, coordY: 500 }
    ]);
    stage.dispatchEvent(touch("pointermove", { clientX: 900, clientY: 450 })); // back on
    flushFrames();
    expect(held.setHeld).toHaveBeenLastCalledWith(7, 450, "drag");
    stage.dispatchEvent(touch("pointermove", { clientX: 1100, clientY: 400 })); // off again
    flushFrames();
    stage.dispatchEvent(touch("pointerup", { clientX: 1100, clientY: 400 }));
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", pressed: false, coordX: 900, coordY: 450 });
    expect(held.setHeld).toHaveBeenLastCalledWith(null, 0, "drag");
  });

  it("dispose releases a held mouse press", () => {
    makeInput({ map: (x, y) => ({ x, y, item: null }) });
    stage.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 100 }));
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 150, clientY: 120 }));
    flushFrames();
    capture.dispose();
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", pressed: false, coordX: 150, coordY: 120 });
    const count = sent.length;
    capture.dispose(); // idempotent: nothing held any more
    expect(sent).toHaveLength(count);
  });

  it("dispose releases a held touch drag, but owes nothing for a touch that never pressed", () => {
    makeInput({ map: (x, y) => ({ x, y, item: 7 }) });
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 100 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 200, clientY: 100 }));
    flushFrames();
    capture.dispose();
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", pressed: false, coordX: 200, coordY: 100 });

    sent = [];
    makeInput({ map: (x, y) => ({ x, y, item: 7 }) });
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 100 })); // a potential tap: nothing sent
    capture.dispose();
    expect(sent).toEqual([]);
  });

  it("a pointercancel after motion releases at the last mapped point when its own point maps nowhere", () => {
    makeInput({ map: (x, y) => (inside(x, y) ? { x, y, item: null } : null) });
    stage.dispatchEvent(pointerEvent("pointerdown", { clientX: 100, clientY: 100 }));
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 300, clientY: 100 }));
    flushFrames();
    stage.dispatchEvent(pointerEvent("pointercancel", { clientX: 5000, clientY: 100 }));
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", pressed: false, coordX: 300, coordY: 100 });
  });
});

describe("createStreamInput — moves are mapped once per frame", () => {
  it("maps only the newest move of a frame (no per-event clientToGame)", () => {
    const calls: Array<[number, number]> = [];
    makeInput({
      map: (x, y) => {
        calls.push([x, y]);
        return { x, y, item: null };
      }
    });
    // C4a: GSW maps at its own flush now (M1), and the capture's very FIRST frame also maps its first sample once
    // (the first `relative` needs a base: docs/input.md "When `map` is called"). Every later frame maps one point.
    stage.dispatchEvent(pointerEvent("pointermove", { clientX: 0, clientY: 10 }));
    flushFrames();
    calls.length = 0;
    sent.length = 0;
    for (let i = 1; i <= 5; i++) stage.dispatchEvent(pointerEvent("pointermove", { clientX: i * 10, clientY: 10 }));
    expect(calls).toEqual([]);
    flushFrames();
    expect(calls).toEqual([[50, 10]]);
    expect(sent).toEqual([{ kind: "hover", coordX: 50, coordY: 10 }]);
  });

  it("a gesture hook reads the item GSW just mapped at an edge: one clientToGame per touch-down", () => {
    const calls: Array<[number, number]> = [];
    const held = heldController((item) => item === 7);
    makeInput({
      map: (x, y) => {
        calls.push([x, y]);
        return { x, y, item: 7 };
      },
      heldCard: held.controller
    });
    stage.dispatchEvent(touch("pointerdown", { clientX: 300, clientY: 900 }));
    expect(calls).toEqual([[300, 900]]); // GSW's own map of the down point; the touch-down hook reused it
  });

  it("no mapped answer outlives its event: a later press at the same point reads the picture again", () => {
    let item: number | null = 7;
    const items: Array<number | null> = [];
    const confirm = confirmController(null);
    const classify = vi.fn((hit: number) => {
      items.push(hit);
      return null;
    });
    makeInput({
      map: (x, y) => ({ x, y, item }),
      tapToFocus: () => false,
      confirmTap: { ...confirm.controller, classify },
      confirmTapEnabled: () => true
    });
    stage.dispatchEvent(touch("pointerdown", { clientX: 300, clientY: 300 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 300, clientY: 300 }));
    item = 8; // the picture changed under a still finger
    stage.dispatchEvent(touch("pointerdown", { clientX: 300, clientY: 300 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 300, clientY: 300 }));
    expect(items).toEqual([7, 8]);
  });

  it("a touch drag's lift hook runs once per frame with the frame's newest point (M1's per-record drag-move)", () => {
    const held = heldController((item) => item === 7);
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), heldCard: held.controller });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 900 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 640, clientY: 880 })); // past the slop: the drag starts
    flushFrames();
    held.setHeld.mockClear();
    for (const y of [860, 840, 820]) stage.dispatchEvent(touch("pointermove", { clientX: 640, clientY: y }));
    flushFrames();
    expect(held.setHeld.mock.calls).toEqual([[7, 820, "drag"]]);
  });

  it("a stray finger's motion during a drag never moves the cursor", () => {
    makeInput({ map: (x, y) => ({ x, y, item: 7 }) });
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 200, clientY: 100, pointerId: 1 })); // drag
    flushFrames();
    const before = sent.length;
    stage.dispatchEvent(touch("pointerdown", { clientX: 600, clientY: 600, pointerId: 2 })); // stray: a drag is on
    stage.dispatchEvent(touch("pointermove", { clientX: 650, clientY: 650, pointerId: 2 }));
    flushFrames();
    expect(sent).toHaveLength(before);
  });
});

describe("createStreamInput — two-finger scroll", () => {
  it("vertical two-finger drift becomes wheel ticks at the latch centroid (natural direction), never a click", () => {
    makeInput({ map: (x, y) => ({ x: x * 2, y: y * 2, item: 7 }), tapToFocus: () => false });
    // A 540-px-tall stage: 2 presentation px per client px, so the 56-px wheel step is 28 client px.
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 200, pointerId: 1 }));
    stage.dispatchEvent(touch("pointerdown", { clientX: 200, clientY: 200, pointerId: 2 }));
    // Fingers DOWN 30 client px each: 60 presentation px of centroid drift ⇒ one wheel-up, 4 px carried.
    stage.dispatchEvent(touch("pointermove", { clientX: 100, clientY: 230, pointerId: 1 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 200, clientY: 230, pointerId: 2 }));
    flushFrames();
    expect(sent).toEqual([{ kind: "click", button: "wheel-up", coordX: 300, coordY: 400 }]);
    // Fingers UP 60 client px (120 presentation px from 4 carried): two wheel-downs.
    stage.dispatchEvent(touch("pointermove", { clientX: 100, clientY: 170, pointerId: 1 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 200, clientY: 170, pointerId: 2 }));
    flushFrames();
    expect(sent.slice(1)).toEqual([
      { kind: "click", button: "wheel-down", coordX: 300, coordY: 400 },
      { kind: "click", button: "wheel-down", coordX: 300, coordY: 400 }
    ]);
    stage.dispatchEvent(touch("pointerup", { clientX: 100, clientY: 170, pointerId: 1 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 200, clientY: 400, pointerId: 2 })); // one finger left: inert
    stage.dispatchEvent(touch("pointerup", { clientX: 200, clientY: 400, pointerId: 2 }));
    flushFrames();
    expect(sent).toHaveLength(3);
    expect(sent.every((m) => m.kind === "click" && (m.button === "wheel-up" || m.button === "wheel-down"))).toBe(true);
  });

  it("a still two-finger touch sends nothing (the first finger's tap is cancelled)", () => {
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), tapToFocus: () => false });
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 200, pointerId: 1 }));
    stage.dispatchEvent(touch("pointerdown", { clientX: 200, clientY: 200, pointerId: 2 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 100, clientY: 200, pointerId: 1 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 200, clientY: 200, pointerId: 2 }));
    flushFrames();
    expect(sent).toEqual([]);
    // And the channel is free again: a following tap is a normal tap.
    stage.dispatchEvent(touch("pointerdown", { clientX: 300, clientY: 300, pointerId: 3 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 300, clientY: 300, pointerId: 3 }));
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 300, coordY: 300 });
  });

  it("small two-finger jitter below the scroll threshold sends no tick", () => {
    makeInput({ map: (x, y) => ({ x, y, item: 7 }) });
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 200, pointerId: 1 }));
    stage.dispatchEvent(touch("pointerdown", { clientX: 200, clientY: 200, pointerId: 2 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 100, clientY: 210, pointerId: 1 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 200, clientY: 210, pointerId: 2 }));
    expect(sent).toEqual([]);
  });
});

describe("createStreamInput — touch hovers before every press edge", () => {
  it("a tap on clear colour with tapToFocus on hovers, then commits", () => {
    makeInput({ map: (x, y) => ({ x, y, item: null }), tapToFocus: () => true });
    stage.dispatchEvent(touch("pointerdown", { clientX: 10, clientY: 20 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 10, clientY: 20 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 10, coordY: 20 },
      { kind: "click", button: "left", coordX: 10, coordY: 20 }
    ]);
  });
});

describe("createStreamInput — confirm button dismissal", () => {
  it("a later tap elsewhere hides the confirm button (and is a normal tap)", () => {
    let hit: { id: number; kind: "shop" } | null = { id: 8, kind: "shop" };
    const confirm = confirmController(null);
    confirm.controller.classify = () => hit;
    makeInput({
      map: (x, y) => ({ x, y, item: 8 }),
      confirmTap: confirm.controller,
      confirmTapEnabled: () => true,
      tapToFocus: () => false
    });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(confirm.show).toHaveBeenCalledWith(8, "shop");
    expect(confirm.hide).not.toHaveBeenCalled();

    hit = null; // the next tap lands on an ordinary widget
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 100 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 100, clientY: 100 }));
    expect(confirm.hide).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 100, coordY: 100 });
    // The commit no longer fires: the button it belonged to is gone.
    const count = sent.length;
    capture.commitConfirm();
    expect(sent).toHaveLength(count);
  });

  it("a mouse click elsewhere hides the confirm button", () => {
    const confirm = confirmController({ id: 8, kind: "shop" });
    makeInput({ map: (x, y) => ({ x, y, item: 8 }), confirmTap: confirm.controller, confirmTapEnabled: () => true });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(confirm.show).toHaveBeenCalled();
    stage.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 }));
    expect(confirm.hide).toHaveBeenCalledTimes(1);
    stage.dispatchEvent(pointerEvent("pointerup", { clientX: 10, clientY: 10 }));
  });

  it("re-tapping the same confirm widget keeps the button up for it", () => {
    const confirm = confirmController({ id: 8, kind: "shop" });
    makeInput({ map: (x, y) => ({ x, y, item: 8 }), confirmTap: confirm.controller, confirmTapEnabled: () => true });
    for (let i = 0; i < 2; i++) {
      stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
      stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    }
    expect(confirm.show).toHaveBeenCalledTimes(2);
    expect(confirm.show).toHaveBeenLastCalledWith(8, "shop");
    capture.commitConfirm();
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 640, coordY: 360 });
  });
});

describe("createStreamInput — held-card lift follows raiseHeldCard live", () => {
  it("a touch drag on a hand card does not lift while raiseHeldCard is off", () => {
    const held = heldController((item) => item === 7);
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), heldCard: held.controller, raiseHeldCard: () => false });
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 900 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 200, clientY: 300 }));
    flushFrames();
    expect(held.setHeld).not.toHaveBeenCalledWith(7, expect.anything(), "drag");
    stage.dispatchEvent(touch("pointerup", { clientX: 200, clientY: 300 }));
  });
});

// C2 — the channel runs on godot-scene-web's pointer capture (mode "mouse"). These pin what that adds to the
// pre-C2 contract above: chords as edges, buttons and wheel axes couch has no token for, the browser's own menu
// events, the capture's release-on-blur, and couch never sending GSW's default long-press right click.
describe("createStreamInput — on the GSW pointer capture", () => {
  const mouse = (type: string, x: number, y: number, button: number, buttons: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button, buttons });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    Object.defineProperty(event, "pointerId", { value: 1 });
    return event;
  };

  it("a second button during a hold is its own press and release edge (a chord arrives as a move)", () => {
    makeInput({ map: (x, y) => ({ x, y, item: null }) });
    stage.dispatchEvent(mouse("pointerdown", 10, 10, 0, 1));
    stage.dispatchEvent(mouse("pointermove", 10, 10, 2, 3)); // right joins the held left
    stage.dispatchEvent(mouse("pointermove", 10, 10, 2, 1)); // right lets go
    stage.dispatchEvent(mouse("pointerup", 10, 10, 0, 0));
    expect(sent).toEqual([
      { kind: "click", button: "left", pressed: true, coordX: 10, coordY: 10 },
      { kind: "click", button: "right", pressed: true, coordX: 10, coordY: 10 },
      { kind: "click", button: "right", pressed: false, coordX: 10, coordY: 10 },
      { kind: "click", button: "left", pressed: false, coordX: 10, coordY: 10 }
    ]);
  });

  it("a mouse right click is its edge pair only: its contextmenu (button 2) is no second click", () => {
    makeInput({ map: (x, y) => ({ x, y, item: null }) });
    stage.dispatchEvent(mouse("pointerdown", 40, 50, 2, 2));
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50, button: 2 });
    stage.dispatchEvent(menu);
    stage.dispatchEvent(mouse("pointerup", 40, 50, 2, 0));
    expect(menu.defaultPrevented).toBe(true);
    expect(sent).toEqual([
      { kind: "click", button: "right", pressed: true, coordX: 40, coordY: 50 },
      { kind: "click", button: "right", pressed: false, coordX: 40, coordY: 50 }
    ]);
  });

  it("back/forward buttons and a horizontal wheel have no couch token and send nothing", () => {
    makeInput({ map: (x, y) => ({ x, y, item: null }) });
    const up = mouse("pointerup", 10, 10, 3, 0);
    stage.dispatchEvent(mouse("pointerdown", 10, 10, 3, 8));
    stage.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true); // no history navigation either
    stage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, deltaX: 120 }));
    expect(sent).toEqual([]);
  });

  it("a window blur releases a held mouse press at its last point", () => {
    makeInput({ map: (x, y) => ({ x: x * 2, y: y * 2, item: null }) });
    stage.dispatchEvent(mouse("pointerdown", 10, 10, 0, 1));
    window.dispatchEvent(new Event("blur"));
    expect(sent).toEqual([
      { kind: "click", button: "left", pressed: true, coordX: 20, coordY: 20 },
      { kind: "click", button: "left", pressed: false, coordX: 20, coordY: 20 }
    ]);
    stage.dispatchEvent(mouse("pointerup", 10, 10, 0, 0)); // nothing left to release
    expect(sent).toHaveLength(2);
  });

  it("a long hold on a card that is not in the hand is still a tap on lift, never a right click", () => {
    vi.useFakeTimers();
    try {
      const held = heldController(() => false);
      makeInput({ map: (x, y) => ({ x, y, item: 7 }), heldCard: held.controller, tapToFocus: () => false });
      stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
      vi.advanceTimersByTime(1000);
      expect(sent).toEqual([]);
      stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
      expect(sent).toEqual([
        { kind: "hover", coordX: 640, coordY: 360 },
        { kind: "click", button: "left", coordX: 640, coordY: 360 }
      ]);
      expect(held.setHeld).not.toHaveBeenCalledWith(7, expect.anything(), "peek");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a peek that then travels is a drag that lifts the card, and its release clears the lift", () => {
    vi.useFakeTimers();
    try {
      const held = heldController((item) => item === 7);
      makeInput({ map: (x, y) => ({ x, y, item: 7 }), heldCard: held.controller });
      stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 900 }));
      vi.advanceTimersByTime(100);
      expect(held.setHeld).toHaveBeenLastCalledWith(7, 900, "peek");
      stage.dispatchEvent(touch("pointermove", { clientX: 640, clientY: 500 }));
      vi.advanceTimersToNextFrame(); // fake timers own requestAnimationFrame here
      expect(held.setHeld).toHaveBeenLastCalledWith(7, 500, "drag");
      stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 500 }));
      expect(sent.filter((m) => m.kind === "click")).toEqual([
        { kind: "click", button: "left", pressed: true, coordX: 640, coordY: 900 },
        { kind: "click", button: "left", pressed: false, coordX: 640, coordY: 500 }
      ]);
      expect(held.setHeld).toHaveBeenLastCalledWith(null, 0, "drag");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createStreamInput — pointer targets (C3)", () => {
  const SCENE = "res://scenes/event.tscn";
  /** Option buttons 100 px wide side by side at x 0..99 (item 1), 100..199 (item 2); nothing past 200. */
  const resolveTarget: NonNullable<StreamInputOptions["resolveTarget"]> = (clientX, clientY) => {
    if (clientX >= 200) return null;
    const item = clientX < 100 ? 1 : 2;
    return {
      key: item,
      identity: { item, scene: SCENE, path: `Options/Option${item}` },
      local: { x: clientX - (item - 1) * 100, y: clientY },
      frame: 9
    };
  };
  const mouse = (type: string, x: number, y: number, buttons: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    Object.defineProperty(event, "pointerId", { value: 1 });
    return event;
  };
  const target = (n: number, x: number, y: number) => ({
    targetScene: SCENE,
    targetPath: `Options/Option${n}`,
    localX: x,
    localY: y
  });

  it("a hover and a mouse click carry the node they were on and the point in it", () => {
    makeInput({ map: (x, y) => ({ x: x * 2, y: y * 2, item: null }), resolveTarget });
    stage.dispatchEvent(mouse("pointermove", 150, 30, 0));
    flushFrames();
    stage.dispatchEvent(mouse("pointerdown", 150, 30, 1));
    stage.dispatchEvent(mouse("pointerup", 40, 30, 0));
    expect(sent).toEqual([
      { kind: "hover", coordX: 300, coordY: 60, ...target(2, 50, 30) },
      { kind: "click", button: "left", pressed: true, coordX: 300, coordY: 60, ...target(2, 50, 30) },
      { kind: "click", button: "left", pressed: false, coordX: 80, coordY: 60, ...target(1, 40, 30) }
    ]);
  });

  it("preserves the instance id on hover and click as a decimal string", () => {
    const instanceId = "18446744073709551615";
    makeInput({ map: (x, y) => ({ x, y, item: 2 }), resolveTarget: (x, y) => {
      const hit = resolveTarget(x, y)!;
      return { ...hit, identity: { ...hit.identity, instanceId } };
    } });
    stage.dispatchEvent(mouse("pointermove", 150, 30, 0));
    flushFrames();
    stage.dispatchEvent(mouse("pointerdown", 150, 30, 1));
    stage.dispatchEvent(mouse("pointerup", 150, 30, 0));
    expect(sent).toEqual([
      { kind: "hover", coordX: 150, coordY: 30, ...target(2, 50, 30), targetInstance: instanceId },
      { kind: "click", button: "left", pressed: true, coordX: 150, coordY: 30, ...target(2, 50, 30), targetInstance: instanceId },
      { kind: "click", button: "left", pressed: false, coordX: 150, coordY: 30, ...target(2, 50, 30), targetInstance: instanceId }
    ]);
  });

  it("stamps an instance-only target without requiring scene or path", () => {
    makeInput({ map: (x, y) => ({ x, y, item: 5 }), resolveTarget: () => ({
      key: 5, identity: { item: 5, instanceId: "123" }, local: { x: 1, y: 2 }
    }) });
    stage.dispatchEvent(mouse("pointermove", 10, 10, 0));
    flushFrames();
    expect(sent).toEqual([{ kind: "hover", coordX: 10, coordY: 10, targetInstance: "123", localX: 1, localY: 2 }]);
  });

  it("over no node the message is coordinate-only, byte-identical to before", () => {
    makeInput({ map: (x, y) => ({ x, y, item: null }), resolveTarget });
    stage.dispatchEvent(mouse("pointermove", 500, 30, 0));
    flushFrames();
    expect(sent).toEqual([{ kind: "hover", coordX: 500, coordY: 30 }]);
  });

  it("a node the seat cannot find (no scene or path) is no target", () => {
    makeInput({
      map: (x, y) => ({ x, y, item: null }),
      resolveTarget: () => ({ key: 5, identity: { item: 5 }, local: { x: 1, y: 2 } })
    });
    stage.dispatchEvent(mouse("pointermove", 10, 10, 0));
    flushFrames();
    expect(sent).toEqual([{ kind: "hover", coordX: 10, coordY: 10 }]);
  });

  it("a touch tap's one full click carries the node the finger went down on", () => {
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), tapToFocus: () => false, resolveTarget });
    stage.dispatchEvent(touch("pointerdown", { clientX: 60, clientY: 20 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 60, clientY: 20 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 60, coordY: 20, ...target(1, 60, 20) },
      { kind: "click", button: "left", coordX: 60, coordY: 20, ...target(1, 60, 20) }
    ]);
  });

  it("a wheel tick carries the node under the wheel", () => {
    makeInput({ map: (x, y) => ({ x, y, item: null }), resolveTarget });
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 120, clientY: 10, deltaY: -100 });
    stage.dispatchEvent(wheel);
    expect(sent).toEqual([{ kind: "click", button: "wheel-up", coordX: 120, coordY: 10, ...target(2, 20, 10) }]);
  });

  it("the confirm commit carries the widget the focus tap was on", () => {
    const confirm = confirmController({ id: 2, kind: "shop" });
    makeInput({
      map: (x, y) => ({ x, y, item: 2 }),
      confirmTap: confirm.controller,
      confirmTapEnabled: () => true,
      resolveTarget
    });
    stage.dispatchEvent(touch("pointerdown", { clientX: 150, clientY: 40 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 150, clientY: 40 }));
    sent.length = 0;
    capture.commitConfirm();
    expect(sent).toEqual([{ kind: "click", button: "left", coordX: 150, coordY: 40, ...target(2, 50, 40) }]);
  });
});

describe("createStreamInput — removal re-tap", () => {
  it("focuses removal once, swallows bounce, then activates the same service", () => {
    let now = 0;
    const confirm = confirmController({ id: 8, kind: "shop", retapActivates: true });
    makeInput({ map: (x, y) => ({ x, y, item: 8 }), confirmTap: confirm.controller, confirmTapEnabled: () => true,
      tapToFocus: () => true, clock: () => now });
    const tap = () => {
      stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
      stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    };
    tap();
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]);
    now = 100;
    tap();
    expect(sent.filter((m) => m.kind === "click")).toHaveLength(0);
    now = 250;
    tap();
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 640, coordY: 360 });
  });

  it("consumes a stale removal re-tap after the service is spent", () => {
    const confirm = confirmController({ id: 8, kind: "shop", retapActivates: true });
    makeInput({ map: (x, y) => ({ x, y, item: 8 }), items: { 8: { class: "NMerchantCardRemoval" } },
      confirmTap: confirm.controller, confirmTapEnabled: () => true, tapToFocus: () => true });
    const tap = () => {
      stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
      stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    };
    tap();
    confirm.controller.classify = () => null;
    tap();
    expect(sent.filter((m) => m.kind === "click")).toHaveLength(0);
  });

  it("does not click a confirm target invalidated after focus", () => {
    const confirm = confirmController({ id: 8, kind: "shop" });
    confirm.controller.commit = () => false;
    makeInput({ map: (x, y) => ({ x, y, item: 8 }), confirmTap: confirm.controller, confirmTapEnabled: () => true });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    capture.commitConfirm();
    expect(sent.filter((m) => m.kind === "click")).toHaveLength(0);
  });
});


describe("createStreamInput — confirm art readiness", () => {
  it("falls back to focus then click when the shared button art is unavailable", () => {
    let now = 0;
    const confirm = confirmController({ id: 8, kind: "shop" });
    makeInput({ map: (x, y) => ({ x, y, item: 8 }), items: { 8: { class: "NMerchantCard" } },
      confirmTap: confirm.controller, confirmTapEnabled: () => true, confirmButtonReady: () => false,
      tapToFocus: () => true, clock: () => now });
    const tap = () => {
      stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
      stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    };
    tap();
    expect(confirm.show).not.toHaveBeenCalled();
    expect(sent.filter((m) => m.kind === "click")).toHaveLength(0);
    now = 250;
    tap();
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 640, coordY: 360 });
  });
});
