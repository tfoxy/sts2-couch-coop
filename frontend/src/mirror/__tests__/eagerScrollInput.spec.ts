import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEagerScroll,
  MAP_LIMIT_HI,
  MAP_LIMIT_LO,
  WHEEL_NOTCH_PX,
  type EagerScroll,
  type EagerScrollTarget
} from "@/mirror/eagerScroll";
import { createInputCapture, type InputCapture } from "@/mirror/inputCapture";
import type { MirrorInputMessage } from "@/mirror/mirrorClient";

// The INPUT half of eager scrolling: what inputCapture does with a wheel event over a scrollable, and how the
// compensation lands on the coordinate that actually goes upstream. Driven through the real DOM event path, so the
// wire these tests observe is the wire the game gets.

function domRect(left: number, top: number, width: number, height: number): DOMRect {
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

let stage: HTMLElement;
let sent: MirrorInputMessage[];
let capture: InputCapture;
let engine: EagerScroll;
let frames: FrameRequestCallback[];
let clock: { t: number };
let targets: EagerScrollTarget[];
let mapEl: HTMLElement;

function flushFrames(): void {
  for (const cb of frames.splice(0)) {
    cb(0);
  }
}

function mapTarget(streamedY = -600): EagerScrollTarget {
  return {
    id: "map",
    kind: "map",
    el: mapEl,
    streamedY,
    renderedY: streamedY,
    viewport: { minX: 0, minY: 0, maxX: 1920, maxY: 1080 },
    scrollbarBox: null,
    scrollbarRenderedBox: null,
    wheelSafe: null,
    limitLo: MAP_LIMIT_LO,
    limitHi: MAP_LIMIT_HI,
    band: null,
    pinned: false,
    suppressed: false,
    bar: null
  };
}

// R19 WP5 — the action wire that states the target offset. `sent` remains available to prove a scroll gesture does
// not also emit ordinary input.
let scrolls: Array<{ elementId: string; offsetY: number; requestId: string }>;

// The LIVE widened design width the capture is built with. 1920 = 16:9 (what every case in this file used before
// R20); a bigger number is "Widescreen stretch", where the pointer fraction spreads across the wider design box and
// the anchor map has to invert each painting node's shift to recover a 1920-space game coordinate.
let buildDesignWidth = 1920;

function build(): void {
  sent = [];
  scrolls = [];
  engine = createEagerScroll({
    targets: () => targets,
    send: (m) => sent.push(m),
    sendScroll: (elementId, offsetY) => {
      const requestId = `r${scrolls.length + 1}`;
      scrolls.push({ elementId, offsetY, requestId });
      return requestId;
    },
    designPerClientPx: () => 2, // the half-scale stage below
    applyLocalOffset: (nodeId, dy) => {
      const target = targets.find((candidate) => candidate.id === nodeId);
      if (!target?.el) return;
      target.el.style.translate = Math.abs(dy) < 0.01 ? "0px" : `0px ${dy.toFixed(2)}px`;
    },
    scrollRenderedY: (nodeId) => targets.find((candidate) => candidate.id === nodeId)?.renderedY ?? null,
    now: () => clock.t,
    raf: () => 0,
    caf: () => undefined
  });
  capture = createInputCapture(
    stage,
    (m) => sent.push(m),
    () => buildDesignWidth,
    undefined,
    undefined,
    {},
    undefined,
    engine
  );
}

function rebuildCapture(): void {
  capture.dispose();
  engine.dispose();
  build();
}

beforeEach(() => {
  buildDesignWidth = 1920;
  document.body.innerHTML = "";
  frames = [];
  clock = { t: 1000 };
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  stage = document.createElement("div");
  document.body.appendChild(stage);
  // 1920x1080 design painted at half scale.
  stage.getBoundingClientRect = () => domRect(0, 0, 960, 540);
  mapEl = document.createElement("div");
  document.body.appendChild(mapEl);
  targets = [mapTarget()];
  build();
});

afterEach(() => {
  capture.dispose();
  engine.dispose();
  vi.unstubAllGlobals();
  delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
});

// R11 WS-S §5 — a drag inside a CARD GRID scrolls it, on both input paths, and the press is withheld so the game
// can neither start its own drag-scroll with it nor press the card under the finger.
describe("inputCapture × eagerScroll — the grid drag", () => {
  // The deck grid: a 1002-tall frame at design y=80 with content twice as tall.
  function gridTarget(): EagerScrollTarget {
    return {
      id: "grid",
      kind: "grid",
      el: mapEl,
      streamedY: 0,
      renderedY: 0,
      viewport: { minX: 0, minY: 80, maxX: 1920, maxY: 1082 },
      scrollbarBox: null,
      scrollbarRenderedBox: null,
      wheelSafe: { x: 87, y: 581 },
      limitLo: -3000,
      limitHi: 0,
      band: null,
      pinned: false,
      suppressed: false,
      bar: null
    };
  }

  // A card under the finger remains a valid grid-pan origin.
  function stubCard(): void {
    const card = document.createElement("div");
    card.setAttribute("data-touch-id", "card-7");
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [card];
  }

  beforeEach(() => {
    targets = [gridTarget()];
    stubCard();
  });

  it("MOUSE: withholds the press, sends no hover stream, and states the grid offset", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 300, bubbles: true }));
    // Nothing upstream yet — and nothing to retract later.
    expect(sent).toEqual([]);

    // Drag 100 CSS px up = 200 design px.
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 200, bubbles: true }));
    flushFrames();
    engine.__frameForTest();
    expect(mapEl.style.translate).toBe("0px -200.00px");
    expect(scrolls).toEqual([{ elementId: "grid", offsetY: -200, requestId: "r1" }]);
    expect(sent).toEqual([]);

    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 200, bubbles: true }));
    expect(scrolls.at(-1)).toEqual({ elementId: "grid", offsetY: -200, requestId: "r1" });
    expect(sent.some((m) => "pressed" in m)).toBe(false);
  });

  it("MOUSE: a press that never travels is still a CLICK (choose-a-card dialogs keep working)", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 300, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 300, bubbles: true }));
    expect(sent).toEqual([{ kind: "click", button: "left", coordX: 960, coordY: 600 }]);
  });

  it("TOUCH: a drag over a card scrolls the grid — no press, release, or card semantics", () => {
    const touch = (type: string, clientY: number): MouseEvent => {
      const ev = new MouseEvent(type, { button: 0, clientX: 480, clientY, bubbles: true, cancelable: true });
      Object.defineProperty(ev, "pointerType", { value: "touch" });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      return ev;
    };
    stage.dispatchEvent(touch("pointerdown", 300));
    sent.length = 0; // the down-edge hover is the pre-existing contract, not what this test is about

    stage.dispatchEvent(touch("pointermove", 200));
    flushFrames();
    engine.__frameForTest();
    expect(mapEl.style.translate).toBe("0px -200.00px");
    expect(scrolls).toEqual([{ elementId: "grid", offsetY: -200, requestId: "r1" }]);
    expect(sent).toEqual([]);

    stage.dispatchEvent(touch("pointerup", 200));
    expect(sent.some((m) => "pressed" in m)).toBe(false);
  });
});

