import { describe, expect, it, vi } from "vitest";

import type { ExtensionSession, ItemMeta, ItemMetaBatch, ItemQuery } from "@godot-scene-web/render-stream-client";

import {
  POINTER_TARGET_GROUPS,
  RS_GROUP_EVENT_OPTION,
  RS_GROUP_HAND_HOLDER
} from "@/stream-ext/groups";
import { buildStreamExtensions } from "@/stream-ext/extensions";
import { climbToTarget, createPointerTargetModule, touchTargetFor } from "@/stream-ext/pointerTargets";
import type { MirrorSettings } from "@/mirror/mirrorSettings";
import { MULTIPLAYER_PLAYER_STATE_SCENE_FILE } from "@/mirror/renderer/interactionPolicy";

function meta(id: number, groups: string[], identity: { scene?: string | null; path?: string | null } = {}): ItemMeta {
  return {
    id,
    node: true,
    class: null,
    script: null,
    scene: identity.scene === undefined ? "res://s.tscn" : identity.scene,
    path: identity.path === undefined ? `N${id}` : identity.path,
    groups,
    meta: {}
  };
}

function query(parents: Record<number, number | null>, metas: Record<number, ItemMeta | null>): ItemQuery {
  return {
    parent: (id) => parents[id] ?? null,
    children: () => new Uint32Array(0),
    transform: () => [1, 0, 0, 1, 0, 0],
    rect: () => null,
    subtreeRect: () => null,
    visible: () => true,
    meta: (id) => metas[id] ?? null,
    hitTest: () => null
  };
}

function session(groups: string[] = [...POINTER_TARGET_GROUPS]) {
  const mouseFilter = vi.fn<(id: number, filter: "stop" | "pass" | "ignore" | null) => void>();
  const pickOrder = vi.fn<(order: "drawn" | "tree") => void>();
  const s: ExtensionSession = {
    sessionId: "s",
    streamId: "t",
    itemMeta: { fields: ["scene", "path"], groups, metaKeys: [] },
    requestRedraw: () => {},
    mouseFilter,
    pickOrder
  };
  return Object.assign(s, { mouseFilter, pickOrder });
}

const full = (items: ItemMeta[]): ItemMetaBatch => ({ form: "full", items });
const delta = (items: ItemMeta[]): ItemMetaBatch => ({ form: "delta", items });

describe("pointerTargets — identity climb", () => {
  it("climbs from a card's label to the hand card's holder", () => {
    // label 12 → card art 11 → card 10 → holder 9 (hand holder group) → container 8
    const q = query(
      { 12: 11, 11: 10, 10: 9, 9: 8, 8: null },
      { 12: meta(12, []), 11: meta(11, []), 10: meta(10, []), 9: meta(9, [RS_GROUP_HAND_HOLDER]), 8: meta(8, []) }
    );
    expect(climbToTarget(12, q)).toBe(9);
  });

  it("climbs to a confirm-eligible widget", () => {
    const q = query({ 21: 20, 20: 19, 19: null }, { 21: meta(21, []), 20: meta(20, [RS_GROUP_EVENT_OPTION]), 19: meta(19, []) });
    expect(climbToTarget(21, q)).toBe(20);
  });

  it("otherwise names the first node, and only when it has an identity the seat can find", () => {
    const q = query(
      { 31: 30, 30: 29, 29: null, 41: 40, 40: null },
      {
        31: { ...meta(31, []), node: false }, // a TileMap quadrant, say: no node
        30: meta(30, []),
        29: meta(29, []),
        41: meta(41, [], { scene: null, path: null }), // a node created in code, no owner
        40: meta(40, [])
      }
    );
    expect(climbToTarget(31, q)).toBe(30);
    expect(climbToTarget(41, q)).toBeNull();
    expect(climbToTarget(99, query({}, {}))).toBeNull();
  });
});

