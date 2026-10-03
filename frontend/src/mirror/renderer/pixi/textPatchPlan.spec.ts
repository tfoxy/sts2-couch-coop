import { describe, expect, it } from "vitest";
import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import type { MirrorNode } from "@/mirror/sceneTree";
import { planTextPatch, textOnlyChange, type TextPatchContext } from "./textPatchPlan";

const label = (fields: Record<string, unknown> = {}): MirrorNode => ({
  id: "clock", parentId: "bar", visible: true, transform: [1, 0, 0, 1, 10, 4],
  localRect: { x: 0, y: 0, width: 80, height: 32 }, anchors: [0, 0, 1, 1],
  text: { text: "04:00", colorHtml: "#efc851ff", fontSizePx: 32, halign: "center", valign: "center",
    outlineColorHtml: "#192930ff", outlineSize: 12 },
  textWrap: null, ...fields,
} as unknown as MirrorNode);
const withText = (text: string, extra: Record<string, unknown> = {}) =>
  label({ text: { ...(label().text as object), text }, ...extra });

describe("textOnlyChange", () => {
  it("accepts a change of the label's text and its measured wrap only", () => {
    expect(textOnlyChange(label(), withText("04:01"))).toBe(true);
    expect(textOnlyChange(label(), withText("04:01", { textWrap: { lines: [{ start: 0, end: 5 }], basis: "text",
      parsedText: null, sourceLength: 5, sourceHash: 1 } }))).toBe(true);
    // A text object rebuilt with the same values is no change at all.
    expect(textOnlyChange(label(), withText("04:00"))).toBe(false);
  });

  it("refuses text plus any other field: visibility, size, anchors, transform", () => {
    expect(textOnlyChange(label(), withText("04:01", { visible: false }))).toBe(false);
    expect(textOnlyChange(label(), withText("04:01", { localRect: { x: 0, y: 0, width: 96, height: 32 } }))).toBe(false);
    expect(textOnlyChange(label(), withText("04:01", { anchors: [0, 0, 0.5, 1] }))).toBe(false);
    expect(textOnlyChange(label(), withText("04:01", { transform: [1, 0, 0, 1, 12, 4] }))).toBe(false);
  });

  it("refuses a node gaining or losing its text, and a container that resizes to its label", () => {
    expect(textOnlyChange(label({ text: null }), label())).toBe(false);
    expect(textOnlyChange(label(), label({ text: null }))).toBe(false);
    // The container's own delta is a size change, never a text-only one: it keeps the patch on its usual rules.
    const box = { id: "bar", parentId: null, text: null, localRect: { x: 0, y: 0, width: 80, height: 32 } };
    expect(textOnlyChange(box as unknown as MirrorNode,
      { ...box, localRect: { x: 0, y: 0, width: 96, height: 32 } } as unknown as MirrorNode)).toBe(false);
  });
});

describe("planTextPatch", () => {
  const record = (key: string, text: string, extra: Record<string, unknown> = {}) =>
    ({ key, insertionIndex: 3, text, transform: [1, 0, 0, 1, 10, 4], labelId: "clock", style: {}, ...extra } as PixiTextRecord);
  const committed = new Map([["clock:0:0", record("clock:0:0", "04:00", { parentId: "static:bar" })]]);
  const context = (overrides: Partial<TextPatchContext> = {}): TextPatchContext => ({
    keysOf: (id) => (id === "clock" ? ["clock:0:0"] : undefined),
    committedText: (key) => committed.get(key),
    built: (id) => id === "clock",
    orderOf: (id) => (id === "clock" ? 5 : undefined),
    movedSpans: [],
    textPatchable: () => true,
    underOverride: () => false,
    sampled: new Set(),
    committedAlpha: () => false,
    prepare: () => ({ records: [record("clock:0:0", "04:01")] }),
    ...overrides,
  });

  it("re-prepares an untouched label and keeps the group the composition stamped", () => {
    const planned = planTextPatch(["clock"], context());
    expect(Array.isArray(planned)).toBe(true);
    expect(planned).toEqual([{ ...record("clock:0:0", "04:01"), parentId: "static:bar" }]);
  });

  it("names each refusal", () => {
    expect(planTextPatch(["other"], context())).toBe("text-not-drawn");
    // Empty -> non-empty: the committed build drew no records for an empty label.
    expect(planTextPatch(["clock"], context({ keysOf: () => [] }))).toBe("text-not-drawn");
    expect(planTextPatch(["clock"], context({ built: () => false }))).toBe("text-not-drawn");
    // A wire change in this frame moves the label's span (an ancestor moved).
    expect(planTextPatch(["clock"], context({ movedSpans: [{ start: 4, end: 9 }] }))).toBe("text-span");
    expect(planTextPatch(["clock"], context({ movedSpans: [{ start: 6, end: 9 }] }))).not.toBe("text-span");
    // A committed patch moved it, or it sits in a local-animation root's span (`textPatchable`).
    expect(planTextPatch(["clock"], context({ textPatchable: () => false }))).toBe("text-moved");
    expect(planTextPatch(["clock"], context({ underOverride: () => true }))).toBe("text-under-override");
    // This frame's patch already samples the record (an alpha fade or a move)...
    expect(planTextPatch(["clock"], context({ sampled: new Set(["text:clock:0:0"]) }))).toBe("text-sampled");
    // ...versus an alpha a committed patch changed since the build.
    expect(planTextPatch(["clock"], context({ committedAlpha: () => true }))).toBe("text-alpha");
    expect(planTextPatch(["clock"], context({ prepare: () => ({ refusal: "font-pending" }) }))).toBe("text-prep:font-pending");
    // Non-empty -> empty, or a wrap that adds a line or a run: a different record shape.
    expect(planTextPatch(["clock"], context({ prepare: () => ({ records: [] }) }))).toBe("text-shape");
    expect(planTextPatch(["clock"], context({ prepare: () => ({ records: [record("clock:0:0", "04:"),
      record("clock:1:0", "01")] }) }))).toBe("text-shape");
    expect(planTextPatch(["clock"], context({ prepare: () => ({ records: [record("clock:0:1", "04:01")] }) })))
      .toBe("text-shape");
    expect(planTextPatch(["clock"], context({ prepare: () => ({ records: [record("clock:0:0", "￼",
      { inlineImage: { url: "/res/x.png", width: 8, height: 8 } })] }) }))).toBe("text-shape");
  });
});
