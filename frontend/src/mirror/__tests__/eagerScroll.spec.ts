import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_HOLD_MS,
  MAP_LIMIT_HI,
  MAP_LIMIT_LO,
  PAN_ACTIVATE_PX,
  SETTLE_DEADLINE_MS,
  SETTLE_EPS_PX,
  SETTLE_GLIDE_MS,
  SETTLE_STALL_MS,
  SCROLL_SEND_MIN_MS,
  WHEEL_NOTCH_PX,
  absorbBand,
  barFraction,
  barHandleYFor,
  barOffsetFor,
  clampEager,
  createEagerScroll,
  inferBarMapping,
  panClaimWithholdsPress,
  wheelEventToGamePx,
  type EagerScrollTarget
} from "@/mirror/eagerScroll";
import type { MirrorInputMessage } from "@/mirror/mirrorClient";

// DOM-backed fixtures exercise the same id-addressed renderer seam as the shipped renderer.
type DomTarget = EagerScrollTarget & { el: HTMLElement };

// A map target: `TheMap` under the full-screen map screen, at the game's own resting offset (-600).
function mapTarget(overrides: Partial<DomTarget> = {}): DomTarget {
  return {
    id: "map",
    kind: "map",
    el: document.createElement("div"),
    streamedY: -600,
    renderedY: -600,
    viewport: { minX: 0, minY: 0, maxX: 1920, maxY: 1080 },
    scrollbarBox: null,
    scrollbarRenderedBox: null,
    wheelSafe: null,
    limitLo: MAP_LIMIT_LO,
    limitHi: MAP_LIMIT_HI,
    band: null,
    pinned: false,
    suppressed: false,
    bar: null,
    ...overrides
  };
}

// A card grid: a 1920x1002 viewport at y=80 (the grid sits below the top bar) over 2400px of content.
function gridTarget(overrides: Partial<DomTarget> = {}): DomTarget {
  return {
    id: "grid",
    kind: "grid",
    el: document.createElement("div"),
    streamedY: 0,
    renderedY: 0,
    viewport: { minX: 0, minY: 80, maxX: 1920, maxY: 1082 },
    scrollbarBox: null,
    scrollbarRenderedBox: null,
    wheelSafe: null,
    limitLo: 1002 - 2400,
    limitHi: 0,
    band: null,
    pinned: false,
    suppressed: false,
    bar: null,
    ...overrides
  };
}

interface Harness {
  engine: ReturnType<typeof createEagerScroll>;
  sent: MirrorInputMessage[];
  scrolls: Array<{ elementId: string; offsetY: number; requestId: string }>;
  setTargets(list: EagerScrollTarget[]): void;
  targets(): EagerScrollTarget[];
  // Advance the fake clock and run exactly one blend frame.
  step(ms: number): void;
  clock: { t: number };
}

function harness(initial: EagerScrollTarget[]): Harness {
  const clock = { t: 1000 };
  let list = initial;
  const sent: MirrorInputMessage[] = [];
  const scrolls: Harness["scrolls"] = [];
  const engine = createEagerScroll({
    targets: () => list,
    send: (m) => sent.push(m),
    sendScroll: (elementId, offsetY) => {
      const requestId = `r${scrolls.length + 1}`;
      scrolls.push({ elementId, offsetY, requestId });
      return requestId;
    },
    designPerClientPx: () => 1,
    applyLocalOffset: (nodeId, dy) => writeFixtureOffset(list, nodeId, dy),
    scrollRenderedY: (nodeId) => fixtureTarget(list, nodeId)?.renderedY ?? null,
    now: () => clock.t,
    // No rAF: every frame is driven explicitly by `step` so the state machine is deterministic.
    raf: () => 0,
    caf: () => undefined
  });
  return {
    engine,
    sent,
    scrolls,
    setTargets: (next) => {
      list = next;
    },
    targets: () => list,
    step(ms: number) {
      clock.t += ms;
      engine.__frameForTest();
    },
    clock
  };
}

function fixtureTarget(list: EagerScrollTarget[], nodeId: string): EagerScrollTarget | null {
  return list.find((target) => target.id === nodeId) ?? null;
}

function writeFixtureOffset(list: EagerScrollTarget[], nodeId: string, dy: number): void {
  for (const target of list) {
    const element = target.id === nodeId ? target.el : target.bar?.id === nodeId ? target.bar.el : null;
    if (!element) continue;
    const value = Math.abs(dy) < 0.01 ? "0px" : `0px ${dy.toFixed(2)}px`;
    if (element.style.translate !== value) element.style.translate = value;
    return;
  }
}

// R19 WP5 — the harness exposes the absolute action wire. `scrolls` records the position stated to the game;
// `sent` remains available to prove this path does not also emit ordinary input.
interface AuthorityHarness extends Harness {
  scrolls: Array<{ elementId: string; offsetY: number; requestId: string }>;
  // The host's answer to one send, by index into `scrolls`.
  ack(index: number, offsetY: number): void;
}