describe("pointerTargets — host filters", () => {
  it("arms the player-state instance root across ordinary sibling descendants", () => {
    const scene = MULTIPLAYER_PLAYER_STATE_SCENE_FILE;
    const q = query({ 11: 10, 12: 10 }, {
      10: meta(10, [], { scene, path: "." }),
      11: { ...meta(11, [], { scene, path: "HP/Label" }), class: "Label" },
      12: { ...meta(12, [], { scene, path: "Name" }), class: "Control" }
    });
    expect(touchTargetFor(11, q)).toBe(10);
    expect(touchTargetFor(12, q)).toBe(10);
  });

  it("keeps a nearer button immediate inside a player-state scene", () => {
    const scene = MULTIPLAYER_PLAYER_STATE_SCENE_FILE;
    const q = query({ 12: 11, 11: 10 }, {
      10: meta(10, [], { scene, path: "." }),
      11: { ...meta(11, [], { scene, path: "Button" }), class: "NBackButton" },
      12: meta(12, [], { scene, path: "Button/Label" })
    });
    expect(touchTargetFor(12, q)).toBeNull();
  });

  it("keeps nested plain buttons and scrollbars immediate even under a hover-first widget", () => {
    for (const type of ["NBackButton", "NScrollbar", "NScrollbarTrain", "NDropdownScrollbar"]) {
      const q = query({ 11: 10, 10: 9, 9: null }, {
        10: { ...meta(10, []), script: `res://ui/${type}.cs` },
        9: meta(9, [RS_GROUP_EVENT_OPTION])
      });
      expect(touchTargetFor(11, q)).toBeNull();
    }
  });

  it("reads touch policy from the current frame and drops it on dispose", () => {
    const module = createPointerTargetModule();
    const q = query({ 11: 10, 10: null }, { 10: { ...meta(10, []), class: "NCard" } });
    expect(module.touchTargetFor(11)).toBeNull();
    module.extension.beforeDraw?.({ query: q } as never);
    expect(module.touchTargetFor(11)).toBe(10);
    module.extension.dispose?.();
    expect(module.touchTargetFor(11)).toBeNull();
  });

  it("asks for identity v2 and role groups without stating filters or pick order", () => {
    const { extension } = createPointerTargetModule();
    expect(extension.wants).toEqual({
      fields: ["scene", "path", "instance_id", "mouse_filter", "class", "script"], groups: [...POINTER_TARGET_GROUPS]
    });
    const s = session();
    extension.onSession?.(s);
    extension.onItemMeta?.(full([meta(37, []), { ...meta(38, [RS_GROUP_EVENT_OPTION]), mouseFilter: "ignore" }]));
    extension.onItemMeta?.(delta([{ ...meta(38, [RS_GROUP_EVENT_OPTION]), mouseFilter: "stop" }]));
    extension.onItemsRemoved?.(Uint32Array.from([38]));
    extension.dispose?.();
    expect(s.mouseFilter).not.toHaveBeenCalled();
    expect(s.pickOrder).not.toHaveBeenCalled();
  });

  it("uses a host-picked Hitbox itself instead of its hand holder", () => {
    for (const mouseFilter of ["stop", "pass"] as const) {
      const q = query({ 10: 9, 9: null }, {
        10: { ...meta(10, []), mouseFilter },
        9: meta(9, [RS_GROUP_HAND_HOLDER])
      });
      expect(climbToTarget(10, q)).toBe(10);
    }
  });

  it("accepts instance-only input nodes and refuses picked nodes without any identity", () => {
    const m = { ...meta(10, [], { scene: null, path: null }), mouseFilter: "stop" as const };
    expect(climbToTarget(10, query({ 10: 9 }, { 10: { ...m, instanceId: "18446744073709551615" } }))).toBe(10);
    expect(climbToTarget(10, query({ 10: 9 }, { 10: m, 9: meta(9, []) }))).toBeNull();
  });

  it("a client that cannot resolve (a spec's fake) gives no resolver", () => {
    const module = createPointerTargetModule();
    expect(module.resolverFor(null)).toBeNull();
    expect(module.resolverFor({} as never)).toBeNull();
  });
});

describe("pointerTargets — interactive pages always run it", () => {
  const off = {
    raiseHandCards: false,
    uiScaling: false,
    raiseHeldCard: false,
    confirmTap: false
  } as MirrorSettings;

  it("is in an interactive page's list whatever the viewer enabled, and never in a receive-only page's", () => {
    const interactive = buildStreamExtensions({ settings: off, presentationWidth: 1920, interactive: true });
    expect(interactive.extensions.map((e) => e.id)).toContain("couchcoop.pointerTargets");
    expect(interactive.pointerTargets).not.toBeNull();
    const viewOnly = buildStreamExtensions({ settings: off, presentationWidth: 1920 });
    expect(viewOnly.extensions).toEqual([]);
    expect(viewOnly.pointerTargets).toBeNull();
  });
});

describe("pointerTargets — choice exclusions", () => {
  it.each(["NCardGridSelectionScreen", "NDeckCardSelectScreen", "NCardPreviewContainer", "NHoverTipCardContainer", "NInspectCardScreen"])("does not arm cards under %s", (type) => {
    const q = query({ 1: 2, 2: 3 }, { 2: { ...meta(2, []), class: "NCard" }, 3: { ...meta(3, []), class: type } });
    expect(touchTargetFor(1, q)).toBeNull();
  });

  it("clicks a lone visible event option immediately, but arms multiple options", () => {
    const module = createPointerTargetModule();
    const items = [meta(1, [RS_GROUP_EVENT_OPTION]), meta(2, [RS_GROUP_EVENT_OPTION])];
    const q = query({}, Object.fromEntries(items.map((m) => [m.id, m])));
    module.extension.onItemMeta!(full(items));
    module.extension.beforeDraw!({ query: q } as never);
    expect(module.touchTargetFor(1)).toBe(1);
    q.visible = (id) => id !== 2;
    module.extension.beforeDraw!({ query: q } as never);
    expect(module.touchTargetFor(1)).toBeNull();
  });
});

