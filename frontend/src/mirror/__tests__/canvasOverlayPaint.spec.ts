import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMirrorOverlay, type MirrorOverlay } from "@/mirror/canvas/overlay";
import { __setStillDecoderForTest, type StillDecoder } from "@/mirror/stillDecode";
import type { OverlayRecord } from "@/mirror/canvas/paintSpec";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode } from "@/mirror/sceneTree";
import type { MirrorShaderBinding } from "@/mirror/shaderAttributes";
import type { LoadedSpineClip } from "@/mirror/spineClip";

// THE OVERLAY'S PAINT INTEGRATION — the half of a Wave-2 surface that is not geometry.
//
// A DOM-backend node inherits `modulate.a` through the CSS opacity cascade and the composed tint through an
// inherited `filter`, because its element is NESTED inside its parent's. Every element this overlay builds is a
// FLAT child of one container, so both have to arrive on the record and be written here. These are the tests that
// say they do — plus the two rules that come with them: `mergedNodeStyle`'s "a WebGL host gets no filter", and the
// HOIST RULE that keeps a background VFX surface from being painted over the whole game.
//
// `nodeShaderAttributes` is mocked because the contract under test is what the overlay DOES with a binding, not
// whether gsw can resolve one: the real builder needs a resolvable material document, and a spec that had to
// synthesize one would be testing gsw's resolver.

const { shaderBindingMock } = vi.hoisted(() => ({ shaderBindingMock: vi.fn() }));
vi.mock("@/mirror/shaderAttributes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/shaderAttributes")>();
  return { ...actual, nodeShaderAttributes: (node: MirrorNode) => shaderBindingMock(node) };
});

// …and the CLIP CLIENT, for the same reason: it fetches + decodes over the network, and what the spine sections
// below test is what the overlay does with a clip. `frameIndexAt` / `msToNextSpineFrame` stay REAL — the deadline
// is the module's own playback math, and stubbing it would test nothing.
const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

let overlay: MirrorOverlay | null = null;

// SPINE SOURCE. These cases are about the RASTER lane — the `/spines/` request, its still/canvas paint
// mechanism and its clock. These cases pin the raster lane so their synchronous-fetch assertions stay isolated;
// the explicit delta experiment's fallback ordering is covered by domGeoclip.spec.ts / canvasGeoclip.spec.ts.
beforeEach(() => {
});

afterEach(() => {
  overlay?.dispose();
  overlay = null;
  document.body.innerHTML = "";
  shaderBindingMock.mockReset();
  __setStillDecoderForTest(null);
  vi.restoreAllMocks();
});

/** A stage with a stand-in canvas, which is all `createMirrorOverlay` needs to place its container after. */
function mountOverlay(): { stage: HTMLElement; container: HTMLElement } {
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  stage.appendChild(canvas);
  document.body.appendChild(stage);
  overlay = createMirrorOverlay(stage, canvas);
  return { stage, container: overlay.container };
}

/** Real `MirrorNode`s, through the real parser — the overlay reads node fields, so they must be wire-shaped. */
function nodesOf(specs: Array<Record<string, unknown>>): Map<string, MirrorNode> {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: specs.map((s) => s.id),
      upserts: specs
    })!
  );
  return state.nodes;
}

function wireNode(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId: null,
    name: id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 50 } },
    visible: true,
    ...over
  };
}

function record(over: Partial<OverlayRecord> = {}): OverlayRecord {
  return {
    id: "n",
    kind: "text",
    transform: [1, 0, 0, 1, 0, 0],
    w: 100,
    h: 50,
    order: 0,
    opacity: 1,
    tintR: 1,
    tintG: 1,
    tintB: 1,
    coveredAbove: false,
    clip: null,
    ...over
  };
}

function hostOf(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
}

const LABEL = wireNode("n", { nodeType: "Godot.Label", text: { text: "hi" } });
const SHADER = wireNode("fx", { nodeType: "Godot.ColorRect", fillColor: { r: 1, g: 1, b: 1, a: 1 } });

const WEBGL_BINDING: MirrorShaderBinding = {
  attributes: { "data-godot-shader-webgl": "1", "data-godot-shader-path": "res://shaders/card_ripple.gdshader" },
  style: { "mix-blend-mode": "plus-lighter" }
};

