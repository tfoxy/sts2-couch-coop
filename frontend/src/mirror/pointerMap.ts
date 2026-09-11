// The mirror's ONE bidirectional VISUAL ANCHOR MAP: at any stage point, the game↔stage horizontal
// correspondence is the affine map of the TOPMOST VISIBLY-PAINTING element under the pointer (its true 1920-space
// game rect ↔ its rendered stage rect). This replaces the old two-mode (design-coordinate vs element-addressed)
// input scheme with a single coordinate resolution the game hit-tests natively.
//
// The whole map exists only because a wider-than-16:9 stage re-lays-out content horizontally on ONE squeeze field
// (mirrorRenderer's proportional spread: renderedX = gameX·designW/1920). A node authored at game-x is drawn at
// `gameX + spreadDx`. So the game coordinate under a pointer is NOT `fraction·designWidth` any more — it's that
// value minus the shift of whatever is actually painted there. On a 16:9 stage design space IS game space (no shift
// anywhere), so the map short-circuits to the pure fraction with ZERO probes (the phone-CPU rule — a hit test costs
// the DOM backend a forced layout, which we must never pay per hover frame on a phone, and phones are never widened).
//
// WHO ANSWERS "what is painted there" (M0): the RENDERER, through `spreadPainterAt` — this module holds the
// arithmetic and the demotion policy, and takes the painter as an input. That is what lets the same anchor map work
// over a canvas stage, which has no elements to walk.
//
// A drag freezes not just the resolved point but the FIELD AFFINE at the press (coordX = a·designX + b): a drag
// begun on a proportional world element (a card) replays the whole-world SQUEEZE so the finger keeps the content;
// a drag on an anchored HUD element replays its fixed TRANSLATION. This lets drag-motion frames run pure math with
// no DOM probes (the phone-CPU rule again).
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only.

import { affineInverse, nodeMatrix } from "@/mirror/affine";
import type { InteractiveRect, SpreadPainter } from "@/mirror/renderer/contracts";
import { domSpreadPainterAt } from "@/mirror/renderer/domHitProbes";
import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH } from "@/mirror/sceneTree";

// The horizontal FIELD affine at a resolved point: `coordX = a·designX + b`. A gesture freezes this and replays it
// with pure math on drag-motion frames (no DOM probe). Prop world content → the squeeze `a = 1920/designW, b = 0`;
// anchored HUD → the translation `a = 1, b = −dx`; 16:9 → identity `a = 1, b = 0`.
export interface FieldAffine {
  a: number;
  b: number;
}

