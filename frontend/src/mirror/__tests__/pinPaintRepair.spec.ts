import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,

  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// R20 item 5 — "every relic dialog after the first opens black".
//
// A Godot dialog opens with ONE tween that animates `position` AND `modulate` together. The client replays the
// transform half by pinning the node's element to the tween endpoint, and while that pin is live the walk treats
// any inherited-context change on a riding descendant as benign ("the only thing that moved is the pinned
// ancestor's streamed transform") and skips it. The modulate half rides the SAME context, as the subtree's tint —
// so every frame of the fade-in was swallowed, the subtree parked at whatever brightness the last pre-pin walk
// applied, and because the fade FINISHES inside the pin window nothing dirtied the subtree ever again. It stayed
// dark for as long as the dialog was open, and only re-upserting the subtree (the user's left/right arrow press)
// repaired it. The first open in a page session was correct because the popup had no record yet, so
// `applyTweenHints` dropped its hints and no pin existed.
//
// THE FIXTURE is distilled from a live capture of the second open (`.sts2/bench/r20-relic/relic-open2.ndjson`,
// 30s / 3.5MB / 1278 messages — uncommittable, and 99% of it is unrelated scene traffic). Kept verbatim from it:
//   * the tween hints the open delta carries (position + modulate, 250ms, Cubic/Out, with declared starts),
//   * the 18 fade frames and their wire timings, i.e. the exact modulate ramp of the popup (#00 → #ff over
//     ~280ms) and of the side arrows (which start 135ms later and end ~365ms in),
//   * the popup's streamed slide (a vertical ease-out from y=340 to y=140) and the arrows' horizontal one,
//   * the ~135ms client stall over the open (the dialog's first frame builds a screen's worth of elements), which
//     is what coalesced the first seven fade frames into ONE reconcile and armed the pin at fade frame #77.
// Reduced to the shape the walk cares about: a screen root, a popup with a painting child, and one arrow with a
// painting child. The node ids/names, art, text and the rest of the room are dropped — none of them participate.
const FADE: { atMs: number; popup: string | null; popupY: number; arrow: string | null }[] = [
  { atMs: 0, popup: "#00000000", popupY: 140, arrow: "#00000000" },
  { atMs: 28.3, popup: "#11111111", popupY: 302.6088, arrow: null },
  { atMs: 50.2, popup: "#22222222", popupY: 270.19498, arrow: null },
  { atMs: 69.3, popup: "#33333333", popupY: 242.40308, arrow: null },
  { atMs: 95.6, popup: "#55555555", popupY: 199.26282, arrow: null },
  { atMs: 117.5, popup: "#66666666", popupY: 183.20346, arrow: null },
  { atMs: 135.4, popup: "#77777777", popupY: 170.34393, arrow: "#11111111" },
  { atMs: 163.6, popup: "#99999999", popupY: 152.8023, arrow: "#33333333" },
  { atMs: 185.1, popup: "#aaaaaaaa", popupY: 147.40918, arrow: "#44444444" },
  { atMs: 204.8, popup: "#bbbbbbbb", popupY: 143.79385, arrow: "#55555555" },
  { atMs: 222.4, popup: "#cccccccc", popupY: 141.60077, arrow: "#66666666" },
  { atMs: 247.2, popup: "#dddddddd", popupY: 140.47443, arrow: "#77777777" },
  { atMs: 261.0, popup: "#eeeeeeee", popupY: 140.05936, arrow: "#88888888" },
  { atMs: 280.2, popup: "#ffffffff", popupY: 140, arrow: "#99999999" },
  { atMs: 296.5, popup: null, popupY: 140, arrow: "#aaaaaaaa" },
  { atMs: 321.5, popup: null, popupY: 140, arrow: "#cccccccc" },
  { atMs: 351.8, popup: null, popupY: 140, arrow: "#eeeeeeee" },
  { atMs: 364.4, popup: null, popupY: 140, arrow: "#ffffffff" }
];
// Index of the frame the coalesced (stalled) reconcile lands on — the last one applied before the pin arms.
const STALL_THROUGH = 6;
const TWEEN_MS = 250;

// The tween hints the open delta carries, verbatim in shape: the popup slides up from y=340 while it fades in,
// each arrow slides in horizontally while it fades in. `startTransform`/`startOpacity` are the declared `.From(…)`
// values, which is what makes the client PRIME the start and defer the arm.
const OPEN_HINTS = [
  {
    targetId: "popup",
    property: "position",
    durationMs: TWEEN_MS,
    trans: "Cubic",
    ease: "Out",
    endTransform: [1, 0, 0, 1, 528, 140],
    startTransform: [1, 0, 0, 1, 528, 340]
  },
  { targetId: "popup", property: "modulate", durationMs: TWEEN_MS, endOpacity: 1, startOpacity: 0 },
  {
    targetId: "arrow",
    property: "position:x",
    durationMs: TWEEN_MS,
    trans: "Back",
    ease: "Out",
    endTransform: [1, 0, 0, 1, 1320, 476],
    startTransform: [1, 0, 0, 1, 1220, 476]
  },
  { targetId: "arrow", property: "modulate", durationMs: TWEEN_MS, endOpacity: 1, startOpacity: 0 }
];

