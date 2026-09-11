// M4 — THE PURE HALF OF CANVAS TEXT: what to draw, where, and when to refuse.
//
// Nothing here touches a canvas, a font, or the DOM. `resolveTextSpec` turns a node plus its resolved text-scale
// declarations into a RASTER DESCRIPTOR, and `layoutText` breaks that descriptor's string into placed lines
// against a `measure` callback the caller supplies. The rasterizer (`textSurfaces.ts`) owns the 2D context; this
// module owns the rules, which is what makes them testable without one.
//
// THE PARITY TARGET IS THE DOM BACKEND'S OWN RENDERING, not Godot's. That is a deliberate choice and it is the
// cheapest correct one: the DOM stage renders a label as `.mirror-text { display:flex; white-space:pre-wrap;
// line-height:1.1 }` around an inline span styled by `nodeStyles.textStyle`, and the browser shapes it. A canvas
// raster uses the SAME rasterizer on the SAME font at the SAME size, so glyph shaping, kerning and hinting agree
// by construction and only the box model has to be reproduced. Reimplementing shaping would be a different
// project with a worse result.
//
// WHAT THE WIRE DOES NOT CARRY, measured (scripts/probe-text-census.mjs, all six standard screens): `autowrap_mode`
// and `clip_text` are not streamed at all, and `text.layout.lines` — Godot's own wrap result — arrives EMPTY in
// every one of 1,650 text upserts. There is therefore no wrap oracle to match. `white-space: pre-wrap` over the
// streamed box IS the specification, and the greedy line breaker below reproduces THAT rather than Godot's.
//
// THE FOUR REFUSALS, and why refusing is a feature. A refused label stays on the DOM overlay and renders exactly
// as it does today, so a refusal costs one hoisted element and never a wrong word. Wrong wrapping is wrong WORDS,
// which is the one failure mode a text path must not ship:
//   * RICH — this round's scope line. A `[b]` span swaps to a different font FILE and `[img]` embeds a real
//     inline image; both are gsw's `richTextLayeredHtml` doing DOM layout, and reproducing them on a canvas is
//     separate work.
//   * `text-wrap: balance` — the two reward-row rules ask the browser to re-balance line lengths after wrapping,
//     which is a different (and unspecified) algorithm from greedy. Guessing would move words between lines.
//   * UNBREAKABLE SCRIPTS — CJK/Thai/kana have no spaces and break on character or dictionary rules. A greedy
//     space-breaker does not wrap them at all; it overflows the box silently. Zero across the recorded set, which
//     is why this is a guard rather than a feature.
//   * NO STREAMED FACE — with no family there is nothing to ask the browser for, and `textStyle` correspondingly
//     emits no `font-family` and lets the element inherit. Also zero across the set.

import { OUTLINE_SCALE } from "@/mirror/nodeStyles";
import type { MirrorNode } from "@/mirror/sceneTree";
import type { TextScaleDecls } from "@/mirror/textScaleClasses";
import { godotLines, type GodotLine } from "@/mirror/textWrap";

/** `.mirror-text { line-height: 1.1 }` — the DOM stage's own pitch, and an ABSOLUTE multiple of the font size.
 *
 *  NOT derived from the font's own height the way the native client derives it. Godot's `line_spacing` is EXTRA
 *  space added to a font-metric line box, so the native port has to read `font.GetHeight()` and subtract; CSS
 *  `line-height` is the whole pitch. Porting Godot's derivation here would reproduce the native client's number
 *  and diverge from the browser's — and the browser is what this backend is trying to match. */
export const LINE_PITCH_RATIO = 1.1;

/** Why this label cannot be rastered. See the module header — each one keeps it on the DOM overlay, correct. */
export type TextRefusal = "rich" | "balance" | "unbreakable" | "no-font";

/** Scripts a greedy space-breaking wrapper cannot break. Same set the offline census counts. */
const UNBREAKABLE = /[ᄀ-ᇿ⺀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯฀-๿]/;

export interface TextShadowSpec {
  dx: number;
  dy: number;
  color: string;
}

/**
 * ONE LABEL'S RASTER DESCRIPTOR — everything that changes its PIXELS, and nothing that does not.
 *
 * The exclusions are the design, not an oversight. The node's TINT and OPACITY are not here because a fading
 * label is the same pixels at a different quad colour, premultiplied at draw time — baking them would mint a
 * texture per frame of every fade. The node's TRANSFORM is not here because the quad's matrix carries it. The box
 * HEIGHT and the VERTICAL alignment are not here because they place the ink block, which is again the matrix.
 * What IS here includes the box WIDTH, because a wrap depends on it: the same string in two differently-sized
 * boxes is two different rasters.
 */