// THE PER-BUILD COSTS THIS MODULE PAYS, and what removes them without changing an outcome. `reconcile` runs on
// every draw-list build — which on a scroll gesture is every frame, with no new wire data at all — and it used to
// copy-and-sort the record list, mint a template-literal placement key per record, and rebuild + `JSON.stringify`
// a ~20-key style object per text record. These are the tests that say the cheaper answers are the SAME answers.
describe("the overlay's per-build work", () => {
  it("still sorts records the builder hands over out of order", () => {
    const { container } = mountOverlay();
    // The skip is gated on a scan, so an out-of-order list must take the sort. The builder emits in paint order
    // today; this is what stops the fast path from becoming a silent contract change if it ever stops.
    overlay!.reconcile(
      [record({ id: "b", order: 9 }), record({ id: "a", order: 1 })],
      nodesOf([wireNode("a", { text: { text: "a" } }), wireNode("b", { text: { text: "b" } })])
    );
    expect([...container.children].map((el) => el.getAttribute("data-node-id"))).toEqual(["a", "b"]);
  });

  it("keeps ties in the order the builder emitted them — the fast path must be stable too", () => {
    const { container } = mountOverlay();
    // `sort` is stable, so an equal-order run keeps its input order; skipping the sort has to agree. Two records
    // at the same paint index is not exotic — a 0x0 anchor and its sibling share one.
    overlay!.reconcile(
      [record({ id: "second", order: 4 }), record({ id: "first", order: 4 })],
      nodesOf([wireNode("first", { text: { text: "1" } }), wireNode("second", { text: { text: "2" } })])
    );
    expect([...container.children].map((el) => el.getAttribute("data-node-id"))).toEqual(["second", "first"]);
  });

  it("writes a placement only when the matrix or the box actually moved", () => {
    const { container } = mountOverlay();
    const nodes = nodesOf([LABEL]);
    overlay!.reconcile([record()], nodes);
    const host = hostOf(container, "n")!;
    expect(host.style.transform).toBe("matrix(1, 0, 0, 1, 0, 0)");

    // Vandalise the written style: an unmoved record must not restore it (no write at all), and a moved one must.
    host.style.transform = "matrix(9, 9, 9, 9, 9, 9)";
    overlay!.reconcile([record()], nodes);
    expect(host.style.transform).toBe("matrix(9, 9, 9, 9, 9, 9)");

    overlay!.reconcile([record({ transform: [1, 0, 0, 1, 0, 12] })], nodes);
    expect(host.style.transform).toBe("matrix(1, 0, 0, 1, 0, 12)");
  });

  it("notices a box that changed while the matrix did not — all eight numbers are compared", () => {
    const { container } = mountOverlay();
    const nodes = nodesOf([LABEL]);
    overlay!.reconcile([record()], nodes);
    const host = hostOf(container, "n")!;
    overlay!.reconcile([record({ w: 640 })], nodes);
    expect(host.style.width).toBe("640px");
  });

  it("rebuilds a text style only when the NODE changed identity, and never misses one that did", () => {
    const { container } = mountOverlay();
    const nodes = nodesOf([wireNode("n", { text: { text: "hi", textColor: { html: "#ff0000" } } })]);
    overlay!.reconcile([record()], nodes);
    const text = container.querySelector<HTMLElement>(".mirror-text")!;
    expect(text.style.color).toBe("rgb(255, 0, 0)");

    // The SAME node object across a rebuild — the scroll case, where nothing has come off the wire. Vandalising
    // the style proves no write happened rather than merely that the outcome matched.
    text.style.color = "rgb(1, 2, 3)";
    overlay!.reconcile([record()], nodes);
    expect(text.style.color).toBe("rgb(1, 2, 3)");

    // …and a genuinely new node object (what `mergeNode` produces for every upsert) is picked up. The cache is an
    // identity check, so this is the half that would break if a node were ever mutated in place instead.
    const recoloured = nodesOf([wireNode("n", { text: { text: "hi", textColor: { html: "#00ff00" } } })]);
    overlay!.reconcile([record()], recoloured);
    expect(text.style.color).toBe("rgb(0, 255, 0)");
  });
});

// M4's lifecycle, which is the TRAIL shape rather than the fx or spine one. A gsw host must survive being drawn
// (the runtime renders INTO it) and a spine element IS the pixels the quad uploads from — but a label's raster
// comes from a scratch canvas the overlay never sees, so a drawn label's element has no job at all and is
// dropped outright.
describe("the overlay under canvas text", () => {
  const TWO_LABELS = [wireNode("a", { text: { text: "one" } }), wireNode("b", { text: { text: "two" } })];
  const records = [record({ id: "a" }), record({ id: "b", order: 1 })];

  it("drops a label the canvas painted — no element, so nothing is composited twice", () => {
    const { container } = mountOverlay();
    overlay!.setTextDrawn(new Set(["a"]));
    overlay!.reconcile(records, nodesOf(TWO_LABELS));
    expect(hostOf(container, "a")).toBeNull();
    expect(hostOf(container, "b")).not.toBeNull();
  });

  it("DESTROYS the element a label had last build once the canvas takes it over", () => {
    // The sweep does this for free: an element the build did not name is removed by `syncOrder`. What this pins
    // is that the label does not linger for a frame painting the same words above the whole stage.
    const { container } = mountOverlay();
    const nodes = nodesOf(TWO_LABELS);
    overlay!.reconcile(records, nodes);
    expect(hostOf(container, "a")).not.toBeNull();
    overlay!.setTextDrawn(new Set(["a"]));
    overlay!.reconcile(records, nodes);
    expect(hostOf(container, "a")).toBeNull();
  });

  it("gives a REFUSED label its element back", () => {
    // A label can stop being canvas-drawn — a re-raster the pacer holds back, a digest that changed. The element
    // has to come back, or the lever could lose a label.
    const { container } = mountOverlay();
    const nodes = nodesOf(TWO_LABELS);
    overlay!.setTextDrawn(new Set(["a"]));
    overlay!.reconcile(records, nodes);
    overlay!.setTextDrawn(new Set<string>());
    overlay!.reconcile(records, nodes);
    expect(hostOf(container, "a")).not.toBeNull();
    expect(hostOf(container, "a")!.textContent).toBe("one");
  });

  it("counts the residue, and still counts a drawn label under its KIND", () => {
    // `text` keeps meaning "how many text records this build had", exactly as `withheld` is counted in its kind.
    // `textHoisted` is the half the canvas did not take.
    const { container } = mountOverlay();
    overlay!.setTextDrawn(new Set(["a"]));
    const out = overlay!.reconcile(records, nodesOf(TWO_LABELS));
    expect(out.counts.text).toBe(2);
    expect(out.counts.textHoisted).toBe(1);
    expect(container.children).toHaveLength(1);
  });

  it("counts NOTHING hoisted with the lever off — a null drawn set is the pre-M4 path verbatim", () => {
    const { container } = mountOverlay();
    const out = overlay!.reconcile(records, nodesOf(TWO_LABELS));
    expect(out.counts.textHoisted).toBe(0);
    expect(container.children).toHaveLength(2);
  });
});

