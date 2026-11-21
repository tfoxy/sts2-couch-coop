import { describe, expect, it, vi } from "vitest";
import type {
  Affine2D, ExtensionFrame, ExtensionSession, ItemMeta, ItemQuery, OverrideTable, OverrideValues
} from "@godot-scene-web/render-stream-client";

import { flameFlickerPose, flamePhaseMs, spinDurationMs } from "@/mirror/animAttributes";
import { createMirrorSettings } from "@/mirror/mirrorSettings";
import { createDecorExtension } from "@/stream-ext/decor";
import { buildStreamExtensions } from "@/stream-ext/extensions";

const identity: Affine2D = [1, 0, 0, 1, 0, 0];
const energy = "res://scenes/combat/energy_counters/ironclad_energy_counter.tscn";
const fireScript = "res://src/Core/Nodes/Vfx/NRestSiteFireVfx.cs";
function meta(id: number, path: string, scene = energy, script: string | null = null): ItemMeta {
  return { id, path, scene, script, node: true, groups: [], meta: {} };
}
function fixture(items: ItemMeta[], parents: Record<number, number> = {}) {
  const hidden = new Set<number>();
  const values = new Map<number, Readonly<Required<OverrideValues>>>();
  const query: ItemQuery = {
    parent: vi.fn((id) => parents[id] ?? null),
    children: vi.fn(() => new Uint32Array()),
    transform: vi.fn((): Affine2D => [0, 1, -1, 0, 250, 120]),
    rect: vi.fn(() => ({ x: 100, y: 50, w: 80, h: 60 })),
    controlRect: vi.fn(() => null), subtreeRect: vi.fn(() => null),
    visible: vi.fn((id) => !hidden.has(id)), meta: vi.fn((id) => items.find((item) => item.id === id) ?? null),
    hitTest: vi.fn(() => null)
  };
  const overrides: OverrideTable = {
    set(id, value) {
      values.set(id, { transform: identity, modulate: [1, 1, 1, 1], visible: true,
        frozen: false, clipOutset: [0, 0, 0, 0], ...value });
    },
    translate: vi.fn(), scaleAbout: vi.fn(), setGlobal: vi.fn(), freeze: vi.fn(),
    clear: vi.fn((id) => { values.delete(id); }), clearAll: vi.fn(() => values.clear()),
    get: (id) => values.get(id) ?? null, effective: () => identity,
    get size() { return values.size; }
  };
  const redraw = vi.fn();
  const session: ExtensionSession = { sessionId: "s", streamId: "s", itemMeta: null,
    requestRedraw: redraw, mouseFilter: vi.fn(), pickOrder: vi.fn() };
  const frame: ExtensionFrame = { seq: 1, now: 200, query, overrides, requestRedraw: redraw };
  const extension = createDecorExtension();
  extension.onSession!(session);
  extension.onItemMeta!({ form: "full", items });
  const draw = (now = 200) => extension.beforeDraw!({ ...frame, now });
  return { extension, draw, query, overrides, values, redraw, session, frame, hidden };
}
function expectMatrix(actual: Affine2D | undefined, expected: Affine2D) {
  expect(actual).toBeDefined();
  expected.forEach((value, index) => expect(actual![index]).toBeCloseTo(value, 9));
}