describe("pointerTargets — reward focus snapshots", () => {
  function rewards() {
    const module = createPointerTargetModule();
    // Metadata arrival order differs from the visible row order.
    const items = [
      { ...meta(10, []), class: "NRewardsScreen" },
      { ...meta(30, []), class: "NRewardButton" },
      { ...meta(20, []), script: "res://ui/NRewardButton.cs" },
      meta(21, [], { path: "Hitbox" }), meta(31, [], { path: "Hitbox" })
    ];
    const q = query({ 20: 10, 30: 10, 21: 20, 31: 30 }, Object.fromEntries(items.map((m) => [m.id, m])));
    q.children = (id) => Uint32Array.from(({ 10: [20, 30], 20: [21], 30: [31] } as Record<number, number[]>)[id] ?? []);
    q.rect = (id) => id === 21 ? { x: 100, y: 200, w: 200, h: 40 } : id === 31 ? { x: 100, y: 300, w: 200, h: 40 } : null;
    const hitTest = vi.fn((_x: number, y: number): number | null => y < 270 ? 21 : 31);
    q.hitTest = hitTest;
    const listener = vi.fn();
    const unsubscribe = module.subscribeRewardFocus(listener);
    module.extension.onItemMeta!({ form: "full", items });
    const draw = (seq: number | null) => module.extension.beforeDraw!({
      seq, query: q, overrides: { effective: () => [1, 0, 0, 1, 40, 10] }
    } as never);
    return { module, q, listener, unsubscribe, draw, hitTest };
  }

  it("uses tree order and native Hitbox centres, checking coverage in drawn space", () => {
    const run = rewards();
    expect(run.listener).toHaveBeenLastCalledWith({ screenId: null, rows: [] });
    run.draw(1);
    expect(run.listener).toHaveBeenLastCalledWith({ screenId: "10", rows: [
      { id: "20", focused: false, covered: false, gameCenter: { x: 200, y: 220 } },
      { id: "30", focused: false, covered: false, gameCenter: { x: 200, y: 320 } }
    ] });
    expect(run.hitTest.mock.calls).toEqual([[240, 230], [240, 330]]);
  });

  it("defers a covered row and a row with no geometry", () => {
    const run = rewards();
    run.hitTest.mockReturnValue(99);
    run.q.rect = (id) => id === 21 ? { x: 100, y: 200, w: 200, h: 40 } : null;
    run.draw(1);
    expect(run.listener.mock.lastCall?.[0].rows).toEqual([
      { id: "20", focused: false, covered: true, gameCenter: { x: 200, y: 220 } },
      { id: "30", focused: false, covered: false, gameCenter: null }
    ]);
  });

  it("prefers a nested Hitbox to decorative subtree bounds and rejects empty geometry", () => {
    const run = rewards();
    const children = run.q.children;
    run.q.children = (id) => id === 20 ? Uint32Array.of(22) : id === 22 ? Uint32Array.of(21) : children(id);
    run.q.rect = (id) => id === 21 ? { x: 100, y: 200, w: 200, h: 40 } : null;
    run.q.subtreeRect = () => ({ x: 0, y: 0, w: 1000, h: 1000 });
    run.draw(1);
    expect(run.listener.mock.lastCall?.[0].rows[0].gameCenter).toEqual({ x: 200, y: 220 });
    expect(run.listener.mock.lastCall?.[0].rows[1].gameCenter).toBeNull();
    run.q.rect = () => ({ x: 100, y: 200, w: 0, h: 40 });
    run.draw(2);
    expect(run.listener.mock.lastCall?.[0].rows.every((row: { gameCenter: unknown }) => row.gameCenter === null)).toBe(true);
  });

  it("emits once per scene transaction, excluding extension redraws", () => {
    const run = rewards();
    run.draw(1);
    run.listener.mockClear();
    run.draw(null);
    run.draw(1);
    expect(run.listener).not.toHaveBeenCalled();
    run.draw(2);
    expect(run.listener).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    run.module.subscribeRewardFocus(late);
    expect(late).toHaveBeenCalledWith(run.listener.mock.lastCall?.[0]);
  });

  it("drops removed rows and hidden screens and stops notifying after unsubscribe or dispose", () => {
    const run = rewards();
    run.draw(1);
    run.module.extension.onItemsRemoved!(Uint32Array.of(20));
    run.draw(2);
    expect(run.listener.mock.lastCall?.[0].rows.map((row: { id: string }) => row.id)).toEqual(["30"]);
    run.q.visible = (id) => id !== 10;
    run.draw(3);
    expect(run.listener).toHaveBeenLastCalledWith({ screenId: null, rows: [] });
    run.unsubscribe();
    run.listener.mockClear();
    run.draw(4);
    expect(run.listener).not.toHaveBeenCalled();
    run.module.subscribeRewardFocus(run.listener);
    run.module.extension.dispose!();
    run.listener.mockClear();
    run.draw(5);
    expect(run.listener).not.toHaveBeenCalled();
  });
});