export interface TextSpec {
  text: string;
  /** The canvas2D `font` shorthand — `<style> <weight> <px>px "<family>"`. The raster key's most important field. */
  cssFont: string;
  family: string;
  fontPx: number;
  color: string;
  /** ALREADY multiplied by `OUTLINE_SCALE`: the width to hand `strokeText`, not the streamed one. 0 for none. */
  outlinePx: number;
  outlineColor: string | null;
  shadow: TextShadowSpec | null;
  /** Alignment of each LINE within the text block. */
  align: "left" | "center" | "right" | "justify";
  /** Placement of the BLOCK within the box — the flex `justify-content` half. */
  blockAlign: "start" | "center" | "end";
  /** Placement of the block on the VERTICAL axis — `align-items`. Pure placement; not in the raster key. */
  blockAlignY: "start" | "center" | "end";
  boxW: number;
  boxH: number;
  /** The width lines actually wrap against: `boxW` less any `padding-right` the scale table applied. */
  contentW: number;
  /**
   * Absolute WRAPPED-line pitch in px. `LINE_PITCH_RATIO * fontPx` unless the scale table overrode it.
   *
   * TWO DECLARATIONS CAN OVERRIDE IT and they are not interchangeable — see `resolveTextSpec`. A plain
   * `line-height` on the `.mirror-text` child is the End-Turn precedent; `--godot-rich-line-height` on the node
   * is the card-description one, which gsw reads as a raw `line-height` on each `.godot-rich-paragraph`.
   */
  pitchPx: number;
  /**
   * EXTRA px inserted at an explicit `\n`, on top of {@link pitchPx} — `--godot-rich-paragraph-spacing`, 0 when
   * the table sets none (which is every label but a card description today).
   *
   * A WRAPPED line and a NEW PARAGRAPH are different distances in this game, and conflating them is what makes a
   * two-paragraph card description sit at the wrong height in its box. The DOM stage gets the distinction for
   * free — gsw emits one `.godot-rich-paragraph` block per Godot paragraph and the gap is the blocks' spacing —
   * so a single pitch here is a canvas-only flattening of a difference the other arm renders.
   */
  paragraphGapPx: number;
  /** `pre-wrap` (the base), `pre` (never wrap), `normal` (wrap AND collapse whitespace). */
  whiteSpace: "pre-wrap" | "pre" | "normal";
  /**
   * The `> .mirror-text { transform: scale(N) }` the card rules apply, about the box CENTRE.
   *
   * NOT folded into `fontPx`, and that distinction is worth stating: scaling the font would re-shape the text at
   * a different size and could move a line break. This is a post-layout visual scale on both backends, so it
   * belongs in the QUAD MATRIX — which also means the raster is built at the true font size, and a scaled card
   * label's line breaks are byte-identical to the unscaled one's.
   */
  blockScale: number;
  /**
   * WHERE GODOT BROKE THE LINES, when the producer measured this exact string — see `@/mirror/textWrap`.
   *
   * Non-null makes {@link layoutText} a REPLAY rather than a derivation: it places the lines it was given and
   * runs no breaker at all. Null (most labels, and every recording that predates the channel) leaves the greedy
   * `pre-wrap` breaker in charge, unchanged.
   *
   * IT IS PART OF THE RASTER KEY. Two specs identical in every other field can lay out differently depending on
   * whether a wrap had arrived, which is a real state on a live page: the wrap rides the producer's static path
   * and can land a build or two after the label's first raster. Without it in {@link textDigest} that first
   * raster would be reused forever and the wrap would never appear on screen.
   */
  godotLines: readonly GodotLine[] | null;
  /** Non-null ⇒ do not raster; leave this label on the DOM overlay. See the module header. */
  refusal: TextRefusal | null;
}

/**
 * A COLOUR RUN over the spec's string — `[start, end)` character indices, as `richSimple` produces them.
 *
 * Declared here rather than imported so that the layout module keeps having no dependencies at all: the shape is
 * structural, and a tokenizer that produces it is interchangeable with any other.
 */
export interface TextSpan {
  start: number;
  end: number;
  color: string;
}

/** One contiguous stretch of a placed line drawn in a single colour. See {@link PlacedLine.runs}. */
export interface TextRun {
  text: string;
  /** x of the run's left edge, in box space. */
  x: number;
  width: number;
  /** The run's own colour, or null to use the spec's. */
  color: string | null;
}

export interface PlacedLine {
  text: string;
  width: number;
  /** x of the line's left edge, in box space. */
  x: number;
  /** y of the line's BASELINE is `y + ascent`; this is the top of the line box. */
  y: number;
  /**
   * The line split into colour runs — PRESENT ONLY when the caller supplied spans that reach this line.
   *
   * Absent is the whole plain path, unchanged: no caller passes spans today, so every `PlacedLine` this module
   * produces is byte-identical to what it produced before runs existed, and a spec pins exactly that. A rasterizer
   * that does not know about runs keeps drawing `text` at `x` and is still correct.
   */
  runs?: TextRun[];
}

export interface TextLayout {
  lines: PlacedLine[];
  /** The text block's own width — shrink-to-fit, or the content width when anything wrapped. See `layoutText`. */
  blockW: number;
  blockH: number;
  /** Did the greedy breaker actually split a hard line? Decides shrink-to-fit vs stretch. */
  wrapped: boolean;
}

/** A width measurement for one run of text in the spec's font. Supplied by the caller — see the module header. */
export type MeasureText = (text: string) => number;

/**
 * A FACE'S OWN LINE BOX in px — the 2D context's `fontBoundingBoxAscent`/`fontBoundingBoxDescent`.
 *
 * Supplied by the caller for exactly the reason {@link MeasureText} is: this module owns the RULES and never opens
 * a context. It is measured once per font shorthand by `textSurfaces.lineMetricsFor`, which is the only place in
 * this client that owns a 2D context to ask.
 *
 * BOTH TERMS TRAVEL TOGETHER, always. The half-leading is `(pitch - (ascent + descent)) / 2`, so a real ascent
 * paired with a guessed descent moves the baseline by half the descent's error — a pair from one measurement of
 * one face is the only combination that is right. See {@link baselineOf}.
 */
export interface TextLineMetrics {
  ascent: number;
  descent: number;
}

/**
 * WHERE LINE `lineY`'s BASELINE GOES, in box space — the one expression both text backends place text with.
 *
 * The CSS line box, verbatim: a line of pitch P holds a font content box of `ascent + descent` centred in it, so
 * the line's ink starts at `lineY + (P - content) / 2` and its baseline is one ascent below that. When the pitch is
 * TIGHTER than the content — which the End-Turn rule's `calc(0.79em + 1px)` deliberately is — the half-leading goes
 * negative and the ink correctly extends above the line box, which is what the browser does with it too.
 *
 * IT LIVES HERE, in the module with no context and no GL, because the raster path (`textSurfaces`' `fillText`) and
 * the glyph path (`glyphPass`' pen origins) must agree to the pixel or a screen that mixes them — which is every
 * screen, since an outlined label can only raster — shows a row of labels sitting at two different heights. Two
 * copies of one arithmetic is exactly how that drifts, so there is one copy and both callers use it.
 */