function authorityHarness(initial: EagerScrollTarget[], options: { sendFails?: boolean } = {}): AuthorityHarness {
  const clock = { t: 1000 };
  let list = initial;
  const sent: MirrorInputMessage[] = [];
  const scrolls: AuthorityHarness["scrolls"] = [];
  const engine = createEagerScroll({
    targets: () => list,
    send: (m) => sent.push(m),
    designPerClientPx: () => 1,
    applyLocalOffset: (nodeId, dy) => writeFixtureOffset(list, nodeId, dy),
    scrollRenderedY: (nodeId) => fixtureTarget(list, nodeId)?.renderedY ?? null,
    sendScroll: (elementId, offsetY) => {
      if (options.sendFails) {
        return null; // a closing socket: the engine must keep owing the send, not pretend it went out
      }
      const requestId = `r${scrolls.length + 1}`;
      scrolls.push({ elementId, offsetY, requestId });
      return requestId;
    },
    now: () => clock.t,
    raf: () => 0,
    caf: () => undefined
  });
  return {
    engine,
    sent,
    scrolls,
    setTargets: (next) => {
      list = next;
    },
    targets: () => list,
    step(ms: number) {
      clock.t += ms;
      engine.__frameForTest();
    },
    ack(index: number, offsetY: number) {
      const send = scrolls[index];
      engine.noteScrollAck({ requestId: send.requestId, offsetY, requestedY: send.offsetY, surface: "map" });
    },
    clock
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------

describe("eagerScroll — wheel coalescer math", () => {
  it("maps a Chrome pixel-mode notch to exactly one game notch", () => {
    expect(wheelEventToGamePx({ deltaY: 100, deltaMode: 0 }, 1)).toBe(WHEEL_NOTCH_PX);
    expect(wheelEventToGamePx({ deltaY: -300, deltaMode: 0 }, 1)).toBe(-3 * WHEEL_NOTCH_PX);
    expect(wheelEventToGamePx({ deltaY: 120, deltaMode: 0 }, 1)).toBe(WHEEL_NOTCH_PX);
  });

  it("maps Firefox LINE mode at 3 lines per notch", () => {
    expect(wheelEventToGamePx({ deltaY: 3, deltaMode: 1 }, 1)).toBe(WHEEL_NOTCH_PX);
    expect(wheelEventToGamePx({ deltaY: -6, deltaMode: 1 }, 1)).toBe(-2 * WHEEL_NOTCH_PX);
  });

  it("passes trackpad pixel deltas through 1:1, scaled into DESIGN px", () => {
    // A letterboxed stage painting the 1080-tall design box at 0.5x ⇒ 2 design px per CSS px.
    expect(wheelEventToGamePx({ deltaY: 17, deltaMode: 0 }, 2)).toBe(34);
    expect(wheelEventToGamePx({ deltaY: -4.5, deltaMode: 0 }, 1)).toBe(-4.5);
  });

  it("ignores a zero / non-finite delta", () => {
    expect(wheelEventToGamePx({ deltaY: 0, deltaMode: 0 }, 1)).toBe(0);
    expect(wheelEventToGamePx({ deltaY: Number.NaN, deltaMode: 0 }, 1)).toBe(0);
  });

});

// ---------------------------------------------------------------------------------------------------------------

describe("eagerScroll — clamping", () => {
  it("holds the map inside the game's own scroll window", () => {
    const t = mapTarget();
    expect(clampEager(t, 0)).toBe(0);
    expect(clampEager(t, -5000)).toBe(MAP_LIMIT_LO);
    expect(clampEager(t, 99999)).toBe(MAP_LIMIT_HI);
  });

  it("never invents travel on a grid whose content fits", () => {
    const t = gridTarget({ limitLo: 0, limitHi: 0 });
    expect(clampEager(t, -900)).toBe(0);
  });

  // R11 WS-S §2 — the materialized band ABSORBS, it does not yank.
  it("absorbs travel past the materialized rows, one viewport past the last one", () => {
    // Rows materialized over local y 0..1500 with a 1002-tall viewport: the strict band edge is 1002−1500 = −498,
    // and a viewport of slack takes the absorbing edge to −1500.
    const t = gridTarget({ band: { lo: 0, hi: 1500 } });
    expect(absorbBand(t, 0, -400, 1002)).toBe(-400); // well inside — untouched
    expect(absorbBand(t, 0, -3000, 1002)).toBe(-1500); // a flick is absorbed at the edge…
    // …and never REVERSED: a gesture already past the edge (the band narrowed under it, mid-recycle) simply stops
    // travelling further, rather than snapping the content back against the finger.
    expect(absorbBand(t, -2000, -2400, 1002)).toBe(-2000);
    // Travel back TOWARDS the band is always allowed, whatever side it starts on.
    expect(absorbBand(t, -2000, -1800, 1002)).toBe(-1800);
  });

  it("only ever absorbs against the direction of travel", () => {
    const t = gridTarget({ band: { lo: 400, hi: 1500 } });
    // The upper edge is −400 + 1002 = 602; going the other way is the lower edge's business, not this one's.
    expect(absorbBand(t, 0, 900, 1002)).toBe(602);
    expect(absorbBand(t, 900, 500, 1002)).toBe(500);
  });

  it("ignores a nonsense band (a mid-recycle frame) rather than pinning to it", () => {
    const t = gridTarget({ band: { lo: 3000, hi: 0 } });
    expect(absorbBand(t, 0, -300, 1002)).toBe(-300);
  });

  it("leaves the map alone — nothing about it is virtualized", () => {
    const t = mapTarget();
    expect(absorbBand(t, 0, -99999, 1080)).toBe(-99999);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("eagerScroll — scrollbar mapping inference", () => {
  it("fits the (offset → thumb Y) line from two observed rest pairs", () => {
    const m = inferBarMapping({ offset: 0, handleY: -36 }, { offset: -400, handleY: 100 });
    expect(m).not.toBeNull();
    expect(m!.slope).toBeCloseTo((100 - -36) / -400, 6);
    // Anchored on the NEWER sample, so a resync only moves the reference.
    expect(barHandleYFor(m!, -400)).toBeCloseTo(100, 6);
    expect(barHandleYFor(m!, 0)).toBeCloseTo(-36, 6);
    expect(barHandleYFor(m!, -200)).toBeCloseTo(32, 6);
  });

  it("refuses two samples too close together to carry a trustworthy slope", () => {
    expect(inferBarMapping({ offset: 0, handleY: 0 }, { offset: 3, handleY: 40 })).toBeNull();
    expect(inferBarMapping({ offset: 0, handleY: 0 }, { offset: 0, handleY: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("eagerScroll — the state machine", () => {
  it("moves the container locally on the same frame it sends an absolute offset", () => {
    const target = mapTarget();
    const h = harness([target]);

    // One notch UP over the map: the container offset grows by 40.
    expect(h.engine.wheel(960, 540, -WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 })).toBe(true);
    h.step(16);

    expect(h.engine.__entryForTest("map")).toEqual({ phase: "active", eagerY: -600 + WHEEL_NOTCH_PX });
    // The DOM carries eager − streamed straight away, while the host still shows -600.
    expect(target.el.style.translate).toBe(`0px ${WHEEL_NOTCH_PX.toFixed(2)}px`);
    expect(h.scrolls).toEqual([{ elementId: "map", offsetY: -600 + WHEEL_NOTCH_PX, requestId: "r1" }]);
    expect(h.sent).toEqual([]);
  });

  it("refuses a wheel outside every scrollable viewport", () => {
    const h = harness([gridTarget()]);
    expect(h.engine.wheel(960, 40, WHEEL_NOTCH_PX, { coordX: 960, coordY: 40 })).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it("settles cleanly: ACTIVE → SETTLING → IDLE as the streamed geometry arrives, translate cleared", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 });
    h.step(16);
    expect(h.engine.__entryForTest("map")!.phase).toBe("active");

    // The gesture ends; nothing streamed yet.
    h.step(ACTIVE_HOLD_MS + 1);
    expect(h.engine.__entryForTest("map")!.phase).toBe("settling");

    // The host's lerp lands.
    h.setTargets([{ ...target, streamedY: -600 + WHEEL_NOTCH_PX, renderedY: -600 + WHEEL_NOTCH_PX }]);
    h.step(16);
    expect(h.engine.__entryForTest("map")).toBeNull(); // IDLE entries are retired
    expect(target.el.style.translate).toBe("0px");
  });

  it("does not glide the offset away while the host answer is still in flight", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -5 * WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 });
    h.step(16);
    const eager = -600 + 5 * WHEEL_NOTCH_PX;
    h.step(ACTIVE_HOLD_MS + 1);
    expect(h.engine.__entryForTest("map")!.phase).toBe("settling");

    // A quarter of a second of ordinary link latency must not erase the local lead before the answer lands.
    h.step(SETTLE_STALL_MS + 1);
    h.step(SETTLE_STALL_MS + 1);
    expect(h.engine.__entryForTest("map")).toEqual({ phase: "settling", eagerY: eager });
    expect(target.el.style.translate).toBe(`0px ${(5 * WHEEL_NOTCH_PX).toFixed(2)}px`);

    // The answer arrives (the host lerps in) and the settle ends the quiet way.
    h.setTargets([{ ...target, streamedY: eager, renderedY: eager }]);
    h.step(16);
    expect(h.engine.__entryForTest("map")).toBeNull();
    expect(target.el.style.translate).toBe("0px");
  });


  it("HARD-SNAPS at the deadline when the streamed geometry never arrives at all", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -400, { coordX: 960, coordY: 540 });
    h.step(16);
    h.step(ACTIVE_HOLD_MS + 1);
    expect(h.engine.__entryForTest("map")!.phase).toBe("settling");

    // Keep the streamed offset MOVING (so the stall glide can never fire) but never reaching the eager value.
    let streamed = -600;
    for (let i = 0; i < 40; i++) {
      streamed -= 1; // moves, but away from the eager target
      h.setTargets([{ ...target, streamedY: streamed, renderedY: streamed }]);
      h.step(SETTLE_DEADLINE_MS / 20);
      if (h.engine.__entryForTest("map") === null) break;
    }
    expect(h.engine.__entryForTest("map")).toBeNull();
    expect(target.el.style.translate).toBe("0px");
  });

  it("HARD-RESETS when the scrollable disappears", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 });
    h.step(16);
    expect(target.el.style.translate).toBe(`0px ${WHEEL_NOTCH_PX.toFixed(2)}px`);

    h.setTargets([]); // screen change
    h.step(16);
    expect(h.engine.__entryForTest("map")).toBeNull();
  });

  it("HARD-RESETS when a tween pins the container", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 });
    h.step(16);
    h.setTargets([{ ...target, pinned: true }]);
    h.step(16);
    expect(h.engine.__entryForTest("map")).toBeNull();
    expect(target.el.style.translate).toBe("0px");
  });

  it("HARD-RESETS on demand (keyframe / reconnect / stretch toggle)", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 });
    h.step(16);
    h.engine.reset();
    expect(h.engine.__entryForTest("map")).toBeNull();
    expect(target.el.style.translate).toBe("0px");
  });

  it("re-asserts the translate on a RE-CREATED element", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 });
    h.step(16);

    // The renderer rebuilt the node: a brand-new element with no inline translate.
    const fresh = document.createElement("div");
    h.setTargets([{ ...target, el: fresh }]);
    h.step(16);
    expect(fresh.style.translate).toBe(`0px ${WHEEL_NOTCH_PX.toFixed(2)}px`);
  });

  it("absorbs a big flick at the materialized band's slack edge instead of yanking to it", () => {
    // A long deck: the GAME's own limit is far below, so the band's slack edge (1002 − 1500 − 1002) is what stops
    // the flick — one viewport past the last materialized row, not ON the last materialized row.
    const target = gridTarget({ limitLo: -3000, band: { lo: 0, hi: 1500 } });
    const h = harness([target]);
    h.engine.wheel(960, 500, 2000, { coordX: 960, coordY: 500 });
    h.step(16);
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(1002 - 1500 - 1002);
  });

  it("still refuses to leave the GAME's own window, band or no band", () => {
    const target = gridTarget({ band: { lo: 0, hi: 1500 } }); // limitLo = 1002 − 2400
    const h = harness([target]);
    h.engine.wheel(960, 500, 2000, { coordX: 960, coordY: 500 });
    h.step(16);
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(1002 - 2400);
  });

  it("the RESTING offset of a grid whose band starts at 0 is legal — no first-notch yank", () => {
    // The header merge (mirrorRenderer.eagerGridBand) reports lo: 0 for a grid scrolled to the top. One notch down
    // must move the content exactly one notch, not slam it to the top of the first card row.
    const target = gridTarget({ band: { lo: 0, hi: 1500 } });
    const h = harness([target]);
    h.engine.wheel(960, 500, WHEEL_NOTCH_PX, { coordX: 960, coordY: 500 });
    h.step(16);
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(-WHEEL_NOTCH_PX);
  });
});

