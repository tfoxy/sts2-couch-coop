import type { RenderRecord } from "./recordModel";

// --- hand-card PARITY gauge (`?handParity=1`) --------------------------------------------------------------
//
// The question this answers: when a card transition ends, is the client's card where the GAME says it is? A tween
// settle is the one moment the two can be compared — the client has just finished replaying the hint, and the pin
// catch-up above holds the pose the producer streamed in the meantime (the game's own truth). Recording both, per
// settle, turns "the cards jump at the end of a transition" from an eyeball report into a number.
//
// OFF by default and zero-cost when off (one boolean read per settle). Entries are capped so a long session can't
// grow the array without bound; `drifted`/`maxDriftPx` keep counting past the cap so a truncated log still reports
// honestly. Read from a bench/devtools via `window.__mirrorHandParity`.
// THE POST-SETTLE HALF. The measure above compares the endpoint against what the producer streamed WHILE the pin
// was up — so a node the producer suppressed for the whole window scores 0 drift no matter how wrong the endpoint
// was: nothing ever contradicted it. The contradiction arrives one frame LATER, as the first streamed pose after
// the suppression window closes, and on screen that is exactly the jump being hunted. So each settle also arms a
// short WATCH: the first streamed transform to reach `pinTween` within the window is compared against the value the
// element was actually left at. It is a gauge, not a gate — a genuine game-initiated move inside the watch counts
// as a snap too, which is why the window is short and the number is read as a trend, not a verdict.
const HAND_PARITY_WATCH_MS = 500;
interface HandParityEntry {
  /** Mirror node id, and its slash-joined scene path (`data-node-path`) when the element carries one. */
  id: string;
  path: string;
  /** Which measure this is: the settle comparison, or the first streamed pose after one. */
  kind: "settle" | "post-settle";
  /** `performance.now` of the settle. */
  at: number;
  /** Where the client's replayed tween ended, and where the game says it should be (null = the two agree). */
  settled: string | null;
  streamed: string | null;
  /** Endpoint → game translation error, in DESIGN px (element transforms are parent-relative design space). */
  dx: number;
  dy: number;
  distPx: number;
}
const mirrorHandParity = {
  enabled: false,
  /** Transform settles seen since the last reset. */
  settles: 0,
  /** …of which ended somewhere other than the game's pose. */
  drifted: 0,
  maxDriftPx: 0,
  /** Settles whose watch window actually saw a streamed pose (the rest expired uncontradicted). */
  postSettles: 0,
  /** …of which arrived at a DIFFERENT pose than the settle left the element at — a visible jump. */
  snapped: 0,
  maxSnapPx: 0,
  /** Entries dropped because `entries` hit ENTRY_CAP. */
  dropped: 0,
  entries: [] as HandParityEntry[]
};
const HAND_PARITY_ENTRY_CAP = 1024;
let handParityEnabled =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("handParity") === "1";