describe("the overlay's composed alpha cascade", () => {
  it("writes the record's composed opacity onto the host", () => {
    const { container } = mountOverlay();
    overlay!.reconcile([record({ opacity: 0.251 })], nodesOf([LABEL]));
    // The DOM twin: `nodeStyle` always emits `opacity`, and the ancestor half of it reaches the element through
    // the nesting. A flat overlay element has no ancestor to inherit from, so the composed value is written here
    // — without it a debug label the game shows at a quarter alpha painted at full white.
    expect(hostOf(container, "n")!.style.opacity).toBe("0.251");
  });

  it("re-writes opacity when it changes and leaves it alone when it does not", () => {
    const { container } = mountOverlay();
    const nodes = nodesOf([LABEL]);
    overlay!.reconcile([record({ opacity: 1 })], nodes);
    const host = hostOf(container, "n")!;
    const spy = vi.spyOn(host.style, "setProperty");
    overlay!.reconcile([record({ opacity: 1 })], nodes);
    const unchanged = spy.mock.calls.length;
    overlay!.reconcile([record({ opacity: 0.5 })], nodes);
    expect(host.style.opacity).toBe("0.5");
    // The write is diffed, so an unmoved surface costs compares rather than style writes.
    expect(spy.mock.calls.length).toBe(unchanged);
  });

  it("renders a non-white composed tint as an feColorMatrix the host references", () => {
    const { stage, container } = mountOverlay();
    overlay!.reconcile([record({ tintR: 0.5, tintG: 0.2, tintB: 1 })], nodesOf([LABEL]));
    const host = hostOf(container, "n")!;
    // jsdom quotes a url() token on read-back, so the id is matched rather than the whole serialization.
    expect(host.style.filter).toContain("mtint-25_10_50");
    // The <defs> hangs off the STAGE: `syncOrder` sweeps every container child the build did not name.
    const filter = stage.querySelector("filter#mtint-25_10_50");
    expect(filter).not.toBeNull();
    expect(filter!.querySelector("feColorMatrix")!.getAttribute("values")).toBe(
      "0.5 0 0 0 0 0 0.2 0 0 0 0 0 1 0 0 0 0 0 1 0"
    );
  });

  it("builds no <defs> at all for a white tint", () => {
    const { stage, container } = mountOverlay();
    overlay!.reconcile([record()], nodesOf([LABEL]));
    expect(hostOf(container, "n")!.style.filter).toBe("");
    // Across the whole standard recording set not one overlay record carries a non-white composed tint, so the
    // registry must cost nothing on the screens we actually ship.
    expect(stage.querySelector("svg")).toBeNull();
  });
});

describe("the overlay's shader binding style", () => {
  it("PRESERVES binding.style — an additive material stays additive", () => {
    const { container } = mountOverlay();
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    overlay!.reconcile([record({ id: "fx", kind: "shader" })], nodesOf([SHADER]));
    const host = hostOf(container, "fx")!;
    // `assignMaterialAttributes` puts a CanvasItemMaterial's ADD blend in `binding.style`. Dropping it (which
    // this module used to do) silently downgraded every additive surface to source-over.
    expect(host.style.getPropertyValue("mix-blend-mode")).toBe("plus-lighter");
    expect(host.getAttribute("data-godot-shader-webgl")).toBe("1");
  });

  it("gives a WebGL host NO filter, tint included — gsw feeds the modulate into the shader itself", () => {
    const { container } = mountOverlay();
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    overlay!.reconcile([record({ id: "fx", kind: "shader", tintR: 0.5, tintG: 0.5, tintB: 0.5 })], nodesOf([SHADER]));
    // `mergedNodeStyle`'s rule verbatim: `delete merged.filter` for a `data-godot-shader-webgl` node.
    expect(hostOf(container, "fx")!.style.filter).toBe("");
  });

  it("composes a NON-WebGL binding's own filter before the composed tint", () => {
    const { container } = mountOverlay();
    shaderBindingMock.mockReturnValue({ attributes: {}, style: { filter: "url(#mhsv-1)" } });
    overlay!.reconcile([record({ id: "fx", kind: "shader", tintR: 0.5, tintG: 0.5, tintB: 0.5 })], nodesOf([SHADER]));
    // The shader's own filter first, the composed tint after — `mergedNodeStyle`'s order.
    expect(hostOf(container, "fx")!.style.filter).toMatch(/mhsv-1.*mtint-25_25_25/);
  });

  it("drops a style the binding stopped carrying", () => {
    const { container } = mountOverlay();
    const nodes = nodesOf([SHADER]);
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    overlay!.reconcile([record({ id: "fx", kind: "shader" })], nodes);
    shaderBindingMock.mockReturnValue({ attributes: { "data-godot-shader-webgl": "1" }, style: {} });
    overlay!.reconcile([record({ id: "fx", kind: "shader" })], nodes);
    expect(hostOf(container, "fx")!.style.getPropertyValue("mix-blend-mode")).toBe("");
  });
});

describe("the HOIST RULE", () => {
  it("withholds a shader surface the game paints over, and counts it", () => {
    const { container } = mountOverlay();
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const result = overlay!.reconcile(
      [record({ id: "fx", kind: "shader", coveredAbove: true })],
      nodesOf([SHADER])
    );
    // No element ⇒ gsw never binds a runtime here ⇒ the node renders exactly as it does under `?shaders=off`.
    // The alternative is what the bug looked like: a background VFX layer, or an additive card glow, hoisted
    // above the entire canvas.
    expect(hostOf(container, "fx")).toBeNull();
    expect(result.counts.shader).toBe(1);
    expect(result.counts.withheld).toBe(1);
    expect(result.counts.elements).toBe(0);
  });

  it("hoists the same surface when nothing paints over it", () => {
    const { container } = mountOverlay();
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const result = overlay!.reconcile(
      [record({ id: "fx", kind: "shader", coveredAbove: false })],
      nodesOf([SHADER])
    );
    expect(hostOf(container, "fx")).not.toBeNull();
    expect(result.counts.withheld).toBe(0);
  });

  it("SWEEPS a surface that was hoisted and then became covered", () => {
    const { container } = mountOverlay();
    const nodes = nodesOf([SHADER]);
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    overlay!.reconcile([record({ id: "fx", kind: "shader" })], nodes);
    expect(hostOf(container, "fx")).not.toBeNull();
    const after = overlay!.reconcile([record({ id: "fx", kind: "shader", coveredAbove: true })], nodes);
    expect(hostOf(container, "fx")).toBeNull();
    // A teardown detaches whatever gsw had bound, so both runtimes have to re-scan.
    expect(after.shaderDirty).toBe(true);
  });

  it("never withholds text — that would blank a label the DOM stage draws", () => {
    const { container } = mountOverlay();
    const result = overlay!.reconcile([record({ coveredAbove: true })], nodesOf([LABEL]));
    // Text is a DOM overlay on BOTH backends; its overlay-vs-canvas gap is the pre-registered P6 divergence and
    // is not this rule's business.
    expect(hostOf(container, "n")).not.toBeNull();
    expect(result.counts.withheld).toBe(0);
  });
});

