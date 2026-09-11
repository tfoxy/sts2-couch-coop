import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {

  createMirrorRenderer,
  mirrorWalkStats,
  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// R10-B3 ELEMENT ADOPTION across pooled-node recycling.
//
// STS2 recycles its NCard visual pool by FREEING a card's shell and RE-INSTANTIATING it, so a card moving between
// piles reaches the mirror as "remove ~28 Godot instance ids / add ~28 different ones" for what the viewer sees as
// the same card. The reconciler used to answer with a full subtree teardown + rebuild, which (because gsw keys its
// WebGL shader bindings by HTMLElement) disposed and recreated every shader binding under the card — each rebuild
// paying a `syncCanvasSize` forced layout.
//
// With adoption, a removed record carrying a content-stable ADOPT KEY is CONDEMNED for the rest of the walk, and a
// node added in that same walk with a matching key takes it over: same element, same canvases, same style caches,
// same tween pins. These specs drive the renderer through the exact wire deltas the producer emits and assert the
// identity, the re-stamping, the guards, and the teardown invariants.

const NCARD = "MegaCrit.Sts2.Core.Nodes.Cards.NCard";

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}

function box(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function node(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: xform(0, 0),
    localRect: box(100, 16),
    visible: true,
    ...over
  };
}

// One pooled card SHELL: an NCard root carrying the producer's stable `contentKey`, plus the named descendants a
// real card has (the ones whose elements must survive a recycle).
function cardShell(
  idPrefix: string,
  parentId: string,
  contentKey: string,
  over: Record<string, unknown> = {}
): Record<string, unknown>[] {
  return [
    {
      ...node(`${idPrefix}`, parentId, { name: "Card", nodeType: NCARD, contentKey, mouseFilter: 0 }),
      ...over
    },
    node(`${idPrefix}-cc`, `${idPrefix}`, { name: "CardContainer" }),
    node(`${idPrefix}-title`, `${idPrefix}-cc`, { name: "TitleLabel" }),
    node(`${idPrefix}-art`, `${idPrefix}-cc`, {
      name: "Portrait",
      // A textureRegion + textureUrl leaf paints through the atlas <canvas> sub-layer — the per-record DOM whose
      // survival is the whole point of adoption.
      texture: { resourcePath: "res://images/atlas.png", resourceType: "Texture2D" },
      textureRegion: { position: { x: 0, y: 0 }, size: { x: 32, y: 32 } }
    })
  ];
}

function cardIds(idPrefix: string): string[] {
  return [`${idPrefix}`, `${idPrefix}-cc`, `${idPrefix}-title`, `${idPrefix}-art`];
}

// Inert filler so the scene is big enough for a card recycle to stay on the INCREMENTAL structural path. The
// walk BAILS to a full walk when the STRUCTURAL churn of a delta — order-dirty parents + derived removals + adds
// (see BAIL_ORDER_CHURN_RATIO / BAIL_MIN_ORDER_CHURN in mirrorRenderer) — exceeds max(8, 15% of the scene). A
// 4-node card swap is 3 dirty parents + 4 removals + 4 adds = 11, which would swamp any toy scene and silently
// test only the full path; at this size the 15% ratio governs (~16) with room for the two-card swaps below.
// Real combat is ~680 nodes, i.e. a threshold of ~102 against the same 11 — this is the faithful regime.
const FILLER_COUNT = 100;
function filler(): Record<string, unknown>[] {
  return Array.from({ length: FILLER_COUNT }, (_, i) => node(`f${i}`, "root", { name: `F${i}` }));
}
function fillerIds(): string[] {
  return Array.from({ length: FILLER_COUNT }, (_, i) => `f${i}`);
}

function keyframe(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!
  );
}

