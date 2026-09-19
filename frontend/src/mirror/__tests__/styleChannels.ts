// THE DOM STAGE'S TWO DRAWN CHANNELS, READ BACK THE WAY A BROWSER WOULD RUN THEM.
//
// A holder's drawn y is the SUM of its `transform` (the game's pose) and its `translate` (the cosmetic lift), and
// the renderer writes both within one frame — a start value under an instant transition, a style barrier, then the
// eased target. jsdom runs no transitions, so the values a browser would interpolate BETWEEN are only visible in
// the ORDER of the writes; `watchStyle` records every state the `style` attribute passed through, and `channelOf`
// reads one channel's `from`/`to`/timing out of that sequence: `from` is the value in force when the eased
// transition was first specified (the browser's transition start), `to` the value the frame ended on.
//
// Shared by `handRaise.spec.ts` (which pins the DOM channel writes directly) and `handLiftPhase.spec.ts` (which
// holds the two stages' drawn starts against each other). A second copy of this reader is how the arms would come
// to be measured differently, which is the one thing a parity spec cannot afford.
//
// Not a `.spec.ts`, so vitest's default include glob does not collect it as a test file.

/** Every value `el`'s style attribute took from here on, oldest first, with the final state last. Read ONCE. */
export function watchStyle(el: HTMLElement): () => string[] {
  const observer = new MutationObserver(() => {});
  observer.observe(el, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
  return () => {
    const states = observer.takeRecords().map((record) => String(record.oldValue ?? ""));
    states.push(el.getAttribute("style") ?? "");
    observer.disconnect();
    return states;
  };
}

export function styleValue(state: string, prop: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]*)`).exec(state);
  return match ? match[1].trim() : null;
}

/** The vertical component of a channel's value: `matrix(a, b, c, d, x, y)` → y, `0px -41px` → -41, `0px` → 0. */
export function channelY(state: string, prop: "transform" | "translate"): number {
  const value = styleValue(state, prop);
  if (value == null || value === "" || value === "none") return 0;
  if (prop === "transform") {
    const matrix = /matrix\(([^)]*)\)/.exec(value);
    return matrix ? Number(matrix[1].split(",")[5]) : 0;
  }
  const parts = value.split(/\s+/);
  return parts.length > 1 ? Number.parseFloat(parts[1]) : 0;
}

/** This state's transition timing for the channel: 0ms (instant/absent) or the duration plus its easing. */
export function channelTiming(state: string, prop: string): { ms: number; ease: string } {
  const transition = styleValue(state, "transition") ?? "";
  const timed = new RegExp(`\\b${prop}\\s+([\\d.]+)(m?s)(?:\\s+(cubic-bezier\\([^)]*\\)|[a-z-]+))?`).exec(transition);
  if (!timed) return { ms: 0, ease: "" };
  return { ms: Number(timed[1]) * (timed[2] === "s" ? 1000 : 1), ease: timed[3] ?? "" };
}

export function channelOf(
  states: string[],
  prop: "transform" | "translate"
): { from: number; to: number; ms: number; ease: string } {
  const final = states[states.length - 1];
  const armed = states.findIndex((state) => channelTiming(state, prop).ms > 0);
  return {
    from: channelY(armed === -1 ? final : states[armed], prop),
    to: channelY(final, prop),
    ...channelTiming(final, prop)
  };
}
