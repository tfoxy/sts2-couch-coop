// HEADLESS RICH TEXT FOR THE STAGE CANVAS.
//
// This module intentionally stops before either DOM creation or raster allocation.  It turns the subset of the
// BBCode grammar that we can reproduce into ordered text/image placements, and names every other construct as a
// refusal.  The strict-canvas capability gate can consequently decide before presentation whether the whole stage
// must use the DOM renderer; there is no per-label DOM escape hatch hidden here.

import { DEFAULT_BBCODE_TAGS } from "@spirectl/presentation/render";
import {
  godotBbcodeTagKind,
  type GodotBbcodeTagDescriptor,
} from "@godot-scene-web/html";

import type { MirrorFont, MirrorNode } from "@/mirror/sceneTree";
import {
  baselineOf,
  type TextLineMetrics,
  type TextSpec,
} from "@/mirror/canvas/textLayout";
import type { ColorValidator } from "@/mirror/canvas/richSimple";
import type { GodotLine } from "@/mirror/textWrap";

export type RichCanvasRole = "normal" | "bold" | "italic" | "bold-italic";

export type RichCanvasRefusal =
  | "unknown-tag"
  | "malformed-tag"
  | "unbalanced-tag"
  | "unsupported-style"
  | "unsupported-effect"
  | "bad-color"
  | "mixed-alignment"
  | "invalid-image-options"
  | "unresolved-image"
  | "unready-font"
  | "invalid-wrap";

export interface RichCanvasFailure {
  ok: false;
  refusal: RichCanvasRefusal;
  detail: string;
}

export interface RichCanvasText {
  kind: "text";
  text: string;
  role: RichCanvasRole;
  color: string | null;
}

export interface RichCanvasImage {
  kind: "image";
  path: string;
  width: number | null;
  height: number | null;
  valign: "top" | "middle" | "bottom";
  region: { x: number; y: number; width: number; height: number } | null;
}

export type RichCanvasItem = RichCanvasText | RichCanvasImage;

export interface RichCanvasParagraph {
  /** The same per-paragraph rule gsw applies to an alignment BBCode region. */
  align: "left" | "center" | "right" | "justify";
  /** Only BBCode alignment blocks use gsw's rich paragraph-spacing custom property. */
  richParagraph: boolean;
  items: readonly RichCanvasItem[];
}

export interface RichCanvasDocument {
  paragraphs: readonly RichCanvasParagraph[];
  /** Markup-stripped text; an inline image occupies one U+FFFC code unit. */
  plainText: string;
}

export type RichCanvasParseResult =
  | { ok: true; value: RichCanvasDocument }
  | RichCanvasFailure;

interface StyleFrame {
  id: string;
  type: "bold" | "italic" | "color" | "align" | "passthrough";
  value?: string;
}

interface ParsedTag {
  close: boolean;
  name: string;
  argument: string;
  argumentHadEquals: boolean;
  raw: string;
}

function tagAt(
  value: string,
  open: number,
): { tag: ParsedTag; end: number } | null {
  const close = value.indexOf("]", open + 1);
  if (close < 0) return null;
  const raw = value.slice(open + 1, close);
  const match = raw.match(
    /^\s*(\/?)\s*([a-zA-Z_][\w-]*)(?:([=\s]+)([\s\S]*))?\s*$/,
  );
  if (!match) return null;
  return {
    tag: {
      close: match[1] === "/",
      name: (match[2] ?? "").toLowerCase(),
      argument: (match[4] ?? "").trim(),
      argumentHadEquals: (match[3] ?? "").includes("="),
      raw,
    },
    end: close + 1,
  };
}

function roleOf(stack: readonly StyleFrame[]): RichCanvasRole {
  const bold = stack.some((entry) => entry.type === "bold");
  const italic = stack.some((entry) => entry.type === "italic");
  if (bold && italic) return "bold-italic";
  return bold ? "bold" : italic ? "italic" : "normal";
}

function colorOf(stack: readonly StyleFrame[]): string | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]?.type === "color") return stack[i]?.value ?? null;
  }
  return null;
}

