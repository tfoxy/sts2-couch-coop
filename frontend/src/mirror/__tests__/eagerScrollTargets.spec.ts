import { describe, expect, it } from "vitest";

import { barOffsetFor, MAP_LIMIT_HI, MAP_LIMIT_LO } from "@/mirror/eagerScroll";
import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// The RENDERER half of eager scrolling: which nodes are scrollables, where their viewport is, what the eager offset
// may reach, and how much of a virtualized grid is actually materialized. Everything here is measured off a wire
// shape taken from a real recording (`.sts2/bench/r8-map-live.ndjson` for the map, `wscrisp-deckdialog.ndjson` for
// the deck grid), so the names and node types below are the ones that really arrive on the wire.

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}

function rect(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}

function node(
  id: string,
  parentId: string | null,
  name: string,
  nodeType: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    parentId,
    name,
    nodeType,
    transform: xform(0, 0),
    localRect: rect(100, 100),
    visible: true,
    ...over
  };
}

function harness(): { renderer: MirrorRenderer; state: MirrorState } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { renderer: createMirrorRenderer(stage, defs), state: createMirrorState() };
}

function keyframe(state: MirrorState, nodes: Record<string, unknown>[]): void {
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
}

// The map screen as the wire actually streams it: a full-screen NMapScreen whose `TheMap` child carries the scroll
// offset in its LOCAL Y, with the drawing/point containers nested under it.
function mapScene(offsetY = -600, screenVisible = true): Record<string, unknown>[] {
  return [
    node("root", null, "Run", "MegaCrit.Sts2.Core.Nodes.NRun", { localRect: rect(1920, 1080) }),
    node("screen", "root", "MapScreen", "MegaCrit.Sts2.Core.Nodes.Screens.Map.NMapScreen", {
      localRect: rect(1920, 1080),
      visible: screenVisible
    }),
    node("themap", "screen", "TheMap", "Godot.Control", {
      localRect: rect(1920, 1080),
      transform: xform(0, offsetY)
    }),
    node("drawings", "themap", "Drawings", "MegaCrit.Sts2.Core.Nodes.Screens.Map.NMapDrawings", {
      localRect: rect(1920, 3240),
      transform: xform(0, -1620)
    })
  ];
}

// A deck-view card grid: an NCardGrid inset for the top bar with a content-sized ScrollContainer and a pool of
// materialized `NGridCardHolder` rows.
function gridScene(
  offsetY = 0,
  rowYs: number[] = [348.8, 726.4],
  contentH = 2400
): Record<string, unknown>[] {
  const holders = rowYs.flatMap((y, row) =>
    [0, 1].map((col) =>
      node(`holder-${row}-${col}`, "scroll", `GridCardHolder-${row}-${col}`, "MegaCrit.Sts2.Core.Nodes.Cards.NGridCardHolder", {
        localRect: rect(0, 0),
        transform: xform(225 + col * 280, y)
      })
    )
  );
  // The ANCHOR claims are the real wire's (`.sts2/bench/wscrisp-deckdialog.ndjson`): every frame from Run down to the
  // NCardGrid is a full-width [0,1] span, so on a widened stage each one reproduces Godot's own resize and passes the
  // whole budget down. They are inert at 16:9 (no widening budget is open), so every case below is unchanged by them.
  return [
    node("root", null, "Run", "MegaCrit.Sts2.Core.Nodes.NRun", {
      localRect: rect(1920, 1080),
      anchorLeft: 0,
      anchorRight: 1
    }),
    node("deck", "root", "DeckViewScreen", "MegaCrit.Sts2.Core.Nodes.Screens.NDeckViewScreen", {
      localRect: rect(1920, 1080),
      anchorLeft: 0,
      anchorRight: 1
    }),
    // (the SortingOptions header is added per-test where it matters — see the header-merge cases)
    node("grid", "deck", "CardGrid", "MegaCrit.Sts2.Core.Nodes.Cards.NCardGrid", {
      localRect: rect(1920, 1002),
      transform: xform(0, 80),
      sceneFilePath: "res://scenes/cards/card_grid.tscn",
      anchorLeft: 0,
      anchorRight: 1
    }),
    node("scroll", "grid", "ScrollContainer", "Godot.Control", {
      localRect: rect(1570, contentH),
      transform: xform(175, offsetY)
    }),
    ...holders
  ];
}

