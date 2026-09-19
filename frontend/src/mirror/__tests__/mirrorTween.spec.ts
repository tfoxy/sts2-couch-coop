import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,





  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { affineMul, IDENTITY_AFFINE, type Affine } from "@/mirror/affine";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorState,
  type MirrorTweenHint
} from "@/mirror/sceneTree";

// Part C — declarative tween replay. A transform-endpoint hint on a node ROOT arms a CSS `transition` on the
// node's whole subtree (rigidly propagated, shared timing → no tearing); streamed intermediate transforms are
// ignored while owned (pinned to the endpoint); the transition is cleared at epoch end so hovers stay instant.

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

// A node at global translation (x, y) (identity basis), with a box so it renders a `matrix(...)` transform.
function node(id: string, parentId: string | null, x: number, y: number): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "ColorRect",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 90, y: 130 } },
    visible: true,
    fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#e0574a" }
  };
}

// A node with an explicit `modulate.a` (the alpha the game fades) — identity RGB so no tint filter is registered.
function nodeMod(id: string, parentId: string | null, x: number, y: number, modA: number): Record<string, unknown> {
  return { ...node(id, parentId, x, y), modulate: { r: 1, g: 1, b: 1, a: modA, html: "#ffffff" } };
}

// A node with an explicit `self_modulate.a` (the alpha a self_modulate fade drives — the node's OWN paint only,
// never the child cascade). Identity RGB so no tint filter is registered.
function nodeSelfMod(id: string, parentId: string | null, x: number, y: number, selfA: number): Record<string, unknown> {
  return { ...node(id, parentId, x, y), selfModulate: { r: 1, g: 1, b: 1, a: selfA, html: "#ffffff" } };
}

// A clip container (clips its nested children to its box) carrying a self_modulate alpha on its own paint. Its
// texture/fill paint splits onto a `.mirror-clip-self` layer that carries selfAlpha; the container element carries
// the cascading childOpacity.
function clipNode(id: string, parentId: string | null, x: number, y: number, selfA: number): Record<string, unknown> {
  return { ...node(id, parentId, x, y), clipChildren: 1, selfModulate: { r: 1, g: 1, b: 1, a: selfA, html: "#ffffff" } };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
}

function volatile(state: MirrorState, nodes: Record<string, unknown>[], hints?: unknown[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes, hints })!);
}

function hintsOnly(state: MirrorState, hints: unknown[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", hints })!);
}

// A full keyframe — the node `transform`s are parent-relative (composed
// down the walk), and a tween endTransform is the target's END LOCAL transform (lifted by the parent global).
function fullLocal(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!
  );
}

function el(stage: HTMLElement, id: string): HTMLElement {
  return stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
}

function tx(elx: HTMLElement): number {
  const m = /matrix\(([^)]*)\)/.exec(elx.style.transform);
  return m ? Number(m[1].split(",")[4]) : Number.NaN;
}
function ty(elx: HTMLElement): number {
  const m = /matrix\(([^)]*)\)/.exec(elx.style.transform);
  return m ? Number(m[1].split(",")[5]) : Number.NaN;
}

// Every fixture below uses Godot trans "Cubic" + ease "Out", which `godotEasingToCss` (@godot-scene-web/html) maps to
// `cubic-bezier(0.33, 1, 0.68, 1)` — the Penner easeOutCubic fit. WS6 replaced the old generic `ease-out` fallback for
// the polynomial/trig families (that fallback lagged Godot by up to 0.39 of the travel distance on QuintOut, which is
// what made the mirror's shop-open slide look ~2× slower than the game). These specs assert the transition
// COMPOSITION (which channels, which durations); the mapping itself is covered by gsw's own easing tests.

// A transform-endpoint hint (position tween): the TARGET's end global as a 6-tuple [a,b,c,d,tx,ty].
function transformHint(targetId: string, endTransform: number[], durationMs = 200): Partial<MirrorTweenHint> & Record<string, unknown> {
  return { targetId, property: "position", durationMs, trans: "Cubic", ease: "Out", endTransform };
}

// An opacity-endpoint hint (modulate:a fade): `endOpacity` is the TARGET node's END modulate.a.
function opacityHint(targetId: string, endOpacity: number, durationMs = 200): Partial<MirrorTweenHint> & Record<string, unknown> {
  return { targetId, property: "modulate:a", durationMs, trans: "Cubic", ease: "Out", endOpacity };
}

// A self_modulate:a fade hint: same shape as opacityHint but the property marks it self-only (target-pinned, no fan).
function selfOpacityHint(targetId: string, endOpacity: number, durationMs = 200): Partial<MirrorTweenHint> & Record<string, unknown> {
  return { targetId, property: "self_modulate:a", durationMs, trans: "Cubic", ease: "Out", endOpacity };
}