describe("stream client decorations", () => {
  it.each([2, 3])("reuses layer %i's ring period and rotates about its captured rect centre", (layer) => {
    const path = `Layers/RotationLayers/Layer${layer}`;
    const f = fixture([meta(1, path)]);
    f.draw();
    expectMatrix(f.values.get(1)?.transform, identity); // captured host pose is preserved, even when rotated
    f.draw(200 + spinDurationMs(path)! / 4);
    expectMatrix(f.values.get(1)?.transform, [0, 1, -1, 0, 220, -60]);
    f.draw(200 + spinDurationMs(path)!);
    expectMatrix(f.values.get(1)?.transform, identity);
    expect(f.extension.wants?.fields).toEqual(["path", "scene", "script"]);
  });

  it("excludes star layers, intent holders, nonrotating energy layers and unrelated fire sprites", () => {
    const f = fixture([
      meta(1, "Icon/RotationLayers/Layer1", "res://scenes/combat/star_counter.tscn"),
      meta(2, "Layers/RotationLayers/Layer2", "res://scenes/combat/star_counter.tscn"),
      meta(3, "Enemy/IntentHolder"), meta(4, "Layers/Layer3"),
      meta(5, "SteppedFireMix", "res://scenes/vfx/unrelated.tscn")
    ]);
    f.draw();
    expect(f.values.size).toBe(0);
    expect(f.redraw).not.toHaveBeenCalled();
  });

  it("does no queries or redraw with no bindings, and stops redraw while every binding is hidden", () => {
    const empty = fixture([]);
    empty.draw();
    for (const fn of Object.values(empty.query)) expect(fn).not.toHaveBeenCalled();
    expect(empty.redraw).not.toHaveBeenCalled();
    const f = fixture([meta(1, "Layers/RotationLayers/Layer2")]);
    f.hidden.add(1); f.draw();
    expect(f.redraw).not.toHaveBeenCalled();
    expect(f.query.rect).not.toHaveBeenCalled();
    f.hidden.clear(); f.draw();
    expect(f.redraw).toHaveBeenCalledTimes(1);
    f.hidden.add(1); f.draw(400);
    expect(f.redraw).toHaveBeenCalledTimes(1);
  });

  it("does not schedule redraw for an unpainted bound item", () => {
    const f = fixture([meta(1, "Layers/RotationLayers/Layer2")]);
    vi.mocked(f.query.rect).mockReturnValue(null);
    f.draw();
    expect(f.redraw).not.toHaveBeenCalled();
    expect(f.values.size).toBe(0);
  });

  it("uses one flame phase per frozen root, with independent phases between roots", () => {
    const scene = "res://scenes/vfx/candle.tscn";
    const f = fixture([
      meta(10, ".", scene, fireScript), meta(20, ".", scene, fireScript),
      meta(11, "SteppedFireMix", scene), meta(12, "SteppedFireAdd", scene),
      meta(13, "SteppedFireAdd1", scene), meta(21, "SteppedFireMix", scene)
    ], { 11: 10, 12: 10, 13: 10, 21: 20 });
    f.draw();
    for (const value of f.values.values()) expectMatrix(value.transform, identity);
    f.draw(800);
    const one = f.values.get(11)!.transform;
    expectMatrix(f.values.get(12)?.transform, one);
    expectMatrix(f.values.get(13)?.transform, one);
    expect(f.values.get(21)?.transform).not.toEqual(one);
    const phase = flamePhaseMs("10");
    expect(one[3]).toBeCloseTo(flameFlickerPose(600, phase).scaleY / flameFlickerPose(0, phase).scaleY);
    // Each quad's bottom centre remains anchored.
    expect(one[0] * 140 + one[2] * 110 + one[4]).toBeCloseTo(140);
    expect(one[1] * 140 + one[3] * 110 + one[5]).toBeCloseTo(110);
    expect([...f.values.keys()]).toEqual([11, 12, 13, 21]);
  });

  it.each(["streamClientDecor", "streamDecorFrozen"] as const)("clears its overrides when %s turns off and restarts from the host pose", (key) => {
    const items = [meta(1, "Layers/RotationLayers/Layer2"),
      meta(2, "Icon/RotationLayers/Layer1", "res://scenes/combat/star_counter.tscn")];
    const f = fixture(items);
    const settings = createMirrorSettings(undefined, "", { storage: null });
    settings.streamClientDecor = settings.streamDecorFrozen = true;
    const built = buildStreamExtensions({ settings, interactive: true, presentationWidth: 1920 });
    const decor = built.extensions.find((extension) => extension.id === "couchcoop.decor")!;
    try {
      decor.onSession!(f.session); decor.onItemMeta!({ form: "full", items });
      decor.beforeDraw!(f.frame); decor.beforeDraw!({ ...f.frame, now: 500 });
      expect([...f.values.keys()]).toEqual([1]);
      expect(f.values.get(1)?.transform).not.toEqual(identity);
      expect(f.values.has(2)).toBe(false);
      f.overrides.set(99, { visible: false });
      settings[key] = false;
      // The watch requests one draw to clear the retained override; disabled draws must not sustain it.
      f.redraw.mockClear();
      decor.beforeDraw!({ ...f.frame, now: 800 });
      expect([...f.values.keys()]).toEqual([99]);
      expect(f.values.get(99)?.visible).toBe(false);
      expect(f.redraw).not.toHaveBeenCalled();
      decor.beforeDraw!({ ...f.frame, now: 900 });
      expect(f.redraw).not.toHaveBeenCalled();
      settings[key] = true;
      decor.beforeDraw!({ ...f.frame, now: 1000 });
      expectMatrix(f.values.get(1)?.transform, identity);
    } finally { for (const extension of built.extensions) extension.dispose?.(); }
  });

  it("keeps identity while gated off and requires both wishes and the effective report", () => {
    const f = fixture([meta(1, "Layers/RotationLayers/Layer2")]);
    const settings = createMirrorSettings(undefined, "", { storage: null });
    const built = buildStreamExtensions({ settings, interactive: true, presentationWidth: 1920 });
    const decor = built.extensions.find((extension) => extension.id === "couchcoop.decor")!;
    try {
      decor.onSession!(f.session);
      decor.onItemMeta!({ form: "full", items: [meta(1, "Layers/RotationLayers/Layer2")] });
      decor.beforeDraw!(f.frame);
      expect(f.values.size).toBe(0);
      settings.streamDecorFrozen = true;
      decor.beforeDraw!(f.frame);
      expect(f.values.size).toBe(1);
    } finally { for (const extension of built.extensions) extension.dispose?.(); }
  });

  it("clears removed, replaced and reclassified identities without losing another module's override", () => {
    const f = fixture([meta(1, "Layers/RotationLayers/Layer2"), meta(2, "Layers/RotationLayers/Layer3")]);
    f.draw();
    f.overrides.set(999, { visible: false });
    f.extension.onItemsRemoved!(new Uint32Array([1]));
    f.extension.onItemMeta!({ form: "delta", items: [meta(2, "IntentHolder")] });
    f.draw(400);
    expect([...f.values.keys()]).toEqual([999]);
    f.extension.onItemMeta!({ form: "full", items: [meta(3, "Layers/RotationLayers/Layer2")] });
    f.draw(500);
    expect([...f.values.keys()]).toEqual([999, 3]);
    f.extension.onItemMeta!({ form: "full", items: [] });
    f.draw(600);
    expect([...f.values.keys()]).toEqual([999]);
  });
});