// --- THE RESIDUAL CENSUS -----------------------------------------------------------------------------------
//
// `withheld` says what the hoist rule HID. Nothing said what it could not hide — a label or a creature still
// compositing above the whole canvas with the game painting over it, which is the divergence the whole canvas
// stage is measured against. These pin that row, and specifically pin that it distinguishes "hoisted" from
// "hoisted AND wrong": a hoisted label with nothing on top of it is drawn correctly and must read 0.
describe("the covered-and-hoisted residual census", () => {
  it("counts a label the game paints over, and only that one", () => {
    mountOverlay();
    const covered = overlay!.reconcile([record({ coveredAbove: true })], nodesOf([LABEL]));
    expect(covered.counts.coveredText).toBe(1);
    expect(covered.counts.coveredSpine).toBe(0);
  });

  it("reads 0 for a hoisted label with nothing above it", () => {
    mountOverlay();
    // The distinction that makes the row worth having: this label IS hoisted, and it is nonetheless correct.
    const clear = overlay!.reconcile([record({ coveredAbove: false })], nodesOf([LABEL]));
    expect(clear.counts.coveredText).toBe(0);
  });

  it("does not count a covered fx host, because the hoist rule already hid it", () => {
    mountOverlay();
    const fx = overlay!.reconcile([record({ id: "fx", kind: "shader", coveredAbove: true })], nodesOf([SHADER]));
    // Its number is `withheld` (or `fxHidden` under M2); double-counting it here would make the residual row a
    // sum of two unrelated facts, which is the mistake `fxHidden` itself had to be split to fix.
    expect(fx.counts.coveredText + fx.counts.coveredSpine).toBe(0);
    expect(fx.counts.withheld).toBe(1);
  });
});

// --- M2 -----------------------------------------------------------------------------------------------------
//
// The draw list paints the shader/particle surfaces itself now, so this module's job for those two kinds inverts.
// PRESENCE of the third `reconcile` argument is the flag — nothing else in here reads a URL.

const PARTICLES = wireNode("ps", { nodeType: "Godot.GPUParticles2D", particles: { spec: { amount: 4 }, emitting: true } });

/**
 * An `OverlayFxSource`. `drawn` is the set the BUILD put quads in; `declined` is the registry's refusals.
 * Defaults to "the surface was drawn", which is the steady state the flag exists to produce.
 */
function fxOf(opts: { drawn?: string[]; declined?: string[] } = {}): {
  declined(id: string): boolean;
  drawn(id: string): boolean;
} {
  const declined = new Set(opts.declined ?? []);
  const drawn = opts.drawn === undefined ? null : new Set(opts.drawn);
  return { declined: (id) => declined.has(id), drawn: (id) => (drawn === null ? true : drawn.has(id)) };
}