// R11 WS-S §8 — the two-finger scroll goes through the same engine as everything else.
describe("inputCapture × eagerScroll — two fingers", () => {
  function touch(type: string, pointerId: number, clientY: number): MouseEvent {
    const ev = new MouseEvent(type, { button: 0, clientX: 480, clientY, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "pointerType", { value: "touch" });
    Object.defineProperty(ev, "pointerId", { value: pointerId });
    return ev;
  }

  it("moves the map 1:1 with the fingers and states the resulting offset", () => {
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [];
    stage.dispatchEvent(touch("pointerdown", 1, 200));
    stage.dispatchEvent(touch("pointerdown", 2, 300));
    sent.length = 0;

    // Both fingers travel 60 CSS px (=120 design px) down the screen: past the 24px two-finger cancel threshold, so
    // the gesture is a scroll, and the centroid has moved 120 design px.
    stage.dispatchEvent(touch("pointermove", 1, 260));
    stage.dispatchEvent(touch("pointermove", 2, 360));
    flushFrames();
    engine.__frameForTest();

    // 1:1 — the map follows the fingers exactly.
    expect(mapEl.style.translate).toBe("0px 120.00px");
    expect(scrolls).toEqual([{ elementId: "map", offsetY: -480, requestId: "r1" }]);
    expect(sent).toEqual([]);

    stage.dispatchEvent(touch("pointerup", 1, 260));
    stage.dispatchEvent(touch("pointerup", 2, 360));
    // No right-click is emitted for a gesture that moved.
    expect(sent).toEqual([]);
  });

  it("forwards ordinary input where nothing claims the gesture", () => {
    targets = [];
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [];
    stage.dispatchEvent(touch("pointerdown", 1, 200));
    stage.dispatchEvent(touch("pointerdown", 2, 300));
    sent.length = 0;
    stage.dispatchEvent(touch("pointermove", 1, 260));
    stage.dispatchEvent(touch("pointermove", 2, 360));
    flushFrames();
    // 120 design px of centroid drift = two 56px steps, sent at the latch centroid, exactly as before the feature.
    expect(sent).toEqual([
      { kind: "click", button: "wheel-up", coordX: 960, coordY: 500 },
      { kind: "click", button: "wheel-up", coordX: 960, coordY: 500 }
    ]);
  });
});

describe("inputCapture × eagerScroll — the wheel", () => {
  it("hands a notch over the map to the engine, which moves it locally and states its offset", () => {
    stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, clientX: 480, clientY: 270, bubbles: true }));
    engine.__frameForTest();

    expect(scrolls).toEqual([{ elementId: "map", offsetY: -600 + WHEEL_NOTCH_PX, requestId: "r1" }]);
    expect(sent).toEqual([]);
    expect(mapEl.style.translate).toBe(`0px ${WHEEL_NOTCH_PX.toFixed(2)}px`);
  });

  it("forwards ordinary input where no scrollable claims the point", () => {
    targets = [];
    stage.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, deltaMode: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(sent).toEqual([{ kind: "click", button: "wheel-down", coordX: 960, coordY: 540 }]);
  });

});

