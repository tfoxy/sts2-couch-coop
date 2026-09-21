/**
 * Bound the cold-page foreground proof without reopening a tab that Android is
 * already scheduling. A single first window can be slow while Chrome restores
 * a just-created page; a background or frozen page never reaches minRaf.
 */
export async function sampleRafUntilForeground({ sample, minRaf, maxSamples = 3 }) {
  const rates = [];
  for (let i = 0; i < maxSamples; i++) {
    const rate = await sample();
    rates.push(rate);
    if (rate >= minRaf) return { rates, best: Math.max(...rates), foreground: true };
  }
  return { rates, best: Math.max(...rates), foreground: false };
}
