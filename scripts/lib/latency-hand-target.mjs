// Pure geometry used by the latency harness before its one trusted hover.
// Rects and poses come from the existing browser seams; no game-specific nodes or actions.
export function acceptHandHitStack(stack, targetCardId, competingCardIds = []) {
  const ids = Array.isArray(stack?.ids) ? stack.ids : [];
  const first = ids[0] ?? null;
  // A blocker above the card leaves no owner in the stack. A blocker below it
  // does not shadow the card. The first owner must be this card, not its hitbox.
  const accepted = Boolean(targetCardId && first === targetCardId &&
    stack?.topStamp === "other" && !competingCardIds.includes(first));
  return { accepted, source: "mirror-hit-stack", ids: ids.slice(0, 12),
    blocked: Boolean(stack?.blocked), topStamp: stack?.topStamp ?? null };
}

// Choose a single pre-disconnect hover within the game viewport that claims no
// hand footprint or interactive renderer owner. This is setup, never a sample.
export function selectNeutralParkingPoint({ holders, rects, stageWidth, stageHeight, acceptPoint }) {
  if (!(stageWidth > 0 && stageHeight > 0) || typeof acceptPoint !== "function") return null;
  const byId = new Map(rects.map(rect => [rect.id, rect]));
  const hand = holders.filter(h => h.inFan);
  if (!hand.length || hand.some(h => !h.hitboxId || !byId.has(h.hitboxId))) return null;
  const clearOf = (rect, gx, gy) => {
    const m = rect.transform, r = rect.localRect;
    if (!Array.isArray(m) || m.length < 6 || !m.every(Number.isFinite) ||
        !r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
        r.width <= 0 || r.height <= 0) return false;
    const determinant = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return false;
    const x = gx - m[4] - (rect.spreadDx ?? 0);
    const y = gy - m[5] - (rect.raiseDy ?? 0);
    const lx = (m[3] * x - m[2] * y) / determinant;
    const ly = (-m[1] * x + m[0] * y) / determinant;
    const fx = (lx - r.x) / r.width, fy = (ly - r.y) / r.height;
    return Number.isFinite(fx) && Number.isFinite(fy) &&
      (fx < -.05 || fx > 1.05 || fy < -.05 || fy > 1.05);
  };
  for (const fy of [.25, .35, .45, .55, .65]) for (const fx of [.5, .35, .65, .2, .8]) {
    const gx = stageWidth * fx, gy = stageHeight * fy;
    if (hand.some(h => !clearOf(byId.get(h.hitboxId), gx, gy))) continue;
    const acceptance = acceptPoint({ gx, gy, fx, fy });
    if (acceptance?.accepted) return { gx, gy, fx, fy, acceptance };
  }
  return null;
}

export function selectHandTarget({ holders, rects, neutralRects, stageWidth, stageHeight, acceptPoint = null }) {
  const byId = new Map(rects.map(rect => [rect.id, rect]));
  const candidateXs = [.12, .25, .4, .5, .6, .75, .88];
  const candidateYs = [.28, .38, .48, .58, .68];
  const eligible = holders.filter(holder => holder.inFan && holder.zIndex !== 1 &&
    !holder.channelLive && holder.hitboxId && byId.has(holder.hitboxId));
  const matrixPoint = (rect, lx, ly) => {
    const m = rect.transform;
    if (!Array.isArray(m) || m.length < 6 || !m.every(Number.isFinite) ||
        !Number.isFinite(lx) || !Number.isFinite(ly)) return null;
    return [m[0] * lx + m[2] * ly + m[4] + (rect.spreadDx ?? 0),
      m[1] * lx + m[3] * ly + m[5] + (rect.raiseDy ?? 0)];
  };
  const localPoint = (rect, gx, gy) => {
    const m = rect.transform;
    if (!Array.isArray(m) || m.length < 6 || !m.every(Number.isFinite) ||
        !Number.isFinite(gx) || !Number.isFinite(gy)) return null;
    const determinant = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return null;
    const x = gx - m[4] - (rect.spreadDx ?? 0);
    const y = gy - m[5] - (rect.raiseDy ?? 0);
    return [(m[3] * x - m[2] * y) / determinant,
      (-m[1] * x + m[0] * y) / determinant];
  };
  const normalizedMargin = (rect, point) => {
    if (!point) return -Infinity;
    const r = rect.localRect;
    if (!(r.width > 0 && r.height > 0) || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) return -Infinity;
    const fx = (point[0] - r.x) / r.width;
    const fy = (point[1] - r.y) / r.height;
    return Math.min(fx, 1 - fx, fy, 1 - fy);
  };
  const otherRects = holders.filter(holder => holder.inFan && holder.hitboxId && byId.has(holder.hitboxId))
    .map(holder => ({ holder, rect: byId.get(holder.hitboxId), neutral: neutralRects?.[holder.id] ?? null }));
  const focused = holders.some(h => h.inFan && h.zIndex === 1);
  // Once a focused card lowers, any hand card can move into the intended point.
  if (focused && holders.some(h => h.inFan &&
    (!h.hitboxId || !byId.has(h.hitboxId) || !neutralRects?.[h.id]))) return null;
  for (const holder of eligible.sort((a, b) => a.mDrawn[4] - b.mDrawn[4])) {
    const rect = byId.get(holder.hitboxId);
    const neutral = neutralRects?.[holder.id] ?? null;
    // If the hand is already focused, the unhovered pose is essential: the
    // hover itself can lower/re-layout this target before the native hit test.
    if (focused && !neutral) continue;
    const viable = [];
    for (const fy of candidateYs) for (const fx of candidateXs) {
      const r = rect.localRect;
      const point = matrixPoint(rect, r.x + fx * r.width, r.y + fy * r.height);
      if (!point) continue;
      const [gx, gy] = point;
      if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
      if (gx < 2 || gy < 2 || gx > stageWidth - 2 || gy > stageHeight - 2) continue;
      const currentMargin = normalizedMargin(rect, localPoint(rect, gx, gy));
      const neutralMargin = neutral ? normalizedMargin(neutral, localPoint(neutral, gx, gy)) : currentMargin;
      if (currentMargin < .10 || neutralMargin < .10) continue;
      if (otherRects.some(other => other.holder.id !== holder.id &&
        (normalizedMargin(other.rect, localPoint(other.rect, gx, gy)) > -.025 ||
          (other.neutral && normalizedMargin(other.neutral, localPoint(other.neutral, gx, gy)) > -.025)))) continue;
      const score = Math.min(currentMargin, neutralMargin);
      viable.push({ gx, gy, fx, fy, currentMargin, neutralMargin, score });
    }
    viable.sort((a, b) => b.score - a.score);
    for (const point of viable) {
      const acceptance = acceptPoint?.(holder, point) ?? { accepted: true };
      if (acceptance.accepted) return { holder, rect, neutral, point, acceptance };
    }
  }
  return null;
}