export function baselineOf(lineY: number, pitchPx: number, metrics: TextLineMetrics): number {
  return lineY + (pitchPx - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent;
}

// --- the spec ---------------------------------------------------------------------------------------------------

/** `nodeStyles.alignToTextAlign`'s table — the streamed halign as a CSS `text-align`, or null for "leave alone". */
function halignToTextAlign(align: string | null): "center" | "right" | "justify" | null {
  switch ((align ?? "").toLowerCase()) {
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "fill":
      return "justify";
    default:
      return null;
  }
}

/** `nodeStyles.alignToFlex`'s table, as the three block positions. */
function toBlockAlign(align: string | null): "start" | "center" | "end" {
  switch ((align ?? "").toLowerCase()) {
    case "right":
    case "bottom":
    case "end":
      return "end";
    case "center":
      return "center";
    default:
      return "start";
  }
}

/** `12px`, `10%` of `basis`, or 0 for anything else (including a `calc()` this path will not evaluate). */
function lengthPx(value: string | undefined, basis: number): number {
  if (!value) return 0;
  const pct = /^([\d.]+)%$/.exec(value.trim());
  if (pct) return (Number(pct[1]) / 100) * basis;
  const px = /^([\d.]+)px$/.exec(value.trim());
  return px ? Number(px[1]) : 0;
}

/**
 * A font-relative CSS length as absolute px, or null when the value is not one of the shapes the table uses.
 *
 * FOUR SHAPES, deliberately, and no more: `calc(<n>em + <m>px)` (the End-Turn button's `calc(0.79em + 1px)` and
 * the card description's `calc(0.88em + 1px)`), a bare `em`, a bare `px`, and a unitless ratio. A general CSS
 * calc evaluator would be a lot of code with nothing else to evaluate; anything unrecognised returns null and the
 * caller falls back rather than guessing.
 *
 * `em` RESOLVES AGAINST THE UNSCALED FONT SIZE, which is the right basis for both callers: `blockScale` is a
 * post-layout transform on the block (see {@link TextSpec.blockScale}), and CSS resolves `em` before a transform
 * applies too. So a card description's 0.88em is 0.88 of the size the glyphs are RASTERED at, and the 1.24 scale
 * then multiplies pitch and glyphs together — exactly as it does in the DOM.
 */
function lengthFromFontRelative(value: string | undefined, fontPx: number): number | null {
  if (!value) return null;
  const m = /^calc\(\s*([\d.]+)em\s*\+\s*([\d.]+)px\s*\)$/.exec(value.trim());
  if (m) return Number(m[1]) * fontPx + Number(m[2]);
  const em = /^([\d.]+)em$/.exec(value.trim());
  if (em) return Number(em[1]) * fontPx;
  const px = /^([\d.]+)px$/.exec(value.trim());
  if (px) return Number(px[1]);
  const ratio = /^([\d.]+)$/.exec(value.trim());
  if (ratio) return Number(ratio[1]) * fontPx;
  return null;
}

/**
 * `scale(1.24)` from a `transform` declaration, or 1. The card rules are the only writers.
 *
 * EXPORTED for the paint dump (R8). The `O` row publishes the block scale its matrix does NOT carry, and it has
 * to compute that from the same declaration this does — a second parser would be a second answer.
 */
export function scaleFromTransform(value: string | undefined): number {
  if (!value) return 1;
  const m = /scale\(\s*([\d.]+)\s*\)/.exec(value);
  return m ? Number(m[1]) : 1;
}

/**
 * The `!important` font-size cap the End-Turn rule applies: `min(calc(<px> * <scale>), 34px) !important`.
 *
 * `!important` in an author stylesheet BEATS a non-important inline style, which is why that rule carries it and
 * why the cap really does win over `textStyle`'s inline `font-size`. Only the `min(..., Npx)` cap is read — the
 * `calc` half is the size this function is already being handed.
 */
function fontSizeCap(value: string | undefined): number | null {
  if (!value || !value.includes("!important")) return null;
  // THE LAST `, <n>px)` in the value, not the first. The first one belongs to the inner
  // `var(--godot-font-px, 0px)` FALLBACK — reading that gave a cap of 0 and collapsed the label to nothing, which
  // is what the "a size under the cap is left alone" spec caught. The min()'s own second argument is last.
  let cap: number | null = null;
  for (const m of value.matchAll(/,\s*([\d.]+)px\s*\)/g)) {
    cap = Number(m[1]);
  }
  return cap;
}

/**
 * Build one label's raster descriptor from the node and its resolved text-scale declarations.
 *
 * `decls` comes from `textScaleClasses.resolveTextScaleDecls` — the same table the DOM backend's generated
 * stylesheet is built from, resolved in the browser's own cascade order. Nothing here re-lists which per-scene
 * rules exist; they arrive as values.
 */
