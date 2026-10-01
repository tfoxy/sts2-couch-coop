import { describe, expect, it } from "vitest";
import { createProducerBuildReasons, type ProducerBuildObservation } from "./producerBuildReasons";

const row = (overrides: Partial<ProducerBuildObservation> = {}): ProducerBuildObservation => ({
  source: "wire", decline: "scene-rewrite", sceneRevision: 12, committedRevision: 11,
  changedIds: 1, sceneRewrite: true, sampledVisual: false, sizeChanged: false,
  fontChanged: false, textureCountChanged: false, resourcesPending: false, elapsedMs: 2, windowPhase: 1,
  ...overrides,
});

describe("producer build reason diagnostic", () => {
  it("counts every build without dropping repeated reasons and preserves revision bounds", () => {
    const diagnostic = createProducerBuildReasons();
    diagnostic.add(row());
    diagnostic.add(row({ sceneRevision: 13, committedRevision: 12, elapsedMs: 3 }));
    diagnostic.add(row({ source: "animation", decline: "transform-overrides", sceneRevision: 13,
      committedRevision: 13, changedIds: 0, sceneRewrite: false, sampledVisual: true, elapsedMs: 5 }));
    const snapshot = diagnostic.snapshot();
    expect(snapshot.total).toBe(3);
    expect(snapshot.bySource.wire).toEqual({ count: 2, elapsedMs: 5,
      firstSceneRevision: 12, lastSceneRevision: 13, firstCommittedRevision: 11, lastCommittedRevision: 12 });
    expect(snapshot.byDecline["transform-overrides"].count).toBe(1);
    expect(snapshot.byObservedInput["sampled-visual-observed"].count).toBe(1);
    expect(snapshot.bySourceDecline["wire:scene-rewrite"].count).toBe(2);
    expect(snapshot.byWindowSourceDecline["1:wire:scene-rewrite"].count).toBe(2);
    diagnostic.add(row({ source: "resource", decline: "direct-build", elapsedMs: 7 }));
    diagnostic.noteNonBuild("full-build-deferred-in-flight");
    expect(snapshot.total).toBe(3);
    expect(diagnostic.snapshot().total).toBe(4);
    expect(diagnostic.snapshot().nonBuild["full-build-deferred-in-flight"]).toBe(1);
  });

  it("does not label an unobserved change as unchanged output", () => {
    const diagnostic = createProducerBuildReasons();
    diagnostic.add(row({ source: "clock", decline: "plan-unsupported", sceneRevision: 4,
      committedRevision: 4, changedIds: 0, sceneRewrite: false }));
    diagnostic.add(row({ source: "resize", decline: "direct-build", sceneRevision: 4,
      committedRevision: 4, changedIds: 0, sceneRewrite: false, sizeChanged: true }));
    expect(diagnostic.snapshot().byObservedInput["none-observed"].count).toBe(1);
    expect(diagnostic.snapshot().byObservedInput["size-observed"].count).toBe(1);
    diagnostic.add(row({ source: "wire", sceneRevision: 5, committedRevision: 4,
      changedIds: 0, sceneRewrite: false }));
    expect(diagnostic.snapshot().byObservedInput["wire-revision-only"].count).toBe(1);
  });

  it("joins full-build stages to one terminal outcome and hashes pending dependencies", () => {
    const diagnostic = createProducerBuildReasons();
    const first = diagnostic.add(row({ sampleClock: 123, fontEpoch: 4, textureEpoch: 7, sizeEpoch: 2 }));
    diagnostic.event(first, { stage: "encoded", operationId: 9, mode: "full-scene" });
    diagnostic.event(first, { stage: "api-attempt", operationId: 9, mode: "scene-patch" });
    diagnostic.event(first, { stage: "api-accepted", operationId: 9, mode: "scene-patch" });
    diagnostic.event(first, { stage: "presented", operationId: 9, mode: "scene-patch" });
    expect(diagnostic.snapshot().ledger.openBuildIds).toEqual([first]);
    expect(diagnostic.snapshot().ledger.complete).toBe(false);
    expect(diagnostic.finish(first, "committed")).toBe(true);
    const second = diagnostic.add(row({ source: "resource" }));
    diagnostic.event(second, { stage: "texture-pending", dependencyKeys: ["/res/a.png"] });
    diagnostic.finish(second, "refused");
    const snapshot = diagnostic.snapshot().ledger;
    expect(snapshot.starts).toBe(2);
    expect(snapshot.terminal).toBe(2);
    expect(snapshot.openBuildIds).toEqual([]);
    expect(snapshot.rows[0]).toMatchObject({ buildId: first, state: "committed", sampleClock: 123 });
    expect(snapshot.rows[0].events[0]).toMatchObject({ stage: "encoded", operationId: 9 });
    expect(snapshot.rows[1].state).toBe("stopped-texture-pending");
    expect(snapshot.rows[1].dependencies).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("/res/a.png");
  });

  it("preserves superseded and disposed terminals across late callbacks", () => {
    const diagnostic = createProducerBuildReasons();
    const stale = diagnostic.add(row());
    const resized = diagnostic.add(row({ sizeEpoch: 2 }));
    const inFlight = diagnostic.add(row({ source: "animation" }));
    diagnostic.finish(stale, "superseded");
    diagnostic.finish(resized, "superseded");
    diagnostic.disposeOpen();
    diagnostic.event(inFlight, { stage: "presented", operationId: 5 });
    expect(diagnostic.finishIfOpen(inFlight, "committed")).toBe(false);
    expect(diagnostic.snapshot().ledger.rows.map((entry) => entry.state)).toEqual([
      "superseded", "superseded", "disposed",
    ]);
    expect(diagnostic.snapshot().ledger.lateEvents).toBe(1);
    expect(diagnostic.snapshot().ledger.lateTerminalCalls).toBe(1);
    expect(diagnostic.snapshot().ledger.complete).toBe(false);
    expect(diagnostic.finish(stale, "committed")).toBe(false);
    expect(diagnostic.snapshot().ledger.duplicateFinalizations).toBe(1);
  });

  it("fails closed on a dependency list or row capacity overflow", () => {
    const diagnostic = createProducerBuildReasons();
    const id = diagnostic.add(row());
    diagnostic.finish(id, "stopped-font-pending", "font", Array.from({ length: 129 }, (_, index) => `font-${index}`));
    expect(diagnostic.snapshot().ledger).toMatchObject({ overflow: true, complete: false });
    const full = createProducerBuildReasons();
    for (let i = 0; i < 2049; i++) full.add(row({ sceneRevision: i }));
    expect(full.snapshot().ledger).toMatchObject({ starts: 2049, overflow: true, complete: false });
  });

  it("keeps retained and present-only operations separate from full producer builds", () => {
    const diagnostic = createProducerBuildReasons(true);
    const build = diagnostic.add(row());
    diagnostic.event(build, { stage: "presented", operationId: 1, mode: "full-scene" });
    diagnostic.finish(build, "committed");
    const patch = diagnostic.startRetained(12, "scene-patch");
    diagnostic.retainedEvent(patch, { stage: "api-accepted", operationId: 2, mode: "scene-patch" });
    diagnostic.retainedEvent(patch, { stage: "present-call", operationId: 2, mode: "scene-patch" });
    expect(diagnostic.snapshot().retainedOperations).toMatchObject({ starts: 1, terminal: 0,
      openSubmissionIds: [patch], complete: false });
    diagnostic.retainedEvent(patch, { stage: "presented", operationId: 2, mode: "scene-patch" });
    diagnostic.finishRetained(patch, "committed");
    const presentOnly = diagnostic.startRetained(12, "present-only");
    diagnostic.retainedEvent(presentOnly, { stage: "present-call", operationId: 0x80000000, mode: "present-only" });
    diagnostic.finishRetained(presentOnly, "refused");
    const snapshot = diagnostic.snapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.ledger).toMatchObject({ starts: 1, terminal: 1, complete: true });
    expect(snapshot.retainedOperations).toMatchObject({ starts: 2, terminal: 2,
      openSubmissionIds: [], complete: true, rows: [
        { mode: "scene-patch", operationId: 2, state: "committed" },
        { mode: "present-only", operationId: 0x80000000, state: "refused" },
      ] });
  });

  it("fails retained evidence closed on late events, duplicate terminals and overflow", () => {
    const diagnostic = createProducerBuildReasons(true);
    const id = diagnostic.startRetained(7, "scene-patch");
    diagnostic.disposeOpen();
    diagnostic.retainedEvent(id, { stage: "presented", operationId: 7 });
    expect(diagnostic.finishRetained(id, "committed")).toBe(false);
    expect(diagnostic.snapshot().retainedOperations).toMatchObject({ lateEvents: 1,
      duplicateFinalizations: 1, complete: false, rows: [{ state: "disposed" }] });
    const full = createProducerBuildReasons(true);
    for (let i = 0; i < 2049; i++) full.startRetained(i, "present-only");
    expect(full.snapshot().retainedOperations).toMatchObject({ starts: 2049, overflow: true, complete: false });
  });
});