function color(html: string): Record<string, number | string> {
  const r = parseInt(html.slice(1, 3), 16) / 255;
  const g = parseInt(html.slice(3, 5), 16) / 255;
  const b = parseInt(html.slice(5, 7), 16) / 255;
  const a = html.length >= 9 ? parseInt(html.slice(7, 9), 16) / 255 : 1;
  return { r, g, b, a, html };
}

// A boxed, centre-anchored Control with no own paint at a parent-relative origin — the popup / an arrow. The box
// and the anchors are what make it a tween TARGET (a boxless node has no matrix to animate) and what put it on the
// wide-screen anchor algebra, both true of the captured nodes.
function group(
  id: string,
  parentId: string | null,
  x: number,
  y: number,
  modulate: string,
  size = 864
): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } },
    localRect: { position: { x: 0, y: 0 }, size: { x: size, y: size } },
    anchorLeft: 0.5,
    anchorRight: 0.5,
    visible: true,
    modulate: color(modulate)
  };
}

// A painting leaf inside one of those groups: it is where the composed tint is baked (`filter: url(#mtint-…)`),
// exactly as in the live DOM — an INTERIOR node never wears the cascading tint itself, or it would double-apply
// onto its children.
function leaf(id: string, parentId: string, x: number, y: number, w: number, h: number): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "ColorRect",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } },
    localRect: { position: { x: 0, y: 0 }, size: { x: w, y: h } },
    visible: true,
    fillColor: color("#e0574aff")
  };
}

const ORDER = ["screen", "popup", "panel", "arrow", "icon"];

// The captured stream's matrices are parent-relative. A rider must remain composed through the pinned parent while
// the producer streams only that parent's fresh pose.
function keyframe(state: MirrorState): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: ORDER,
      upserts: [
        group("screen", null, 0, 0, "#ffffffff"),
        group("popup", "screen", 528, 140, "#ffffffff"),
        leaf("panel", "popup", 24, 18, 864, 660),
        group("arrow", "screen", 1320, 476, "#ffffffff", 128),
        leaf("icon", "arrow", 12, 12, 64, 64)
      ]
    })!
  );
}

// One wire frame of the fade: the volatile upserts the producer actually sends (only what moved), plus the hints
// on the opening frame. `popupX` exists for the sweep variant below — the captured popup slides on Y alone.
function fadeFrame(state: MirrorState, index: number, withHints: boolean, popupX = 528): void {
  const f = FADE[index];
  const upserts: Record<string, unknown>[] = [];
  if (f.popup) {
    upserts.push(group("popup", "screen", popupX, f.popupY, f.popup));
  }
  if (f.arrow) {
    upserts.push(group("arrow", "screen", 1320, 476, f.arrow, 128));
  }
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts,
      hints: withHints ? OPEN_HINTS : undefined
    })!
  );
}

