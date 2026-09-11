import { describe, expect, it } from "vitest";

import {
  appendTrailPoint,
  buildTrailStrip,
  createTrailPoints,
  expireTrailPoints,
  trailPhaseProbe,
  trailProfile,
  TRAIL_POINT_DURATION_MS,
  type TrailPoints
} from "@/mirror/cardTrail";

function curved(pointCount = 24): TrailPoints {
  const points = createTrailPoints();
  for (let i = 0; i < pointCount; i++) {
    const t = i / (pointCount - 1);
    appendTrailPoint(points, 200 + t * 1400, 900 - Math.sin(t * Math.PI) * 520, i * 16);
  }
  return points;
}

function straight(): TrailPoints {
  const points = createTrailPoints();
  for (let i = 0; i <= 12; i++) appendTrailPoint(points, i * 60, 500, i * 16);
  return points;
}

describe("trail seams", () => {
  it("uses half-alpha joint quads only where a curved ribbon needs them", () => {
    const curvedStrip = buildTrailStrip(curved(), trailProfile("OuterTrail"), { textured: true })!;
    const straightStrip = buildTrailStrip(straight(), trailProfile("OuterTrail"), { textured: true })!;

    expect(curvedStrip.seamQuads.length).toBeGreaterThan(0);
    expect(straightStrip.seamQuads).toHaveLength(0);
    for (const seam of curvedStrip.seamQuads) {
      const owner = curvedStrip.quads.find(
        (cell) => Math.abs(cell.m[2] - seam.m[2]) < 1e-9 && Math.abs(cell.m[3] - seam.m[3]) < 1e-9
      );
      expect(owner).toBeDefined();
      expect(seam.alpha).toBeCloseTo(owner!.alpha / 2, 12);
    }
  });
});

describe("trailPhaseProbe", () => {
  it("reports a live stroke's age span and current head", () => {
    const points = createTrailPoints();
    appendTrailPoint(points, 0, 0, 1000);
    appendTrailPoint(points, 100, 0, 1200);
    appendTrailPoint(points, 200, 0, 1400);
    const phase = trailPhaseProbe([{ id: "outer", points }], 1500);
    expect(phase).toMatchObject({ strokes: 1, points: 3, oldestAgeMs: 500, headAgeMs: 100, headX: 200, headY: 0 });
    expect(phase.arcPx).toBeCloseTo(200, 9);
  });

  it("tracks the same ribbon as its oldest points expire", () => {
    const points = createTrailPoints();
    for (let i = 0; i < 8; i++) appendTrailPoint(points, i * 40, 0, 1000 + i * 60);
    const young = trailPhaseProbe([{ id: "outer", points }], 1420);
    expireTrailPoints(points, 1900, TRAIL_POINT_DURATION_MS);
    const old = trailPhaseProbe([{ id: "outer", points }], 1900);
    expect(old.points).toBeLessThan(young.points);
    expect(old.arcPx).toBeLessThan(young.arcPx);
  });
});
