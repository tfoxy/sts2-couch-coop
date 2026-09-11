import { beforeEach, describe, expect, it } from "vitest";

import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta } from "@/mirror/sceneTree";

// M0 — the five RENDERER-OWNED input seams, on the DOM backend. The three z-stack probes are the walks the input
// modules used to run inline (their own specs still pin the semantics end-to-end through inputCapture /
// pointerMap / mapNodeTap); what is asserted here is that the renderer answers them, and the two eager-scroll
// seams, which are new code: the write goes to the element the id has NOW, and the read is the BAKED translation.

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function node(id: string, parentId: string | null, x: number, y: number): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 100 } },
    visible: true
  };
}

function build(renderer: MirrorRenderer, nodes: Record<string, unknown>[]): void {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: nodes,
      orderedIds: nodes.map((n) => n.id as string)
    })!
  );
  renderer.reconcile(state);
}

function el(stage: HTMLElement, id: string): HTMLElement {
  const found = stage.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  if (!found) throw new Error(`no element for ${id}`);
  return found;
}

let stage: HTMLElement;
let renderer: MirrorRenderer;

beforeEach(() => {
  document.body.innerHTML = "";
  ({ stage, renderer } = harness());
  build(renderer, [node("Root", null, 0, 0), node("Scroller", "Root", 100, 240)]);
});

describe("applyLocalOffset", () => {
  it("writes the cosmetic offset as the node's inline translate", () => {
    renderer.applyLocalOffset("Scroller", -128.456);
    expect(el(stage, "Scroller").style.translate).toBe("0px -128.46px");
  });

  it("writes the '0px' rest value at zero — the only spelling that survives a CSSOM round trip", () => {
    renderer.applyLocalOffset("Scroller", 12);
    renderer.applyLocalOffset("Scroller", 0);
    // Not "" and not "0px 0px": the gates around this READ the inline style back and compare against "0px".
    expect(el(stage, "Scroller").style.translate).toBe("0px");
  });

  it("is a no-op for an id the renderer no longer has — never a write to a recycled element", () => {
    expect(() => renderer.applyLocalOffset("GoneAway", 40)).not.toThrow();
    // The point of addressing by ID: a stale id resolves to nothing, where a stale ELEMENT could well resolve to
    // a pooled node the walk has since handed to somebody else.
    expect(el(stage, "Scroller").style.translate).toBe("");
  });
});

describe("scrollRenderedY", () => {
  it("reports the Y the walk BAKED into the node (not the streamed value, not the cosmetic offset)", () => {
    expect(renderer.scrollRenderedY("Scroller")).toBe(240);
    // A cosmetic offset is composed ON TOP of the base transform (CSS applies `translate` outside `transform`),
    // so it must not move this reading — that is exactly what makes `eagerY − renderedY` a stable quantity.
    renderer.applyLocalOffset("Scroller", -300);
    expect(renderer.scrollRenderedY("Scroller")).toBe(240);
  });

  it("is null for an unknown id, so the caller keeps its own streamed fallback", () => {
    expect(renderer.scrollRenderedY("GoneAway")).toBeNull();
  });
});

describe("the z-stack probes", () => {
  it("touchStackAt reports the widget stack, topmost first, stopping at a block", () => {
    const card = document.createElement("div");
    card.setAttribute("data-touch-id", "card-1");
    const button = document.createElement("div");
    button.setAttribute("data-touch-block", "bar");
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [card, button, card];
    expect(renderer.touchStackAt(10, 10)).toEqual({
      ids: ["card-1"],
      blocked: true,
      blockKind: "bar",
      topStamp: "other"
    });
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it("touchStackAt is inert where there is no hit test at all", () => {
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    expect(renderer.touchStackAt(10, 10)).toEqual({ ids: [], blocked: false, blockKind: null, topStamp: null });
  });

  it("spreadPainterAt skips backdrops wider than the caller's threshold and reports the first real painter", () => {
    const mk = (attrs: Record<string, string>, width: number): HTMLElement => {
      const div = document.createElement("div");
      for (const [k, v] of Object.entries(attrs)) div.setAttribute(k, v);
      div.getBoundingClientRect = () => ({ width }) as DOMRect;
      return div;
    };
    const backdrop = mk({ "data-node-id": "bg", "data-paints": "1", "data-spread-dx": "300" }, 960);
    const card = mk(
      { "data-node-id": "card", "data-paints": "1", "data-spread-dx": "240", "data-spread-mode": "prop" },
      200
    );
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [backdrop, card];
    expect(renderer.spreadPainterAt(10, 10, 912)).toEqual({ dx: 240, prop: true, widthPx: 200 });
    // Raise the threshold above the backdrop's width and IT becomes the anchor instead.
    expect(renderer.spreadPainterAt(10, 10, 1000)).toEqual({ dx: 300, prop: false, widthPx: 960 });
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it("spreadPainterAt says UNDEFINED (not null) where there is no hit test — the caller then maps identity", () => {
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    expect(renderer.spreadPainterAt(10, 10, 912)).toBeUndefined();
  });

  it("mapNodeAt resolves a map point's scene-root id", () => {
    const point = document.createElement("div");
    point.setAttribute("data-scene-file", "res://scenes/ui/normal_map_point.tscn");
    point.setAttribute("data-scene-root-id", "669410934510");
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [point];
    expect(renderer.mapNodeAt(10, 10)).toBe("669410934510");
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });
});