describe("mirrorRenderer.eagerScrollTargets", () => {
  it("finds the map container and reports its live offset + full-screen viewport", () => {
    const { renderer, state } = harness();
    keyframe(state, mapScene(-600));
    renderer.reconcile(state);

    const targets = renderer.eagerScrollTargets();
    expect(targets).toHaveLength(1);
    const map = targets[0];
    expect(map.kind).toBe("map");
    expect(map.id).toBe("themap");
    expect(map.streamedY).toBe(-600);
    expect(map.viewport).toEqual({ minX: 0, minY: 0, maxX: 1920, maxY: 1080 });
    // The map screen's own scroll window, as measured off the wire (see MAP_LIMIT_LO / MAP_LIMIT_HI).
    expect(map.limitLo).toBe(MAP_LIMIT_LO);
    expect(map.limitHi).toBe(MAP_LIMIT_HI);
    // The whole map is streamed — nothing is virtualized away.
    expect(map.band).toBeNull();
    expect(map.pinned).toBe(false);
    expect(map.el).not.toBeNull();
    // The PAINTED translation, read back off the matrix the walk just wrote — this is what the blend composes
    // against (see EagerScrollTarget.renderedY), and at rest it agrees with the streamed value.
    expect(map.renderedY).toBe(-600);
  });

  it("tracks the map offset as the host scrolls", () => {
    const { renderer, state } = harness();
    keyframe(state, mapScene(-600));
    renderer.reconcile(state);
    keyframe(state, mapScene(-320));
    renderer.reconcile(state);
    expect(renderer.eagerScrollTargets()[0].streamedY).toBe(-320);
    expect(renderer.eagerScrollTargets()[0].renderedY).toBe(-320);
  });

  it("reports the PAINTED Y, which lags the streamed one until the renderer has drawn it", () => {
    const { renderer, state } = harness();
    keyframe(state, mapScene(-600));
    renderer.reconcile(state);
    // A delta lands (node data updated) but no reconcile frame has run yet — exactly the window in which composing
    // against the streamed value made the map dip.
    keyframe(state, mapScene(-320));
    const target = renderer.eagerScrollTargets()[0];
    expect(target.streamedY).toBe(-320);
    expect(target.renderedY).toBe(-600);
  });

  it("reads the BASE matrix, not whatever a composed pass prepended to the element", () => {
    const { renderer, state } = harness();
    keyframe(state, mapScene(-600));
    renderer.reconcile(state);
    // `el!`: optional on the interface since a canvas stage has no elements — this backend always publishes one,
    // which the map case above asserts.
    const el = renderer.eagerScrollTargets()[0].el!;
    // What applyViewScalePass / applyTipScalePass do: PREPEND a stamp straight onto the element, bypassing the
    // style cache. Parsing the element's first `matrix(` reads the STAMP (here: 999), which is not where the walk
    // put this node — and composing the cosmetic translate against it would fling the container across the screen.
    el.style.transform = `matrix(1.2, 0, 0, 1.2, 0, 999) ${el.style.transform}`;
    expect(renderer.eagerScrollTargets()[0].renderedY).toBe(-600);
  });

  it("drops a scrollable whose SCREEN is hidden (a closed map behind combat keeps every descendant visible)", () => {
    const { renderer, state } = harness();
    keyframe(state, mapScene(-600, false));
    renderer.reconcile(state);
    expect(renderer.eagerScrollTargets()).toEqual([]);
  });

  it("finds a card grid's ScrollContainer with the grid's own rect as the viewport", () => {
    const { renderer, state } = harness();
    keyframe(state, gridScene(0));
    renderer.reconcile(state);

    const targets = renderer.eagerScrollTargets();
    expect(targets).toHaveLength(1);
    const grid = targets[0];
    expect(grid.kind).toBe("grid");
    expect(grid.id).toBe("scroll");
    expect(grid.streamedY).toBe(0);
    // The NCardGrid is inset 80px for the top bar.
    expect(grid.viewport).toEqual({ minX: 0, minY: 80, maxX: 1920, maxY: 1082 });
    // ScrollLimitBottom = viewport − content; upward travel only.
    expect(grid.limitLo).toBe(1002 - 2400);
    expect(grid.limitHi).toBe(0);
  });

  it("reports the MATERIALIZED row band of a virtualized grid", () => {
    const { renderer, state } = harness();
    keyframe(state, gridScene(0, [348.8, 726.4, 1104]));
    renderer.reconcile(state);
    const band = renderer.eagerScrollTargets()[0].band!;
    expect(band.lo).toBeCloseTo(348.8, 3);
    // Top row + the pitch between rows of slack, so the band covers the last row's own height.
    expect(band.hi).toBeCloseTo(1104 + (1104 - 348.8) / 2, 3);
  });

  // R11 WS-S §2 — the HEADER MERGE. `SortingOptions` (a plain Control child of the ScrollContainer, always streamed)
  // sits at y≈92 above the first card row at y≈348.8; without merging it in, the RESTING offset 0 is outside the
  // band and the very first wheel notch yanked the grid ~270px.
  const sortingHeader = node("sorting", "scroll", "SortingOptions", "Godot.Control", {
    localRect: rect(1481, 60),
    transform: xform(56, 92)
  });

  // The grid's own scrollbar (`scrollbar.tscn` under the NCardGrid), as the wire streams it: a 50×742 strip at the
  // right edge with the thumb inside it. Visible only when the game gives it a Stop mouse filter. The strip's anchor
  // claim is [1,1] — pinned to the RIGHT edge of its parent span — which is why on a widened stage it takes the FULL
  // widening delta and ends up the most-displaced widget in the dialog (see the Widescreen-stretch case below).
  const scrollbar = (visible = true): Record<string, unknown>[] => [
    node("bar", "grid", "Scrollbar", "MegaCrit.Sts2.Core.Nodes.GodotExtensions.NScrollbar", {
      localRect: rect(50, 742),
      transform: xform(1820, 129.6),
      sceneFilePath: "res://scenes/ui/scrollbar.tscn",
      anchorLeft: 1,
      anchorRight: 1,
      visible
    }),
    node("handle", "bar", "Handle", "MegaCrit.Sts2.Core.Nodes.CommonUi.NScrollbarTrain", {
      localRect: rect(72, 72),
      transform: xform(-11, -36),
      anchorLeft: 0.5,
      anchorRight: 0.5,
      visible
    })
  ];

  it("carves the visible SCROLLBAR out of the claim surface, and finds its thumb", () => {
    const { renderer, state } = harness();
    keyframe(state, [...gridScene(0), ...scrollbar()]);
    renderer.reconcile(state);
    const grid = renderer.eagerScrollTargets()[0];
    // Grid at y=80, bar local (1820, 129.6) sized 50x742.
    expect(grid.scrollbarBox).toEqual({ minX: 1820, minY: 209.6, maxX: 1870, maxY: 951.6 });
    expect(grid.bar?.id).toBe("handle");
  });

  // R20 — the WIDENED stage, which no bar test had ever run (every eager-scroll spec was 16:9, so the branch that
  // shifts the strip could not execute and the defect below shipped). "Widescreen stretch" at 2520 design px is
  // spreadFactor 1.3125 ⇒ Δ = 600; the bar hugs the right edge of the anchored 1920-wide frame, so it takes the WHOLE
  // delta. The GAME box must not move (the game still hit-tests 1920 space) while the RENDERED box is where the strip
  // is actually painted — and it is the rendered one a raw pointer has to be inside before the bar may claim a press.
  it("publishes the strip's ON-STAGE box under Widescreen stretch, leaving the game box at 1920", () => {
    const { renderer, state } = harness();
    keyframe(state, [...gridScene(0), ...scrollbar()]);
    renderer.setStretch(2520 / 1920);
    renderer.reconcile(state);
    const grid = renderer.eagerScrollTargets()[0];
    expect(grid.scrollbarBox).toEqual({ minX: 1820, minY: 209.6, maxX: 1870, maxY: 951.6 });
    expect(grid.scrollbarRenderedBox).toEqual({ minX: 2420, minY: 209.6, maxX: 2470, maxY: 951.6 });
  });

  it("at 16:9 the rendered box IS the game box — the R20 bar gate is a provable no-op", () => {
    const { renderer, state } = harness();
    keyframe(state, [...gridScene(0), ...scrollbar()]);
    renderer.reconcile(state);
    const grid = renderer.eagerScrollTargets()[0];
    expect(grid.scrollbarRenderedBox).toEqual(grid.scrollbarBox);
  });

  it("carves out nothing while the bar is hidden (the game gives it MouseFilter Ignore in the same breath)", () => {
    const { renderer, state } = harness();
    keyframe(state, [...gridScene(0), ...scrollbar(false)]);
    renderer.reconcile(state);
    expect(renderer.eagerScrollTargets()[0].scrollbarBox).toBeNull();
    expect(renderer.eagerScrollTargets()[0].scrollbarRenderedBox).toBeNull();
  });

  it("aims a grid's wheel ticks at the middle of the left gutter, at the frame's vertical middle", () => {
    const { renderer, state } = harness();
    keyframe(state, gridScene(0));
    renderer.reconcile(state);
    // Content starts at x=175 inside a frame that starts at 0 ⇒ x=87.5; the frame is 1002 tall from y=80.
    expect(renderer.eagerScrollTargets()[0].wheelSafe).toEqual({ x: 87.5, y: 581 });
  });

  it("has no wheel-safe point for the MAP (nothing to aim past on a full-screen container)", () => {
    const { renderer, state } = harness();
    keyframe(state, mapScene(-600));
    renderer.reconcile(state);
    expect(renderer.eagerScrollTargets()[0].wheelSafe).toBeNull();
    expect(renderer.eagerScrollTargets()[0].scrollbarBox).toBeNull();
  });

  it("merges the streamed header in: a grid at the top has a band that starts at 0", () => {
    const { renderer, state } = harness();
    keyframe(state, [...gridScene(0, [348.8, 726.4, 1104]), sortingHeader]);
    renderer.reconcile(state);
    const band = renderer.eagerScrollTargets()[0].band!;
    expect(band.lo).toBe(0);
    expect(band.hi).toBeCloseTo(1104 + (1104 - 348.8) / 2, 3);
  });

  it("does NOT merge it when the grid has scrolled away from the top (the rows are rows down the list)", () => {
    // A row a few pitches below the header is not contiguous with it — merging there would let the eager offset run
    // up into rows the host has not recycled back in yet.
    const { renderer, state } = harness();
    keyframe(state, [...gridScene(-1500, [1858.4, 2236, 2613.6]), sortingHeader]);
    renderer.reconcile(state);
    expect(renderer.eagerScrollTargets()[0].band!.lo).toBeCloseTo(1858.4, 3);
  });

  it("refuses to invent travel on a grid whose content fits the viewport", () => {
    const { renderer, state } = harness();
    keyframe(state, gridScene(0, [348.8], 800));
    renderer.reconcile(state);
    const grid = renderer.eagerScrollTargets()[0];
    expect(grid.limitLo).toBe(grid.streamedY);
    expect(grid.limitHi).toBe(grid.streamedY);
  });

  it("ignores a `ScrollContainer` that is not a card grid's (the settings screen's own scroller)", () => {
    const { renderer, state } = harness();
    keyframe(state, [
      node("root", null, "Run", "MegaCrit.Sts2.Core.Nodes.NRun", { localRect: rect(1920, 1080) }),
      node("settings", "root", "SettingsScreen", "MegaCrit.Sts2.Core.Nodes.Screens.Settings.NSettingsScreen", {
        localRect: rect(1920, 1080)
      }),
      node("scroll", "settings", "ScrollContainer", "MegaCrit.Sts2.Core.Nodes.GodotExtensions.NScrollableContainer", {
        localRect: rect(1920, 1080)
      })
    ]);
    renderer.reconcile(state);
    expect(renderer.eagerScrollTargets()).toEqual([]);
  });

  // R19 WP5 — the two facts the ABSOLUTE channel takes from the renderer, checked against a streamed scene rather
  // than against a hand-built target: the container's ADDRESS, and the bar geometry the press mapping runs on.
  it("names the scroll container by its live node id — the elementId set-scroll-offset resolves", () => {
    const { renderer, state } = harness();
    // Real wire ids are the Godot `GetInstanceId()` as a decimal string (the same addressing select-map-node and
    // hover-element take), so the action's `ulong.TryParse` is answered by the id the renderer reports verbatim.
    const scene = gridScene(0).map((n) => (n.id === "scroll" ? { ...n, id: "43704649279" } : n));
    keyframe(
      state,
      scene.map((n) => (n.parentId === "scroll" ? { ...n, parentId: "43704649279" } : n))
    );
    renderer.reconcile(state);
    expect(renderer.eagerScrollTargets()[0].id).toBe("43704649279");
  });

  it("the streamed bar box and the streamed limits compose into the game's own press mapping", () => {
    const { renderer, state } = harness();
    keyframe(state, [...gridScene(0), ...scrollbar()]);
    renderer.reconcile(state);
    const grid = renderer.eagerScrollTargets()[0];
    const box = grid.scrollbarBox!;
    // The game reads a bar press as a fraction of the WHOLE strip and lerps it onto the surface's bottom limit,
    // with no compensation for the thumb — so both ENDS of the streamed strip must land exactly on the streamed
    // limits, which is what makes the client's mapping parity rather than an approximation.
    expect(barOffsetFor(grid, box.minY)).toBe(grid.limitHi);
    expect(barOffsetFor(grid, box.maxY)).toBe(grid.limitLo);
    expect(barOffsetFor(grid, (box.minY + box.maxY) / 2)).toBeCloseTo(grid.limitLo / 2, 6);
    // 1002-tall frame over 2400 of content ⇒ the bar's bottom really is the bottom of the deck.
    expect(grid.limitLo).toBe(1002 - 2400);
  });

  it("exposes the retained-tree membership test", () => {
    const { renderer, state } = harness();
    keyframe(state, mapScene(-600));
    renderer.reconcile(state);
    expect(renderer.isUnderNode("drawings", "themap")).toBe(true);
    expect(renderer.isUnderNode("themap", "themap")).toBe(true);
    expect(renderer.isUnderNode("screen", "themap")).toBe(false);
  });
});
