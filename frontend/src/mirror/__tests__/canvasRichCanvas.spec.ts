import { describe, expect, it } from "vitest";

import {
  layoutRichCanvas,
  parseRichCanvas,
  resolveRichCanvasFaces,
  validateRichCanvasWrap,
  type RichCanvasFace,
  type RichCanvasFaces,
} from "@/mirror/canvas/richCanvas";
import type { TextSpec } from "@/mirror/canvas/textLayout";
import type { MirrorNode } from "@/mirror/sceneTree";

const color = (value: string) =>
  /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;

const faces: RichCanvasFaces = (
  ["normal", "bold", "italic", "bold-italic"] as const
).reduce((out, role) => {
  out[role] = {
    role,
    cssFont: `${role} 20px Face`,
    fontPx: 20,
    letterSpacingPx: 0,
  };
  return out;
}, {} as RichCanvasFaces);

const layout = (raw: string, width = 100) => {
  const parsed = parseRichCanvas(raw, { color });
  if (!parsed.ok) return parsed;
  return layoutRichCanvas(parsed.value, {
    width,
    pitchPx: 24,
    paragraphGapPx: 4,
    faces,
    measure: (face: RichCanvasFace, text: string) => ({
      width: text.length * (face.role === "bold" ? 12 : 10),
      metrics: { ascent: 16, descent: 4 },
    }),
    imageSize: (path) =>
      path === "res://orb.png" ? { width: 16, height: 16 } : null,
  });
};