describe("inputCapture × eagerScroll — upstream compensation", () => {
  it("a tap right after a scroll uses the compensated game coordinates", () => {
    // Three notches up ⇒ the content leads the host by 3 notches of design px.
    const lead = 3 * WHEEL_NOTCH_PX;
    for (let i = 0; i < 3; i++) {
      stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, clientX: 480, clientY: 270, bubbles: true }));
    }
    engine.__frameForTest();
    sent.length = 0;

    const button = document.createElement("div");
    button.setAttribute("data-touch-block", "1");
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [button];

    // Tap at design (960, 540): the content there is what the game has `lead` px further up.
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 270, bubbles: true }));

    expect(sent).toEqual([
      { kind: "click", button: "left", pressed: true, coordX: 960, coordY: 540 - lead },
      { kind: "click", button: "left", pressed: false, coordX: 960, coordY: 540 - lead }
    ]);
  });

  it("compensates a HOVER through the same seam", () => {
    stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, clientX: 480, clientY: 270, bubbles: true }));
    engine.__frameForTest();
    sent.length = 0;

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 960, coordY: 540 - WHEEL_NOTCH_PX });
  });

  it("stops compensating once the host has caught up", () => {
    stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, clientX: 480, clientY: 270, bubbles: true }));
    engine.__frameForTest();
    targets = [mapTarget(-600 + WHEEL_NOTCH_PX)];
    clock.t += 200;
    engine.__frameForTest();
    sent.length = 0;

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 960, coordY: 540 });
  });

});

describe("inputCapture × eagerScroll — the pan", () => {
  it("a left-drag over empty map space pans locally and is EXEMPT from compensation", () => {
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [];
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(engine.panActive()).toBe(true);

    // Drag 60 CSS px down = 120 design px.
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 330, bubbles: true }));
    flushFrames();
    engine.__frameForTest();
    expect(mapEl.style.translate).toBe("0px 120.00px");
    expect(scrolls).toEqual([{ elementId: "map", offsetY: -480, requestId: "r1" }]);
    expect(sent).toEqual([]);

    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 330, bubbles: true }));
    expect(engine.panActive()).toBe(false);
  });

  it("takes the RELEASE position too — the tail of a flick is not left behind (live-found)", () => {
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [];
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    // One flushed move (30 design px), then the pointer goes UP 100 design px further on. The eager offset must
    // include the release position too, so the stated position matches the local endpoint.
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 285, bubbles: true }));
    flushFrames();
    engine.__frameForTest();
    expect(mapEl.style.translate).toBe("0px 30.00px");

    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 335, bubbles: true }));
    engine.__frameForTest();
    expect(mapEl.style.translate).toBe("0px 130.00px");
    expect(scrolls.at(-1)).toEqual({ elementId: "map", offsetY: -470, requestId: "r2" });
  });

  it("does NOT pan when the press landed on a BLOCKING button — empty ids are not empty space (§3)", () => {
    // A deck dialog's sort / back / pencil buttons are `…Button` leaves: the renderer stamps them
    // `data-touch-block`, so they carry no touch id at all.
    const button = document.createElement("div");
    button.setAttribute("data-touch-block", "1");
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [button];
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(engine.panActive()).toBe(false);
  });

  it("does NOT pan when the press landed on a touch widget", () => {
    const widget = document.createElement("div");
    widget.setAttribute("data-touch-id", "card-1");
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [widget];
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(engine.panActive()).toBe(false);
  });
});