// ---------------------------------------------------------------------------------------------------------------

// R11 WS-S §1 — THE SHAKE. The composed position of a scroll container is `base matrix + cosmetic translate` (CSS
// applies the `translate` property outside `transform`). Round 2 had TWO independent rAF writers for those two
// halves, so on the unlucky (and deterministic) ordering every reconciled frame painted `eagerY + one host lerp
// step`. These tests drive a simulated renderer — a "reconcile" writes the element's base matrix and hands the
// engine a fresh `renderedY` — and assert the composed sum against BOTH call orders.
describe("eagerScroll — single-writer composition", () => {
  // The two halves, read off the element exactly as the browser would compose them.
  function composedY(el: HTMLElement): number {
    const m = /matrix\(([^)]*)\)/.exec(el.style.transform);
    const base = m ? Number(m[1].split(",")[5]) : 0;
    const parts = (el.style.translate || "").trim().split(/\s+/);
    const dy = parts.length > 1 ? parseFloat(parts[1]) : 0;
    return base + (Number.isFinite(dy) ? dy : 0);
  }

  // One renderer walk: bake the host's latest position into the element's own matrix and republish the target with
  // the matching `renderedY` (which is what mirrorRenderer.baseTranslateY reads back off its style cache).
  function reconcileTo(h: Harness, target: DomTarget, y: number): DomTarget {
    target.el.style.transform = `matrix(1, 0, 0, 1, 0, ${y})`;
    const next = { ...target, streamedY: y, renderedY: y };
    h.setTargets([next]);
    return next;
  }

  it("holds the composed position at the eager offset while the host lerps underneath it", () => {
    const target = mapTarget();
    target.el.style.transform = "matrix(1, 0, 0, 1, 0, -600)";
    const h = harness([target]);
    h.engine.wheel(960, 540, -5 * WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 }); // 5 notches UP
    const eager = -600 + 5 * WHEEL_NOTCH_PX;
    h.step(16);
    expect(composedY(target.el)).toBeCloseTo(eager, 2);

    // The host answers in ~138px lerp steps. ORDER A: the walk lands first, then the compose seam.
    let live = target;
    for (let y = -600; y < eager; y += 138) {
      live = reconcileTo(h, live, Math.min(eager, y + 138));
      h.engine.afterReconcile();
      expect(composedY(live.el)).toBeCloseTo(eager, 2);
      h.step(16); // …and the engine's own frame, which must not move it either
      expect(composedY(live.el)).toBeCloseTo(eager, 2);
    }
  });

  it("holds it under the OTHER order too — engine frame first, walk second", () => {
    const target = mapTarget();
    target.el.style.transform = "matrix(1, 0, 0, 1, 0, -600)";
    const h = harness([target]);
    h.engine.wheel(960, 540, -5 * WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 });
    const eager = -600 + 5 * WHEEL_NOTCH_PX;
    h.step(16);

    let live = target;
    for (let y = -600; y < eager; y += 138) {
      h.step(16); // the engine's rAF runs BEFORE the walk this frame
      live = reconcileTo(h, live, Math.min(eager, y + 138));
      h.engine.afterReconcile();
      expect(composedY(live.el)).toBeCloseTo(eager, 2);
    }
  });

  it("composes only what is live: an idle engine reads no targets at all", () => {
    const target = mapTarget();
    let reads = 0;
    const clock = { t: 1000 };
    const engine = createEagerScroll({
      targets: () => {
        reads++;
        return [target];
      },
      send: () => undefined,
      sendScroll: () => null,
      designPerClientPx: () => 1,
      applyLocalOffset: () => undefined,
      scrollRenderedY: () => target.renderedY,
      now: () => clock.t,
      raf: () => 0,
      caf: () => undefined
    });
    engine.afterReconcile();
    expect(reads).toBe(0);
    engine.wheel(960, 540, WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 });
    reads = 0;
    engine.afterReconcile();
    expect(reads).toBe(1);
    engine.dispose();
  });

  it("hard-resets through the compose seam when a tween takes the container over", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 });
    h.step(16);
    h.setTargets([{ ...target, pinned: true }]);
    h.engine.afterReconcile();
    expect(h.engine.__entryForTest("map")).toBeNull();
    expect(target.el.style.translate).toBe("0px");
  });
});

