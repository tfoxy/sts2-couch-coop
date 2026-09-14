import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { playZoneThreshold } from "@spirectl/presentation/render";

import {
  createInputCapture,
  LONG_PRESS_MS,
  PEEK_MS,
  type InputCapture
} from "@/mirror/inputCapture";
import { pointInPlacedRect } from "@/mirror/raiseInverse";
import { pushOutOfNearMiss, resetNearMissMemory } from "@/mirror/pointerMap";
import { viewScaleForwardBox, type ViewScaleInputStamp } from "@/mirror/viewScaleInverse";
import { MIRROR_DESIGN_HEIGHT } from "@/mirror/sceneTree";
import type { InteractiveRect } from "@/mirror/mirrorRenderer";
import type { MirrorInputMessage } from "@/mirror/mirrorClient";

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

// Stub document.elementsFromPoint with a z-stack of NODE elements (topmost first) for the visual-anchor map.
// Each entry becomes a div carrying the streamed `data-node-id` (+ optional `data-paints` / `data-spread-dx` /
// `data-spread-w`), with a fixed client rect. Returns a probe counter so a test can pin how many times the map
// read the DOM (the phone-CPU / frozen-shift property).
function stubNodeStack(
  ...nodes: Array<{ id?: string; paints?: boolean; spreadDx?: string; spreadW?: string; prop?: boolean; rect?: DOMRect }>
): { probes: () => number } {
  const els = nodes.map((n) => {
    const el = document.createElement("div");
    if (n.id != null) el.setAttribute("data-node-id", n.id);
    if (n.paints) el.setAttribute("data-paints", "1");
    if (n.spreadDx != null) el.setAttribute("data-spread-dx", n.spreadDx);
    if (n.spreadW != null) el.setAttribute("data-spread-w", n.spreadW);
    if (n.prop) el.setAttribute("data-spread-mode", "prop");
    el.getBoundingClientRect = () => n.rect ?? rect(0, 0, 0, 0);
    return el;
  });
  let count = 0;
  (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => {
    count++;
    return els;
  };
  return { probes: () => count };
}

let stage: HTMLElement;
let sent: MirrorInputMessage[];
let capture: InputCapture;
let frames: FrameRequestCallback[];

// Flush queued animation-frame callbacks (mirrors real rAF: the id is returned synchronously, the callback
// runs LATER — which is what lets onPointerMove coalesce moves between frames).
function flushFrames(): void {
  const pending = frames.splice(0);
  for (const cb of pending) {
    cb(0);
  }
}

beforeEach(() => {
  document.body.innerHTML = "";
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});

  stage = document.createElement("div");
  document.body.appendChild(stage);
  // Stage = half-scale of the 1920x1080 design space (e.g. a 1280x720 browser letterboxed to 960x540 here).
  stage.getBoundingClientRect = () => rect(0, 0, 960, 540);

  sent = [];
  capture = createInputCapture(stage, (message) => sent.push(message));
});

afterEach(() => {
  capture.dispose();
  vi.unstubAllGlobals();
  // Drop any per-test elementsFromPoint stub so unrelated tests see no scene.
  delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
});

describe("createInputCapture", () => {
  it("sends a hover with the cursor's DESIGN-space coordinate", () => {
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(sent).toHaveLength(1);
    // 480/960 * 1920 = 960, 270/540 * 1080 = 540 (screen center → design center).
    expect(sent[0]).toMatchObject({ kind: "hover", coordX: 960, coordY: 540 });
    expect(sent[0].coordX).toBe(960);
  });

  it("on a WIDENED stage, a hover over a painting node maps to its SHIFTED game coordinate", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520);
    // A painting node carrying a +300 anchor shift, occupying a sub-rect of the stage (not a full-span backdrop).
    stubNodeStack({ id: "4242", paints: true, spreadDx: "300", rect: rect(100, 100, 200, 100) });
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    // fraction 0.5 → 0.5·2520 = 1260 design-x; minus the node's +300 shift → 960. 270/540·1080 = 540.
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 960, coordY: 540 });
  });

  it("on a WIDENED stage, skips non-painting overlays and maps through the first painter beneath", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520);
    // Top→down: two non-painting layers (a transparent transition ColorRect, a boxless group), then the painter.
    stubNodeStack(
      { id: "overlay", rect: rect(0, 0, 960, 540) },
      { id: "passthrough", rect: rect(0, 0, 960, 540) },
      { id: "999", paints: true, spreadDx: "300", rect: rect(400, 0, 200, 100) }
    );
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    // The painter's +300 shift wins: 0.5·2520 − 300 = 960.
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 960, coordY: 540 });
  });

  it("on a WIDENED stage with nothing painting under the pointer, uses the uniform fallback", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520);
    // A background element with a shift but NO data-paints → not an anchor; the map falls back to a uniform squeeze.
    stubNodeStack({ id: "bg", spreadDx: "300", rect: rect(0, 0, 960, 540) });
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    // Uniform fallback: designX 1260 · 1920/2520 = 960.
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 960, coordY: 540 });
  });

  it("on a WIDENED stage, a click press+release maps to shifted coordinates (never an elementId)", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520);
    stubNodeStack({ id: "77", paints: true, spreadDx: "300", rect: rect(0, 0, 200, 100) });
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(sent.map((m) => `${m.kind}:${m.pressed}`)).toEqual(["click:true", "click:false"]);
    // 0.5·2520 − 300 = 960 for both press and release.
    expect(sent[0]).toMatchObject({ coordX: 960, coordY: 540, pressed: true });
    expect(sent.at(-1)).toMatchObject({ coordX: 960, pressed: false });
  });

  it("on a WIDENED stage, a drag FREEZES the press-time shift and probes the DOM only on press + release", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520);
    const { probes } = stubNodeStack({ id: "card", paints: true, spreadDx: "300", rect: rect(0, 0, 200, 100) });
    // Press at the center → ONE probe, freezing shift 300.
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(probes()).toBe(1);
    // Two drag-motion frames → NO further probes (pure frozen math — the phone-CPU / no-teleport property).
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 600, clientY: 300, bubbles: true }));
    flushFrames();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 700, clientY: 350, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(1);
    // Release resolves FRESH → one more probe.
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 700, clientY: 350, bubbles: true }));
    expect(probes()).toBe(2);
    // The drag hovers used the FROZEN shift 300: 600/960·2520 − 300 = 1275; they stay plain (no `pressed`).
    const hovers = sent.filter((m) => m.kind === "hover");
    expect(hovers[0]).toMatchObject({ coordX: 1275 });
    expect(hovers.every((m) => m.pressed === undefined)).toBe(true);
  });

  it("a drag begun on a PROP element replays the world SQUEEZE across the whole world", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520);
    // A proportional world element (a card): data-spread-mode="prop". Press freezes the squeeze field, not −dx.
    stubNodeStack({ id: "card", paints: true, spreadDx: "300", prop: true, rect: rect(0, 0, 200, 100) });
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    // Press coord is the EXACT local hit: 0.5·2520 − 300 = 960.
    expect(sent.at(-1)).toMatchObject({ kind: "click", pressed: true, coordX: 960 });
    // Drag to clientX 600 → designX 1575; frozen squeeze replays 1575·1920/2520 = 1200 (NOT 1575 − 300 = 1275).
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 600, clientY: 300, bubbles: true }));
    flushFrames();
    expect(sent.filter((m) => m.kind === "hover").at(-1)).toMatchObject({ coordX: 1200 });
  });

  it("a drag begun on an ANCHORED element replays its fixed translation", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520);
    // An anchored HUD element (no data-spread-mode): press freezes the translation affine {a:1, b:−300}.
    stubNodeStack({ id: "slider", paints: true, spreadDx: "300", rect: rect(0, 0, 200, 100) });
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", pressed: true, coordX: 960 });
    // Drag to clientX 600 → designX 1575; translation replays 1575 − 300 = 1275.
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 600, clientY: 300, bubbles: true }));
    flushFrames();
    expect(sent.filter((m) => m.kind === "hover").at(-1)).toMatchObject({ coordX: 1275 });
  });

  it("consults the interactive-rects provider on press/release (even painter hits) but NEVER on drag frames", () => {
    capture.dispose();
    sent = [];
    let providerCalls = 0;
    const provider = (): InteractiveRect[] => {
      providerCalls++;
      return [];
    };
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520, provider);
    // Painter hits are vetted too: same-frame overlaps are self-exempt (coord = designX − dx tests the SAME point
    // as the rendered-containment check), but a coord landing in a DIFFERENT-frame rect is a mismap even when the
    // painter was exact (the map parchment's transparent torn-edge box covers the whole TopBar band).
    stubNodeStack({ id: "card", paints: true, spreadDx: "300", prop: true, rect: rect(0, 0, 200, 100) });
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    const afterPress = providerCalls;
    expect(afterPress).toBeGreaterThan(0);
    // Drag-motion frames → pure frozen math, ZERO provider calls (the phone-CPU rule).
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 600, clientY: 300, bubbles: true }));
    flushFrames();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 700, clientY: 350, bubbles: true }));
    flushFrames();
    expect(providerCalls).toBe(afterPress); // no calls between press and release
    // Release resolves fresh → provider consulted again.
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 700, clientY: 350, bubbles: true }));
    expect(providerCalls).toBeGreaterThan(afterPress);
  });

  it("on a 16:9 stage, input stays coordinate-based with ZERO DOM probes even with a node under the pointer", () => {
    // Default design width == MIRROR_DESIGN_WIDTH → the elementsFromPoint probe is skipped entirely.
    const { probes } = stubNodeStack({ id: "4242", paints: true, spreadDx: "300", rect: rect(100, 100, 200, 100) });
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, clientY: 150, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(0);
    // 200/960 * 1920 = 400, 150/540 * 1080 = 300 (the shift is ignored — 16:9 design space IS game space).
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 400, coordY: 300 });
  });
});

describe("createInputCapture — five-to-four raised-hand settlement", () => {
  it("keeps the locally lifted fourth survivor and its native pressed:true coordinate on the same holder at dy 0", () => {
    capture.dispose();
    sent = [];
    const fourth = {
      transform: [1, 0, 0, 1, 1100, 800] as [number, number, number, number, number, number],
      localRect: { x: 0, y: 0, width: 300, height: 422 },
      spreadDx: 200,
      dy: 0,
      ownerId: "holder-fourth",
    };
    capture = createInputCapture(
      stage,
      (m) => sent.push(m),
      () => 2520,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      () => [fourth],
      {
        touchStackAt: () => ({ ids: [], blocked: false, blockKind: null, topStamp: null }),
        spreadPainterAt: () => ({ dx: 0, prop: false, widthPx: 20 }),
        raisedHandVisualClaimAt: () => ({ ownerId: "holder-fourth" }),
      },
    );

    // Client -> widened design (1405, 1000), a locally lifted fourth-holder pixel after the game has
    // already settled that holder's own raise at zero. The coordinate-only protocol must press its native OBB.
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 535.7142857, clientY: 500, bubbles: true }));
    const press = sent.find((message) => message.kind === "click" && message.pressed === true)!;
    expect(press.coordX).not.toBeCloseTo(1405, 3);
    expect(press.coordY).toBeCloseTo(1000, 3);
    expect(pointInPlacedRect(fourth.transform, fourth.localRect, press.coordX!, press.coordY!)).toBe(true);
  });

  it("04-32 freezes the press-time touch owner through delayed slop after its down-edge hover re-poses the fan", () => {
    capture.dispose();
    const recorded = [
      // focused: native local (388.15, 65.49), 88px beyond the right native edge
      {
        point: { x: 1438.1473, y: 725.4943 },
        transform: [1, 0, 0, 1, 1050, 660] as [number, number, number, number, number, number],
        localRect: { x: 0, y: 0, width: 300, height: 422 },
        spreadDx: 0,
        dy: 0,
        expected: { x: null, y: 725.4943, tolerance: 0 },
      },
      {
        // The actual later resting stamp: raw Y is pre-inverse and the composed OBB requires X arbitration too.
        point: { x: 1334.6665, y: 854 },
        transform: [0.79221445, 0.11133849, -0.11133849, 0.79221445, 1104.6603556, 871.1419434] as [number, number, number, number, number, number],
        localRect: { x: 0, y: 0, width: 300, height: 422 },
        spreadDx: 196.7,
        dy: -119,
        expected: { x: 1321.99, y: 970.22, tolerance: 2 },
      },
    ];
    for (const [index, sample] of recorded.entries()) {
      sent = [];
      const defragment = {
        transform: sample.transform,
        localRect: sample.localRect,
        spreadDx: sample.spreadDx,
        dy: sample.dy,
        ownerId: "holder-defragment",
      };
      capture = createInputCapture(
        stage,
        (message) => sent.push(message),
        () => 2401,
        undefined,
        undefined,
        { isCard: (id) => id === "defragment-card", isHandCard: (id) => id === "defragment-card" },
        undefined,
        undefined,
        undefined,
        () => [defragment],
        {
          touchStackAt: () => ({ ids: ["defragment-card"], blocked: false, blockKind: null, topStamp: "other" }),
          spreadPainterAt: () => ({ dx: 0, prop: false, widthPx: 20 }),
          // The independent pixel provenance probe reproduces the missed recording; only the already-proven touch
          // target may bridge this exact holder through the down-edge focus/reflow.
          raisedHandVisualClaimAt: () => null,
          raisedHandTouchTargetClaim: (id) => id === "defragment-card" ? { ownerId: "holder-defragment" } : null,
        },
      );
      const clientX = sample.point.x / 2401 * 960;
      const clientY = sample.point.y / 1080 * 540;
      stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 32 + index, clientX, clientY }));
      // Delayed slop classification must use the claim captured above, not re-query after the down-edge hover.
      stage.dispatchEvent(touchEvent("pointermove", { pointerId: 32 + index, clientX, clientY: clientY - 16 }));

      const ownershipSensitive = sent.filter((message) => message.kind === "hover" || (message.kind === "click" && message.pressed === true));
      expect(ownershipSensitive).toHaveLength(2);
      for (const message of ownershipSensitive) {
        expect(pointInPlacedRect(defragment.transform, defragment.localRect, message.coordX!, message.coordY!)).toBe(true);
        expect(message).not.toHaveProperty("ownerId");
        expect(message).not.toHaveProperty("cardId");
        expect(message).not.toHaveProperty("elementId");
        expect(message).not.toHaveProperty("handAnchor");
      }
      for (const message of ownershipSensitive) {
        if (sample.expected.x === null) {
          expect(message.coordY).toBeCloseTo(sample.expected.y, 6);
        } else {
          expect(Math.hypot(message.coordX! - sample.expected.x, message.coordY! - sample.expected.y)).toBeLessThan(sample.expected.tolerance);
        }
      }
      expect(ownershipSensitive[1]).toMatchObject({ kind: "click", pressed: true });
      capture.dispose();
    }
  });

  it("does not bridge an unstamped glow or dead-space stack entry into a raised-card claim", () => {
    capture.dispose();
    sent = [];
    let bridgeCalls = 0;
    capture = createInputCapture(
      stage,
      (message) => sent.push(message),
      () => 2520,
      undefined,
      undefined,
      { isCard: () => false, isHandCard: () => false },
      undefined,
      undefined,
      undefined,
      () => [{
        transform: [1, 0, 0, 1, 1050, 660] as [number, number, number, number, number, number],
        localRect: { x: 0, y: 0, width: 300, height: 422 },
        spreadDx: 0,
        dy: 0,
        ownerId: "holder-defragment",
      }],
      {
        touchStackAt: () => ({ ids: ["decorative-glow"], blocked: false, blockKind: null, topStamp: "other" }),
        spreadPainterAt: () => ({ dx: 0, prop: false, widthPx: 20 }),
        raisedHandVisualClaimAt: () => null,
        raisedHandTouchTargetClaim: () => { bridgeCalls++; return { ownerId: "holder-defragment" }; },
      },
    );
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 1438.1473 / 2520 * 960, clientY: 725.4943 / 1080 * 540 }));
    expect(bridgeCalls).toBe(0);
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 1438.1473, coordY: 725.4943 });
  });

  it("uses renderer ownership to correct the exact pre-canonical fourth-card point after near-miss X canonicalization", () => {
    capture.dispose();
    sent = [];
    const fourth = {
      transform: [0.7922144, 0.1113385, -0.1113385, 0.7922144, 1104.6602, 871.1421] as [number, number, number, number, number, number],
      localRect: { x: -150, y: -211, width: 300, height: 422 },
      spreadDx: 196.7,
      dy: -119,
      ownerId: "holder-fourth",
    };
    // Its game rect contains the pre-canonical X but its rendered rect is +200px away, so the retained
    // near-miss pass canonically pushes 1261.218 left to 1244.016 before the raise arbiter runs.
    const canonicalizer: InteractiveRect = {
      id: "wide-near-miss",
      transform: [1, 0, 0, 1, 1245, 800],
      localRect: { x: 0, y: 0, width: 300, height: 300 },
      spreadDx: 200,
      renderedWidth: 0,
      raiseDy: 0,
    };
    capture = createInputCapture(
      stage,
      (m) => sent.push(m),
      () => 2520,
      () => [canonicalizer],
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      () => [fourth],
      {
        touchStackAt: () => ({ ids: [], blocked: false, blockKind: null, topStamp: null }),
        spreadPainterAt: () => ({ dx: 0, prop: false, widthPx: 20 }),
        raisedHandVisualClaimAt: () => ({ ownerId: "holder-fourth" }),
      },
    );
    // stage client → widened design (1261.218, 836.4), the point from the reported fifth-played recording.
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480.464, clientY: 418.2, bubbles: true }));
    flushFrames();
    const hover = sent.at(-1)!;
    expect(hover).toMatchObject({ kind: "hover" });
    // The canonicalizer first reaches 1244.016; final local-X arbitration may inset further to keep the sent
    // point on the rotated fourth-card OBB.  The regression is the post-canonical raised Y, not a raw X replay.
    expect(hover.coordX).toBeLessThan(1244.016);
    // The local-X inset is rotated, so final arbitration may carry Y a few px; it must retain the provisional
    // 119px raise correction rather than returning the raw 836.4 point.
    expect((hover.coordY ?? 0) - 836.4).toBeGreaterThan(110);
  });
});

