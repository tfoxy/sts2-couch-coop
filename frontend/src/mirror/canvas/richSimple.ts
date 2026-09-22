// SIMPLE RICH TEXT — the subset of bbcode a single-face raster can draw, and a LOUD refusal for everything else.
//
// Treating every `RichTextLabel` as a refusal would be a large over-refusal, because `rich` is a wire boolean
// (the node's type) rather than a statement about the string. Measured over the recorded corpus, most
// rich strings carry no markup at all, and most of the rest carry only whole-string alignment and colour. Those
// are drawable by a run list — one `fillText` per colour run instead of one per line — and nothing else about the
// raster changes.
//
// ---------------------------------------------------------------------------------------------------------------
// WHY THE REFUSALS ARE THE FEATURE, and why they are per class rather than a boolean.
//
// gsw renders an unrecognised tag LITERALLY. So a tokenizer here that disagrees with gsw's does not produce a
// slightly-wrong label — it produces the WRONG WORDS on screen, either by swallowing markup gsw would have shown
// or by showing markup gsw would have consumed. That is the one failure mode a text path must never ship, and it
// is strictly worse than the alternative, which is that the label keeps its DOM element and renders exactly as it
// does today. One hoisted label is the price of certainty and it is a cheap price.
//
// Each refusal is named, so a census can say WHICH construct is holding a screen back rather than how many labels
// failed:
//   font-swap   `[b]` `[i]` `[u]` `[s]` `[code]` — a different font FILE, plus per-role letter spacing. A raster
//               built from one `cssFont` cannot express it without a second face and a second measurement pass.
//   img         `[img]` embeds a real inline image, laid out in the text flow. That is gsw doing DOM layout.
//   style       `font_size` (a second measurement pass), `bgcolor` (a box behind the run), `outline_color` (a
//               second stroke colour mid-line), `url` (an underline), and the structural `font`/`outline_size`/
//               `indent`. Each is a real feature; none is a colour.
//   effect      gsw's own built-in animated effects, which are PER-CHARACTER. They defeat the immutable-raster
//               premise this whole registry is built on: a texture keyed by a digest cannot animate.
//   unknown     any tag neither gsw's grammar nor the STS2 table names. See above — this is the wrong-words case.
//   nested-align / non-wrapping-align   alignment that is not one span over the whole string. A paragraph
//               construct inside a line is a block-layout problem, not a run problem.
//   unbalanced  a close tag that does not match the innermost open of the same name. Deliberately STRICTER than
//               gsw (which searches the stack): erring toward a refusal errs toward the label rendering as it
//               does today, which is the safe direction.
//   bad-color   a colour value the browser itself would not accept. See `createColorValidator`.
//
// ---------------------------------------------------------------------------------------------------------------
// THE TAG TABLE IS IMPORTED, NEVER RESTATED. `DEFAULT_BBCODE_TAGS` is the single authoring of the STS2 custom tags
// (the colour aliases and the six effect names), and it is what cc already feeds gsw — so reading it here is what
// makes this tokenizer and the DOM backend's renderer agree by construction rather than by review. What IS named
// below is gsw's own standard grammar, which it does not export.
//
// AND THE ONE SUBTLETY IN THAT TABLE, because it decides six tags. STS2's six effect names split two ways there:
// three are `{kind:"style", css:{}}` — an EMPTY css block, a span with no declarations — and three
// (`sine`/`jitter`/`thinky_dots`) are `{kind:"effect"}` descriptors the DOM backend animates per character. BOTH
// halves pass through here, contributing nothing, and both are exactly right on THIS backend, for two different
// reasons:
//
//   empty css   there is nothing to draw differently. Checked rather than assumed — a NON-empty css block refuses
//               as `style`, because that WOULD be a visible difference this run list cannot express.
//   custom fx   this backend cannot animate at all (a texture keyed by a digest does not move), and the effect
//               changes only WHERE each character sits, never WHICH characters they are. So the flat raster draws
//               the right words in the right colours, and the motion is simply absent — which is what the
//               canvas arm is for. Refusing instead would hoist every `[jitter]` label in combat back into a DOM
//               element, which is the cost this backend exists to avoid.
//
// gsw's OWN built-in effects (`[rainbow]`, `[shake]`, …) keep refusing, unchanged: they are a per-character
// COLOUR sweep as much as a displacement, and a flat raster of one would be the wrong pixels rather than still
// ones.