// ---------------------------------------------------------------------------------------------------------------

// R11 WS-S §3 — what a scrollable may claim.
describe("eagerScroll — the claim surface", () => {
  const barBox = { minX: 1820, minY: 210, maxX: 1870, maxY: 952 };

  it("claims nothing on the scrollbar strip — that is the host's absolute channel", () => {
    const target = gridTarget({ scrollbarBox: barBox });
    const h = harness([target]);
    expect(h.engine.wheel(1840, 500, WHEEL_NOTCH_PX, { coordX: 1840, coordY: 500 })).toBe(false);
    expect(h.engine.beginPan(1840, 500)).toBeNull();
    expect(h.engine.compensate(1840, 500)).toEqual({ coordX: 1840, coordY: 500 });
    // …while the content next to it is claimed exactly as before.
    expect(h.engine.wheel(900, 500, WHEEL_NOTCH_PX, { coordX: 900, coordY: 500 })).toBe(true);
  });

  it("does NOT fall through to the scrollable underneath (a dialog's bar is not the map's wheel)", () => {
    const map = mapTarget();
    const grid = gridTarget({ scrollbarBox: barBox });
    const h = harness([map, grid]);
    expect(h.engine.wheel(1840, 500, WHEEL_NOTCH_PX, { coordX: 1840, coordY: 500 })).toBe(false);
    expect(h.engine.__entryForTest("map")).toBeNull();
  });

});

// ---------------------------------------------------------------------------------------------------------------

describe("eagerScroll — pan", () => {
  it("follows the finger 1:1 and sends the resulting absolute offset", () => {
    const target = mapTarget();
    const h = harness([target]);
    expect(h.engine.beginPan(960, 500)).toBe("absolute");
    h.engine.panTo(620); // finger dragged 120px down
    h.step(16);
    expect(h.engine.__entryForTest("map")!.eagerY).toBe(-480);
    expect(target.el.style.translate).toBe("0px 120.00px");
    expect(h.scrolls).toEqual([{ elementId: "map", offsetY: -480, requestId: "r1" }]);
    expect(h.sent).toEqual([]);
  });

  // R11 WS-S §6 — a press is a CLAIM, not a scroll.
  it("a held press defers local movement until the finger moves", () => {
    const target = mapTarget();
    const h = harness([target]);
    expect(h.engine.beginPan(960, 500)).toBe("absolute");
    h.step(16);
    // No entry, no translate — whatever the stream does to this container is simply what the player sees.
    expect(h.engine.__entryForTest("map")).toBeNull();
    expect(target.el.style.translate).toBe("");

    // Geometry can update while the hold is still below the activation threshold…
    h.setTargets([{ ...target, streamedY: -420, renderedY: -420 }]);
    h.step(16);
    expect(target.el.style.translate).toBe("");

    // …and a hair of finger travel is still not a scroll.
    h.engine.panTo(500 + PAN_ACTIVATE_PX - 0.5);
    h.step(16);
    expect(h.engine.__entryForTest("map")).toBeNull();
  });

  it("activates on the first real motion, from where the host has got to (not from the press)", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.beginPan(960, 500);
    // The host moved 180px under the hold; the drag must start from THERE, or the content teleports on the first
    // millimetre of travel.
    const moved = { ...target, streamedY: -420, renderedY: -420 };
    h.setTargets([moved]);
    h.step(16);
    h.engine.panTo(560); // 60px of finger travel
    h.step(16);
    expect(h.engine.__entryForTest("map")!.eagerY).toBe(-360);
    expect(moved.el.style.translate).toBe("0px 60.00px");
  });

  it("claims a grid drag as absolute, over a card as readily as over empty space", () => {
    const h = harness([gridTarget({ wheelSafe: { x: 87, y: 581 } })]);
    expect(h.engine.beginPan(900, 500, { ids: 1, blocked: false, source: "press" })).toBe("absolute");
    expect(h.engine.panMode()).toBe("absolute");
  });

  it("refuses a grid drag that started on a BLOCKING widget (a button, the scrollbar)", () => {
    const h = harness([gridTarget()]);
    expect(h.engine.beginPan(900, 500, { ids: 0, blocked: true, source: "press" })).toBeNull();
  });

  it("moves the grid 1:1 with the finger and sends its absolute offset", () => {
    const target = gridTarget({ wheelSafe: { x: 87, y: 581 }, limitLo: -3000 });
    const h = harness([target]);
    h.engine.beginPan(900, 500, { ids: 1, blocked: false, source: "press" });
    h.engine.panTo(300); // dragged 200px UP the screen ⇒ the content goes up ⇒ the offset decreases
    h.step(16);
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(-200);
    expect(target.el.style.translate).toBe("0px -200.00px");
    expect(h.scrolls).toEqual([{ elementId: "grid", offsetY: -200, requestId: "r1" }]);
    expect(h.sent).toEqual([]);
    h.engine.endPan();
    expect(h.scrolls.at(-1)).toEqual({ elementId: "grid", offsetY: -200, requestId: "r1" });
  });

  it("is exempt from compensation while it runs, and compensating again the moment it ends", () => {
    // The gesture's own driver is fed the RAW pointer Y — a compensation there would feed the eager lead straight
    // back into the delta producing it (each frame's dy would shrink by the lead it just created).
    const target = gridTarget({ wheelSafe: { x: 87, y: 581 }, limitLo: -3000 });
    const h = harness([target]);
    h.engine.beginPan(900, 500, { ids: 0, blocked: false, source: "press" });
    h.engine.panTo(400);
    h.step(16);
    expect(h.engine.compensate(900, 500)).toEqual({ coordX: 900, coordY: 500 });
    h.engine.endPan();
    expect(h.engine.compensate(900, 500)).toEqual({ coordX: 900, coordY: 600 });
  });

  it("refuses to pan outside a scrollable", () => {
    const h = harness([gridTarget()]);
    expect(h.engine.beginPan(960, 20)).toBeNull();
    expect(h.engine.panActive()).toBe(false);
  });

});