// --- hover-probe memo (WS3): a widened-stage hover flush within HOVER_REPROBE_PX/MS of the last fresh probe
// replays its field affine with pure math instead of paying another elementsFromPoint walk (see hoverCoord in
// inputCapture.ts). Press/release/wheel/tap/peek always resolve fresh and refresh the memo for free; 16:9 stays
// exactly as before (mapPointerToGame already probes zero times there). Time is driven by a mocked
// `performance.now` (the same pattern mirrorTween.spec.ts uses) so the time bound is deterministic.
// R10-PERF6 WS-P1 widened the bounds to 64 viewport px / 250ms (`?hoverReprobePx=`/`?hoverReprobeMs=` restore the
// old 24/120) — a plain move is the ONLY thing the memo covers. -------------------------------------------------

describe("createInputCapture — hover-probe memo (widened stage)", () => {
  let clock = 0;

  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a burst of hovers within 64px/250ms of the last probe sends exactly 1 probe; every move's sent coord still tracks the cursor via the memoized affine (matching what a fresh probe would give)", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520);
    const { probes } = stubNodeStack({ id: "4242", paints: true, spreadDx: "300", rect: rect(100, 100, 200, 100) });

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(1);
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 960, coordY: 540 });

    // Two more moves, each within HOVER_REPROBE_PX (64 viewport px of the LAST probe) and well inside
    // HOVER_REPROBE_MS — both replay the memoized anchored-translation affine {a:1, b:-300} with pure math.
    clock += 10;
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 490, clientY: 275, bubbles: true }));
    flushFrames();
    clock += 10;
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 500, clientY: 280, bubbles: true }));
    flushFrames();

    expect(probes()).toBe(1); // still ONE elementsFromPoint call — the DOM was never re-probed
    const hovers = sent.filter((m) => m.kind === "hover");
    expect(hovers).toHaveLength(3);
    // The painter never moved, so a fresh probe at these points would give the SAME affine — the memoized coords
    // must match that fraction·2520 − 300 formula exactly.
    expect(hovers[1]).toMatchObject({ coordX: (490 / 960) * 2520 - 300, coordY: (275 / 540) * 1080 });
    expect(hovers[2]).toMatchObject({ coordX: (500 / 960) * 2520 - 300, coordY: (280 / 540) * 1080 });
  });

  it("movement beyond HOVER_REPROBE_PX forces a re-probe", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520);
    const { probes } = stubNodeStack({ id: "4242", paints: true, spreadDx: "300", rect: rect(100, 100, 200, 100) });

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(1);

    // 70 viewport px away (euclidean) — past the 64px bound — even though well within the time bound.
    clock += 5;
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 550, clientY: 270, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(2);
  });

  it("elapsed time beyond HOVER_REPROBE_MS forces a re-probe even with negligible movement", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520);
    const { probes } = stubNodeStack({ id: "4242", paints: true, spreadDx: "300", rect: rect(100, 100, 200, 100) });

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(1);

    // A 3px move (well within HOVER_REPROBE_PX) but the mocked clock has advanced past HOVER_REPROBE_MS (250ms).
    clock += 300;
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 483, clientY: 271, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(2);
  });

  it("a pointerdown/up mid-burst always resolves fresh, and refreshes the memo for the hovers that follow", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520);
    const { probes } = stubNodeStack({ id: "4242", paints: true, spreadDx: "300", rect: rect(100, 100, 200, 100) });

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(1);

    // A press+release at a nearby point — EXACT probing always, never memoized, regardless of the hover bounds.
    clock += 10;
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 485, clientY: 272, bubbles: true }));
    expect(probes()).toBe(2); // press never reuses the hover memo
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 485, clientY: 272, bubbles: true }));
    expect(probes()).toBe(3); // release resolves fresh too

    // The next hover — close to the press/release point and soon after — replays the REFRESHED memo (from the
    // release's fresh probe), so it costs NO further DOM probe.
    clock += 10;
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 490, clientY: 275, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(3);
  });

  it("a memoized hover flush still applies the near-miss push-out over the CURRENT retained rects", () => {
    capture.dispose();
    sent = [];
    // An anchored button at game-space x∈[900,1100] (full height, never rendered-shifted: spreadDx 0). The
    // UNRELATED painter's +300 anchor shift maps the pointer's game X to 960 — INSIDE the button's game rect —
    // while the pointer's own design-X (1260) is NOT inside the button's (spreadDx-0) rendered rect, so the
    // near-miss pass must push the coordinate back out (a pointer visually nowhere near the button).
    const button: InteractiveRect = {
      id: "btn",
      transform: [1, 0, 0, 1, 900, 0],
      localRect: { x: 0, y: 0, width: 200, height: 1080 },
      spreadDx: 0,
      renderedWidth: 0,
      raiseDy: 0
    };
    let providerCalls = 0;
    const provider = (): InteractiveRect[] => {
      providerCalls++;
      return [button];
    };
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520, provider);
    const { probes } = stubNodeStack({ id: "4242", paints: true, spreadDx: "300", rect: rect(100, 100, 200, 100) });

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(1);
    const afterFirst = providerCalls;
    expect(afterFirst).toBeGreaterThan(0);
    const expectedFirst = pushOutOfNearMiss(960, 540, 1260, [button]);
    expect(expectedFirst).not.toBe(960); // sanity: this scenario really does trigger a push
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: expectedFirst, coordY: 540 });

    // A second hover within reprobe bounds → MEMOIZED (no further elementsFromPoint call), but the near-miss pass
    // still runs each flush against the CURRENT retained rects (no DOM read either way).
    clock += 10;
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 485, clientY: 272, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(1); // still just the one DOM probe
    expect(providerCalls).toBeGreaterThan(afterFirst); // near-miss rects were consulted again on the memoized flush
    const rawSecond = (485 / 960) * 2520 - 300; // same anchored-translation affine {a:1, b:-300} as the first probe
    const designXSecond = (485 / 960) * 2520;
    const gameYSecond = (272 / 540) * 1080;
    const expectedSecond = pushOutOfNearMiss(rawSecond, gameYSecond, designXSecond, [button]);
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: expectedSecond, coordY: gameYSecond });
  });

  it("on a 16:9 stage, a burst of hovers still probes ZERO times (unaffected by the memo, before AND after)", () => {
    const { probes } = stubNodeStack({ id: "4242", paints: true, spreadDx: "300", rect: rect(100, 100, 200, 100) });

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, clientY: 150, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(0);

    clock += 10;
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 205, clientY: 152, bubbles: true }));
    flushFrames();
    clock += 200; // past HOVER_REPROBE_MS — irrelevant on 16:9, which never probes in the first place
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, clientY: 300, bubbles: true }));
    flushFrames();
    expect(probes()).toBe(0);
  });
});

describe("createInputCapture — misc", () => {
  it("keeps following the cursor as it moves (no element-change debounce)", () => {
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 100, bubbles: true }));
    flushFrames();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 200, bubbles: true }));
    flushFrames();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 700, clientY: 500, bubbles: true }));
    flushFrames();
    expect(sent.filter((m) => m.kind === "hover")).toHaveLength(3);
    expect(sent.at(-1)).toMatchObject({ coordX: 1400, coordY: 1000 });
  });

  it("coalesces multiple moves within a frame into one hover (latest position wins)", () => {
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    expect(sent).toHaveLength(0); // nothing sent until the frame fires
    flushFrames();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ coordX: 960, coordY: 540 }); // the LATEST move
  });

  it("replays a tap as press→release (a click in-game) and prevents the default (text selection)", () => {
    const down = new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true, cancelable: true });
    stage.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true); // stops the browser starting a text selection
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "left", pressed: true, coordX: 960, coordY: 540 });

    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "left", pressed: false, coordX: 960, coordY: 540 });
  });

  it("replays a drag as press → (plain) hover moves → release", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 0, clientY: 0, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 700, clientY: 500, bubbles: true }));
    flushFrames();
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 700, clientY: 500, bubbles: true }));

    const kinds = sent.map((m) => `${m.kind}:${m.pressed ?? ""}`);
    expect(kinds).toEqual(["click:true", "hover:", "hover:", "click:false"]);
    // Moves during the drag stay plain hovers — the producer applies the held-button mask to make them a drag.
    expect(sent.filter((m) => m.kind === "hover").every((m) => m.pressed === undefined)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "left", pressed: false, coordX: 1400, coordY: 1000 });
  });

  it("prevents the context menu and replays right-click via pointerdown/up", () => {
    const menu = new MouseEvent("contextmenu", { clientX: 0, clientY: 0, bubbles: true, cancelable: true });
    stage.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(sent.filter((m) => m.kind === "click")).toHaveLength(0); // the menu event itself sends nothing

    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 2, clientX: 0, clientY: 0, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 2, clientX: 0, clientY: 0, bubbles: true }));
    expect(sent.map((m) => `${m.kind}:${m.button}:${m.pressed}`)).toEqual([
      "click:right:true",
      "click:right:false"
    ]);
  });

  it("synthesizes a release on pointercancel so a held button never sticks", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    sent = [];
    stage.dispatchEvent(new MouseEvent("pointercancel", { clientX: 480, clientY: 270, bubbles: true }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "left", pressed: false });
  });

  it("sends a key message with modifiers and ignores key repeats", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE", shiftKey: true }));
    expect(sent.at(-1)).toMatchObject({ kind: "key", key: "KeyE", modifiers: "shift" });

    sent = [];
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE", repeat: true }));
    expect(sent).toHaveLength(0);
  });

  it("does not capture keys while typing in an editable field", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
    expect(sent.filter((m) => m.kind === "key")).toHaveLength(0);
  });

  it("forwards mouse-wheel ticks as wheel-up / wheel-down clicks", () => {
    const up = new WheelEvent("wheel", { deltaY: -1, clientX: 480, clientY: 270, bubbles: true, cancelable: true });
    stage.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "wheel-up", coordX: 960, coordY: 540 });
    expect(sent.at(-1)!.pressed).toBeUndefined();

    stage.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, clientX: 480, clientY: 270, bubbles: true }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "wheel-down" });
  });
});

// --- TOUCH gestures (pointerType === "touch") -------------------------------------------------------------

