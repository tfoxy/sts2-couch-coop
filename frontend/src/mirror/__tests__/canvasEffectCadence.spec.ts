import { describe, expect, it } from "vitest";
import { createEffectCadence } from "@/mirror/canvas/effectCadence";

describe("headless effect cadence", () => {
  it("samples 60Hz stage builds at the configured 30Hz producer cadence and accumulates delta", () => {
    const cadence = createEffectCadence();
    const sampled = Array.from({ length: 20 }, (_, i) => cadence.decide("fx", "v1", i * 16.667, 30, false));
    expect(sampled.filter((entry) => entry.sample)).toHaveLength(10);
    expect(sampled[1]!.nextDueMs).toBeCloseTo(33.333, 2);
    expect(sampled.find((entry, i) => i > 0 && entry.sample)!.delta).toBeCloseTo(0.033334, 5);
  });

  it("forces material changes and renders static effects once", () => {
    const cadence = createEffectCadence();
    expect(cadence.decide("fx", "a", 0, 30, true).sample).toBe(true);
    expect(cadence.decide("fx", "a", 16, 30, true).sample).toBe(false);
    expect(cadence.decide("fx", "b", 16, 30, true).sample).toBe(true);
  });
});
