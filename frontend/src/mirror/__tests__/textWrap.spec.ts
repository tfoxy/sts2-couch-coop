// THE STREAMED-WRAP GATE, pinned — and above all the CROSS-LANGUAGE HASH.
//
// `godotLines` is the only thing standing between a stale streamed wrap and a label rendering different words
// from the ones the game is showing. Two halves are worth pinning and they fail in different ways:
//
//   * THE HASH must agree with `Sts2RuntimeSceneTextDiagnostics.Fnv1a32` EXACTLY, or the wrap is silently never
//     used and the whole channel is dead weight that reads as "working" (every label just falls back). The
//     vectors below were computed from the algorithm's definition independently of both implementations, so
//     they pin the C# and the TypeScript to the same third thing rather than to each other.
//   * THE REFUSALS must fire. A validator that is too permissive does not degrade the picture, it changes the
//     words.

import { describe, expect, it } from "vitest";

import type { MirrorTextWrap } from "@/mirror/sceneTree";
import { fnv1a32, godotLines } from "@/mirror/textWrap";

function wrapFor(source: string, ranges: [number, number][], over: Partial<MirrorTextWrap> = {}): MirrorTextWrap {
  return {
    lines: ranges.map(([start, end]) => ({ start, end })),
    basis: "text",
    parsedText: null,
    sourceLength: source.length,
    sourceHash: fnv1a32(source),
    ...over
  };
}

describe("fnv1a32 — the cross-language staleness hash", () => {
  // Independently computed from the FNV-1a definition over UTF-16 code units. If one of these ever changes, the
  // producer and the client have stopped agreeing and every streamed wrap is being thrown away.
  it.each([
    ["", -2128831035],
    ["Strike", 1849856623],
    ["Deal 9 damage.", -1209866591],
    ["Damage ALL other enemies\nequal to the damage dealt.", -428184616],
    ["é一", 1502015756]
  ])("hashes %j to the reference value", (input, expected) => {
    expect(fnv1a32(input)).toBe(expected);
  });

  it("iterates CODE UNITS, not code points — the divergence no ASCII test can catch", () => {
    // U+1F600 is a surrogate PAIR. A port using `for...of` (code points) agrees with C# on everything above and
    // disagrees here, which is exactly the data-dependent failure this pin exists for.
    expect(fnv1a32("\u{1F600}ab")).toBe(753646331);
  });

  it("stays a signed 32-bit int for long input, so the 2^53 multiply trap is closed", () => {
    // `hash * 16777619` in doubles silently loses low bits past 2^53; Math.imul does not. A long string is where
    // the plain spelling would first diverge — the value only has to be stable and in range to prove imul is used.
    const long = "the ironclad strikes again ".repeat(50);
    const h = fnv1a32(long);
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(-2147483648);
    expect(h).toBeLessThanOrEqual(2147483647);
    expect(fnv1a32(long)).toBe(h);
  });
});

describe("godotLines — what may be drawn from a streamed wrap", () => {
  const TEXT = "Damage ALL other enemies equal to the damage dealt.";

  it("replays the engine's own breaks", () => {
    const lines = godotLines(wrapFor(TEXT, [[0, 24], [25, 51]]), TEXT);
    expect(lines?.map((l) => l.text)).toEqual(["Damage ALL other enemies", "equal to the damage dealt."]);
  });

  it("refuses a wrap measured against different words — the stale case", () => {
    // Same LENGTH, different content: the case a length check alone would wave through, and the case that would
    // put words on screen the game is not saying.
    const other = TEXT.replace("Damage ALL", "Damage TWO");
    expect(other.length).toBe(TEXT.length);
    expect(godotLines(wrapFor(TEXT, [[0, 24], [25, 51]]), other)).toBeNull();
  });

  it("refuses a wrap measured against a different length", () => {
    expect(godotLines(wrapFor(TEXT, [[0, 24]]), TEXT + "!")).toBeNull();
  });

  it("slices the PARSED string for a rich label, never the caller's markup", () => {
    // A bbcode label's own `text` IS the markup; the ranges address the resolved content. Slicing the caller's
    // string here would emit tag fragments as words.
    const parsed = "Deal 9 damage.";
    const wrap = wrapFor(parsed, [[0, 14]], { basis: "parsed", parsedText: parsed });
    expect(godotLines(wrap, "Deal [color=green]9[/color] damage.")?.map((l) => l.text)).toEqual([parsed]);
  });

  it("refuses a parsed basis whose string the wire did not carry", () => {
    const wrap = wrapFor("Deal 9 damage.", [[0, 14]], { basis: "parsed", parsedText: null });
    expect(godotLines(wrap, "Deal 9 damage.")).toBeNull();
  });

  it("answers null for a node with no streamed wrap, which is most of them", () => {
    expect(godotLines(null, TEXT)).toBeNull();
    expect(godotLines(undefined, TEXT)).toBeNull();
  });
});
