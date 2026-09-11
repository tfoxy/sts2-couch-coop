import { describe, expect, it } from "vitest";

import { applyAnimationBinding, ensureAnimationStyles } from "@spirectl/presentation/render";

import {
  nodeAnimBinding,
  pinnedLoopBinding,
  pinnedLoopFamily,
  pinnedLoopNodePivot,
  pinnedLoopRidesAnimSelf,
  MAP_POINT_PULSE_TOKEN,
  PROCEED_GLOW_TOKEN,
  TOP_BAR_DECK_ROCK_TOKEN,
  TOP_BAR_MAP_ROCK_TOKEN,
  TOP_BAR_SPIN_TOKEN
} from "@/mirror/animAttributes";

// The headless client freezes the energy/star spin game-side; the mirror replays it on the browser clock
// by reusing @spirectl/presentation's animation vocabulary. These tests lock in the frozen-node → presentation-
// binding map and confirm the presentation per-element apply lands the (normal) keyframe — the wiring a static
// build can check. NOTE: the mirror applies this to a self-layer CHILD (local space) so the transform-shorthand
// keyframe spins in place; the mirror reconcile wiring for that is not landed yet (see mirrorRenderer createEl).
describe("nodeAnimBinding", () => {
  it("maps the ENERGY counter rotation layers to a spin, matching the catalog periods", () => {
    // ironclad/silent/defect/regent: `Layers/RotationLayers/{Layer2,Layer3}` = child indices 0,1 → 1x, 2x.
    expect(nodeAnimBinding("EnergyCounter/Layers/RotationLayers/Layer2", "Node2D")).toEqual({
      path: "EnergyCounter/Layers/RotationLayers/Layer2",
      kind: "rotate",
      durationMs: 12566,
    });
    expect(nodeAnimBinding("EnergyCounter/Layers/RotationLayers/Layer3", "Node2D")).toEqual({
      path: "EnergyCounter/Layers/RotationLayers/Layer3",
      kind: "rotate",
      durationMs: 6283,
    });
    // necrobinder_energy_counter has a SINGLE rotation layer; its `Layers/Layer3` is a sibling of RotationLayers
    // (not a child), so it must not spin.
    expect(nodeAnimBinding("NecrobinderEnergyCounter/Layers/Layer3", "Node2D")).toBeNull();
    expect(nodeAnimBinding("NecrobinderEnergyCounter/Layers/Layer1", "Node2D")).toBeNull();
  });

  it("maps the STAR counter rotation layers by CHILD INDEX, not by leaf number", () => {
    // star_counter.tscn nests them under `Icon/RotationLayers/{Layer1,Layer2}` = child indices 0,1. `Layer2` is
    // therefore the SECOND child here (2x) even though it is the FIRST child in an energy counter (1x).
    expect(nodeAnimBinding("StarCounter/Icon/RotationLayers/Layer1", "Node2D")).toEqual({
      path: "StarCounter/Icon/RotationLayers/Layer1",
      kind: "rotate",
      durationMs: 12566,
    });
    expect(nodeAnimBinding("StarCounter/Icon/RotationLayers/Layer2", "Node2D")).toEqual({
      path: "StarCounter/Icon/RotationLayers/Layer2",
      kind: "rotate",
      durationMs: 6283,
    });
  });

  it("returns null for a RotationLayers child under an UNKNOWN owning container", () => {
    // The ordinal is only derivable for the two known counter containers (`Layers` / `Icon`).
    expect(nodeAnimBinding("Whatever/Mystery/RotationLayers/Layer2", "Node2D")).toBeNull();
  });

  // The bob rides the HOLDER (the mirror DOM is NESTED, so its children move with it) — one animation per
  // intent instead of three, and the two 0×0 `IntentParticle` emitter leaves stop carrying an animation the
  // compositor can't run (`animationHasNoVisibleChange`).
  it("maps the enemy-intent HOLDER to a bob and leaves its children unanimated", () => {
    expect(nodeAnimBinding("EnemyContainer/Enemy/IntentHolder", "Control")).toEqual({
      path: "EnemyContainer/Enemy/IntentHolder",
      kind: "bob",
      durationMs: 2000,
      amplitudePx: 10,
      baselineUpPx: 8,
    });
    for (const leaf of ["IntentHolder/Intent", "IntentHolder/Value", "IntentHolder/IntentParticle"]) {
      expect(nodeAnimBinding(`EnemyContainer/Enemy/${leaf}`, "Sprite2D")).toBeNull();
    }
    // The co-op player intents (different subtree) must not match the IntentHolder suffix.
    expect(nodeAnimBinding("Intents/MultiplayerPlayerIntent/CardIntent", "Node2D")).toBeNull();
    // Nor may a node whose NAME merely ends in the holder's (suffix match is on a full path segment).
    expect(nodeAnimBinding("EnemyContainer/Enemy/FakeIntentHolder", "Control")).toBeNull();
  });

  it("returns null for unrelated nodes and a missing path", () => {
    expect(nodeAnimBinding("EnergyCounter/Layers/RotationLayers/Layer2/Sprite", "Sprite2D")).toBeNull();
    expect(nodeAnimBinding("SomeButton/Label", "Label")).toBeNull();
    expect(nodeAnimBinding(null, "Node2D")).toBeNull();
  });

  it("maps each Tezcatara stepped-fire QUAD leaf to a flameFlicker loop (the flat DOM can't move it via the root)", () => {
    for (const leaf of ["SteppedFireMix", "SteppedFireAdd", "SteppedFireAdd1"]) {
      const b = nodeAnimBinding(`EventBg/Fires/SteppedFireTezcatara3/${leaf}`, "Sprite2D");
      expect(b).not.toBeNull();
      expect(b!.kind).toBe("flameFlicker");
      expect(b!.path).toBe(`EventBg/Fires/SteppedFireTezcatara3/${leaf}`);
      // Phase seed lives in [0, 2600) (the larger loop period).
      expect(b!.delayMs).toBeGreaterThanOrEqual(0);
      expect(b!.delayMs).toBeLessThan(2600);
    }
    // The flame ROOT (last segment not a quad) is NOT mapped, and SteppedFireAdd must not swallow a near-miss.
    expect(nodeAnimBinding("EventBg/Fires/SteppedFireTezcatara3", "Node2D")).toBeNull();
    expect(nodeAnimBinding("EventBg/Fires/SteppedFireTezcatara3/SteppedFireAddX", "Sprite2D")).toBeNull();
  });

  it("shares one phase across a flame's three quads (same parent) but desyncs different flames", () => {
    // Same parent path → same phase → the three stacked quads stay mutually layered. Exact value pins the
    // FNV-1a hash so a native/web drift is caught (CosmeticAnimator.FlamePhaseMs computes the identical 1652).
    const mix = nodeAnimBinding("Fires/SteppedFireTezcatara3/SteppedFireMix", "Sprite2D")!;
    const add = nodeAnimBinding("Fires/SteppedFireTezcatara3/SteppedFireAdd", "Sprite2D")!;
    expect(mix.delayMs).toBe(1652);
    expect(add.delayMs).toBe(1652);
    // A different flame root → a different phase (1652 vs 2376) so the 79 flames don't flicker in lockstep.
    const other = nodeAnimBinding("Fires/SteppedFireTezcatara7/SteppedFireMix", "Sprite2D")!;
    expect(other.delayMs).toBe(2376);
  });
  // NOTE: the flameFlicker APPLY (applyAnimationBinding → CSS keyframes) is owned by @spirectl/presentation and
  // is covered by its own test (presentation/web/test/animations.test.ts). It is deliberately NOT re-tested here:
  // the frontend vitest resolves @spirectl/presentation to the SIBLING spirectl checkout via the vite alias, so a
  // brand-new presentation kind is only visible after the spirectl branch merges — the producer map above is the
  // couch-coop-owned surface. vue-tsc type-checks against the ambient shim (which already carries kind/delayMs/loop).
});

