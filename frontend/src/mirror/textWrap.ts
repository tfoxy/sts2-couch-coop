// GODOT'S OWN LINE BREAKING, VALIDATED — the one gate between a streamed wrap and a rendered label.
//
// The producer runs `TextServer.shaped_text_get_line_breaks` inside the game, with the node's real width,
// autowrap flags, justification flags and overrun behaviour, and streams the resulting character ranges
// (`MirrorTextWrap`). This module is what a renderer calls to turn that into lines it may actually draw.
//
// ---------------------------------------------------------------------------------------------------------------
// WHY A VALIDATOR AND NOT A PLAIN SLICE.
//
// The wrap rides the producer's STATIC path (add / keyframe / re-describe) and a label's words ride its PER-TICK
// path. So a label whose text changes without a re-describe carries ranges that describe the string it used to
// hold. Slicing the new text at the old offsets does not produce a misplaced line — it produces DIFFERENT WORDS,
// silently, in a label the player is reading. That is the one failure a text path must never ship, and it is
// strictly worse than the alternative, which is that the renderer breaks the lines itself exactly as it does
// today.
//
// So the wrap is treated as a CLAIM about a specific string, and `godotLines` is where the claim is checked. It
// answers null far more readily than it answers lines, and every null is a renderer falling back to what it
// already did.
//
// ---------------------------------------------------------------------------------------------------------------
// THE PARITY TARGET MOVES, AND THAT IS THE POINT.
//
// The canvas text path was written to match the DOM backend's CSS rendering, and therefore had to REFUSE every
// label whose wrap a greedy space-breaker could not reproduce: `text-wrap: balance`, scripts that do not break on
// spaces, tab stops, trimmed overruns. Each refusal is a label that stays on the DOM overlay and keeps painting
// above the whole stage — the layering bug this exists to close. With the engine's own breaks in hand the
// question stops being "can we reproduce CSS" and becomes "can we replay Godot", which is what the mirror is for.
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only, no DOM, no gsw.

import type { MirrorTextWrap } from "@/mirror/sceneTree";

/**
 * FNV-1a, 32-bit, over the string's UTF-16 CODE UNITS.
 *
 * THE PORT OF `Sts2RuntimeSceneTextDiagnostics.Fnv1a32`, and it has to agree with it bit for bit or the wrap is
 * never used at all. Two details carry that agreement and neither is incidental:
 *
 *   * CODE UNITS, not code points. `for (const ch of s)` iterates code POINTS in JavaScript and would agree with
 *     the C# side across all of ASCII, then diverge on the first character outside the BMP — a data-dependent
 *     disagreement that no ASCII test could ever catch. `charCodeAt` is the C# `foreach (var c in string)`.
 *   * `Math.imul` for the multiply. `hash * 16777619` in doubles loses the low bits once the product exceeds
 *     2^53, so the plain spelling agrees with C# for short strings and diverges for longer ones — the same
 *     data-dependent shape. `imul` is 32-bit multiply with wraparound, which is what `unchecked` gives C#.
 *
 * Returns a SIGNED 32-bit int (`| 0`), matching the C# `(int)` cast, so the two can be compared directly.
 */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/** One line of a validated wrap: the substring to draw, and the range it came from. */
export interface GodotLine {
  text: string;
  start: number;
  end: number;
}

/**
 * The lines Godot broke this label into, or null when the streamed wrap may not be trusted for `text`.
 *
 * `text` is the string the caller is ABOUT TO DRAW — the node's own text for a `"text"` basis. For a `"parsed"`
 * basis the addressed string is the wrap's own `parsedText` (a bbcode label's `text` is its markup), so the
 * caller's string is not what gets sliced; it is not consulted at all, because the producer already resolved the
 * markup and the caller has no way to reproduce that resolution.
 *
 * Null means "break the lines yourself". Reasons, all deliberate:
 *   * no wrap streamed for this node (the common case);
 *   * the string the caller holds is not the string the producer measured (length or hash disagree) — the stale
 *     case this whole channel is shaped around;
 *   * the basis names a string the wire did not carry.
 */
export function godotLines(wrap: MirrorTextWrap | null | undefined, text: string): GodotLine[] | null {
  if (!wrap) {
    return null;
  }
  const source = wrap.basis === "parsed" ? wrap.parsedText : text;
  if (source === null) {
    return null;
  }
  // LENGTH FIRST, and it is not merely an optimisation: it is the check that makes a hash collision harmless,
  // because a colliding string of a different length never reaches the comparison at all.
  if (source.length !== wrap.sourceLength || fnv1a32(source) !== wrap.sourceHash) {
    return null;
  }
  const out: GodotLine[] = [];
  for (const line of wrap.lines) {
    // `sceneTree.normalizeTextWrap` already refused any range outside [0, sourceLength] or out of order, and the
    // length check above ties that bound to THIS string — so the slice cannot run off the end.
    out.push({ text: source.slice(line.start, line.end), start: line.start, end: line.end });
  }
  return out;
}
