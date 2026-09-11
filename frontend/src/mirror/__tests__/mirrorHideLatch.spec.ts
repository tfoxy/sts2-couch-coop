import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {


  createMirrorRenderer,
  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState, type MirrorTweenHint } from "@/mirror/sceneTree";

// Feature 2 — tween hide-latch. When a client fade settles a node's opacity to ~0, the producer ships one drain of
// "resting alpha + Visible=true" BEFORE the hide/removal; the reconcile would write it through → a 1-frame reappear
// flash. The latch holds the node at 0 for a 400ms grace while that drain passes. Extends the mirrorTween.spec.ts
// harness (rAF-mocked clock + flushRaf drives the settle).

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

// A leaf ColorRect at (x,y) with an explicit modulate.a (the alpha the game fades). Identity RGB → no tint filter.
function nodeMod(id: string, x: number, y: number, modA: number, visible = true): Record<string, unknown> {
  return {
    id,
    parentId: null,
    name: id,
    nodeType: "ColorRect",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 90, y: 130 } },
    visible,
    modulate: { r: 1, g: 1, b: 1, a: modA, html: "#ffffff" },
    fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#e0574a" }
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
}
function volatile(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}
function hintsOnly(state: MirrorState, hints: unknown[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", hints })!);
}
function el(stage: HTMLElement, id: string): HTMLElement {
  return stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
}
// A modulate:a fade-out hint (endOpacity 0 = a disappear).
function fadeOut(targetId: string, durationMs = 200): Partial<MirrorTweenHint> & Record<string, unknown> {
  return { targetId, property: "modulate:a", durationMs, trans: "Cubic", ease: "Out", endOpacity: 0 };
}

describe("mirror tween hide-latch (Feature 2)", () => {
  let clock = 0;
  let rafCb: FrameRequestCallback | null = null;
  // WS-B: the renderer's animation loop is DEADLINE-SCHEDULED — it parks on a `setTimeout` until the earliest live
  // tween / held-restore deadline and only THEN requests the rAF that mutates. Model both halves against the same
  // fake clock so `flushRaf(atMs)` keeps its meaning ("let the renderer run at this wall-clock time").
  let timers: { id: number; at: number; cb: () => void }[] = [];
  let nextTimerId = 1;

  beforeEach(() => {
    document.body.innerHTML = "";
    clock = 0;
    rafCb = null;
    timers = [];
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      rafCb = null;
    });
    vi.stubGlobal("setTimeout", (cb: () => void, ms?: number) => {
      const id = nextTimerId++;
      timers.push({ id, at: clock + (ms ?? 0), cb });
      return id;
    });
    vi.stubGlobal("clearTimeout", (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    });
  });

  afterEach(() => { // restore default for other suites
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function flushRaf(atMs: number): void {
    clock = atMs;
    // Fire every scheduler timer whose deadline has passed (each wake re-requests the frame callback below), then
    // run that callback. A wake arms at most one successor, so this converges after one pass.
    for (let guard = 0; guard < 8; guard++) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
      if (due.length === 0) {
        break;
      }
      timers = timers.filter((t) => t.at > clock);
      for (const timer of due) {
        timer.cb();
      }
    }
    const cb = rafCb;
    rafCb = null;
    cb?.(atMs);
  }

  // Drive the flash sequence up to (but not including) the resting-restore drain. Returns the renderer/state/stage.
  function fadeThenSettle(restingA = 1): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [nodeMod("p", 100, 100, restingA)], ["p"]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe(String(restingA));

    // Arm the disappear fade → 0 and let it SETTLE (client replays it to 0; the producer keeps streaming restingA).
    clock = 0;
    hintsOnly(state, [fadeOut("p", 200)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("0"); // pinned to the fade endpoint
    flushRaf(210); // past the 200ms fade → settle → latch armed
    return { stage, renderer, state };
  }

  it("ON: holds 0 through the resting-alpha restore, then the node hides (no flash)", () => {
    const { stage, renderer, state } = fadeThenSettle(1);

    // The producer's pre-hide drain: modulate.a restored to 1, still visible. Without the latch this writes 1 (flash).
    clock = 220;
    volatile(state, [nodeMod("p", 100, 100, 1)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("0"); // LATCH held it at 0

    // Next drain: the node actually hides.
    clock = 230;
    volatile(state, [nodeMod("p", 100, 100, 1, false)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.display).toBe("none");
  });

  it("holds 0 for a resting alpha that ISN'T 1 (e.g. a 0.75 card)", () => {
    const { stage, renderer, state } = fadeThenSettle(0.75);

    clock = 220;
    volatile(state, [nodeMod("p", 100, 100, 0.75)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("0"); // 0.75 ≈ resting signature → clamped
  });

  it("cancel — incoming ≠ resting signature (a genuine reveal ramp) writes through", () => {
    const { stage, renderer, state } = fadeThenSettle(1);

    // A drain restoring a DIFFERENT alpha (0.5, not the resting 1) is a real re-show, not the flash → write through.
    clock = 220;
    volatile(state, [nodeMod("p", 100, 100, 0.5)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("0.5");

    // The latch is now cancelled: a subsequent resting-alpha drain is NOT clamped.
    clock = 230;
    volatile(state, [nodeMod("p", 100, 100, 1)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("1");
  });

  it("cancel — an incoming ~0 (the producer caught up) writes through and clears the latch", () => {
    const { stage, renderer, state } = fadeThenSettle(1);

    clock = 220;
    volatile(state, [nodeMod("p", 100, 100, 0)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("0");

    // Latch cleared → a later resting restore writes through (no lingering clamp).
    clock = 230;
    volatile(state, [nodeMod("p", 100, 100, 1)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("1");
  });

  it("cancel — a NEW opacity tween on the node clears the latch (fade back in animates)", () => {
    const { stage, renderer, state } = fadeThenSettle(1);

    // A fresh fade-IN to 0.8 arms a new opacity tween → cancels the latch and pins the new endpoint.
    clock = 220;
    hintsOnly(state, [{ targetId: "p", property: "modulate:a", durationMs: 100, trans: "Cubic", ease: "Out", endOpacity: 0.8 }]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("0.8"); // NOT clamped to 0
  });

  it("cancel — 400ms grace expiry lets the resting alpha through", () => {
    const { stage, renderer, state } = fadeThenSettle(1);

    // Latch armed at 210 → expires at 610. A resting-restore drain AFTER that writes through.
    clock = 620;
    volatile(state, [nodeMod("p", 100, 100, 1)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("1");
  });

  // WS-REST — the rest-site refocus/first-click defect. The re-show arrives as a PLAIN resting-alpha write with NO
  // fade-in hint (the fade-in tween was killed by the unfocus), so it looks value-identical to the pre-hide flash and
  // the latch clamps it to 0. With NO further delta to un-stick it, the rendererTick must release the latch at 150ms
  // and re-apply the streamed opacity.
  it("WS-REST: restored at 150ms with no further write (held-restore self-heal)", () => {
    const { stage, renderer, state } = fadeThenSettle(1);

    // The hint-less refocus re-show: modulate.a restored to 1, still visible. Held at 0 (looks like the flash).
    clock = 220;
    volatile(state, [nodeMod("p", 100, 100, 1)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("0"); // clamped — the held-restore clock STARTS here

    // <150ms after the hold: still clamped (the tick hasn't reached the short expiry).
    flushRaf(220 + 100);
    expect(el(stage, "p").style.opacity).toBe("0");

    // ≥150ms after the hold, with NO further scene delta: the tick releases the latch and re-applies the streamed 1.
    flushRaf(220 + 150);
    expect(el(stage, "p").style.opacity).toBe("1");
  });

  it("cancel — a full keyframe rebuild clears the latch (a reappearing node isn't suppressed)", () => {
    const { stage, renderer, state } = fadeThenSettle(1);

    // A teardown/keyframe rebuild re-establishes the scene; the node returns at its resting alpha and must NOT be
    // clamped by the stale latch.
    clock = 220;
    full(state, [nodeMod("p", 100, 100, 1)], ["p"]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("1");
  });
});