// The tint filter baked on a painting leaf — `null` when the node is untinted (the correct end state: the game's
// nodes are all `#ffffffff` once the fade lands).
function tintOf(stage: HTMLElement, id: string): string | null {
  const el = stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null;
  const m = /url\(#?["']?#(mtint-[\d_]+)/.exec(el?.style.filter ?? "");
  return m ? m[1] : null;
}

function transformOfEl(stage: HTMLElement, id: string): string {
  const el = stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null;
  return el?.style.transform ?? "";
}

describe("R20 item 5 — a transform pin must not swallow the fade riding with it", () => {
  let clock = 0;
  let rafCbs: FrameRequestCallback[] = [];
  let stage: HTMLElement;
  let renderer: MirrorRenderer;
  let state: MirrorState;

  beforeEach(() => {
    document.body.innerHTML = "";
    clock = 0;
    rafCbs = [];
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    // A hint that declares its `.From(…)` start is PRIMED by the reconcile and ARMED a frame later (the renderer's
    // deferred-arm path), so the frame callback has to be modelled or no pin would ever exist here.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafCbs.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(defs);
    stage = document.createElement("div");
    document.body.append(stage, svg);
    renderer = createMirrorRenderer(stage, defs);
    // The live client that hit this was on a 2520×1080 phone-landscape stage, i.e. the wide-screen squeeze field
    // was ON — which is what makes the placement half of the assertion below meaningful.
    renderer.setStretch(1.3125);
    state = createMirrorState();
    mirrorWalkStats.reset();
  });

  afterEach(() => {
    renderer.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // One rendered frame: reconcile, then run the frame callbacks the browser would (the deferred tween arm).
  function render(): void {
    renderer.reconcile(state);
    const due = rafCbs;
    rafCbs = [];
    for (const cb of due) {
      cb(clock);
    }
  }

  // Replay: the resting keyframe (so the popup HAS a record and its hints are not dropped), then the open — the
  // first seven fade frames coalesced into one stalled reconcile that arms the pin, then a reconcile per frame.
  function replayOpen(): void {
    clock = 0;
    keyframe(state);
    render();

    const base = 1000;
    for (let i = 0; i <= STALL_THROUGH; i++) {
      fadeFrame(state, i, i === 0);
    }
    clock = base + FADE[STALL_THROUGH].atMs;
    render();

    for (let i = STALL_THROUGH + 1; i < FADE.length; i++) {
      fadeFrame(state, i, false);
      clock = base + FADE[i].atMs;
      render();
    }
  }

  it("ends the open at the game's own white, with the fade tracking the wire frame by frame", () => {
    replayOpen();

    // The wire settled at #ffffffff and so has the client: no tint filter anywhere in the dialog.
    expect(state.nodes.get("popup")!.modulate!.html).toBe("#ffffffff");
    expect(tintOf(stage, "panel")).toBeNull();
    expect(tintOf(stage, "icon")).toBeNull();
    // …and it got there by tracking the ramp, not by one late correction: every swallowed frame is a repair.
    expect(mirrorWalkStats.pinPaintRepairs).toBeGreaterThan(8);

    // The last fade frame lands INSIDE the pin window (that is the whole defect: after it, nothing dirties this
    // subtree again). Prove the end state is not merely the pin expiring afterwards.
    expect(FADE[FADE.length - 1].atMs).toBeLessThan(FADE[STALL_THROUGH].atMs + TWEEN_MS);
  });

  it("keeps the riding subtree's placement byte-identical while the pin lasts", () => {
    clock = 0;
    keyframe(state);
    render();

    const base = 1000;
    for (let i = 0; i <= STALL_THROUGH; i++) {
      fadeFrame(state, i, i === 0);
    }
    clock = base + FADE[STALL_THROUGH].atMs;
    render();
    // The arrow slides HORIZONTALLY, so on a squeezed wide stage its descendants' spread shift is a function of a
    // coordinate that moves every frame. Re-deriving them off the streamed transform is exactly what the pin skip
    // exists to prevent (the TopBar slide) — the repair must therefore change the paint and nothing else.
    const pinnedIcon = transformOfEl(stage, "icon");
    const pinnedPanel = transformOfEl(stage, "panel");
    expect(pinnedIcon).not.toBe("");

    for (let i = STALL_THROUGH + 1; i < FADE.length; i++) {
      fadeFrame(state, i, false);
      clock = base + FADE[i].atMs;
      render();
      // Still inside the pin window for every one of these frames.
      expect(transformOfEl(stage, "icon")).toBe(pinnedIcon);
      expect(transformOfEl(stage, "panel")).toBe(pinnedPanel);
    }
    expect(mirrorWalkStats.pinPaintRepairs).toBeGreaterThan(0);
  });

  // The captured popup slides on Y alone, and on a squeezed stage a node's shift is a function of its X — so the
  // guard above cannot see a sideways move. This variant streams the same fade over a pose that sweeps
  // horizontally, which puts every riding descendant's spread claim on a coordinate that moves every frame.
  // The replay fails if a repair adopts fresh matrices instead of preserving the pinned parent relationship.
  it("repaints a rider without re-spreading it when the pinned pose sweeps sideways", () => {
    clock = 0;
    keyframe(state);
    render();

    const sweepX = (i: number): number => 328 + (200 * i) / (FADE.length - 1);
    const base = 1000;
    for (let i = 0; i <= STALL_THROUGH; i++) {
      fadeFrame(state, i, i === 0, sweepX(i));
    }
    clock = base + FADE[STALL_THROUGH].atMs;
    render();
    const pinnedPanel = transformOfEl(stage, "panel");
    expect(pinnedPanel).toContain("matrix(");

    let tints = 0;
    for (let i = STALL_THROUGH + 1; i < FADE.length; i++) {
      fadeFrame(state, i, false, sweepX(i));
      clock = base + FADE[i].atMs;
      render();
      expect(transformOfEl(stage, "panel")).toBe(pinnedPanel);
      if (tintOf(stage, "panel") !== null) {
        tints++;
      }
    }
    // …and the paint really was moving while the placement held still.
    expect(tints).toBeGreaterThan(0);
    expect(tintOf(stage, "panel")).toBeNull();
    expect(mirrorWalkStats.pinPaintRepairs).toBeGreaterThan(0);
  });

});