export function resolveTextSpec(node: MirrorNode, decls: TextScaleDecls): TextSpec | null {
  const t = node.text;
  if (!t || !t.text) {
    return null;
  }
  const self = decls.self;
  const textDecls = decls.text;

  // SIZE: the streamed px times the resolved `--godot-text-scale`, then the table's `!important` cap if it has one.
  const scale = Number(self["--godot-text-scale"] ?? "1") || 1;
  const basePx = t.fontSizePx ?? 0;
  let fontPx = basePx * scale;
  const cap = fontSizeCap(textDecls["font-size"]);
  if (cap != null && fontPx > cap) {
    fontPx = cap;
  }

  const font = node.font;
  const boxW = node.localRect?.width ?? 0;
  const boxH = node.localRect?.height ?? 0;

  // OUTLINE: `textStyle`'s rule verbatim — the per-tick diagnostics outline beats the stale top-level one, and a
  // colour without a positive size paints nothing. The width is scaled HERE so no caller can forget to.
  const outlineColor = t.outlineColorHtml ?? node.outline?.colorHtml ?? null;
  const outlineSize = t.outlineColorHtml != null && t.outlineSize > 0 ? t.outlineSize : (node.outline?.size ?? 0);
  const hasOutline = outlineColor != null && outlineSize > 0;

  const whiteSpace =
    textDecls["white-space"] === "pre" ? "pre" : textDecls["white-space"] === "normal" ? "normal" : "pre-wrap";

  // ALIGNMENT, in the browser's precedence. `textStyle` writes an INLINE `text-align` only for center/right/fill,
  // and deliberately writes nothing for left — which is what lets a per-scene rule's inherited `text-align` reach
  // the label. So the inline value wins when there is one, and the table's value applies when there is not.
  const inlineAlign = halignToTextAlign(t.halign);
  const tableAlign = self["text-align"];
  const align = inlineAlign ?? (tableAlign === "center" || tableAlign === "right" ? tableAlign : "left");

  // GODOT'S OWN LINE BREAKING, when the producer measured THIS string (see `@/mirror/textWrap`). Restricted to a
  // `"text"` basis here because the plain path rasters `t.text`: a `"parsed"` basis addresses a bbcode label's
  // markup-stripped content, which is a different string and belongs to the rich wave.
  const wrapLines = node.textWrap?.basis === "text" ? godotLines(node.textWrap, t.text) : null;

  // TWO OF THE FOUR REFUSALS ARE ABOUT THE BREAKER, NOT ABOUT THE LABEL — so having the engine's own breaks
  // retires them, and that is the point of the channel rather than a side effect.
  //
  //   * `balance` — `text-wrap: balance` asks the BROWSER to re-balance line lengths after wrapping. Godot has
  //     no such mode and never balances, so with its breaks in hand there is nothing left to reproduce: the
  //     declaration is a CSS-side artefact of how the DOM stage renders, and the mirror's parity target is the
  //     game.
  //   * `unbreakable` — a greedy SPACE breaker cannot wrap CJK/Thai/kana at all and would overflow the box
  //     silently. Godot's TextServer breaks them on their own rules and we now receive the result.
  //
  // The other two stand and are not about breaking: `rich` is a different wave (the markup still has to be laid
  // out), and `no-font` means there is no face to raster with at all. `no-font` therefore moves AHEAD of the wrap
  // short-circuit — a streamed wrap says where the lines go, not what to draw them with — which also makes it the
  // reported class for a label that would once have been reported as `balance`. That is the more accurate of the
  // two answers: knowing where the breaks go does not help a label with no typeface.
  const refusal: TextRefusal | null = node.richText
    ? "rich"
    : font == null
      ? "no-font"
      : wrapLines !== null
        ? null
        : self["text-wrap"] === "balance"
          ? "balance"
          : UNBREAKABLE.test(t.text)
            ? "unbreakable"
            : null;

  const weight = font?.weight ?? "";
  const style = font?.style ?? "";
  const family = font?.family ?? "";

  return {
    text: t.text,
    // The canvas2D shorthand, in the order the spec requires (style, weight, size, family). No `sans-serif`
    // fallback is appended: the DOM path has one because a face may still be loading, but a raster taken before
    // the face is ready would BAKE the fallback into a texture that is then reused forever — so the rasterizer
    // waits for the face instead, and this string names only the face it is waiting for.
    cssFont: `${style} ${weight} ${fontPx}px "${family}"`.replace(/\s+/g, " ").trim(),
    family,
    fontPx,
    color: t.colorHtml ?? "#ffffff",
    outlinePx: hasOutline ? outlineSize * OUTLINE_SCALE : 0,
    outlineColor: hasOutline ? outlineColor : null,
    shadow: node.shadow
      ? { dx: node.shadow.offsetX, dy: node.shadow.offsetY, color: node.shadow.colorHtml }
      : null,
    align,
    blockAlign: toBlockAlign(t.halign),
    blockAlignY: toBlockAlign(t.valign),
    boxW,
    boxH,
    // The reward rules reserve 10% of the box on the right, which narrows what lines wrap against — the one
    // padding in the table, and it changes where words go, so it cannot be ignored.
    contentW: Math.max(0, boxW - lengthPx(self["padding-right"], boxW)),
    // PITCH, in the DOM's own precedence, because the two declarations reach a label by different routes:
    //
    //   `line-height` on `> .mirror-text`      — an ORDINARY declaration; the browser applies it to the label's
    //                                            line boxes directly (the End-Turn button).
    //   `--godot-rich-line-height` on the NODE — a CUSTOM PROPERTY; it inherits down to gsw's own
    //                                            `.godot-rich-paragraph` blocks, whose base css reads it as
    //                                            `line-height: var(--godot-rich-line-height, normal)`.
    //
    // An ordinary declaration on the element itself wins over one that arrives through a variable on a
    // descendant's rule, so the plain value is asked first. THE CANVAS ASKED NEITHER before this: it read only
    // `line-height`, which the card rules never set, so every card description fell through to the 1.1 ratio —
    // 23.1px against the game's 19.5px at the live font size of 21, on the most-read text in the game.
    //
    // NOT GATED ON `richText`, and that is deliberate. The `?textRich=simple` path re-resolves a card description
    // with `richText: false` (its markup already parsed out), and gating here would hand that re-resolve the
    // fallback pitch — the same defect, reachable only on the arm that is on by default.
    pitchPx:
      lengthFromFontRelative(textDecls["line-height"], fontPx) ??
      lengthFromFontRelative(self["--godot-rich-line-height"], fontPx) ??
      LINE_PITCH_RATIO * fontPx,
    // …and the between-paragraph gap, which has no plain-declaration twin: it is the SPACING BETWEEN gsw's
    // paragraph blocks, so there is nothing on `.mirror-text` that could carry it.
    paragraphGapPx: Math.max(0, lengthFromFontRelative(self["--godot-rich-paragraph-spacing"], fontPx) ?? 0),
    whiteSpace,
    blockScale: scaleFromTransform(textDecls.transform),
    godotLines: wrapLines,
    refusal
  };
}

// --- the line breaker -------------------------------------------------------------------------------------------

