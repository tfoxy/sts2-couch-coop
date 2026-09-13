import { describe, expect, it, vi } from "vitest";
import { createFirstScenePresentation } from "../firstScenePresentation";

function harness() {
  let next = 0;
  let visible = true;
  const frames = new Map<number, FrameRequestCallback>();
  const presented = vi.fn();
  const failed = vi.fn();
  const gate = createFirstScenePresentation({
    presented, failed, visible: () => visible,
    requestFrame: (callback) => { frames.set(++next, callback); return next; },
    cancelFrame: (handle) => { frames.delete(handle); }
  });
  return { gate, frames, presented, failed,
    visible(value: boolean) { visible = value; gate.visibilityChanged(); },
    frame() { const due = [...frames.values()]; frames.clear(); due.forEach((fn) => fn(0)); }
  };
}

describe("first game frame connection receipt", () => {
  it("waits for a successful frame and a paint opportunity, then sends once", () => {
    const h = harness();
    h.gate.setAttempt("attempt-1");
    h.frame(); h.frame();
    expect(h.presented).not.toHaveBeenCalled();
    h.gate.rendered();
    h.frame();
    expect(h.presented).not.toHaveBeenCalled();
    h.frame();
    expect(h.presented).toHaveBeenCalledExactlyOnceWith("attempt-1");
    h.gate.rendered(); h.frame(); h.frame();
    expect(h.presented).toHaveBeenCalledTimes(1);
  });

  it("does not complete a hidden tab and resumes when it becomes visible", () => {
    const h = harness();
    h.gate.setAttempt("attempt-1");
    h.gate.rendered(); h.frame();
    h.visible(false); h.frame();
    expect(h.presented).not.toHaveBeenCalled();
    expect(h.frames.size).toBe(0);
    h.visible(true); h.frame(); h.frame();
    expect(h.presented).toHaveBeenCalledExactlyOnceWith("attempt-1");
  });

  it("rejects an old callback after a new attempt and requires its own render", () => {
    const h = harness();
    h.gate.setAttempt("old"); h.gate.rendered();
    const stale = [...h.frames.values()][0];
    h.gate.setAttempt("new");
    stale(0); h.frame(); h.frame();
    expect(h.presented).not.toHaveBeenCalled();
    h.gate.rendered(); h.frame(); h.frame();
    expect(h.presented).toHaveBeenCalledExactlyOnceWith("new");
  });

  it("cancels pending success on unmount or a rendering failure", () => {
    const h = harness();
    h.gate.setAttempt("old"); h.gate.rendered(); h.frame();
    h.gate.failed(new Error("texture decode failed"));
    h.gate.failed(new Error("same render retried"));
    h.frame();
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect(h.presented).not.toHaveBeenCalled();
    h.gate.setAttempt("new"); h.gate.rendered(); h.frame();
    const stale = [...h.frames.values()][0];
    h.gate.dispose(); stale(0);
    expect(h.presented).not.toHaveBeenCalled();
  });

  it("does not label an absent grant or a later gameplay error as a join failure", () => {
    const h = harness();
    h.gate.failed(new Error("no grant"));
    h.gate.setAttempt("granted"); h.gate.rendered(); h.frame(); h.frame();
    h.gate.failed(new Error("later gameplay"));
    expect(h.failed).not.toHaveBeenCalled();
  });
});