// R10-B2 — the four loops the R13 producer folds out of the wire on top of the map pulse. The producer names the
// loop; the CLIENT owns the keyframes. Every number below is pinned to its single source in the bridge-mod
// (`Sts2TopBarFold` / `Sts2ProceedGlow`), so a drift between producer and client cannot go unnoticed.
describe("pinnedLoopBinding — the top-bar + proceed tokens", () => {
  it("maps the DECK rock onto Sts2TopBarFold's sweep", () => {
    // A continuous ±0.12 rad sine about the icon's pivot:
    // DeckRockAmplitudeRad = 0.12, DeckRockPeriodMs = 2000π / DeckRockRateRadPerSec(4).
    const b = pinnedLoopBinding(TOP_BAR_DECK_ROCK_TOKEN, "616562702403", 57, 45.8333)!;
    expect(b.kind).toBe("rock");
    expect(b.amplitudeRad).toBe(0.12);
    expect(b.durationMs).toBeCloseTo(1570.7963267948966, 9);
    expect(b.pivotX).toBe(57);
    expect(b.pivotY).toBe(45.8333);
  });

  it("maps the MAP rock onto the two 0.8s Sine/InOut tween legs", () => {
    // The map button rocks between −0.12 and +0.12 rad on two 0.8s Sine/InOut legs, looped forever.
    // MapRockAmplitudeRad = 0.12, MapRockPeriodMs = 2 × MapRockLegMs(800).
    const b = pinnedLoopBinding(TOP_BAR_MAP_ROCK_TOKEN, "616378153016", 60.25, 52)!;
    expect(b.kind).toBe("rock");
    expect(b.amplitudeRad).toBe(0.12);
    expect(b.durationMs).toBe(1600);
  });

  it("maps the SETTINGS spin onto a constant 1 rad/s turn", () => {
    // A steady 1 rad/s turn. SpinPeriodMs = 2000π / SpinRateRadPerSec(1), and `rotate`'s durationMs is ONE FULL
    // TURN (not a half-period like the rocks).
    const b = pinnedLoopBinding(TOP_BAR_SPIN_TOKEN, "616747251790", 57, 56.7812)!;
    expect(b.kind).toBe("rotate");
    expect(b.durationMs).toBeCloseTo(6283.185307179587, 9);
    expect(b.pivotX).toBe(57);
    expect(b.pivotY).toBe(56.7812);
    expect(b.amplitudeRad).toBeUndefined();
  });

  it("maps the PROCEED glow onto the pinned-alpha RATIO, not the raw alphas", () => {
    // The Proceed glow sweeps its own alpha 0.25 ↔ 0.75 on two 0.5s LINEAR legs, looped forever.
    // The producer pins the alpha at PinnedAlpha = LoopMaxAlpha = 0.75, so the client multiplies that by an
    // opacity loop: 1 (the pinned value each cycle starts/ends at) ↔ LoopMinAlpha/LoopMaxAlpha = 1/3.
    const b = pinnedLoopBinding(PROCEED_GLOW_TOKEN, "740328219014", 0, 0)!;
    expect(b.kind).toBe("glowPulse");
    expect(b.alphaFrom).toBe(1);
    expect(b.alphaTo).toBeCloseTo(0.25 / 0.75, 12);
    expect(b.durationMs).toBe(1000); // LoopPeriodMs = 2 × LoopLegMs(500)
    // Nothing moves, so no pivot is carried at all (and none enters the renderer's signature — a re-layout of the
    // button must never restart the shimmer).
    expect(b.pivotX).toBeUndefined();
    expect(b.pivotY).toBeUndefined();
  });

  it("gives every token a deterministic in-range phase and keeps unknown tokens null", () => {
    for (const token of [TOP_BAR_DECK_ROCK_TOKEN, TOP_BAR_MAP_ROCK_TOKEN, TOP_BAR_SPIN_TOKEN, PROCEED_GLOW_TOKEN]) {
      const b = pinnedLoopBinding(token, "n1", 1, 2)!;
      expect(b.delayMs).toBeGreaterThanOrEqual(0);
      expect(b.delayMs).toBeLessThan(b.durationMs!);
      expect(pinnedLoopBinding(token, "n1", 1, 2)!.delayMs).toBe(b.delayMs); // stable per node
    }
    expect(pinnedLoopBinding("someFutureLoop", "n1", 0, 0)).toBeNull();
  });
});