/**
 * Every index this line may be broken AT, in CSS's rules for `pre-wrap` text.
 *
 * Two opportunities, and only two: after a run of spaces, and after a hyphen that is not itself followed by one.
 * There is deliberately no intra-word breaking — CSS only does that under `overflow-wrap`/`word-break`, which
 * nothing in this app sets, so a word wider than the box OVERFLOWS on the DOM backend and must overflow here too.
 */
export function breakOpportunities(line: string): number[] {
  const points: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === " " || c === "\t") {
      let j = i;
      while (j < line.length && (line[j] === " " || line[j] === "\t")) {
        j++;
      }
      if (j < line.length) {
        points.push(j);
      }
      i = j - 1;
    } else if (c === "-" && i + 1 < line.length && line[i + 1] !== " " && line[i + 1] !== "-") {
      points.push(i + 1);
    }
  }
  return points;
}

/** Trailing spaces HANG at a soft break in CSS — they do not count toward the line's width. */
function trimEnd(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

/**
 * One broken piece: its text, and WHERE it came from in the hard line it was broken out of.
 *
 * The offsets are what lets a colour span address a placed line. They are carried for every piece, plain or not,
 * because a piece that knows where it came from costs two numbers and a piece that does not cannot be coloured at
 * all — and the text is still the same text, so nothing downstream changes for a caller that ignores them.
 */
interface Piece {
  text: string;
  start: number;
  end: number;
}

/**
 * Greedily break one hard line to `width`. Returns the line unchanged when it fits or cannot be broken.
 *
 * The "cannot be broken" case is not an error path: a single word wider than its box is real (a long relic name in
 * a narrow plaque), the DOM backend lets it overflow, and so does this.
 */
function breakLine(line: string, width: number, measure: MeasureText): Piece[] {
  if (width <= 0 || measure(trimEnd(line)) <= width) {
    return [{ text: line, start: 0, end: line.length }];
  }
  const points = breakOpportunities(line);
  if (points.length === 0) {
    return [{ text: line, start: 0, end: line.length }];
  }
  // THE END OF THE LINE IS A CANDIDATE TOO. Without it the last segment is never measured, so a line whose
  // overflow is entirely AFTER its final break opportunity came back unwrapped — every break point fitted, the
  // loop ended, and the whole line was emitted as the tail. That is the "wraps at the last break that fits" spec.
  const ends = [...points, line.length];
  const out: Piece[] = [];
  let start = 0;
  let lastFit = -1;
  // A piece's `end` is where it was CUT, before the trailing spaces were trimmed off its text. That distinction is
  // the whole reason both are recorded: the trimmed spaces are still characters of the source string, and a colour
  // span that covers them must not have its indices shifted by CSS's decision not to paint them.
  const push = (from: number, to: number): void => {
    out.push({ text: trimEnd(line.slice(from, to)), start: from, end: to });
  };
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i];
    if (end <= start) {
      continue;
    }
    if (measure(trimEnd(line.slice(start, end))) <= width) {
      lastFit = end;
      continue;
    }
    if (lastFit > start) {
      // Emit up to the last break that fit, then RE-CONSIDER this same candidate against the new line.
      push(start, lastFit);
      start = lastFit;
      lastFit = -1;
      i--;
      continue;
    }
    // Nothing fits before this candidate — the first word overflows. Take it whole (never break inside a word)
    // and carry on, which is exactly what the DOM does with it.
    push(start, end);
    start = end;
    lastFit = -1;
  }
  if (start < line.length) {
    push(start, line.length);
  }
  if (out.length === 0) {
    out.push({ text: "", start: 0, end: 0 });
  }
  return out;
}

/**
 * `white-space: normal`'s collapsing, WITH the index map back to the source.
 *
 * Collapsing re-indexes the string, so a colour span addressed against the original no longer addresses the text
 * being laid out. Rather than refuse the combination (`normal` plus rich is rare but real), the map records which
 * source character each surviving character came from, which is enough to move a span's endpoints across.
 */
function collapseWithMap(s: string): { text: string; map: number[] } {
  const text: string[] = [];
  const map: number[] = [];
  let i = 0;
  // `trim()`'s leading half: skip whitespace before the first real character.
  while (i < s.length && /\s/.test(s[i])) i++;
  for (; i < s.length; i++) {
    if (/\s/.test(s[i])) {
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j >= s.length) break; // trailing whitespace: `trim()`'s other half
      text.push(" ");
      map.push(i);
      i = j - 1;
      continue;
    }
    text.push(s[i]);
    map.push(i);
  }
  return { text: text.join(""), map };
}

function alignOffset(align: TextSpec["align"], free: number): number {
  if (align === "center") return free / 2;
  if (align === "right") return free;
  return 0; // left, and `justify` — whose per-line stretching is not reproduced; see `layoutText`.
}

function blockOffset(align: "start" | "center" | "end", free: number): number {
  if (align === "center") return free / 2;
  if (align === "end") return free;
  return 0;
}

/**
 * Break and place one spec's text. PURE: every width comes from `measure`.
 *
 * THE TWO-STAGE BOX, which is the part that is easy to get subtly wrong. The DOM stage renders a flex container
 * (the box) around ONE inline item (the text), so there are two independent placements:
 *
 *   1. The ITEM is shrink-to-fit — as wide as its longest line — UNLESS it was stretched to the container, in
 *      which case it stays at the full content width even if every line came out shorter. TWO things stretch it:
 *      having WRAPPED, and being CENTRE- or RIGHT-aligned (see the stretch site for the measurement behind the
 *      second). Either way this is not simply `min(maxLine, boxW)`.
 *   2. `justify-content` then places that block in the box, and `text-align` places each LINE inside the block.
 *
 * A single unwrapped LEFT-aligned line makes both stages agree, which is why the distinction only shows up on
 * multi-line, wrapped and centred labels — and those are exactly the ones a naive implementation gets wrong.
 *
 * `justify` is accepted and rendered as LEFT: Godot's `Fill` alignment reaches us through the same halign field,
 * but reproducing inter-word justification would need per-space stretching that the DOM backend does not do
 * either (browsers justify, but the streamed value is rare enough that matching left is honest and stated).
 */