// jsdom's MouseEvent can't carry pointerType/pointerId, so define them on the synthetic event.
function touchEvent(
  type: string,
  opts: { pointerId?: number; clientX?: number; clientY?: number; button?: number } = {}
): MouseEvent {
  const { pointerId = 1, clientX = 0, clientY = 0, button = 0 } = opts;
  const ev = new MouseEvent(type, { button, clientX, clientY, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "pointerType", { value: "touch" });
  Object.defineProperty(ev, "pointerId", { value: pointerId });
  return ev;
}

// Make elementsFromPoint resolve a z-stack of hover-first widgets (topmost first) so a touch can be identified.
// The renderer stamps each widget's id as data-touch-id on every descendant; touchTargetsAt reads the stack.
// Returns a probe counter so a test can pin how many times the touch path actually paid the forced hit test (the
// WS-2 drag-probe throttle). Every restub resets the count.
function stubTouchStack(...touchIds: string[]): { probes: () => number } {
  const els = touchIds.map((id) => {
    const el = document.createElement("div");
    el.setAttribute("data-touch-id", id);
    return el;
  });
  let count = 0;
  (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => {
    count++;
    return els;
  };
  return { probes: () => count };
}

describe("createInputCapture — touch", () => {
  // R16 tap-arm debounce: nowMs() reads `performance.now`, so a controllable clock lets a test place a re-tap
  // precisely inside/outside TAP_ARM_DEBOUNCE_MS of the arm. Frozen at 0 unless a test advances it — the REAL
  // elapsed wall-clock time inside a synchronous test body is near-zero, so without this every re-tap-commit here
  // would otherwise land inside the debounce window and be wrongly swallowed.
  let clock = 0;
  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // Drop the per-test elementsFromPoint stub so non-listed-touch tests see no scene.
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it("emits exactly one hover at the down point on the PRIMARY touch's down edge (sent directly, not coalesced)", () => {
    stubTouchStack("card-1");
    // The touch-start counts as a hover: the down edge sends it IMMEDIATELY, without waiting for a frame flush.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]);
    // Flushing frames adds nothing (the queued-hover slot was dropped on down — no duplicate at the same point).
    flushFrames();
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]);
  });

  it("does NOT down-hover for a SECOND (two-finger) finger — only the primary hovers", () => {
    stubTouchStack("card-1");
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 1, clientX: 480, clientY: 270 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]); // primary hovers
    // A second finger (a two-finger latch) must not add its own hover.
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 2, clientX: 520, clientY: 270 }));
    expect(sent).toHaveLength(1);
    expect(sent.filter((m) => m.kind === "hover")).toHaveLength(1);
  });

  it("does NOT down-hover for a stray finger arriving mid-drag", () => {
    // Finger 1 starts a drag (press fired). A stray finger 2 during the drag never hovers.
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 1, clientX: 0, clientY: 0 }));
    stage.dispatchEvent(touchEvent("pointermove", { pointerId: 1, clientX: 480, clientY: 270 }));
    flushFrames();
    sent = [];
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 2, clientX: 700, clientY: 500 }));
    expect(sent).toHaveLength(0); // the stray finger adds nothing
  });

  it("first tap on a hover-first widget arms a HOVER (no click); second tap on it CLICKS", () => {
    stubTouchStack("card-1");

    // Tap 1 → the down edge hovers (touch-start counts as a hover), then the arm hovers again on lift; no click.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]); // the immediate down-hover
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 }, // down-hover
      { kind: "hover", coordX: 960, coordY: 540 } //  arm-hover on lift
    ]);

    sent = [];
    // Tap 2 on the same scene instance, past TAP_ARM_DEBOUNCE_MS since the tap-1 arm → the down-hover, then a full
    // click (no `pressed` ⇒ host does press+release).
    clock += 300;
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "left", coordX: 960, coordY: 540 }
    ]);

    sent = [];
    // Tap 3 on the SAME widget → still down-hover then click (the widget stays armed after a commit).
    clock += 300;
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "left", coordX: 960, coordY: 540 }
    ]);
  });

  it("activates an authoritatively focused target in one tap, with focus latched at press time", () => {
    stubTouchStack("reward-1");
    let focused = true;
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (message) => sent.push(message), undefined, undefined, undefined, {
      isFocused: (id) => id === "reward-1" && focused
    });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    focused = false; // a later delta cannot change this gesture's press-time answer
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "left", coordX: 960, coordY: 540 }
    ]);
  });

  it("reports the press-time touch target before its down-hover can change focus", () => {
    stubTouchStack("reward-1");
    const noteTouchTarget = vi.fn();
    capture.dispose();
    capture = createInputCapture(stage, (message) => sent.push(message), undefined, undefined, undefined, {
      isFocused: (id) => id === "reward-1",
      noteTouchTarget
    });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    expect(noteTouchTarget).toHaveBeenCalledWith("reward-1");
  });

  it("does not let the touch-down hover turn an initially unfocused target into a same-tap activation", () => {
    stubTouchStack("reward-1");
    let focused = false;
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (message) => sent.push(message), undefined, undefined, undefined, {
      isFocused: () => focused
    });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    focused = true; // models the focus caused by the existing down-hover arriving before release
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "hover", coordX: 960, coordY: 540 }
    ]);
  });

  it("makes programmatic reward focus immediately one-tap ready without the arm debounce", () => {
    stubTouchStack("reward-1");
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (message) => sent.push(message), undefined, undefined, undefined, {
      isFocused: () => false
    });

    capture.focusTarget("reward-1", 123, 456);
    expect(sent).toEqual([{ kind: "hover", coordX: 123, coordY: 456 }]);
    sent = [];
    // clock is still zero: an ordinary freshly-armed re-tap would be swallowed for 200ms.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "left", coordX: 960, coordY: 540 }
    ]);

    capture.clearProgrammaticFocus();
    sent = [];
    stubTouchStack("reward-2");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent.every((message) => message.kind === "hover")).toBe(true);
  });

  it("can send programmatic hover without one-tap readiness for an older host", () => {
    stubTouchStack("reward-1");
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (message) => sent.push(message), undefined, undefined, undefined, {
      isFocused: () => false
    });

    capture.focusTarget("reward-1", 123, 456, false);
    sent = [];
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "hover", coordX: 960, coordY: 540 }
    ]);
  });

  it("recognizes a focused lower-stack wrapper only where its native interactive descendant owns the press", () => {
    capture.dispose();
    sent = [];
    const focusedHit: InteractiveRect = {
      id: "focused-hit",
      transform: [1, 0, 0, 1, 900, 500],
      localRect: { x: 0, y: 0, width: 120, height: 80 },
      spreadDx: 0,
      renderedWidth: 0,
      raiseDy: 0
    };
    capture = createInputCapture(
      stage,
      (message) => sent.push(message),
      undefined,
      () => [focusedHit],
      undefined,
      { isFocused: (id) => id === "focused-row" },
      undefined,
      undefined,
      undefined,
      undefined,
      {
        touchStackAt: () => ({
          ids: ["covering-sibling", "focused-row"],
          blocked: false,
          blockKind: null,
          topStamp: "other"
        }),
        spreadPainterAt: () => null,
        raisedHandVisualClaimAt: () => null,
        isUnderNode: (id, ancestorId) => id === "focused-hit" && ancestorId === "focused-row"
      }
    );

    // (960,540) lies inside focusedHit: the focused lower-stack row activates immediately.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "left", coordX: 960, coordY: 540 });

    // The same overlapping visual stack at native y=700 is outside that row. It must focus the covering target,
    // not treat the unrelated focused row elsewhere in the stack as permission to click through.
    sent = [];
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 2, clientX: 480, clientY: 350 }));
    stage.dispatchEvent(touchEvent("pointerup", { pointerId: 2, clientX: 480, clientY: 350 }));
    expect(sent.some((message) => message.kind === "click")).toBe(false);
    expect(sent.every((message) => message.kind === "hover")).toBe(true);
  });

  it("R16: swallows a re-tap of the armed widget WITHIN TAP_ARM_DEBOUNCE_MS of the arm (no click, stays armed)", () => {
    stubTouchStack("card-1");
    // Tap 1 arms card-1 at clock=0.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    sent = [];

    // A re-tap 150ms later (< the 200ms debounce) is an accidental double-tap: down-hover only, NO click, and the
    // widget stays armed.
    clock += 150;
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]);

    // A THIRD tap past the debounce window (measured from the ORIGINAL arm, not the swallowed tap) commits.
    sent = [];
    clock += 100; // clock is now 250 — past the original arm (0) by 250ms
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "left", coordX: 960, coordY: 540 }
    ]);
  });

  it("R16: commits a re-tap once TAP_ARM_DEBOUNCE_MS has elapsed since the arm", () => {
    stubTouchStack("card-1");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 })); // arm at clock=0
    sent = [];

    clock = 250; // past the 200ms debounce
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "left", coordX: 960, coordY: 540 }
    ]);
  });

  it("tapping empty space after a commit disarms, so the next tap on a widget hovers first again", () => {
    stubTouchStack("card-1");
    // Arm then commit card-1 (past TAP_ARM_DEBOUNCE_MS so the re-tap isn't swallowed).
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    clock += 300;
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));

    sent = [];
    // Tap empty space (no touch-id) → the down-hover, then an immediate click + DISARM.
    stubTouchStack();
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 100 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 100, clientY: 100 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 200, coordY: 200 },
      { kind: "click", button: "left", coordX: 200, coordY: 200 }
    ]);

    sent = [];
    // Now card-1 again → down-hover then the arm HOVER (it was disarmed), not click.
    stubTouchStack("card-1");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "hover", coordX: 960, coordY: 540 }
    ]);
  });

  it("re-tapping the armed option commits it even when overlapping options share the stack", () => {
    // Event option buttons overlap, so the stack has more than one id. Pure-topmost identity: opt-1 is on top,
    // so re-tapping COMMITS opt-1 (the armed widget under the finger) rather than re-arming the neighbour.
    stubTouchStack("opt-1", "opt-2");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 }, // down-hover
      { kind: "hover", coordX: 960, coordY: 540 } //  first tap arms opt-1
    ]);

    sent = [];
    clock += 300; // past TAP_ARM_DEBOUNCE_MS so the re-tap isn't swallowed
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 }, // down-hover
      { kind: "click", button: "left", coordX: 960, coordY: 540 } // re-tap commits opt-1
    ]);
  });

  it("tapping a different card arms it (its overlay can't occlude — mouse_filter=Ignore ⇒ pointer-events:none)", () => {
    stubTouchStack("card-A");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 }, // down-hover
      { kind: "hover", coordX: 960, coordY: 540 } //  arm card-A
    ]);

    sent = [];
    // card-A is hovered/enlarged, but the renderer now marks its decorative glow `pointer-events:none`, so
    // tapping card-B's spot hit-tests to [card-B] alone → arm B, never commit A. (Pure-topmost identity: the
    // topmost data-touch-id is the widget the game would target.)
    stubTouchStack("card-B");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 50, clientY: 500 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 50, clientY: 500 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 100, coordY: 1000 }, // down-hover
      { kind: "hover", coordX: 100, coordY: 1000 } //  arm B, no click
    ]);
  });

  it("a button (data-touch-block) over a hover-first widget = immediate click, no fall-through", () => {
    // z-stack: a Skip button on top (block), a card behind it (touch-id). Tapping must click, not arm a hover.
    const block = document.createElement("div");
    block.setAttribute("data-touch-block", "1");
    const card = document.createElement("div");
    card.setAttribute("data-touch-id", "card-behind");
    (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => [block, card];

    // The primary down still hovers (unconditional), then the block button clicks immediately (no fall-through).
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "left", coordX: 960, coordY: 540 }
    ]);
  });

  it("tap on a NON-listed target clicks immediately (no elementsFromPoint scene)", () => {
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]); // the immediate down-hover; press still deferred
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "left", coordX: 960, coordY: 540 }
    ]);
  });

  it("replays a touch DRAG as press → (plain) hovers → release", () => {
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 0, clientY: 0 }));
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 480, clientY: 270 }));
    flushFrames();
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 700, clientY: 500 }));
    flushFrames();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 700, clientY: 500 }));

    const kinds = sent.map((m) => `${m.kind}:${m.pressed ?? ""}`);
    // A leading down-hover (the touch-start), then the deferred press → plain drag hovers → release.
    expect(kinds).toEqual(["hover:", "click:true", "hover:", "hover:", "click:false"]);
    expect(sent[0]).toMatchObject({ kind: "hover", coordX: 0, coordY: 0 }); // the down-hover at the down point
    // Press fires at the START point; release where the finger lifted.
    expect(sent[1]).toMatchObject({ button: "left", pressed: true, coordX: 0, coordY: 0 });
    expect(sent.at(-1)).toMatchObject({ button: "left", pressed: false, coordX: 1400, coordY: 1000 });
  });

  it("two-finger tap sends a single right-click on lift (only the PRIMARY finger down-hovers)", () => {
    // The first (primary) finger's down counts as a hover; the SECOND finger does NOT hover.
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 800, coordY: 600 }]); // primary down-hover
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 2, clientX: 440, clientY: 300 }));
    expect(sent).toHaveLength(1); // secondary finger adds nothing — the two-finger gesture is latching
    stage.dispatchEvent(touchEvent("pointerup", { pointerId: 1, clientX: 400, clientY: 300 }));
    expect(sent).toHaveLength(1); // wait for the second finger
    stage.dispatchEvent(touchEvent("pointerup", { pointerId: 2, clientX: 440, clientY: 300 }));
    expect(sent).toHaveLength(2); // the down-hover, then the right-click
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "right" });
    expect(sent.at(-1)!.pressed).toBeUndefined();
  });

  it("two-finger pinch (large movement) emits nothing beyond the primary down-hover", () => {
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 800, coordY: 600 }]); // primary down-hover
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 2, clientX: 440, clientY: 300 })); // secondary: no hover
    sent = []; // isolate the pinch itself
    stage.dispatchEvent(touchEvent("pointermove", { pointerId: 1, clientX: 100, clientY: 300 }));
    flushFrames();
    stage.dispatchEvent(touchEvent("pointerup", { pointerId: 1, clientX: 100, clientY: 300 }));
    stage.dispatchEvent(touchEvent("pointerup", { pointerId: 2, clientX: 440, clientY: 300 }));
    expect(sent).toHaveLength(0); // the pinch produces no click
  });
});

// --- onHeldCard (the touch-only card-lift signal; see mirrorRenderer.setHeldCard) ---------------------------

describe("createInputCapture — onHeldCard (touch card lift)", () => {
  afterEach(() => {
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it("reports the held card id + its live game coord through a touch drag, then null on release", () => {
    capture.dispose();
    sent = [];
    const heldCard = vi.fn();
    stubTouchStack("card-1");
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, heldCard);

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 0, clientY: 0 }));
    expect(heldCard).not.toHaveBeenCalled(); // still deferred — no gesture classified yet

    // Classifies as a drag (fires the deferred press at the START point) then schedules a hover at the new point.
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 480, clientY: 270 }));
    flushFrames();
    // A further drag-motion frame (no reclassification — just the frozen-affine hover replay).
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 700, clientY: 500 }));
    flushFrames();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 700, clientY: 500 }));

    expect(heldCard.mock.calls).toEqual([
      ["card-1", 0, 0, "drag"], // press, at the drag's START point
      ["card-1", 960, 540, "drag"], // first drag-motion frame's live coord
      ["card-1", 1400, 1000, "drag"], // second drag-motion frame's live coord
      [null, 1400, 1000] // release (mode omitted — id is null)
    ]);
  });

  it("never calls onHeldCard for a MOUSE drag", () => {
    capture.dispose();
    sent = [];
    const heldCard = vi.fn();
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, heldCard);

    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 0, clientY: 0, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 700, clientY: 500, bubbles: true }));
    flushFrames();
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 700, clientY: 500, bubbles: true }));

    expect(heldCard).not.toHaveBeenCalled();
  });
});

// --- long-press peek (touch: hold a card still to focus + raise it, un-focus on release, never a play) ---------

type TouchOpts = {
  raiseHeldCard?: () => boolean;
  unfocusOnRelease?: () => boolean;
  tapToFocus?: () => boolean;
  isFocused?: (id: string) => boolean;
  isCard?: (id: string) => boolean;
  isHandCard?: (id: string) => boolean;
  playZoneThreshold?: (dragStartY: number) => number;
  endTurnBoxAt?: (gameX: number, gameY: number) => { minX: number; minY: number; maxX: number; maxY: number } | null;
  handChoiceActive?: () => boolean;
};