// A NON-full structural delta — the wire shape of an add / remove / reparent (orderedIds always present).
function structural(
  state: MirrorState,
  parts: { upserts?: Record<string, unknown>[]; removedIds?: string[]; orderedIds: string[] }
): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts: parts.upserts ?? [],
      removedIds: parts.removedIds ?? [],
      orderedIds: parts.orderedIds
    })!
  );
}

function el(stage: HTMLElement, id: string): HTMLElement | null {
  return stage.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
}

// gsw's WebGL runtime disposes exactly the bindings whose node ELEMENT is no longer among
// `root.querySelectorAll("[data-godot-shader-webgl]")` (see godot-scene-web packages/html/src/webgl/runtime.ts,
// `reconcile`). jsdom has no WebGL2 so the runtime itself no-ops here; this reproduces its dispose criterion
// verbatim over the real DOM the reconciler produced, which is the strongest statement available in-process.
function shaderElements(stage: HTMLElement): HTMLElement[] {
  return [...stage.querySelectorAll<HTMLElement>("[data-godot-shader-webgl]")];
}

// The stage-attached elements the mirror owns — used to prove no condemned element is left detached OR attached
// after a walk.
function mirrorNodeCount(stage: HTMLElement): number {
  return stage.querySelectorAll(".mirror-node").length;
}

let created: MirrorRenderer[] = [];

beforeEach(() => {
  mirrorWalkStats.reset();
});

afterEach(() => {
  for (const r of created) {
    r.dispose();
  }
  created = [];
  document.body.innerHTML = "";
});

function build(): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
  const { stage, renderer } = harness();
  created.push(renderer);
  const state = createMirrorState();
  keyframe(
    state,
    [node("root", null, { name: "Root" }), node("hand", "root", { name: "Hand" }), ...filler(), ...cardShell("a", "hand", "nc:strike#1")],
    ["root", "hand", ...fillerIds(), ...cardIds("a")]
  );
  renderer.reconcile(state);
  return { stage, renderer, state };
}

// The pool swap: the SAME walk removes shell `a` and adds shell `b` carrying the same contentKey.
function swap(
  state: MirrorState,
  renderer: MirrorRenderer,
  from: string,
  to: string,
  contentKey: string
): void {
  structural(state, {
    removedIds: cardIds(from),
    upserts: cardShell(to, "hand", contentKey),
    orderedIds: ["root", "hand", ...fillerIds(), ...cardIds(to)]
  });
  renderer.reconcile(state);
}