export function layoutText(spec: TextSpec, measure: MeasureText, spans?: readonly TextSpan[]): TextLayout {
  // SOURCE OFFSETS, so a colour span can address a placed line. `collapseWithMap` is only reached under
  // `white-space: normal`, and only its map differs from the plain path — the text it produces is identical.
  const collapsed = spec.whiteSpace === "normal" ? collapseWithMap(spec.text) : null;
  const source = collapsed ? collapsed.text : spec.text;
  const canWrap = spec.whiteSpace !== "pre";

  // Hard lines, each with where it starts in `source`.
  const hard: Piece[] = [];
  {
    let at = 0;
    for (const line of source.split("\n")) {
      hard.push({ text: line, start: at, end: at + line.length });
      at += line.length + 1; // the "\n" itself
    }
  }

  const broken: Piece[] = [];
  let wrapped = false;
  if (spec.godotLines !== null) {
    // REPLAY. The engine already answered this question with the node's real width, autowrap flags and overrun
    // behaviour, so there is nothing to derive: the breaker does not run and neither does `canWrap`.
    //
    // The offsets are into the node's own text, which is `source` here — `collapseWithMap` is only reached under
    // `white-space: normal`, and a label whose wrap the producer measured was measured against the uncollapsed
    // string. So a `normal` label keeps ITS OWN breaker rather than replaying against a string the offsets do not
    // address; that is the same "when in doubt, do what we did before" direction every refusal in this module
    // takes.
    if (collapsed === null) {
      for (const line of spec.godotLines) {
        broken.push({ text: line.text, start: line.start, end: line.end });
      }
      // "Wrapped" means the block stretches to the content width instead of shrinking to fit (see the doc
      // comment). It is a question about whether a break was INSERTED, so it is measured the same way here as
      // below: more lines than the hard newlines already required.
      wrapped = broken.length > hard.length;
    }
  }
  if (broken.length === 0) {
    for (const line of hard) {
      if (!canWrap) {
        broken.push(line);
        continue;
      }
      const pieces = breakLine(line.text, spec.contentW, measure);
      if (pieces.length > 1) {
        wrapped = true;
      }
      for (const piece of pieces) {
        // Re-base the piece's offsets from "within this hard line" to "within the source".
        broken.push({ text: piece.text, start: line.start + piece.start, end: line.start + piece.end });
      }
    }
  }

  const widths = broken.map((piece) => measure(trimEnd(piece.text)));
  const maxWidth = widths.length > 0 ? Math.max(...widths) : 0;
  // STAGE 1 — shrink-to-fit, or the full content width once anything wrapped OR the lines are not left-aligned.
  //
  // THE SECOND CLAUSE IS THE HORIZONTAL HALF OF "CARD DESCRIPTIONS ARE NOT CENTERED", and it is measured rather
  // than reasoned: on the live game a `[center]` card description's paragraph box is the FULL content width (243
  // of 243) and its ink sits at the centre of that box — 84.87 where centred would be 82.87, against 0 for flush
  // left. `text-align` resolves against the CONTAINING BLOCK, and gsw's `.godot-rich-paragraph` is a block-level
  // element filling the label; shrinking to the longest line and then "centring" inside THAT is a no-op, which is
  // why a short description sat hard against the left edge of its card.
  //
  // WHY IT IS SAFE, and this is a proof rather than a hope: the change only bites when the LINE alignment
  // disagrees with the BLOCK alignment, which happens only for a rich label whose `[center]` outranks a streamed
  // `Left` halign. Where they agree the placement is IDENTICAL either way — stretching sets `blockX` to 0 and
  // moves exactly the same distance into `alignOffset`, since `blockOffset(a, contentW - blockW) +
  // alignOffset(a, blockW - width)` and `0 + alignOffset(a, contentW - width)` are the same number for a matching
  // `a`. The specs pin that: the `x` assertions in "the two-stage box" are unchanged, only the reported `blockW`.
  const stretched = wrapped || spec.align === "center" || spec.align === "right";
  const blockW = stretched ? spec.contentW : Math.min(maxWidth, spec.contentW);

  // EACH LINE'S TOP, and the reason it is accumulated rather than `i * pitch`: a PARAGRAPH break is a bigger gap
  // than a WRAPPED one (`--godot-rich-paragraph-spacing`), so the two have to be counted separately.
  //
  // A line starts a new paragraph exactly when its offset is one of the HARD line starts — the splits on `\n`
  // computed above. That test works on both paths at once and is why the pieces carry offsets at all: the
  // breaker's pieces are re-based onto `source`, and the engine's replayed lines are addressed against it too.
  // Comparing TEXT instead would call two identical paragraphs one, and counting `\n` while walking would miss
  // that a wrapped line never contains one.
  const hardStarts = new Set(hard.map((line) => line.start));
  const tops: number[] = [];
  let gapTotal = 0;
  for (let i = 0; i < broken.length; i++) {
    if (i > 0 && spec.paragraphGapPx > 0 && hardStarts.has(broken[i].start)) {
      gapTotal += spec.paragraphGapPx;
    }
    tops.push(i * spec.pitchPx + gapTotal);
  }
  const blockH = broken.length * spec.pitchPx + gapTotal;
  // STAGE 2 — `justify-content` places the block, `align-items` places it vertically. `blockH` carries the gaps,
  // so a two-paragraph description centres on its TRUE height rather than on a height that pretends every break
  // is a wrap — which is the vertical half of the "card descriptions are not centered" report.
  const blockX = blockOffset(spec.blockAlign, spec.contentW - blockW);
  const blockY = blockOffset(spec.blockAlignY, spec.boxH - blockH);

  const useRuns = spans !== undefined && spans.length > 0;
  const lines: PlacedLine[] = broken.map((piece, i) => {
    const x = blockX + alignOffset(spec.align, blockW - widths[i]);
    const line: PlacedLine = { text: piece.text, width: widths[i], x, y: blockY + tops[i] };
    if (useRuns) {
      const runs = runsFor(piece, x, spans, collapsed?.map ?? null, measure);
      // ONLY when the spans actually reach this line. A line with one colour is one run, which is the same call
      // sequence a rasterizer already makes — so it is left absent rather than expressed as a single-run list.
      if (runs !== null) {
        line.runs = runs;
      }
    }
    return line;
  });

  return { lines, blockW, blockH, wrapped };
}

