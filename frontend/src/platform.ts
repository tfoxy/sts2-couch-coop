// Platform predicates that more than one workstream has to agree about — a LEAF module, importing nothing.
//
// It exists for the same reason `mirror/settingsStorage.ts` does: two modules on opposite sides of an import
// edge need the same answer, and neither may pull the other's dependencies in. `pwa/installPrompt.ts` (which
// imports vue) and `render/quality.ts` (which documents itself as importing almost nothing, so it can be
// resolved before everything else) both need the iOS test below, and a second copy of it would be a rule that
// drifts rather than a rule.

/**
 * iPhone/iPad, including iPadOS 13+ which reports a desktop "Macintosh" UA and is only distinguishable
 * by having touch points.
 *
 * WHAT IT IS NOT: a "mobile" test. An iPad-masquerading-as-a-Mac answers true here and false to
 * `RenderQualitySignals.mobile`'s UA regex, which is correct — this asks which BROWSER ENGINE is running
 * (every browser on iOS is WebKit, however it is branded), not how big the screen is.
 *
 * Two other copies of this test exist on purpose and are NOT this function:
 *   * `boot/bootstrap.ts` inlines it inside `webLinkBlockedByBrowser` — the public origin ships ~5 KB of
 *     bootstrap and importing anything at all is the cost it is avoiding;
 *   * `join/joinModel.ts`'s `isIosSafari` is a WEAKER predicate (no touch-points term) for a different
 *     question. Don't merge them without deciding whether an iPad-masquerade belongs in its answer.
 */
export function isIosPlatform(userAgent: string | null | undefined, maxTouchPoints = 0): boolean {
  if (typeof userAgent !== "string") return false;
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return userAgent.includes("Macintosh") && maxTouchPoints > 1;
}