// ---------------------------------------------------------------------------------------------------------------

// R11 WS-S §7 — while a drawing tool is armed the map does not scroll AT ALL (a product decision: on a phone the
// scroll and the stroke are the same finger, and a stroke drawn onto moving parchment is unreadable — the native
// game does allow it). §8 — a two-finger scroll is the same engine, not a separate stepper.
describe("eagerScroll — a suppressed scrollable", () => {
  it("CLAIMS a wheel over the armed map and sends nothing at all", () => {
    const target = mapTarget({ suppressed: true });
    const h = harness([target]);
    // True = claimed: the caller must not emit any other action either.
    expect(h.engine.wheel(960, 540, -WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 })).toBe(true);
    h.step(16);
    expect(h.sent).toEqual([]);
    expect(h.engine.__entryForTest("map")).toBeNull();
    expect(target.el.style.translate).toBe("");
  });

  it("DECLINES a press, so the press+motion passes through and the host draws", () => {
    const h = harness([mapTarget({ suppressed: true })]);
    expect(h.engine.beginPan(960, 540, { ids: 0, blocked: false, source: "press" })).toBeNull();
    expect(h.engine.panActive()).toBe(false);
  });

  it("SWALLOWS a two-finger gesture — claimed, and deliberately inert", () => {
    const h = harness([mapTarget({ suppressed: true })]);
    expect(h.engine.beginPan(960, 540, { ids: 0, blocked: false, source: "gesture" })).toBe("swallow");
    expect(h.engine.panActive()).toBe(false);
    h.step(16);
    expect(h.sent).toEqual([]);
  });

  it("goes back to scrolling the moment the tool is put away", () => {
    const target = mapTarget({ suppressed: true });
    const h = harness([target]);
    h.engine.wheel(960, 540, -WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 });
    h.setTargets([{ ...target, suppressed: false }]);
    expect(h.engine.wheel(960, 540, -WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 })).toBe(true);
    h.step(16);
    expect(h.scrolls).toEqual([{ elementId: "map", offsetY: -520, requestId: "r1" }]);
    expect(h.sent).toEqual([]);
  });

  it("claims a two-finger gesture over the map as absolute", () => {
    const target = mapTarget();
    const h = harness([target]);
    expect(h.engine.beginPan(960, 540, { ids: 0, blocked: false, source: "gesture" })).toBe("absolute");
    h.engine.panTo(700); // fingers dragged 160px DOWN ⇒ the content follows
    h.step(16);
    expect(h.engine.__entryForTest("map")!.eagerY).toBe(-600 + 160);
    expect(target.el.style.translate).toBe("0px 160.00px");
    expect(h.scrolls).toEqual([{ elementId: "map", offsetY: -440, requestId: "r1" }]);
    expect(h.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("eagerScroll — upstream Y compensation", () => {
  it("reports the GAME coordinate while the local offset runs ahead", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -120, { coordX: 960, coordY: 540 }); // eager -480, streamed still -600
    h.step(16);
    // A tap at screen y=540 is over the content the game has at 540 − 120.
    expect(h.engine.compensate(960, 540)).toEqual({ coordX: 960, coordY: 420 });
    // X is never touched (the scroll is vertical), and a point outside the viewport is untouched entirely.
    expect(h.engine.compensate(960, 2000)).toEqual({ coordX: 960, coordY: 2000 });
  });

  it("is identity once the host has caught up", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -120, { coordX: 960, coordY: 540 });
    h.step(16);
    h.setTargets([{ ...target, streamedY: -480, renderedY: -480 }]);
    h.step(ACTIVE_HOLD_MS + 1);
    expect(h.engine.compensate(960, 540)).toEqual({ coordX: 960, coordY: 540 });
  });

  it("exempts a pan from compensation while the semantic action is pending", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.beginPan(960, 500);
    h.engine.panTo(620);
    h.step(16);
    expect(h.engine.compensate(960, 540)).toEqual({ coordX: 960, coordY: 540 });
    // Once the pan ends, the accumulated lead IS compensated again.
    h.engine.endPan();
    expect(h.engine.compensate(960, 540)).toEqual({ coordX: 960, coordY: 420 });
  });

  it("exempts a pan armed while a wheel lead is outstanding", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -120, { coordX: 960, coordY: 540 }); // eager -480, streamed -600 ⇒ lead 120
    h.step(16);
    h.engine.beginPan(960, 500);
    expect(h.engine.compensate(960, 540)).toEqual({ coordX: 960, coordY: 540 });
    // Dragging further keeps pointer input in the pan's local coordinate space.
    h.engine.panTo(700);
    h.step(16);
    expect(h.engine.compensate(960, 540)).toEqual({ coordX: 960, coordY: 540 });
  });

  it("lets the TOPMOST scrollable claim a point two viewports overlap", () => {
    const map = mapTarget();
    const grid = gridTarget();
    // Paint order: the grid dialog is painted over the map.
    const h = harness([map, grid]);
    h.engine.wheel(960, 500, 80, { coordX: 960, coordY: 500 });
    h.step(16);
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(-80);
    expect(h.engine.__entryForTest("map")).toBeNull();
    // The grid ran 80px UP the content, so a tap at screen y=500 is over the game's y=580.
    expect(h.engine.compensate(960, 500)).toEqual({ coordX: 960, coordY: 580 });
  });

  it("ignores a sub-epsilon delta rather than nudging every coordinate", () => {
    const target = mapTarget();
    const h = harness([target]);
    h.engine.wheel(960, 540, -(SETTLE_EPS_PX - 0.5), { coordX: 960, coordY: 540 });
    h.step(16);
    expect(h.engine.compensate(960, 540)).toEqual({ coordX: 960, coordY: 540 });
  });
});

// ---------------------------------------------------------------------------------------------------------------

