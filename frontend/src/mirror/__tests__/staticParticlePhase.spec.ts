import { describe, expect, it } from "vitest";
import { createStaticParticlePhaseBank } from "@/mirror/canvas/staticParticlePhase";

describe("strict-canvas static particle phase", () => {
  it("warms a non-preprocessed one-shot to the DOM runtime's representative frame, then expires it at its active window", () => {
    const phases = createStaticParticlePhaseBank();
    const spec = { oneShot: true, lifetime: 0.4, explosiveness: 0, preprocess: 0 };

    expect(phases.sample("ring", spec, true, 1, 100)).toMatchObject({ expired: false, nextDueMs: 900 });
    expect(phases.sample("ring", spec, true, 1, 100).warmSeconds).toBeCloseTo(0.16);
    expect(phases.sample("ring", spec, true, 1, 899).expired).toBe(false);
    expect(phases.sample("ring", spec, true, 1, 900)).toMatchObject({ expired: true, nextDueMs: Infinity });
  });

  it("does not warm an authored preprocessed emitter and restarts a retired burst on its new epoch", () => {
    const phases = createStaticParticlePhaseBank();
    const spec = { oneShot: true, lifetime: 1, explosiveness: 1, preprocess: 2 };

    expect(phases.sample("burst", spec, true, 1, 0)).toMatchObject({ warmSeconds: 0, expired: false });
    expect(phases.sample("burst", spec, true, 1, 1000).expired).toBe(true);
    expect(phases.sample("burst", spec, true, 2, 1000)).toMatchObject({ expired: false, nextDueMs: 2000 });
  });

  it("keeps repeating emitters warm and treats a non-emitting one-shot as an intentional no-op", () => {
    const phases = createStaticParticlePhaseBank();

    expect(phases.sample("ambient", { oneShot: false, lifetime: 2, preprocess: 0 }, true, null, 0)).toMatchObject({ expired: false, warmSeconds: 2, nextDueMs: Infinity });
    expect(phases.sample("quiet", { oneShot: true, lifetime: 1 }, false, 1, 0).expired).toBe(true);
  });
});