describe("element adoption across a pooled-shell recycle", () => {
  it("keeps the SAME elements when a shell is re-instantiated under new instance ids", () => {
    const { stage, renderer, state } = build();
    const before = cardIds("a").map((id) => el(stage, id));
    expect(before.every((e) => e !== null)).toBe(true);
    // Stage C: the unbaked sprite's paint layer is the page-crop placeholder div (jsdom never bakes a blob).
    const canvasBefore = before[3]!.querySelector(".mirror-atlas-page");
    expect(canvasBefore).not.toBeNull();

    const createdBefore = mirrorWalkStats.createEl;
    swap(state, renderer, "a", "b", "nc:strike#1");

    const after = cardIds("b").map((id) => el(stage, id));
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBe(before[i]); // element IDENTITY, not just an equal-looking element
    }
    // The atlas sprite sub-layer (and every other per-record DOM) rode along with the record.
    expect(after[3]!.querySelector(".mirror-atlas-page")).toBe(canvasBefore);
    // The recycle really did take the INCREMENTAL structural path (the one a live card play takes) — not the
    // full-walk fallback, which the "full-walk parity" suite covers separately.
    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(1);
    expect(mirrorWalkStats.bails).toBe(0);
    expect(mirrorWalkStats.adoptions).toBe(4);
    expect(mirrorWalkStats.createEl).toBe(createdBefore); // zero element creations for a whole-card recycle
    // The old ids are gone from the DOM (the elements were re-keyed, not duplicated).
    for (const id of cardIds("a")) {
      expect(el(stage, id)).toBeNull();
    }
  });

  it("leaves gsw's shader-binding element set untouched across the recycle", () => {
    const { stage, renderer } = harness();
    created.push(renderer);
    const state = createMirrorState();
    const withShader = (prefix: string, key: string): Record<string, unknown>[] => {
      const shell = cardShell(prefix, "hand", key);
      shell[2] = node(`${prefix}-title`, `${prefix}-cc`, {
        name: "TitleLabel",
        texture: { resourcePath: "res://images/card.png", resourceType: "Texture2D" },
        shader: { resourcePath: "res://shaders/card_ripple.gdshader", resourceType: "Shader" },
        shaderParameters: [{ name: "width", kind: "number", number: 0.075 }]
      });
      return shell;
    };
    keyframe(
      state,
      [node("root", null, { name: "Root" }), node("hand", "root", { name: "Hand" }), ...filler(), ...withShader("a", "nc:strike#1")],
      ["root", "hand", ...fillerIds(), ...cardIds("a")]
    );
    renderer.reconcile(state);
    const shadersBefore = shaderElements(stage);
    expect(shadersBefore.length).toBe(1);

    structural(state, {
      removedIds: cardIds("a"),
      upserts: withShader("b", "nc:strike#1"),
      orderedIds: ["root", "hand", ...fillerIds(), ...cardIds("b")]
    });
    renderer.reconcile(state);

    const shadersAfter = shaderElements(stage);
    // Same element objects ⇒ gsw's `present.has(node)` holds for every binding ⇒ nothing is disposed, nothing is
    // created, and no binding pays a fresh syncCanvasSize forced layout.
    expect(shadersAfter).toEqual(shadersBefore);
    expect(shadersAfter[0]).toBe(shadersBefore[0]);
  });

  it("re-stamps every id-derived attribute on the adopted element", () => {
    const { stage, renderer, state } = build();
    const cardEl = el(stage, "a")!;
    const titleEl = el(stage, "a-title")!;
    expect(titleEl.getAttribute("data-touch-id")).toBe("a"); // the owning NCard's id

    swap(state, renderer, "a", "b", "nc:strike#1");

    expect(cardEl.getAttribute("data-node-id")).toBe("b");
    expect(cardEl.getAttribute("data-node-path")).toBe("Root/Hand/Card");
    expect(titleEl.getAttribute("data-node-id")).toBe("b-title");
    expect(titleEl.getAttribute("data-node-path")).toBe("Root/Hand/Card/CardContainer/TitleLabel");
    // The touch scan embeds the OWNING widget's id — the whole reason the re-stamp is not optional.
    expect(titleEl.getAttribute("data-touch-id")).toBe("b");
  });

  it("re-stamps the scene attributes and drops stale ones", () => {
    const { stage, renderer } = harness();
    created.push(renderer);
    const state = createMirrorState();
    const withScene = (prefix: string): Record<string, unknown>[] => {
      const shell = cardShell(prefix, "hand", "nc:strike#1");
      shell[0] = {
        ...node(prefix, "hand", { name: "Card", nodeType: NCARD, mouseFilter: 0, contentKey: "nc:strike#1" }),
        sceneFilePath: "res://cards/card.tscn"
      };
      return shell;
    };
    keyframe(
      state,
      [node("root", null, { name: "Root" }), node("hand", "root", { name: "Hand" }), ...filler(), ...withScene("a")],
      ["root", "hand", ...fillerIds(), ...cardIds("a")]
    );
    renderer.reconcile(state);
    const titleEl = el(stage, "a-title")!;
    expect(titleEl.getAttribute("data-scene-root-id")).toBe("a");

    structural(state, {
      removedIds: cardIds("a"),
      upserts: withScene("b"),
      orderedIds: ["root", "hand", ...fillerIds(), ...cardIds("b")]
    });
    renderer.reconcile(state);

    expect(titleEl.getAttribute("data-scene-root-id")).toBe("b");
    expect(titleEl.getAttribute("data-scene-file")).toBe("res://cards/card.tscn");
    expect(titleEl.getAttribute("data-scene-node-path")).toBe("CardContainer/TitleLabel");
  });

  it("re-styles the adopted node against its new streamed data", () => {
    const { stage, renderer, state } = build();
    const cardEl = el(stage, "a")!;

    structural(state, {
      removedIds: cardIds("a"),
      upserts: cardShell("b", "hand", "nc:strike#1", { transform: xform(400, 90) }),
      orderedIds: ["root", "hand", ...fillerIds(), ...cardIds("b")]
    });
    renderer.reconcile(state);

    expect(cardEl.style.transform).toContain("400");
    expect(cardEl.style.transform).toContain("90");
  });
});