describe("the overlay with in-canvas effects", () => {
  it("keeps a COVERED shader surface the draw list painted — the hoist rule has nothing left to decide", () => {
    const { container } = mountOverlay();
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const result = overlay!.reconcile([record({ id: "fx", kind: "shader", coveredAbove: true })], nodesOf([SHADER]), fxOf());
    // The element STAYS: it is what gsw discovers, binds and renders into, and it is where the attributes live.
    // Only its compositing stops. `withheld` going to 0 while keeping its meaning is M2's acceptance number.
    expect(hostOf(container, "fx")).not.toBeNull();
    expect(result.counts.withheld).toBe(0);
    expect(result.counts.shader).toBe(1);
  });

  it("hides the host so gsw's canvas stops compositing above the whole stage", () => {
    const { container } = mountOverlay();
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const result = overlay!.reconcile([record({ id: "fx", kind: "shader" })], nodesOf([SHADER]), fxOf());
    const host = hostOf(container, "fx")!;
    // `visibility` and NOT `display: none`: gsw sizes its canvas from `selfLayer.clientWidth`, which a
    // display-none host reports as 0 — every surface would collapse to nothing. Hidden preserves layout, keeps
    // the ResizeObserver alive, and does not stop the runtime rendering (its loop gates on dormancy attributes).
    expect(host.style.visibility).toBe("hidden");
    expect(host.style.display).toBe("");
    expect(result.counts.fxHidden).toBe(1);
  });

  it("hides a particle host too, and never the container", () => {
    const { container } = mountOverlay();
    const result = overlay!.reconcile([record({ id: "ps", kind: "particles" })], nodesOf([PARTICLES]), fxOf());
    expect(hostOf(container, "ps")!.style.visibility).toBe("hidden");
    // The container carries the TEXT of the whole screen. Hiding it would blank every label on the stage.
    expect(container.style.visibility).toBe("");
    expect(result.counts.fxHidden).toBe(1);
  });

  it("SHOWS an un-drawn surface nothing covers — turning the flag on must never LOSE an effect", () => {
    const { container } = mountOverlay();
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    // No quad yet (gsw has not drawn it, or the governor has not uploaded its first frame) and nothing paints
    // over it. Flag-OFF hoists this surface and that hoist is CORRECT, so the flag must not hide it — otherwise
    // an effect the DOM arm shows would go missing on the canvas arm, which is the one regression M2 cannot have.
    const result = overlay!.reconcile(
      [record({ id: "fx", kind: "shader", coveredAbove: false })],
      nodesOf([SHADER]),
      fxOf({ drawn: [] })
    );
    expect(hostOf(container, "fx")!.style.visibility).toBe("");
    expect(result.counts.fxHidden).toBe(0);
    expect(result.counts.withheld).toBe(0);
  });

  it("hides an un-drawn surface that IS covered, and keeps counting it withheld", () => {
    const { container } = mountOverlay();
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const result = overlay!.reconcile(
      [record({ id: "fx", kind: "shader", coveredAbove: true })],
      nodesOf([SHADER]),
      fxOf({ drawn: [] })
    );
    // Flag-off withholds this one outright, so hiding it shows the same nothing — but the ELEMENT stays, which is
    // the whole difference: withholding it would deadlock the fix (no element ⇒ gsw never renders ⇒ no pixels ⇒
    // no quad ⇒ withheld forever). The counter keeps its old meaning and now measures the residue.
    expect(hostOf(container, "fx")).not.toBeNull();
    expect(hostOf(container, "fx")!.style.visibility).toBe("hidden");
    expect(result.counts.withheld).toBe(1);
    expect(result.counts.fxHidden).toBe(1);
  });

  it("leaves text and spine hosts visible — they have no gsw surface to upload", () => {
    const { container } = mountOverlay();
    const result = overlay!.reconcile([record({ id: "n", kind: "text" })], nodesOf([LABEL]), fxOf());
    expect(hostOf(container, "n")!.style.visibility).toBe("");
    expect(result.counts.fxHidden).toBe(0);
  });

  it("DROPS a surface the registry refused, and counts it apart from a withholding", () => {
    const { container } = mountOverlay();
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const result = overlay!.reconcile(
      [record({ id: "fx", kind: "shader" })],
      nodesOf([SHADER]),
      fxOf({ declined: ["fx"] })
    );
    // A refused surface (a SCREEN_TEXTURE reader, an over-MAX_TEXTURE_SIZE source) will never get a quad, so
    // keeping its host would leave gsw compositing a full-screen canvas above the stage — the original bug,
    // reintroduced by its own fix. Dropped like a withholding; counted as something else, because a policy
    // refusal is a different fact and `withheld` is the number M2 is judged on.
    expect(hostOf(container, "fx")).toBeNull();
    expect(result.counts.fxDeclined).toBe(1);
    expect(result.counts.withheld).toBe(0);
    expect(result.counts.shader).toBe(1);
  });

  it("SWEEPS a host whose surface became refused", () => {
    const { container } = mountOverlay();
    const nodes = nodesOf([SHADER]);
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    // The refusal is only knowable AFTER the first frame (gsw reports `usesScreenTexture` with a render), so the
    // host legitimately exists for a build or two first.
    overlay!.reconcile([record({ id: "fx", kind: "shader" })], nodes, fxOf());
    expect(hostOf(container, "fx")).not.toBeNull();
    const after = overlay!.reconcile([record({ id: "fx", kind: "shader" })], nodes, fxOf({ declined: ["fx"] }));
    expect(hostOf(container, "fx")).toBeNull();
    expect(after.shaderDirty).toBe(true);
  });

  it("is entirely inert without the argument — the hoist rule is back and nothing is hidden", () => {
    const { container } = mountOverlay();
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const covered = overlay!.reconcile([record({ id: "fx", kind: "shader", coveredAbove: true })], nodesOf([SHADER]));
    expect(hostOf(container, "fx")).toBeNull();
    expect(covered.counts.withheld).toBe(1);
    expect(covered.counts.fxHidden).toBe(0);
    expect(covered.counts.fxDeclined).toBe(0);

    const uncovered = overlay!.reconcile([record({ id: "fx", kind: "shader" })], nodesOf([SHADER]));
    expect(hostOf(container, "fx")!.style.visibility).toBe("");
    expect(uncovered.counts.fxHidden).toBe(0);
  });

  it("restores a host's visibility if the flag stops being passed", () => {
    const { container } = mountOverlay();
    const nodes = nodesOf([SHADER]);
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    overlay!.reconcile([record({ id: "fx", kind: "shader" })], nodes, fxOf());
    expect(hostOf(container, "fx")!.style.visibility).toBe("hidden");
    // `syncHostStyle` diffs against its last write and REMOVES what the next one does not carry, so the flag is
    // reversible on a live element rather than only at construction.
    overlay!.reconcile([record({ id: "fx", kind: "shader" })], nodes);
    expect(hostOf(container, "fx")!.style.visibility).toBe("");
  });
});


