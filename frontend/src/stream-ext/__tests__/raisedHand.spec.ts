import { describe, expect, it } from "vitest";

import type { Affine2D, ExtensionFrame, ItemMeta, ItemMetaBatch, ItemQuery, OverrideTable, Rect } from "@godot-scene-web/render-stream-client";

import {
  computeRaisePlan,
  creatureShiftFor,
  creatureShifts,
  createRaisedHandExtension,
  raiseLiftPx,
  type CreatureGroupFacts,
  type RaiseFrameInput
} from "@/stream-ext/raisedHand";
import {
  RAISE_GROUPS,
  RS_GROUP_CREATURE_HUD,
  RS_GROUP_HAND_CONTAINER,
  RS_GROUP_HAND_HOLDER,
  RS_GROUP_HAND_ROOT,
  RS_GROUP_TARGETING_ARROW
} from "@/stream-ext/groups";

// -------------------------------------------------------------------------------------------------------------
// The pure plan (the policy, unchanged from the old mirror).
// -------------------------------------------------------------------------------------------------------------

function holder(id: number, localY: number | null) {
  return { id, localY };
}

function hud(id: number, kind: "HealthBar" | "Intents", top: number, height: number, reticleTop: number | null, powerTop: number | null): CreatureGroupFacts {
  return { id, kind, rootId: 1, top, height, reticleTop, powerTop };
}

describe("raisedHand — plan", () => {
  it("stands down for a targeting arrow, a hand choice or a dragged card", () => {
    const base: RaiseFrameInput = { holders: [holder(10, -59)], targeting: false, choicePrompt: false, dragging: false, creatureGroups: [] };
    expect(raiseLiftPx(base)).toBe(119);
    expect(raiseLiftPx({ ...base, targeting: true })).toBe(0);
    expect(raiseLiftPx({ ...base, choicePrompt: true })).toBe(0);
    expect(raiseLiftPx({ ...base, dragging: true })).toBe(0);
  });

  it("lifts a resting holder by the full raise and leaves a focused holder alone", () => {
    const resting = computeRaisePlan({ holders: [holder(10, -59)], targeting: false, choicePrompt: false, dragging: false, creatureGroups: [] });
    expect(resting.offsets).toEqual([{ id: 10, dy: -119 }]);
    // A focused holder sits at the game's own pose (t = 1), so the ramp applies no lift.
    const focused = computeRaisePlan({ holders: [holder(10, -209)], targeting: false, choicePrompt: false, dragging: false, creatureGroups: [] });
    expect(focused.offsets).toEqual([]);
  });

  it("does not lift a holder that left the fan (localY null)", () => {
    const plan = computeRaisePlan({ holders: [holder(10, null)], targeting: false, choicePrompt: false, dragging: false, creatureGroups: [] });
    expect(plan.offsets).toEqual([]);
  });

  it("shifts a creature HUD group above the reticle", () => {
    const group = hud(20, "HealthBar", 0, 64, -179, 25);
    const shifts = creatureShifts(group);
    expect(shifts.healthBar).toBe(-179 - (25 + 40));
    expect(creatureShiftFor("HealthBar", shifts)).toBe(shifts.healthBar);
    expect(creatureShiftFor("Intents", shifts)).toBe(shifts.intents);
    const plan = computeRaisePlan({ holders: [], targeting: false, choicePrompt: false, dragging: false, creatureGroups: [group] });
    expect(plan.offsets).toEqual([{ id: 20, dy: Math.round(shifts.healthBar) }]);
  });
});

// -------------------------------------------------------------------------------------------------------------
// The extension glue: identity indexing and the "dirty only" write discipline.
// -------------------------------------------------------------------------------------------------------------

function meta(id: number, groups: string[], path: string | null = null): ItemMeta {
  return { id, node: true, scene: null, script: null, path, groups, meta: {} };
}

function batch(items: ItemMeta[], form: "full" | "delta" = "full"): ItemMetaBatch {
  return { form, items };
}

class FakeOverrides implements OverrideTable {
  writes = 0;
  cleared: number[] = [];
  readonly values = new Map<number, { transform: Affine2D }>();
  set(id: number, o: { transform?: Affine2D }): void {
    this.writes++;
    if (o.transform) this.values.set(id, { transform: o.transform });
  }
  translate(id: number, dx: number, dy: number): void {
    this.writes++;
    this.values.set(id, { transform: [1, 0, 0, 1, dx, dy] });
  }
  scaleAbout(id: number, sx: number, sy: number, px: number, py: number): void {
    this.writes++;
    this.values.set(id, { transform: [sx, 0, 0, sy, px - sx * px, py - sy * py] });
  }
  setGlobal(): void { this.writes++; }
  freeze(): void { this.writes++; }
  clear(id: number): void { this.cleared.push(id); }
  clearAll(): void { this.writes++; }
  get(): null { return null; }
  effective(): Affine2D { return [1, 0, 0, 1, 0, 0]; }
  size = 0;
}

