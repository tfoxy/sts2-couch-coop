import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetGlContextEventsForTest,
  glContextEventsReport,
  installGlContextEventReporter
} from "@/mirror/glContextEvents";

// R7 W1 fix (d). WHAT WENT WRONG WITHOUT THIS. The one combat cell that completed on the device in round 6 had its
// GPU process killed MID-CELL and finished anyway — the canvas stage's context-loss handling worked. Nothing
// counted it, because the only gauge was a post-settle boolean that reads `false` once a context has been lost AND
// restored: indistinguishable from a context that never went. These are TRANSITIONS.
//
// And they are page-WIDE. When the GPU process dies every context on the page dies at once, including the gsw
// shader and particle runtimes' canvases — which on the DOM arm are the only ones there are — so a counter living
// inside one renderer describes a fraction of the event and cannot say whether the rest came back.

function fireOn(el: EventTarget, kind: string): void {
  el.dispatchEvent(new Event(kind, { bubbles: false, cancelable: true }));
}

describe("page-wide GL context event reporter", () => {
  beforeEach(() => {
    __resetGlContextEventsForTest();
    installGlContextEventReporter();
    document.body.innerHTML = "";
  });

  it("starts at a measured zero rather than an absent field", () => {
    const r = glContextEventsReport();
    expect(r.losses).toBe(0);
    expect(r.restores).toBe(0);
    expect(r.firstLossAtMs).toBeNull();
    expect(r.events).toEqual([]);
  });

  // THE CAPTURE-PHASE REQUIREMENT, pinned: `webglcontextlost` does NOT bubble, so a window listener registered in
  // the bubble phase would never see a canvas's event at all. This spec fails loudly if that option is dropped.
  it("sees a non-bubbling event on a canvas nested in the page", () => {
    const stage = document.createElement("div");
    const canvas = document.createElement("canvas");
    canvas.className = "mirror-canvas-stage";
    stage.appendChild(canvas);
    document.body.appendChild(stage);

    fireOn(canvas, "webglcontextlost");
    const r = glContextEventsReport();
    expect(r.losses).toBe(1);
    expect(r.events[0].kind).toBe("webglcontextlost");
    expect(r.events[0].target).toBe("canvas.mirror-canvas-stage");
    expect(r.firstLossAtMs).not.toBeNull();
  });

  // A canvas created AFTER the reporter was installed — which is every gsw effect canvas, since the runtimes mint
  // theirs lazily. A per-element listener set up at install time would miss all of them.
  it("sees canvases created after installation", () => {
    const later = document.createElement("canvas");
    document.body.appendChild(later);
    fireOn(later, "webglcontextlost");
    expect(glContextEventsReport().losses).toBe(1);
  });

  it("counts a loss and its restore separately, so recovery is visible", () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    fireOn(canvas, "webglcontextlost");
    fireOn(canvas, "webglcontextrestored");
    const r = glContextEventsReport();
    expect(r.losses).toBe(1);
    expect(r.restores).toBe(1);
    // The distinction the old boolean could not make: this page HAS lost a context, and has recovered.
    expect(r.losses).toBeGreaterThan(0);
  });

  // The reading that matters on a device: more losses than restores means something did not come back.
  it("leaves losses > restores when a context never returns", () => {
    const a = document.createElement("canvas");
    const b = document.createElement("canvas");
    document.body.append(a, b);
    fireOn(a, "webglcontextlost");
    fireOn(b, "webglcontextlost");
    fireOn(a, "webglcontextrestored");
    const r = glContextEventsReport();
    expect(r.losses).toBe(2);
    expect(r.restores).toBe(1);
  });

  it("keeps creation errors in their own bucket — a context never made is a different failure", () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    fireOn(canvas, "webglcontextcreationerror");
    const r = glContextEventsReport();
    expect(r.creationErrors).toBe(1);
    expect(r.losses).toBe(0);
  });

  // A page thrashing its contexts must not fill memory with the record of it. The COUNTERS keep counting; only
  // the event list is capped.
  it("caps the event list at 20 while the counters keep going", () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    for (let i = 0; i < 30; i++) fireOn(canvas, "webglcontextlost");
    const r = glContextEventsReport();
    expect(r.losses).toBe(30);
    expect(r.events).toHaveLength(20);
  });

  // Two mirror views on one page must not double-count every event.
  it("is idempotent to install", () => {
    installGlContextEventReporter();
    installGlContextEventReporter();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    fireOn(canvas, "webglcontextlost");
    expect(glContextEventsReport().losses).toBe(1);
  });

  // A REPORTER, not a policy. The arm that owns a canvas decides whether its loss is recoverable — a passive
  // observer that quietly consumed the event would be a defect wearing an instrument's clothes.
  it("never cancels the event it observes", () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const event = new Event("webglcontextlost", { bubbles: false, cancelable: true });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