// --- spine clip LIFETIME + the decode gate (M3, A1) ---------------------------------------------------------
//
// Two latent bugs, fixed together because they are the same fact seen twice: this module was painting pixels it
// did not own.
//
//   1. IT RELEASED WITHOUT RETAINING. `LoadedSpineClip`'s refcount exists so an LRU eviction cannot close
//      ImageBitmaps (or revoke object urls) the renderer is still painting. Our count rested at ZERO, so every
//      clip on screen was one eviction away from a permanently blank creature — latent only because the pools
//      (24 clips / 64 stills) are bigger than a screen.
//   2. IT SWAPPED WITHOUT DECODING. `img.src = <fresh blob url>` on a live element drops the old bitmap at once
//      and Chromium's raster is lazy, so a creature's animation change flashed it invisible — with the NEW
//      placement already written over the OLD pixels for the interim. `stillDecode` is the DOM backend's fix.
//
// Neither changes a single float. What they change is WHEN pixels commit, and whether they survive.
describe("the overlay's spine clip lifetime", () => {
  const CREATURE = wireNode("sp", {
    nodeType: "SpineSprite",
    spine: { sceneResPath: "res://creature.tscn", nodePath: "Sprite" },
    spineCurrentAnim: "idle"
  });

  interface Counted extends LoadedSpineClip {
    refs: () => number;
  }

  /** A clip that COUNTS its own retain/release, which is the whole of what is under test. */
  function countedClip(over: Partial<LoadedSpineClip> = {}): Counted {
    let refs = 0;
    const bitmap = { close() {} } as unknown as ImageBitmap;
    return {
      canvasWidth: 100,
      canvasHeight: 100,
      totalDurationMs: 100,
      localX: -10,
      localY: -20,
      localWidth: 100,
      localHeight: 100,
      frames: [
        { index: 0, offsetX: 3, offsetY: 4, width: 40, height: 60, durationMs: 100, startMs: 0, png: new Uint8Array(), bitmap }
      ],
      stillUrl: "blob:still-a",
      degraded: false,
      retain() {
        refs += 1;
      },
      release() {
        refs = Math.max(0, refs - 1);
      },
      dispose() {},
      refs: () => refs,
      ...over
    } as Counted;
  }

  /** A decoder a test drives by hand: `settle()` is where the swap is allowed to commit. */
  function manualDecoder(): { urls: string[]; settle: () => number } {
    const pending: Array<() => void> = [];
    const urls: string[] = [];
    const decoder: StillDecoder = (url, ready) => {
      urls.push(url);
      pending.push(() => ready(true));
    };
    __setStillDecoderForTest(decoder);
    return {
      urls,
      settle() {
        const run = pending.splice(0, pending.length);
        for (const r of run) r();
        return run.length;
      }
    };
  }

  function spineRecord(): OverlayRecord {
    return record({ id: "sp", kind: "spine", w: 0, h: 0 });
  }

  async function reconcileSpine(node: Record<string, unknown> = CREATURE): Promise<void> {
    overlay!.reconcile([spineRecord()], nodesOf([node]));
    await Promise.resolve();
    await Promise.resolve();
  }

  it("RETAINS the clip it paints, and releases it exactly once on teardown", async () => {
    const clip = countedClip();
    loadSpineClipMock.mockResolvedValue(clip);
    __setStillDecoderForTest((_url, ready) => ready(true)); // synchronous, so the commit lands inline
    const { container } = mountOverlay();
    await reconcileSpine();

    // Two references: the clip being PAINTED, and the still whose object url is on screen. Both are real — the
    // second outlives a clip swap, which is exactly when the first goes away.
    expect(clip.refs()).toBe(2);
    expect(container.querySelector("img.mirror-spine-img")).not.toBeNull();

    overlay!.dispose();
    overlay = null;
    expect(clip.refs()).toBe(0);
  });

  it("never lets the count go NEGATIVE when a load resolves into a stale generation", async () => {
    // A newer clip won the race. The old code released a clip this entry had never retained, which after the
    // pairing fix would decrement a reference another entry owns — and close bitmaps out from under it.
    const stale = countedClip();
    const fresh = countedClip({ stillUrl: "blob:still-b" });
    let resolveStale: (c: LoadedSpineClip) => void = () => {};
    loadSpineClipMock.mockImplementationOnce(() => new Promise<LoadedSpineClip>((r) => (resolveStale = r)));
    loadSpineClipMock.mockResolvedValue(fresh);
    __setStillDecoderForTest((_url, ready) => ready(true));
    mountOverlay();

    await reconcileSpine();
    // The node's anim changes before the first load lands, so the entry moves to a new url + generation.
    await reconcileSpine({ ...CREATURE, spineCurrentAnim: "attack" });
    resolveStale(stale);
    await Promise.resolve();
    await Promise.resolve();

    expect(stale.refs()).toBe(0);
    expect(fresh.refs()).toBeGreaterThan(0);
  });

  it("does not swap the <img> until the new pixels have DECODED", async () => {
    const first = countedClip();
    loadSpineClipMock.mockResolvedValue(first);
    const decoder = manualDecoder();
    const { container } = mountOverlay();
    await reconcileSpine();

    // The decode is in flight: no element yet, and — the point — no half-written placement either.
    expect(decoder.urls).toEqual(["blob:still-a"]);
    expect(container.querySelector("img.mirror-spine-img")).toBeNull();

    decoder.settle();
    const img = container.querySelector<HTMLImageElement>("img.mirror-spine-img")!;
    expect(img.getAttribute("src")).toBe("blob:still-a");
    // Geometry and pixels land TOGETHER, so the element never shows new geometry on old pixels.
    expect(img.style.width).toBe("40px");
    expect(img.style.transform).toBe("translate(-7px, -16px) scale(1)");
  });

  it("keeps the OLD frame on screen for the whole of the next decode", async () => {
    loadSpineClipMock.mockResolvedValue(countedClip());
    __setStillDecoderForTest((_url, ready) => ready(true));
    const { container } = mountOverlay();
    await reconcileSpine();
    const img = container.querySelector<HTMLImageElement>("img.mirror-spine-img")!;
    expect(img.getAttribute("src")).toBe("blob:still-a");

    // idle → attack. This is the transition that flashed the creature invisible.
    const decoder = manualDecoder();
    loadSpineClipMock.mockResolvedValue(countedClip({ stillUrl: "blob:still-b", frames: [
      { index: 0, offsetX: 0, offsetY: 0, width: 80, height: 90, durationMs: 100, startMs: 0, png: new Uint8Array(), bitmap: null }
    ] }));
    await reconcileSpine({ ...CREATURE, spineCurrentAnim: "attack" });

    expect(decoder.urls).toEqual(["blob:still-b"]);
    expect(img.getAttribute("src")).toBe("blob:still-a"); // still painting the old pose
    expect(img.style.width).toBe("40px"); // …at the OLD size

    decoder.settle();
    expect(img.getAttribute("src")).toBe("blob:still-b");
    expect(img.style.width).toBe("80px");
  });

  it("DEDUPES an in-flight decode rather than starting a probe per reconcile", async () => {
    loadSpineClipMock.mockResolvedValue(countedClip());
    const decoder = manualDecoder();
    mountOverlay();
    await reconcileSpine();
    await reconcileSpine();
    await reconcileSpine();
    // `mountSpine` is re-entered on every reconcile; a probe apiece would multiply decodes on the busiest frames.
    expect(decoder.urls).toEqual(["blob:still-a"]);
  });

  it("DROPS a commit whose entry moved on while the decode ran", async () => {
    loadSpineClipMock.mockResolvedValue(countedClip());
    const decoder = manualDecoder();
    const { container } = mountOverlay();
    await reconcileSpine();

    // The node goes away before the decode lands. Committing here would resurrect an element for a dead entry.
    overlay!.reconcile([], nodesOf([CREATURE]));
    decoder.settle();
    expect(container.querySelector("img.mirror-spine-img")).toBeNull();
  });

  it("FAILS OPEN where the environment has no decode at all", async () => {
    // jsdom and old WebViews have no `HTMLImageElement.decode`. The real `decodeStill` passes through
    // SYNCHRONOUSLY there, so the commit runs inline and the gate is behaviourally invisible — a gate that could
    // silently never fire would freeze a creature on a stale pose forever, which is worse than the flicker.
    loadSpineClipMock.mockResolvedValue(countedClip());
    __setStillDecoderForTest(null); // the production decoder, against jsdom's <img>
    const { container } = mountOverlay();
    await reconcileSpine();
    expect(container.querySelector<HTMLImageElement>("img.mirror-spine-img")?.getAttribute("src")).toBe("blob:still-a");
  });

  it("reports onSpineReady ONCE per committed still, and never for a stale one", async () => {
    const ready = vi.fn();
    loadSpineClipMock.mockResolvedValue(countedClip());
    __setStillDecoderForTest((_url, cb) => cb(true));
    const stage = document.createElement("div");
    const canvas = document.createElement("canvas");
    stage.appendChild(canvas);
    document.body.appendChild(stage);
    overlay = createMirrorOverlay(stage, canvas, { onSpineReady: ready });

    await reconcileSpine();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith("sp");

    // A re-reconcile of the SAME clip is a placement write, not a commit.
    await reconcileSpine();
    expect(ready).toHaveBeenCalledTimes(1);
  });
});