// R19 WP5 — semantic scrolling through the real DOM event path. The two defects that live in THIS file are the ones
// only the input layer can fix: a press the game never accepts (the widescreen map drag) and a press the input
// layer hands to the host and the host does nothing useful with (the card-grid scrollbar track).
describe("inputCapture × eagerScroll — the scrollbar track", () => {
  // The deck grid's own bar as the renderer publishes it: a 50-wide strip down the right of a 1920x1002 frame, and
  // 2400px of content to scroll through. Design px throughout (the stage paints them at half scale).
  const barBox = { minX: 1820, minY: 200, maxX: 1870, maxY: 1000 };

  function barGrid(): EagerScrollTarget {
    return {
      id: "grid",
      kind: "grid",
      el: mapEl,
      streamedY: 0,
      renderedY: 0,
      viewport: { minX: 0, minY: 80, maxX: 1920, maxY: 1082 },
      scrollbarBox: barBox,
      // 16:9 (designWidth 1920) ⇒ the bar's spreadDx is 0 ⇒ the rendered box IS the game box, and the R20 gate is
      // provably inert. Set to the same box rather than null so these cases really do run through the gate.
      scrollbarRenderedBox: barBox,
      wheelSafe: { x: 87, y: 581 },
      limitLo: -2400,
      limitHi: 0,
      band: null,
      pinned: false,
      suppressed: false,
      bar: null
    };
  }

  // The z-stack over the strip, topmost first. The renderer stamps a scrollbar's track `data-touch-block="bar"` and
  // its handle `"thumb"` (R21) — the claim reads the KIND, so the stub has to carry the right one or the test means
  // nothing. `over` puts a foreign widget on top, which is the confirm-button case.
  function stubStrip(kind: "bar" | "thumb", over?: { block?: string; id?: string }): void {
    const stack: Element[] = [];
    if (over) {
      const top = document.createElement("div");
      if (over.block !== undefined) top.setAttribute("data-touch-block", over.block);
      if (over.id !== undefined) top.setAttribute("data-touch-id", over.id);
      stack.push(top);
    }
    const strip = document.createElement("div");
    strip.setAttribute("data-touch-block", kind);
    stack.push(strip);
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => stack;
  }

  beforeEach(() => {
    targets = [barGrid()];
    stubStrip("bar");
    rebuildCapture();
  });

  it("MOUSE: a press three quarters down the TRACK scrolls the grid, and sends no click at all", () => {
    // client (922, 400) on a half-scale stage ⇒ design (1844, 800) ⇒ 0.75 of the strip ⇒ 0.75 of −2400.
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 922, clientY: 400, bubbles: true }));
    engine.__frameForTest();
    expect(engine.panMode()).toBe("bar");
    expect(mapEl.style.translate).toBe("0px -1800.00px");
    expect(scrolls).toEqual([{ elementId: "grid", offsetY: -1800, requestId: "r1" }]);
    expect(sent).toEqual([]);
  });

  it("MOUSE: the release of a track press is NOT a deferred click (the one withheld press that already acted)", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 922, clientY: 400, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 922, clientY: 400, bubbles: true }));
    // A grid DRAG's sub-slop release becomes a full click so choose-a-card dialogs keep working; a bar press must
    // not, or the game's own scrollbar gets a press that jumps it somewhere else again.
    expect(sent).toEqual([]);
    expect(engine.panActive()).toBe(false);
    expect(scrolls.at(-1)).toEqual({ elementId: "grid", offsetY: -1800, requestId: "r1" });
  });

  it("MOUSE: dragging the thumb re-states the position, never a delta", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 922, clientY: 200, bubbles: true }));
    expect(engine.__entryForTest("grid")!.eagerY).toBe(-600); // design y=400 ⇒ a quarter down
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 922, clientY: 500, bubbles: true }));
    flushFrames();
    engine.__frameForTest();
    expect(engine.__entryForTest("grid")!.eagerY).toBe(-2400); // design y=1000 ⇒ the very bottom
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 922, clientY: 500, bubbles: true }));
    expect(scrolls.at(-1)!.offsetY).toBe(-2400);
    expect(sent.some((m) => m.kind === "click")).toBe(false);
  });

  const touchAt = (type: string, clientY: number, clientX = 922): MouseEvent => {
    const ev = new MouseEvent(type, { button: 0, clientX, clientY, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "pointerType", { value: "touch" });
    Object.defineProperty(ev, "pointerId", { value: 1 });
    return ev;
  };

  it("TOUCH: a tap on the track scrolls it — on the RELEASE, and with no press, no hover, no release upstream", () => {
    // Touch normally offers a gesture to the engine only at DRAG CLASSIFICATION (8px of travel) — which is why a
    // track tap, a gesture with no travel in it at all, needed a press-time hook of its own.
    //
    // R21: that hook no longer ACTS at the press. The strip is a ~50px sliver at the edge of the frame, so a
    // finger reaches it by accident constantly; a claim that jumps on contact turns an accidental brush into a
    // jump to wherever the finger touched. The tap is committed when the gesture proves to BE a tap — on the lift.
    stage.dispatchEvent(touchAt("pointerdown", 400));
    engine.__frameForTest();
    expect(scrolls).toEqual([]);
    expect(mapEl.style.translate).toBe("");
    expect(sent).toEqual([]);

    stage.dispatchEvent(touchAt("pointerup", 400));
    engine.__frameForTest();
    expect(scrolls).toEqual([{ elementId: "grid", offsetY: -1800, requestId: "r1" }]);
    expect(sent).toEqual([]);
    expect(engine.panActive()).toBe(false);
  });

  it("TOUCH: a SWIPE that began on the track scrolls the CONTENT — the strip gives the gesture up (the reported defect)", () => {
    // The player is scrolling the grid with their thumb, whose arc clips the strip at the right edge. The press
    // lands at design y=1000 — the very BOTTOM of the 200..1000 strip — so before R21 the press-time claim read it
    // as "drag the scrollbar" and threw the grid to the bottom of the whole collection (−2400) before the finger
    // had moved at all.
    stage.dispatchEvent(touchAt("pointerdown", 500));
    engine.__frameForTest();
    expect(scrolls).toEqual([]); // nothing on contact — the gesture has not said what it is yet

    // 300 CSS px up = 600 design px of finger travel: the swipe.
    stage.dispatchEvent(touchAt("pointermove", 200));
    flushFrames();
    engine.__frameForTest();
    // The content follows the finger 1:1 from the PRESS (no jump at the hand-over — the travel since the press is
    // applied whole), and it is nowhere near the −2400 the strip's own mapping would have named.
    expect(engine.panMode()).toBe("absolute");
    expect(engine.__entryForTest("grid")!.eagerY).toBe(-600);
    expect(scrolls.at(-1)!.offsetY).toBe(-600);
    expect(sent).toEqual([]);

    stage.dispatchEvent(touchAt("pointerup", 200));
    expect(sent).toEqual([]);
  });

  it("TOUCH: a slide down the THUMB still tracks the finger by position", () => {
    // The handle is a deliberate grab — a player's finger does not land on it by accident the way it brushes the
    // track — so it is NOT deferred and drags exactly as it did before R21.
    stubStrip("thumb");
    stage.dispatchEvent(touchAt("pointerdown", 200));
    engine.__frameForTest();
    expect(engine.__entryForTest("grid")!.eagerY).toBe(-600); // acts at the press, like the mouse
    stage.dispatchEvent(touchAt("pointermove", 500));
    flushFrames();
    engine.__frameForTest();
    expect(engine.__entryForTest("grid")!.eagerY).toBe(-2400);
    stage.dispatchEvent(touchAt("pointerup", 500));
    expect(sent).toEqual([]);
  });

  // R21 — THE CONFIRM BUTTON. A card-selection dialog (smith / remove card) puts its confirm button at the right
  // of the frame, overlapping the strip. The bar claimed those presses on geometry alone and WITHHELD them, so the
  // only part of the button that clicked was the part clear of the strip.
  describe("a widget painted over the strip", () => {
    it("MOUSE: the press belongs to the button on top, and goes upstream", () => {
      stubStrip("bar", { block: "1" });
      stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 922, clientY: 400, bubbles: true }));
      engine.__frameForTest();
      expect(engine.panMode()).toBeNull();
      expect(scrolls).toEqual([]);
      expect(sent).toEqual([{ kind: "click", button: "left", pressed: true, coordX: 1844, coordY: 800 }]);
      stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 922, clientY: 400, bubbles: true }));
      expect(sent.at(-1)).toEqual({ kind: "click", button: "left", pressed: false, coordX: 1844, coordY: 800 });
    });

    it("TOUCH: the tap reaches the button (a block leaf clicks immediately)", () => {
      stubStrip("bar", { block: "1" });
      stage.dispatchEvent(touchAt("pointerdown", 400));
      engine.__frameForTest();
      expect(scrolls).toEqual([]);
      expect(sent).toEqual([{ kind: "hover", coordX: 1844, coordY: 800 }]);
      stage.dispatchEvent(touchAt("pointerup", 400));
      expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 1844, coordY: 800 });
    });

    it("a hover-first widget on top wins too — and its drag scrolls the grid as CONTENT", () => {
      // A card drawn over the strip is what the player is touching, so the bar may not have it. The grid still
      // does (§5: cards do not disqualify a grid drag), which is what keeps the press withheld.
      stubStrip("bar", { id: "card-7" });
      stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 922, clientY: 400, bubbles: true }));
      expect(engine.panMode()).toBe("absolute");
      expect(sent).toEqual([]);
    });

  });

});

