import { describe, expect, it, vi } from "vitest";

import { createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import type { TrailQuadSource } from "@/mirror/canvas/paintSpec";
import type { TrailStrip } from "@/mirror/cardTrail";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// Strict canvas admission may leave an inactive ribbon commandless, but that
// proof belongs to the source queried by the builder. These tests keep the
// no-op route distinct from an active ribbon's real painter-order quads.

function stateWithTrail(): MirrorState {
  const state = createMirrorState();
  applySceneDelta(state, parseSceneDelta({
    type: "scene-delta",
    full: true,
    screenType: "combat",
    orderedIds: ["root", "trail"],
    upserts: [
      {
        id: "root", parentId: null, name: "Root", nodeType: "Control", visible: true,
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } }
      },
      {
        id: "trail", parentId: "root", name: "OuterTrail", nodeType: "MegaCrit.Sts2.Core.Nodes.Vfx.NCardTrail", visible: true,
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 50 } },
        texture: { resourcePath: "res://trail.png" }
      }
    ]
  })!);
  return state;
}

const LIVE_STRIP: TrailStrip = {
  quads: [{ m: [20, 0, 0, 10, 0, 0], alpha: 1 }],
  seamQuads: [],
  textured: false,
  bands: 1,
  segments: 1,
  x1: 0,
  y1: 0,
  x2: 20,
  y2: 0,
  bboxArea: 200
};

function buildWith(source: TrailQuadSource) {
  return buildDrawList(stateWithTrail(), createDrawList<string>(), {
    hitTest: false,
    assert: true,
    trailSource: source,
    stageOwnedNoop: (_input, record) => record.kind === "trail" && source.isProvablySilent?.(record.id) === true
  });
}

describe("strict trail source admission", () => {
  it("marks an exactly empty source strip as a stage-owned no-op", () => {
    const stripFor = vi.fn<TrailQuadSource["stripFor"]>(() => null);
    const silent = vi.fn((id: string) => {
      const strip = stripFor(id);
      return strip === null || strip.quads.length === 0;
    });
    const built = buildWith({
      isProvablySilent: silent,
      stripFor,
      textureFor: () => null,
      blendFor: () => 0
    });

    expect(built.overlayRecords.map((record) => record.kind)).toEqual(["trail"]);
    expect(silent).toHaveBeenCalledWith("trail");
    expect(stripFor).toHaveBeenCalledTimes(2);
    expect(stripFor).toHaveBeenNthCalledWith(1, "trail");
    expect(stripFor).toHaveBeenNthCalledWith(2, "trail");
    expect(built.stageOwnedNoopIds).toEqual(new Set(["trail"]));
    expect(built.trailQuadIds.size).toBe(0);
    expect(built.stats.trailQuads).toBe(0);
  });

  it("emits active source strips as real trail quads instead of no-ops", () => {
    const stripFor = vi.fn<TrailQuadSource["stripFor"]>(() => LIVE_STRIP);
    const silent = vi.fn((id: string) => {
      const strip = stripFor(id);
      return strip === null || strip.quads.length === 0;
    });
    const built = buildWith({
      isProvablySilent: silent,
      stripFor,
      textureFor: () => null,
      blendFor: () => 0
    });

    expect(silent).toHaveBeenCalledWith("trail");
    expect(stripFor).toHaveBeenCalledTimes(2);
    expect(stripFor).toHaveBeenNthCalledWith(1, "trail");
    expect(stripFor).toHaveBeenNthCalledWith(2, "trail");
    expect(built.stageOwnedNoopIds.size).toBe(0);
    expect(built.trailQuadIds).toEqual(new Set(["trail"]));
    expect(built.stats.trailQuads).toBe(1);
  });
});