/**
 * Split one placed line into colour runs, or null when no span touches it.
 *
 * THE X OF EACH RUN IS A CUMULATIVE PREFIX MEASURE, never a sum of the pieces' own widths, and that is the one
 * thing in here that is not obvious. A font's advance for "AV" is not the advance for "A" plus the advance for "V"
 * — kerning is a property of the PAIR — so summing run widths would drift a few tenths of a pixel per boundary and
 * put every run after the first in the wrong place. Measuring the prefix `line.slice(0, k)` asks the browser the
 * question it can actually answer, and reproduces exactly where the DOM backend's inline spans land.
 */
function runsFor(
  piece: Piece,
  lineX: number,
  spans: readonly TextSpan[],
  map: number[] | null,
  measure: MeasureText
): TextRun[] | null {
  const text = piece.text;
  if (text.length === 0) {
    return null;
  }
  // A span's indices address the ORIGINAL string; `map` moves them into collapsed space when there was a collapse.
  const at = (sourceIndex: number): number => {
    if (map === null) return sourceIndex;
    // The first collapsed position at or after this source index — a binary search would be overkill for a label.
    for (let k = 0; k < map.length; k++) {
      if (map[k] >= sourceIndex) return k;
    }
    return map.length;
  };
  // Colour per character of this line, from the spans that overlap it.
  const colors: (string | null)[] = new Array(text.length).fill(null);
  let touched = false;
  for (const span of spans) {
    const from = Math.max(piece.start, at(span.start));
    const to = Math.min(piece.end, at(span.end));
    for (let k = from; k < to; k++) {
      const local = k - piece.start;
      if (local >= 0 && local < colors.length) {
        colors[local] = span.color;
        touched = true;
      }
    }
  }
  if (!touched) {
    return null;
  }
  const runs: TextRun[] = [];
  let start = 0;
  for (let k = 1; k <= text.length; k++) {
    if (k < text.length && colors[k] === colors[start]) {
      continue;
    }
    const prefix = measure(text.slice(0, start));
    runs.push({
      text: text.slice(start, k),
      x: lineX + prefix,
      width: measure(text.slice(0, k)) - prefix,
      color: colors[start]
    });
    start = k;
  }
  return runs;
}

// --- raster scale -----------------------------------------------------------------------------------------------

/**
 * Quantization step for {@link rasterScaleFor} — 1/32, and a POWER OF TWO so the stepped value is exact in binary
 * (`ceil(0.8 / (1/32)) * (1/32)` is 0.8125 and not 0.8125000000000001, which would key two textures for one
 * scale). See {@link rasterScaleFor} for why the step shrank from 0.5.
 */
export const RASTER_SCALE_STEP = 1 / 32;
/**
 * The step for a label that is STANDING STILL — eight times finer, and a power of two for the same reason.
 *
 * WHY THERE ARE TWO. Once the blit is exactly 1:1 (`exactBlitSize`), the raster scale stops controlling sharpness
 * and starts controlling SIZE: the ink is drawn at `rasterScale` device px per design px rather than at the true
 * on-screen scale, so the step's round-up is a systematic size error of up to `STEP / scale` — 3.5% around the
 * 0.9 the live combat labels sit at, for a scale that has just missed a step. Per-label RMSE against the DOM is
 * exactly what punishes that, and a label 3.5% too big is legible as "the canvas text is slightly bigger".
 *
 * WHY IT IS NOT SIMPLY THE STEP EVERYWHERE. The stepped value is in the raster key, so a card scaling through a
 * flight mints a texture for every step it crosses; at 1/256 that is eight times the churn on exactly the frames
 * that can least afford it, and the labels the texture pacer then declines fall back to the DOM overlay
 * mid-flight, which is a visible layer pop. So the fine step is spent only where it is both wanted and free: a
 * label at rest re-keys once, at the settle, and every label on a settled screen shares the stage's one scale.
 */
export const RASTER_SCALE_STEP_REST = 1 / 256;
/**
 * The floor. ONE STEP, not 1 — see {@link rasterScaleFor}: a label drawn at a quarter size must be allowed to
 * raster at a quarter size. It exists only so a degenerate matrix cannot ask for a zero-pixel texture.
 */
export const RASTER_SCALE_MIN = RASTER_SCALE_STEP;
export const RASTER_SCALE_MAX = 3;

/**
 * How many device pixels per design pixel this label should be rastered at.
 *
 * THE WHOLE JOB IS TO EQUAL THE ON-SCREEN SCALE. The raster is blitted through a quad, and the sampler in gsw's
 * canvas executor is `LINEAR` for BOTH minification and magnification with no mipmaps — so any disagreement
 * between the scale the texture was drawn at and the scale it is drawn AT resamples every glyph, in either
 * direction. `scale === on-screen scale` is a 1:1 blit and is the only sharp case.
 *
 * WHY THIS IS NOT WHAT IT USED TO SAY. The old version clamped at a floor of 1 and rounded UP to half-steps,
 * which was written for the magnify case (a card at 1.24, a high-dpr phone) and silently assumed a label is never
 * drawn SMALLER than its design size. It is, constantly: on the live combat frame 46 of 56 text quads were
 * minified, the labels sitting at an on-screen scale of 0.80-0.87 while the floor forced a raster at 1.0 — a
 * fixed 15-25% shrink through a bilinear filter, on every label, forever. The measured S/T histogram is exactly
 * `1/0.8` and `1/0.87`, i.e. the floor and nothing else. Hence: no floor worth the name, and a step fine enough
 * (1/32) that the residual is at most `STEP / scale` — 1.6% at 0.8, against the 25% it replaces.
 *
 * ROUNDING IS STILL UP, so the residual error is always in the direction of slightly TOO MUCH detail rather than
 * too little; minifying a hair is the benign direction for glyph edges.
 *
 * THE STEP IS NOT FREE and it is not sized by taste: the raster key includes this number, so every distinct value
 * is a distinct texture and an unquantized scale would mint one per frame of any zoom. It stays coarse enough to
 * bound that and fine enough to be invisible. At REST it costs nothing at all — every label on a screen shares
 * the stage's one scale factor, so they share a handful of stepped values however fine the step is.
 *
 * `perDesignPx` IS THE WHOLE DESIGN-TO-DEVICE FACTOR, not just `devicePixelRatio`. The caller owes the product of
 * every scale between this matrix and a screen pixel — the stage's own fit-to-screen transform, the device pixel
 * ratio, and the label's `blockScale`. Passing only the DPR is what left the phone case wrong in both directions
 * at once (see the sizing law at the top of `canvasRenderer`).
 *
 * The matrix's MEAN axis length, not its larger one: a non-uniform scale cannot be satisfied on both axes by a
 * single raster, and the mean splits the error instead of over-allocating for the larger axis.
 */