/** The translation of a baked `matrix(a, b, c, d, tx, ty)`, or null for anything else (`none`, a keyword, junk). */
function cssTranslation(value: string | null): [number, number] | null {
  if (!value) {
    return null;
  }
  const m = /matrix\(([^)]*)\)/.exec(value);
  if (!m) {
    return null;
  }
  const parts = m[1].split(",");
  if (parts.length < 6) {
    return null;
  }
  const x = Number(parts[4]);
  const y = Number(parts[5]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function noteHandParity(
  record: RenderRecord,
  now: number,
  settled: string | null,
  catchup: string | null
): void {
  mirrorHandParity.settles += 1;
  let dx = 0;
  let dy = 0;
  const a = cssTranslation(settled);
  const b = catchup != null ? cssTranslation(catchup) : null;
  if (a && b) {
    dx = b[0] - a[0];
    dy = b[1] - a[1];
  }
  const distPx = Math.hypot(dx, dy);
  if (catchup != null && catchup !== settled) {
    mirrorHandParity.drifted += 1;
    if (distPx > mirrorHandParity.maxDriftPx) {
      mirrorHandParity.maxDriftPx = distPx;
    }
  }
  if (mirrorHandParity.entries.length >= HAND_PARITY_ENTRY_CAP) {
    mirrorHandParity.dropped += 1;
    return;
  }
  mirrorHandParity.entries.push({
    id: record.id,
    path: record.el?.getAttribute("data-node-path") ?? "",
    kind: "settle",
    at: now,
    settled,
    streamed: catchup,
    dx,
    dy,
    distPx
  });
}

/**
 * Close a post-settle watch WITHOUT scoring it. The gauge asks one question — "did the pose the client's replayed
 * tween left this element at survive contact with the game's next word on the subject?" — and that question is only
 * meaningful while nothing ELSE has legitimately moved the element in the meantime. Every such event cancels:
 *
 *   - a re-arm or a prime of the transform channel (a NEW tween supersedes the settled one; its endpoint is where
 *     the element is going now, so the next streamed pose is being compared against a pose nobody claims any more —
 *     a re-arm inside the window was a GUARANTEED false snap);
 *   - a card FLIGHT taking the channel (the discard/draw curve is its own authority frame by frame);
 *   - the element going away (nothing left to compare, and a re-created one starts clean).
 *
 * OPACITY arms deliberately do NOT cancel: a fade moves nothing, so a settled transform is still exactly as
 * accountable during one as it was before it — and hand cards fade constantly, so cancelling on them would blind
 * the gauge to most of the window it exists to watch.
 *
 * Free when the gauge is off (`parityWatchUntil` is only ever non-zero under `?handParity=1`).
 */
function cancelParityWatch(record: RenderRecord): void {
  if (record.parityWatchUntil === 0) {
    return;
  }
  record.parityWatchUntil = 0;
  record.parityWatchTransform = null;
  record.parityWatchParentId = null;
}

// The post-settle watch (see HAND_PARITY_WATCH_MS). Called from `pinTween` — BEFORE its fast-out, since a settled
// node owns no channel any more — with the transform the walk is about to write for this node, or null when the
// producer shipped none this frame. The FIRST non-null one closes the watch; a watch that expires with nothing
// streamed closes silently (the producer never contradicted the endpoint, which is the case the settle measure
// already scores as zero drift).
//
// Aug-20: the two ways a watch dies UNSCORED are checked first, because both used to score. (a) EXPIRY was only
// enforced on the streamed==null branch, so a node the producer stayed silent about for a second and then moved for
// ordinary gameplay reasons counted the move as a snap — at any distance, at any later time. (b) A REPARENT keeps
// the record and the id but changes the space: these transforms are parent-relative, so comparing a pose taken under
// the hand against one taken under the discard pile measured the distance between two ORIGINS (a live end-turn
// discard reported 489px of "snap" while direct element sampling showed 0.0px of visible discontinuity).
function notePostSettleSnap(record: RenderRecord, streamed: string | null, now: number): void {
  if (now >= record.parityWatchUntil) {
    cancelParityWatch(record); // expired — the window is what makes a jump attributable to the settle
    return;
  }
  // `record.lastNode` is already THIS walk's node here (visit assigns it before the paint block), so this is the
  // parent the pose about to be written is relative to.
  if ((record.lastNode?.parentId ?? null) !== record.parityWatchParentId) {
    cancelParityWatch(record);
    return;
  }
  const settled = record.parityWatchTransform;
  if (streamed == null) {
    return; // still inside the window, still uncontradicted — keep watching
  }
  const a = cssTranslation(settled);
  const b = cssTranslation(streamed);
  if (streamed !== settled && (a === null || b === null)) {
    // Two poses we cannot measure between (a non-`matrix(...)` string: `none`, a keyword, a null settle). Scoring
    // this as a snap of dx=dy=0 — which is what it used to do — puts a phantom in the `snapped` count that the px
    // columns can never explain. Defensive only: every writer of both values bakes a matrix, so this is unreachable
    // today, which is also why it carries no test seam.
    cancelParityWatch(record);
    return;
  }
  cancelParityWatch(record);
  mirrorHandParity.postSettles += 1;
  const dx = a && b ? b[0] - a[0] : 0;
  const dy = a && b ? b[1] - a[1] : 0;
  const distPx = Math.hypot(dx, dy);
  if (streamed === settled) {
    return; // the game agrees with where the element was left — nothing jumped, nothing to log
  }
  mirrorHandParity.snapped += 1;
  if (distPx > mirrorHandParity.maxSnapPx) {
    mirrorHandParity.maxSnapPx = distPx;
  }
  if (mirrorHandParity.entries.length >= HAND_PARITY_ENTRY_CAP) {
    mirrorHandParity.dropped += 1;
    return;
  }
  mirrorHandParity.entries.push({
    id: record.id,
    path: record.el?.getAttribute("data-node-path") ?? "",
    kind: "post-settle",
    at: now,
    settled,
    streamed,
    dx,
    dy,
    distPx
  });
}

if (typeof window !== "undefined") {
  mirrorHandParity.enabled = handParityEnabled;
  (window as unknown as Record<string, unknown>).__mirrorHandParity = mirrorHandParity;
}


export { cancelParityWatch, handParityEnabled, notePostSettleSnap, noteHandParity, HAND_PARITY_WATCH_MS };