// R19 WP5 — SCROLL AUTHORITY. The client stops asking for travel and states a position; the game clamps it to its
// own limits and answers with the clamped value. The tests that matter most are the two DISCRIMINATION ones: a
// client-driven scroll the game must follow, and a game-driven one the client must follow.
describe("eagerScroll — scroll authority: the absolute channel", () => {
  it("sends the offset itself without ordinary input", () => {
    const h = authorityHarness([mapTarget()]);
    // 55px of trackpad travel preserves the exact position the player left locally.
    h.engine.wheel(960, 540, -55, { coordX: 960, coordY: 540 });
    h.step(16);
    expect(h.scrolls).toEqual([{ elementId: "map", offsetY: -545, requestId: "r1" }]);
    expect(h.sent).toEqual([]); // the semantic action is the only transport for this gesture
  });

  it("addresses the scroll container by its own node id — the id the action resolves", () => {
    const h = authorityHarness([gridTarget({ id: "43704649279" })]);
    h.engine.wheel(960, 500, WHEEL_NOTCH_PX, { coordX: 960, coordY: 500 });
    h.step(16);
    expect(h.scrolls[0].elementId).toBe("43704649279");
  });

  it("coalesces mid-gesture sends, and NEVER throttles away the release position", () => {
    const target = mapTarget();
    const h = authorityHarness([target]);
    h.engine.beginPan(960, 500);
    h.engine.panTo(560);
    h.step(16);
    expect(h.scrolls).toHaveLength(1);

    // Two more frames inside the coalescing window: the offset keeps moving locally, but nothing new goes out.
    h.engine.panTo(570);
    h.step(8);
    h.engine.panTo(580);
    h.step(8);
    expect(h.scrolls).toHaveLength(1);
    expect(h.engine.__entryForTest("map")!.eagerY).toBe(-520);

    // Past the window, the current position is stated…
    h.engine.panTo(590);
    h.step(SCROLL_SEND_MIN_MS);
    expect(h.scrolls).toHaveLength(2);
    expect(h.scrolls[1].offsetY).toBe(-510);

    // …and the RELEASE goes out regardless of both gates, one pixel of travel or not. This is the send that
    // decides where the game comes to rest.
    h.engine.panTo(591);
    h.engine.endPan();
    expect(h.scrolls).toHaveLength(3);
    expect(h.scrolls[2].offsetY).toBe(-509);
  });

  it("keeps OWING a send the socket refused, instead of pretending it went out", () => {
    const h = authorityHarness([mapTarget()], { sendFails: true });
    h.engine.wheel(960, 540, -55, { coordX: 960, coordY: 540 });
    h.step(16);
    expect(h.scrolls).toEqual([]);
    expect(h.engine.__authorityForTest("map")).toEqual({
      authoredY: null,
      ackedY: null,
      requestId: null,
      resent: false
    });
  });

  // DISCRIMINATION, DIRECTION 1 — THE CLIENT LED, THE GAME FOLLOWS. The player's stated preference.
  it("ends EXACTLY where the client was: the game is told the offset and lands on it", () => {
    const target = mapTarget();
    const h = authorityHarness([target]);
    h.engine.wheel(960, 540, -55, { coordX: 960, coordY: 540 });
    h.step(16);
    const settledAt = -545;
    expect(h.engine.__entryForTest("map")!.eagerY).toBe(settledAt);

    // The gesture ends; the answer is still in flight, so the client holds its position rather than guessing.
    h.step(ACTIVE_HOLD_MS + 1);
    expect(h.engine.__entryForTest("map")).toEqual({ phase: "settling", eagerY: settledAt });

    // The game accepted the whole travel (its clamp did not bite) and then paints it.
    h.ack(0, settledAt);
    h.step(16);
    expect(h.engine.__entryForTest("map")!.eagerY).toBe(settledAt);
    h.setTargets([{ ...target, streamedY: settledAt, renderedY: settledAt }]);
    h.step(16);

    // EQUALITY, not a bound: the eager offset was never adopted, glided or snapped away from where the player
    // left it, and the container is now painted there.
    expect(h.engine.__entryForTest("map")).toBeNull();
    expect(target.el.style.translate).toBe("0px");
    expect(h.targets()[0].streamedY).toBe(settledAt);
  });

  it("glides to the GAME's own clamp when it refuses the travel we asked for", () => {
    // The client's limit formula is a reconstruction of the game's; here the game's real bottom is 1000px short.
    const target = gridTarget({ limitLo: -3000 });
    const h = authorityHarness([target]);
    h.engine.wheel(960, 500, 5000, { coordX: 960, coordY: 500 });
    h.step(16);
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(-3000);
    expect(h.scrolls[0].offsetY).toBe(-3000);

    h.step(ACTIVE_HOLD_MS + 1);
    h.ack(0, -2000); // the game clamped
    h.step(16);
    expect(h.engine.__entryForTest("grid")!.phase).toBe("glide");

    h.step(SETTLE_GLIDE_MS + 1);
    // Landed on the game's answer — and deliberately back in SETTLING rather than idle, because the container has
    // not travelled there yet and clearing the translate now would jump by the remaining catch-up.
    expect(h.engine.__entryForTest("grid")).toEqual({ phase: "settling", eagerY: -2000 });

    h.setTargets([{ ...target, streamedY: -2000, renderedY: -2000 }]);
    h.step(16);
    expect(h.engine.__entryForTest("grid")).toBeNull();
    expect(target.el.style.translate).toBe("0px");
  });

  // DISCRIMINATION, DIRECTION 2 — THE GAME MOVED IT ITSELF, THE CLIENT FOLLOWS. The player's one exception.
  it("follows the GAME when the paint settles somewhere the game never acked", () => {
    const target = mapTarget();
    const h = authorityHarness([target]);
    h.engine.wheel(960, 540, -55, { coordX: 960, coordY: 540 });
    h.step(16);
    h.step(ACTIVE_HOLD_MS + 1);
    h.ack(0, -545); // the game agreed with us…

    // …and then something else moved the map entirely: an act-change slide, another seat's input, a re-layout.
    const moved = { ...target, streamedY: -900, renderedY: -900 };
    h.setTargets([moved]);
    h.step(16); // the paint MOVED — the evidence the stall window waits for
    h.step(SETTLE_STALL_MS + 1); // …and then stopped, at an offset that is not the one the game acked
    expect(h.engine.__entryForTest("map")!.phase).toBe("glide");

    h.step(SETTLE_GLIDE_MS + 1);
    expect(h.engine.__entryForTest("map")).toBeNull();
    expect(moved.el.style.translate).toBe("0px");
  });

  it("does NOT read a stalled paint as the game moving it while the ack is still in flight", () => {
    // The same stillness, minus the ack. Before the answer comes back, still paint means "in flight" and nothing
    // else — reading it as a game-initiated move would erase the local lead before the response arrives.
    const target = mapTarget();
    const h = authorityHarness([target]);
    h.engine.wheel(960, 540, -5 * WHEEL_NOTCH_PX, { coordX: 960, coordY: 540 });
    h.step(16);
    h.step(ACTIVE_HOLD_MS + 1);
    const moved = { ...target, streamedY: -450, renderedY: -450 };
    h.setTargets([moved]);
    h.step(16);
    h.step(SETTLE_STALL_MS + 1);
    expect(h.engine.__entryForTest("map")).toEqual({ phase: "settling", eagerY: -600 + 5 * WHEEL_NOTCH_PX });
  });

  it("RE-SENDS once at the deadline (an absolute send is idempotent), then adopts the paint", () => {
    const target = mapTarget();
    const h = authorityHarness([target]);
    h.engine.wheel(960, 540, -55, { coordX: 960, coordY: 540 });
    h.step(16);
    h.step(ACTIVE_HOLD_MS + 1);
    expect(h.scrolls).toHaveLength(1);

    // Nothing ever comes back — the message was dropped.
    h.step(SETTLE_DEADLINE_MS + 1);
    expect(h.scrolls).toEqual([
      { elementId: "map", offsetY: -545, requestId: "r1" },
      { elementId: "map", offsetY: -545, requestId: "r2" }
    ]);
    expect(h.engine.__authorityForTest("map")!.resent).toBe(true);
    expect(h.engine.__entryForTest("map")!.phase).toBe("settling");

    // A second silent window and the ancient backstop wins: the player must never be left looking at a position
    // the game does not agree with.
    h.step(SETTLE_DEADLINE_MS + 1);
    expect(h.engine.__entryForTest("map")).toBeNull();
    expect(target.el.style.translate).toBe("0px");
    expect(h.scrolls).toHaveLength(2);
  });

  it("ignores a STALE ack — an earlier send of the same gesture is about a position already scrolled past", () => {
    const target = mapTarget();
    const h = authorityHarness([target]);
    h.engine.beginPan(960, 500);
    h.engine.panTo(560);
    h.step(16);
    h.engine.panTo(700);
    h.step(SCROLL_SEND_MIN_MS);
    expect(h.scrolls).toHaveLength(2);

    // The FIRST send's answer arrives late, carrying a nonsense value. The entry is listening for r2 only.
    h.ack(0, -12345);
    expect(h.engine.__authorityForTest("map")).toMatchObject({ ackedY: null, requestId: "r2" });
    h.ack(1, h.scrolls[1].offsetY);
    expect(h.engine.__authorityForTest("map")!.ackedY).toBe(h.scrolls[1].offsetY);
  });
});