// The resolved game coordinate, the field affine used to get there, the SHIFT (`designX − coordX`, kept for the
// renderer's cursor-follower / stamping), and the pointer's design-space X (so the input side can run the
// hit-consistency pass without re-deriving it).
export interface PointerMapping {
  coordX: number;
  coordY: number;
  shift: number;
  affine: FieldAffine;
  designX: number;
  // The resolved coordX came from the UNIFORM SQUEEZE field (`designX·1920/designW`) rather than from a specific
  // painter's own translation (`designX − dx`). A squeezed coordinate carries NO per-painter misregistration — which
  // is the only thing the near-miss pass exists to undo — so the pass is SUPPRESSED for it (see nearMissApplies).
  squeezed: boolean;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampGameX(value: number): number {
  return value < 0 ? 0 : value > MIRROR_DESIGN_WIDTH ? MIRROR_DESIGN_WIDTH : value;
}

function mapping(
  coordX: number,
  coordY: number,
  designX: number,
  affine: FieldAffine,
  squeezed = false
): PointerMapping {
  return { coordX, coordY, shift: designX - coordX, affine, designX, squeezed };
}

// Map a viewport pixel to GAME design space (1920x1080 — the headless viewport the game hit-tests in), inverting
// the wide-screen re-layout via the topmost visibly-painting element under the pointer. `stageRect` is the stage's
// rendered (scaled) client rect; `designWidth` is the LIVE widened design width (=== MIRROR_DESIGN_WIDTH on 16:9).
//
// `painterAt` is the RENDERER's probe for "which painter anchors this pixel" (mirrorRenderer.spreadPainterAt) —
// the one DOM-shaped question this module used to answer itself, now asked of whichever backend drew the frame.
// It is handed the backdrop-demotion threshold below and answers with the first painter that survives it; `null`
// means it walked and found none (→ the uniform-squeeze fallback), `undefined` means the backend cannot hit-test
// at all (→ the identity, exactly what the pre-seam `no elementsFromPoint` arm returned). The default is the DOM
// backend's own walk, so an unwired caller is byte-identical to before the seam.
export function mapPointerToGame(
  clientX: number,
  clientY: number,
  stageRect: DOMRect,
  designWidth: number,
  painterAt: (
    clientX: number,
    clientY: number,
    backdropWidthPx: number
  ) => SpreadPainter | null | undefined = domSpreadPainterAt
): PointerMapping {
  if (stageRect.width <= 0 || stageRect.height <= 0) {
    return { coordX: 0, coordY: 0, shift: 0, affine: { a: 1, b: 0 }, designX: 0, squeezed: false };
  }
  const designX = clamp01((clientX - stageRect.left) / stageRect.width) * designWidth;
  const coordY = clamp01((clientY - stageRect.top) / stageRect.height) * MIRROR_DESIGN_HEIGHT;

  // 16:9 — design space IS game space; nothing shifted, so the fraction is exact. NO probe at all (phone-CPU rule).
  if (designWidth === MIRROR_DESIGN_WIDTH) {
    return mapping(designX, coordY, designX, { a: 1, b: 0 });
  }

  // The uniform SQUEEZE field: design space maps linearly back to 1920 (renderedX = gameX·designW/1920 inverted).
  const squeezeA = MIRROR_DESIGN_WIDTH / designWidth;
  const stageW = stageRect.width;

  // THE BACKDROP THRESHOLD (the demotion policy, which stays here — the probe only measures and compares).
  //
  // A full-stage BACKDROP — a width-stretched span (`data-spread-w`) or an element as wide as the stage — must NOT
  // impose its (usually squeezed) map on the content painted ABOVE it (a re-centered vignette can't govern a card
  // floating over it). The probe skips it and keeps walking for a more specific painter; if none is found the
  // uniform-squeeze fallback below maps it (a full-span backdrop's rect-pair IS that same squeeze).
  //
  // FULL-FRAME BAND. The stage-relative test above has a hole big enough to
  // drive the turn banner through, and the turn banner drove through it. An element authored to span the game's
  // OWN 1920 frame is a band by construction — it cannot speak for a specific widget, which is exactly the
  // reasoning `STAGE_BAND_FRACTION` already applies on the near-miss side. But on a widened stage such an element
  // is only 1920/designWidth of the stage (80% at 2400, 76% at 2520), so it sails under a 0.95·stageW threshold
  // and, being ANCHORED, imposes its centring translation (dx = (designW − 1920)/2) on everything under it.
  //
  // Measured live at 2400x1080 with a hand on screen: for as long as the start-of-turn banner is up, the first
  // painter over a hand card is `PlayerTurnBanner/TurnNumber` (1920 wide, anchored, dx 240), so a pointer at
  // design x 450 resolved to game x 210 instead of 360 — a whole card-and-a-half to the left. That also destroys
  // the readable-hand claim (the mis-placed point is inside no card's drawn box), so the raise inverse silently
  // becomes the identity and the sent Y keeps the raised value too: the card the finger is on focuses nothing at
  // all until the banner leaves. The banner plays at the START OF EVERY TURN, so on a 20:9 phone this is not an
  // edge case; 16:9 never sees it because the map short-circuits there with no probe at all.
  //
  // The frame-band threshold is expressed in the frame's own terms and converted to client px: 1920 design px
  // occupy `stageW · 1920/designWidth` of the stage. It is always the tighter of the two, so the pair is exactly
  // the narrower bound.
  const stageBandWidth = 0.95 * stageW;
  const frameBandWidth = FRAME_BAND_FRACTION * stageW * (MIRROR_DESIGN_WIDTH / designWidth);
  const backdropWidthPx = frameBandWidth < stageBandWidth ? frameBandWidth : stageBandWidth;

  const painter = painterAt(clientX, clientY, backdropWidthPx);
  if (painter === undefined) {
    // No hit test available in this environment at all (never a live browser) — nothing can be anchored, so the
    // pointer's own fraction is the best answer, as it was before this seam existed.
    return mapping(designX, coordY, designX, { a: 1, b: 0 });
  }
  if (painter) {
    if (painter.prop) {
      // PROPORTIONAL world content (a card, a creature, an arrow segment): the hit itself resolves via the exact
      // local translation (`designX − dx`, correct for a point ON this rigid element), but the FROZEN field is the
      // whole-world squeeze — a drag begun here spreads the world under the finger.
      // EXCEPTION: a prop painter wider than ~60% of the stage (the oversized center-anchored parallax bg) has a
      // rigid ~2765-wide span that misregisters the field, and its own hit identity is irrelevant → squeeze coord too.
      const squeezed = painter.widthPx > 0.6 * stageW;
      const coordX = clampGameX(squeezed ? designX * squeezeA : designX - painter.dx);
      return mapping(coordX, coordY, designX, { a: squeezeA, b: 0 }, squeezed);
    }
    // ANCHORED HUD: subtract its fixed translation; a drag begun here replays that same translation.
    const coordX = clampGameX(designX - painter.dx);
    return mapping(coordX, coordY, designX, { a: 1, b: -painter.dx });
  }

  // No specific painter (dead letterbox space, or only a widened backdrop was seen) → the uniform squeeze field.
  return mapping(clampGameX(designX * squeezeA), coordY, designX, { a: squeezeA, b: 0 }, true);
}

// How many times the hit-consistency pass will step across abutting interactive rects before giving up (a pointer
// in a dense near-miss band shouldn't loop unboundedly; ~4 covers the worst real HUD cluster).
const HIT_CONSISTENCY_ITERATIONS = 4;

// A rect whose GAME-x extent covers at least this fraction of the 1920 stage is a "stage-band" bar (the TopBar bar,
// a full-band dialog backdrop): it spans the frame and can't speak for a specific widget, so it never VOUCHES in the
// legit-hit guard (see topOffender). Matches the backdrop-demote threshold in mapPointerToGame.
const STAGE_BAND_FRACTION = 0.95;

// The same "this thing is a band, not a widget" idea, asked of the GAME FRAME instead of the stretched stage, and
// used by mapPointerToGame's painter walk (see the demotion block there for the measurement behind it). Kept
// slightly under 1 for the same reason STAGE_BAND_FRACTION is: an authored full-frame element can round a pixel
// short. Deliberately NOT shared with STAGE_BAND_FRACTION despite the equal value — they answer different
// questions about different denominators, and a later tune of one must not silently move the other.
const FRAME_BAND_FRACTION = 0.95;

// SQUEEZE GATE. May the hit-consistency pass run for a coordinate resolved this way? The pass exists to undo ONE
// thing: a point mapped through a specific painter's own translation (`designX − painterDx`) can land inside the
// GAME rect of a DIFFERENTLY-shifted control the user is visually not over. A coordinate that came from the uniform
// SQUEEZE instead (`designX·1920/designW` — the >60%-wide prop backdrop exception and the no-specific-painter
// fallback) carries no per-painter dx at all, so there is nothing to undo; worse, under the squeeze practically
// EVERY spread rect looks like an offender by construction (a rect's rendered box is `[gLeft+dx, gRight+dx]` but the
// squeeze-consistent band is `[gLeft·s, gRight·s]` — wider for every rect once s > 1). Running the pass there made
// the sent X BISTABLE between adjacent hover samples (measured 268.61 design px of step jump at 2520x1080,
// scripts/probe-targeting-drag-jump.mjs). So: squeeze in ⇒ no push.
export function nearMissApplies(squeezed: boolean): boolean {
  return !squeezed;
}

// The same question asked of a FIELD AFFINE alone — for the hover-probe memo, which has no PointerMapping to consult
// and resolves by replaying `a·designX + b` verbatim. That replay IS the uniform squeeze whenever the frozen field is
// the squeeze one (`a = 1920/designW ≠ 1, b = 0`), regardless of which painter the memo was taken over; the anchored
// -HUD field (`a = 1, b = −dx`) is the per-painter translation the pass is for.
export function isSqueezeAffine(affine: FieldAffine): boolean {
  return affine.b === 0 && affine.a !== 1;
}

// DIRECTIONAL HYSTERESIS (the belt to the squeeze gate's braces). A push direction is otherwise decided fresh on
// every sample from whichever offender happens to be topmost there, and in a dense near-miss band (overlapping
// creature Hitbox/HpBarHitbox Controls) the topmost offender ALTERNATES between adjacent samples — each one deriving
// `dir` from its OWN rendered mid, so the sent X flips left/right/left. Remembering the last decision and re-using it
// while the pointer is still walking the SAME band makes the walk monotonic. Cleared on press/release and on any
// stage-rect invalidation (resize / screen change) — see resetNearMissMemory.
interface NearMissMemory {
  offenderId: string;
  dir: number;
  designX: number;
  gLeft: number;
  gRight: number;
}
let nearMissMemory: NearMissMemory | null = null;

// How far (design px) the pointer may travel and still count as "the same band region" for the hysteresis above.
// A hover sample steps ~10-15 design px; this spans a few samples without letting a stale direction survive a jump
// clear across the stage.
const NEARMISS_HYSTERESIS_PX = 64;

// Forget the last push direction: a new gesture (press/release) or a new stage geometry starts a fresh band walk.
export function resetNearMissMemory(): void {
  nearMissMemory = null;
}

// Is the offender we just found part of the SAME band region the remembered decision was made in? Either literally
// the same control, or one whose game-x extent overlaps it — and reached without the pointer having jumped away.
function sameBandRegion(memory: NearMissMemory, id: string, gLeft: number, gRight: number, designX: number): boolean {
  if (Math.abs(designX - memory.designX) > NEARMISS_HYSTERESIS_PX) {
    return false;
  }
  return id === memory.offenderId || (gLeft <= memory.gRight && gRight >= memory.gLeft);
}

// PROBE SEAM (dev only): when the page installs `window.__probeNearMiss` BEFORE this module loads, every pass
// reports the decision it made. One boolean check in production, where the hook is never installed.
type NearMissProbeRecord = {
  offenderId: string | null;
  gLeft: number | null;
  gRight: number | null;
  dir: number;
  seeded: boolean;
  gameX: number;
  designX: number;
  outX: number;
};
const NEARMISS_PROBE = typeof window !== "undefined" && "__probeNearMiss" in window;
function reportNearMiss(record: NearMissProbeRecord): void {
  const hook = (window as unknown as { __probeNearMiss?: (r: NearMissProbeRecord) => void }).__probeNearMiss;
  if (typeof hook === "function") {
    hook(record);
  }
}

// True when the GAME point (gx, gy) is inside interactive rect `r`'s box (point mapped into the rect's local
// [0,w]×[0,h] via the inverse of its placement matrix — handles rotation/skew). `width` defaults to the game box;
// the RENDERED containment test passes `r.renderedWidth` for a width-STRETCHED anchored span (a full-canvas 0/1
// blocker like `Game` renders 0..designW wide, not 0..1920 — judging it by the game width would flag it as "not
// under the pointer" past x=1920 and push every legit hover off the stage edge).
//
// `offsetY` shifts the PLACEMENT for the RENDERED test only: readable-hand mode draws a rect up to ~244 design px
// above where the game has it (raiseInverse.ts), and a rect the pointer IS visually over must not read as a
// near-miss just because its true box is elsewhere. 0 whenever the mode is off — i.e. always, on the mouse path
// this pass is for.
function pointInRectGame(
  r: InteractiveRect,
  gx: number,
  gy: number,
  width = r.localRect.width,
  offsetY = 0
): boolean {
  const inv = affineInverse(nodeMatrix(r.transform, r.localRect));
  if (!inv) {
    return false;
  }
  const y = gy - offsetY;
  const lx = inv[0] * gx + inv[2] * y + inv[4];
  const ly = inv[1] * gx + inv[3] * y + inv[5];
  return lx >= 0 && lx <= width && ly >= 0 && ly <= r.localRect.height;
}

// The rect's game-space horizontal extent [min, max] from its four transformed corners (rotation-safe).
function gameXExtent(r: InteractiveRect): [number, number] {
  const m = nodeMatrix(r.transform, r.localRect);
  const w = r.localRect.width;
  const h = r.localRect.height;
  const xs = [m[4], m[0] * w + m[4], m[2] * h + m[4], m[0] * w + m[2] * h + m[4]];
  return [Math.min(...xs), Math.max(...xs)];
}

// The topmost OFFENDER at game X `x`: scanning back-to-front (topmost paint order is LAST), the first rect whose
// GAME box contains the game point but whose RENDERED rect — game rect shifted right by spreadDx (and, for a
// stretched span, widened to renderedWidth) — does NOT contain the pointer, i.e. (designX − spreadDx, gameY) is
// outside that box. A rect the pointer IS visually over is a legitimate hit and never offends.
// LEGIT-HIT GUARD: z-aware vouching. The scan is topmost-first, so the FIRST rect
// whose game box contains the coord decides — mirroring the game's own topmost-first hit arbitration. When the
// pointer IS visually over that topmost rect (a legit hit) it VOUCHES (the scan stops, NO push) UNLESS it can't: a
// width-STRETCHED span (renderedWidth > 0 — a full-canvas blocker containing every pointer; symmetric with the
// never-OFFEND rule) or a stage-band bar (game-x extent ≥ 0.95·1920 — the TopBar bar, a full-band dialog backdrop).
// Those keep the scan going so a lower offender is still found (the pre-fix parchment-over-TopBar push is preserved).
// Only a normal-width widget genuinely under the pointer vouches.
// Shared by the iterating near-miss pass and the single-step squeeze gate below (twin of NearMiss.TopOffender).
// `designY` is the POINTER's own design Y, which is what the RENDERED test must be asked about; `gameY` is the
// resolved game Y, which is what the GAME test must. They are the same number for everything the mirror draws where
// the game has it — but readable-hand mode draws a hand card ~119px above its game box and the resolve un-maps that
// (raiseInverse), so on that one surface the two differ and using either for both is wrong. Defaulted, so every
// caller that has no raise to un-map is byte-identical.
function topNearMissOffender(
  x: number,
  gameY: number,
  designX: number,
  rects: readonly InteractiveRect[],
  designY: number = gameY
): InteractiveRect | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (!pointInRectGame(r, x, gameY)) {
      continue; // this rect's GAME box doesn't contain the resolved coord → not a candidate.
    }
    // Topmost rect whose GAME box contains the coord. RENDERED box does NOT contain the raw pointer → offender.
    if (
      !pointInRectGame(
        r,
        designX - r.spreadDx,
        designY,
        r.renderedWidth > 0 ? r.renderedWidth : r.localRect.width,
        r.raiseDy
      )
    ) {
      if (r.raiseDy !== 0 || r.raiseGoverned) {
        // A surface readable-hand mode moved VERTICALLY can never offend. This pass is a horizontal correction —
        // it undoes the wide-screen spread — and a failed rendered test on a raised rect need not mean the pointer
        // near-missed it in X at all: the resolved Y was un-mapped for whichever stamp the raise inverse claimed
        // (raiseInverse.ts), and that claim is decided independently and can miss this rect (nothing claims while
        // the hand is mid-relayout, for instance). Then the pointer's design Y is compared against a box the game
        // has 119px lower and the card reads as a near-miss of ITSELF. Measured live at 1920x950: hovering the
        // revealed band of the centre card pushed the sent X from game 960 to 280 — clear across the hand — so the
        // game focused nothing. Vouching (below) is still allowed: that direction only ever SUPPRESSES a push.
        //
        // `raiseGoverned` widens the rule to EVERY hand hit box while the mode is up, offset or not: the anchor /
        // claim machinery owns the whole hand's input then, and an ANCHOR (the focused dy:0 card's own centre
        // included) deliberately lands inside a card box the raw pointer may not be over — a fan neighbour's
        // anchor sits inside the focused card's box, and this pass pushing it out would break identity targeting.
        // WIDESCREEN-ONLY failure mode if this is ever lost: the pass only runs at designWidth > 1920, so no
        // 16:9 test can catch its absence.
        continue;
      }
      return r;
    }
    // The pointer IS visually over this rect — a legitimate hit.
    if (r.renderedWidth > 0) {
      continue; // stretched blocker never vouches (symmetric with the never-offend rule).
    }
    const [gLeft, gRight] = gameXExtent(r);
    if (gRight - gLeft >= STAGE_BAND_FRACTION * MIRROR_DESIGN_WIDTH) {
      continue; // stage-band bar can't vouch for a specific widget; keep the parchment-over-TopBar push.
    }
    return null; // legit hit of a normal-width widget under the pointer → no push.
  }
  return null;
}