describe("pinnedLoopFamily / pinnedLoopNodePivot / pinnedLoopRidesAnimSelf", () => {
  it("gives each kill switch its own tokens", () => {
    expect(pinnedLoopFamily(MAP_POINT_PULSE_TOKEN)).toBe("mapPulse");
    expect(pinnedLoopFamily(TOP_BAR_DECK_ROCK_TOKEN)).toBe("topBar");
    expect(pinnedLoopFamily(TOP_BAR_MAP_ROCK_TOKEN)).toBe("topBar");
    expect(pinnedLoopFamily(TOP_BAR_SPIN_TOKEN)).toBe("topBar");
    expect(pinnedLoopFamily(PROCEED_GLOW_TOKEN)).toBe("glow");
    expect(pinnedLoopFamily("someFutureLoop")).toBeNull();
  });

  it("carries each icon's AUTHORED pivot_offset, straight out of its scene file", () => {
    // scenes/ui/top_bar/top_bar_{deck,map,settings}_button.tscn → the `Control/Icon` node's `pivot_offset`.
    // None of them is the box centre, which is why the rotation kinds need the value at all.
    expect(pinnedLoopNodePivot(TOP_BAR_DECK_ROCK_TOKEN)).toEqual({ x: 36, y: 34 });
    expect(pinnedLoopNodePivot(TOP_BAR_MAP_ROCK_TOKEN)).toEqual({ x: 42, y: 32 });
    expect(pinnedLoopNodePivot(TOP_BAR_SPIN_TOKEN)).toEqual({ x: 32, y: 33 });
    // The map pulse derives its own pivot (box centre, lifted through the baked matrix — a different space); the
    // glow needs none.
    expect(pinnedLoopNodePivot(MAP_POINT_PULSE_TOKEN)).toBeNull();
    expect(pinnedLoopNodePivot(PROCEED_GLOW_TOKEN)).toBeNull();
  });

  it("routes the rotation/glow kinds to the self layer and leaves the map pulse on the element", () => {
    // A rotation over a baked matrix ORBITS the node, and an opacity has to MULTIPLY the element's own — both need
    // the child. `pivotPulse` composes `scale:`+`translate:` precisely so it can ride the element itself.
    expect(pinnedLoopRidesAnimSelf(TOP_BAR_DECK_ROCK_TOKEN)).toBe(true);
    expect(pinnedLoopRidesAnimSelf(TOP_BAR_MAP_ROCK_TOKEN)).toBe(true);
    expect(pinnedLoopRidesAnimSelf(TOP_BAR_SPIN_TOKEN)).toBe(true);
    expect(pinnedLoopRidesAnimSelf(PROCEED_GLOW_TOKEN)).toBe(true);
    expect(pinnedLoopRidesAnimSelf(MAP_POINT_PULSE_TOKEN)).toBe(false);
    expect(pinnedLoopRidesAnimSelf("someFutureLoop")).toBe(false);
  });
});