// ---------------------------------------------------------------------------------------------------------------

// R19 WP5 §"absolute" — the current claim surface.
describe("eagerScroll — scroll authority: the claim", () => {
  it("claims a MAP drag as ABSOLUTE, so the caller withholds the press it could not get accepted", () => {
    const h = authorityHarness([mapTarget()]);
    expect(h.engine.beginPan(960, 500)).toBe("absolute");
    expect(h.engine.panMode()).toBe("absolute");
    expect(panClaimWithholdsPress("absolute")).toBe(true);

    h.engine.panTo(620);
    h.step(16);
    // The content followed the finger locally, and the whole upstream half is the stated offset.
    expect(h.engine.__entryForTest("map")!.eagerY).toBe(-480);
    expect(h.sent).toEqual([]);
    expect(h.scrolls).toEqual([{ elementId: "map", offsetY: -480, requestId: "r1" }]);
  });

  it("claims a grid drag as absolute too — preserving its withheld press", () => {
    const h = authorityHarness([gridTarget({ wheelSafe: { x: 87, y: 581 }, limitLo: -3000 })]);
    expect(h.engine.beginPan(900, 500, { ids: 1, blocked: false, source: "press" })).toBe("absolute");
    h.engine.panTo(300);
    h.step(16);
    expect(h.sent).toEqual([]);
    expect(h.scrolls).toEqual([{ elementId: "grid", offsetY: -200, requestId: "r1" }]);
  });

  it("claims a two-finger gesture as ABSOLUTE", () => {
    const h = authorityHarness([mapTarget()]);
    expect(h.engine.beginPan(960, 540, { ids: 0, blocked: false, source: "gesture" })).toBe("absolute");
  });

  it("leaves every REFUSAL exactly as it was — a widget, a block, a suppressed map", () => {
    const h = authorityHarness([mapTarget(), gridTarget()]);
    expect(h.engine.beginPan(960, 500, { ids: 1, blocked: false, source: "press" })).toBe("absolute"); // grid: cards don't disqualify
    expect(h.engine.beginPan(900, 500, { ids: 0, blocked: true, source: "press" })).toBeNull();
    const suppressed = authorityHarness([mapTarget({ suppressed: true })]);
    expect(suppressed.engine.beginPan(960, 540, { ids: 0, blocked: false, source: "press" })).toBeNull();
    expect(suppressed.engine.beginPan(960, 540, { ids: 0, blocked: false, source: "gesture" })).toBe("swallow");
  });

  it("is exempt from compensation while it runs, like every other claim that sends no press", () => {
    const h = authorityHarness([mapTarget()]);
    h.engine.wheel(960, 540, -120, { coordX: 960, coordY: 540 }); // a lead is outstanding
    h.step(16);
    h.engine.beginPan(960, 500);
    h.engine.panTo(700);
    h.step(16);
    expect(h.engine.compensate(960, 540)).toEqual({ coordX: 960, coordY: 540 });
    h.engine.endPan();
    // The live lead is compensated again the moment the gesture ends.
    expect(h.engine.compensate(960, 540).coordY).toBeLessThan(540);
  });
});

// ---------------------------------------------------------------------------------------------------------------