describe("mirror declarative tween replay (Part C, Stage 1)", () => {
  let clock = 0;
  let rafCb: FrameRequestCallback | null = null;
  // WS-B: the renderer's animation loop is DEADLINE-SCHEDULED — it parks on a `setTimeout` until the earliest live
  // tween deadline and only THEN requests the rAF that mutates. Model both halves against the same fake clock so
  // `flushRaf(atMs)` keeps its meaning ("let the renderer run at this wall-clock time").
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

  afterEach(() => {
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

  it("parses the endTransform / endOpacity / group wire fields", () => {
    const delta = parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      hints: [
        { targetId: "n", property: "position", durationMs: 200, trans: "Cubic", ease: "Out", endTransform: [1, 0, 0, 1, 5, 6], group: "g1" },
        { targetId: "n", property: "modulate:a", durationMs: 200, endOpacity: 0.3, group: "g1" }
      ]
    })!;
    expect(delta.hints[0].endTransform).toEqual([1, 0, 0, 1, 5, 6]);
    expect(delta.hints[0].group).toBe("g1");
    expect(delta.hints[1].endOpacity).toBe(0.3);
    // A malformed endTransform (wrong arity) normalizes to null.
    const bad = parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", hints: [{ targetId: "n", property: "position", endTransform: [1, 2, 3] }] })!;
    expect(bad.hints[0].endTransform).toBeNull();
  });

  it("parses the startTransform / startOpacity wire fields (Fix 2)", () => {
    const delta = parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      hints: [
        {
          targetId: "n",
          property: "global_position:x",
          durationMs: 250,
          endTransform: [1, 0, 0, 1, 272, 80],
          startTransform: [1, 0, 0, 1, 300, 80]
        },
        { targetId: "n", property: "modulate:a", durationMs: 50, endOpacity: 1, startOpacity: 0 }
      ]
    })!;
    expect(delta.hints[0].startTransform).toEqual([1, 0, 0, 1, 300, 80]);
    expect(delta.hints[1].startOpacity).toBe(0);
    // A malformed startTransform (wrong arity) normalizes to null; a missing start stays null.
    const bad = parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      hints: [{ targetId: "n", property: "position", startTransform: [1, 2, 3], endTransform: [1, 0, 0, 1, 5, 6] }]
    })!;
    expect(bad.hints[0].startTransform).toBeNull();
    expect(bad.hints[0].startOpacity).toBeNull();
  });

  it("NEVER reflows — a start-less hint has nothing to commit, a primed one defers its arm a frame (WS-P1)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("r", null, 300, 80)], ["r"]);
    renderer.reconcile(state);

    const reflow = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(0);

    // A start-LESS transform hint primes nothing, so there is nothing for the reflow to commit: it is skipped
    // entirely (59 phone profiler samples sat in this one forced layout). The endpoint still arms SYNCHRONOUSLY —
    // a primeless batch is unchanged by the deferred-arm work.
    hintsOnly(state, [transformHint("r", [1, 0, 0, 1, 272, 80], 250)]);
    renderer.reconcile(state);
    expect(reflow.mock.calls.length).toBe(0);
    expect(tx(el(stage, "r"))).toBe(272);

    reflow.mockClear();

    // R10-PERF6 WS-P1: the SAME hint carrying a declared start no longer forces the layout engine at all. The prime
    // lands (and PINS the channel) inside the reconcile; the arm rides the next frame, where the browser has
    // already committed the primed start as the transition's implicit "from".
    hintsOnly(state, [{ ...transformHint("r", [1, 0, 0, 1, 272, 80], 250), startTransform: [1, 0, 0, 1, 300, 80] }]);
    renderer.reconcile(state);
    expect(reflow.mock.calls.length).toBe(0);
    expect(tx(el(stage, "r"))).toBe(300); // still at the PRIMED start, transition-less, until the arm lands
    expect(el(stage, "r").style.transition).toBe("none");

    flushRaf(clock);
    expect(reflow.mock.calls.length).toBe(0);
    expect(tx(el(stage, "r"))).toBe(272); // armed at the endpoint one frame later
    expect(el(stage, "r").style.transition).toBe("transform 250ms cubic-bezier(0.33, 1, 0.68, 1)");

    reflow.mockRestore();
  });

  it("WS-ANIM: a start (implicit OR declared) primes the element off the FOLDED near-final value; a start-less hint collapses", () => {
    // The slow-client collapse this whole feature defends against: the coalescer folds the node create + settle
    // re-emit + hint into ONE message, so the element is reconciled at the NEAR-FINAL streamed value (1983) BEFORE the
    // hint arms. With a start on the hint (the wire field is identical whether the producer sampled it implicitly or
    // the game declared `.From(...)`), the client PRIMES to the real start (1583) transition-less at the single reflow,
    // so the transition animates 1583→1983. WITHOUT a start it stays at the folded 1983 → no motion (backward-compat).
    const { stage, renderer } = harness();
    const state = createMirrorState();

    // R10-PERF6 WS-P1: the pre-arm state is now observable directly — the prime lands in the reconcile and the arm
    // rides the NEXT frame, with no forced reflow between them.
    const target = (): HTMLElement => el(stage, "btn");
    const reflow = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(0);

    // Node folded to the NEAR-FINAL value 1983 (the coalesced streamed transform), THEN a hint carrying the start 1583.
    full(state, [node("btn", null, 1983, 764)], ["btn"]);
    renderer.reconcile(state);
    hintsOnly(state, [{ ...transformHint("btn", [1, 0, 0, 1, 1983, 764], 800), startTransform: [1, 0, 0, 1, 1583, 764] }]);
    renderer.reconcile(state);
    expect(reflow.mock.calls.length).toBe(0); // the layout engine is never forced
    expect(tx(target())).toBe(1583); // PRIMED to the real start off the folded 1983
    expect(target().style.transition).toBe("none"); // transition-less so the prime IS the transition's implicit "from"

    flushRaf(clock);
    expect(tx(target())).toBe(1983); // armed endpoint → the browser animates 1583 → 1983
    expect(target().style.transition).toBe("transform 800ms cubic-bezier(0.33, 1, 0.68, 1)");

    // Same fold, but a START-LESS hint (an old mod, or the kill-switch off): no prime — so (R10-PERF4 WS-3 item 1)
    // there is no pre-arm reflow AT ALL, and the element stays at the folded 1983, i.e. the "animation" collapses
    // (arms straight to 1983). Same pre-WS-ANIM visual outcome, one forced layout cheaper.
    reflow.mockClear();
    full(state, [node("btn", null, 1983, 764)], ["btn"]);
    renderer.reconcile(state);
    hintsOnly(state, [transformHint("btn", [1, 0, 0, 1, 1983, 764], 800)]);
    renderer.reconcile(state);
    expect(reflow.mock.calls.length).toBe(0); // nothing primed → nothing to commit
    expect(tx(target())).toBe(1983); // armed synchronously (a primeless batch never defers)

    reflow.mockRestore();
  });

  it("REGRESSION: a target driven by BOTH a transform+start and an opacity+start hint keeps BOTH transitions", () => {
    // The prime-clobber bug: priming the opacity channel (`transition:none` + reflow) after the transform channel was
    // already armed snapped the transform to its end — losing the slide, keeping only the fade. The collect→prime-all→
    // ONE reflow→arm-all restructure must reflow once and leave the element animating on both channels.
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A shared reticle-like node latched at (300,80) and modulate.a=1 from the previous option.
    full(state, [nodeMod("ret", null, 300, 80, 1)], ["ret"]);
    renderer.reconcile(state);

    const reflow = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(0);

    // The reticle re-anchors: slide global x 300→272 (250ms) AND fade in modulate.a 0→1 (50ms), both with a start.
    hintsOnly(state, [
      { ...transformHint("ret", [1, 0, 0, 1, 272, 80], 250), startTransform: [1, 0, 0, 1, 300, 80] },
      { ...opacityHint("ret", 1, 50), startOpacity: 0 }
    ]);
    renderer.reconcile(state);

    const r = el(stage, "ret");
    // R10-PERF6 WS-P1: no reflow at all, and BOTH channels sit at their primed starts until the deferred arm.
    expect(reflow.mock.calls.length).toBe(0);
    expect(tx(r)).toBe(300);
    expect(r.style.opacity).toBe("0");
    expect(r.style.transition).toBe("none");

    flushRaf(clock);
    // Both channels stay armed (composed transition) — the transform is NOT snapped to its end by the opacity prime.
    expect(r.style.transition).toBe("transform 250ms cubic-bezier(0.33, 1, 0.68, 1), opacity 50ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(tx(r)).toBe(272); // slide endpoint (animating from the primed 300)
    expect(r.style.opacity).toBe("1"); // fade endpoint (animating from the primed 0)

    reflow.mockRestore();
  });

  it("primes an opacity fade from its declared start then arms the end alpha (Fix 2)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A shared reticle-like node latched at modulate.a=1 from the previous option.
    full(state, [nodeMod("ret", null, 100, 100, 1)], ["ret"]);
    renderer.reconcile(state);

    // A fade-IN From(0)→1: with a declared start the client primes to 0 then arms 1.
    hintsOnly(state, [{ ...opacityHint("ret", 1, 50), startOpacity: 0 }]);
    renderer.reconcile(state);
    const r = el(stage, "ret");
    expect(r.style.opacity).toBe("0"); // PINNED at the primed start until the deferred arm (WS-P1)
    flushRaf(clock);
    expect(r.style.transition).toBe("opacity 50ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(r.style.opacity).toBe("1"); // armed at the end alpha (the prime-to-0 is the transition's implicit from)
  });

  it("arms the transition on the TARGET only; nested descendants ride via the DOM (untouched, no fan)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // parent p at global (100,100); child c NESTED under p, rigidly offset to global (110,120) → relative (10,20).
    full(state, [node("p", null, 100, 100), node("c", "p", 10, 20)], ["p", "c"]);
    renderer.reconcile(state);
    const p0 = el(stage, "p");
    const c0 = el(stage, "c");
    expect(p0.contains(c0)).toBe(true); // c is a DOM DESCENDANT of p (nested model)
    expect(tx(p0)).toBe(100); // root → global
    expect([tx(c0), ty(c0)]).toEqual([10, 20]); // child placed RELATIVE to its parent element
    const cTransformBefore = c0.style.transform;

    // A position tween moves p's global to (300,100). Only p is armed — c follows rigidly THROUGH the DOM.
    hintsOnly(state, [transformHint("p", [1, 0, 0, 1, 300, 100], 200)]);
    renderer.reconcile(state);

    const p = el(stage, "p");
    const c = el(stage, "c");
    expect(p.style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect([tx(p), ty(p)]).toEqual([300, 100]); // target endpoint on the parent element
    // The descendant is NOT armed and NOT rewritten — its relative placement is unchanged, so it rides p's
    // transition through the DOM (no fan, no per-descendant transition → no tearing).
    expect(c.style.transition).toBe("");
    expect(c.style.transform).toBe(cTransformBefore); // byte-identical
  });

  it("ignores streamed intermediate transforms while owned (pinned to the endpoint)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("p", null, 100, 100)], ["p"]);
    renderer.reconcile(state);

    clock = 10;
    hintsOnly(state, [transformHint("p", [1, 0, 0, 1, 300, 100], 200)]);
    renderer.reconcile(state);
    expect(tx(el(stage, "p"))).toBe(300);

    // A streamed intermediate frame (the game's own tween at t=60%) arrives mid-window — it must be IGNORED.
    clock = 130;
    volatile(state, [node("p", null, 220, 100)]);
    renderer.reconcile(state);
    expect(tx(el(stage, "p"))).toBe(300); // still pinned to the endpoint, not the streamed 220
  });

  it("clears the transition at epoch end so a later reposition is instant (no hover smear)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("p", null, 100, 100)], ["p"]);
    renderer.reconcile(state);

    clock = 0;
    hintsOnly(state, [transformHint("p", [1, 0, 0, 1, 300, 100], 200)]);
    renderer.reconcile(state);
    const p = el(stage, "p");
    expect(p.style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1)");

    // Before the epoch, the rAF keeps it armed.
    flushRaf(100);
    expect(p.style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1)");

    // Past the epoch (now >= 200) the transition is cleared.
    flushRaf(210);
    expect(p.style.transition).toBe("");

    // A subsequent instant reposition (a hover) writes the new transform with NO transition → instant.
    clock = 300;
    volatile(state, [node("p", null, 140, 100)]);
    renderer.reconcile(state);
    expect(p.style.transition).toBe("");
    expect(tx(p)).toBe(140);
  });

  it("never arms a node that has no tween hint (a hover-moved node is never smeared)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("h", null, 40, 40)], ["h"]);
    renderer.reconcile(state);
    // Move it (as a hover would) with no hint.
    volatile(state, [node("h", null, 90, 40)]);
    renderer.reconcile(state);
    const h = el(stage, "h");
    expect(h.style.transition).toBe("");
    expect(tx(h)).toBe(90);
  });

  it("drops a hint whose target node isn't mirrored (one-shot, no crash)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("p", null, 100, 100)], ["p"]);
    renderer.reconcile(state);
    hintsOnly(state, [transformHint("ghost", [1, 0, 0, 1, 300, 100], 200)]);
    expect(() => renderer.reconcile(state)).not.toThrow();
    expect(el(stage, "p").style.transition).toBe("");
  });

  // Stage 4 — modulate alpha fades. An `endOpacity` hint arms an `opacity` transition on the target's whole subtree,
  // pinning each node's END painted opacity (a re-root cascade of the target's fade). CSS opacity doesn't inherit
  // across the flat DOM, so every subtree node is pinned individually.

  it("pins a modulate fade on the TARGET element only — CSS opacity cascades to the nested subtree (no fan)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // Nested p→c→d. Element opacity is now each node's OWN modulate.a (CSS multiplies down the DOM): p=1, c=0.5, d=1.
    full(state, [nodeMod("p", null, 100, 100, 1), nodeMod("c", "p", 110, 120, 0.5), nodeMod("d", "c", 120, 140, 1)], ["p", "c", "d"]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("1");
    expect(el(stage, "c").style.opacity).toBe("0.5");
    expect(el(stage, "d").style.opacity).toBe("1");

    // Fade p's own modulate.a → 0.2. Only p is armed; c and d cascade under it via CSS and are UNTOUCHED.
    hintsOnly(state, [opacityHint("p", 0.2, 200)]);
    renderer.reconcile(state);
    const [p, c, d] = [el(stage, "p"), el(stage, "c"), el(stage, "d")];
    expect(p.style.transition).toBe("opacity 200ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(p.style.opacity).toBe("0.2"); // raw end modulate.a (NOT composed)
    expect(c.style.transition).toBe("");
    expect(d.style.transition).toBe("");
    expect(c.style.opacity).toBe("0.5"); // untouched — its own modulate.a
    expect(d.style.opacity).toBe("1");
  });

  it("handles a fade-IN from modulate.a=0 on the target (raw endpoint, no NaN/Infinity)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // p starts fully invisible (its own modulate.a=0); c under it keeps its own modulate.a=1 (visually 0 via cascade).
    full(state, [nodeMod("p", null, 100, 100, 0), nodeMod("c", "p", 110, 120, 1)], ["p", "c"]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("0");
    expect(el(stage, "c").style.opacity).toBe("1");

    hintsOnly(state, [opacityHint("p", 1, 200)]);
    renderer.reconcile(state);
    const [p, c] = [el(stage, "p"), el(stage, "c")];
    expect(p.style.opacity).toBe("1"); // raw endpoint (no ratio → no divide-by-zero)
    expect(c.style.transition).toBe(""); // untouched — rides p's cascade
    expect(c.style.opacity).toBe("1");
    expect(Number.isFinite(Number(p.style.opacity))).toBe(true);
  });

  it("arms both channels on a node driven by a parallel move + fade (one composed transition)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [nodeMod("p", null, 100, 100, 1)], ["p"]);
    renderer.reconcile(state);

    hintsOnly(state, [transformHint("p", [1, 0, 0, 1, 300, 100], 200), opacityHint("p", 0.3, 200)]);
    renderer.reconcile(state);
    const p = el(stage, "p");
    expect(p.style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1), opacity 200ms cubic-bezier(0.33, 1, 0.68, 1)"); // transform channel first
    expect([tx(p), ty(p)]).toEqual([300, 100]);
    expect(p.style.opacity).toBe("0.3");
  });

  it("expires each channel independently (a longer fade outlives a shorter move)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [nodeMod("p", null, 100, 100, 1)], ["p"]);
    renderer.reconcile(state);

    clock = 0;
    hintsOnly(state, [transformHint("p", [1, 0, 0, 1, 300, 100], 200), opacityHint("p", 0.3, 400)]);
    renderer.reconcile(state);
    const p = el(stage, "p");
    expect(p.style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1), opacity 400ms cubic-bezier(0.33, 1, 0.68, 1)");

    // Past the move's epoch (200) but not the fade's (400): the transform channel drops, opacity keeps animating.
    flushRaf(210);
    expect(p.style.transition).toBe("opacity 400ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(p.style.opacity).toBe("0.3");

    // Past the fade's epoch too: fully cleared → a later instant change isn't smeared.
    flushRaf(410);
    expect(p.style.transition).toBe("");
  });

  it("clears the fade at epoch end so a later streamed opacity is instant", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [nodeMod("p", null, 100, 100, 1)], ["p"]);
    renderer.reconcile(state);

    clock = 0;
    hintsOnly(state, [opacityHint("p", 0.2, 200)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("0.2");

    flushRaf(210);
    expect(el(stage, "p").style.transition).toBe("");

    // A subsequent streamed modulate change (no hint) writes the new opacity with NO transition → instant.
    clock = 300;
    volatile(state, [nodeMod("p", null, 100, 100, 0.7)]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("0.7");
    expect(el(stage, "p").style.transition).toBe("");
  });

  it("never arms opacity on a modulate change with no hint (no fade smear on a flicker)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [nodeMod("h", null, 40, 40, 1)], ["h"]);
    renderer.reconcile(state);
    volatile(state, [nodeMod("h", null, 40, 40, 0.4)]);
    renderer.reconcile(state);
    const h = el(stage, "h");
    expect(h.style.transition).toBe("");
    expect(h.style.opacity).toBe("0.4");
  });

  // A-client + item C — self_modulate fades. `self_modulate` changes ONLY the node's own paint (selfAlpha), never the
  // child cascade, so the endpoint is pinned on the TARGET alone (no subtree fan). For a clip container that own paint
  // lives on the `.mirror-clip-self` layer, so the layer animates, not the container element.

  it("pins a self_modulate fade on an INTERIOR target's self-paint layer (not the element; children untouched)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // p is INTERIOR (children c, d) with own paint (fillColor) + a self_modulate alpha. c under p, d under c.
    full(state, [nodeSelfMod("p", null, 100, 100, 1), node("c", "p", 10, 20), node("d", "c", 10, 20)], ["p", "c", "d"]);
    renderer.reconcile(state);
    const p = el(stage, "p");
    const pSelf = p.querySelector(":scope > .mirror-clip-self") as HTMLElement;
    expect(pSelf).not.toBeNull(); // interior node with own paint → self-layer
    expect(p.style.opacity).toBe("1"); // container keeps modulate.a (=1) → cascades to children

    // Fade p's OWN self_modulate.a → 0.2. Only p's self-paint layer animates; the container + children are untouched.
    hintsOnly(state, [selfOpacityHint("p", 0.2, 200)]);
    renderer.reconcile(state);
    expect(pSelf.style.opacity).toBe("0.2");
    expect(pSelf.style.transition).toBe("opacity 200ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(p.style.opacity).toBe("1"); // element unchanged — the nested children don't fade
    expect(p.style.transition).toBe("");
    const [c, d] = [el(stage, "c"), el(stage, "d")];
    expect(c.style.transition).toBe("");
    expect(d.style.transition).toBe("");
  });

  it("folds a self_modulate fade into the ELEMENT opacity for a LEAF target (modAlpha × selfAlpha)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A LEAF (no children) with a modulate.a=0.5 and a self_modulate. Element opacity = modAlpha × selfAlpha.
    const leaf = { ...nodeSelfMod("leaf", null, 40, 40, 1), modulate: { r: 1, g: 1, b: 1, a: 0.5, html: "#ffffff" } };
    full(state, [leaf], ["leaf"]);
    renderer.reconcile(state);
    expect(el(stage, "leaf").style.opacity).toBe("0.5"); // 0.5 × 1

    // Fade self_modulate.a → 0.4: the leaf element opacity animates to modAlpha(0.5) × 0.4 = 0.2 (no self-layer).
    hintsOnly(state, [selfOpacityHint("leaf", 0.4, 200)]);
    renderer.reconcile(state);
    const el0 = el(stage, "leaf");
    expect(el0.style.opacity).toBe("0.2");
    expect(el0.style.transition).toBe("opacity 200ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(el0.querySelector(":scope > .mirror-clip-self")).toBeNull(); // leaf → no self-layer
  });

  it("animates a clip container's self-paint layer (not the container) on a self_modulate fade (item C)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // k is a clip container WITH a nested child (so it's INTERIOR): container opacity = modulate.a, self-paint = selfAlpha.
    full(state, [clipNode("k", null, 100, 100, 1), node("kid", "k", 110, 110)], ["k", "kid"]);
    renderer.reconcile(state);
    const container = el(stage, "k");
    const clipSelf = container.querySelector(":scope > .mirror-clip-self") as HTMLElement;
    expect(clipSelf).not.toBeNull();
    expect(container.style.opacity).toBe("1"); // modulate.a cascades to the nested child

    // Fade k's own self_modulate.a → 0.3: the self-paint layer's opacity animates to m1; the container is untouched.
    hintsOnly(state, [selfOpacityHint("k", 0.3, 200)]);
    renderer.reconcile(state);
    expect(clipSelf.style.opacity).toBe("0.3");
    expect(clipSelf.style.transition).toBe("opacity 200ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(container.style.opacity).toBe("1"); // modulate.a unchanged — nested children don't fade
    // The container element itself carries no opacity transition (only its self-paint layer animates).
    expect(container.style.transition).toBe("");
  });

  it("handles a self fade-IN from self_modulate.a=0 (no NaN/Infinity)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [nodeSelfMod("p", null, 100, 100, 0)], ["p"]);
    renderer.reconcile(state);
    expect(el(stage, "p").style.opacity).toBe("0");

    hintsOnly(state, [selfOpacityHint("p", 1, 200)]);
    renderer.reconcile(state);
    const p = el(stage, "p");
    expect(p.style.opacity).toBe("1"); // childOpacity_current(1) · m1(1)
    expect(Number.isFinite(Number(p.style.opacity))).toBe(true);
  });

  it("REGRESSION: a modulate:a hint pins the TARGET only even when descendants carry self_modulate (no fan)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // c/d carry self_modulate (which does NOT cascade). The old fan had to special-case them; the nested model has
    // no fan at all — only p is armed, and CSS opacity cascades to c/d regardless of their self_modulate.
    full(
      state,
      [nodeMod("p", null, 100, 100, 1), nodeSelfMod("c", "p", 110, 120, 0.5), nodeSelfMod("d", "c", 120, 140, 0.7)],
      ["p", "c", "d"]
    );
    renderer.reconcile(state);

    hintsOnly(state, [opacityHint("p", 0.2, 200)]);
    renderer.reconcile(state);
    const [p, c, d] = [el(stage, "p"), el(stage, "c"), el(stage, "d")];
    expect(p.style.transition).toBe("opacity 200ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect(p.style.opacity).toBe("0.2");
    // Descendants untouched — their own opacity (modAlpha × selfAlpha for a leaf) is unchanged.
    expect(c.style.transition).toBe("");
    expect(d.style.transition).toBe("");
  });

  it("a nested tween endpoint is the target's end local transform", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [node("p", null, 100, 100), node("c", "p", 10, 20)], ["p", "c"]);
    renderer.reconcile(state);
    expect([tx(el(stage, "c")), ty(el(stage, "c"))]).toEqual([10, 20]);

    hintsOnly(state, [transformHint("c", [1, 0, 0, 1, 30, 20], 200)]);
    renderer.reconcile(state);
    expect(el(stage, "c").style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect([tx(el(stage, "c")), ty(el(stage, "c"))]).toEqual([30, 20]);
  });

  it("Stage 2: a deep dirty descendant updates under a tween-pinned ancestor without disturbing the pin", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // p (to be pinned) → c (clean intermediate) → d (deep descendant). Nested: c rel p, d rel c.
    full(state, [node("p", null, 100, 100), node("c", "p", 50, 30), node("d", "c", 10, 10)], ["p", "c", "d"]);
    renderer.reconcile(state);
    expect([tx(el(stage, "p")), ty(el(stage, "p"))]).toEqual([100, 100]);

    // Arm a transform tween on p → (300,100): pins p's element to the endpoint for 200ms.
    clock = 0;
    hintsOnly(state, [transformHint("p", [1, 0, 0, 1, 300, 100], 200)]);
    renderer.reconcile(state);
    expect(tx(el(stage, "p"))).toBe(300);
    const dBefore = el(stage, "d").style.transform;

    // Mid-tween (t=100 < 200), ONLY the deep descendant d moves (fresh streamed frame). p and c keep object identity,
    // so p takes the recurse-only fast path (its pinned element must be left completely untouched) and c is a clean
    // intermediate on the dirty path down to d.
    clock = 100;
    volatile(state, [node("d", "c", 50, 50)]);
    renderer.reconcile(state);

    // The pinned ancestor's element is untouched: still at the endpoint, transition intact.
    expect(tx(el(stage, "p"))).toBe(300);
    expect(el(stage, "p").style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1)");
    // The deep descendant re-based to its new global (its element transform actually changed).
    expect(el(stage, "d").style.transform).not.toBe(dBefore);
    expect([tx(el(stage, "d")), ty(el(stage, "d"))]).toEqual([50, 50]); // 200-150, 180-130 relative to c
  });

  it("lifts a target's end-local tween to the same element matrix", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // p local (100,100) [root → == global]; c LOCAL (10,20) → c global = p·c_local = (110,120) → relative (10,20).
    fullLocal(state, [node("p", null, 100, 100), node("c", "p", 10, 20)], ["p", "c"]);
    renderer.reconcile(state);
    expect([tx(el(stage, "c")), ty(el(stage, "c"))]).toEqual([10, 20]); // identical placement to the global fixture

    // Move c's LOCAL x 10→30. Lifted by p's global (100,100) → global (130,120) → relative (30,20): SAME as global mode.
    hintsOnly(state, [transformHint("c", [1, 0, 0, 1, 30, 20], 200)]);
    renderer.reconcile(state);
    expect(el(stage, "c").style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1)");
    expect([tx(el(stage, "c")), ty(el(stage, "c"))]).toEqual([30, 20]);
  });

  // R10-B1 — the post-settle DERASTER SCALE GATE. Tearing the will-change layer down after a settle re-rasters the
  // element at its final transform (the fix for blurry card text after a zoom), but it costs a second
  // Layerize+Commit echo per settle group. A translation-only tween cannot change the rasterization scale, so those
  // settles skip it; anything that changes the 2×2 linear part still derasters.
  describe("deraster scale gate", () => {
    function settleTween(endTransform: number[]): HTMLElement {
      const { stage, renderer } = harness();
      const state = createMirrorState();
      full(state, [node("p", null, 100, 100)], ["p"]);
      renderer.reconcile(state);
      clock = 0;
      hintsOnly(state, [transformHint("p", endTransform, 200)]);
      renderer.reconcile(state);
      flushRaf(210); // the settle wakeup: expires the channel and decides on the deraster
      return el(stage, "p");
    }

    it("SKIPS the will-change re-raster for a translation-only tween", () => {
      expect(settleTween([1, 0, 0, 1, 300, 140]).style.willChange).toBe("");
    });

    it("KEEPS it when the tween changes SCALE (the blurry-text fix must survive)", () => {
      expect(settleTween([1.4, 0, 0, 1.4, 300, 140]).style.willChange).toBe("transform");
    });

    it("KEEPS it when the tween changes ROTATION (an off-diagonal linear change)", () => {
      const c = Math.cos(0.4);
      const s = Math.sin(0.4);
      expect(settleTween([c, s, -s, c, 300, 140]).style.willChange).toBe("transform");
    });

  });

  // WS-4 HAND-LAYOUT APPROACH HINTS. The hand's card-layout motion is not a Godot tween — the producer derives it
  // analytically and ships it as an ORDINARY tween hint per card slot (Expo/Out, transform endpoint, NO declared
  // start) while suppressing that slot's per-frame transforms for the hint's duration. That makes MID-FLIGHT
  // RE-TARGETING the normal case, not an edge case: every newly drawn card re-lays-out the whole hand, so each slot
  // is re-targeted while its previous approach is still running. These specs pin the three client-side properties
  // the producer's design depends on.
  describe("hand-layout approach hints (WS-4)", () => {
    // Godot trans "Expo" + ease "Out" — an exponential approach and an expo-out transition are the same curve,
    // which is the whole reason this ships as a plain tween hint instead of a new wire type.
    const EXPO_OUT = "cubic-bezier(0.19, 1, 0.22, 1)";

    function handHint(targetId: string, endLocal: number[], durationMs: number): Record<string, unknown> {
      return { targetId, property: "position", durationMs, trans: "Expo", ease: "Out", endTransform: endLocal };
    }

    // A hand: the container at global (960,900), one card SLOT at local (-200,0), and the card itself nested at
    // local (0,0) inside the slot. The producer ships parent-relative matrices.
    function hand(): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
      const { stage, renderer } = harness();
      const state = createMirrorState();
      fullLocal(state, [node("hand", null, 960, 900), node("h", "hand", -200, 0), node("c", "h", 0, 0)], ["hand", "h", "c"]);
      renderer.reconcile(state);
      return { stage, renderer, state };
    }

    it("arms an Expo/Out transition on the SLOT, and the nested card rides it rigidly", () => {
      const { stage, renderer, state } = hand();
      expect([tx(el(stage, "h")), ty(el(stage, "h"))]).toEqual([-200, 0]);
      const cardBefore = el(stage, "c").style.transform;

      clock = 0;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
      renderer.reconcile(state);

      // Start-LESS, so the arm is synchronous (nothing to prime, no deferred frame) — the slot goes straight to the
      // endpoint under an Expo/Out transition of the producer's computed settle duration.
      expect(el(stage, "h").style.transition).toBe(`transform 884ms ${EXPO_OUT}`);
      expect([tx(el(stage, "h")), ty(el(stage, "h"))]).toEqual([-40, 0]);
      // The card is DOM-nested inside the slot, so its own element transform is relative and never rewritten: it
      // follows the slot's CSS transition for free. This is why the slot is the right suppression root.
      expect(el(stage, "c").style.transform).toBe(cardBefore);
      expect(el(stage, "c").style.transition).toBe("");
    });

    it("RE-TARGETS mid-flight without teleporting: new endpoint, new duration, no prime", () => {
      const { stage, renderer, state } = hand();
      clock = 0;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
      renderer.reconcile(state);
      const cardBefore = el(stage, "c").style.transform;

      // 300 ms in, another card is drawn and the hand re-lays-out. The producer recomputes the endpoint AND the
      // duration from the slot's LIVE pose, so the second hint describes the REMAINING travel — a shorter window.
      clock = 300;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, 60, 0], 620)]);
      renderer.reconcile(state);

      // The re-arm swaps the endpoint and the duration in place. Crucially the element is NOT primed anywhere first
      // (no `transition: none` step, no jump back to a start), so the browser re-eases from wherever the running
      // transition had reached — which is exactly what the game's own loop does on a re-target.
      expect(el(stage, "h").style.transition).toBe(`transform 620ms ${EXPO_OUT}`);
      expect([tx(el(stage, "h")), ty(el(stage, "h"))]).toEqual([60, 0]);
      expect(el(stage, "c").style.transform).toBe(cardBefore); // the card still rides rigidly across the re-arm
    });

    it("ignores streamed transforms while the slot is pinned, and accepts them again after it settles", () => {
      const { stage, renderer, state } = hand();
      clock = 0;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
      renderer.reconcile(state);

      // A streamed frame that slips through mid-flight (the producer resumed a tick early, or the window was
      // cancelled) must NOT fight the transition: the pinned channel wins while the client owns it.
      clock = 200;
      volatile(state, [node("h", "hand", -150, 0)]);
      renderer.reconcile(state);
      expect(tx(el(stage, "h"))).toBe(-40);

      // Once the channel expires, the node is streamed again — which is what makes the producer's settle re-emit
      // (and its cancel-on-abandon path) able to re-sync a slot the game moved somewhere else.
      flushRaf(900);
      clock = 950;
      volatile(state, [node("h", "hand", -150, 0)]);
      renderer.reconcile(state);
      expect(tx(el(stage, "h"))).toBe(-150);
    });
  });

  // PIN CATCH-UP. The producer has exactly one way to say "forget the hint I sent you":
  // it collapses the node's suppression window and resumes streaming. That un-pins the PRODUCER — but there is no
  // wire-level tween abort, so the CLIENT stays pinned to the dead endpoint until its own deadline and `tickTweens`
  // then drops that endpoint WITHOUT re-applying the streamed transform `pinTween` had been ignoring. Every delta
  // that lands inside a pin was therefore lost permanently, which is both reported hand defects:
  //   * a card re-focused mid-unfocus stayed unfocused (its focus pose is written INSTANTLY by the game, so the
  //     producer's batch has ~no travel left, falls under its duration floor, publishes no hint and only streams);
  //   * a settled card sat at the client's endpoint rather than the game's pose, and "jumped" whenever something
  //     unrelated finally moved it (the mis-placed 4th card of a start-of-turn draw).
  // The fix: while a transform pin overrides a streamed value, remember it; at settle, apply it instead of dropping
  // it. Only a value that genuinely CHANGED since the arm counts — a node the producer is merely SUPPRESSING keeps
  // shipping nothing, so its retained pre-tween transform must never be mistaken for a fresh pose and replayed
  // (that would teleport the card back to where the approach started).
  describe("pin catch-up: a streamed pose ignored while pinned is applied at settle (WS-4 regressions)", () => {
    const EXPO_OUT = "cubic-bezier(0.19, 1, 0.22, 1)";

    function handHint(targetId: string, endLocal: number[], durationMs: number): Record<string, unknown> {
      return { targetId, property: "position", durationMs, trans: "Expo", ease: "Out", endTransform: endLocal };
    }

    function hand(): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
      const { stage, renderer } = harness();
      const state = createMirrorState();
      fullLocal(state, [node("hand", null, 960, 900), node("h", "hand", -200, 0), node("c", "h", 0, 0)], ["hand", "h", "c"]);
      renderer.reconcile(state);
      return { stage, renderer, state };
    }

    // A non-full delta that REPARENTS. The producer ships an order array whenever the tree's shape changed, which is
    // what makes the walk structural without it being a keyframe — the discard of a played card looks exactly like
    // this (the card leaves the hand's holder for the pile's).
    function structural(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
      applySceneDelta(
        state,
        parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes, orderedIds: order })!
      );
    }

    async function parityHand(): Promise<{ stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState }> {
      window.history.replaceState(null, "", "/?handParity=1");
      vi.resetModules();
      const { createMirrorRenderer: createParityRenderer } = await import("@/mirror/mirrorRenderer");
      const stage = document.createElement("div");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      svg.appendChild(defs);
      document.body.append(stage, svg);
      const renderer = createParityRenderer(stage, defs);
      const state = createMirrorState();
      fullLocal(state, [node("hand", null, 960, 900), node("h", "hand", -200, 0), node("c", "h", 0, 0)], ["hand", "h", "c"]);
      renderer.reconcile(state);
      return { stage, renderer, state };
    }

    const parityGauge = (): { postSettles: number; snapped: number; maxSnapPx: number } =>
      (window as unknown as { __mirrorHandParity: { postSettles: number; snapped: number; maxSnapPx: number } })
        .__mirrorHandParity;

    it("DEFECT 2: the settle lands on the GAME's pose, not the stale endpoint", () => {
      const { stage, renderer, state } = hand();
      clock = 0;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
      renderer.reconcile(state);
      expect(tx(el(stage, "h"))).toBe(-40);

      // The producer decided this holder's remaining travel was under its duration floor, cancelled the window and
      // resumed streaming — so -150 is the authoritative pose and NO further hint is coming. The pin still (rightly)
      // refuses to fight the running transition with it.
      clock = 200;
      volatile(state, [node("h", "hand", -150, 0)]);
      renderer.reconcile(state);
      expect(tx(el(stage, "h"))).toBe(-40);

      // ...but the settle must not DROP it. Before the fix the slot stayed at -40 for good: nothing else touches the
      // node, so the card only "jumped" to its real place when some later, unrelated delta moved it.
      flushRaf(900);
      expect(tx(el(stage, "h"))).toBe(-150);
      expect(el(stage, "h").style.transition).toBe(""); // applied INSTANTLY — a catch-up must never ease
    });

    it("DEFECT 1: a refocus streamed mid-unfocus wins the settle (the card ends FOCUSED)", () => {
      const { stage, renderer, state } = hand();
      // The card is focused: the game holds it lifted (y −60). The player moves off it → a 400ms approach back down
      // into the re-spread fan (x −200 → −140, y −60 → 0).
      clock = 0;
      volatile(state, [node("h", "hand", -200, -60)]);
      renderer.reconcile(state);
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, -140, 0], 400)]);
      renderer.reconcile(state);
      expect([tx(el(stage, "h")), ty(el(stage, "h"))]).toEqual([-140, 0]);

      // 120ms in the player re-focuses. The game's focus branch writes the lift INSTANTLY and only then sets the
      // position target, so the batch has ~no travel left, drops under the producer's floor, publishes no hint and
      // merely streams the live post-snap pose: x partway through the unfocus travel, y snapped back up.
      clock = 120;
      volatile(state, [node("h", "hand", -188, -60)]);
      renderer.reconcile(state);

      flushRaf(410);
      expect([tx(el(stage, "h")), ty(el(stage, "h"))]).toEqual([-188, -60]); // FOCUSED, as the game has it
    });

    it("does NOT replay a merely-SUPPRESSED node's retained transform (no teleport back to the start)", () => {
      const { stage, renderer, state } = hand();
      clock = 0;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
      renderer.reconcile(state);

      // What a suppressed holder actually looks like on the wire: volatile upserts that carry NO transform at all
      // (the producer withholds it for the window's lifetime). The node is re-walked, but its authoritative pose is
      // unchanged — so there is nothing to catch up on, and the settle must keep the endpoint.
      clock = 300;
      volatile(state, [{ id: "h", parentId: "hand", visible: true }]);
      renderer.reconcile(state);
      clock = 600;
      volatile(state, [{ id: "h", parentId: "hand", visible: true }]);
      renderer.reconcile(state);

      flushRaf(900);
      expect(tx(el(stage, "h"))).toBe(-40); // the approach's endpoint, NOT the pre-tween -200
    });

    it("a mid-flight RE-ARM clears the pending catch-up (the new endpoint already accounts for it)", () => {
      const { stage, renderer, state } = hand();
      clock = 0;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
      renderer.reconcile(state);

      clock = 200;
      volatile(state, [node("h", "hand", -150, 0)]);
      renderer.reconcile(state);

      // Another card is drawn: the producer recomputes the endpoint from the holder's LIVE pose, so the new hint
      // already describes the travel that remains from -150. Replaying the stashed -150 at settle would undo it.
      clock = 210;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, 60, 0], 620)]);
      renderer.reconcile(state);

      flushRaf(900);
      expect(tx(el(stage, "h"))).toBe(60);
    });

    // The PARITY GAUGE (`?handParity=1`, `--hand-parity` on bench-mirror-replay). Turns "the cards jump at the end
    // of a transition" into a number: at every transform settle it records where the client's replayed tween ended
    // against where the game says the card is, so a recording can be A/B'd before and after a fix.
    it("PARITY GAUGE: records both a drifted and an agreeing settle", async () => {
      const { stage, renderer, state } = await parityHand();
        clock = 0;
        hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
        renderer.reconcile(state);
        clock = 200;
        volatile(state, [node("h", "hand", -150, -12)]);
        renderer.reconcile(state);
        flushRaf(900);

        const gauge = (window as unknown as { __mirrorHandParity: {
          settles: number; drifted: number; maxDriftPx: number;
          entries: { id: string; dx: number; dy: number; distPx: number }[];
        } }).__mirrorHandParity;
        expect(gauge.settles).toBe(1);
        expect(gauge.drifted).toBe(1);
        const [entry] = gauge.entries;
        expect(entry.id).toBe("h");
        expect([entry.dx, entry.dy]).toEqual([-110, -12]); // endpoint (−40,0) → game (−150,−12)
        expect(gauge.maxDriftPx).toBeCloseTo(Math.hypot(110, 12), 6);

        // A second, honest settle accumulates without changing the drift total.
        clock = 1000;
        hintsOnly(state, [handHint("h", [1, 0, 0, 1, 20, 0], 200)]);
        renderer.reconcile(state);
        flushRaf(1210);
        expect(gauge.settles).toBe(2);
        expect(gauge.drifted).toBe(1);
        expect(gauge.maxDriftPx).toBeCloseTo(Math.hypot(110, 12), 6);
        expect(tx(el(stage, "h"))).toBe(20);
    });

    // The other half of the gauge: a settle the producer NEVER contradicted (it suppressed the node for the whole
    // window) scores zero drift above — so a wrong-but-uncontradicted endpoint is invisible to it. The
    // contradiction arrives as the first streamed pose AFTER the window, which is the jump the report is hunting.
    it("PARITY GAUGE: counts a POST-SETTLE snap — the first streamed pose that disagrees with the settle", async () => {
      const { stage, renderer, state } = await parityHand();
        clock = 0;
        hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
        renderer.reconcile(state);
        // Suppressed for the whole window: no transform on the wire at all, so the settle itself sees no drift.
        clock = 400;
        volatile(state, [{ id: "h", parentId: "hand", visible: true }]);
        renderer.reconcile(state);
        flushRaf(900);

        const gauge = (window as unknown as { __mirrorHandParity: {
          settles: number; drifted: number; postSettles: number; snapped: number; maxSnapPx: number;
          entries: { id: string; kind: string; dx: number; dy: number; distPx: number }[];
        } }).__mirrorHandParity;
        expect([gauge.settles, gauge.drifted]).toEqual([1, 0]); // nothing contradicted the endpoint...
        expect([gauge.postSettles, gauge.snapped]).toEqual([0, 0]); // ...and the watch hasn't seen a pose yet

        // The producer resumes streaming and the game's real pose lands: the card visibly jumps 110px.
        clock = 950;
        volatile(state, [node("h", "hand", -150, 0)]);
        renderer.reconcile(state);
        expect([gauge.postSettles, gauge.snapped]).toEqual([1, 1]);
        expect(gauge.maxSnapPx).toBeCloseTo(110, 6);
        const snap = gauge.entries.find((e) => e.kind === "post-settle")!;
        expect([snap.id, snap.dx, snap.dy]).toEqual(["h", -110, 0]);
        expect(tx(el(stage, "h"))).toBe(-150);

        // Only the FIRST pose after a settle is watched — a later move is ordinary gameplay, not a snap.
        clock = 1000;
        volatile(state, [node("h", "hand", -300, 0)]);
        renderer.reconcile(state);
        expect([gauge.postSettles, gauge.snapped]).toEqual([1, 1]);
    });

    it("PARITY GAUGE: a streamed pose that AGREES with the settle counts as watched, never as a snap", async () => {
      const { renderer, state } = await parityHand();
        clock = 0;
        hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
        renderer.reconcile(state);
        flushRaf(900);
        clock = 950;
        volatile(state, [node("h", "hand", -40, 0)]); // the game landed exactly where the hint said
        renderer.reconcile(state);

        const gauge = (window as unknown as { __mirrorHandParity: {
          postSettles: number; snapped: number; maxSnapPx: number; entries: { kind: string }[];
        } }).__mirrorHandParity;
        expect([gauge.postSettles, gauge.snapped, gauge.maxSnapPx]).toEqual([1, 0, 0]);
        expect(gauge.entries.some((e) => e.kind === "post-settle")).toBe(false);
    });

    // Aug-20 — THE GAUGE'S OWN PREDICATES. On a live run the post-settle counters read +8 snaps over a focus sweep
    // and 28 (max 489px) over an end-turn discard, while sampling the elements directly showed 0.0px of visible
    // discontinuity. Every one of those was the gauge scoring a move it had no business attributing to the settle.
    // The three tests below are the three mechanisms, and they only ever tighten what COUNTS — the replay behaviour
    // (where the elements actually end up) is untouched, which each test also asserts.

    it("PARITY GAUGE: the watch EXPIRES — a pose arriving after the window is ordinary gameplay", async () => {
      const { stage, renderer, state } = await parityHand();
        clock = 0;
        hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
        renderer.reconcile(state);
        // Silent for the whole window, exactly as in the snap test above — so the watch is still armed at the settle.
        clock = 400;
        volatile(state, [{ id: "h", parentId: "hand", visible: true }]);
        renderer.reconcile(state);
        flushRaf(900);
        expect([parityGauge().postSettles, parityGauge().snapped]).toEqual([0, 0]);

        // ...and the next pose does not arrive until 600ms after the settle: the 500ms window has closed, so this is
        // the game moving a card for its own reasons, not a snap out of the settle. The expiry used to be enforced
        // only while the producer stayed SILENT, so the first streamed pose counted at ANY later time.
        clock = 1500;
        volatile(state, [node("h", "hand", -150, 0)]);
        renderer.reconcile(state);
        expect([parityGauge().postSettles, parityGauge().snapped, parityGauge().maxSnapPx]).toEqual([0, 0, 0]);

        // The watch is CLOSED, not merely skipped: a second late pose finds nothing armed either.
        clock = 1600;
        volatile(state, [node("h", "hand", -300, 0)]);
        renderer.reconcile(state);
        expect([parityGauge().postSettles, parityGauge().snapped]).toEqual([0, 0]);
        expect(tx(el(stage, "h"))).toBe(-300); // the replay itself is unchanged — the gauge is the only thing that moved
    });

    it("PARITY GAUGE: a RE-ARM inside the window cancels the watch (a live focus hint, not a snap)", async () => {
      const { stage, renderer, state } = await parityHand();
        clock = 0;
        hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
        renderer.reconcile(state);
        flushRaf(900);

        // The player moves onto the card 50ms after it settled: a fresh position hint, no upsert of its own. The
        // watch is now scoring against a pose NOBODY claims any more — every following stream reports the new
        // endpoint's travel, so before the fix a re-arm inside the window was a guaranteed false snap.
        clock = 950;
        hintsOnly(state, [handHint("h", [1, 0, 0, 1, 20, -60], 300)]);
        renderer.reconcile(state);
        expect([parityGauge().postSettles, parityGauge().snapped]).toEqual([0, 0]);

        // Including the mid-flight pose the new tween's pin overrides — the case that actually fired in the wild.
        clock = 1000;
        volatile(state, [node("h", "hand", 4, -30)]);
        renderer.reconcile(state);
        expect([parityGauge().postSettles, parityGauge().snapped, parityGauge().maxSnapPx]).toEqual([0, 0, 0]);

        flushRaf(1300);
        expect([tx(el(stage, "h")), ty(el(stage, "h"))]).toEqual([4, -30]); // pin catch-up still applies, unchanged
    });

    it("PARITY GAUGE: a REPARENT inside the window cancels the watch (transforms are parent-relative)", async () => {
      const { stage, renderer, state } = await parityHand();
      structural(state, [node("pile", null, 1700, 980)], ["hand", "pile", "h", "c"]);
      renderer.reconcile(state);
        clock = 0;
        hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
        renderer.reconcile(state);
        flushRaf(900);

        // The card is played: it moves from the hand's holder to the pile's, ~750px away on screen. Its element
        // survives (a reparent moves it, it is not rebuilt), so the record — and the watch on it — comes along, but
        // the pose it now carries is expressed in the PILE's space. Subtracting one from the other is not a screen
        // distance at all: here it would read a tidy 30px for a card that crossed the table, and on a live end-turn
        // discard it read 489px for a card that visibly moved 0.0px.
        clock = 950;
        structural(state, [node("h", "pile", -10, 0)], ["hand", "pile", "h", "c"]);
        renderer.reconcile(state);

        expect([parityGauge().postSettles, parityGauge().snapped, parityGauge().maxSnapPx]).toEqual([0, 0, 0]);
        expect(el(stage, "h").parentElement).toBe(el(stage, "pile"));
        expect(tx(el(stage, "h"))).toBe(-10); // the card really did move — the gauge simply cannot score across it
    });

    it("PARITY GAUGE off: the post-settle watch never arms (the gauge is the only thing that pays)", () => {
      const { renderer, state } = hand();
      clock = 0;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
      renderer.reconcile(state);
      flushRaf(900);
      clock = 950;
      volatile(state, [node("h", "hand", -150, 0)]);
      renderer.reconcile(state);
      const gauge = (window as unknown as { __mirrorHandParity: { postSettles: number; snapped: number } })
        .__mirrorHandParity;
      expect([gauge.postSettles, gauge.snapped]).toEqual([0, 0]);
    });

    it("still eases: a catch-up equal to the endpoint writes nothing and keeps the Expo/Out transition history", () => {
      const { stage, renderer, state } = hand();
      clock = 0;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, -40, 0], 884)]);
      renderer.reconcile(state);
      expect(el(stage, "h").style.transition).toBe(`transform 884ms ${EXPO_OUT}`);

      // The producer's ordinary settle re-emit: the game landed exactly where the hint said it would.
      clock = 800;
      volatile(state, [node("h", "hand", -40, 0)]);
      renderer.reconcile(state);

      flushRaf(900);
      expect(tx(el(stage, "h"))).toBe(-40);
      expect(el(stage, "h").style.transition).toBe("");
    });
  });

  // WS-C — THE ENDPOINT'S OWN PLACE ON THE WIDE-SCREEN FIELD.
  //
  // On a wider-than-16:9 stage the world sits on one horizontal squeeze field: a node that claims its own place on
  // it shifts by a function of its OWN rendered X. The walk derives that shift once per node per walk, from the
  // node's CURRENT pose — and while a hand approach runs, the producer suppresses that slot's transforms, so the
  // stored shift is frozen at the PRE-tween pose for the hint's whole window. Composing a tween endpoint with it
  // therefore landed the card at `endX + startX·(F−1)` instead of `endX·F`: up to ~600 design px of error at the
  // 2520 stage, followed by a SNAP when the post-window settle re-emit let the walk re-derive the shift.
  describe("hand-layout approach hints under the wide-screen spread", () => {
    const F = 2520 / 1920; // 1.3125 — the widest stretch; the squeeze-field factor
    const EXPO_OUT = "cubic-bezier(0.19, 1, 0.22, 1)";

    function handHint(targetId: string, endLocal: number[], durationMs: number): Record<string, unknown> {
      return { targetId, property: "position", durationMs, trans: "Expo", ease: "Out", endTransform: endLocal };
    }

    // A BOXLESS positioner: a 0×0 rect and no anchors, which is what makes it take the spread's PASS-THROUGH branch
    // (own origin field claim, budget passed to the children) — the shape of the real holder chain, whose 0×0
    // NHandCardHolders position painting cards that never carry an anchor frame of their own.
    function boxless(id: string, parentId: string | null, x: number, y: number): Record<string, unknown> {
      return {
        id,
        parentId,
        name: id,
        nodeType: "Node2D",
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } },
        visible: true
      };
    }

    // The hand: container at global (960,900), the slot `h` at local (−200,0) → global 760, and the card nested at
    // the slot's origin. The producer ships parent-relative matrices — so a hint's endTransform is the
    // slot's END LOCAL transform and the renderer lifts it by the container's global.
    function hand(stretch: number): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
      const { stage, renderer } = harness();
      renderer.setStretch(stretch);
      const state = createMirrorState();
      fullLocal(state, [boxless("hand", null, 960, 900), boxless("h", "hand", -200, 0), boxless("c", "h", 0, 0)], ["hand", "h", "c"]);
      renderer.reconcile(state);
      return { stage, renderer, state };
    }

    // The element's ON-STAGE x: its own CSS matrix composed with every ancestor's, up to (excluding) the stage —
    // the DOM is nested, so an element's own transform is only its parent-relative part.
    function stageX(elx: HTMLElement, stage: HTMLElement): number {
      let acc: Affine = [...IDENTITY_AFFINE] as Affine;
      let cur: HTMLElement | null = elx;
      while (cur && cur !== stage) {
        const m = /matrix\(([^)]*)\)/.exec(cur.style.transform);
        const own = (m ? m[1].split(",").map(Number) : [...IDENTITY_AFFINE]) as Affine;
        acc = affineMul(own, acc);
        cur = cur.parentElement;
      }
      return acc[4];
    }

    it("places a start-less endpoint at ITS OWN field X (endX·F), not at endX + startX·(F−1)", () => {
      const { stage, renderer, state } = hand(F);
      expect(stageX(el(stage, "h"), stage), "at rest, the slot's own field claim").toBeCloseTo(760 * F, 6);

      clock = 0;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, 540, 0], 884)]); // local 540 → global 1500
      renderer.reconcile(state);

      expect(el(stage, "h").style.transition).toBe(`transform 884ms ${EXPO_OUT}`);
      expect(stageX(el(stage, "h"), stage)).toBeCloseTo(1500 * F, 6);
      // The pre-fix composition (the frozen 760-derived shift on a 1500 endpoint) sits 250px to the left — a quarter
      // of the way back across the stage, which is what the mis-landed card looked like.
      expect(stageX(el(stage, "h"), stage)).not.toBeCloseTo(1500 + 760 * (F - 1), 3);
    });

    it("PRIMES at the declared START's own field X, then arms at the endpoint's", () => {
      const { stage, renderer, state } = hand(F);
      clock = 0;
      // A hint with a declared start: the prime lands inside the reconcile, the arm rides the next frame. Both go
      // through the same seam, so both must be evaluated where they actually are — the start is global 700, which
      // is NOT the slot's resting 760.
      hintsOnly(state, [{ ...handHint("h", [1, 0, 0, 1, 540, 0], 884), startTransform: [1, 0, 0, 1, -260, 0] }]);
      renderer.reconcile(state);
      expect(el(stage, "h").style.transition).toBe("none");
      expect(stageX(el(stage, "h"), stage)).toBeCloseTo(700 * F, 6);

      flushRaf(clock);
      expect(stageX(el(stage, "h"), stage)).toBeCloseTo(1500 * F, 6);
      expect(el(stage, "h").style.transition).toBe(`transform 884ms ${EXPO_OUT}`);
    });

    it("does NOT snap at the settle: the producer's re-emit re-derives the SAME shift the endpoint used", () => {
      const { stage, renderer, state } = hand(F);
      clock = 0;
      hintsOnly(state, [handHint("h", [1, 0, 0, 1, 540, 0], 884)]);
      renderer.reconcile(state);
      const armed = el(stage, "h").style.transform;

      // The producer's ordinary settle re-emit: the game landed exactly where the hint said. The walk re-derives the
      // slot's field claim from THAT pose — and because the endpoint was evaluated on the same field, the two agree
      // byte-for-byte, so the pin catch-up has nothing to apply. Before the fix they differed by 250px and the card
      // visibly jumped the instant the transition ended.
      clock = 800;
      volatile(state, [boxless("h", "hand", 540, 0)]);
      renderer.reconcile(state);
      expect(el(stage, "h").style.transform, "the pin still wins mid-flight").toBe(armed);

      flushRaf(900);
      expect(el(stage, "h").style.transform).toBe(armed);
      expect(stageX(el(stage, "h"), stage)).toBeCloseTo(1500 * F, 6);
    });

    it("is BYTE-IDENTICAL at 16:9 — the whole composition is skipped when every dx is 0", () => {
      function run(): { armed: string; settled: string } {
        const { stage, renderer, state } = hand(1);
        clock = 0;
        hintsOnly(state, [handHint("h", [1, 0, 0, 1, 540, 0], 884)]);
        renderer.reconcile(state);
        const armed = el(stage, "h").style.transform;
        clock = 800;
        volatile(state, [boxless("h", "hand", 540, 0)]);
        renderer.reconcile(state);
        flushRaf(900);
        return { armed, settled: el(stage, "h").style.transform };
      }
      const current = run();
      expect(current.armed).toBe("matrix(1, 0, 0, 1, 540, 0)"); // the raw local endpoint, no shift anywhere
      expect(current.settled).toBe(current.armed);
    });

    it("leaves a fieldMode-0 node (a right-anchored HUD) on its WALKED shift", () => {
      // The anchor algebra reproduces Godot's own resize: a 1/1-anchored button hugs the right edge by the frame's
      // whole widening (Δ = 600), which has nothing to do with the button's own X — so its endpoint keeps exactly
      // that shift. Evaluating the field at the endpoint here would drag the HUD off the edge it is pinned to.
      const { stage, renderer } = harness();
      renderer.setStretch(F);
      const state = createMirrorState();
      const frame = {
        id: "frame",
        parentId: null,
        name: "frame",
        nodeType: "Control",
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } },
        anchorLeft: 0,
        anchorRight: 1,
        visible: true
      };
      const hud = {
        id: "endTurn",
        parentId: "frame",
        name: "endTurn",
        nodeType: "Control",
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 1604, y: 980 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 220, y: 80 } },
        anchorLeft: 1,
        anchorRight: 1,
        visible: true
      };
      full(state, [frame, hud], ["frame", "endTurn"]);
      renderer.reconcile(state);
      const DELTA = (F - 1) * 1920; // 600
      expect(stageX(el(stage, "endTurn"), stage)).toBeCloseTo(1604 + DELTA, 4);

      clock = 0;
      hintsOnly(state, [transformHint("endTurn", [1, 0, 0, 1, 1000, 980], 200)]);
      renderer.reconcile(state);
      expect(stageX(el(stage, "endTurn"), stage)).toBeCloseTo(1000 + DELTA, 4);
    });

    it("CENTRE mode: a positional claimer's endpoint is evaluated at the ENDPOINT's centre, scale included", () => {
      // World content is placed on the field at its own box CENTRE, so the endpoint's centre is what counts — and a
      // hint that also SCALES the node moves that centre (`g6`'s own basis, not the resting one).
      const { stage, renderer } = harness();
      renderer.setStretch(F);
      const state = createMirrorState();
      full(state, [node("s", null, 700, 400)], ["s"]); // a 90×130 ColorRect: paints its own box, no anchors
      renderer.reconcile(state);
      expect(stageX(el(stage, "s"), stage), "resting: the field at its own centre (700+45)").toBeCloseTo(
        700 + (700 + 45) * (F - 1),
        6
      );

      clock = 0;
      hintsOnly(state, [transformHint("s", [1, 0, 0, 1, 1500, 400], 200)]);
      renderer.reconcile(state);
      expect(stageX(el(stage, "s"), stage)).toBeCloseTo(1500 + (1500 + 45) * (F - 1), 6);

      // Now a scaling endpoint: the same origin, double size → the centre (and therefore the claim) moves right.
      clock = 300;
      hintsOnly(state, [transformHint("s", [2, 0, 0, 2, 1500, 400], 200)]);
      renderer.reconcile(state);
      expect(stageX(el(stage, "s"), stage)).toBeCloseTo(1500 + (1500 + 2 * 45) * (F - 1), 6);
    });

  });

  // WHAT A FINISHED PIN LEAVES BEHIND — the hit surface under it.
  //
  // While a node is transform-tween pinned the walk skips its whole subtree (nodeWalker's `skipForPin`): the
  // descendants ride the pinned ELEMENT through the nested DOM, so re-basing them against the streamed transform
  // mid-animation would decouple them. The cost is that they keep the parent global they last cached — and when the
  // pin ENDS, nothing offers them a context again. If the node's own stream then goes quiet the walk skips it too
  // (same node object, unchanged context, not dirty), so the descendants keep that pose indefinitely.
  //
  // That is not cosmetic. `interactiveRects()` composes every hit box out of its record's cached parent global, so
  // a stale one is the box the mirror hit-tests against. Measured live on the touch fixture (2026-09-19): 9 of 30
  // hover cycles left a hand card's hit box at a pose the game's own poses, the DOM and the rendered frame all
  // disagreed with — up to 160 design px above the card — and several never recovered. Every pointer resolved
  // through such a box missed the card, which is what made three separate live checks intermittently red.
  //
  // `markGeometryDirty()` cannot cover this: it invalidates the caches that key on the geometry epoch, while the
  // walk's skip gate is independent of it. The pin's end has to ask for the node itself to be walked again.
  it("re-bases the hit boxes under a pin once the tween ends, even if the target's stream has gone quiet", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    // A positioner with a mouse-visible child: the hand holder / `Hitbox` shape, which is where this was measured.
    full(
      state,
      [
        { ...node("holder", null, 0, 100), mouseFilter: 2 },
        { ...node("hitbox", "holder", 0, 0), mouseFilter: 0 }
      ],
      ["holder", "hitbox"]
    );
    renderer.reconcile(state);
    const hitY = () => renderer.interactiveRects().find((r) => r.id === "hitbox")?.transform[5];
    expect(hitY()).toBe(100);

    // A tween takes the holder to y=500 — the element is pinned to the endpoint for 200ms.
    clock = 10;
    hintsOnly(state, [transformHint("holder", [1, 0, 0, 1, 0, 500], 200)]);
    renderer.reconcile(state);

    // Mid-flight the producer streams the holder's own pose to the same place (the game's hand does exactly this
    // as a card returns to rest). The pin swallows it and the subtree is skipped, so the hitbox is now stale.
    clock = 100;
    volatile(state, [node("holder", null, 0, 500)]);
    renderer.reconcile(state);

    // The tween runs out…
    flushRaf(260);

    // …and the next delta touches something else entirely, which is exactly the case that used to strand it: the
    // holder is unchanged, so the walk has no reason of its own to visit it.
    volatile(state, [node("bystander", null, 700, 700)]);
    renderer.reconcile(state);

    expect(hitY()).toBe(500);
  });
});