// --- the spine demand source (M3) --------------------------------------------------------------------------------
//
// `nextSpineDeadline` is one of the canvas stage's three park inputs, and until M3 it was a boolean in disguise:
// `nowMs + 33` for any playing clip. The renderer only asked whether that was finite, so a playing creature
// repainted the whole stage at the display's rate against a 15fps bake. These are the tests that say it now
// answers a real timestamp, and — the load-bearing half — that it can still reach Infinity.
describe("the overlay's spine deadline", () => {
  const CREATURE = wireNode("sp", {
    nodeType: "SpineSprite",
    spine: { sceneResPath: "res://creature.tscn", nodePath: "Sprite" },
    spineCurrentAnim: "idle"
  });

  function clipOf(frames: number, durationMs = 100): LoadedSpineClip {
    const bitmap = { close() {} } as unknown as ImageBitmap;
    return {
      canvasWidth: 100,
      canvasHeight: 100,
      totalDurationMs: frames * durationMs,
      localX: 0,
      localY: 0,
      localWidth: 100,
      localHeight: 100,
      frames: Array.from({ length: frames }, (_, i) => ({
        index: i,
        offsetX: 0,
        offsetY: 0,
        width: 10,
        height: 10,
        durationMs,
        startMs: i * durationMs,
        png: new Uint8Array(),
        bitmap
      })),
      stillUrl: frames === 1 ? "blob:still" : null,
      degraded: false,
      retain() {},
      release() {},
      dispose() {}
    };
  }

  /**
   * The mount instant, PINNED. The overlay seeds a clip's playback clock from `performance.now()`, so a test that
   * read the wall clock a millisecond later would be asserting the machine's scheduling jitter rather than the
   * deadline algebra.
   */
  const T0 = 10_000;

  function pinClock(): void {
    vi.spyOn(performance, "now").mockReturnValue(T0);
  }

  /** Reconcile once and let the mocked clip load land, so the entry is in the playing set. */
  async function mountClip(clip: LoadedSpineClip, over: Record<string, unknown> = {}): Promise<void> {
    loadSpineClipMock.mockResolvedValue(clip);
    pinClock();
    mountOverlay();
    overlay!.reconcile([record({ id: "sp", kind: "spine", w: 0, h: 0 })], nodesOf([{ ...CREATURE, ...over }]));
    await Promise.resolve();
    await Promise.resolve();
  }

  it("answers Infinity with nothing mounted at all", () => {
    mountOverlay();
    expect(overlay!.nextSpineDeadline(1000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("answers Infinity for a STILL — the product default, and the case that must park", async () => {
    // History: counting a still as playing kept the stage at 23fps for thirty seconds of combat. The playing-set
    // counter already excludes them; this says the deadline agrees rather than depending on that.
    await mountClip(clipOf(1));
    expect(overlay!.nextSpineDeadline(5000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("answers the clip's REAL next-frame time, not a fixed frame interval", async () => {
    // 100ms frames. Mounting seeds the playback clock at `performance.now()` with track time 0, so at the mount
    // instant the next boundary is a whole frame away — and 40ms later, 60ms away.
    await mountClip(clipOf(3));
    expect(overlay!.nextSpineDeadline(T0)).toBe(T0 + 100);
    expect(overlay!.nextSpineDeadline(T0 + 40)).toBe(T0 + 100);
    expect(overlay!.nextSpineDeadline(T0 + 99)).toBe(T0 + 100);
    // …and past the boundary it is the NEXT one, not a fixed interval from now.
    expect(overlay!.nextSpineDeadline(T0 + 100)).toBe(T0 + 200);
  });

  it("answers Infinity for a CLAMPED one-shot that has run out", async () => {
    // A landed attack holds its final pose forever. It is still in the playing set (multi-frame, not paused), so
    // before M3 it kept the stage awake for the rest of the screen.
    await mountClip(clipOf(3), { spineLooping: false });
    expect(overlay!.nextSpineDeadline(T0)).toBe(T0 + 100);
    expect(overlay!.nextSpineDeadline(T0 + 5000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("takes the MINIMUM over the playing set", async () => {
    loadSpineClipMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes("fast") ? clipOf(3, 40) : clipOf(3, 100))
    );
    pinClock();
    mountOverlay();
    overlay!.reconcile(
      [
        record({ id: "slow", kind: "spine", w: 0, h: 0, order: 0 }),
        record({ id: "fast", kind: "spine", w: 0, h: 0, order: 1 })
      ],
      nodesOf([
        { ...CREATURE, id: "slow" },
        { ...CREATURE, id: "fast", spine: { sceneResPath: "res://fast.tscn", nodePath: "Sprite" } }
      ])
    );
    await Promise.resolve();
    await Promise.resolve();
    // The 40ms clip is what the stage has to wake for; the 100ms one rides that wakeup.
    expect(overlay!.nextSpineDeadline(T0)).toBe(T0 + 40);
  });

  it("HOLDS for a paused track — the game froze it, so no frame is owed", async () => {
    await mountClip(clipOf(3), { spinePaused: true });
    expect(overlay!.nextSpineDeadline(T0 + 10_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("schedules the loop boundary before the endpoint sample", async () => {
    await mountClip({ ...clipOf(3), totalDurationMs: 400 });
    // The loop period is the final frame start (200ms), so 250ms of playback is 50ms into the loop and the next
    // boundary is frame 1's start.
    expect(overlay!.nextSpineDeadline(T0 + 250)).toBe(T0 + 250 + 50);
  });
});

// --- what the overlay PUBLISHES for the stage to quad (M3 A2) --------------------------------------------------
//
// The quad's pixels are the overlay's own decoded `<img>`, and its geometry is the rect the overlay wrote onto
// that element. So the contract here is: publish only what is genuinely ON SCREEN, and describe it in the node's
// own coordinates so the caller composes rather than re-derives.
describe("the overlay's spine quad source", () => {
  const CREATURE = wireNode("sp", {
    nodeType: "SpineSprite",
    spine: { sceneResPath: "res://creature.tscn", nodePath: "Sprite" },
    spineCurrentAnim: "idle"
  });

  function stillClip(over: Partial<LoadedSpineClip> = {}): LoadedSpineClip {
    return {
      canvasWidth: 50,
      canvasHeight: 50,
      totalDurationMs: 100,
      localX: -10,
      localY: -20,
      localWidth: 100,
      localHeight: 100,
      frames: [
        { index: 0, offsetX: 3, offsetY: 4, width: 40, height: 60, durationMs: 100, startMs: 0, png: new Uint8Array(), bitmap: null }
      ],
      stillUrl: "blob:still-a",
      degraded: false,
      retain() {},
      release() {},
      dispose() {},
      ...over
    };
  }

  async function mountStillClip(clip: LoadedSpineClip): Promise<{ container: HTMLElement }> {
    loadSpineClipMock.mockResolvedValue(clip);
    __setStillDecoderForTest((_url, ready) => ready(true));
    const mounted = mountOverlay();
    overlay!.reconcile([record({ id: "sp", kind: "spine", w: 0, h: 0 })], nodesOf([CREATURE]));
    await Promise.resolve();
    await Promise.resolve();
    return mounted;
  }

  it("publishes nothing before a still has COMMITTED", async () => {
    loadSpineClipMock.mockResolvedValue(stillClip());
    // A decode that never settles: the pixels are not on screen, so there is nothing to quad and the node stays
    // hoisted — which is the pre-A2 behaviour and the safe direction at every step of this path.
    __setStillDecoderForTest(() => {});
    mountOverlay();
    overlay!.reconcile([record({ id: "sp", kind: "spine", w: 0, h: 0 })], nodesOf([CREATURE]));
    await Promise.resolve();
    await Promise.resolve();
    expect(overlay!.spineQuads().size).toBe(0);
  });

  it("publishes the still's NODE-LOCAL rect, which the caller composes rather than re-derives", async () => {
    const { container } = await mountStillClip(stillClip());
    const quad = overlay!.spineQuads().get("sp")!;
    expect(quad).toBeDefined();
    expect(quad.clipUrl).toBe("blob:still-a");
    expect(quad.frameW).toBe(40);
    expect(quad.frameH).toBe(60);
    // scale = localWidth / canvasWidth = 100/50 = 2; tx = localX + offsetX*scale = -10 + 6.
    expect(quad.scale).toBe(2);
    expect(quad.tx).toBe(-4);
    expect(quad.ty).toBe(-12);
    // …and the SAME numbers are on the element, which is what makes the two arms agree by construction.
    const img = container.querySelector<HTMLImageElement>("img.mirror-spine-img")!;
    expect(img.style.transform).toBe("translate(-4px, -12px) scale(2)");
    expect(quad.source).toBe(img);
  });

  it("publishes NOTHING for a multi-frame clip — the animating path is never quadded", async () => {
    const multi = stillClip({
      stillUrl: null,
      frames: [
        { index: 0, offsetX: 0, offsetY: 0, width: 10, height: 10, durationMs: 50, startMs: 0, png: new Uint8Array(), bitmap: null },
        { index: 1, offsetX: 0, offsetY: 0, width: 10, height: 10, durationMs: 50, startMs: 50, png: new Uint8Array(), bitmap: null }
      ]
    });
    await mountStillClip(multi);
    expect(overlay!.spineQuads().size).toBe(0);
  });

  it("hides the host of a spine the DRAW LIST painted, and only that one", async () => {
    const { container } = await mountStillClip(stillClip());
    const host = hostOf(container, "sp")!;
    expect(host.style.visibility).toBe("");

    overlay!.setSpineDrawn(new Set(["sp"]));
    overlay!.reconcile([record({ id: "sp", kind: "spine", w: 0, h: 0 })], nodesOf([CREATURE]));
    // Compositing the `<img>` a second time above the whole stage is the exact layering the quad exists to end.
    expect(hostOf(container, "sp")!.style.visibility).toBe("hidden");

    // …and a build that did NOT draw it puts the creature straight back. There is no state where it is neither.
    overlay!.setSpineDrawn(new Set());
    overlay!.reconcile([record({ id: "sp", kind: "spine", w: 0, h: 0 })], nodesOf([CREATURE]));
    expect(hostOf(container, "sp")!.style.visibility).toBe("");
  });
});
