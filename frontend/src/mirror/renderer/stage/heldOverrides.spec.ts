import { describe, expect, it } from "vitest";
import type { MirrorNode } from "@/mirror/sceneTree";
import {
  copyTransformOverrides, overrideAncestors, sameFieldValue, sameNodeExceptTransform, sameTransformOverrides, touchesOverrideLineage
} from "./heldOverrides";

const tree = (links: Record<string, string | null>) =>
  new Map(Object.entries(links).map(([id, parentId]) => [id, { id, parentId } as MirrorNode]));

describe("sameFieldValue", () => {
  it("accepts identical values and rebuilt flat objects or arrays with equal entries", () => {
    const color = { r: 1, g: 0.5, b: 0, a: 1, html: "#ff8000ff" };
    expect(sameFieldValue(color, color)).toBe(true);
    expect(sameFieldValue(color, { ...color })).toBe(true);
    expect(sameFieldValue({ x: 0, y: 0, width: 24, height: 24 }, { x: 0, y: 0, width: 24, height: 24 })).toBe(true);
    expect(sameFieldValue([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameFieldValue(null, null)).toBe(true);
    expect(sameFieldValue(undefined, undefined)).toBe(true);
    expect(sameFieldValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameFieldValue("label", "label")).toBe(true);
  });

  it("refuses a changed value, a changed shape or a different kind", () => {
    const color = { r: 1, g: 1, b: 1, a: 1, html: "#ffffffff" };
    expect(sameFieldValue(color, { ...color, a: 0.5 })).toBe(false);
    expect(sameFieldValue(color, { ...color, extra: 1 })).toBe(false);
    expect(sameFieldValue({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false);
    expect(sameFieldValue(color, null)).toBe(false);
    expect(sameFieldValue(null, color)).toBe(false);
    expect(sameFieldValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameFieldValue([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(sameFieldValue(0, -0)).toBe(false);
    expect(sameFieldValue(1, "1")).toBe(false);
  });

  it("compares one level only: a rebuilt nested object still differs", () => {
    const textColor = { html: "#ffffffff" };
    expect(sameFieldValue({ text: "12", textColor }, { text: "12", textColor })).toBe(true);
    expect(sameFieldValue({ text: "12", textColor }, { text: "12", textColor: { ...textColor } })).toBe(false);
    expect(sameFieldValue([[1, 2]], [[1, 2]])).toBe(false);
  });

  it("refuses non-plain objects that merely share fields", () => {
    class Box { constructor(public w: number) {} }
    expect(sameFieldValue(new Box(1), new Box(1))).toBe(false);
    expect(sameFieldValue(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(false);
  });
});

describe("sameNodeExceptTransform", () => {
  const node = (extra: Record<string, unknown>) =>
    ({ id: "eye", parentId: "stage", transform: [1, 0, 0, 1, 0, 0], modulate: { r: 1, g: 1, b: 1, a: 1, html: "#ffffffff" },
      visible: true, ...extra }) as unknown as MirrorNode;

  it("ignores the transform and rebuilt colour objects", () => {
    expect(sameNodeExceptTransform(node({}), node({ transform: [1, 0, 0, 1, 20, 0] }))).toBe(true);
  });

  it("refuses any other change, including a field only one side has", () => {
    expect(sameNodeExceptTransform(node({}), node({ visible: false }))).toBe(false);
    expect(sameNodeExceptTransform(node({}), node({ modulate: { r: 1, g: 1, b: 1, a: 0.4, html: "#ffffff66" } }))).toBe(false);
    expect(sameNodeExceptTransform(node({}), node({ intentFrames: { fps: 15 } }))).toBe(false);
    expect(sameNodeExceptTransform(node({ intentFrames: { fps: 15 } }), node({}))).toBe(false);
    expect(sameNodeExceptTransform(node({}), node({ canvasBlendMode: undefined }))).toBe(true);
  });
});

describe("transform override banks", () => {
  it("copies by value, so a later in-place sample cannot reach the bank", () => {
    const live = new Map([["card", [1, 0, 0, 1, 10, 20]]]);
    const bank = copyTransformOverrides(live);
    live.get("card")![4] = 11;
    expect(bank.get("card")).toEqual([1, 0, 0, 1, 10, 20]);
    expect(sameTransformOverrides(live, bank)).toBe(false);
  });

  it("matches the same keys with bitwise-equal matrices", () => {
    const bank = new Map([["card", [1, 0, 0, 1, 10, 20]], ["end", [2, 0, 0, 2, 5, 5]]]);
    expect(sameTransformOverrides(new Map([["end", [2, 0, 0, 2, 5, 5]], ["card", [1, 0, 0, 1, 10, 20]]]), bank)).toBe(true);
    expect(sameTransformOverrides(new Map(), new Map())).toBe(true);
  });

  it("refuses a value change, an added key and a removed key", () => {
    const bank = new Map([["card", [1, 0, 0, 1, 10, 20]]]);
    expect(sameTransformOverrides(new Map([["card", [1, 0, 0, 1, 10, 20.000001]]]), bank)).toBe(false);
    expect(sameTransformOverrides(new Map([["card", [1, 0, 0, 1, 10, 20]], ["end", [1, 0, 0, 1, 0, 0]]]), bank)).toBe(false);
    expect(sameTransformOverrides(new Map(), bank)).toBe(false);
    expect(sameTransformOverrides(new Map([["other", [1, 0, 0, 1, 10, 20]]]), bank)).toBe(false);
    expect(sameTransformOverrides(new Map([["card", [1, 0, 0, 1, 10, -0]]]), new Map([["card", [1, 0, 0, 1, 10, 0]]]))).toBe(false);
  });
});

describe("override lineage", () => {
  const nodes = tree({ stage: null, deck: "stage", card: "deck", art: "card", glint: "art", eye: "stage", pupil: "eye" });
  const overrides = new Map([["card", [1, 0, 0, 1, 0, 0]]]);
  const ancestors = overrideAncestors(overrides, nodes);

  it("collects the strict ancestors of every override", () => {
    expect([...ancestors].sort()).toEqual(["deck", "stage"]);
    const two = overrideAncestors(new Map([["card", [1]], ["pupil", [1]]]), nodes);
    expect([...two].sort()).toEqual(["deck", "eye", "stage"]);
  });

  it("flags the override itself, its descendants and its ancestors, and nothing else", () => {
    for (const id of ["card", "art", "glint", "deck", "stage"])
      expect([id, touchesOverrideLineage(id, overrides, ancestors, nodes)]).toEqual([id, true]);
    for (const id of ["eye", "pupil"])
      expect([id, touchesOverrideLineage(id, overrides, ancestors, nodes)]).toEqual([id, false]);
  });

  it("terminates on a malformed parent cycle", () => {
    const cyclic = tree({ a: "b", b: "a", c: null });
    const cycleOverrides = new Map([["a", [1]]]);
    expect([...overrideAncestors(cycleOverrides, cyclic)].sort()).toEqual(["a", "b"]);
    expect(touchesOverrideLineage("c", cycleOverrides, new Set(), cyclic)).toBe(false);
  });
});