describe("strict-canvas rich BBCode parser", () => {
  it("keeps role-correct runs and nested colour in original painter order", () => {
    const parsed = parseRichCanvas(
      "[center]a[b]B[i][color=#ff0000]C[/color][/i][/b]d[/center]",
      { color },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.paragraphs).toEqual([
      {
        align: "center",
        richParagraph: true,
        items: [
          { kind: "text", text: "a", role: "normal", color: null },
          { kind: "text", text: "B", role: "bold", color: null },
          { kind: "text", text: "C", role: "bold-italic", color: "#ff0000" },
          { kind: "text", text: "d", role: "normal", color: null },
        ],
      },
    ]);
  });

  it("creates an inline image item rather than a mounted element", () => {
    const parsed = parseRichCanvas(
      "Gain [img=12x8 valign=bottom region=1,2,3,4]res://orb.png[/img].",
      { color },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.plainText).toBe("Gain \ufffc.");
    expect(parsed.value.paragraphs[0]?.items[1]).toEqual({
      kind: "image",
      path: "res://orb.png",
      width: 12,
      height: 8,
      valign: "bottom",
      region: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(typeof document.querySelector(".godot-rich-img")).toBe("object");
    expect(document.querySelector(".godot-rich-img")).toBeNull();
  });

  it("distinguishes compact image dimensions from named image options", () => {
    const compact = parseRichCanvas("[img=12x8]res://orb.png[/img]", { color });
    const named = parseRichCanvas(
      "[img width=12 height=8 valign=top]res://orb.png[/img]",
      { color },
    );
    expect(compact.ok && compact.value.paragraphs[0]?.items[0]).toMatchObject({
      kind: "image",
      width: 12,
      height: 8,
      valign: "middle",
    });
    expect(named.ok && named.value.paragraphs[0]?.items[0]).toMatchObject({
      kind: "image",
      width: 12,
      height: 8,
      valign: "top",
    });
  });

  it("splits explicit newlines into rich paragraphs while retaining alignment", () => {
    const parsed = parseRichCanvas("[right]one\ntwo[/right]", { color });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.paragraphs.map((paragraph) => paragraph.align)).toEqual(
      ["right", "right"],
    );
    expect(
      parsed.value.paragraphs.map(
        (paragraph) => (paragraph.items[0] as { text: string }).text,
      ),
    ).toEqual(["one", "two"]);
  });

  it.each([
    ["[u]x[/u]", "unsupported-style"],
    ["[wave]x[/wave]", "unsupported-effect"],
    ["[fill]x[/fill]", "unsupported-style"],
    ["[img mystery]res://orb.png[/img]", "invalid-image-options"],
    ["[not_a_tag]x[/not_a_tag]", "unknown-tag"],
    ["[color=nope]x[/color]", "bad-color"],
    ["[b]x[/i]", "unbalanced-tag"],
  ])("fails closed for %s", (raw, refusal) => {
    const result = parseRichCanvas(raw, { color });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe(refusal);
  });

  it("rejects standalone and duplicate image closing tags", () => {
    for (const raw of ["x[/img]", "[img]res://orb.png[/img][/img]"]) {
      const result = parseRichCanvas(raw, { color });
      expect(result).toMatchObject({ ok: false, refusal: "unbalanced-tag" });
    }
  });
});

describe("strict-canvas rich layout", () => {
  it("wraps between runs and preserves the text/image painter sequence", () => {
    const result = layout(
      "[b]bold[/b] [img=16x16]res://orb.png[/img] tail",
      50,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines).toHaveLength(3);
    expect(
      result.value.lines.flatMap((line) => line.items.map((item) => item.kind)),
    ).toEqual(["text", "text", "image", "text", "text"]);
    expect(result.value.lines[0]?.items[0]).toMatchObject({
      role: "bold",
      x: 0,
    });
    expect(result.value.lines[1]?.items[0]).toMatchObject({
      kind: "image",
      drawWidth: 16,
      drawHeight: 16,
    });
  });

  it("does not turn an unready resource into a DOM fallback", () => {
    const result = layout("[img]res://missing.png[/img]");
    expect(result).toMatchObject({ ok: false, refusal: "unresolved-image" });
  });

  it("replays validated producer wrap offsets across a rich run", () => {
    const parsed = parseRichCanvas("[b]abc[/b] def", { color });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = layoutRichCanvas(parsed.value, {
      width: 200,
      pitchPx: 24,
      paragraphGapPx: 0,
      faces,
      measure: (_face, text) => ({
        width: text.length * 10,
        metrics: { ascent: 16, descent: 4 },
      }),
      imageSize: () => null,
      godotLines: [
        { start: 0, end: 2, text: "ab" },
        { start: 2, end: 7, text: "c def" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.lines.map((line) =>
        line.items
          .map((item) => (item.kind === "text" ? item.text : "\ufffc"))
          .join(""),
      ),
    ).toEqual(["ab", "c def"]);
  });

  it("does not add greedy breaks when producer wrap offsets are present", () => {
    const parsed = parseRichCanvas("[b]abcdef[/b] ghijkl", { color });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = layoutRichCanvas(parsed.value, {
      width: 20,
      pitchPx: 24,
      paragraphGapPx: 0,
      faces,
      measure: (_face, text) => ({
        width: text.length * 10,
        metrics: { ascent: 16, descent: 4 },
      }),
      imageSize: () => null,
      godotLines: [
        { start: 0, end: 6, text: "abcdef" },
        { start: 6, end: 13, text: " ghijkl" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.lines.map((line) =>
        line.items
          .map((item) => (item.kind === "text" ? item.text : "\ufffc"))
          .join(""),
      ),
    ).toEqual(["abcdef", " ghijkl"]);
  });

  it("retains letter spacing across whitespace tokenizer boundaries", () => {
    const parsed = parseRichCanvas("ab cd", { color });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const spacedFaces = {
      ...faces,
      normal: { ...faces.normal, letterSpacingPx: 2 },
    };
    const result = layoutRichCanvas(parsed.value, {
      width: 200,
      pitchPx: 24,
      paragraphGapPx: 0,
      faces: spacedFaces,
      measure: (_face, text) => ({
        width: text.length * 10,
        metrics: { ascent: 16, descent: 4 },
      }),
      imageSize: () => null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const items = result.value.lines[0]?.items;
    expect(items).toMatchObject([
      { kind: "text", text: "ab", x: 0, width: 22 },
      { kind: "text", text: " ", x: 24, width: 10 },
      { kind: "text", text: "cd", x: 36, width: 22 },
    ]);
    expect(result.value.lines[0]?.width).toBe(58);
  });

  it("does not invent an inter-line letter-space at a forced producer endpoint", () => {
    const parsed = parseRichCanvas("abcd", { color });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = layoutRichCanvas(parsed.value, {
      width: 200,
      pitchPx: 24,
      paragraphGapPx: 0,
      faces: { ...faces, normal: { ...faces.normal, letterSpacingPx: 2 } },
      measure: (_face, text) => ({
        width: text.length * 10,
        metrics: { ascent: 16, descent: 4 },
      }),
      imageSize: () => null,
      godotLines: [
        { start: 0, end: 2, text: "ab" },
        { start: 2, end: 4, text: "cd" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.lines.map((line) => [line.width, line.items[0]?.x]),
    ).toEqual([
      [22, 0],
      [22, 0],
    ]);
  });

  it("finalizes every role and inline image against the largest line metric", () => {
    const parsed = parseRichCanvas(
      "a[img=8x8 valign=bottom]res://orb.png[/img][b]B[/b]",
      { color },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = layoutRichCanvas(parsed.value, {
      width: 200,
      pitchPx: 30,
      paragraphGapPx: 0,
      faces,
      measure: (face, text) => ({
        width: text.length * 10,
        metrics:
          face.role === "bold"
            ? { ascent: 24, descent: 6 }
            : { ascent: 16, descent: 4 },
      }),
      imageSize: () => ({ width: 8, height: 8 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const items = result.value.lines[0]?.items ?? [];
    expect(
      items.filter((item) => item.kind === "text").map((item) => item.baseline),
    ).toEqual([24, 24]);
    expect(items.find((item) => item.kind === "image")).toMatchObject({
      y: 16,
    });
  });

  it("accepts only hard-newline gaps and complete producer wrap coverage", () => {
    const parsed = parseRichCanvas("ab\ncd", { color });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      validateRichCanvasWrap(parsed.value, [
        { start: 0, end: 2, text: "ab" },
        { start: 3, end: 5, text: "cd" },
      ]),
    ).toBeNull();
    expect(
      validateRichCanvasWrap(parsed.value, [
        { start: 0, end: 2, text: "ab" },
        { start: 4, end: 5, text: "d" },
      ]),
    ).toMatchObject({ refusal: "invalid-wrap" });
    expect(
      validateRichCanvasWrap(parsed.value, [{ start: 0, end: 2, text: "ab" }]),
    ).toMatchObject({ refusal: "invalid-wrap" });
    expect(
      validateRichCanvasWrap(parsed.value, [
        { start: 0, end: 2, text: "xx" },
        { start: 3, end: 5, text: "cd" },
      ]),
    ).toMatchObject({ refusal: "invalid-wrap" });
  });

  it("counts each final line and each inter-paragraph gap exactly once", () => {
    const single = layout("one");
    expect(single.ok && single.value.height).toBe(24);
    const parsed = parseRichCanvas("[right]one\ntwo[/right]", { color });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const multiple = layoutRichCanvas(parsed.value, {
      width: 100,
      pitchPx: 24,
      paragraphGapPx: 4,
      faces,
      measure: (_face, text) => ({
        width: text.length * 10,
        metrics: { ascent: 16, descent: 4 },
      }),
      imageSize: () => null,
    });
    expect(multiple.ok && multiple.value.height).toBe(52);
  });
});

describe("rich role faces", () => {
  it("uses the streamed bold/italic faces, sizes and glyph spacing", () => {
    const node = {
      font: {
        family: "Regular",
        url: "/regular.ttf",
        weight: "400",
        style: "normal",
      },
      richBoldFont: {
        family: "Bold",
        url: "/bold.ttf",
        weight: "700",
        style: "normal",
      },
      richItalicFont: {
        family: "Italic",
        url: "/italic.ttf",
        weight: "400",
        style: "italic",
      },
      richBoldItalicFont: {
        family: "BoldItalic",
        url: "/bi.ttf",
        weight: "700",
        style: "italic",
      },
      richBoldFontSizePx: 24,
      richItalicFontSizePx: null,
      richBoldItalicFontSizePx: null,
      richBoldFontSpacingPx: 1,
      richItalicFontSpacingPx: null,
      richBoldItalicFontSpacingPx: null,
      text: { fontSizePx: 20 },
    } as unknown as MirrorNode;
    const spec = {
      cssFont: 'normal 400 30px "Regular"',
      fontPx: 30,
    } as TextSpec;
    const resolved = resolveRichCanvasFaces(node, spec);
    expect(resolved?.bold).toMatchObject({
      cssFont: 'normal 700 36px "Bold"',
      fontPx: 36,
      letterSpacingPx: 1,
    });
    expect(resolved?.italic).toMatchObject({
      cssFont: 'italic 400 30px "Italic"',
      fontPx: 30,
      letterSpacingPx: 0.175,
    });
  });
});
