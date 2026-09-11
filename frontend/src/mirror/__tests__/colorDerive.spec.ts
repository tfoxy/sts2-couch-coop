import { describe, expect, it } from "vitest";

import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode } from "@/mirror/sceneTree";

// Stage 2 (client side): the slimmed wire ships colors as `{html:"#rrggbbaa"}` only, so normalizeColor / specColor
// must DERIVE the linear channels from the hex (channels-first precedence keeps OLD full-channel recordings
// byte-identical). Miss the particle path and ramps/baseColors render white. byte/255 is lossless at the
// renderer's consumption precision (tint quantizes to ~0.02).

function nodeFrom(over: Record<string, unknown>): MirrorNode {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: [{ id: "n", name: "n", nodeType: "Control", ...over }],
      orderedIds: ["n"]
    })!
  );
  return state.nodes.get("n")!;
}

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe("color channel derivation from html (Stage 2 wire slim)", () => {
  it("derives modulate channels from html-only", () => {
    const n = nodeFrom({ modulate: { html: "#804020ff" } });
    near(n.modulate!.r, 0x80 / 255);
    near(n.modulate!.g, 0x40 / 255);
    near(n.modulate!.b, 0x20 / 255);
    near(n.modulate!.a, 1);
    expect(n.modulate!.html).toBe("#804020ff");
  });

  it("keeps OLD full-channel colors byte-identical (channels-first precedence)", () => {
    const n = nodeFrom({ modulate: { r: 0.123, g: 0.456, b: 0.789, a: 0.5, html: "#1f74c980" } });
    near(n.modulate!.r, 0.123);
    near(n.modulate!.g, 0.456);
    near(n.modulate!.b, 0.789);
    near(n.modulate!.a, 0.5);
  });

  it("derives fillColor alpha from html (drives the a>0.02 gate)", () => {
    const opaque = nodeFrom({ fillColor: { html: "#12345678" } });
    near(opaque.fillColor!.a, 0x78 / 255);
    const transparent = nodeFrom({ fillColor: { html: "#12345600" } });
    near(transparent.fillColor!.a, 0);
  });

  it("derives particle baseColor from html-only via specColor", () => {
    const n = nodeFrom({
      particleSpec: { kind: "GPUParticles2D", amount: 8, baseColor: { html: "#ff0000ff" } }
    });
    const base = n.particleSpec!.baseColor as number[];
    near(base[0], 1);
    near(base[1], 0);
    near(base[2], 0);
    near(base[3], 1);
  });

  it("derives particle colorRamp stops from html-only via specStops", () => {
    const n = nodeFrom({
      particleSpec: {
        kind: "GPUParticles2D",
        amount: 8,
        colorRamp: [
          { offset: 0, color: { html: "#00ff00ff" } },
          { offset: 1, color: { html: "#0000ffff" } }
        ]
      }
    });
    const ramp = n.particleSpec!.colorRamp as Array<{ offset: number; color: number[] }>;
    near(ramp[0].color[1], 1); // green
    near(ramp[1].color[2], 1); // blue
  });

  it("three-hex-pair #RRGGBB (no alpha) defaults alpha to opaque", () => {
    const n = nodeFrom({ modulate: { html: "#ff8000" } });
    near(n.modulate!.a, 1);
    near(n.modulate!.r, 1);
    near(n.modulate!.g, 0x80 / 255);
  });

  it("malformed hex falls back to opaque white (old default)", () => {
    const n = nodeFrom({ modulate: { html: "not-a-color" } });
    near(n.modulate!.r, 1);
    near(n.modulate!.g, 1);
    near(n.modulate!.b, 1);
    near(n.modulate!.a, 1);
  });
});