describe("adoption guards", () => {
  it("never steals from a record whose node is still in the scene", () => {
    const { stage, renderer } = harness();
    created.push(renderer);
    const state = createMirrorState();
    keyframe(
      state,
      [node("root", null, { name: "Root" }), node("hand", "root", { name: "Hand" }), ...filler(), ...cardShell("a", "hand", "nc:strike#1")],
      ["root", "hand", ...fillerIds(), ...cardIds("a")]
    );
    renderer.reconcile(state);
    const aEl = el(stage, "a")!;

    // Shell `b` ADDS a second node with the SAME content key while `a` is still alive (a defensive case: the
    // producer allocates a per-model serial precisely so this cannot happen, but a duplicate key must never let
    // one live card rip the element out of another).
    structural(state, {
      upserts: cardShell("b", "hand", "nc:strike#1"),
      orderedIds: ["root", "hand", ...fillerIds(), ...cardIds("a"), ...cardIds("b")]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.adoptions).toBe(0);
    expect(el(stage, "a")).toBe(aEl); // untouched
    expect(el(stage, "b")).not.toBeNull();
    expect(el(stage, "b")).not.toBe(aEl);
  });

  it("does not let two cards of the same definition trade elements (distinct serials)", () => {
    const { stage, renderer } = harness();
    created.push(renderer);
    const state = createMirrorState();
    keyframe(
      state,
      [
        node("root", null, { name: "Root" }),
        node("hand", "root", { name: "Hand" }),
        ...cardShell("a", "hand", "nc:strike#1"),
        ...cardShell("b", "hand", "nc:strike#2")
      ],
      ["root", "hand", ...fillerIds(), ...cardIds("a"), ...cardIds("b")]
    );
    renderer.reconcile(state);
    const bEl = el(stage, "b")!;

    // Play the FIRST Strike: its shell is freed, and a new shell arrives for the SECOND Strike's redraw. The keys
    // differ by serial, so the newcomer must NOT claim the departing card's element.
    structural(state, {
      removedIds: cardIds("a"),
      upserts: cardShell("c", "hand", "nc:strike#3"),
      orderedIds: ["root", "hand", ...fillerIds(), ...cardIds("b"), ...cardIds("c")]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.adoptions).toBe(0);
    expect(el(stage, "b")).toBe(bEl);
    expect(el(stage, "c")).not.toBe(bEl);
    for (const id of cardIds("a")) {
      expect(el(stage, id)).toBeNull();
    }
  });

  it("never adopts across a node-type change", () => {
    const { stage, renderer, state } = build();
    const aEl = el(stage, "a")!;
    const swapped = cardShell("b", "hand", "nc:strike#1");
    swapped[0] = node("b", "hand", { name: "Card", nodeType: "MegaCrit.Sts2.Core.Nodes.NRelic", contentKey: "nc:strike#1" });

    structural(state, {
      removedIds: cardIds("a"),
      upserts: swapped,
      orderedIds: ["root", "hand", ...fillerIds(), ...cardIds("b")]
    });
    renderer.reconcile(state);

    expect(el(stage, "b")).not.toBe(aEl);
    expect(mirrorWalkStats.adoptions).toBe(3); // the three descendants still adopt; the mismatched root does not
  });

  it("never adopts through an auto-generated Godot name", () => {
    const { stage, renderer } = harness();
    created.push(renderer);
    const state = createMirrorState();
    const autoShell = (prefix: string): Record<string, unknown>[] => [
      node(prefix, "hand", { name: "Card", nodeType: NCARD, contentKey: "nc:strike#1" }),
      node(`${prefix}-auto`, prefix, { name: "@Control@1619" }),
      node(`${prefix}-leaf`, `${prefix}-auto`, { name: "TitleLabel" })
    ];
    const ids = (p: string) => [p, `${p}-auto`, `${p}-leaf`];
    keyframe(
      state,
      [node("root", null, { name: "Root" }), node("hand", "root", { name: "Hand" }), ...filler(), ...autoShell("a")],
      ["root", "hand", ...fillerIds(), ...ids("a")]
    );
    renderer.reconcile(state);
    const rootEl = el(stage, "a")!;
    const autoEl = el(stage, "a-auto")!;
    const leafEl = el(stage, "a-leaf")!;

    structural(state, {
      removedIds: ids("a"),
      upserts: autoShell("b"),
      orderedIds: ["root", "hand", ...fillerIds(), ...ids("b")]
    });
    renderer.reconcile(state);

    // The contentKey root adopts; the auto-named child cannot (its name carries no identity), and the scope is
    // CLOSED below it — so the leaf under it cannot either.
    expect(el(stage, "b")).toBe(rootEl);
    expect(el(stage, "b-auto")).not.toBe(autoEl);
    expect(el(stage, "b-leaf")).not.toBe(leafEl);
    expect(mirrorWalkStats.adoptions).toBe(1);
  });

  it("does not adopt across walks (a condemned record lives for exactly one walk)", () => {
    const { stage, renderer, state } = build();
    const aEl = el(stage, "a")!;

    // Walk 1: the shell leaves.
    structural(state, { removedIds: cardIds("a"), orderedIds: ["root", "hand", ...fillerIds()] });
    renderer.reconcile(state);
    expect(el(stage, "a")).toBeNull();
    expect(aEl.isConnected).toBe(false);
    expect(mirrorWalkStats.condemnedSwept).toBe(4);

    // Walk 2: the content comes back — too late, the elements are already gone.
    structural(state, {
      upserts: cardShell("b", "hand", "nc:strike#1"),
      orderedIds: ["root", "hand", ...fillerIds(), ...cardIds("b")]
    });
    renderer.reconcile(state);
    expect(mirrorWalkStats.adoptions).toBe(0);
    expect(el(stage, "b")).not.toBe(aEl);
  });
});

describe("condemned-pool teardown invariants", () => {
  it("sweeps unclaimed condemned records before the walk returns", () => {
    const { stage, renderer, state } = build();
    const before = mirrorNodeCount(stage);
    const aEls = cardIds("a").map((id) => el(stage, id)!);

    structural(state, { removedIds: cardIds("a"), orderedIds: ["root", "hand", ...fillerIds()] });
    renderer.reconcile(state);

    expect(mirrorNodeCount(stage)).toBe(before - 4);
    for (const e of aEls) {
      expect(e.isConnected).toBe(false);
    }
    expect(mirrorWalkStats.condemnedSwept).toBe(4);
    expect(mirrorWalkStats.removedRecords).toBe(4); // swept records still count as torn down
  });

  it("adopts the survivors and sweeps only the leftovers when a shell shrinks", () => {
    const { stage, renderer, state } = build();
    const titleEl = el(stage, "a-title")!;
    const artEl = el(stage, "a-art")!;

    // The replacement shell has no Portrait: three of the four elements are adopted, the fourth is swept.
    structural(state, {
      removedIds: cardIds("a"),
      upserts: [
        node("b", "hand", { name: "Card", nodeType: NCARD, contentKey: "nc:strike#1", mouseFilter: 0 }),
        node("b-cc", "b", { name: "CardContainer" }),
        node("b-title", "b-cc", { name: "TitleLabel" })
      ],
      orderedIds: ["root", "hand", ...fillerIds(), "b", "b-cc", "b-title"]
    });
    renderer.reconcile(state);

    expect(el(stage, "b-title")).toBe(titleEl);
    expect(artEl.isConnected).toBe(false);
    expect(mirrorWalkStats.adoptions).toBe(3);
    expect(mirrorWalkStats.condemnedSwept).toBe(1);
  });

  it("keeps DOM order correct after a recycle", () => {
    const { stage, renderer } = harness();
    created.push(renderer);
    const state = createMirrorState();
    keyframe(
      state,
      [
        node("root", null, { name: "Root" }),
        node("hand", "root", { name: "Hand" }),
        ...filler(),
        ...cardShell("a", "hand", "nc:strike#1"),
        ...cardShell("z", "hand", "nc:bash#1")
      ],
      ["root", "hand", ...fillerIds(), ...cardIds("a"), ...cardIds("z")]
    );
    renderer.reconcile(state);

    // `a` is recycled into `b` and re-inserted BEFORE `z` — the reorder pass must still see a clean DOM.
    structural(state, {
      removedIds: cardIds("a"),
      upserts: cardShell("b", "hand", "nc:strike#1"),
      orderedIds: ["root", "hand", ...fillerIds(), ...cardIds("b"), ...cardIds("z")]
    });
    renderer.reconcile(state);

    const handEl = el(stage, "hand")!;
    const kids = [...handEl.children].map((c) => c.getAttribute("data-node-id"));
    expect(kids).toEqual(["b", "z"]);
    expect(mirrorWalkStats.fixupWalks).toBe(0);
  });
});

describe("adoption carries the record's live state", () => {
  it("keeps a live transform-tween pin across the recycle", () => {
    const { stage, renderer, state } = build();
    const cardEl = el(stage, "a")!;

    // Arm a transform tween on the card, then recycle its shell in the very next delta.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        hints: [
          { targetId: "a", property: "position", durationMs: 5000, trans: "Cubic", ease: "Out", endTransform: [1, 0, 0, 1, 900, 20] }
        ]
      })!
    );
    renderer.reconcile(state);
    expect(cardEl.style.transition).toContain("transform");
    const pinned = cardEl.style.transform;

    swap(state, renderer, "a", "b", "nc:strike#1");

    // The record (and with it activeTweens membership + the pinned endpoint) rode along, so the walk did NOT
    // rewrite the element back to the streamed transform mid-tween.
    expect(mirrorWalkStats.adoptions).toBe(4);
    expect(cardEl.style.transform).toBe(pinned);
    expect(cardEl.style.transition).toContain("transform");
  });

  it("keeps an armed hide-latch across the recycle", () => {
    // The hide latch lives entirely on the RECORD (hideLatchedUntil / hideLatchRestingSig), so adoption must carry
    // it: a card whose disappear-fade just settled must stay clamped at 0 through the producer's resting-alpha
    // pre-hide drain even if the shell is recycled in between (otherwise the recycle reintroduces the flash).
    let clock = 0;
    let rafCb: FrameRequestCallback | null = null;
    let timers: { id: number; at: number; cb: () => void }[] = [];
    let nextTimerId = 1;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      rafCb = null;
    });
    vi.stubGlobal("setTimeout", (cb: () => void, ms?: number) => {
      const id = nextTimerId++;
      timers.push({ id, at: clock + (ms ?? 0), cb });
      return id;
    });
    vi.stubGlobal("clearTimeout", (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    });
    const flushRaf = (atMs: number): void => {
      clock = atMs;
      for (let guard = 0; guard < 8; guard++) {
        const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
        if (due.length === 0) break;
        timers = timers.filter((t) => t.at > clock);
        for (const t of due) t.cb();
      }
      const cb = rafCb;
      rafCb = null;
      cb?.(atMs);
    };

    try {
      // A resting modulate.a < 1 so the element really carries an `opacity` write (the channel the latch clamps).
      const resting = { modulate: { r: 1, g: 1, b: 1, a: 0.75, html: "#ffffff" } };
      const { stage, renderer } = harness();
      created.push(renderer);
      const state = createMirrorState();
      keyframe(
        state,
        [
          node("root", null, { name: "Root" }),
          node("hand", "root", { name: "Hand" }),
          ...filler(),
          ...cardShell("a", "hand", "nc:strike#1", resting)
        ],
        ["root", "hand", ...fillerIds(), ...cardIds("a")]
      );
      renderer.reconcile(state);
      const cardEl = el(stage, "a")!;
      expect(cardEl.style.opacity).toBe("0.75");

      applySceneDelta(
        state,
        parseSceneDelta({
          type: "scene-delta",
          full: false,
          screenType: "run",
          hints: [{ targetId: "a", property: "modulate:a", durationMs: 200, trans: "Cubic", ease: "Out", endOpacity: 0 }]
        })!
      );
      renderer.reconcile(state);
      expect(cardEl.style.opacity).toBe("0");
      flushRaf(210); // the fade settles → the latch arms

      // The recycle lands INSIDE the latch's grace window, carrying the producer's resting alpha.
      clock = 220;
      structural(state, {
        removedIds: cardIds("a"),
        upserts: cardShell("b", "hand", "nc:strike#1", resting),
        orderedIds: ["root", "hand", ...fillerIds(), ...cardIds("b")]
      });
      renderer.reconcile(state);
      expect(mirrorWalkStats.adoptions).toBe(4);
      expect(cardEl.style.opacity).toBe("0"); // still clamped — the latch rode along with the record
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("migrates the occlusion gate so an adopted element can still be revealed", () => {
    const { stage, renderer } = harness();
    created.push(renderer);
    const state = createMirrorState();
    // A full-stage opaque cover painted AFTER the hand gates everything below it.
    const cover = (visible: boolean) =>
      node("cover", "root", {
        name: "Cover",
        localRect: box(1920, 1080),
        fillColor: { r: 0, g: 0, b: 0, a: 1 },
        mouseFilter: 0,
        visible
      });
    keyframe(
      state,
      [
        node("root", null, { name: "Root" }),
        node("hand", "root", { name: "Hand" }),
        ...filler(),
        ...cardShell("a", "hand", "nc:strike#1"),
        cover(true)
      ],
      ["root", "hand", ...fillerIds(), ...cardIds("a"), "cover"]
    );
    // The gate engages with hysteresis (OCCLUSION_ENGAGE_WALKS walks in a row).
    for (let i = 0; i < 4; i++) {
      renderer.reconcile(state);
    }
    const handEl = el(stage, "hand")!;
    expect(handEl.style.display).toBe("none");

    // Recycle the card underneath the cover, then lift the cover: the gate must release the adopted subtree.
    structural(state, {
      removedIds: cardIds("a"),
      upserts: cardShell("b", "hand", "nc:strike#1"),
      orderedIds: ["root", "hand", ...fillerIds(), ...cardIds("b"), "cover"]
    });
    renderer.reconcile(state);
    expect(mirrorWalkStats.adoptions).toBe(4);
    applySceneDelta(
      state,
      parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: [cover(false)] })!
    );
    renderer.reconcile(state);
    expect(handEl.style.display).toBe("");
  });
});

