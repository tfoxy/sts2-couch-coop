import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MirrorInputMessage } from "@/mirror/mirrorClient";
import {
  createStreamInput,
  type StreamInput,
  type StreamInputClient,
  type StreamGamePoint
} from "@/mirror/streamInput";
import type { ConfirmTapController } from "@/stream-ext/confirmTap";
import type { HeldCardController } from "@/stream-ext/heldCard";

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

const touch = (type: string, init: { clientX: number; clientY: number }) =>
  pointerEvent(type, { ...init, pointerType: "touch" });

/** A client whose mapping is an explicit, non-identity function, so a test can tell mapped from raw coordinates. */
function stubClient(
  map: (clientX: number, clientY: number) => { x: number; y: number; item: number | null }
): StreamInputClient {
  return {
    clientToGame: (clientX, clientY): StreamGamePoint => {
      const p = map(clientX, clientY);
      return { point: { x: p.x, y: p.y }, item: p.item, drawn: { x: clientX, y: clientY } };
    }
  };
}

function makeInput(options: {
  map?: (x: number, y: number) => { x: number; y: number; item: number | null };
  tapToFocus?: () => boolean;
  clock?: () => number;
  heldCard?: HeldCardController;
  raiseHeldCard?: () => boolean;
  unfocusOnRelease?: () => boolean;
  confirmTap?: ConfirmTapController;
  confirmTapEnabled?: () => boolean;
} = {}): void {
  const map = options.map ?? ((x, y) => ({ x, y, item: null }));
  let client: StreamInputClient | null = stubClient(map);
  capture = createStreamInput({
    stage,
    getClient: () => client,
    send: (m) => sent.push(m),
    tapToFocus: options.tapToFocus,
    now: options.clock,
    heldCard: options.heldCard,
    raiseHeldCard: options.raiseHeldCard,
    unfocusOnRelease: options.unfocusOnRelease,
    confirmTap: options.confirmTap,
    confirmTapEnabled: options.confirmTapEnabled
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
function confirmController(hit: { id: number; kind: "shop" } | null): { controller: ConfirmTapController; show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> } {
  const show = vi.fn();
  const hide = vi.fn();
  return {
    controller: {
      classify: () => hit,
      show,
      hide,
      dispose: vi.fn(),
      state: { targetId: null, kind: null, rect: null }
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

  it("a touch tap sends a single full click (press+release in one turn) when tapToFocus is off", () => {
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), tapToFocus: () => false });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(sent).toEqual([{ kind: "click", button: "left", coordX: 640, coordY: 360 }]);
  });

  it("with tapToFocus on, a touch tap arms the hit item (hover) and a later re-tap of it commits", () => {
    let clock = 0;
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), tapToFocus: () => true, clock: () => clock });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]);

    clock = 250; // past TAP_ARM_DEBOUNCE_MS: this is a deliberate re-tap, not a finger bounce
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 640, coordY: 360 },
      { kind: "click", button: "left", coordX: 640, coordY: 360 }
    ]);
  });

  it("with tapToFocus on, a re-tap of the armed item inside the debounce window is swallowed", () => {
    let clock = 0;
    makeInput({ map: (x, y) => ({ x, y, item: 7 }), tapToFocus: () => true, clock: () => clock });
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    clock = 50; // still inside the 200ms debounce
    stage.dispatchEvent(touch("pointerdown", { clientX: 640, clientY: 360 }));
    stage.dispatchEvent(touch("pointerup", { clientX: 640, clientY: 360 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 640, coordY: 360 }]);
  });

  it("a touch drag past the slop sends press + hover stream + release", () => {
    makeInput({ map: (x, y) => ({ x, y, item: 7 }) });
    stage.dispatchEvent(touch("pointerdown", { clientX: 100, clientY: 100 }));
    stage.dispatchEvent(touch("pointermove", { clientX: 200, clientY: 100 })); // past 8px slop → press
    flushFrames();
    expect(sent[0]).toEqual({ kind: "click", button: "left", pressed: true, coordX: 100, coordY: 100 });
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
    expect(sent).toEqual([{ kind: "click", button: "left", coordX: 960, coordY: 659 }]);
    expect(sent[0].coordY).not.toBe(540);
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
    expect(sent).toEqual([{ kind: "click", button: "left", coordX: 640, coordY: 360 }]);
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
    expect(sent).toEqual([{ kind: "click", button: "left", coordX: 640, coordY: 360 }]);
    expect(confirm.show).not.toHaveBeenCalled();
  });

  it("commitConfirm with no button up sends nothing", () => {
    makeInput({ map: (x, y) => ({ x, y, item: null }) });
    capture.commitConfirm();
    expect(sent).toEqual([]);
  });
});
