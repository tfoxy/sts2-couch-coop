import { describe, expect, it, vi } from "vitest";

import type { ExtensionSession, ItemMeta, ItemMetaBatch, ItemQuery } from "@godot-scene-web/render-stream-client";

import {
  POINTER_TARGET_GROUPS,
  RS_GROUP_EVENT_OPTION,
  RS_GROUP_HAND_HOLDER,
  RS_GROUP_POINTER_INPUT
} from "@/stream-ext/groups";
import { buildStreamExtensions } from "@/stream-ext/extensions";
import { climbToTarget, createPointerTargetModule } from "@/stream-ext/pointerTargets";
import type { MirrorSettings } from "@/mirror/mirrorSettings";

// C3: the stream's POINTER-TARGET module. The mouse filters (each node item's Godot filter stated to the client's hit
// test, so the full-screen transition rect and decoration stop hiding every combat item) and couch's identity climb (the hand card's holder
// or the confirm widget, not the label the finger is on).

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

describe("pointerTargets — the hit test's mouse filters", () => {
  it("asks for scene, path and its groups", () => {
    const { extension } = createPointerTargetModule();
    expect(extension.wants).toEqual({ fields: ["scene", "path"], groups: [...POINTER_TARGET_GROUPS] });
  });

  it("states stop for an input Control, ignore for any other node, nothing for an item with no node", () => {
    const module = createPointerTargetModule();
    const s = session();
    module.extension.onSession!(s);
    module.extension.onItemMeta!(
      full([meta(37, []), meta(38, [RS_GROUP_POINTER_INPUT]), { ...meta(39, []), node: false }])
    );
    expect(s.mouseFilter.mock.calls).toEqual([[37, "ignore"], [38, "stop"]]);
    expect(module.filteredCount).toBe(2);
    // A role widget is "stop" even when the seat read an IGNORE filter (an event option is enabled later).
    module.extension.onItemMeta!(delta([meta(40, [RS_GROUP_EVENT_OPTION]), meta(38, [RS_GROUP_POINTER_INPUT])]));
    expect(s.mouseFilter.mock.calls.at(-1)).toEqual([40, "stop"]);
    expect(s.mouseFilter.mock.calls).toHaveLength(3); // 38 unchanged: not stated again
    s.mouseFilter.mockClear();
    // A full table replaces: an item it no longer lists loses its filter.
    module.extension.onItemMeta!(full([meta(38, [RS_GROUP_POINTER_INPUT])]));
    expect(s.mouseFilter.mock.calls.sort()).toEqual([[37, null], [40, null]]);
    module.extension.onItemsRemoved!(Uint32Array.from([38]));
    expect(module.filteredCount).toBe(0);
  });

  it("keeps the client's draw order: ready-time filters are too stale for Godot's tree order (C4a)", () => {
    const module = createPointerTargetModule();
    const s = session();
    module.extension.onSession!(s);
    module.extension.onItemMeta!(full([meta(37, []), meta(38, [RS_GROUP_POINTER_INPUT])]));
    expect(s.pickOrder).not.toHaveBeenCalled();
  });

  it("states nothing when the seat did not grant the input group", () => {
    const module = createPointerTargetModule();
    const s = session([]);
    module.extension.onSession!(s);
    module.extension.onItemMeta!(full([meta(37, []), meta(38, [])]));
    expect(s.mouseFilter).not.toHaveBeenCalled();
  });

  it("a new session starts from nothing", () => {
    const module = createPointerTargetModule();
    const first = session();
    module.extension.onSession!(first);
    module.extension.onItemMeta!(full([meta(37, [])]));
    const second = session();
    module.extension.onSession!(second);
    expect(module.filteredCount).toBe(0);
    module.extension.onItemMeta!(full([meta(37, [])]));
    expect(second.mouseFilter.mock.calls).toEqual([[37, "ignore"]]);
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
    expect(interactive.extensions.map((e) => e.id)).toEqual(["couchcoop.pointerTargets"]);
    expect(interactive.pointerTargets).not.toBeNull();
    const viewOnly = buildStreamExtensions({ settings: off, presentationWidth: 1920 });
    expect(viewOnly.extensions).toEqual([]);
    expect(viewOnly.pointerTargets).toBeNull();
  });
});