// R10-PERF5 WS-1 — dormancy interaction, from this file's angle. `applyTweenHints` runs AFTER the walk, so a hint
// can name a node the walk just declined to build. Every arm/prime except ONE bails on `!record.el`:
// `armTweenSelfOpacity` has no such guard — it writes the DURABLE `tweenSelfOpacity*` pin and only touches the DOM
// `if (record.selfLayer)`. A dormant record can never own a selfLayer (the layer is created inside the paint block
// the dormancy return skips), so the hint is inert until the reveal picks the pin up. Pinned here because a future
// change that gives a dormant record a selfLayer would break silently.
describe("tween hints against a DORMANT (never-built) target", () => {
  it("arms nothing, creates no DOM, and survives ticking — then lands the self pin on reveal", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // `dlg` is a clip container (own paint → a `.mirror-clip-self` layer once built) hidden at the keyframe.
    full(
      state,
      [node("root", null, 0, 0), { ...clipNode("dlg", "root", 100, 100, 1), visible: false }, node("kid", "dlg", 110, 110)],
      ["root", "dlg", "kid"]
    );
    renderer.reconcile(state);
    expect(el(stage, "dlg")).toBeNull();
    const selfLayersBefore = stage.querySelectorAll(".mirror-clip-self").length; // `root` owns one (fill + kids)

    // All three channels at once against the dormant root.
    hintsOnly(state, [
      transformHint("dlg", [1, 0, 0, 1, 300, 300], 60_000),
      opacityHint("dlg", 0.5, 60_000),
      selfOpacityHint("dlg", 0.25, 60_000)
    ]);
    expect(() => renderer.reconcile(state)).not.toThrow();
    expect(stage.querySelectorAll(".mirror-node").length).toBe(1); // only `root`
    expect(stage.querySelectorAll(".mirror-clip-self").length).toBe(selfLayersBefore); // none added
    // A further reconcile ticks the tween set (which now holds the dormant record) — must stay inert.
    expect(() => renderer.reconcile(state)).not.toThrow();

    volatile(state, [clipNode("dlg", "root", 100, 100, 1)]); // reveal
    renderer.reconcile(state);
    const self = el(stage, "dlg").querySelector<HTMLElement>(".mirror-clip-self");
    expect(self).not.toBeNull();
    expect(self!.style.opacity).toBe("0.25"); // the durable self_modulate pin outlived the dormancy
  });

});