describe("presentation applyAnimationBinding (per-element extract)", () => {
  it("injects the spin keyframe and applies it to the element", () => {
    ensureAnimationStyles(document);
    const el = document.createElement("div");
    const binding = nodeAnimBinding("EnergyCounter/Layers/RotationLayers/Layer2", "Node2D");
    expect(binding).not.toBeNull();
    expect(applyAnimationBinding(el, binding!)).toBe(true);
    // The (self-layer child) element gets the shared spin keyframe on its own transform.
    expect(el.style.animation).toContain("spirectl-rotate");
    expect(document.getElementById("spirectl-presentation-animations")?.textContent).toContain(
      "@keyframes spirectl-rotate",
    );
  });

  it("returns false for a node with no known animation kind", () => {
    const el = document.createElement("div");
    expect(applyAnimationBinding(el, { path: "x", kind: "nope" })).toBe(false);
  });

  it("bobs via the individual translate: keyframe in compose mode, leaving a baked transform intact", () => {
    ensureAnimationStyles(document);
    const el = document.createElement("div");
    el.style.transform = "matrix(1, 0, 0, 1, 1414, 519)"; // the mirror's baked global matrix for the intent holder
    const binding = nodeAnimBinding("EnemyContainer/Enemy/IntentHolder", "Control");
    expect(binding).not.toBeNull();
    expect(applyAnimationBinding(el, binding!, { compose: true })).toBe(true);
    // The compose keyframe drives `translate:` (not `transform:`), so the baked matrix that positions the holder is
    // untouched — the translate composes with it (origin-independent) instead of clobbering it into a jump.
    expect(el.style.animation).toContain("spirectl-intent-bob-compose");
    expect(el.style.transform).toBe("matrix(1, 0, 0, 1, 1414, 519)");
    expect(el.style.getPropertyValue("--spirectl-bob-amp")).toBe("10px");
    expect(document.getElementById("spirectl-presentation-animations")?.textContent).toContain(
      "@keyframes spirectl-intent-bob-compose",
    );
  });

  it("uses value-keyed literal bob keyframes", () => {
    ensureAnimationStyles(document);
    const binding = nodeAnimBinding("EnemyContainer/Enemy/IntentHolder", "Control")!;

    const lit = document.createElement("div");
    expect(applyAnimationBinding(lit, binding, { compose: true })).toBe(true);
    const litName = /(spirectl-intent-bob-compose\S*)/.exec(lit.style.animation)?.[1] ?? "";
    expect(litName).not.toBe("spirectl-intent-bob-compose"); // value-keyed, i.e. suffixed with the px pair

  });
});