// R19 WP5 §"bar" — the card grid's SCROLLBAR strip becomes the client's own absolute channel.
describe("eagerScroll — scroll authority: the scrollbar", () => {
  const barBox = { minX: 1820, minY: 200, maxX: 1870, maxY: 1000 };
  const withBar = (over: Partial<DomTarget> = {}) =>
    gridTarget({ scrollbarBox: barBox, limitLo: -2400, limitHi: 0, ...over });

  it("maps a press to a fraction of the WHOLE strip, with no handle compensation (the game's own rule)", () => {
    expect(barFraction(barBox, 200)).toBe(0);
    expect(barFraction(barBox, 600)).toBe(0.5);
    expect(barFraction(barBox, 1000)).toBe(1);
    // Outside the strip is pinned rather than extrapolated — a drag that runs off the end holds the end.
    expect(barFraction(barBox, -50)).toBe(0);
    expect(barFraction(barBox, 5000)).toBe(1);

    const target = withBar();
    expect(barOffsetFor(target, 200)).toBe(0);
    expect(barOffsetFor(target, 600)).toBe(-1200);
    expect(barOffsetFor(target, 1000)).toBe(-2400);
  });

  it("claims a press on the TRACK and jumps the grid there on the same frame", () => {
    const target = withBar();
    const h = authorityHarness([target]);
    // Three quarters down the track — nowhere near the thumb, which is the press that used to do nothing at all.
    expect(h.engine.beginBarPan(1845, 800)).toBe("bar");
    expect(h.engine.panMode()).toBe("bar");
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(-1800);
    h.step(16);
    expect(target.el.style.translate).toBe("0px -1800.00px");
    expect(h.scrolls).toEqual([{ elementId: "grid", offsetY: -1800, requestId: "r1" }]);
    expect(h.sent).toEqual([]);
  });

  it("tracks a bar DRAG by position, not by delta — the strip is an absolute control", () => {
    const h = authorityHarness([withBar()]);
    h.engine.beginBarPan(1845, 400);
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(-600);
    h.engine.panTo(1000);
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(-2400);
    // …and back up, which a delta-driven gesture would have had to unwind step by step.
    h.engine.panTo(200);
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(0);
    h.engine.endPan();
    expect(h.scrolls.at(-1)!.offsetY).toBe(0);
  });

  it("does NOT band-absorb a bar jump: the game goes there, so the client must too", () => {
    // The materialized rows stop well above the jump. An absolute request is a statement, and stopping short of it
    // would put client and game in different places.
    const h = authorityHarness([withBar({ band: { lo: 0, hi: 1500 } })]);
    h.engine.beginBarPan(1845, 1000);
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(-2400);
  });

  it("refuses the bar off the strip or on a suppressed surface", () => {
    const target = withBar();
    // Off the strip is an ordinary content point, which this entry point never claims.
    expect(authorityHarness([target]).engine.beginBarPan(900, 800)).toBeNull();
    // …and a suppressed surface claims nothing at all.
    expect(authorityHarness([withBar({ suppressed: true })]).engine.beginBarPan(1845, 800)).toBeNull();
  });

  it("keeps the strip carved out of the content surface — a wheel there is still nobody's", () => {
    const h = authorityHarness([withBar()]);
    expect(h.engine.wheel(1845, 800, WHEEL_NOTCH_PX, { coordX: 1845, coordY: 800 })).toBe(false);
    expect(h.engine.beginPan(1845, 800)).toBeNull();
    expect(h.engine.compensate(1845, 800)).toEqual({ coordX: 1845, coordY: 800 });
  });
});

// ---------------------------------------------------------------------------------------------------------------

// R21 — WHOSE POINT IS IT, and WHAT IS THE PLAYER DOING WITH IT. Two live defects, one shape: the claim was pure
// geometry, decided at the press.
//   * a card-selection dialog's confirm button overlaps the strip, and every press of it that landed on the strip
//     was claimed by the bar and WITHHELD, so only the part of the button clear of the strip could be clicked;
//   * the strip is a ~50px sliver at the frame's right edge, exactly where a thumb's arc lands mid-swipe, and the
//     claim jumped the grid to that contact point before the gesture had said what it was.
describe("eagerScroll — the scrollbar claims what the player is touching", () => {
  const barBox = { minX: 1820, minY: 200, maxX: 1870, maxY: 1000 };
  const withBar = (over: Partial<DomTarget> = {}) =>
    gridTarget({ scrollbarBox: barBox, scrollbarRenderedBox: barBox, limitLo: -2400, limitHi: 0, ...over });

  it("refuses a point something else is painted on top of — and the CONTENT takes it instead", () => {
    const h = authorityHarness([withBar()]);
    expect(h.engine.beginBarPan(1845, 800, { barOccluded: true })).toBeNull();
    // The whole point of the refusal: the gesture is claimed by the grid, so its press is still withheld. Left
    // unclaimed it would go upstream at a coordinate the GAME reads as its own scrollbar, which is the same
    // hijack one layer down.
    expect(h.engine.beginPan(1845, 800, { ids: 0, blocked: false, source: "press", barOccluded: true })).toBe(
      "absolute"
    );
  });

  it("refuses a point that is not the strip AS PAINTED — same fall-through (R20's band, R21's residue)", () => {
    const h = authorityHarness([withBar({ scrollbarRenderedBox: { ...barBox, minX: 2420, maxX: 2470 } })]);
    expect(h.engine.beginBarPan(1845, 800, { rawDesignX: 2400 })).toBeNull();
    expect(h.engine.beginPan(1845, 800, { ids: 0, blocked: false, source: "press", rawDesignX: 2400 })).toBe(
      "absolute"
    );
    // On the strip as painted, the bar still owns it — and the content claim still refuses it.
    expect(h.engine.beginPan(1845, 800, { ids: 0, blocked: false, source: "press", rawDesignX: 2445 })).toBeNull();
  });

  it("a BUTTON on top does not become a grid pan either — that press is the button's", () => {
    const h = authorityHarness([withBar()]);
    expect(
      h.engine.beginPan(1845, 800, { ids: 0, blocked: true, source: "press", barOccluded: true })
    ).toBeNull();
  });

  it("DEFERRED (a finger on the track): nothing happens on contact, and a TAP commits on the release", () => {
    const h = authorityHarness([withBar()]);
    expect(h.engine.beginBarPan(1845, 800, { deferred: true })).toBe("bar");
    expect(h.engine.__entryForTest("grid")).toBeNull(); // no entry, no translate, no send
    expect(h.scrolls).toEqual([]);
    h.engine.panTo(803); // finger jitter, still tap-sized
    expect(h.scrolls).toEqual([]);
    h.engine.endPan();
    // Committed where the finger LIFTED (y=803 ⇒ 0.75375 of the strip), which is within the tap slop of where it
    // went down — the same "the release is the gesture's last position" rule every other claimed gesture ends on.
    expect(h.scrolls).toEqual([{ elementId: "grid", offsetY: -1809, requestId: "r1" }]);
    expect(h.sent).toEqual([]);
  });

  it("DEFERRED: a SWIPE hands the gesture to the content, with the travel since the press applied whole", () => {
    const h = authorityHarness([withBar({ streamedY: -1200, renderedY: -1200 })]);
    h.engine.beginBarPan(1845, 800, { deferred: true });
    // 300px of finger travel UP the screen: content, 1:1 from the press — not the −2400 the strip's own mapping
    // would have named for a press at y=800, and not a jump of any kind.
    h.engine.panTo(500);
    expect(h.engine.panMode()).toBe("absolute");
    expect(h.engine.__entryForTest("grid")!.eagerY).toBe(-1500);
    h.engine.endPan();
    expect(h.scrolls.at(-1)!.offsetY).toBe(-1500);
    expect(h.sent).toEqual([]);
  });

});

// ---------------------------------------------------------------------------------------------------------------

describe("eagerScroll — scroll authority acknowledgements", () => {
  it("an ack for a surface nobody is scrolling is dropped without a trace", () => {
    const h = authorityHarness([mapTarget()]);
    h.engine.noteScrollAck({ requestId: "nobody", offsetY: -1, requestedY: null, surface: null });
    expect(h.engine.__authorityForTest("map")).toBeNull();
  });
});