import { DEFAULT_BBCODE_TAGS } from "@spirectl/presentation/render";
import {
  GODOT_BBCODE_BUILT_IN_EFFECTS,
  godotBbcodeTagKind,
  type GodotBbcodeTagDescriptor
} from "@godot-scene-web/html";

export type RichRefusal =
  | "font-swap"
  | "img"
  | "style"
  | "effect"
  | "unknown"
  | "nested-align"
  | "non-wrapping-align"
  | "unbalanced"
  | "bad-color";

/** A colour run over the parsed PLAIN text: `[start, end)` indices into it. */
export interface RichSpan {
  start: number;
  end: number;
  color: string;
}

export interface RichSimple {
  /** The string with all markup removed — what the line breaker and the measurer see. */
  text: string;
  /** Colour runs, in order, non-overlapping. EMPTY for a markup-free string, which is the common case. */
  spans: RichSpan[];
  /** Whole-string alignment, or null when the string carried none. */
  align: "left" | "center" | "right" | "justify" | null;
}

export type RichParseResult =
  | { ok: true; value: RichSimple }
  | { ok: false; refusal: RichRefusal; detail: string };

/** Godot's `fill` is CSS's `justify`; the rest map through unchanged. */
function alignFrom(name: string): RichSimple["align"] {
  return name === "fill" ? "justify" : (name as RichSimple["align"]);
}

// --- the colour validator ---------------------------------------------------------------------------------------

/**
 * Is this a colour the BROWSER accepts, and what does it normalize to?
 *
 * The set-sentinel trick, and it is not a trick so much as CSS's own semantics made observable: assigning an
 * INVALID value to `fillStyle` is a no-op — the property keeps what it had — which is exactly what a stylesheet
 * does with a declaration it cannot parse (it drops it). So: set a sentinel, assign the candidate, and read back.
 * Unchanged means the browser rejected it, and the run should not be coloured at all rather than coloured with a
 * guess. Anything else is the browser's own normalization, which is also what the DOM arm would have painted.
 *
 * Injectable because the module must stay testable without a 2D context, and because a null validator ("cannot
 * tell") has to have a defined meaning: it accepts the value as written, which is what an environment with no
 * canvas would have to do anyway.
 */
export type ColorValidator = (value: string) => string | null;

export function createColorValidator(ctx: CanvasRenderingContext2D | null): ColorValidator {
  if (ctx === null) {
    return (value) => value.trim() || null;
  }
  // Two sentinels, because a candidate that IS the sentinel would read as a rejection under one.
  const SENTINELS = ["#010203", "#040506"];
  return (value) => {
    const raw = value.trim();
    if (raw.length === 0) {
      return null;
    }
    for (const sentinel of SENTINELS) {
      ctx.fillStyle = sentinel;
      ctx.fillStyle = raw;
      const got = typeof ctx.fillStyle === "string" ? ctx.fillStyle : "";
      if (got.toLowerCase() !== sentinel) {
        return got;
      }
    }
    return null;
  };
}

// --- the parser ---------------------------------------------------------------------------------------------

interface Frame {
  name: string;
  /** The colour this frame contributes, or null for a pass-through frame. */
  color: string | null;
  /** Where the frame opened, as an index into the OUTPUT text. */
  start: number;
}