describe("full-walk parity", () => {
  it("adopts on the FULL (keyframe) path too", () => {
    const { stage, renderer, state } = build();
    const aEls = cardIds("a").map((id) => el(stage, id)!);
    const createdBefore = mirrorWalkStats.createEl;

    // A keyframe re-establishes the whole scene: the pooled shell arrives under new ids in the same walk that
    // retires the old ones (which the full path prunes AFTER the visits — hence the up-front condemn).
    keyframe(
      state,
      [node("root", null, { name: "Root" }), node("hand", "root", { name: "Hand" }), ...filler(), ...cardShell("b", "hand", "nc:strike#1")],
      ["root", "hand", ...fillerIds(), ...cardIds("b")]
    );
    renderer.reconcile(state);

    expect(mirrorWalkStats.fullWalks).toBeGreaterThan(0);
    expect(mirrorWalkStats.adoptions).toBe(4);
    expect(mirrorWalkStats.createEl).toBe(createdBefore);
    for (let i = 0; i < aEls.length; i++) {
      expect(el(stage, cardIds("b")[i])).toBe(aEls[i]);
    }
  });

  it("sweeps unclaimed condemned records on the FULL path", () => {
    const { stage, renderer, state } = build();
    const aEls = cardIds("a").map((id) => el(stage, id)!);

    keyframe(state, [node("root", null, { name: "Root" }), node("hand", "root", { name: "Hand" }), ...filler()], ["root", "hand", ...fillerIds()]);
    renderer.reconcile(state);

    for (const e of aEls) {
      expect(e.isConnected).toBe(false);
    }
    expect(mirrorWalkStats.condemnedSwept).toBe(4);
    expect(mirrorNodeCount(stage)).toBe(2 + FILLER_COUNT);
  });
});

