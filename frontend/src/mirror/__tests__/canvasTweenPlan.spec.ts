import { describe, expect, it } from "vitest";

import {
  easedProgress,
  isSelfModulateProperty,
  planTweenHints,
  HIDE_LATCH_ALPHA_EPS,
  type TweenLoopHint,
  type TweenTargetFacts
} from "@/mirror/canvas/tweenPlan";
import { parseSceneDelta, type MirrorTweenHint } from "@/mirror/sceneTree";

// The pure half of `applyTweenHints`: which CHANNEL a wire hint drives, and what the endpoint means once the
// node's other alpha factor is folded in. These are the decisions mirrorTween.spec.ts asserts through the DOM
// ("pins a modulate fade on the TARGET element only", "pins a self_modulate fade on an INTERIOR target's
// self-paint layer", "folds a self_modulate fade into the ELEMENT opacity for a LEAF target") — restated as the
// data the canvas evaluator is handed.

function wireHint(over: Partial<MirrorTweenHint> = {}): MirrorTweenHint {
  return {
    targetId: "n",
    property: "position",
    to: null,
    durationMs: 200,
    trans: "Cubic",
    ease: "Out",
    endTransform: null,
    endOpacity: null,
    group: null,
    startTransform: null,
    startOpacity: null,
    ...over
  };
}

function facts(over: Partial<TweenTargetFacts> = {}): TweenTargetFacts {
  return {
    hasChildren: false,
    modAlpha: 1,
    selfAlpha: 1,
    endTransformGlobal: null,
    startTransformGlobal: null,
    ...over
  };
}

function plan(hint: MirrorTweenHint, f: TweenTargetFacts | null): TweenLoopHint[] {
  return planTweenHints([hint], () => f);
}

describe("canvas tween plan: channel selection", () => {
  it("splits one wire hint that carries BOTH endpoints into two independent channels", () => {
    const out = plan(
      wireHint({ endTransform: [1, 0, 0, 1, 5, 6], endOpacity: 0.3, property: "modulate:a", group: "g1" }),
      facts({ endTransformGlobal: [1, 0, 0, 1, 5, 6] })
    );
    expect(out.map((h) => h.channel)).toEqual(["transform", "opacity"]);
    expect(out.every((h) => h.group === "g1")).toBe(true);
  });

  it("routes `self_modulate` on an INTERIOR node to its own paint layer, at the RAW end alpha", () => {
    const [ch] = plan(
      wireHint({ property: "self_modulate:a", endOpacity: 0.2 }),
      facts({ hasChildren: true, modAlpha: 1, selfAlpha: 1 })
    );
    expect(ch.channel).toBe("selfOpacity");
    expect(ch.endOpacity).toBe(0.2); // the container keeps its modulate.a, so the children never fade
    expect(ch.restingAlpha).toBeNull(); // the hide-latch only ever watches the ELEMENT channel
  });

  it("FOLDS `self_modulate` into the element alpha for a LEAF (modAlpha × selfAlpha)", () => {
    const [ch] = plan(
      wireHint({ property: "self_modulate:a", endOpacity: 0.4 }),
      facts({ hasChildren: false, modAlpha: 0.5, selfAlpha: 1 })
    );
    expect(ch.channel).toBe("opacity");
    expect(ch.endOpacity).toBeCloseTo(0.2, 12); // 0.5 × 0.4 — a leaf has no cascade to protect
  });

  it("a `modulate` fade on a LEAF carries the leaf's OWN self factor through as a constant", () => {
    const [ch] = plan(
      wireHint({ property: "modulate:a", endOpacity: 0.5 }),
      facts({ hasChildren: false, modAlpha: 1, selfAlpha: 0.6 })
    );
    expect(ch.endOpacity).toBeCloseTo(0.3, 12); // 0.5 × 0.6
  });

  it("a `modulate` fade on an INTERIOR node is the RAW end alpha (the cascade does the rest)", () => {
    const [ch] = plan(
      wireHint({ property: "modulate:a", endOpacity: 0.2 }),
      facts({ hasChildren: true, modAlpha: 1, selfAlpha: 0.5 })
    );
    expect(ch.endOpacity).toBe(0.2);
  });

  it("handles a fade-IN from alpha 0 without a divide (endpoints are re-root multiplies, not ratios)", () => {
    const [ch] = plan(
      wireHint({ property: "modulate:a", endOpacity: 1, startOpacity: 0 }),
      facts({ modAlpha: 0, selfAlpha: 1 })
    );
    expect(ch.endOpacity).toBe(1);
    expect(ch.startOpacity).toBe(0);
    expect(Number.isFinite(ch.endOpacity!)).toBe(true);
  });

  it("names both self_modulate spellings and nothing else", () => {
    expect(isSelfModulateProperty("self_modulate:a")).toBe(true);
    expect(isSelfModulateProperty("self_modulate")).toBe(true);
    expect(isSelfModulateProperty("modulate:a")).toBe(false);
    expect(isSelfModulateProperty("position")).toBe(false);
  });
});

