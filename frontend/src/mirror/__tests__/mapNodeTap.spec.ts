import { afterEach, describe, expect, it, vi } from "vitest";

import { createInputCapture, type InputCapture } from "@/mirror/inputCapture";
import { createMapNodeTapRouter, type MirrorActionMessage } from "@/mirror/mapNodeTap";
// M0: the map-point z-stack walk is the RENDERER's (mirrorRenderer.mapNodeAt / its DOM implementation). The router
// takes it as a collaborator, so these specs resolve with the same walk the live renderer hands it.
import { mapPointElementIdAt } from "@/mirror/mirrorRenderer";
import type { MirrorInputMessage } from "@/mirror/mirrorClient";

// R11 WS-M — tapping a map node on the mirror must TRAVEL. A coordinate click on a map point is ignored by the
// game, so a tap is routed as the `select-map-node` semantic action (a per-seat vote) addressed by the point's
// streamed scene-node id. These specs pin the three decisions the client owns: WHICH element a tap resolves to,
// WHEN the action is suppressed by an armed drawing tool, and that a routed touch tap emits no
// coordinate click.

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {}
  } as DOMRect;
}

// A z-stack (topmost first) of renderer-stamped elements, as elementsFromPoint would return them.
function stubStack(...specs: Array<{ sceneFile?: string; rootId?: string; block?: boolean; touchId?: string }>): void {
  const els = specs.map((spec) => {
    const el = document.createElement("div");
    if (spec.sceneFile != null) el.setAttribute("data-scene-file", spec.sceneFile);
    if (spec.rootId != null) el.setAttribute("data-scene-root-id", spec.rootId);
    if (spec.block) el.setAttribute("data-touch-block", "1");
    if (spec.touchId != null) el.setAttribute("data-touch-id", spec.touchId);
    return el;
  });
  (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => els;
}

const MAP_POINT = "res://scenes/ui/normal_map_point.tscn";

afterEach(() => {
  delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
});

describe("mapPointElementIdAt", () => {
  it("resolves the map point's SCENE ROOT id (the node's live instance id)", () => {
    // A finger lands on a DESCENDANT of the point (its icon); the root id is what the action must carry.
    stubStack({ sceneFile: MAP_POINT, rootId: "669410934510" });
    expect(mapPointElementIdAt(10, 10)).toBe("669410934510");
  });

  it("matches every map-point scene variant by file SUFFIX (normal / ancient / boss)", () => {
    for (const file of [
      "res://scenes/ui/normal_map_point.tscn",
      "res://scenes/ui/ancient_map_point.tscn",
      "res://scenes/ui/boss_map_point.tscn"
    ]) {
      stubStack({ sceneFile: file, rootId: "42" });
      expect(mapPointElementIdAt(10, 10)).toBe("42");
    }
  });

  it("returns null off a map point", () => {
    stubStack({ sceneFile: "res://scenes/ui/map_dot.tscn", rootId: "7" }, { sceneFile: "res://scenes/screens/map/map_screen.tscn", rootId: "1" });
    expect(mapPointElementIdAt(10, 10)).toBeNull();
  });

  it("stops at a blocking button drawn OVER the map (the button keeps its own tap)", () => {
    stubStack({ block: true }, { sceneFile: MAP_POINT, rootId: "669410934510" });
    expect(mapPointElementIdAt(10, 10)).toBeNull();
  });

  it("is inert without an elementsFromPoint implementation", () => {
    expect(mapPointElementIdAt(10, 10, {} as unknown as Document)).toBeNull();
  });
});

describe("createMapNodeTapRouter", () => {
  let sent: MirrorActionMessage[];

  beforeEach(() => {
    sent = [];
  });

  function router(drawingToolActive?: () => boolean) {
    return createMapNodeTapRouter({
      sendAction: (m) => sent.push(m),
      drawingToolActive,
      mapNodeAt: (x, y) => mapPointElementIdAt(x, y)
    });
  }

  it("sends select-map-node with the point's elementId and reports the tap consumed", () => {
    stubStack({ sceneFile: MAP_POINT, rootId: "669410934510" });
    expect(router()(10, 10)).toBe(true);
    expect(sent).toEqual([{ semanticActionId: "select-map-node", args: { elementId: "669410934510" } }]);
  });

  it("sends nothing (and does not consume the tap) off a map point", () => {
    stubStack({ sceneFile: "res://scenes/combat/draw_pile.tscn", rootId: "9" });
    expect(router()(10, 10)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("suppresses the action while a map DRAWING TOOL is armed (the tap is a stroke, not travel)", () => {
    stubStack({ sceneFile: MAP_POINT, rootId: "669410934510" });
    expect(router(() => true)(10, 10)).toBe(false);
    expect(sent).toEqual([]);
    // Putting the tool away re-enables travel with no reload.
    expect(router(() => false)(10, 10)).toBe(true);
    expect(sent).toHaveLength(1);
  });

});

describe("inputCapture — map-node tap routing", () => {
  let stage: HTMLElement;
  let sent: MirrorInputMessage[];
  let capture: InputCapture;
  let frames: FrameRequestCallback[];
  let routed: Array<{ x: number; y: number }>;
  let routeResult: boolean;

  function touchEvent(type: string, opts: { clientX: number; clientY: number; pointerId?: number }): MouseEvent {
    const ev = new MouseEvent(type, { button: 0, clientX: opts.clientX, clientY: opts.clientY, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "pointerType", { value: "touch" });
    Object.defineProperty(ev, "pointerId", { value: opts.pointerId ?? 1 });
    return ev;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    stage = document.createElement("div");
    document.body.appendChild(stage);
    stage.getBoundingClientRect = () => rect(0, 0, 960, 540);
    sent = [];
    routed = [];
    routeResult = true;
    capture = createInputCapture(
      stage,
      (message) => sent.push(message),
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      (x, y) => {
        routed.push({ x, y });
        return routeResult;
      }
    );
  });

  afterEach(() => {
    capture.dispose();
    vi.unstubAllGlobals();
  });

  it("a routed TOUCH tap emits NO coordinate click (only the down-edge hover)", () => {
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(routed).toEqual([{ x: 480, y: 270 }]);
    expect(sent.filter((m) => m.kind === "click")).toEqual([]);
    expect(sent).toEqual([{ kind: "hover", coordX: 960, coordY: 540 }]);
  });

  it("an UNROUTED touch tap still clicks (byte-identical to the pre-feature path)", () => {
    routeResult = false;
    stage.dispatchEvent(touchEvent("pointerdown", { clientX: 480, clientY: 270 }));
    stage.dispatchEvent(touchEvent("pointerup", { clientX: 480, clientY: 270 }));
    expect(sent.filter((m) => m.kind === "click")).toEqual([{ kind: "click", button: "left", coordX: 960, coordY: 540 }]);
  });

  it("a MOUSE click offers the tap to the router (keeping its press/release pair)", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(routed).toEqual([{ x: 480, y: 270 }]);
    // The press had already gone out when the gesture turned out to be a click, and swallowing the release would
    // leave the button stuck down in the game — so the (game-ignored) pair stays exactly as before.
    expect(sent.filter((m) => m.kind === "click")).toHaveLength(2);
  });

  it("a mouse DRAG (a map pan) is never offered as a tap", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    // 60 client px on a half-scale stage = 120 design px, far past the tap slop.
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 540, clientY: 270, bubbles: true }));
    expect(routed).toEqual([]);
  });

  it("a cancelled mouse gesture cannot route a later release", () => {
    stage.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointercancel", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX: 480, clientY: 270, bubbles: true }));
    expect(routed).toEqual([]);
  });
});
