export function traceDecodeEvidenceError(decodeCount, cacheFamily, canonicalNames, bridgeWindow = null) {
  if (decodeCount > 0 || bridgeWindow !== null) return null;
  return `no ${canonicalNames.join("/")} events matched (cacheFamily=${cacheFamily}) — image decode is UNMEASURED, not fast; re-check the decode-cache event names for this Chrome`;
}