describe("createInputCapture — long-press peek", () => {
  // Fake ONLY setTimeout/clearTimeout so the suite's manual rAF stub (from the top-level beforeEach) still drives
  // the hover flush. R16 tap-arm debounce (see the "touch" describe block for the full rationale): a controllable
  // `performance.now` clock lets a re-tap land past TAP_ARM_DEBOUNCE_MS of the arm.
  let clock = 0;
  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  // Rebuild `capture` with the touch options bag (16:9 stage → coords are a plain 2× of the client px). Returns the
  // onHeldCard mock so a test can assert the cosmetic-lift calls.
  function peekCapture(touch: TouchOpts): ReturnType<typeof vi.fn> {
    capture.dispose();
    sent = [];
    const heldCard = vi.fn();
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, heldCard, touch);
    return heldCard;
  }

  it("focuses + raises a held card on long-press, then un-focuses (never clicks) on release", () => {
    stubTouchStack("card-1");
    const heldCard = peekCapture({ isCard: (id) => id === "card-1" });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 800 }]); // the down-hover; press deferred + peek pending

    vi.advanceTimersByTime(PEEK_MS);
    // Peek fired: a SECOND plain hover at the finger AND the card raised — but NO click.
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 800 }, // down-hover
      { kind: "hover", coordX: 960, coordY: 800 } //  peek hover
    ]);
    expect(heldCard).toHaveBeenCalledWith("card-1", 960, 800, "peek");
    expect(sent.some((m) => m.kind === "click")).toBe(false);

    sent = [];
    heldCard.mockClear();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 400 }));
    // Release (default ON — ?unfocusCenter): lift cleared, ONE un-focus hover at the RESOLVED screen center (the
    // stage-center client point (480,270) → designCoord → (960,540) on this 16:9 stage), and NO click at all.
    expect(heldCard).toHaveBeenCalledWith(null, 960, 800);
    const hovers = sent.filter((m) => m.kind === "hover");
    expect(hovers).toHaveLength(1);
    expect(hovers[0]).toMatchObject({ coordX: 960, coordY: 540 });
    expect(sent.some((m) => m.kind === "click")).toBe(false);
  });

  it("does not schedule peek or non-hand long-press for an already-focused target", () => {
    stubTouchStack("card-1");
    const heldCard = peekCapture({
      isCard: (id) => id === "card-1",
      isFocused: (id) => id === "card-1"
    });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(heldCard).not.toHaveBeenCalled();
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 800 }]);

    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 400 }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "left" });
    expect(sent.some((message) => message.kind === "click" && message.button === "right")).toBe(false);
  });

  it("skips the un-focus hover on release when unfocusOnRelease is off (still clears the lift)", () => {
    stubTouchStack("card-1");
    const heldCard = peekCapture({ isCard: (id) => id === "card-1", unfocusOnRelease: () => false });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    vi.advanceTimersByTime(PEEK_MS);
    sent = [];
    heldCard.mockClear();

    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 400 }));
    expect(heldCard).toHaveBeenCalledWith(null, 960, 800); // lift still cleared
    expect(sent.filter((m) => m.kind === "hover")).toHaveLength(0); // but NO up-shift hover
    expect(sent.some((m) => m.kind === "click")).toBe(false);
  });

  it("on a WIDENED stage, the peek-release un-focus hover maps the center through the resolver (not raw dw/2)", () => {
    capture.dispose();
    sent = [];
    const heldCard = vi.fn();
    // A single element carrying BOTH data-touch-id (so the card is hittable) AND the painter attrs (a +300 anchor
    // shift over the whole stage) so mapPointerToGame inverts it: raw design center 2520/2 = 1260 → game X 960.
    const el = document.createElement("div");
    el.setAttribute("data-touch-id", "card-1");
    el.setAttribute("data-node-id", "999");
    el.setAttribute("data-paints", "1");
    el.setAttribute("data-spread-dx", "300");
    el.getBoundingClientRect = () => rect(0, 0, 960, 540);
    (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => [el];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520, undefined, heldCard, {
      isCard: (id) => id === "card-1"
    });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    vi.advanceTimersByTime(PEEK_MS); // peek fires
    sent = [];
    heldCard.mockClear();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 400 }));
    const hovers = sent.filter((m) => m.kind === "hover");
    expect(hovers).toHaveLength(1);
    // Center routed through the resolver: raw design center 1260 minus the +300 painter shift = 960 (NOT 1260).
    expect(hovers[0]).toMatchObject({ coordX: 960, coordY: 540 });
  });

  it("converts to a normal drag (press → release) if the finger moves after the peek fires", () => {
    stubTouchStack("card-1");
    peekCapture({ isCard: (id) => id === "card-1" });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 100 }));
    vi.advanceTimersByTime(PEEK_MS); // peek fires
    sent = [];

    // Move past the drag threshold → the deferred-press drag path fires a real press.
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 480, clientY: 270 }));
    flushFrames();
    expect(sent.some((m) => m.kind === "click" && m.pressed === true)).toBe(true);

    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent.some((m) => m.kind === "click" && m.pressed === false)).toBe(true);
  });

  it("presses immediately on a quick tap when tapToFocus is off", () => {
    stubTouchStack("card-1");
    peekCapture({ isCard: (id) => id === "card-1", tapToFocus: () => false });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    // Quick tap: lift BEFORE the peek timer fires → the two-step arm is skipped, a click goes out at once (after
    // the leading down-hover).
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "left", coordX: 960, coordY: 540 }
    ]);
  });

  it("still two-steps a quick tap (arm then commit) when tapToFocus is on (default)", () => {
    stubTouchStack("card-1");
    peekCapture({ isCard: (id) => id === "card-1" });

    // First quick tap → down-hover then the arm hover, no click.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "hover", coordX: 960, coordY: 540 }
    ]);

    sent = [];
    // Second quick tap on the same widget, past TAP_ARM_DEBOUNCE_MS → down-hover then commit (click).
    clock += 300;
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "left", coordX: 960, coordY: 540 }
    ]);
  });

  it("does not emit a right-click when a second finger lands during a live peek", () => {
    stubTouchStack("card-1");
    peekCapture({ isCard: (id) => id === "card-1" });

    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 }));
    vi.advanceTimersByTime(PEEK_MS); // peek fires on finger 1
    sent = [];

    // Second finger while the peek is live: the peek folds into dragActive, so it's a stray, not a two-finger tap.
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 2, clientX: 440, clientY: 300 }));
    stage.dispatchEvent(touchEvent("pointerup", { pointerId: 1, clientX: 400, clientY: 300 }));
    stage.dispatchEvent(touchEvent("pointerup", { pointerId: 2, clientX: 440, clientY: 300 }));

    expect(sent.some((m) => m.kind === "click" && m.button === "right")).toBe(false);
  });

  it("does not fire a peek when the target is not a card", () => {
    stubTouchStack("not-a-card");
    const heldCard = peekCapture({ isCard: () => false });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]); // the primary down-hover
    vi.advanceTimersByTime(PEEK_MS);
    expect(sent).toHaveLength(1); // no SECOND (peek) hover fires for a non-card
    expect(heldCard).not.toHaveBeenCalled();
  });

  it("does not fire a peek when raiseHeldCard is off", () => {
    stubTouchStack("card-1");
    const heldCard = peekCapture({ isCard: (id) => id === "card-1", raiseHeldCard: () => false });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]); // the primary down-hover
    vi.advanceTimersByTime(PEEK_MS);
    expect(sent).toHaveLength(1); // no peek even armed when raiseHeldCard is off
    expect(heldCard).not.toHaveBeenCalled();
  });

  it("does not PEEK (lift) a non-hand card on long-press — it right-clicks instead (#13)", () => {
    // A card by leaf (isCard true) that is NOT under the hand (isHandCard false) — e.g. a deck-dialog / reward card
    // — never PEEKS (the cosmetic raise stays hand-card only, so heldCard is never called). Since #13 a long-press
    // on such a card is a RIGHT-CLICK instead of nothing.
    stubTouchStack("card-1");
    const heldCard = peekCapture({ isCard: () => true, isHandCard: () => false });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]); // the primary down-hover
    // R1: the non-hand-card leg fires at its own, longer LONG_PRESS_MS threshold, not PEEK_MS.
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(heldCard).not.toHaveBeenCalled(); // no lift — the peek stays hand-card only
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "right", coordX: 960, coordY: 540 } // #13 right-click
    ]);
  });

  it("does NOT peek a card that's already focused/armed — a re-touch drags it cleanly (issue 1)", () => {
    stubTouchStack("card-1");
    const heldCard = peekCapture({ isCard: (id) => id === "card-1" });

    // First tap focuses/arms card-1 (down-hover then arm-hover).
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "hover", coordX: 960, coordY: 540 }
    ]);
    sent = [];
    heldCard.mockClear();

    // Touch the SAME (armed) card and hold PAST PEEK_MS → the down-hover fires but NO peek (re-touching a focused
    // card = grab, not peek).
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    vi.advanceTimersByTime(PEEK_MS * 2);
    expect(heldCard).not.toHaveBeenCalled();
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]); // only the down-hover, no peek focus hover

    // Then drag it (crosses the 8px threshold) → a proper press then a `pressed:false` release (the card drops).
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 600, clientY: 420 }));
    flushFrames();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 600, clientY: 420 }));
    expect(sent.some((m) => m.kind === "click" && m.button === "left" && m.pressed === true)).toBe(true);
    expect(sent.some((m) => m.kind === "click" && m.button === "left" && m.pressed === false)).toBe(true);
  });

  it("still peeks a DIFFERENT (unarmed) card while another is focused", () => {
    const heldCard = peekCapture({ isCard: () => true });

    // Arm card-1.
    stubTouchStack("card-1");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    sent = [];
    heldCard.mockClear();

    // Hold on a DIFFERENT card (card-2, unarmed) → the peek still fires.
    stubTouchStack("card-2");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 300 }));
    vi.advanceTimersByTime(PEEK_MS);
    expect(heldCard).toHaveBeenCalledWith("card-2", 200, 600, "peek");
  });
});

// --- #12: single-tap selection in a from-hand card-choice dialog ------------------------------------------------
// handChoiceActive true = a discard/exhaust/enchant-from-hand dialog is up. A HAND card then selects with ONE tap
// (no arm-first), and the below-line unselect right-click is suppressed. Twin of GestureMachineTests.Choice*.

describe("createInputCapture — single-tap hand-choice (#12)", () => {
  afterEach(() => {
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  function choiceCapture(touch: TouchOpts): void {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, touch);
  }

  it("a HAND card selects with a SINGLE tap while a choice dialog is active", () => {
    stubTouchStack("card-1");
    choiceCapture({ isCard: () => true, isHandCard: () => true, handChoiceActive: () => true });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 }));
    // Single tap → down-hover + click, NOT arm-first (down-hover + arm-hover).
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 400 },
      { kind: "click", button: "left", coordX: 960, coordY: 400 }
    ]);
  });

  it("a below-line 2nd selection clicks, never a right-click cancel (choose-2 dialog)", () => {
    stubTouchStack("card-1");
    choiceCapture({ isCard: () => true, isHandCard: () => true, handChoiceActive: () => true });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 })); // first selection
    sent = [];
    stubTouchStack("card-2");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 300, clientY: 500 })); // below the line (design 1000)
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 300, clientY: 500 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 600, coordY: 1000 },
      { kind: "click", button: "left", coordX: 600, coordY: 1000 }
    ]);
    expect(sent.some((m) => m.kind === "click" && m.button === "right")).toBe(false);
  });

  it("a NON-hand card (reward/deck) still arms first, even in a choice dialog", () => {
    stubTouchStack("reward-1");
    choiceCapture({ isCard: () => true, isHandCard: () => false, handChoiceActive: () => true });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 400 },
      { kind: "hover", coordX: 960, coordY: 400 } // arm-first (no click)
    ]);
  });

  it("no dialog (handChoiceActive false) → a hand card arms first (arm-first preserved)", () => {
    stubTouchStack("card-1");
    choiceCapture({ isCard: () => true, isHandCard: () => true, handChoiceActive: () => false });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 400 },
      { kind: "hover", coordX: 960, coordY: 400 }
    ]);
  });

});

// --- #13: long-press on a NON-hand card = right click ------------------------------------------------------------
// A non-hand card is isCard true + isHandCard false (reward / shop card / card-grid card). A still hold past PEEK_MS
// right-clicks it FRESH at the start point; the release is silent. Twin of GestureMachineTests.LongPress*.

describe("createInputCapture — long-press right-click (#13)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    vi.useRealTimers();
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  // A non-hand card: isCard true, isHandCard false.
  function rewardCapture(touch: TouchOpts = {}): ReturnType<typeof vi.fn> {
    capture.dispose();
    sent = [];
    const heldCard = vi.fn();
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, heldCard, {
      isCard: () => true,
      isHandCard: () => false,
      ...touch
    });
    return heldCard;
  }

  it("right-clicks a non-hand card on long-press, at the fresh-resolved start point; release is silent", () => {
    stubTouchStack("reward-1");
    const heldCard = rewardCapture();

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 800 }]); // down-hover; right-click pending

    // R1: a non-hand card's long-press leg fires at its OWN, longer threshold (LONG_PRESS_MS) — not PEEK_MS.
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 800 },
      { kind: "click", button: "right", coordX: 960, coordY: 800 }
    ]);
    expect(heldCard).not.toHaveBeenCalled(); // never lifts

    sent = [];
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 400 }));
    expect(sent).toHaveLength(0); // the release emits nothing
  });

  it("R1: does NOT right-click at PEEK_MS — only at the longer LONG_PRESS_MS", () => {
    stubTouchStack("reward-1");
    rewardCapture();
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    sent = [];
    vi.advanceTimersByTime(PEEK_MS); // the hand-card peek threshold — too early for a non-hand card
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(LONG_PRESS_MS - PEEK_MS); // now past LONG_PRESS_MS in total
    expect(sent).toEqual([{ kind: "click", button: "right", coordX: 960, coordY: 800 }]);
  });

  it("right-clicks even when raiseHeldCard is off (decoupled from the cosmetic lift)", () => {
    stubTouchStack("reward-1");
    rewardCapture({ raiseHeldCard: () => false });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(sent.some((m) => m.kind === "click" && m.button === "right")).toBe(true);
  });

  it("right-clicks even on an ALREADY-armed reward card (the non-hand leg is not armed-gated)", () => {
    stubTouchStack("reward-1");
    rewardCapture();
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 400 })); // arm
    sent = [];
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(sent.some((m) => m.kind === "click" && m.button === "right")).toBe(true);
  });

  it("is terminal: no drag/hover after firing, and the release stays silent", () => {
    stubTouchStack("reward-1");
    rewardCapture();
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    sent = [];
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 700, clientY: 500 }));
    flushFrames();
    expect(sent).toHaveLength(0); // no press / drag / hover
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 700, clientY: 500 }));
    expect(sent).toHaveLength(0);
  });

  it("treats a second finger after a fired long-press as a stray (no down-hover, no two-finger right-click)", () => {
    stubTouchStack("reward-1");
    rewardCapture();
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 1, clientX: 480, clientY: 400 }));
    vi.advanceTimersByTime(LONG_PRESS_MS); // fires on finger 1
    sent = [];
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 2, clientX: 520, clientY: 400 }));
    stage.dispatchEvent(touchEvent("pointerup", { pointerId: 1, clientX: 480, clientY: 400 }));
    stage.dispatchEvent(touchEvent("pointerup", { pointerId: 2, clientX: 520, clientY: 400 }));
    expect(sent.some((m) => m.kind === "hover")).toBe(false);
    expect(sent.some((m) => m.kind === "click" && m.button === "right")).toBe(false);
  });

  it("a HAND card still peeks (never right-clicks) — regression", () => {
    stubTouchStack("card-1");
    const heldCard = rewardCapture({ isHandCard: () => true });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    vi.advanceTimersByTime(PEEK_MS);
    expect(heldCard).toHaveBeenCalledWith("card-1", 960, 800, "peek");
    expect(sent.some((m) => m.kind === "click")).toBe(false);
  });

  it("does nothing on a long-press over a NON-card target (isCard false)", () => {
    stubTouchStack("opt-1");
    rewardCapture({ isCard: () => false });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    vi.advanceTimersByTime(PEEK_MS);
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 800 }]); // only the down-hover
  });

});

// --- R4 change 2: end-turn tap parks the cursor directly below the button ----------------------------------------
// The END-TURN button is a *Button leaf → data-touch-block → no touch-id, so a tap on it lands in the empty/block tap
// branch. `endTurnBoxAt` returns its game-space box; the un-hover fires AFTER the click at (centerX, maxY+24 ≤ 1079).
// Twin of GestureMachineTests.{EndTurnTapUnhoversBelowButton, NonEndTurnTapNoExtraHover, EndTurnUnhoverSwitchOffNoHover,
// EndTurnHoldPhaseNoHoverUntilTapEnd}.

describe("createInputCapture — end-turn un-hover", () => {
  afterEach(() => {
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  // R13: the box itself is now used ONLY to decide whether the tap landed on it — its coordinates no longer feed
  // the parked point (see below).
  const endTurnBox = { minX: 1600, minY: 980, maxX: 1880, maxY: 1060 };

  function build(touch: TouchOpts): void {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, touch);
  }

  it("R13: parks the cursor at the RESOLVED SCREEN CENTER (not below the button) AFTER the click on a tap", () => {
    const boxAt = vi.fn(() => endTurnBox);
    build({ endTurnBoxAt: boxAt });
    // No elementsFromPoint scene → touchTargetsAt returns [] → the empty/block branch fires the click, then un-hovers.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 480 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 480 }));
    expect(sent.map((m) => `${m.kind}:${m.button ?? ""}`)).toEqual(["hover:", "click:left", "hover:"]);
    // The stage-center client point (480,270 on this 960×540 rect) → designCoord → (960,540) on a 16:9 stage — NOT
    // the button's box-derived (centerX, maxY+24) = (1740, 1079) the old behaviour used.
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 960, coordY: 540 });
    // The hit-test receives the release's RESOLVED GAME point (client 480,480 on the 2× stage → design 960,960) —
    // the exact value the click sent (the native twin's contract).
    expect(boxAt).toHaveBeenCalledTimes(1);
    expect(boxAt).toHaveBeenCalledWith(960, 960);
  });

  it("R13: on a WIDENED stage, the un-hover center maps through the resolver (not raw dw/2)", () => {
    capture.dispose();
    sent = [];
    const boxAt = vi.fn(() => endTurnBox);
    // A single painting element covering the whole stage with a +300 anchor shift, so mapPointerToGame inverts it:
    // raw design center 2520/2 = 1260 → game X 960 (matching the peek-release resolver test's pattern).
    const el = document.createElement("div");
    el.setAttribute("data-node-id", "999");
    el.setAttribute("data-paints", "1");
    el.setAttribute("data-spread-dx", "300");
    el.getBoundingClientRect = () => rect(0, 0, 960, 540);
    (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => [el];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520, undefined, undefined, { endTurnBoxAt: boxAt });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 480 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 480 }));
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 960, coordY: 540 });
  });

  it("sends no extra hover when the tap did not land on the end-turn button", () => {
    build({ endTurnBoxAt: () => null });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 300, clientY: 300 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 300, clientY: 300 }));
    expect(sent.map((m) => `${m.kind}:${m.button ?? ""}`)).toEqual(["hover:", "click:left"]);
  });

  it("never moves the cursor during the hold — the un-hover fires only after the click on tap end", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      build({ endTurnBoxAt: () => endTurnBox });
      stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 480 }));
      vi.advanceTimersByTime(PEEK_MS * 5); // a long hold — a block button never peeks (no touch-id)
      flushFrames();
      expect(sent.map((m) => `${m.kind}:${m.button ?? ""}`)).toEqual(["hover:"]); // only the down-hover during the hold
      stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 480 }));
      expect(sent.map((m) => `${m.kind}:${m.button ?? ""}`)).toEqual(["hover:", "click:left", "hover:"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- tap-to-unselect (touch: once a card is PRESSED, a below-the-hand tap = a right-click cancel) ---------------
// Stage is 960x540 (2× the 1920x1080 design), so coordY = clientY*2. UNSELECT_ZONE_Y is 846 design-Y ⇒ clientY 423:
// a tap at clientY 200 lands ABOVE the line (coordY 400), one at clientY 500 lands BELOW it (coordY 1000).

describe("createInputCapture — tap-to-unselect", () => {
  // R16 tap-arm debounce (see the "touch" describe block for the full rationale): a controllable clock lets a
  // two-step press land past TAP_ARM_DEBOUNCE_MS of the arm.
  let clock = 0;
  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it("after a two-step press, a tap below the hand line RIGHT-clicks (cancel) — even landing on a card", () => {
    stubTouchStack("card-1");
    // Focus (arm) card-1 above the line — first tap down-hovers then arm-hovers, no click.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 400 },
      { kind: "hover", coordX: 960, coordY: 400 }
    ]);

    // Re-tap the popped-up card (still above the line), past TAP_ARM_DEBOUNCE_MS → down-hover then commit/press.
    sent = [];
    clock += 300;
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 400 },
      { kind: "click", button: "left", coordX: 960, coordY: 400 }
    ]);

    // Now a tap BELOW the line — even landing on a DIFFERENT card → down-hover then a right-click cancel at the point.
    sent = [];
    stubTouchStack("card-2");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 300, clientY: 500 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 300, clientY: 500 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 600, coordY: 1000 },
      { kind: "click", button: "right", coordX: 600, coordY: 1000 }
    ]);

    // The pressed + armed state was cleared: tapping card-2 above the line now ARMS it (down-hover + arm-hover).
    sent = [];
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 300, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 300, clientY: 200 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 600, coordY: 400 },
      { kind: "hover", coordX: 600, coordY: 400 }
    ]);
  });

  it("a below-line tap after only a FOCUS (armed, not pressed) does NOT right-click", () => {
    stubTouchStack("card-1");
    // A single tap focuses (arms) card-1 — no commit, so nothing is "pressed" (down-hover + arm-hover).
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 400 },
      { kind: "hover", coordX: 960, coordY: 400 }
    ]);

    // Tap below the line on another card: no press happened, so it's a normal tap (arms card-2), never a cancel.
    sent = [];
    stubTouchStack("card-2");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 300, clientY: 500 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 300, clientY: 500 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 600, coordY: 1000 },
      { kind: "hover", coordX: 600, coordY: 1000 }
    ]);
  });

  it("a below-line tap with nothing pressed is a normal tap (no spurious right-click)", () => {
    // Empty space, no prior interaction — the down-hover then a plain left click, never a cancel.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 300, clientY: 500 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 300, clientY: 500 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 600, coordY: 1000 },
      { kind: "click", button: "left", coordX: 600, coordY: 1000 }
    ]);
  });

  it("does NOT cancel below the line once the pressed card has left the scene (no-target play)", () => {
    // `isCard(id)` (renderer.isCardTouchTarget) reports whether the id still has an NCard record. A no-target card
    // plays and leaves the hand → its record is pruned → isCard(id) flips false → the unselect latch self-disables,
    // so the next below-line tap (another card / End Turn) is a NORMAL tap, not a wasted right-click.
    capture.dispose();
    sent = [];
    let cardPresent = true;
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {
      isCard: (id) => (id === "card-1" ? cardPresent : true)
    });
    stubTouchStack("card-1");
    // Two-step press card-1 (above the line), past TAP_ARM_DEBOUNCE_MS so the re-tap isn't swallowed.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 })); // arm
    clock += 300;
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 })); // press
    expect(sent).toContainEqual({ kind: "click", button: "left", coordX: 960, coordY: 400 });

    // The card plays and leaves the hand → isCard(card-1) now false.
    cardPresent = false;
    sent = [];
    stubTouchStack(); // empty space below the line
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 300, clientY: 500 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 300, clientY: 500 }));
    // The down-hover, then a normal left click (the gate self-disabled), NOT a right-click cancel.
    expect(sent).toEqual([
      { kind: "hover", coordX: 600, coordY: 1000 },
      { kind: "click", button: "left", coordX: 600, coordY: 1000 }
    ]);
  });

  it("with tapToFocus off, a single-tap press then a below-line tap right-clicks (unselect)", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {
      tapToFocus: () => false
    });
    stubTouchStack("card-1");
    // tapToFocus off: after the down-hover, a single tap presses immediately AND records the press.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 400 },
      { kind: "click", button: "left", coordX: 960, coordY: 400 }
    ]);

    // A following below-line tap cancels it (down-hover then the right-click).
    sent = [];
    stubTouchStack("card-2");
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 300, clientY: 500 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 300, clientY: 500 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 600, coordY: 1000 },
      { kind: "click", button: "right", coordX: 600, coordY: 1000 }
    ]);
  });
});