function fakeQuery(overrides: Record<number, { parent?: number | null; y?: number; visible?: boolean }>): ItemQuery {
  return {
    parent: (id) => overrides[id]?.parent ?? null,
    children: () => new Uint32Array(0),
    transform: (id) => {
      const o = overrides[id];
      if (o === undefined || o.y === undefined) return null;
      return [1, 0, 0, 1, 0, o.y];
    },
    rect: (id) => {
      const o = overrides[id];
      if (o === undefined || o.y === undefined) return null;
      return { x: 0, y: o.y, w: 0, h: 0 } as Rect;
    },
    subtreeRect: () => null,
    visible: (id) => overrides[id]?.visible ?? true,
    meta: (id) => {
      const m = metas.get(id);
      return m ?? null;
    },
    hitTest: () => null
  };
}

const metas = new Map<number, ItemMeta>();
let query: ItemQuery;
let overrides: FakeOverrides;

function frame(seq: number | null): ExtensionFrame {
  return { seq, now: 0, overrides, query, requestRedraw: () => {} };
}

describe("raisedHand — extension glue", () => {
  it("indexes the mod's groups and writes a lift only while dirty", () => {
    metas.clear();
    overrides = new FakeOverrides();
    const container = 100;
    query = fakeQuery({
      [container]: { y: 0 },
      10: { parent: container, y: -59 }
    });
    const ext = createRaisedHandExtension();
    ext.onItemMeta!(batch([
      meta(10, [RS_GROUP_HAND_HOLDER], "CardHolderContainer/NHandCardHolder-CARD"),
      meta(container, [RS_GROUP_HAND_CONTAINER])
    ]));

    ext.beforeDraw!(frame(5));
    expect(overrides.values.has(10)).toBe(true);
    expect(overrides.values.get(10)!.transform[5]).toBe(-119);
    const writesAfterFirst = overrides.writes;

    // Nothing changed: the same transaction again must not write a single override (the "dirty only" spec).
    ext.beforeDraw!(frame(5));
    expect(overrides.writes).toBe(writesAfterFirst);

    ext.dispose!();
  });

  it("leaves a holder that was reparented onto the hand root alone", () => {
    metas.clear();
    overrides = new FakeOverrides();
    const container = 100;
    const handRoot = 200;
    query = fakeQuery({
      [container]: { y: 0 },
      [handRoot]: { y: 0 },
      11: { parent: handRoot, y: -59 }
    });
    const ext = createRaisedHandExtension();
    ext.onItemMeta!(batch([
      meta(11, [RS_GROUP_HAND_HOLDER]),
      meta(container, [RS_GROUP_HAND_CONTAINER]),
      meta(handRoot, [RS_GROUP_HAND_ROOT])
    ]));
    ext.beforeDraw!(frame(1));
    expect(overrides.values.has(11)).toBe(false);
    ext.dispose!();
  });

  it("stands the lift down while a targeting arrow is visible", () => {
    metas.clear();
    overrides = new FakeOverrides();
    const container = 100;
    const arrow = 300;
    query = fakeQuery({
      [container]: { y: 0 },
      10: { parent: container, y: -59 },
      [arrow]: { visible: true }
    });
    const ext = createRaisedHandExtension();
    ext.onItemMeta!(batch([
      meta(10, [RS_GROUP_HAND_HOLDER]),
      meta(container, [RS_GROUP_HAND_CONTAINER]),
      meta(arrow, [RS_GROUP_TARGETING_ARROW])
    ]));
    ext.beforeDraw!(frame(1));
    expect(overrides.values.has(10)).toBe(false);
    ext.dispose!();
  });
});

describe("raisedHand — off is empty", () => {
  it("asks for the mod's groups and a path, and nothing else", () => {
    const ext = createRaisedHandExtension();
    expect(ext.wants?.fields).toEqual(["path"]);
    expect([...(ext.wants?.groups ?? [])].sort()).toEqual([...RAISE_GROUPS].slice().sort());
  });
});