// HIT-CONSISTENCY (near-miss) PASS. The inverse map places a pointer in empty space to the LEFT of a +dx-shifted
// button inside that button's GAME rect, so the game would hover/click a control the user is visually NOT over. Fix:
// if the resolved game point lands in a visible mouse-visible (Stop/Pass — buttons AND tooltip-only relics/gold)
// Control's GAME rect whose RENDERED rect (game rect + spreadDx)
// does NOT contain the pointer, push the game X OUT of that game rect toward the pointer's side; iterate in the SAME
// direction across any abutting rect the push lands in (capped). A pointer that IS visually over the rect is a
// legitimate hit and never pushes. Y is 1:1 (no vertical widening), so the pointer's design-Y === game Y.
export function pushOutOfNearMiss(
  gameX: number,
  gameY: number,
  designX: number,
  rects: readonly InteractiveRect[],
  designY: number = gameY
): number {
  const topOffender = (x: number): InteractiveRect | null =>
    topNearMissOffender(x, gameY, designX, rects, designY);
  let x = gameX;
  let dir = 0; // -1 = push left, +1 = push right; locked on the first offender so the walk never doubles back
  let seeded = false; // the lock came from the remembered direction (hysteresis) rather than this offender's mid
  let first: { id: string; gLeft: number; gRight: number } | null = null;
  // Finish: publish the decision (so the NEXT sample in this band inherits the direction), report it to the probe
  // seam, and return the clamped coordinate. `pushed` false = the pass changed nothing, which must not overwrite a
  // live band memory with a no-op.
  const finish = (value: number, pushed: boolean): number => {
    const outX = clampGameX(value);
    if (pushed && first) {
      nearMissMemory = { offenderId: first.id, dir, designX, gLeft: first.gLeft, gRight: first.gRight };
    }
    if (NEARMISS_PROBE) {
      reportNearMiss({
        offenderId: first?.id ?? null,
        gLeft: first?.gLeft ?? null,
        gRight: first?.gRight ?? null,
        dir,
        seeded,
        gameX,
        designX,
        outX
      });
    }
    return outX;
  };
  for (let iter = 0; iter < HIT_CONSISTENCY_ITERATIONS; iter++) {
    const offender = topOffender(x);
    if (!offender) {
      return finish(x, first !== null); // fully clear of offenders — the push succeeded (or never fired)
    }
    const [gLeft, gRight] = gameXExtent(offender);
    if (dir === 0) {
      // HYSTERESIS first: still in the band the last sample pushed out of ⇒ keep pushing the SAME way, rather than
      // re-deriving from whichever overlapping hitbox is topmost at this pixel (that alternation is the bistability).
      const remembered =
        nearMissMemory !== null &&
        sameBandRegion(nearMissMemory, offender.id, gLeft, gRight, designX);
      if (remembered && nearMissMemory) {
        dir = nearMissMemory.dir;
        seeded = true;
      } else {
        const renderedMid = (gLeft + gRight) / 2 + offender.spreadDx;
        dir = designX < renderedMid ? -1 : 1;
      }
      first = { id: offender.id, gLeft, gRight };
    }
    // Push just OUTSIDE the game rect on the pointer's side (±1px clears the inclusive edge).
    x = dir < 0 ? gLeft - 1 : gRight + 1;
  }
  // ALL-OR-NOTHING: the cap exhausted while still inside an offender (a long chain of game-space-OVERLAPPING rects
  // — the fanned hand's hitboxes overlap continuously, so a directional walk can cross the whole hand). A partial
  // walk would land the coord on a control SEVERAL entities away from the pointer (the "card 5 → 4 briefly hovers
  // card 1" flicker); the original coord at worst hits the adjacent overlap — game-native ambiguity. Revert.
  return topOffender(x) ? finish(gameX, false) : finish(x, true);
}