// R10-PERF5 WS-1 — dormancy interaction, from this file's angle: the pool's teardown invariant ("no condemned
// element outlives its walk") must hold when the re-add lands somewhere DORMANT and therefore declines adoption.
describe("a recycle whose destination is a dormant subtree", () => {
  it("declines the adoption, sweeps the pool, and leaves no detached element behind", () => {
    const { stage, renderer } = harness();
    created.push(renderer);
    const state = createMirrorState();
    keyframe(
      state,
      [
        node("root", null, { name: "Root" }),
        node("hand", "root", { name: "Hand" }),
        node("deck", "root", { name: "Deck", visible: false }), // the CLOSED dialog
        node("decklist", "deck", { name: "DeckList" }),
        ...filler(),
        ...cardShell("a", "hand", "nc:strike#1")
      ],
      ["root", "hand", "deck", "decklist", ...fillerIds(), ...cardIds("a")]
    );
    renderer.reconcile(state);
    const before = mirrorNodeCount(stage);
    const oldEls = cardIds("a").map((id) => el(stage, id)!);

    mirrorWalkStats.reset();
    structural(state, {
      removedIds: cardIds("a"),
      upserts: cardShell("b", "decklist", "nc:strike#1"), // same contentKey — but into the closed dialog
      orderedIds: ["root", "hand", "deck", "decklist", ...fillerIds(), ...cardIds("b")]
    });
    renderer.reconcile(state);

    expect(mirrorWalkStats.adoptions).toBe(0); // never spend a pooled element on an invisible tree
    expect(mirrorWalkStats.condemnedSwept).toBe(cardIds("a").length);
    expect(mirrorNodeCount(stage)).toBe(before - cardIds("a").length);
    for (const e of oldEls) {
      expect(e.isConnected).toBe(false); // swept, not left detached-but-alive or re-attached
    }
    for (const id of cardIds("b")) {
      expect(el(stage, id)).toBeNull();
    }

    // Reveal: the card builds fresh (a missed reuse, never a bug) and re-acquires its touch class.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [node("deck", "root", { name: "Deck", visible: true })]
      })!
    );
    renderer.reconcile(state);
    for (const id of cardIds("b")) {
      expect(el(stage, id), `revealed ${id}`).not.toBeNull();
    }
    expect(el(stage, "b")!.classList.contains("mirror-card-liftable")).toBe(true);
  });
});
