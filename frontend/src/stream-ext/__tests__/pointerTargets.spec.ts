import { describe, expect, it, vi } from "vitest";

import type { ExtensionSession, ItemMeta, ItemMetaBatch, ItemQuery } from "@godot-scene-web/render-stream-client";

import {
  POINTER_TARGET_GROUPS,
  RS_GROUP_EVENT_OPTION,
  RS_GROUP_HAND_HOLDER
} from "@/stream-ext/groups";
import { buildStreamExtensions } from "@/stream-ext/extensions";
import { climbToTarget, createPointerTargetModule } from "@/stream-ext/pointerTargets";
import type { MirrorSettings } from "@/mirror/mirrorSettings";

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
  it("asks for identity v2 and role groups without stating filters or pick order", () => {
    const { extension } = createPointerTargetModule();
    expect(extension.wants).toEqual({
      fields: ["scene", "path", "instance_id", "mouse_filter"], groups: [...POINTER_TARGET_GROUPS]
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
    expect(interactive.extensions.map((e) => e.id)).toEqual(["couchcoop.pointerTargets"]);
    expect(interactive.pointerTargets).not.toBeNull();
    const viewOnly = buildStreamExtensions({ settings: off, presentationWidth: 1920 });
    expect(viewOnly.extensions).toEqual([]);
    expect(viewOnly.pointerTargets).toBeNull();
  });
});