// R20 — THE SAME TRACK ON A WIDENED STAGE, which nothing in this file had ever exercised: every case above builds
// the capture at designWidth 1920, so the branch that spreads the pointer across a wider design box could not run and
// the defect below shipped. Reported as "the card grid scrollbar takes over when dragging near its LEFT (but not over
// it) on widescreen stretch".
//
// THE ARITHMETIC. "Widescreen stretch" at 2520 design px is spreadFactor 1.3125. The strip's GAME box is x [1820,1870]
// (the wire's own 1820 origin + 50 wide) and its anchor claim is [1,1], so it takes the whole 600px widening delta and
// is PAINTED at [2420,2470] — the largest displacement in the dialog, which is why the error is one-sided and there is
// no right-hand twin. Beside the bar nothing paints, so the anchor map answers with the uniform squeeze
// (`gameX = designX·1920/2520`), and the old game-space AABB test therefore claimed every raw designX in
// [2388.75, 2454.375]: a 31.25px PHANTOM BAND immediately left of the painted bar. A "bar" claim withholds the press,
// so that band did not merely mis-target the gesture — it deleted it.
describe("inputCapture × eagerScroll — the scrollbar track under Widescreen stretch", () => {
  const barBox = { minX: 1820, minY: 200, maxX: 1870, maxY: 1000 };
  const barRenderedBox = { minX: 2420, minY: 200, maxX: 2470, maxY: 1000 };

  function wideBarGrid(): EagerScrollTarget {
    return {
      id: "grid",
      kind: "grid",
      el: mapEl,
      streamedY: 0,
      renderedY: 0,
      viewport: { minX: 0, minY: 80, maxX: 1920, maxY: 1082 },
      scrollbarBox: barBox,
      scrollbarRenderedBox: barRenderedBox,
      wheelSafe: { x: 87, y: 581 },
      limitLo: -2400,
      limitHi: 0,
      band: null,
      pinned: false,
      suppressed: false,
      bar: null
    };
  }

  // A raw widened-design X, as a client pixel on the half-scale 2520x1080 stage below.
  const clientOf = (designX: number): number => (designX / 2520) * 1260;

  beforeEach(() => {
    // 2520x1080 design painted at half scale — the same 2:1 the 16:9 cases use, just wider.
    stage.getBoundingClientRect = () => domRect(0, 0, 1260, 540);
    buildDesignWidth = 2520;
    targets = [wideBarGrid()];
    // Nothing paints beside the bar, so the probe finds no `data-paints` anchor and the map falls back to the uniform
    // squeeze — which is exactly the resolve that manufactured the phantom band.
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [];
    rebuildCapture();
  });

  it("MOUSE: a press 20px LEFT of the painted strip is NOT the scrollbar's (the reported defect)", () => {
    // Raw designX 2400 squeezes to game 1828.57 — inside the GAME box [1820,1870], so the pre-R20 AABB test claimed
    // it and withheld the press. On screen the pointer was 20px clear of the bar.
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: clientOf(2400), clientY: 400, bubbles: true }));
    engine.__frameForTest();
    // Not the bar's — and R21: not NOBODY's either. R20 refused the bar claim but left the strip's game box carved
    // out of the content claim too, so the press went upstream at a coordinate the GAME reads as its own scrollbar
    // — which then took the whole gesture (its press latches a flag the grid drives its scroll target from). The
    // client refusing a claim must not hand the gesture to the very control it refused it for: the point is
    // ordinary grid CONTENT, and its press is withheld like any other grid drag's.
    expect(engine.panMode()).toBe("absolute");
    expect(scrolls).toEqual([]); // claimed, not yet moved (§6: a press is not a scroll)
    expect(sent).toEqual([]);
  });

  it("MOUSE: …and that press still CLICKS if it never travels", () => {
    // The withheld press is deferred, not deleted — a sub-slop release is a full click, so whatever the player was
    // pressing beside the bar still gets pressed.
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: clientOf(2400), clientY: 400, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: clientOf(2400), clientY: 400, bubbles: true }));
    expect(sent).toEqual([{ kind: "click", button: "left", coordX: 1828.5714285714284, coordY: 800 }]);
  });

  it("MOUSE: a press ON the painted strip still claims it", () => {
    // Raw designX 2445 is inside the RENDERED box [2420,2470] and squeezes to game 1862.86, inside the game box.
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: clientOf(2445), clientY: 400, bubbles: true }));
    engine.__frameForTest();
    expect(engine.panMode()).toBe("bar");
    expect(scrolls).toEqual([{ elementId: "grid", offsetY: -1800, requestId: "r1" }]);
    expect(sent).toEqual([]);
  });

  it("TOUCH: the same band, on the path where a false claim eats a tap", () => {
    const touch = (type: string, clientX: number): MouseEvent => {
      const ev = new MouseEvent(type, { button: 0, clientX, clientY: 400, bubbles: true, cancelable: true });
      Object.defineProperty(ev, "pointerType", { value: "touch" });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      return ev;
    };
    stage.dispatchEvent(touch("pointerdown", clientOf(2400)));
    engine.__frameForTest();
    expect(engine.panMode()).toBeNull();
    // The down-edge hover the claim used to swallow.
    expect(sent).toEqual([{ kind: "hover", coordX: 1828.5714285714284, coordY: 800 }]);
  });

});