// S2/D2 — TWEEN HINTS WHOSE ENDPOINT SPACE IS GONE.
//
// The DOM twin of the canvas builder's two refusals (canvasStage.spec: "DROPS a hint whose target is an orphan"
// and "DROPS the transform channel of a hint whose target was RE-PARENTED before the hint was drained"). In
// An endpoint is parent-relative and `liftEndpointToGlobal` composes it against the target's parent global; when
// that parent is missing or is no longer the parent the endpoint was written against, the lift
// produces a number in a space that does not exist and the tween plays the node out at the design corner.
//
// Every case here uses START-LESS hints, which arm SYNCHRONOUSLY inside `reconcile` (a primed batch defers its arms
// a frame — see the WS-P1 case above), so the assertions are on the element right after the call. And the DOM
// NESTS: an element's own `transform` is its matrix relative to its parent element, so these read the LOCAL number
// and the lift/re-base round trip is what turns the endpoint back into one.
describe("tween hints whose endpoint SPACE is gone (S2/D2)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mirrorWalkStats.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** root → holder → card, plus a play layer AT the root (whose global is the identity — see below). */
  function handScene(state: MirrorState): void {
    fullLocal(
      state,
      [node("root", null, 0, 0), node("holder", "root", 500, 900), node("card", "holder", 0, 0), node("play", "root", 0, 0)],
      ["root", "holder", "card", "play"]
    );
  }

  /**
   * The transition property list a channel wrote, as a sorted set. Parenthesised groups are stripped FIRST: the
   * easing is `cubic-bezier(0.33, 1, 0.68, 1)` and its commas are not channel separators.
   */
  function channels(elx: HTMLElement): string[] {
    return (elx.style.transition || "")
      .replace(/\([^)]*\)/g, "")
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter((name) => name.length > 0)
      .sort();
  }

  it("drops the TRANSFORM channel of a re-parented target and keeps the OPACITY one", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    handScene(state);
    renderer.reconcile(state);
    expect(ty(el(stage, "card"))).toBe(0); // nested under `holder`, which carries the (500,900)

    // TWO DELTAS, ONE RECONCILE — which is what `pendingHints` is an accumulator FOR, and the ordinary case
    // whenever the client renders slower than the producer streams. The hint is written while the card is still in
    // the hand, so its endpoint is relative to `holder`; the second delta PLAYS the card, re-parenting it under a
    // layer that sits AT the scene root. That layer's global IS the identity, so a "lifted" endpoint would be its
    // own raw parent-relative numbers and the card would be held at (0, -200) of the design corner.
    hintsOnly(state, [{ ...transformHint("card", [1, 0, 0, 1, 0, -200], 200), endOpacity: 0.5 }]);
    // A real re-parent moves the node in the order too, so the structure walk re-nests the element.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [node("card", "play", 960, 440)],
        orderedIds: ["root", "holder", "play", "card"]
      })!
    );
    renderer.reconcile(state);

    expect(mirrorWalkStats.hintTransformRebased).toBe(1);
    // The card paints the pose the producer is streaming for its NEW home, not the endpoint's dead space.
    expect(tx(el(stage, "card"))).toBe(960);
    expect(ty(el(stage, "card"))).toBe(440);
    // The opacity channel is parent-independent and is untouched by the refusal.
    expect(channels(el(stage, "card"))).toEqual(["opacity"]);
    expect(el(stage, "card").style.opacity).toBe("0.5");
  });

  it("does not re-arm a primed local endpoint after its target moves house before rAF", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    handScene(state);
    renderer.reconcile(state);
    let deferredArm: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      deferredArm = cb;
      return 1;
    });

    // A declared start makes this transform prime now and defer its old-holder endpoint arm to the next rAF.
    // This is the one-frame window the normal mid-channel reparent release cannot close on its own.
    hintsOnly(state, [
      {
        ...transformHint("card", [1, 0, 0, 1, 0, -200], 200),
        startTransform: [1, 0, 0, 1, 0, -100]
      }
    ]);
    renderer.reconcile(state);
    expect(ty(el(stage, "card"))).toBe(-100);

    // Before the deferred arm, the card is played under the root-level layer. pinTween drops the prime and the
    // structural walk paints the streamed pose in its new parent space.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [node("card", "play", 960, 440)],
        orderedIds: ["root", "holder", "play", "card"]
      })!
    );
    renderer.reconcile(state);
    expect(mirrorWalkStats.tweenReparentDropped).toBe(1);
    expect(el(stage, "card").parentElement).toBe(el(stage, "play"));
    expect([tx(el(stage, "card")), ty(el(stage, "card"))]).toEqual([960, 440]);

    // The delayed closure must observe that parent change too — re-arming its old holder-local endpoint would put
    // the card back in the wrong coordinate space for the rest of the hint window.
    expect(deferredArm).not.toBeNull();
    deferredArm!(16);
    expect(el(stage, "card").parentElement).toBe(el(stage, "play"));
    expect([tx(el(stage, "card")), ty(el(stage, "card"))]).toEqual([960, 440]);
    expect(channels(el(stage, "card"))).not.toContain("transform");
  });

  it("drops the TRANSFORM channel of an ORPHANED target — re-parented onto a holder not yet streamed", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    handScene(state);
    renderer.reconcile(state);

    // The producer really does emit this: a hand card is hinted on the very delta that re-parents it, a frame
    // before its new holder is streamed. The record SURVIVES (orphan hold keeps it warm and merely refuses to build
    // DOM for it — orphanHold.spec), so the hint reaches the drain and the guard is what answers it. There is no
    // parent global to compose, and `liftEndpointToGlobal`'s `?? IDENTITY_AFFINE` would silently say design origin.
    hintsOnly(state, [{ ...transformHint("card", [1, 0, 0, 1, 0, -200], 200), endOpacity: 0.5 }]);
    volatile(state, [node("card", "HolderNotStreamedYet", 0, 0)]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.hintTransformRebased).toBe(1);
  });

  it("arms normally for a dormant, never-built target whose parent IS in the map", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    fullLocal(state, [node("root", null, 0, 0), { ...node("dlg", "root", 100, 100), visible: false }], ["root", "dlg"]);
    renderer.reconcile(state);

    // No element, so nothing to observe on the DOM — which is exactly why the counter is the instrument here.
    hintsOnly(state, [transformHint("dlg", [1, 0, 0, 1, 300, 300], 200)]);
    expect(() => renderer.reconcile(state)).not.toThrow();
    expect(mirrorWalkStats.hintTransformRebased).toBe(0);
  });

  it("arms a hint that carries NO parent stamp — an older recording must not be refused wholesale", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    handScene(state);
    renderer.reconcile(state);

    // `parentIdAtArrival` is stamped by `applySceneDelta`; strip it to stand in for a stream that predates the
    // field. `!== undefined` is the leg that makes that a no-op rather than a refusal (undefined !== "holder").
    hintsOnly(state, [transformHint("card", [1, 0, 0, 1, 0, -200], 200)]);
    for (const hint of state.pendingHints) {
      delete (hint as { parentIdAtArrival?: string | null }).parentIdAtArrival;
    }
    renderer.reconcile(state);

    expect(mirrorWalkStats.hintTransformRebased).toBe(0);
    // Lifted through `holder`'s global (500,900) and re-based back onto the nested element: the local endpoint.
    expect(tx(el(stage, "card"))).toBe(0);
    expect(ty(el(stage, "card"))).toBe(-200);
    expect(channels(el(stage, "card"))).toEqual(["transform"]);
  });

  it("counts TRANSFORMS refused, not hints dropped — an opacity-only hint on a re-parented target is silent", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    handScene(state);
    renderer.reconcile(state);

    hintsOnly(state, [opacityHint("card", 0.25, 200)]);
    volatile(state, [node("card", "play", 960, 440)]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.hintTransformRebased).toBe(0);
    expect(el(stage, "card").style.opacity).toBe("0.25");
  });

  it("leaves an unmoved target alone — the ordinary case pays nothing and counts nothing", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    handScene(state);
    renderer.reconcile(state);

    hintsOnly(state, [transformHint("card", [1, 0, 0, 1, 0, -200], 200)]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.hintTransformRebased).toBe(0);
    expect(tx(el(stage, "card"))).toBe(0);
    expect(ty(el(stage, "card"))).toBe(-200);
  });
});