// --- two-finger scroll wheel (touch: a recognized two-finger DRAG turns vertical centroid drift into wheel ticks) ---
// Stage is 960x540 (2× the 1920x1080 design), so design px = client px × 2. WHEEL_STEP_DESIGN is 56 design px of
// vertical CENTROID drift per tick = 28 client px when BOTH fingers move together. Direction is NATURAL touch scroll:
// fingers moving UP (centroid Y decreasing) ⇒ wheel-down; DOWN ⇒ wheel-up. Ticks fire at the STORED latch centroid.
// Twin of GestureMachineTests.TwoFinger{DragEmitsWheelTicks,SubStepEmitsNoWheel,WheelDirectionMapping}.

describe("createInputCapture — two-finger scroll wheel", () => {
  afterEach(() => {
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  // Latch two fingers at clientY 300 (x 400/440) ⇒ design centroid (840, 600). Returns nothing; `sent` is cleared.
  function latchTwoFingers(): void {
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 }));
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 2, clientX: 440, clientY: 300 }));
    sent = []; // drop the primary down-hover
  }

  it("emits exactly N wheel-down ticks for an N-step upward two-finger drag, at the stored latch centroid", () => {
    latchTwoFingers();
    // Drag BOTH fingers up by 2 steps (56 client px = 112 design px) → centroid drifts −2·step → 2 wheel-down ticks.
    stage.dispatchEvent(touchEvent("pointermove", { pointerId: 1, clientX: 400, clientY: 300 - 56 }));
    stage.dispatchEvent(touchEvent("pointermove", { pointerId: 2, clientX: 440, clientY: 300 - 56 }));
    expect(sent).toEqual([
      { kind: "click", button: "wheel-down", coordX: 840, coordY: 600 },
      { kind: "click", button: "wheel-down", coordX: 840, coordY: 600 }
    ]);
    expect(sent.every((m) => m.pressed === undefined)).toBe(true); // wheel ticks are full clicks (no held mask)
  });

  it("emits NO wheel tick for a recognized two-finger drag whose centroid drift is below one step", () => {
    latchTwoFingers();
    // Each finger travels 20 client px = 40 design px ≥ TWO_FINGER_CANCEL_DESIGN (24) so it's a recognized drag, but
    // the total centroid drift (40 design) never reaches WHEEL_STEP_DESIGN (56) → no ticks.
    stage.dispatchEvent(touchEvent("pointermove", { pointerId: 1, clientX: 400, clientY: 300 - 20 }));
    stage.dispatchEvent(touchEvent("pointermove", { pointerId: 2, clientX: 440, clientY: 300 - 20 }));
    expect(sent).toHaveLength(0);
  });

  it("maps direction naturally: fingers up ⇒ wheel-down, fingers down ⇒ wheel-up", () => {
    // Fingers UP (centroid decreasing) by 1 step (28 client px) → one wheel-down.
    latchTwoFingers();
    stage.dispatchEvent(touchEvent("pointermove", { pointerId: 1, clientX: 400, clientY: 300 - 28 }));
    stage.dispatchEvent(touchEvent("pointermove", { pointerId: 2, clientX: 440, clientY: 300 - 28 }));
    expect(sent.map((m) => m.button)).toEqual(["wheel-down"]);

    // A fresh capture, fingers DOWN by 1 step → one wheel-up.
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m));
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 }));
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 2, clientX: 440, clientY: 300 }));
    sent = [];
    stage.dispatchEvent(touchEvent("pointermove", { pointerId: 1, clientX: 400, clientY: 300 + 28 }));
    stage.dispatchEvent(touchEvent("pointermove", { pointerId: 2, clientX: 440, clientY: 300 + 28 }));
    expect(sent.map((m) => m.button)).toEqual(["wheel-up"]);
  });

  it("ignores horizontal two-finger drift (a pinch/pan) — no wheel ticks", () => {
    latchTwoFingers();
    // Move a finger far HORIZONTALLY (300 client px) with no vertical change → recognized drag, zero centroid Y drift.
    stage.dispatchEvent(touchEvent("pointermove", { pointerId: 1, clientX: 100, clientY: 300 }));
    expect(sent).toHaveLength(0);
  });
});

// --- hand-card gating (only HAND cards get drag-lift / unselect card semantics; the verdict is CAPTURED at press) ---
// Twin of GestureMachineTests.HandCardVerdictCapturedAtPressSurvivesReparent + the unselect self-disable.

describe("createInputCapture — hand-card gating", () => {
  // R16 tap-arm debounce (see the "touch" describe block for the full rationale).
  let clock = 0;
  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it("a grabbed HAND card keeps its drag lift after isHandCard flips false mid-gesture (press-captured)", () => {
    let hand = true;
    const heldCard = vi.fn();
    stubTouchStack("card-1");
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, heldCard, {
      isCard: () => true,
      isHandCard: () => hand
    });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 0, clientY: 0 })); // captures handCard = true
    hand = false; // the grabbed card re-parents OUT of the hand (live verdict now false)
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 480, clientY: 270 })); // classify drag
    flushFrames();
    // The lift still reports the card (uses the press-captured verdict, not the live isHandCard).
    expect(heldCard.mock.calls.some((c) => c[0] === "card-1" && c[3] === "drag")).toBe(true);
  });

  it("a NON-hand card never lifts on drag, even if isHandCard flips true mid-gesture", () => {
    let hand = false;
    const heldCard = vi.fn();
    stubTouchStack("card-2");
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, heldCard, {
      isCard: () => true,
      isHandCard: () => hand
    });

    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 0, clientY: 0 })); // captures handCard = false
    hand = true; // becomes a hand card live (irrelevant — verdict frozen at press)
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 480, clientY: 270 })); // classify drag
    flushFrames();
    expect(heldCard.mock.calls.every((c) => c[0] !== "card-2")).toBe(true);
  });

  it("a below-line tap does NOT cancel once the pressed card has left the hand (isHandCard false)", () => {
    let inHand = true;
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {
      isCard: () => true,
      isHandCard: () => inHand
    });
    stubTouchStack("card-1");
    // Two-step press card-1 above the line (clientY 200 = design coordY 400), past TAP_ARM_DEBOUNCE_MS so the
    // re-tap isn't swallowed.
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 })); // arm
    clock += 300;
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 })); // press
    expect(sent).toContainEqual({ kind: "click", button: "left", coordX: 960, coordY: 400 });

    // The card is played/discarded and leaves the HAND → isHandCard(card-1) flips false.
    inHand = false;
    sent = [];
    stubTouchStack(); // empty space below the line
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 300, clientY: 500 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 300, clientY: 500 }));
    // The down-hover then a NORMAL left click (the latch self-disabled via isHandCard), NOT a right-click cancel.
    expect(sent).toEqual([
      { kind: "hover", coordX: 600, coordY: 1000 },
      { kind: "click", button: "left", coordX: 600, coordY: 1000 }
    ]);
  });
});

// --- change 1: drag-release below the play line right-clicks (de-select) ---------------------------------------
// Stage 960x540 (2× the 1920x1080 design), so design coordY = clientY × 2. playZoneThreshold(1080, dragStartY):
// baseLine 810. A grab at design-Y 800 (clientY 400) → min(810, 750) = 750, so a drop at/below design-Y 750
// (clientY 375) cancels. Twin of GestureMachineTests' change-1 suite (PlayZone.Threshold(1080, ·)).

describe("createInputCapture — drag-release below the play line (unselect)", () => {
  afterEach(() => {
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  // The live play-zone floor exactly as MirrorView wires it, so these tests are true twins of the native harness.
  function playZoneBag(extra: TouchOpts = {}): TouchOpts {
    return {
      isCard: () => true,
      isHandCard: () => true,
      playZoneThreshold: (d) => playZoneThreshold(MIRROR_DESIGN_HEIGHT, d),
      ...extra
    };
  }

  function rebuild(touch: TouchOpts): void {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, touch);
  }

  it("a HAND card dragged and dropped below the play line right-clicks after the left release", () => {
    stubTouchStack("card-1");
    rebuild(playZoneBag());
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 })); // grab (design 960,800)
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 480, clientY: 450 })); // classify drag
    flushFrames();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 450 })); // drop below the line (coordY 900)
    const kinds = sent.map((m) => `${m.kind}:${m.button ?? ""}:${m.pressed ?? ""}`);
    expect(kinds).toEqual(["hover::", "click:left:true", "hover::", "click:left:false", "click:right:"]);
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "right", coordX: 960, coordY: 900 });
    expect(sent.at(-1)!.pressed).toBeUndefined();
  });

  it("a HAND card released ABOVE the play line does NOT right-click", () => {
    stubTouchStack("card-1");
    rebuild(playZoneBag());
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 480, clientY: 350 })); // drag UP (coordY 700 < 750)
    flushFrames();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 350 }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "left", pressed: false });
    expect(sent.some((m) => m.button === "right")).toBe(false);
  });

  it("a NON-hand card dropped below the line does NOT right-click (hand-card only)", () => {
    stubTouchStack("card-1");
    rebuild(playZoneBag({ isHandCard: () => false }));
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 480, clientY: 450 }));
    flushFrames();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 450 }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "left", pressed: false });
    expect(sent.some((m) => m.button === "right")).toBe(false);
  });

  it("a peek that converts to a drag still right-clicks on a below-line drop", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      stubTouchStack("card-1");
      rebuild(playZoneBag());
      stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
      vi.advanceTimersByTime(PEEK_MS); // peek fires
      stage.dispatchEvent(touchEvent("pointermove", { clientX: 480, clientY: 450 })); // convert to drag
      flushFrames();
      stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 450 })); // drop below the line
      const clicks = sent.filter((m) => m.kind === "click");
      expect(clicks.at(-1)).toMatchObject({ button: "right" });
      expect(clicks.at(-2)).toMatchObject({ button: "left", pressed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a PURE peek released below the line never right-clicks (no press)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      stubTouchStack("card-1");
      rebuild(playZoneBag());
      stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 450 })); // hold still below the line
      vi.advanceTimersByTime(PEEK_MS); // peek fires
      stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 450 }));
      expect(sent.some((m) => m.kind === "click")).toBe(false); // an un-focus hover only, never a click
    } finally {
      vi.useRealTimers();
    }
  });

  it("a two-finger tap emits exactly ONE right-click (no double-fire from the drag-release path)", () => {
    rebuild(playZoneBag());
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 1, clientX: 400, clientY: 450 }));
    stage.dispatchEvent(touchEvent("pointerdown", { pointerId: 2, clientX: 440, clientY: 450 }));
    stage.dispatchEvent(touchEvent("pointerup", { pointerId: 1, clientX: 400, clientY: 450 }));
    stage.dispatchEvent(touchEvent("pointerup", { pointerId: 2, clientX: 440, clientY: 450 }));
    expect(sent.filter((m) => m.kind === "click" && m.button === "right")).toHaveLength(1);
  });

  it("a re-parented hand card (isHandCard flips false mid-drag) still right-clicks below the line (frozen verdict)", () => {
    let hand = true;
    stubTouchStack("card-1");
    rebuild(playZoneBag({ isHandCard: () => hand }));
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 })); // captures handCard = true
    hand = false; // re-parents out of the hand (live verdict now false)
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 480, clientY: 450 }));
    flushFrames();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 450 }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "right" });
  });

  it("with playZoneThreshold UNWIRED (absent from the bag), a below-line drop never right-clicks (old behaviour)", () => {
    stubTouchStack("card-1");
    // No playZoneThreshold in the bag → the feature is off.
    rebuild({ isCard: () => true, isHandCard: () => true });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 400 }));
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 480, clientY: 450 }));
    flushFrames();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 450 }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "left", pressed: false });
    expect(sent.some((m) => m.button === "right")).toBe(false);
  });
});

// --- change 2: reward/deck cards are arm-first touch targets (gesture level; the stamping twin lives in
// mirrorRenderer.spec) ------------------------------------------------------------------------------------------