describe("canvas tween plan: the hide-latch signature", () => {
  it("captures the PRE-fade painted alpha for a fade-OUT, and nothing for a partial fade", () => {
    const [out] = plan(wireHint({ property: "modulate:a", endOpacity: 0 }), facts({ modAlpha: 0.75, selfAlpha: 1 }));
    expect(out.restingAlpha).toBeCloseTo(0.75, 12);
    const [partial] = plan(wireHint({ property: "modulate:a", endOpacity: 0.4 }), facts({ modAlpha: 1 }));
    expect(partial.restingAlpha).toBeNull();
  });

  it("treats anything at/below the alpha epsilon as a disappear", () => {
    const [out] = plan(
      wireHint({ property: "modulate:a", endOpacity: HIDE_LATCH_ALPHA_EPS }),
      facts({ modAlpha: 1 })
    );
    expect(out.restingAlpha).toBe(1);
  });

});

describe("canvas tween plan: what is dropped", () => {
  it("drops a hint whose target isn't mirrored (a one-shot), and one with no usable endpoint", () => {
    expect(plan(wireHint({ endTransform: [1, 0, 0, 1, 5, 6] }), null)).toEqual([]);
    expect(plan(wireHint(), facts())).toEqual([]);
  });

  it("drops a non-positive duration", () => {
    expect(
      plan(wireHint({ endOpacity: 0.5, property: "modulate:a", durationMs: 0 }), facts())
    ).toEqual([]);
    expect(
      plan(wireHint({ endOpacity: 0.5, property: "modulate:a", durationMs: -5 }), facts())
    ).toEqual([]);
  });

  it("drops the TRANSFORM half when the caller could not lift the endpoint (a boxless target)", () => {
    // `endTransformGlobal` null is the planner's expression of `nodeTransformForGlobal` returning null — a
    // rect-only / boxless node has nothing to animate, but a fade on the same hint still arms.
    const out = plan(
      wireHint({ endTransform: [1, 0, 0, 1, 5, 6], endOpacity: 0.3, property: "modulate:a" }),
      facts({ endTransformGlobal: null })
    );
    expect(out.map((h) => h.channel)).toEqual(["opacity"]);
  });

  it("consumes the real wire shape the parser produces", () => {
    // End to end from a scene delta, so a drift in `normalizeTweenHint` fails here rather than at runtime.
    const delta = parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      hints: [
        { targetId: "n", property: "position", durationMs: 250, trans: "Expo", ease: "Out", endTransform: [1, 0, 0, 1, 272, 80], startTransform: [1, 0, 0, 1, 300, 80] },
        { targetId: "n", property: "modulate:a", durationMs: 50, endOpacity: 1, startOpacity: 0 }
      ]
    })!;
    const out = planTweenHints(delta.hints, (h) =>
      facts({
        endTransformGlobal: h.endTransform,
        startTransformGlobal: h.startTransform
      })
    );
    expect(out.map((h) => h.channel)).toEqual(["transform", "opacity"]);
    expect(out[0].startTransform).toEqual([1, 0, 0, 1, 300, 80]);
    expect(out[0].trans).toBe("Expo");
    expect(out[0].ease).toBe("Out");
    expect(out[1].startOpacity).toBe(0);
    expect(out[1].durationMs).toBe(50);
  });
});

describe("canvas tween plan: eased progress", () => {
  it("samples Godot's own equations, and pins the endpoints exactly", () => {
    const [ch] = plan(
      wireHint({ property: "modulate:a", endOpacity: 1, trans: "Cubic", ease: "Out" }),
      facts()
    );
    expect(easedProgress(ch, 0)).toBe(0);
    expect(easedProgress(ch, 100)).toBeCloseTo(0.875, 12); // (t−1)³ + 1 at t = 0.5
    expect(easedProgress(ch, 200)).toBe(1);
    expect(easedProgress(ch, 5000)).toBe(1); // clamped, never extrapolated
  });

  it("defaults an absent trans to LINEAR, matching Godot's own Tween default", () => {
    const [ch] = plan(
      wireHint({ property: "modulate:a", endOpacity: 1, trans: null, ease: null }),
      facts()
    );
    expect(easedProgress(ch, 50)).toBeCloseTo(0.25, 12);
    expect(easedProgress(ch, 150)).toBeCloseTo(0.75, 12);
  });

  it("reaches exactly 1 for Expo/In, which the raw equation would leave at 0.999", () => {
    // `PropertyTweener::step` assigns `final_val` outright once the elapsed time reaches the duration; it never
    // evaluates the equation there. A replay that stopped at 0.999 would leave every Expo tween short.
    const [ch] = plan(
      wireHint({ property: "modulate:a", endOpacity: 1, trans: "Expo", ease: "In" }),
      facts()
    );
    expect(easedProgress(ch, 199.9999)).toBeLessThan(1);
    expect(easedProgress(ch, 200)).toBe(1);
  });
});
