import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bakedStillFor,
  bakedStillNeedsOwnLayer,
  CARD_RIPPLE_SHOWN_WIDTH
} from "@/mirror/bakedEffects";
import { mirrorSettings, type EffectMode } from "@/mirror/mirrorSettings";
import { CARD_RIPPLE_SHADER_IDS } from "@/mirror/shaderResources";
import type { MirrorNode, MirrorShaderParam } from "@/mirror/sceneTree";

// The two glow emitters, spelled exactly as the producer streams them (confirmed against a recorded mirror
// session, `.sts2/bench/audit-cardreward-open.ndjson`).
const UNCOMMON_GLOW = "MegaCrit.Sts2.Core.Nodes.Vfx.Cards.NCardUncommonGlow";
const RARE_GLOW = "MegaCrit.Sts2.Core.Nodes.Vfx.Cards.NCardRareGlow";

function mkNode(over: Partial<MirrorNode> = {}): MirrorNode {
  return { id: "n", nodeType: "Godot.Node2D", shaderId: null, shaderParams: null, particleSpec: null, ...over } as MirrorNode;
}

/** A card highlight whose ripple the game currently has tweened to `width`. */
function rippleNode(width: number | null): MirrorNode {
  const params: MirrorShaderParam[] =
    width === null ? [] : [{ name: "width", kind: "number", number: width } as MirrorShaderParam];
  return mkNode({
    nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCardHighlight",
    shaderId: CARD_RIPPLE_SHADER_IDS[0],
    shaderParams: params
  });
}

function glowNode(nodeType: string): MirrorNode {
  return mkNode({ nodeType, particleSpec: { kind: "GPUParticles2D" } as MirrorNode["particleSpec"] });
}

let savedShaderMode: EffectMode;
let savedParticleMode: EffectMode;

beforeEach(() => {
  savedShaderMode = mirrorSettings.shaderMode;
  savedParticleMode = mirrorSettings.particleMode;
  mirrorSettings.shaderMode = "off";
  mirrorSettings.particleMode = "off";
});

afterEach(() => {
  mirrorSettings.shaderMode = savedShaderMode;
  mirrorSettings.particleMode = savedParticleMode;
});

describe("bakedStillFor — the card ripple", () => {
  it("stands in for a SHOWN ripple while shaders are off", () => {
    const still = bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH));

    expect(still).not.toBeNull();
    expect(still!.url).toMatch(/card-ripple/);
    // Baked at the node's own localRect, so the element paints it across itself.
    expect(still!.box).toBe("localRect");
    // The shader declares `render_mode blend_add` and NOTHING streams that, so this paint has to carry the
    // additive blend itself — unlike the glows, whose material reaches the DOM as `canvasBlendMode`.
    expect(still!.additive).toBe(true);
    expect(still!.opacityScale).toBe(1);
  });

  it("paints NOTHING for a ripple the game has hidden", () => {
    // `width` 0 is NCardHighlight at rest — every unplayable card in the hand. Painting the still there would
    // light up the whole hand, which is the opposite of the cue.
    expect(bakedStillFor(rippleNode(0))).toBeNull();
  });

  it("paints NOTHING when the width uniform is not streamed at all", () => {
    // An effect we cannot measure is not invented. (The WebGL path makes the opposite call for the same node —
    // there an unmeasurable uniform must not wrongly HIDE a live effect.)
    expect(bakedStillFor(rippleNode(null))).toBeNull();
  });

  it("scales opacity with the tween so the glow fades in rather than popping", () => {
    // AnimShow/AnimHide tween `width` over 0.5 s, and a card's playability flips on every energy change.
    const half = bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH / 2));
    expect(half!.opacityScale).toBeCloseTo(0.5, 5);
  });

  it("clamps the opacity scale through AnimFlash's overshoot", () => {
    // AnimFlash peaks at 0.15 — double the shown width — before settling back.
    expect(bakedStillFor(rippleNode(0.15))!.opacityScale).toBe(1);
  });

  it("paints nothing in any mode that still renders the real shader", () => {
    for (const mode of ["dynamic", "dynamic-half", "dynamic-quarter", "static"] as const) {
      mirrorSettings.shaderMode = mode;
      expect(bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))).toBeNull();
    }
  });

  it("ignores a shader node that is not the ripple", () => {
    mirrorSettings.shaderMode = "off";
    const other = mkNode({ shaderId: "res://shaders/hsv.gdshader", shaderParams: [] });
    expect(bakedStillFor(other)).toBeNull();
  });
});