describe("createInputCapture — arm-first reward/deck cards", () => {
  // R16 tap-arm debounce (see the "touch" describe block for the full rationale).
  let clock = 0;
  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  function rebuild(touch: TouchOpts): ReturnType<typeof vi.fn> {
    capture.dispose();
    sent = [];
    const heldCard = vi.fn();
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, heldCard, touch);
    return heldCard;
  }

  it("arms then commits a reward/deck card (a non-hand touch target): tap 1 hovers, tap 2 clicks", () => {
    stubTouchStack("reward-1");
    rebuild({ isCard: () => true, isHandCard: () => false });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "hover", coordX: 960, coordY: 540 }
    ]);
    sent = [];
    clock += 300; // past TAP_ARM_DEBOUNCE_MS so the re-tap isn't swallowed
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent).toEqual([
      { kind: "hover", coordX: 960, coordY: 540 },
      { kind: "click", button: "left", coordX: 960, coordY: 540 }
    ]);
  });

  it("does NOT peek a reward/deck card (peek stays hand-card only; long-press right-clicks it — #13)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      stubTouchStack("reward-1");
      const heldCard = rebuild({ isCard: () => true, isHandCard: () => false });
      stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
      // R1: a non-hand card's long-press leg fires at LONG_PRESS_MS (300ms), not PEEK_MS (100ms).
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(heldCard).not.toHaveBeenCalled(); // no lift — the peek stays hand-card only
      // #13: a long-press on a non-hand card is a right-click (not a peek, not nothing).
      expect(sent).toEqual([
        { kind: "hover", coordX: 960, coordY: 540 },
        { kind: "click", button: "right", coordX: 960, coordY: 540 }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT drag-lift a reward/deck card (drag lift stays hand-card only)", () => {
    stubTouchStack("reward-1");
    const heldCard = rebuild({ isCard: () => true, isHandCard: () => false });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 50, clientY: 50 }));
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 300, clientY: 450 }));
    flushFrames();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 300, clientY: 450 }));
    expect(heldCard.mock.calls.every((c) => c[0] !== "reward-1")).toBe(true);
  });

  it("does NOT tap-unselect a reward/deck card below the line (unselect stays hand-card only)", () => {
    stubTouchStack("reward-1");
    // tapToFocus off → a single tap presses (records the press) so the below-line tap has a candidate to unselect.
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {
      isCard: () => true,
      isHandCard: () => false,
      tapToFocus: () => false,
      playZoneThreshold: (d) => playZoneThreshold(MIRROR_DESIGN_HEIGHT, d)
    });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 200 })); // press recorded
    sent = [];
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 300, clientY: 500 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 300, clientY: 500 }));
    // A NORMAL left click below the line (the unselect gate needs a HAND card), never a right-click.
    expect(sent).toEqual([
      { kind: "hover", coordX: 600, coordY: 1000 },
      { kind: "click", button: "left", coordX: 600, coordY: 1000 }
    ]);
  });
});

// --- change 3: a drag begun OFF a card raises the hand card it MOVES onto (the lift latch) ----------------------
// The latch is band-gated on design-Y >= UNSELECT_ZONE_Y (846 → clientY 423) to bound the per-frame hit-test cost.

describe("createInputCapture — drag-into-card lift latch", () => {
  afterEach(() => {
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  function rebuild(touch: TouchOpts): ReturnType<typeof vi.fn> {
    capture.dispose();
    sent = [];
    const heldCard = vi.fn();
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, heldCard, touch);
    return heldCard;
  }

  it("latches the lift onto a hand card the drag MOVES onto (drag begun off any card)", () => {
    stubTouchStack(); // press on EMPTY space
    const heldCard = rebuild({ isCard: () => true, isHandCard: () => true });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 450 })); // design (200, 900) — no card
    stubTouchStack("card-1"); // the finger now moves over a hand card
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 150, clientY: 450 })); // classify drag (nothing latched)
    flushFrames(); // flushHover: coordY 900 >= 846, a hand card under the finger → latch the lift
    expect(heldCard.mock.calls.some((c) => c[0] === "card-1" && c[3] === "drag")).toBe(true);
  });

  // (a) A PROBE latch FOLLOWS the finger: crossing onto a DIFFERENT hand card switches the lift (old unlifts).
  it("SWITCHES the probe lift to a different hand card the finger crosses onto", () => {
    stubTouchStack(); // press on EMPTY space
    const heldCard = rebuild({ isCard: () => true, isHandCard: () => true });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 450 }));
    stubTouchStack("card-1");
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 150, clientY: 450 }));
    flushFrames(); // probe-latch card-1
    expect(heldCard.mock.calls.at(-1)![0]).toBe("card-1");
    heldCard.mockClear();
    stubTouchStack("card-2"); // the finger crosses onto a DIFFERENT hand card
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 200, clientY: 450 }));
    flushFrames();
    expect(heldCard.mock.calls.at(-1)![0]).toBe("card-2"); // the probe lift switches to card-2
  });

  // (b) A PROBE latch CLEARS when the finger leaves every hand card (within the band).
  it("CLEARS the probe lift when the finger leaves every hand card (within the band)", () => {
    stubTouchStack();
    const heldCard = rebuild({ isCard: () => true, isHandCard: () => true });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 450 }));
    stubTouchStack("card-1");
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 150, clientY: 450 }));
    flushFrames(); // probe-latch card-1
    heldCard.mockClear();
    stubTouchStack(); // the finger moves off every hand card, still below the band
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 200, clientY: 450 }));
    flushFrames();
    expect(heldCard.mock.calls.at(-1)![0]).toBe(null); // the probe lift clears
  });

  // (c) A press GRAB (finger down ON a card) stays STICKY: dragging over another hand card does NOT switch it.
  it("does NOT switch a PRESS grab when the finger crosses onto another hand card", () => {
    const heldCard = rebuild({ isCard: () => true, isHandCard: () => true });
    stubTouchStack("card-1"); // press ON card-1 → a press GRAB
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 450 }));
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 130, clientY: 450 })); // classify drag → press-grab card-1
    flushFrames();
    expect(heldCard.mock.calls.at(-1)![0]).toBe("card-1");
    heldCard.mockClear();
    stubTouchStack("card-2"); // the finger crosses onto a different hand card
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 200, clientY: 450 }));
    flushFrames();
    expect(heldCard.mock.calls.at(-1)![0]).toBe("card-1"); // a PRESS grab stays sticky — no switch
  });

  it("does NOT latch when raiseHeldCard is off", () => {
    stubTouchStack();
    const heldCard = rebuild({ isCard: () => true, isHandCard: () => true, raiseHeldCard: () => false });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 450 }));
    stubTouchStack("card-1");
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 150, clientY: 450 }));
    flushFrames();
    expect(heldCard.mock.calls.every((c) => c[0] !== "card-1")).toBe(true);
  });

  it("does NOT latch above the band-gate (design-Y < 846)", () => {
    stubTouchStack();
    const heldCard = rebuild({ isCard: () => true, isHandCard: () => true });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 200 })); // design Y 400 < 846
    stubTouchStack("card-1");
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 150, clientY: 200 }));
    flushFrames();
    expect(heldCard.mock.calls.every((c) => c[0] !== "card-1")).toBe(true);
  });

  // (d) Re-classification is band-gated too: once a probe lift is active, rising ABOVE the band skips the
  // per-frame hit-test, so the lift neither switches nor clears there.
  it("does NOT re-classify a probe lift above the band (design-Y < 846) — it stays lifted", () => {
    stubTouchStack();
    const heldCard = rebuild({ isCard: () => true, isHandCard: () => true });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 450 }));
    stubTouchStack("card-1");
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 150, clientY: 450 }));
    flushFrames(); // probe-latch card-1 (below the band)
    heldCard.mockClear();
    stubTouchStack(); // the finger leaves the card AND rises above the band
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 200, clientY: 200 })); // design Y 400 < 846
    flushFrames();
    expect(heldCard.mock.calls.at(-1)![0]).toBe("card-1"); // not re-classified above the band → stays lifted
  });

  it("a drag begun off a card, latched, then released below the line does NOT right-click (press-time handCard false)", () => {
    stubTouchStack();
    rebuild({
      isCard: () => true,
      isHandCard: () => true,
      playZoneThreshold: (d) => playZoneThreshold(MIRROR_DESIGN_HEIGHT, d)
    });
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 450 })); // press off any card
    stubTouchStack("card-1");
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 150, clientY: 450 })); // classify drag (handCard false)
    flushFrames(); // latch card-1
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 175, clientY: 470 }));
    flushFrames();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 175, clientY: 470 })); // drop below the line
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "left", pressed: false });
    expect(sent.some((m) => m.button === "right")).toBe(false);
  });
});

// --- The drag-probe throttle on that latch ----------------------------------------------------------------------
//
// The latch above runs `document.elementsFromPoint` — a forced hit test — once per move event of a drag inside the
// hand band. Which card is under the finger cannot change without the finger travelling, so a move that stays
// within 24 DESIGN px AND 90ms of the last probe reuses the previous verdict. The stage here is 960 CSS px wide for
// the 1920 design box, so 1 client px = 2 design px: 10 client px is inside the bound, 20 is outside.
describe("createInputCapture — drag-probe throttle", () => {
  let clock = 0;
  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    window.history.replaceState(null, "", "/");
  });

  function rebuild(): ReturnType<typeof vi.fn> {
    capture.dispose();
    sent = [];
    const heldCard = vi.fn();
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, heldCard, {
      isCard: () => true,
      isHandCard: () => true
    });
    return heldCard;
  }

  // Press off any card at clientX 100 / clientY 450 (design Y 900, inside the band), then drag to 150 so the first
  // latch probe runs there. Returns the held-card spy.
  function dragTo150(): ReturnType<typeof vi.fn> {
    stubTouchStack();
    const heldCard = rebuild();
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 100, clientY: 450 }));
    stubTouchStack("card-1");
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 150, clientY: 450 }));
    flushFrames();
    expect(heldCard.mock.calls.at(-1)![0]).toBe("card-1");
    return heldCard;
  }

  it("skips the hit test for a move under 24 design px within 90ms, keeping the previous verdict", () => {
    const heldCard = dragTo150();
    heldCard.mockClear();
    const stack = stubTouchStack("card-2"); // a DIFFERENT card is now under the finger...
    clock += 10;
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 160, clientY: 450 })); // ...but only 20 design px on
    flushFrames();
    expect(stack.probes()).toBe(0); // no forced hit test at all
    expect(heldCard.mock.calls.at(-1)![0]).toBe("card-1"); // the previous verdict stands
  });

  it("probes fresh once the finger has travelled 24 design px from the last probe", () => {
    const heldCard = dragTo150();
    heldCard.mockClear();
    const stack = stubTouchStack("card-2");
    clock += 10;
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 170, clientY: 450 })); // 40 design px → over the bound
    flushFrames();
    expect(stack.probes()).toBe(1);
    expect(heldCard.mock.calls.at(-1)![0]).toBe("card-2"); // the latch switched
  });

  it("probes fresh once 90ms have passed, even for a finger that barely moved", () => {
    const heldCard = dragTo150();
    heldCard.mockClear();
    const stack = stubTouchStack("card-2");
    clock += 200; // past DRAG_REPROBE_MS
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 152, clientY: 450 })); // 4 design px
    flushFrames();
    expect(stack.probes()).toBe(1);
    expect(heldCard.mock.calls.at(-1)![0]).toBe("card-2");
  });

  it("the ENDPOINTS always probe fresh: a press probes, and neither press nor release inherits a memo", () => {
    const heldCard = dragTo150();
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 150, clientY: 450 })); // release clears the memo
    heldCard.mockClear();

    const empty = stubTouchStack(); // the next gesture presses on empty space (so its drag re-classifies)
    clock += 5; // inside the time bound, and the press point is within 24 design px of the last probe
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 151, clientY: 450 }));
    expect(empty.probes()).toBe(1); // the press ALWAYS runs its own hit test (onTouchDown)

    const stack = stubTouchStack("card-2");
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 161, clientY: 450 })); // 20 design px — inside the bound
    flushFrames();
    expect(stack.probes()).toBe(1); // still fresh: the endpoints cleared the memo, so nothing was reused
    expect(heldCard.mock.calls.at(-1)![0]).toBe("card-2");
  });

});

// The web view-scale coordinate inverse maps a hover/tap over an enlarged item's halo back onto its true hit box.
describe("createInputCapture view-scale inverse (FIX 3)", () => {
  // The ancient-event OptionsContainer group in GAME space: 1000x292 centred at x=960, y 700..992, x1.2 about its
  // BOTTOM centre (grows UP), no clamp. Its ScaledBox spans y 641.6..992 — the enlarged top row paints in the halo.
  function optionStamp(neighborRects: ViewScaleInputStamp["neighborRects"] = []): ViewScaleInputStamp {
    const channel = { pivotX: 960, pivotY: 992, k: 1.2, offsetX: 0, offsetY: 0 };
    const originalBox = { minX: 460, minY: 700, maxX: 1460, maxY: 992 };
    return { channel, scaledBox: viewScaleForwardBox(originalBox, channel), originalBox, isGroup: true, neighborRects };
  }

  it("sends the INVERTED game coordinate for a hover over a view-scaled group's halo", () => {
    capture.dispose();
    sent = [];
    // 16:9 stage (default 1920 design width). Pass the view-scale registry getter as the 7th arg.
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {}, () => [optionStamp()]);
    // Stage is 960x540 (half scale). Aim at GAME (960, 660) — the enlarged halo above the true option top (700):
    // clientX = 960*0.5 = 480, clientY = 660*0.5 = 330.
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 330, bubbles: true }));
    flushFrames();
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("hover");
    expect(sent[0].coordX).toBeCloseTo(960, 3); // centre column unchanged
    // 992 + (660 - 992)/1.2 = 715.33 — remapped DOWN onto the first real option row (inside 700..992).
    expect(sent[0].coordY).toBeCloseTo(715.333, 2);
  });

  it("leaves a hover OUTSIDE every ScaledBox untouched (identity)", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {}, () => [optionStamp()]);
    // GAME (960, 500): above the ScaledBox top (641.6) → client (480, 250).
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 250, bubbles: true }));
    flushFrames();
    expect(sent[0].coordX).toBeCloseTo(960, 3);
    expect(sent[0].coordY).toBeCloseTo(500, 3);
  });

  it("leaves an EXEMPT overlay hover untouched (a neighbour rect owns the tap)", () => {
    capture.dispose();
    sent = [];
    const overlay = { minX: 900, minY: 640, maxX: 1020, maxY: 700 }; // a TopBar-style button in the halo
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {}, () => [
      optionStamp([overlay])
    ]);
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 330, bubbles: true })); // GAME (960,660)
    flushFrames();
    expect(sent[0].coordY).toBeCloseTo(660, 3); // exempt → identity
  });

  it("with no registry getter (unwired) the input path is byte-identical", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m)); // no 7th arg
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 330, bubbles: true }));
    flushFrames();
    expect(sent[0].coordY).toBeCloseTo(660, 3); // 330/540*1080, no inverse applied
  });
});