export function rasterScaleFor(matrix: readonly number[], perDesignPx: number, atRest = false): number {
  const axisX = Math.hypot(matrix[0], matrix[1]);
  const axisY = Math.hypot(matrix[2], matrix[3]);
  const mean = (axisX + axisY) / 2;
  const wanted = mean * (perDesignPx > 0 ? perDesignPx : 1);
  // The TIER needs no separate key of its own: it reaches the texture only through this number, and the digest
  // already carries it. Two tiers that agree on the scale agree on the raster, so sharing one texture between
  // them is correct rather than stale — and where they disagree the settle re-keys, which is the point.
  const step = atRest ? RASTER_SCALE_STEP_REST : RASTER_SCALE_STEP;
  const stepped = Math.ceil(wanted / step) * step;
  return Math.min(RASTER_SCALE_MAX, Math.max(RASTER_SCALE_MIN, stepped));
}

// --- the raster key ---------------------------------------------------------------------------------------------

/**
 * The digest a texture registry keys one raster by — everything in {@link TextSpec} that changes pixels.
 *
 * Cheap to build and stable across builds, which is the whole point: the offline census measured 15-52 labels
 * re-drawn on EVERY build while their pixels change 0-64 times per THIRTY SECONDS, so this string is what turns
 * a per-build raster into a per-change one. Cross-node sharing (two labels reading the same digest) is real but
 * small — 1.00-1.29x on the recorded screens — and is a bonus rather than the argument.
 *
 * FIELDS ARE NUL-SEPARATED, which makes a collision structurally impossible rather than merely unlikely. The
 * first field is the label's own TEXT and game text contains spaces, so a printable separator would let a
 * crafted string impersonate a field boundary, reading as a different (text, font) pair. NUL cannot appear in a
 * streamed label. `textSurfaces` counts collisions anyway; this is what makes that counter's zero a consequence.
 */
export function textDigest(spec: TextSpec, rasterScale: number, spans?: readonly TextSpan[]): string {
  const base = [
    spec.text,
    spec.cssFont,
    spec.color,
    spec.outlinePx,
    spec.outlineColor ?? "",
    spec.shadow ? `${spec.shadow.dx},${spec.shadow.dy},${spec.shadow.color}` : "",
    spec.align,
    spec.pitchPx,
    // THE PARAGRAPH GAP, a base field of its own rather than folded into the pitch — the two are independent
    // numbers and a label can change one without the other. It is in the key for the reason the pitch is: the
    // scale table resolves from the node's scene path, which can land a build after the label's first raster, and
    // a raster keyed without it would keep the fallback spacing forever.
    spec.paragraphGapPx,
    spec.whiteSpace,
    // The wrap inputs. Rounded to a whole pixel: a sub-pixel box difference cannot move a line break, and leaving
    // the raw float in would mint a texture per frame of any box that animates its width.
    Math.round(spec.contentW),
    rasterScale
  ].join("\u0000");
  // NO SPANS, NO SUFFIX — and this is the property the whole T11 change rests on. Every caller today is
  // span-less, so every digest this function produces is BYTE-IDENTICAL to what it produced before runs existed,
  // and a spec pins exactly that. Appending an empty field instead would have re-keyed every label in the cache
  // for a feature nothing uses yet.
  // THE STREAMED WRAP, appended as TWO fields so the counting argument still decides every shape.
  //
  // A wrap changes where the lines go while leaving every field above identical, so it has to be in the key — a
  // label rastered before its wrap arrived would otherwise keep that first raster forever. Two fields rather than
  // one keeps the four possible shapes at four DISTINCT NUL counts (11 plain, 12 spanned, 13 wrapped, 14 both),
  // which is the same impossibility-by-counting the base rests on, extended rather than replaced. (Those counts
  // were each one lower before the paragraph gap joined the base; what the argument needs is that they stay
  // DISTINCT, and adding a base field shifts all four together.)
  const wrapSuffix =
    spec.godotLines === null
      ? ""
      : `\u0000w\u0000${spec.godotLines.map((l) => `${l.start},${l.end}`).join(";")}`;
  if (spans === undefined || spans.length === 0) {
    return base + wrapSuffix;
  }
  // A COLLISION BETWEEN THE FOUR SHAPES IS IMPOSSIBLE BY COUNTING, not by luck: the base is eleven NUL-joined
  // fields and therefore contains exactly ten NULs, a spanned digest eleven, a wrapped one twelve and a
  // spanned-and-wrapped one thirteen. No two can ever be equal whatever the strings say — which is the same structural argument the base fields
  // rest on, extended rather than replaced. (`textSurfaces` counts collisions anyway; this is what makes its
  // zero a consequence.)
  return `${base}\u0000${spans.map((s) => `${s.start},${s.end},${s.color}`).join(";")}${wrapSuffix}`;
}