describe("inputCapture × eagerScroll — the map drag through semantic scrolling", () => {
  beforeEach(() => {
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [];
    rebuildCapture();
  });

  it("MOUSE: sends no press or pointer stream — only the offset (the widescreen-stretch fix)", () => {
    // The defect: under "Widescreen stretch" the press of a right-zone drag resolves into stretched space with no
    // painter under it, the game accepts the coordinate and starts no drag, and the client's own pan proof then
    // disowns the gesture and glides the map back to where the drag started. An absolute gesture withholds that
    // press entirely, so there is nothing left for the game to decline.
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(engine.panMode()).toBe("absolute");
    expect(sent).toEqual([]);

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 330, bubbles: true }));
    flushFrames();
    engine.__frameForTest();
    expect(mapEl.style.translate).toBe("0px 120.00px");
    expect(sent).toEqual([]);
    expect(scrolls).toEqual([{ elementId: "map", offsetY: -480, requestId: "r1" }]);

    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 330, bubbles: true }));
    expect(sent).toEqual([]);
    expect(engine.panActive()).toBe(false);
  });

  it("MOUSE: a press that never travels is still a click", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(sent).toEqual([{ kind: "click", button: "left", coordX: 960, coordY: 540 }]);
  });

  it("WHEEL: states the offset instead of replaying ticks", () => {
    stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, clientX: 480, clientY: 270, bubbles: true }));
    engine.__frameForTest();
    expect(sent).toEqual([]);
    expect(scrolls).toEqual([{ elementId: "map", offsetY: -600 + WHEEL_NOTCH_PX, requestId: "r1" }]);
  });
});