// The rendered-box guard on the view-scale inverse prevents a wide-screen false halo. The inverse runs LAST, on an already-resolved game point, so on a
// wider-than-16:9 stage it could claim a pointer that was never over the enlarged item: BESIDE the ancient-event
// options no `data-paints` painter anchors the map, mapPointerToGame falls back to the uniform squeeze
// (`designX·1920/designW`) which drops the centred group's spread shift, and the squeezed game X lands inside the
// group's ScaledBox anyway — the inverse then contracted it INTO an option row (hovering/tapping empty space beside
// the options focused/activated one). The guard tests the RAW widened-design pointer against the stamp's ON-STAGE
// renderedBox (ScaledBox + spreadDx on X) before any stamp may remap.
describe("createInputCapture view-scale inverse — renderedBox guard (wide stage)", () => {
  const DESIGN_W = 2214; // the ultrawide stage the bug reproduces on
  const SPREAD_DX = 147; // the centre-anchored option group's applied shift: ½·(2214 − 1920)
  const STAGE_W = DESIGN_W / 2; // 1107 — half scale, so clientX·2 === designX and clientY·2 === designY exactly
  const STAGE_H = 540;
  const SQUEEZE = 1920 / DESIGN_W;

  // The live ancient-event OptionsContainer in GAME space: 1000x292 centred at x=960, y 750..1042, x1.2 about its
  // BOTTOM centre, no clamp. ScaledBox x 360..1560 / y 691.6..1042; rendered (on a 2214 stage) x 507..1707.
  const CHANNEL = { pivotX: 960, pivotY: 1042, k: 1.2, offsetX: 0, offsetY: 0 };
  const ORIGINAL = { minX: 460, minY: 750, maxX: 1460, maxY: 1042 };
  const SCALED = viewScaleForwardBox(ORIGINAL, CHANNEL);

  function optionStamp(withRenderedBox = true): ViewScaleInputStamp {
    return {
      channel: CHANNEL,
      scaledBox: SCALED,
      originalBox: ORIGINAL,
      isGroup: true,
      neighborRects: [],
      ...(withRenderedBox
        ? { renderedBox: { ...SCALED, minX: SCALED.minX + SPREAD_DX, maxX: SCALED.maxX + SPREAD_DX } }
        : {})
    };
  }

  // Client x 875 → widened-design x 1750: ~43 design-px right of the enlarged plaque's rendered right edge (1707),
  // i.e. visibly BESIDE it. Client y 450 → design y 900, the option-row band.
  const BESIDE_CLIENT_X = 875;
  const ROW_CLIENT_Y = 450;
  const BESIDE_DESIGN_X = BESIDE_CLIENT_X * 2; // 1750
  const SQUEEZED_X = BESIDE_DESIGN_X * SQUEEZE; // 1517.615… — the coordinate that MUST go on the wire
  const PREFIX_REMAP_X = CHANNEL.pivotX + (SQUEEZED_X - CHANNEL.pivotX) / CHANNEL.k; // 1424.679… — THE BUG
  const ROW_Y = ROW_CLIENT_Y * 2; // 900

  // A wide-stage capture with the group stamp published and NO painter under the pointer (elementsFromPoint
  // resolves an empty z-stack), so mapPointerToGame takes its uniform-squeeze fallback — the live "beside the
  // plaque" geometry. No interactive-rects provider: the near-miss pass is out of the picture entirely.
  function wideCapture(withRenderedBox = true): void {
    capture.dispose();
    sent = [];
    stage.getBoundingClientRect = () => rect(0, 0, STAGE_W, STAGE_H);
    stubNodeStack(); // empty z-stack → no `data-paints` anchor → squeeze fallback
    capture = createInputCapture(stage, (m) => sent.push(m), () => DESIGN_W, undefined, undefined, {}, () => [
      optionStamp(withRenderedBox)
    ]);
  }

  it("9. a hover BESIDE the enlarged plaque sends the squeezed coordinate, never the contracted option-row one", () => {
    wideCapture();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: BESIDE_CLIENT_X, clientY: ROW_CLIENT_Y, bubbles: true }));
    flushFrames();
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("hover");
    expect(sent[0].coordY).toBeCloseTo(ROW_Y, 6);
    expect(sent[0].coordX).toBeCloseTo(SQUEEZED_X, 6);
    expect(sent[0].coordX).toBeCloseTo(1517.615, 2);
    // The pre-fix value, and the property that actually mattered: the sent point is OUTSIDE the option row.
    expect(sent[0].coordX).not.toBeCloseTo(PREFIX_REMAP_X, 2);
    expect(sent[0].coordX!).toBeGreaterThan(ORIGINAL.maxX);
  });

  it("10. a touch TAP beside the plaque clicks outside the option row (not on it)", () => {
    wideCapture(); // the empty z-stack is also an empty touch-target stack → the immediate-click branch
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: BESIDE_CLIENT_X, clientY: ROW_CLIENT_Y }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: BESIDE_CLIENT_X, clientY: ROW_CLIENT_Y }));
    const click = sent.find((m) => m.kind === "click");
    expect(click).toBeDefined();
    expect(click).toMatchObject({ button: "left" });
    expect(click!.coordX).toBeCloseTo(SQUEEZED_X, 6);
    expect(click!.coordX!).toBeGreaterThan(ORIGINAL.maxX); // outside the true option row — no false activation
    // The down-hover took the same path.
    expect(sent[0]).toMatchObject({ kind: "hover" });
    expect(sent[0].coordX).toBeCloseTo(SQUEEZED_X, 6);
  });

  it("12. at 16:9 the full input path is identical with and without renderedBox (dx 0 ⇒ provable no-op)", () => {
    const points: Array<[number, number]> = [
      [480, 350], // GAME (960, 700) — the enlarged halo above the true top (750)
      [480, 450], // GAME (960, 900) — the item's own face
      [480, 250], // GAME (960, 500) — above every ScaledBox
      [50, 450] // GAME (100, 900) — left of every ScaledBox
    ];
    const run = (withRenderedBox: boolean): MirrorInputMessage[] => {
      capture.dispose();
      sent = [];
      stage.getBoundingClientRect = () => rect(0, 0, 960, 540); // 16:9 half-scale (design width 1920)
      // At 16:9 the stamps' renderedBox IS the scaledBox (the renderer emits them identical at dx 0).
      const s = { ...optionStamp(false), ...(withRenderedBox ? { renderedBox: SCALED } : {}) };
      capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {}, () => [s]);
      for (const [clientX, clientY] of points) {
        stage.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY, bubbles: true }));
        flushFrames();
      }
      return sent.slice();
    };
    const guarded = run(true);
    const legacy = run(false);
    expect(guarded).toHaveLength(points.length);
    expect(guarded).toEqual(legacy);
  });

  it("13. a FROZEN drag off the plaque refuses the remap too (the drag path is guarded as well)", () => {
    wideCapture();
    // Press over the RENDERED plaque (client 550 → design 1100, inside 507..1707): the guard lets it through, so
    // the press is remapped onto the true row exactly as before.
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 550, clientY: ROW_CLIENT_Y, bubbles: true }));
    const pressed = sent.find((m) => m.pressed === true)!;
    const pressSqueezed = 1100 * SQUEEZE; // 953.93… (no painter ⇒ the squeeze field is what freezes)
    expect(pressed.coordX).toBeCloseTo(CHANNEL.pivotX + (pressSqueezed - CHANNEL.pivotX) / CHANNEL.k, 6);
    expect(pressed.coordX).not.toBeCloseTo(pressSqueezed, 3); // it really did remap

    // Drag-motion out BESIDE the plaque: the frozen affine replays the same squeeze, and the guard now blocks.
    sent = [];
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: BESIDE_CLIENT_X, clientY: ROW_CLIENT_Y, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(SQUEEZED_X, 6);
    expect(sent.at(-1)!.coordX!).toBeGreaterThan(ORIGINAL.maxX);
  });
});

// A gesture freezes its mapping field at press time.
// AFFINE at the press, but every drag-motion frame still re-tested the LIVE view-scale registry, so a stamp the drag
// merely CROSSED took the coordinate over mid-gesture and stepped the sent X by (1−1/k)·(distance from the stamp's
// pivot) in a single frame — the "targeting cursor jumps sideways" report. Measured on the real page with a combat
// recording (scripts/probe-targeting-drag-jump.mjs): 67.6 design px at 2520x1080 and 66.7 at 1920x1080, from a map
// screen's stamps that were still published while the player was in combat (the other half of the fix — see
// mirrorRenderer's ancestorChainHidden reject). The claim is now decided ONCE, at the press, and replayed.
describe("createInputCapture — frozen view-scale mapping on a held drag (R10 WS-F)", () => {
  // A combat-sized stamp the drag crosses: the 1.25 draw-pile button, 80x80 at (15,985), grown from its bottom-LEFT
  // corner. 16:9 (design === game space) so the numbers are the pointer's own coordinates.
  const CHANNEL = { pivotX: 15, pivotY: 1065, k: 1.25, offsetX: 0, offsetY: 0 };
  const ORIGINAL = { minX: 15, minY: 985, maxX: 95, maxY: 1065 };
  const SCALED = viewScaleForwardBox(ORIGINAL, CHANNEL); // x 15..115, y 965..1065

  function pileStamp(): ViewScaleInputStamp {
    return { channel: CHANNEL, scaledBox: SCALED, originalBox: ORIGINAL, isGroup: false, neighborRects: [] };
  }

  // Stage is the default 960x540 half-scale box, so clientX·2 === designX === gameX at 16:9.
  const INSIDE_CLIENT = { clientX: 55, clientY: 512 }; // game (110, 1024) — inside the stamp's ScaledBox
  const OUTSIDE_CLIENT = { clientX: 200, clientY: 512 }; // game (400, 1024) — clear of it
  const INSIDE_GAME_X = 110;
  // What the stamp WOULD do to that point: 15 + (110 − 15)/1.25 = 91 — a 19 design-px step in one frame.
  const REMAPPED_X = CHANNEL.pivotX + (INSIDE_GAME_X - CHANNEL.pivotX) / CHANNEL.k;

  function pileCapture(): void {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {}, () => [pileStamp()]);
  }

  it("a drag that PRESSED outside every stamp keeps the identity map when it crosses one", () => {
    pileCapture();
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, ...OUTSIDE_CLIENT, bubbles: true }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", pressed: true, coordX: 400 });

    sent = [];
    stage.dispatchEvent(new MouseEvent("pointermove", { ...INSIDE_CLIENT, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(INSIDE_GAME_X, 6); // the pointer's own coordinate — no step
    expect(sent.at(-1)!.coordX).not.toBeCloseTo(REMAPPED_X, 3);
  });

  it("the RELEASE still resolves fresh, so a drop onto the enlarged item lands on its true box", () => {
    pileCapture();
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, ...OUTSIDE_CLIENT, bubbles: true }));
    sent = [];
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, ...INSIDE_CLIENT, bubbles: true }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", pressed: false });
    expect(sent.at(-1)!.coordX).toBeCloseTo(REMAPPED_X, 6);
  });

  it("a drag that PRESSED ON the enlarged item keeps that stamp's inverse for the whole gesture", () => {
    pileCapture();
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, ...INSIDE_CLIENT, bubbles: true }));
    expect(sent.at(-1)!.coordX).toBeCloseTo(REMAPPED_X, 6); // the press itself remaps, as before

    // Still inside the ScaledBox one frame later → the frozen stamp still claims it (no flicker back to identity).
    sent = [];
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 50, clientY: 512, bubbles: true })); // game (100,1024)
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(CHANNEL.pivotX + (100 - CHANNEL.pivotX) / CHANNEL.k, 6);

    // Dragged clear of it → the frozen stamp no longer contains the point, so the map is identity again. That is the
    // stamp's OWN boundary (where the visual itself ends), not an arbitrary one the drag wandered into.
    sent = [];
    stage.dispatchEvent(new MouseEvent("pointermove", { ...OUTSIDE_CLIENT, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(400, 6);
  });

  it("a stamp that APPEARS mid-drag cannot claim the gesture (the registry is not consulted again)", () => {
    capture.dispose();
    sent = [];
    let live: ViewScaleInputStamp[] = [];
    capture = createInputCapture(stage, (m) => sent.push(m), undefined, undefined, undefined, {}, () => live);
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, ...OUTSIDE_CLIENT, bubbles: true }));
    live = [pileStamp()]; // a drain publishes the stamp WHILE the button is held
    sent = [];
    stage.dispatchEvent(new MouseEvent("pointermove", { ...INSIDE_CLIENT, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(INSIDE_GAME_X, 6);
  });

  it("the freeze is released with the gesture — the next plain hover consults the live registry again", () => {
    pileCapture();
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, ...OUTSIDE_CLIENT, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, ...OUTSIDE_CLIENT, bubbles: true }));
    sent = [];
    stage.dispatchEvent(new MouseEvent("pointermove", { ...INSIDE_CLIENT, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(REMAPPED_X, 6);
  });

  it("a TOUCH drag freezes the same way (the classified press decides, the motion replays)", () => {
    pileCapture();
    stage.dispatchEvent(touchEvent("pointerdown", { ...OUTSIDE_CLIENT }));
    // Past DRAG_THRESHOLD_DESIGN → the deferred press fires at the START point and freezes there.
    stage.dispatchEvent(touchEvent("pointermove", { clientX: 190, clientY: 512 }));
    flushFrames();
    sent = [];
    stage.dispatchEvent(touchEvent("pointermove", { ...INSIDE_CLIENT }));
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(INSIDE_GAME_X, 6);
  });
});

// R10 WS-F — THE STAGE-RECT INVALIDATION SEAM. The cached stage rect was dropped only on a window `resize`/`scroll`,
// but toggling the widescreen STRETCH setting rewrites the stage's width AND its letterbox scale from a Vue computed
// with neither event firing. The stale rect then mis-maps EVERY pointer by a fixed ratio.
describe("createInputCapture — stage-rect invalidation (R10 WS-F)", () => {
  it("invalidateStageRect() re-measures the stage (a stretch toggle fires no window event)", () => {
    capture.dispose();
    sent = [];
    let measures = 0;
    let current = rect(0, 0, 960, 540);
    stage.getBoundingClientRect = () => {
      measures++;
      return current;
    };
    capture = createInputCapture(stage, (m) => sent.push(m));

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(960, 6);
    const afterFirst = measures;

    // The stage is re-laid-out (stretch off → a NARROWER letterboxed box at the same design width) with no event.
    current = rect(0, 0, 480, 270);
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(measures).toBe(afterFirst); // still on the stale cache — the pre-fix behaviour
    expect(sent.at(-1)!.coordX).toBeCloseTo(960, 6); // wrong: the pointer is at the stage's RIGHT edge now

    capture.invalidateStageRect();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(measures).toBeGreaterThan(afterFirst);
    expect(sent.at(-1)!.coordX).toBeCloseTo(1920, 6); // the pointer IS the stage's right edge in the new rect
  });

  it("self-heals when the DESIGN WIDTH changes even if nobody calls the seam (the stretch-toggle belt)", () => {
    capture.dispose();
    sent = [];
    let designW = 2520;
    let current = rect(0, 0, 1260, 540); // half scale at 2520 design px
    stage.getBoundingClientRect = () => current;
    stubNodeStack(); // empty z-stack → the uniform-squeeze fallback, so the map is pure arithmetic
    capture = createInputCapture(stage, (m) => sent.push(m), () => designW);

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 630, clientY: 270, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(960, 6); // mid-stage: 1260 design → squeeze → 960

    // Stretch OFF: design width AND the letterboxed rect both change, with no resize/scroll event anywhere.
    designW = 1920;
    current = rect(150, 0, 960, 540);
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 630, clientY: 270, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(960, 6); // (630−150)/960 · 1920 — the NEW rect, re-measured
  });

  it("keeps invalidating on the window events it always did", () => {
    capture.dispose();
    sent = [];
    let current = rect(0, 0, 960, 540);
    stage.getBoundingClientRect = () => current;
    capture = createInputCapture(stage, (m) => sent.push(m));
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();

    current = rect(0, 0, 480, 270);
    window.dispatchEvent(new Event("resize"));
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(1920, 6);
  });
});

// --- the SQUEEZE GATE (r3/WS-N): the hit-consistency pass is for undoing a per-painter dx misregistration, so a
// point the anchor map resolved through the UNIFORM SQUEEZE (dead space / a demoted backdrop / the oversized
// parallax prop, and any hover-memo replay of the squeeze field) must not run it. Under the squeeze practically
// every spread rect "offends" by construction, and which one is topmost alternates between adjacent samples — the
// wide-stage hover bistability (268.61 design px of step jump, scripts/probe-targeting-drag-jump.mjs). --------

describe("createInputCapture — near-miss squeeze gate (widened stage)", () => {
  // The same anchored offender the memo test uses: game x∈[900,1100], never rendered-shifted.
  const button: InteractiveRect = {
    id: "btn",
    transform: [1, 0, 0, 1, 900, 0],
    localRect: { x: 0, y: 0, width: 200, height: 1080 },
    spreadDx: 0,
    renderedWidth: 0,
    raiseDy: 0
  };

  afterEach(() => {
    resetNearMissMemory();
  });

  it("a hover the map SQUEEZE-resolved skips the WALK but still meets the rendered-box gate (R19 6a)", () => {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520, () => [button]);
    // Nothing painting under the pointer → mapPointerToGame's uniform-squeeze fallback: 1260 · 1920/2520 = 960.
    stubNodeStack({ id: "4242", spreadDx: "300", rect: rect(0, 0, 960, 540) });

    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
    flushFrames();
    // 960 IS inside the button's game rect while designX 1260 is nowhere near its rendered rect. Before 6a the
    // squeeze coordinate went out verbatim (960) and hovered a button the pointer was never over; the gate ejects
    // it from that ONE rect — the same 1101 the full pass would reach here, but without its multi-rect walk.
    expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 1101, coordY: 540 });
  });

  it("a MEMOIZED hover replaying the squeeze field skips it too (a prop painter's memo)", () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      capture.dispose();
      sent = [];
      capture = createInputCapture(stage, (m) => sent.push(m), () => 2520, () => [button]);
      // A PROP painter: the fresh resolve uses its exact local translation (1260 − 240 = 1020) — not squeezed, so
      // the pass runs — but the FIELD it memoizes is the whole-world squeeze.
      const { probes } = stubNodeStack({ id: "c", paints: true, spreadDx: "240", prop: true, rect: rect(300, 150, 200, 200) });
      stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 270, bubbles: true }));
      flushFrames();
      expect(probes()).toBe(1);
      expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: pushOutOfNearMiss(1020, 540, 1260, [button]) });

      // The next flush replays that squeeze field with pure math — a squeeze coordinate, so no WALK. R19 6a: the
      // rendered-box gate still applies (it has to be on both legs, or the sent X would depend on whether a sample
      // happened to be memoized), so the replayed 980 is ejected from the button just like the fresh resolve was.
      clock += 10;
      stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 490, clientY: 275, bubbles: true }));
      flushFrames();
      expect(probes()).toBe(1); // memoized: no second DOM probe
      expect(((490 / 960) * 2520 * 1920) / 2520).toBe(980); // the raw replay, inside the button's game rect
      expect(sent.at(-1)).toMatchObject({ kind: "hover", coordX: 1101 });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// R19 6a — the MEASURED map-legend case, end to end through the capture: hovering AND dragging in the dead band