describe("bakedStillFor — the rarity glows", () => {
  it("stands in for each emitter while particles are off", () => {
    const uncommon = bakedStillFor(glowNode(UNCOMMON_GLOW));
    const rare = bakedStillFor(glowNode(RARE_GLOW));

    expect(uncommon!.url).toMatch(/glow-uncommon/);
    expect(rare!.url).toMatch(/glow-rare/);
    // A GPUParticles2D streams no localRect, so each still must state its own node-local box.
    expect(uncommon!.box).toEqual({ x: -256, y: -256, width: 512, height: 512 });
    expect(rare!.box).toEqual({ x: -384, y: -384, width: 768, height: 768 });
    // Centred on the emitter origin, which is what makes the placement one translate.
    for (const still of [uncommon!, rare!]) {
      const box = still.box as { x: number; y: number; width: number; height: number };
      expect(box.x).toBe(-box.width / 2);
      expect(box.y).toBe(-box.height / 2);
    }
  });

  it("does NOT ask for its own blend — the emitter's material already streams one", () => {
    // `canvas_item_material_additive_shared.tres` reaches the DOM as `canvasBlendMode: 1`, which nodeStyle maps
    // to plus-lighter. Asking again here would be the same blend claimed from two places.
    expect(bakedStillFor(glowNode(UNCOMMON_GLOW))!.additive).toBe(false);
    expect(bakedStillFor(glowNode(RARE_GLOW))!.additive).toBe(false);
  });

  it("bakes no modulate in, so the game's own fade stays the element's", () => {
    // Both glow scripts tween modulate:a 1.0 -> 0.9 on tree entry and the mirror streams that as opacity.
    expect(bakedStillFor(glowNode(UNCOMMON_GLOW))!.opacityScale).toBe(1);
  });

  it("paints nothing in any mode that still simulates particles", () => {
    for (const mode of ["dynamic", "dynamic-half", "dynamic-quarter", "static"] as const) {
      mirrorSettings.particleMode = mode;
      expect(bakedStillFor(glowNode(UNCOMMON_GLOW))).toBeNull();
    }
  });

  it("ignores an unrelated particle emitter", () => {
    expect(bakedStillFor(glowNode("MegaCrit.Sts2.Core.Nodes.Vfx.NSomeOtherVfx"))).toBeNull();
  });

  it("does not answer for a glow node with no particle spec", () => {
    expect(bakedStillFor(mkNode({ nodeType: UNCOMMON_GLOW }))).toBeNull();
  });
});

describe("bakedStillFor — the families are independent", () => {
  it("shaders off does not enable the glow stills", () => {
    mirrorSettings.particleMode = "static";
    expect(bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))).not.toBeNull();
    expect(bakedStillFor(glowNode(RARE_GLOW))).toBeNull();
  });

  it("particles off does not enable the ripple still", () => {
    mirrorSettings.shaderMode = "static";
    expect(bakedStillFor(glowNode(RARE_GLOW))).not.toBeNull();
    expect(bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))).toBeNull();
  });

  it("answers null on one field read for an ordinary node", () => {
    expect(bakedStillFor(mkNode())).toBeNull();
  });
});

describe("bakedStillNeedsOwnLayer", () => {
  it("separates the two mount paths", () => {
    // The ripple is a background on the node's own element; a boxless emitter needs a positioned <img>.
    expect(bakedStillNeedsOwnLayer(bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))!)).toBe(false);
    expect(bakedStillNeedsOwnLayer(bakedStillFor(glowNode(RARE_GLOW))!)).toBe(true);
  });
});

// THE SCOPE, recorded so it does not read as an oversight. The baked stills are wired into the DOM stage only —
// `?stage=dom`, the shipping default. The `?stage=canvas` backend is an opt-in experiment whose draw-list builder
// deliberately does not consult this module, so on that stage an off-mode effect still paints nothing at all. If
// the canvas stage ever ships as the default this test is the thing that should fail first.
describe("canvas stage scope", () => {
  it("does not consult the baked stills", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../canvas/paintSpec.ts"),
      "utf8"
    );

    expect(source).not.toContain("bakedEffects");
    expect(source).not.toContain("bakedStillFor");
  });
});