/** Matches one bbcode token. Mirrors what gsw's scanner accepts: a name, an optional `=value` or space-arguments. */
const TAG_RE = /\[(\/?)([a-zA-Z_]+)((?:=|\s)[^\]]*)?\]/g;

/**
 * Parse one rich string into plain text plus colour runs, or refuse and say which class refused it.
 *
 * gsw's STACK SEMANTICS, reproduced: tags nest, the innermost colour wins, and a frame's contribution ends where
 * its close tag is. The one deliberate divergence is strictness — see `unbalanced` in the header.
 */
export function parseSimpleRich(
  raw: string,
  options: { tags?: Record<string, unknown>; color?: ColorValidator } = {}
): RichParseResult {
  const table = (options.tags ?? DEFAULT_BBCODE_TAGS) as Record<string, GodotBbcodeTagDescriptor>;
  const validate = options.color ?? ((v: string) => v.trim() || null);

  let out = "";
  const spans: RichSpan[] = [];
  const stack: Frame[] = [];
  let align: RichSimple["align"] = null;
  /** Where the align tag opened and closed in the OUTPUT, so "did it wrap the whole string" is checkable. */
  let alignRange: { start: number; end: number } | null = null;
  let alignOpen = false;
  let cursor = 0;

  const refuse = (refusal: RichRefusal, detail: string): RichParseResult => ({ ok: false, refusal, detail });

  /** Close a colour frame: everything it covered becomes a span, unless a nested frame already claimed it. */
  const closeFrame = (frame: Frame, end: number): void => {
    if (frame.color === null || end <= frame.start) {
      return;
    }
    // The frame's own colour applies wherever no INNER frame has already written a span. Walking the gaps keeps
    // the result non-overlapping and in order, which is what the run splitter downstream requires.
    let at = frame.start;
    const inner = spans.filter((s) => s.start >= frame.start && s.end <= end).sort((a, b) => a.start - b.start);
    for (const s of inner) {
      if (s.start > at) {
        spans.push({ start: at, end: s.start, color: frame.color });
      }
      at = Math.max(at, s.end);
    }
    if (at < end) {
      spans.push({ start: at, end, color: frame.color });
    }
  };

  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(raw); m !== null; m = TAG_RE.exec(raw)) {
    out += raw.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    const close = m[1] === "/";
    const name = m[2].toLowerCase();
    const argument = (m[3] ?? "").replace(/^=/, "").trim();

    const kind = godotBbcodeTagKind(name, table);
    if (kind === undefined) {
      // gsw would leave this LITERAL. Guessing is how a label ends up with `[foo]` printed in it.
      return refuse("unknown", `[${name}] is in neither grammar`);
    }
    if (kind === "bold" || kind === "italic" || kind === "underline" || kind === "strike" || kind === "code") {
      return refuse("font-swap", `[${name}]`);
    }
    if (kind === "image") return refuse("img", "[img]");
    if (kind === "effect" && GODOT_BBCODE_BUILT_IN_EFFECTS[name]) {
      return refuse("effect", `[${name}] is a built-in animated effect`);
    }
    if (kind === "void") return refuse("style", `[${name}] is a block construct`);
    if (kind === "indent" || kind === "bgcolor" || kind === "url" || kind === "font_size") {
      return refuse("style", `[${name}]`);
    }

    if (kind === "align") {
      if (close) {
        if (!alignOpen) return refuse("unbalanced", `[/${name}] with no open alignment`);
        alignOpen = false;
        if (alignRange) alignRange.end = out.length;
        continue;
      }
      if (align !== null) return refuse("nested-align", `a second [${name}] — alignment must be one whole-string span`);
      // `[p align=x]`'s value lives in the arguments; the shorthand IS its own name.
      const value = name === "p" ? (/align\s*=\s*([a-zA-Z]+)/.exec(m[3] ?? "")?.[1]?.toLowerCase() ?? "left") : name;
      if (value !== "center" && value !== "left" && value !== "right" && value !== "fill") {
        return refuse("unknown", `[p align=${value}]`);
      }
      align = alignFrom(value);
      alignOpen = true;
      alignRange = { start: out.length, end: out.length };
      continue;
    }

    if (name === "outline_color") return refuse("style", `[${name}]`);

    if (kind === "color") {
      if (close) {
        const frame = stack.pop();
        // The built-in `color`/`fgcolor` aliases may close each other, but an STS2 colour alias is
        // its own tag and must close itself. The shared parser classifies both as `color`; this
        // extra stack rule is the consumer's intentional stricter refusal.
        const closesBuiltInColor = name === "color" || name === "fgcolor";
        if (
          !frame ||
          (closesBuiltInColor
            ? frame.name !== "color" && frame.name !== "fgcolor"
            : frame.name !== name)
        ) {
          return refuse("unbalanced", `[/${name}]`);
        }
        closeFrame(frame, out.length);
        continue;
      }
      // gsw resolves the built-ins before consulting custom tags, so even a caller-supplied
      // `color` descriptor must not replace `[color=<argument>]`'s argument semantics.
      const customColor = name === "color" || name === "fgcolor" ? undefined : table[name];
      const rawColor = customColor?.kind === "color" ? customColor.value : argument;
      const colour = validate(rawColor);
      if (colour === null) return refuse("bad-color", `[${name}=${rawColor}]`);
      stack.push({ name, color: colour, start: out.length });
      continue;
    }

    if (kind === "structural") {
      if (name === "font" || name === "outline_size") return refuse("style", `[${name}]`);
      if (close) {
        const frame = stack.pop();
        if (!frame || frame.name !== name) return refuse("unbalanced", `[/${name}]`);
        continue;
      }
      stack.push({ name, color: null, start: out.length });
      continue;
    }

    const descriptor = table[name];
    if (close) {
      const frame = stack.pop();
      if (!frame || frame.name !== name) return refuse("unbalanced", `[/${name}]`);
      closeFrame(frame, out.length);
      continue;
    }
    if (kind === "style" && descriptor?.kind === "style") {
      // THE EMPTY-CSS PROOF, checked rather than assumed. See the module header: three of STS2's six effect names
      // are `{kind:"style", css:{}}` in this table, and an empty declaration block is a span that changes nothing.
      if (Object.keys(descriptor.css ?? {}).length > 0) {
        return refuse("style", `[${name}] carries ${Object.keys(descriptor.css).join(",")}`);
      }
      stack.push({ name, color: null, start: out.length });
      continue;
    }
    if (kind === "effect" && descriptor?.kind === "effect") {
      // A CUSTOM animated effect, drawn flat. See the module header: it displaces characters, it does not change
      // them, and this backend has no way to move a baked raster anyway.
      stack.push({ name, color: null, start: out.length });
      continue;
    }
    return refuse("unknown", `[${name}] is in neither grammar`);
  }
  out += raw.slice(cursor);

  if (alignOpen && alignRange) {
    alignRange.end = out.length;
  }
  // Frames still open at the end style to the end of the string, which is what gsw does with them.
  while (stack.length > 0) {
    closeFrame(stack.pop() as Frame, out.length);
  }
  // WHOLE-STRING ALIGNMENT ONLY. Godot's align tags are PARAGRAPH constructs — gsw makes the content its own
  // block with its own spacing — so an align that covers part of a line is a block-layout change a run list
  // cannot express. Whitespace either side is allowed: `[center]x[/center]\n` is still one aligned string.
  if (align !== null && alignRange !== null) {
    const before = out.slice(0, alignRange.start).trim();
    const after = out.slice(alignRange.end).trim();
    if (before.length > 0 || after.length > 0) {
      return refuse("non-wrapping-align", "alignment covers only part of the string");
    }
  }

  spans.sort((a, b) => a.start - b.start);
  return { ok: true, value: { text: out, spans, align } };
}