// right of the map legend on a 2520-wide stage. Geometry from .sts2/artifacts/diag-map-legend-2520.json.
describe("createInputCapture — squeeze rendered-box gate, map legend (R19 6a)", () => {
  // The anchored legend row: game x[1582,1862] y[486,534], spreadDx 300 ⇒ it RENDERS at x[1882,2162].
  const legend: InteractiveRect = {
    id: "legendTreasure",
    transform: [1, 0, 0, 1, 1582, 486],
    localRect: { x: 0, y: 0, width: 280, height: 48 },
    spreadDx: 300,
    renderedWidth: 0,
    raiseDy: 0
  };
  // The map screen's full-canvas root above it (game [0,1920], stretched to the 2520 stage) — it paints, so it is
  // in the z-stack, but as a `data-spread-w` backdrop it is demoted and the map falls through to the squeeze.
  const rootRect: InteractiveRect = {
    id: "mapScreen",
    transform: [1, 0, 0, 1, 0, 0],
    localRect: { x: 0, y: 0, width: 1920, height: 1080 },
    spreadDx: 0,
    renderedWidth: 2520,
    raiseDy: 0
  };
  const RECTS = [rootRect, legend];
  // clientX → designX on the default 960-wide stage at designWidth 2520.
  const clientForDesign = (designX: number): number => (designX / 2520) * 960;
  const DEAD_BAND = clientForDesign(2340); // designX 2340: nothing painted, squeeze sends 1782.86 — in the game rect
  const CLIENT_Y = (500 / MIRROR_DESIGN_HEIGHT) * 540;

  function legendCapture(): void {
    capture.dispose();
    sent = [];
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520, () => RECTS);
    // Only the demoted full-stage backdrop paints under the pointer → the uniform-squeeze fallback.
    stubNodeStack({ id: "mapScreen", paints: true, spreadDx: "0", spreadW: "1920,2520", rect: rect(0, 0, 960, 540) });
  }

  afterEach(() => {
    resetNearMissMemory();
  });

  it("a hover in the dead band right of the legend no longer resolves onto a legend row", () => {
    legendCapture();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: DEAD_BAND, clientY: CLIENT_Y, bubbles: true }));
    flushFrames();
    const x = sent.at(-1)!.coordX!;
    expect(x).toBeGreaterThan(1862); // clear of the row's game rect …
    expect(x).toBeCloseTo(1863, 6); // … by the pusher's one px, on the pointer's side
  });

  it("a held DRAG through that band is gated too (the frozen replay never ran any pass before)", () => {
    legendCapture();
    // Press further right, still in dead space: the frozen field is the SQUEEZE (a = 1920/2520, b = 0).
    stage.dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, clientX: clientForDesign(2480), clientY: CLIENT_Y, bubbles: true })
    );
    sent = [];
    // Drag LEFT across the band. Every motion frame replays the frozen squeeze — straight into the legend's game
    // rect before 6a, which is the reported "dragging right of the legend focuses legend rows".
    for (const designX of [2440, 2400, 2340, 2280, 2220]) {
      stage.dispatchEvent(new MouseEvent("pointermove", { clientX: clientForDesign(designX), clientY: CLIENT_Y, bubbles: true }));
      flushFrames();
      const x = sent.at(-1)!.coordX!;
      expect(x).toBeCloseTo(1863, 6); // ejected, and to the SAME place every frame — no mid-drag stepping
    }
  });

  it("a drag begun ON a card is NOT gated — its frozen squeeze field is the correct one", () => {
    capture.dispose();
    sent = [];
    let providerCalls = 0;
    capture = createInputCapture(stage, (m) => sent.push(m), () => 2520, () => {
      providerCalls++;
      return RECTS;
    });
    // A PROP painter under the press: the map resolves through its own translation (squeezed === false) even though
    // the FIELD it freezes is the whole-world squeeze. The world is meant to spread under the finger.
    stubNodeStack({ id: "card", paints: true, spreadDx: "300", prop: true, rect: rect(0, 0, 200, 100) });
    stage.dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, clientX: clientForDesign(2480), clientY: CLIENT_Y, bubbles: true })
    );
    const afterPress = providerCalls;
    sent = [];
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: clientForDesign(2340), clientY: CLIENT_Y, bubbles: true }));
    flushFrames();
    // The replay is verbatim (2340 · 1920/2520), inside the legend's game rect — and the rect provider was not even
    // consulted, so the drag-frame phone-CPU rule is intact.
    expect(sent.at(-1)!.coordX).toBeCloseTo((2340 * 1920) / 2520, 6);
    expect(providerCalls).toBe(afterPress);
  });

  it("a hover the pointer really IS over the legend still resolves onto it", () => {
    legendCapture();
    // designX 2000 is inside the RENDERED box [1882,2162]; there the real page has the legend itself painting, so
    // the anchor map takes its anchored translation (2000 − 300 = 1700) and never reaches the squeeze at all.
    stubNodeStack({ id: "legendTreasure", paints: true, spreadDx: "300", rect: rect(716, 243, 106, 24) });
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: clientForDesign(2000), clientY: CLIENT_Y, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordX).toBeCloseTo(1700, 6);
  });
});

// --- F-arrow: the frozen raise correction FADES over the drag -----------------------------------------------------
//
// A press on a raised hand card measures how far the raise inverse moved its point and replays that CONSTANT for
// the whole gesture (frozenRaiseOffset — deliberately, because re-testing containment per frame stepped the sent Y
// by a whole lift mid-drag and flickered the held card). The constant is only right where it was measured: drag the
// card up to target and the game has long since lowered the hand, yet every frame still goes out 119px below the
// finger — and the game draws the targeting arrow at the coordinate it is sent. Live measurement behind this:
// pointer design y 361 → sent y 480, flat over ten samples out to 700px of travel (2026-08-25).
//
// The stage here is 960x540 for the 1920x1080 design box, so 1 client px = 2 design px.
describe("createInputCapture — raise correction fades across a drag (F-arrow)", () => {
  const LIFT = 119;
  // One raised hand card, axis-aligned for readable arithmetic: game box x∈[810,1110], y∈[600,1022], drawn 119px
  // higher (y∈[481,903]). A pointer at design (960, 700) is inside the DRAWN box and un-maps to (960, 819) — kept
  // clear of the viewport floor on purpose, so the numbers below are the pure lift and not a clamp slide.
  const cardStamp = {
    transform: [1, 0, 0, 1, 810, 600] as [number, number, number, number, number, number],
    localRect: { x: 0, y: 0, width: 300, height: 422 },
    spreadDx: 0,
    dy: -LIFT
  };

  function rebuild(): void {
    capture.dispose();
    sent = [];
    capture = createInputCapture(
      stage,
      (m) => sent.push(m),
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      () => [cardStamp]
    );
  }

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  // client (480, 350) → design (960, 700): inside the drawn card, un-maps to y 819.
  const PRESS = { clientX: 480, clientY: 350 };

  it("still corrects EXACTLY at the press point (a tap is byte-identical to before the fade existed)", () => {
    rebuild();
    stage.dispatchEvent(new MouseEvent("pointerdown", { clientX: PRESS.clientX, clientY: PRESS.clientY, button: 0, bubbles: true }));
    flushFrames();
    const press = sent.find((m) => m.kind === "click" && m.pressed);
    expect(press).toMatchObject({ coordX: 960, coordY: 700 + LIFT });
  });

  it("fades the correction to NOTHING once the finger is a fade-length away", () => {
    rebuild();
    stage.dispatchEvent(new MouseEvent("pointerdown", { clientX: PRESS.clientX, clientY: PRESS.clientY, button: 0, bubbles: true }));
    flushFrames();
    // 150 client px up = 300 design px of travel — past the 200px fade — so the sent point IS the finger.
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: PRESS.clientX, clientY: PRESS.clientY - 150, bubbles: true }));
    flushFrames();
    const hover = sent.at(-1)!;
    expect(hover.kind).toBe("hover");
    expect(hover.coordY).toBeCloseTo(400, 6); // design y of the finger, with no lift added
  });

  it("is CONTINUOUS in between — half a fade-length of travel keeps half the correction", () => {
    rebuild();
    stage.dispatchEvent(new MouseEvent("pointerdown", { clientX: PRESS.clientX, clientY: PRESS.clientY, button: 0, bubbles: true }));
    flushFrames();
    // 50 client px = 100 design px of travel = half of the 200px fade.
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: PRESS.clientX, clientY: PRESS.clientY - 50, bubbles: true }));
    flushFrames();
    // finger design y 600, plus half the lift.
    expect(sent.at(-1)!.coordY).toBeCloseTo(600 + LIFT / 2, 6);
  });

  it("measures travel from the press point, not from the hand — moving back restores the correction", () => {
    rebuild();
    stage.dispatchEvent(new MouseEvent("pointerdown", { clientX: PRESS.clientX, clientY: PRESS.clientY, button: 0, bubbles: true }));
    flushFrames();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: PRESS.clientX, clientY: PRESS.clientY - 150, bubbles: true }));
    flushFrames();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: PRESS.clientX, clientY: PRESS.clientY, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordY).toBeCloseTo(700 + LIFT, 6);
  });

  it("a press OFF the hand is unaffected (no offset frozen ⇒ no ramp ⇒ identity replay)", () => {
    rebuild();
    // design (960, 200) — nowhere near the card.
    stage.dispatchEvent(new MouseEvent("pointerdown", { clientX: 480, clientY: 100, button: 0, bubbles: true }));
    flushFrames();
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 250, bubbles: true }));
    flushFrames();
    expect(sent.at(-1)!.coordY).toBeCloseTo(500, 6);
  });
});

// A touch tap resolves twice — once on the down edge and once at release. Both must apply the same per-pixel
// raise inverse so a drawn hand-card pixel reaches its game-space position on the wire.
describe("createInputCapture — a touch tap's release resolves through the raise inverse", () => {
  const LIFT = 119;
  // The same axis-aligned card as the fade suite above: true game box x∈[810,1110], y∈[600,1022], drawn 119px
  // higher (y∈[481,903]).
  const cardStamp = {
    transform: [1, 0, 0, 1, 810, 600] as [number, number, number, number, number, number],
    localRect: { x: 0, y: 0, width: 300, height: 422 },
    spreadDx: 0,
    dy: -LIFT
  };

  function rebuild(): void {
    capture.dispose();
    sent = [];
    capture = createInputCapture(
      stage,
      (m) => sent.push(m),
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      () => [cardStamp]
    );
  }

  // client (480, 350) → design (960, 700), inside the DRAWN box.
  const ON_CARD = { clientX: 480, clientY: 350 };
  it("un-maps the raised card on both edges", () => {
    stubTouchStack();
    rebuild();
    stage.dispatchEvent(touchEvent("pointerdown", ON_CARD));
    stage.dispatchEvent(touchEvent("pointerup", ON_CARD));
    // design y 700 + the 119px lift = 819 — the coordinate the game really has under the drawn pixel.
    expect(sent.at(-1)).toEqual({ kind: "click", button: "left", coordX: 960, coordY: 700 + LIFT });
  });

});

// --- T2: the MOUSE drag-drop cancel ------------------------------------------------------------------------------
//
// The game's cancel for a card being targeted is a ZONE it polls its own cursor against (the bottom band of the
// viewport). Readable-hand mode draws the hand ~119px above where the game has it, so a drop onto the DRAWN hand
// sends a Y about a lift short of that band and the game never cancels — the card stays selected with the arrow up,
// and a hand with a card out of it answers no hover-focus at all. The touch leg has fired a right-click at the drop
// point for a below-line HAND-card drop since the previous round; this is the same rule on the mouse leg, which had
// no cancel at all. Live evidence and the URL kill switch: see readDropCancelClick in inputCapture.ts.
//
// Stage 960x540 for the 1920x1080 design box, so 1 client px = 2 design px. ONE governed hand card, axis-aligned:
// game box x∈[810,1110], y∈[600,1022], drawn 119px higher (y∈[481,903]). A press at client (480,350) = design
// (960,700) is inside the drawn box. playZoneThreshold(1080, 700) = min(810, 700−50) = 650, so a drop at design Y
// ≥ 650 (client Y ≥ 325) is below the floor.
describe("createInputCapture — mouse drag-drop cancel (T2)", () => {
  const LIFT = 119;
  const handRect: InteractiveRect = {
    id: "hitbox-1",
    transform: [1, 0, 0, 1, 810, 600],
    localRect: { x: 0, y: 0, width: 300, height: 422 },
    spreadDx: 0,
    renderedWidth: 1920,
    raiseDy: -LIFT,
    raiseGoverned: true
  };

  let rects: InteractiveRect[];

  function rebuild(bag: Parameters<typeof createInputCapture>[5] = {}): void {
    capture.dispose();
    sent = [];
    capture = createInputCapture(
      stage,
      (m) => sent.push(m),
      undefined,
      () => rects,
      undefined,
      { playZoneThreshold: (d) => playZoneThreshold(MIRROR_DESIGN_HEIGHT, d), ...bag }
    );
  }

  // The reported gesture: grab the card, drag it up into the play area, drag back down, let go.
  function dragUpAndBack(dropClientX = 480, dropClientY = 350): void {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 350 }));
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: dropClientX, clientY: dropClientY }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: dropClientX, clientY: dropClientY }));
  }

  beforeEach(() => {
    rects = [handRect];
    rebuild();
  });

  it("a raised hand card dragged up and dropped back into the hand right-clicks after the left release", () => {
    dragUpAndBack();
    const clicks = sent.filter((m) => m.kind === "click");
    expect(clicks.at(-1)).toMatchObject({ kind: "click", button: "right", coordX: 960, coordY: 700 });
    expect(clicks.at(-1)!.pressed).toBeUndefined();
    expect(clicks.at(-2)).toMatchObject({ button: "left", pressed: false });
  });

  it("…even though the drop lands exactly where the press did (the drag latch, not an endpoint test)", () => {
    // This is the whole gesture in the report: up and back. Its press→release displacement is ZERO, so an
    // endpoint-distance test would call it a click and cancel the game's own click-to-select.
    dragUpAndBack(480, 350);
    expect(sent.some((m) => m.button === "right")).toBe(true);
  });

  it("a plain CLICK on the card never right-clicks (click-to-select must survive)", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 350 }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 350 }));
    expect(sent.some((m) => m.button === "right")).toBe(false);
  });

  it("a drop ABOVE the play line does not right-click (that release is a play, not a cancel)", () => {
    dragUpAndBack(480, 200); // design Y 400 — well above the 650 floor
    expect(sent.some((m) => m.button === "right")).toBe(false);
  });

  it("a drag that started OFF the hand never right-clicks", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 100, clientY: 350 })); // design x 200
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 200 }));
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 350 }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 100, clientY: 350 }));
    expect(sent.some((m) => m.button === "right")).toBe(false);
  });

  it("with readable-hand mode OFF (no governed rect) nothing changes", () => {
    rects = [{ ...handRect, raiseDy: 0, raiseGoverned: false }];
    rebuild();
    dragUpAndBack();
    expect(sent.some((m) => m.button === "right")).toBe(false);
  });

  it("the press-time verdict is FROZEN: the holder leaving the governed set mid-drag still cancels", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 350 }));
    rects = []; // the game re-parents the grabbed holder off the hand container mid-drag
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 350 }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 350 }));
    expect(sent.some((m) => m.button === "right")).toBe(true);
  });

  it("with playZoneThreshold UNWIRED the feature is off (every existing caller stays byte-identical)", () => {
    rebuild({ playZoneThreshold: undefined });
    dragUpAndBack();
    expect(sent.some((m) => m.button === "right")).toBe(false);
  });

  it("a cancelled gesture (stolen capture) retracts the press but never cancels the card", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 350 }));
    stage.dispatchEvent(new MouseEvent("pointermove", { clientX: 480, clientY: 200 }));
    stage.dispatchEvent(new MouseEvent("pointercancel", { clientX: 480, clientY: 350 }));
    expect(sent.at(-1)).toMatchObject({ kind: "click", button: "left", pressed: false });
    expect(sent.some((m) => m.button === "right")).toBe(false);
  });
});