// R19 6a — the SQUEEZE RENDERED-BOX GATE. The generalisation, to interactive rects, of the view-scale `renderedBox`
// guard (viewScaleInverse.ts): the identical failure one layer up.
//
// THE HOLE the squeeze gate above leaves. A point the anchor map resolved through the UNIFORM SQUEEZE carries no
// per-painter dx, so the near-miss pass is suppressed for it (nearMissApplies) and the squeezed coordinate is sent
// VERBATIM. But `designX·1920/designW` is only a *field*, not a hit test: beside an ANCHORED widget (dx = half the
// extra width, a pure translation, so its squeeze-consistent band `[gL·s, gR·s]` and its rendered box `[gL+dx,
// gR+dx]` are neither the same width nor the same place) the squeezed X lands INSIDE the widget's game rect from
// stage space the widget does not cover. Measured on the map screen at 2520x1080: over designX 2220–2440 nothing
// paints, the fallback sends coordX 1691–1859, and every one of those is inside MapLegendItem's game rect
// x[1582,1862] — which RENDERS at x[1882,2162]. 12 of 51 sweep samples false-focused a legend row, and a drag
// across that band dragged it.
//
// THE INVARIANT: a squeezed/unanchored point may only resolve into an interactive rect whose RENDERED box contains
// the RAW widened-design pointer. Where it doesn't, eject the coordinate from that rect.
//
// WHY THIS IS NOT "the near-miss pass, re-enabled for squeezed points" — which stays forbidden (its bistability is
// separately measured: 268.61 design px of step jump, see nearMissApplies). The pass is a WALK: it locks a direction
// and steps across up to four abutting rects, so at any pixel the output depends on which of several overlapping
// rects happened to be topmost, and that identity alternates between adjacent samples. This gate asks the invariant
// ONCE, of the ONE rect the coordinate actually resolves into (the same topmost-first arbitration through the same
// topNearMissOffender, so the same vouching rules apply — a stretched full-canvas blocker can neither offend nor
// vouch, a stage-band bar may offend but never vouches), and ejects from THAT rect only, by handing
// pushOutOfNearMiss a single-rect list. One rect ⇒ the direction is not a choice (the pointer
// is outside the rendered box, so `designX < renderedMid` IS the side test) and the walk terminates in one step ⇒
// single-valued output. Clear of that rect, the coordinate is left alone even if it lands in another.
export function pushOutOfSqueezeMiss(
  gameX: number,
  gameY: number,
  designX: number,
  rects: readonly InteractiveRect[],
  designY: number = gameY
): number {
  const offender = topNearMissOffender(gameX, gameY, designX, rects, designY);
  if (!offender) {
    return gameX; // the coordinate resolves into nothing, or into a rect the pointer really is over → untouched.
  }
  // Reuse the ONE pusher (never a second implementation), narrowed to the offending rect.
  return pushOutOfNearMiss(gameX, gameY, designX, [offender], designY);
}