function alignOf(stack: readonly StyleFrame[]): RichCanvasParagraph["align"] {
  for (let i = stack.length - 1; i >= 0; i--) {
    const value = stack[i]?.type === "align" ? stack[i]?.value : undefined;
    if (value === "fill") return "justify";
    if (value === "left" || value === "center" || value === "right")
      return value;
  }
  return "left";
}

function parseImageOptions(
  argument: string,
): RichCanvasImage | RichCanvasFailure {
  const image: RichCanvasImage = {
    kind: "image",
    path: "",
    width: null,
    height: null,
    valign: "middle",
    region: null,
  };
  let rest = argument;
  if (rest.startsWith("=")) {
    const first = /^=\s*([^\s]+)/.exec(rest);
    if (!first)
      return { ok: false, refusal: "invalid-image-options", detail: argument };
    const token = first[1]!.toLowerCase();
    if (token === "top" || token === "t") image.valign = "top";
    else if (token === "center" || token === "c") image.valign = "middle";
    else if (token === "bottom" || token === "b") image.valign = "bottom";
    else {
      const dimensions = /^(\d+)(?:x(\d+))?$/.exec(token);
      if (
        !dimensions ||
        Number(dimensions[1]) <= 0 ||
        (dimensions[2] !== undefined && Number(dimensions[2]) <= 0)
      ) {
        return { ok: false, refusal: "invalid-image-options", detail: token };
      }
      image.width = Number(dimensions[1]);
      image.height = dimensions[2] === undefined ? null : Number(dimensions[2]);
    }
    rest = rest.slice(first[0].length);
  }
  const option = /([a-zA-Z_]+)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/g;
  for (let match = option.exec(rest); match; match = option.exec(rest)) {
    const key = (match[1] ?? "").toLowerCase();
    const raw = (match[2] ?? "").replace(/^("|')|("|')$/g, "");
    if (key === "width" || key === "height") {
      if (!/^\d+$/.test(raw) || Number(raw) <= 0)
        return {
          ok: false,
          refusal: "invalid-image-options",
          detail: `${key}=${raw}`,
        };
      image[key] = Number(raw);
    } else if (key === "region") {
      const numbers = raw.split(",").map(Number);
      if (
        numbers.length !== 4 ||
        numbers.some((number) => !Number.isFinite(number)) ||
        numbers[2]! <= 0 ||
        numbers[3]! <= 0
      ) {
        return {
          ok: false,
          refusal: "invalid-image-options",
          detail: `region=${raw}`,
        };
      }
      image.region = {
        x: numbers[0]!,
        y: numbers[1]!,
        width: numbers[2]!,
        height: numbers[3]!,
      };
    } else if (key === "valign") {
      if (raw === "top") image.valign = "top";
      else if (raw === "center" || raw === "middle") image.valign = "middle";
      else if (raw === "bottom") image.valign = "bottom";
      else
        return {
          ok: false,
          refusal: "invalid-image-options",
          detail: `valign=${raw}`,
        };
    } else if (key !== "alt") {
      return {
        ok: false,
        refusal: "invalid-image-options",
        detail: `${key}=${raw}`,
      };
    }
  }
  // gsw deliberately ignores unknown image options because HTML can retain them as attributes.  The stage has no
  // equivalent side channel, so accepting a token we did not model would be silently wrong; strict canvas refuses.
  if (rest.replace(option, "").trim().length > 0)
    return { ok: false, refusal: "invalid-image-options", detail: rest };
  return image;
}

/**
 * Parse only the BBCode that the stage can reproduce exactly.  This is deliberately stricter than gsw's HTML
 * parser: a rich label that cannot be described by stage commands is a whole-stage capability failure, never a
 * flattened approximation or a mounted fallback element.
 */
export function parseRichCanvas(
  raw: string,
  options: { tags?: Record<string, unknown>; color?: ColorValidator } = {},
): RichCanvasParseResult {
  const tags = (options.tags ?? DEFAULT_BBCODE_TAGS) as Record<
    string,
    GodotBbcodeTagDescriptor
  >;
  const color = options.color ?? ((value: string) => value.trim() || null);
  const paragraphs: {
    align: RichCanvasParagraph["align"];
    richParagraph: boolean;
    items: RichCanvasItem[];
  }[] = [];
  const stack: StyleFrame[] = [];
  let items: RichCanvasItem[] = [];
  let plainText = "";
  let paragraphAlign = alignOf(stack);
  let paragraphRich = false;
  const fail = (
    refusal: RichCanvasRefusal,
    detail: string,
  ): RichCanvasFailure => ({ ok: false, refusal, detail });

  const commit = (): RichCanvasFailure | null => {
    const nextAlign = alignOf(stack);
    if (nextAlign !== paragraphAlign && items.length > 0)
      return fail("mixed-alignment", "alignment changed inside a paragraph");
    paragraphs.push({
      align: paragraphAlign,
      richParagraph: paragraphRich,
      items,
    });
    items = [];
    paragraphAlign = nextAlign;
    paragraphRich = stack.some((entry) => entry.type === "align");
    return null;
  };
  const text = (value: string): RichCanvasFailure | null => {
    const chunks = value.split(/\r\n|[\r\n]/);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      if (chunk) {
        const nextAlign = alignOf(stack);
        if (nextAlign !== paragraphAlign && items.length > 0)
          return fail(
            "mixed-alignment",
            "alignment changed inside a paragraph",
          );
        paragraphAlign = nextAlign;
        paragraphRich = stack.some((entry) => entry.type === "align");
        const current = items[items.length - 1];
        const role = roleOf(stack);
        const currentColor = colorOf(stack);
        if (
          current?.kind === "text" &&
          current.role === role &&
          current.color === currentColor
        )
          current.text += chunk;
        else
          items.push({ kind: "text", text: chunk, role, color: currentColor });
        plainText += chunk;
      }
      if (i + 1 < chunks.length) {
        const failure = commit();
        if (failure) return failure;
        plainText += "\n";
      }
    }
    return null;
  };
  const close = (
    tag: ParsedTag,
    type: StyleFrame["type"],
  ): RichCanvasFailure | null => {
    const frame = stack[stack.length - 1];
    if (!frame || frame.id !== tag.name || frame.type !== type)
      return fail("unbalanced-tag", `[/${tag.name}]`);
    stack.pop();
    return null;
  };

  for (let index = 0; index < raw.length; ) {
    if (raw[index] !== "[") {
      const next = raw.indexOf("[", index);
      const failure = text(raw.slice(index, next < 0 ? raw.length : next));
      if (failure) return failure;
      index = next < 0 ? raw.length : next;
      continue;
    }
    const parsed = tagAt(raw, index);
    if (!parsed)
      return fail(
        "malformed-tag",
        raw.slice(index, Math.min(raw.length, index + 64)),
      );
    const { tag, end } = parsed;
    const kind = godotBbcodeTagKind(tag.name, tags);
    if (kind === undefined) return fail("unknown-tag", `[${tag.raw}]`);
    if (tag.name === "br") {
      if (tag.close) return fail("malformed-tag", "[/br]");
      const failure = commit();
      if (failure) return failure;
      plainText += "\n";
      index = end;
      continue;
    }
    if (tag.name === "img") {
      if (tag.close) return fail("unbalanced-tag", "[/img] without image");
      const image = parseImageOptions(
        tag.argumentHadEquals ? `=${tag.argument}` : tag.argument,
      );
      if ("ok" in image && !image.ok) return image;
      const next = raw.indexOf("[", end);
      const path = raw.slice(end, next < 0 ? raw.length : next).trim();
      if (!path) return fail("unresolved-image", "empty [img] path");
      const closeImage = next < 0 ? null : tagAt(raw, next);
      if (
        closeImage === null ||
        !closeImage.tag.close ||
        closeImage.tag.name !== "img"
      ) {
        return fail(
          "unbalanced-tag",
          "[img] must be followed by its matching [/img]",
        );
      }
      const nextAlign = alignOf(stack);
      if (nextAlign !== paragraphAlign && items.length > 0)
        return fail("mixed-alignment", "alignment changed inside a paragraph");
      paragraphAlign = nextAlign;
      paragraphRich = stack.some((entry) => entry.type === "align");
      (image as RichCanvasImage).path = path;
      items.push(image as RichCanvasImage);
      plainText += "\ufffc";
      index = closeImage.end;
      continue;
    }
    if (kind === "bold" || kind === "italic") {
      const failure = tag.close
        ? close(tag, kind)
        : (stack.push({ id: tag.name, type: kind }), null);
      if (failure) return failure;
      index = end;
      continue;
    }
    if (kind === "color") {
      if (tag.close) {
        const failure = close(tag, "color");
        if (failure) return failure;
      } else {
        const custom =
          tag.name === "color" || tag.name === "fgcolor"
            ? undefined
            : tags[tag.name];
        const value = custom?.kind === "color" ? custom.value : tag.argument;
        const normalized = color(value);
        if (normalized === null)
          return fail("bad-color", `[${tag.name}=${value}]`);
        stack.push({ id: tag.name, type: "color", value: normalized });
      }
      index = end;
      continue;
    }
    if (kind === "align") {
      const value =
        tag.name === "p"
          ? (
              /align\s*=\s*([a-zA-Z]+)/i.exec(tag.argument)?.[1] ?? "left"
            ).toLowerCase()
          : tag.name;
      // CSS justification is not a left-aligned approximation: it expands every non-final visual line, including
      // colour/role boundaries. Until the stage has that exact per-space placement, reject [fill] up front.
      if (value === "fill") return fail("unsupported-style", `[${tag.raw}]`);
      if (value !== "left" && value !== "center" && value !== "right")
        return fail("unsupported-style", `[${tag.raw}]`);
      const failure = tag.close
        ? close(tag, "align")
        : (stack.push({ id: tag.name, type: "align", value }), null);
      if (failure) return failure;
      index = end;
      continue;
    }
    if (kind === "style" || kind === "effect") {
      const descriptor = tags[tag.name];
      // Two pass-through cases, both of which draw the same words in the same colours as gsw would:
      //   an EMPTY style block  — a span with no declarations, so there is nothing to express;
      //   a CUSTOM effect       — an animation, and this stage has no way to move a placed run. Its characters
      //                           are unchanged, only displaced, so a still rendering of them is right rather
      //                           than approximate. gsw's own BUILT-IN effects are not in this table and keep
      //                           refusing below: those sweep the run's COLOUR too.
      const passThrough =
        descriptor?.kind === "effect" ||
        (descriptor?.kind === "style" &&
          Object.keys(descriptor.css ?? {}).length === 0);
      if (passThrough) {
        const failure = tag.close
          ? close(tag, "passthrough")
          : (stack.push({ id: tag.name, type: "passthrough" }), null);
        if (failure) return failure;
        index = end;
        continue;
      }
    }
    return fail(
      kind === "effect" ? "unsupported-effect" : "unsupported-style",
      `[${tag.raw}]`,
    );
  }
  if (
    stack.some((entry) => entry.type === "align") &&
    alignOf(stack) !== paragraphAlign &&
    items.length > 0
  ) {
    return fail("mixed-alignment", "unclosed alignment changed paragraph");
  }
  if (items.length > 0 || paragraphs.length === 0)
    paragraphs.push({
      align: paragraphAlign,
      richParagraph: paragraphRich,
      items,
    });
  return { ok: true, value: { paragraphs, plainText } };
}

export interface RichCanvasFace {
  role: RichCanvasRole;
  cssFont: string;
  fontPx: number;
  letterSpacingPx: number;
}

export interface RichCanvasFaces {
  normal: RichCanvasFace;
  bold: RichCanvasFace;
  italic: RichCanvasFace;
  "bold-italic": RichCanvasFace;
}

/** Resolve the same role face/size/spacing variables nodeStyles exports for gsw, without creating an element. */
export function resolveRichCanvasFaces(
  node: MirrorNode,
  spec: TextSpec,
): RichCanvasFaces | null {
  const basePx = node.text?.fontSizePx;
  const normalFont = node.font;
  if (normalFont === null || basePx == null || basePx <= 0) return null;
  const scale = spec.fontPx / basePx;
  const faceFor = (
    role: RichCanvasRole,
    font: MirrorFont | null,
    size: number | null,
    spacing: number | null,
  ): RichCanvasFace => {
    if (role === "normal")
      return {
        role,
        cssFont: spec.cssFont,
        fontPx: spec.fontPx,
        letterSpacingPx: 0.25,
      };
    const selected = font ?? normalFont;
    const fontPx = (size ?? basePx) * scale;
    // These are the role rules in gsw base-css.  The font file itself may describe an italic face, but CSS still
    // supplies `font-style: italic`; retaining a streamed `normal` here would choose a different Canvas font.
    const italic =
      role === "italic" || role === "bold-italic" ? "italic" : "normal";
    const weight =
      role === "bold" || role === "bold-italic"
        ? (selected.weight ?? "700")
        : (selected.weight ?? "400");
    return {
      role,
      cssFont: `${italic} ${weight} ${fontPx}px "${selected.family}"`
        .replace(/\s+/g, " ")
        .trim(),
      fontPx,
      letterSpacingPx:
        spacing ?? (role === "italic" || role === "bold-italic" ? 0.175 : 0.25),
    };
  };
  return {
    normal: faceFor("normal", null, null, null),
    bold: faceFor(
      "bold",
      node.richBoldFont,
      node.richBoldFontSizePx,
      node.richBoldFontSpacingPx,
    ),
    italic: faceFor(
      "italic",
      node.richItalicFont,
      node.richItalicFontSizePx,
      node.richItalicFontSpacingPx,
    ),
    "bold-italic": faceFor(
      "bold-italic",
      node.richBoldItalicFont,
      node.richBoldItalicFontSizePx,
      node.richBoldItalicFontSpacingPx,
    ),
  };
}

export interface RichCanvasImageSize {
  width: number;
  height: number;
}
export interface RichCanvasPlacedText extends RichCanvasText {
  x: number;
  baseline: number;
  width: number;
  face: RichCanvasFace;
}
export interface RichCanvasPlacedImage extends RichCanvasImage {
  x: number;
  y: number;
  drawWidth: number;
  drawHeight: number;
}
export type RichCanvasPlacement = RichCanvasPlacedText | RichCanvasPlacedImage;
export interface RichCanvasLayout {
  lines: readonly {
    width: number;
    y: number;
    items: readonly RichCanvasPlacement[];
  }[];
  width: number;
  height: number;
}
export type RichCanvasLayoutResult =
  | { ok: true; value: RichCanvasLayout }
  | RichCanvasFailure;

export interface RichCanvasLayoutOptions {
  width: number;
  pitchPx: number;
  paragraphGapPx: number;
  faces: RichCanvasFaces;
  /** Return null until the exact face is ready; a fallback face is never acceptable in strict canvas. */
  measure: (
    face: RichCanvasFace,
    text: string,
  ) => { width: number; metrics: TextLineMetrics } | null;
  /** Resolves an image without mounting it. A loaded ImageBitmap/atlas source is supplied later by the stage. */
  imageSize: (path: string) => RichCanvasImageSize | null;
  /** Validated producer line offsets for this document's markup-stripped text, when the wire provided them. */
  godotLines?: readonly GodotLine[] | null;
}

/**
 * Validate the producer's own rich-text line ranges against the exact U+FFFC-bearing source this parser produced.
 * Callers must not slice a stale wire wrap: a failed check is a capability refusal, not a guessed line break.
 */
export function validateRichCanvasWrap(
  document: RichCanvasDocument,
  lines: readonly GodotLine[],
): RichCanvasFailure | null {
  let previous = 0;
  for (const line of lines) {
    if (
      line.start < previous ||
      (previous === 0 && line.start !== 0) ||
      line.end < line.start ||
      line.end > document.plainText.length ||
      (line.start > previous &&
        !/^(?:\r\n|\r|\n)+$/.test(
          document.plainText.slice(previous, line.start),
        )) ||
      document.plainText.slice(line.start, line.end) !== line.text
    ) {
      return {
        ok: false,
        refusal: "invalid-wrap",
        detail: `${line.start}:${line.end}`,
      };
    }
    previous = line.end;
  }
  if (previous !== document.plainText.length) {
    return {
      ok: false,
      refusal: "invalid-wrap",
      detail: `trailing:${previous}:${document.plainText.length}`,
    };
  }
  return null;
}

function spacedWidth(
  measure: RichCanvasLayoutOptions["measure"],
  face: RichCanvasFace,
  text: string,
): { width: number; metrics: TextLineMetrics } | null {
  const result = measure(face, text);
  if (result === null) return null;
  return {
    ...result,
    width:
      result.width +
      Math.max(0, Array.from(text).length - 1) * face.letterSpacingPx,
  };
}

/**
 * Lay parsed BBCode into painter-order placements.  Images are placements, not pixels baked into a DOM wrapper;
 * the integration converts each one to a stage texture quad immediately after the preceding text placement.
 */
export function layoutRichCanvas(
  document: RichCanvasDocument,
  options: RichCanvasLayoutOptions,
): RichCanvasLayoutResult {
  const lines: { width: number; y: number; items: RichCanvasPlacement[] }[] =
    [];
  let y = 0;
  let widest = 0;
  const fail = (
    refusal: RichCanvasRefusal,
    detail: string,
  ): RichCanvasFailure => ({ ok: false, refusal, detail });
  const suppliedLines = options.godotLines ?? null;
  if (suppliedLines !== null) {
    const invalid = validateRichCanvasWrap(document, suppliedLines);
    if (invalid) return invalid;
  }
  const forcedEnds = new Set(
    (suppliedLines ?? []).slice(0, -1).map((line) => line.end),
  );
  const useProducerWrap = suppliedLines !== null;
  let sourceAt = 0;
  for (let p = 0; p < document.paragraphs.length; p++) {
    const paragraph = document.paragraphs[p]!;
    let line: RichCanvasPlacement[] = [];
    let lineWidth = 0;
    // Deliberately mirrors the old token-by-token wrap candidate. `lineWidth` is exact display width (including
    // inter-token letter spacing); this separate running value keeps a spacing fix from changing where the legacy
    // greedy breaker decides to wrap.
    let wrapWidth = 0;
    let lineMetrics: TextLineMetrics | null = null;
    const finish = (): RichCanvasFailure | null => {
      const metrics =
        lineMetrics ?? options.measure(options.faces.normal, "M")?.metrics;
      if (!metrics) return fail("unready-font", options.faces.normal.cssFont);
      const free = Math.max(0, options.width - lineWidth);
      const offset =
        paragraph.align === "center"
          ? free / 2
          : paragraph.align === "right"
            ? free
            : 0;
      // Vertical placement cannot be fixed when a run is appended: a later role can carry a larger streamed face,
      // changing the shared CSS line box. Finalize every baseline/image against the line's MAX metrics here.
      const baseline = baselineOf(y, options.pitchPx, metrics);
      for (const item of line) {
        item.x += offset;
        if (item.kind === "text") {
          item.baseline = baseline;
        } else {
          item.y =
            item.valign === "top"
              ? y
              : item.valign === "bottom"
                ? baseline - item.drawHeight
                : baseline -
                  item.drawHeight / 2 -
                  0.094 * options.faces.normal.fontPx;
        }
      }
      lines.push({ width: lineWidth, y, items: line });
      widest = Math.max(widest, lineWidth);
      y += options.pitchPx;
      line = [];
      lineWidth = 0;
      wrapWidth = 0;
      lineMetrics = null;
      return null;
    };
    const addText = (
      source: RichCanvasText,
      token: string,
      continuesRun: boolean,
    ): RichCanvasFailure | null => {
      if (!token) return null;
      const face = options.faces[source.role];
      const sized = spacedWidth(options.measure, face, token);
      if (!sized) return fail("unready-font", face.cssFont);
      // A wire wrap is the engine's exclusive answer.  Do not add a browser-style break just because this canvas
      // is narrower: that would draw a different sequence of words than the producer selected.
      if (
        !useProducerWrap &&
        line.length > 0 &&
        !/^\s+$/.test(token) &&
        wrapWidth + sized.width > options.width
      ) {
        const failure = finish();
        if (failure) return failure;
      }
      const metrics = sized.metrics;
      if (
        !lineMetrics ||
        metrics.ascent + metrics.descent >
          lineMetrics.ascent + lineMetrics.descent
      )
        lineMetrics = metrics;
      // Canvas's letter spacing belongs BETWEEN adjacent glyphs, not inside arbitrary lexer tokens. The normal
      // `ab` / ` ` / `cd` split therefore needs two extra gaps to retain the single-run advance of `ab cd`.
      // A producer endpoint has already called finish(), so it correctly starts a new visual line with no gap.
      const boundary =
        continuesRun && line.length > 0 ? face.letterSpacingPx : 0;
      line.push({
        ...source,
        text: token,
        face,
        x: lineWidth + boundary,
        baseline: baselineOf(y, options.pitchPx, metrics),
        width: sized.width,
      });
      lineWidth += boundary + sized.width;
      wrapWidth += sized.width;
      return null;
    };
    for (const item of paragraph.items) {
      if (item.kind === "text") {
        // Preserve whitespace but only make a soft-wrap decision at the same spaces/hyphens as textLayout.
        const tokens = item.text.split(/(?<=[\s-])|(?=[\s-])/u);
        let continuesItem = false;
        for (const token of tokens) {
          let tokenAt = 0;
          // A streamed break may sit inside a run (for example, a coloured word). Split only at that supplied
          // UTF-16 offset; it is the engine's decision, not a second greedy wrapping rule.
          while (tokenAt < token.length) {
            let next = token.length;
            for (const end of forcedEnds) {
              if (end > sourceAt && end < sourceAt + token.length - tokenAt)
                next = Math.min(next, end - sourceAt);
            }
            const part = token.slice(tokenAt, tokenAt + next);
            const failure = addText(item, part, continuesItem);
            if (failure) return failure;
            tokenAt += part.length;
            sourceAt += part.length;
            continuesItem = true;
            if (forcedEnds.has(sourceAt)) {
              const forced = finish();
              if (forced) return forced;
            }
          }
        }
      } else {
        const source = options.imageSize(item.path);
        if (!source) return fail("unresolved-image", item.path);
        const drawWidth =
          item.width ??
          (item.height
            ? (source.width * item.height) / source.height
            : source.width);
        const drawHeight =
          item.height ??
          (item.width
            ? (source.height * item.width) / source.width
            : source.height);
        if (!(drawWidth > 0 && drawHeight > 0))
          return fail("invalid-image-options", item.path);
        if (
          !useProducerWrap &&
          line.length > 0 &&
          wrapWidth + drawWidth > options.width
        ) {
          const failure = finish();
          if (failure) return failure;
        }
        const normal = options.measure(options.faces.normal, "M");
        if (!normal) return fail("unready-font", options.faces.normal.cssFont);
        lineMetrics ??= normal.metrics;
        const baseline = baselineOf(y, options.pitchPx, normal.metrics);
        const top =
          item.valign === "top"
            ? y
            : item.valign === "bottom"
              ? baseline - drawHeight
              : baseline - drawHeight / 2 - 0.094 * options.faces.normal.fontPx;
        line.push({ ...item, x: lineWidth, y: top, drawWidth, drawHeight });
        lineWidth += drawWidth;
        wrapWidth += drawWidth;
        sourceAt += 1; // U+FFFC in RichCanvasDocument.plainText
        if (forcedEnds.has(sourceAt)) {
          const forced = finish();
          if (forced) return forced;
        }
      }
    }
    if (line.length > 0 || paragraph.items.length === 0) {
      const failure = finish();
      if (failure) return failure;
    }
    if (p + 1 < document.paragraphs.length && paragraph.richParagraph)
      y += options.paragraphGapPx;
    if (p + 1 < document.paragraphs.length) sourceAt += 1; // parser's explicit newline separator
  }
  return { ok: true, value: { lines, width: widest, height: y } };
}
