// Renderer walk metrics and their live gauge sources.

import { cardFlightParseDrops } from "@/mirror/sceneTree";
import type { FullWalkCause } from "@/mirror/renderer/contracts";

// --- walk instrumentation ---------------------------------------------------------------------------------

// Per-walk counters exposed as a shared module singleton (mirrors MirrorView's `__mirrorInteractiveRects` seam) so a
// benchmark/perf workstream can read exactly how much work each reconcile did. A SEPARATE benchmark reads this exact
// field set — do NOT rename fields (ADDING a field is fine; the benchmark reads defensively). All live as of stage 3:
// walks split into fullWalks (keyframe/forceTextures/bail) / incrementalStructuralWalks (orderedIds changed, pruned)
// / updateWalks (volatile-only); `bails` = incremental walks that fell back to full via the churn thresholds;
// `fixupWalks` = the defensive targeted-reorder escape (should stay 0); `reorderedParents` = parents re-ordered by
// the TARGETED pass (the full path re-orders everything, uncounted); `removedRecords` = records torn down (both the
// incremental derived removals and the full-walk prune); lastWalkMs/totalWalkMs bracket each reconcile.
export interface MirrorWalkStats {
  walks: number;
  fullWalks: number;
  incrementalStructuralWalks: number;
  updateWalks: number;
  bails: number;
  visits: number;
  skippedSubtrees: number;
  // R20 item 5: skips the transform-pin gate would have taken that were converted into a
  // paint-only visit because the inherited TINT moved under the pin (a dialog that slides AND fades in). Zero on
  // every screen without a fading tween; a non-zero value is the fade being applied instead of swallowed.
  pinPaintRepairs: number;
  fastPathVisits: number;
  // R10-PERF6 WS-P1: visits that took the ANCESTOR-AFFINE fast path (placement re-derived, everything else reused).
  // On a map scroll this should carry essentially the whole subtree — with `styledNodes` staying near zero.
  affineFastPathVisits: number;
  styledNodes: number;
  reorderedParents: number;
  removedRecords: number;
  fixupWalks: number;
  lastWalkMs: number;
  totalWalkMs: number;
  // O(delta) reconcile instrumentation (geometry-epoch cache). `geomEpoch` = the renderer's current monotonic
  // geometry epoch (bumped by anything that can move an interactive rect / view-scale stamp — see markGeomDirty's
  // call sites); `geomPassRuns` / `geomPassSkips` = how many reconciles rebuilt vs reused the view-scale pass;
  // `interactiveRectRebuilds` = how many times the shared interactive-rect array was actually re-folded (walk pass +
  // input handlers combined). A healthy idle screen shows skips ≫ runs and a flat rect-rebuild count.
  geomEpoch: number;
  geomPassRuns: number;
  geomPassSkips: number;
  interactiveRectRebuilds: number;
  // R10-PERF6 WS-P1: how many times the GAME-space view-scale INPUT registry was actually assembled
  // (buildViewScaleInputStamps — the interactive-rect fold + the neighbour/Z filtering). It is coordinate-only
  // and read exclusively by the input path, so on a replay with no pointer activity it must stay at 0 no matter
  // how much the scene animates. See viewScaleInputStamps.
  viewScaleRegistryBuilds: number;
  // WS-B animation-loop scheduling instrumentation. `tickWakeups` = how many times the animation loop actually ran
  // (with the old free-running poll this was one per rAF — ~60/s forever; deadline-scheduled it is one per DUE
  // deadline, and 0 while nothing is armed). `tickParkedMs` = wall-clock ms the loop spent ASLEEP on a scheduler
  // timer (zero JS on the main thread); with the poll it stays 0. Both are plain counters (no allocation).
  tickWakeups: number;
  tickParkedMs: number;
  // WS-C occlusion-gating instrumentation (GAUGES, not counters — each reflects the state left by the LAST walk).
  // `occludedRoots` = subtree roots currently gated (both tiers); `occlusionHiddenRoots` = the tier-1 subset that is
  // actually `display:none` (so `occludedRoots − occlusionHiddenRoots` are the paint-through tier-2 ones);
  // `occlusionTier` = 0 nothing gated / 1 at least one TIER-1 (opaque) cover engaged / 2 tier-2 only;
  // `occlusionSuspendedAnimators` = spine clips + intent glyphs parked out of the animation loop by the gate.
  occludedRoots: number;
  occlusionHiddenRoots: number;
  occlusionTier: number;
  occlusionSuspendedAnimators: number;
  // R10-PERF6 WS-B gauges (see BACKSTOP_COVER_MIN_ALPHA / FREEZE_CANVAS_SELECTOR). All three describe the state
  // left by the LAST walk, so they fall back to 0 the moment the cover lifts.
  // `occlusionBackstopCovers` = qualifying covers this pass that are one of the game's own overlay BACKSTOPS (>0
  // means the backstop exception is what is holding the gate — the live 0.724 case reads 1 with the setting on
  // and 0 with it off); `occlusionFrozenCanvases` = canvases currently de-promoted to a still `<img>`;
  // `occlusionFrozenFallbacks` = cumulative COUNTER of canvases whose snapshot could not be produced and which
  // were therefore left live (a non-zero value is the "correctness over the win" path being taken).
  occlusionBackstopCovers: number;
  occlusionFrozenCanvases: number;
  occlusionFrozenFallbacks: number;
  // AUG-12 static-fleet stills: effect surfaces (gsw shader + particle canvases) currently swapped for a still
  // `<img>`. A LIVE GAUGE — read straight out of gsw's `staticImagesLive` counters at the moment it is read, not
  // a value some pass last published: the swap is driven by gsw's own quiet-window timer, so an idle frozen
  // screen changes this with nothing on our side running (a published field would read 0 on exactly the state
  // being measured). READ-ONLY: see `setStaticStillGauge`.
  readonly staticStillCanvases: number;
  // R17 — the RETAINED-STILL block, and every one of these is a LIVE GAUGE over gsw's own counters for exactly
  // `staticStillCanvases`' reason (gsw's timers move them with nothing on our side running). See
  // `setStaticStillCountersGauge` for where they come from.
  //
  //   `staticStillCacheHits` / `staticStillCacheMisses` — `claimStaticStill` calls that found an attachable
  //     frame for the key vs. ones that must render the surface themselves. THE headline pair: on the measured
  //     30-card volley (70 emitters, 2 distinct specs) a working mechanism is ~2 misses and the rest hits, and
  //     a stream of misses against that key population means the stills are not SURVIVING — read
  //     `staticStillRetainedEntries`/`Bytes` against the configured budget before blaming the keys.
  //   `staticStillMounts` — claims whose `<img>` actually decoded and went live. Sits below hits by exactly the
  //     claims undone first, which is the only way to tell "the key was there" from "the pixels reached the
  //     screen".
  //   `staticStillBakes` — `bakeStill` encodes for a key with NO waiting surface (a departing binding banking
  //     its frame). `staticStillDonors` is the live count of bindings being held alive to do it,
  //     `…DonorBakes`/`…DonorsDropped` the published/abandoned split — donors dominating dropped means the
  //     donor bound is too small for the scene's churn, or that retention is off and every bake is refused.
  //   `staticStillRetainedEntries` / `…Bytes` — the module-wide pool right now. The number to read against
  //     `parkedStillBytes + stillCacheBytes`: at the budget, the pool is evicting.
  readonly staticStillCacheHits: number;
  readonly staticStillCacheMisses: number;
  readonly staticStillMounts: number;
  readonly staticStillBakes: number;
  readonly staticStillDonors: number;
  readonly staticStillDonorBakes: number;
  readonly staticStillDonorsDropped: number;
  readonly staticStillRetainedEntries: number;
  readonly staticStillRetainedBytes: number;
  // R10-B3 element-adoption instrumentation (COUNTERS, cumulative). `createEl` = elements actually constructed by
  // createEl (the cost adoption exists to remove: on a card play this used to spike by one whole card subtree, and
  // each new element under a shader node makes gsw build a fresh WebGL binding + its syncCanvasSize forced layout).
  // `adoptions` = condemned records re-keyed onto a NEW node id (element + canvases + style caches kept).
  // `condemnedSwept` = condemned records nobody claimed, torn down at the end of the walk (so `condemned` records
  // never outlive their walk). A healthy card play shows adoptions ≈ the card's element count and createEl ≈ 0.
  createEl: number;
  adoptions: number;
  condemnedSwept: number;
  // R10-PERF3 WS-4 texture-walk instrumentation. `fullWalkCauses` breaks `fullWalks` down by WHY the walk went
  // full (the counters sum to fullWalks) — the metric that made the texture-load storm visible in the first place.
  // `textureDirtyIds` = ids handed to markTextureDirty (cumulative, before staleness filtering);
  // `textureRestyles` = ids a walk actually injected into its dirty set (i.e. the node still existed). On a healthy
  // combat replay `fullWalkCauses.texture` is 0 and `textureRestyles` carries the same work in a few dozen visits.
  fullWalkCauses: Record<FullWalkCause, number>;
  textureDirtyIds: number;
  textureRestyles: number;
  // R10-PERF4 WS-4 (item 2) BLEND CENSUS — measurement only (see noteBlendNode). A `mix-blend-mode` element forces
  // the compositor to promote everything painting above it, so an effectively-invisible blend is pure layer tax;
  // these say whether a mid-play MUTING pass would be worth building at all (the settled census only sees the last
  // frame). `blendNodes` / `blendLowAlpha` = the live counts at the end of the last walk; `blendLowAlphaPeak` = the
  // most that were ever simultaneously invisible; `blendLowAlphaSum` / `blendSampleWalks` = the time-weighted mean
  // over walks (sum ÷ walks), i.e. "on an average frame, how many blends are wasted".
  blendNodes: number;
  blendLowAlpha: number;
  blendLowAlphaPeak: number;
  blendLowAlphaSum: number;
  blendSampleWalks: number;
  // R10-PERF5 WS-1 DORMANCY instrumentation. `dormantRoots` is a GAUGE — how many
  // dormant MARKERS exist right now, i.e. how many hidden subtree roots the renderer is currently declining to
  // build. Deliberately a live membership count, not a per-walk tally: a settled screen skip-cleans its dormant
  // roots without re-deriving them, so a per-walk tally would read 0 exactly when the bench census samples it.
  // `dormantSkippedBuilds` is the cumulative COUNTER of boundary returns across all walks (one per subtree the
  // walk declined to build, so it counts re-derivations too).
  // `revealBuilds` counts records that WERE dormant markers and have now built their element (a reveal), and
  // `revealBuildMs` accumulates the wall time of the walks that performed at least one such build — the "did a
  // reveal become a user-visible stall?" series that Phase 2's idle hatchery is meant to flatten.
  dormantRoots: number;
  dormantSkippedBuilds: number;
  revealBuilds: number;
  revealBuildMs: number;
  // R10-PERF5 WS-3 HATCHERY instrumentation. `hatchedBuilds` counts dormant
  // MARKERS the idle hatchery built (one per queue entry realised — the descendants each one drags in show up in
  // `createEl`, like every other build); `hatchDrains` counts budget slices run; `hatchMs` accumulates their wall
  // time. Deliberately SEPARATE from `revealBuilds`/`revealBuildMs`: a hatch build is off the critical path by
  // construction, so folding it into the reveal series would destroy exactly the signal that series exists for.
  hatchedBuilds: number;
  hatchDrains: number;
  hatchMs: number;
  // R10-PERF6 WS-P2 instrumentation. `atlasWarmedRegions` counts region bakes kicked off for a HIDDEN sprite by
  // the hatchery — the series that should drive `textureRestyles` on a map open to
  // ~0. `revealStaggerHolds` / `revealStaggerHeldNodes` count the subtree ROOTS a staggered reveal held back and
  // the wire nodes under them; `revealStaggerBatches` counts release slices run.
  atlasWarmedRegions: number;
  revealStaggerHolds: number;
  revealStaggerHeldNodes: number;
  revealStaggerBatches: number;
  // R10-PERF5 WS-4 RECLAIM instrumentation. Cumulative COUNTER of subtree
  // roots a FULL walk reclaimed — an effectively-hidden node whose already-built element was torn down and whose
  // record was demoted to a dormant marker. Its descendants show up in `removedRecords` (the post-walk prune tears
  // them down like any other unvisited record), and the re-grow shows up in `hatchedBuilds` / `revealBuilds`
  // depending on who got there first.
  reclaimedRoots: number;
  // R12 STATIC-BG BUILD HOLD instrumentation.
  // `staticBgHeldRoots` is a GAUGE — how many combat bg scene roots the renderer is holding unbuilt RIGHT NOW
  // (re-derived per walk, the `dormantRoots` idiom, because a settled combat skip-cleans its held root).
  // `staticBgHoldSkippedBuilds` is the cumulative COUNTER of boundary returns caused by the hold: this is the
  // number that PROVES the live bg subtree was never built (a bench arm reading 0 in a combat recording means the
  // hold was not engaged at all — the setting was off — and must be labelled as such).
  // `staticBgHoldExpiries` counts per-path belt releases. It is now STRUCTURALLY 0 for combat, which no longer
  // arms a deadline at all: the combat hold is unconditional, so there is no race for the component to win. The
  // belt survives only for the families that still fail open (event backdrops, the shop), where a non-zero value
  // is still a bug report.
  staticBgHeldRoots: number;
  staticBgHoldSkippedBuilds: number;
  staticBgHoldExpiries: number;
  // Spine still decode-gate instrumentation. `spineStillDecodes`
  // counts probes started, `spineStillCommits` swaps that actually landed, `spineStillStale` decodes whose record
  // had moved on by the time they resolved (identity change / hot-swap / teardown). decodes = commits + stale +
  // in-flight; a live blank-frame probe reads these to confirm the gate is the thing doing the work.
  spineStillDecodes: number;
  spineStillCommits: number;
  spineStillStale: number;
  // Aug-25 SPINE SUBTREE PAINT CULL: how many spine nodes currently carry the `will-change: transform` promotion
  // (see applySpinePromotionPass). A GAUGE, not a counter — this is the layer bill the fix runs up, and the whole
  // point of scoping it to "still + effect surfaces in the subtree" is that this number stays at ~1 rather than at
  // "every spine node on screen". Published once per walk, from a live count, for the reason dormantRoots is.
  spinePromotedNodes: number;
  // R11 — CARD-FLIGHT + TRAIL instrumentation, the series the reshuffle round is measured on. Counters unless
  // noted; the PEAKs are high-water marks over the measurement window (a reshuffle is ~1s inside a 20s recording,
  // so an average would dilute the only interesting second).
  //
  // `trailPaints` = ribbons rebuilt (paintCardTrail entries that actually built geometry); `trailPathWrites` =
  // `setAttribute("d")` calls that came out of them. Healthy under the mass diet: paints ≈ strokes × 30/s rather
  // than × 60/s, and writes ≈ paints (one band) rather than 3 × paints.
  // `trailPointsPeak` / `trailStrokesPeak` = the largest point list and the most simultaneously-painting strokes
  // seen — the two multiplicands the trail's per-frame cost is linear in. `flightsPeak` = the most simultaneous
  // card flights, i.e. how big the reshuffle actually was; `flightDietFrames` = paints taken while the mass diet
  // was armed (0 outside a mass shuffle is the contract, and it is a straightforward way to see the threshold
  // firing at all).
  // `trailScaffoldAcquires` / `trailScaffoldReuses` = the pool's hit rate; reuses ≈ acquires after the first wave
  // means the free list is doing its job, reuses ≈ 0 means every trail is paying ~10 element creations.
  // `flightPlacementSeamHits` = substituted-global placements answered through `nodePlacementTransform` instead of
  // a whole `nodeStyle` map (see `?flightPlacementSeam`), so this counts allocations NOT made.
  trailPaints: number;
  trailPathWrites: number;
  // R15 — design px² of trail-path bbox actually REWRITTEN, × the bands rewritten with it: the re-raster FILL proxy
  // `trailPathWrites` cannot see (a write count says nothing about how much surface it dirtied). Only paints that
  // reach the `d` write guard add to it; the box is `TrailRibbon.bboxArea` (see cardTrail.ts). A plain double.
  trailPathBboxAreaSum: number;
  // R16 — the other half of that story, and the one R15 named as the actual cost. `trailPathBboxAreaSum` is
  // WRITTEN area: how much surface was re-rastered, integrated over the window, i.e. a FILL price. This is
  // STANDING area: the box every live stroke covers RIGHT NOW, summed across strokes, high-water-marked over the
  // window — i.e. how much blended surface the compositor is carrying per frame whether or not anything rewrote
  // it. A phone pays the second one every frame and the first one only when a `d` changes, which is why a diet can
  // move written area a long way and move nothing the eye can feel. Design px², a plain double.
  trailSurfaceAreaPeak: number;
  trailPointsPeak: number;
  trailStrokesPeak: number;
  flightsPeak: number;
  flightDietFrames: number;
  trailScaffoldAcquires: number;
  trailScaffoldReuses: number;
  // R14a — samples at which the point budget actually bit (one per call that dropped ≥1 interior point, not per
  // point). Reads ≈ one per sample per stroke for the whole stretch of a flight past the budget, and 0 on a flight
  // short enough to fit — which is how a bench tells "the budget is shaping this trail" from "it never applied".
  trailDecimations: number;
  // R14f — head samples cut as TELEPORTS (see cardTrail.ts's teleport cut). One per discontinuity, so a reshuffle
  // of N cards reads ~N: each comet subtree arrives at the un-posed scene origin one delta before it is placed.
  // A number climbing with no cards flying means something else is jumping a ribbon's head around.
  trailTeleportCuts: number;
  flightPlacementSeamHits: number;
  // R12 WS-B — CARD-FLIGHT LIVENESS. A phone trace caught the whole declarative replay silently not running (a
  // stuck producer gate upstream meant no `cardFlights[]` ever reached the client) and NOTHING here could say so:
  // the only flight series was `flightsPeak`, which reads 0 both when the feature is idle and when it is broken.
  // These counters make each link of the chain — hint on the wire → hint matched to a record → flight armed →
  // handed to the compositor → integrated per frame → retired — separately observable, so one
  // `JSON.stringify(window.__mirrorWalkStats)` says WHICH link is missing.
  //
  // `cardFlightHintsReceived` counts hints handed to `applyCardFlights`, so "the host is sending and this client is
  // dropping" is distinguishable from "the host is not sending".
  // `flightHintUnmatched` counts hints whose target id is not (yet) a mirrored record. `flightsArmed` counts
  // flights that joined the per-frame set; `flightCssAnimStarted` those the compositor took.
  // `flightSteps` is THE LIVENESS NUMBER: one per live flight per tick. On the compositor path it should be
  // ≈ flightsArmed × flightSeconds × displayHz, and 0 with `flightsArmed > 0` is the smoking gun for a parked
  // animation loop.
  // `flightNodesStreamed` NAMES THE DEGRADED PATH: a walk styled a card-flight VFX node that no flight owns, i.e.
  // the producer is still streaming those transforms and the cards are moving at the wire's rate rather than the
  // display's. Non-zero during a shuffle ⇒ this host is not emitting (or this client is not arming) flight hints.
  // …and it is scoped to the SHUFFLE mover's node type, which is the only one classified at element-build time; a
  // discard's mover is an ordinary card, indistinguishable in the walk from every other card on screen, so its
  // degraded path shows up as `discardFlightsArmed === 0` while cards are visibly being played instead.
  // R13: `discardFlightsArmed` is the hand→discard SUBSET of `flightsArmed` (a shuffle count is the difference).
  // Read it to tell which kind a host is emitting: the two arrive on the same wire field and arm through the same
  // path, so a producer that has lost one of them looks exactly like an idle screen in every counter but this one.
  cardFlightHintsReceived: number;
  flightHintUnmatched: number;
  flightsArmed: number;
  discardFlightsArmed: number;
  flightCssAnimStarted: number;
  flightSteps: number;
  flightNodesStreamed: number;
  // R14c — flights that took ownership of their comet ROOT (once per flight, not per frame). Read it against
  // `flightsArmed`: equal means every card is placing its own comet, and a shortfall names the hints that arrived
  // without a `trailId` or whose trail record was gone.
  trailRootDrives: number;
  // Why a flight did NOT reach the compositor, broken down — the six paths were indistinguishable before, and each
  // one is a different diagnosis: `lever` = client animation unavailable; `noEl` = the element was torn down or never built
  // (DOM diet / occlusion / a hint that beat the node); `noNode` = the record carries no wire node; `noWaapi` = the
  // browser has no `Element.animate` (jsdom, an ancient WebView); `degenerate` = a hint whose closed form has no
  // duration (the producer); `boxless` = the target node has no placement box of its own (its geometry).
  // Failing is NOT a regression — the flight falls back to the stepped integrator, which is the pre-R11 shipped
  // behaviour. What matters is that it stops being invisible.
  flightCssAnimFailed: Record<FlightAnimFailReason, number>;
  // Why a flight left the per-frame set. `done` is the healthy terminal state (every armed flight should reach it);
  // `pinExpired` means the client fell so far behind its own clock that the producer's window closed under it;
  // `noEl`/`noRecord` mean the node went away mid-flight (a shuffle interrupted by the screen changing).
  flightRetired: Record<FlightRetireReason, number>;
  // A read-time GAUGE over sceneTree's strict `normalizeCardFlight`, which silently drops a malformed hint. Non-zero
  // with `cardFlightHintsReceived === 0` means the host IS sending and the parse is rejecting — the one failure the
  // counters above cannot see, because a dropped hint never reaches the renderer at all.
  readonly cardFlightParseDrops: number;
  // TWEEN HINTS whose TRANSFORM channel was refused because the space its endpoint was authored in is gone: the
  // target is an ORPHAN (it names a parent the node map does not hold) or has been RE-PARENTED since the hint was
  // written (`parentIdAtArrival`). See `applyTweenHints`. The opacity channel of such a hint still arms, so this is
  // not a count of dropped hints — it is a count of endpoints that would otherwise have been lifted through the
  // wrong origin and played the node out at the design corner.
  //
  // It is an INSTRUMENT, not an alarm. Zero across a replay set says only that the set does not contain the race;
  // a non-zero value on a recording makes that recording an offline repro for it. The canvas backend publishes the
  // same number as `hintTransformRebased` in `__mirrorCanvasStats`, so the two arms are comparable on one stream.
  hintTransformRebased: number;
  // …and the same refusal a frame LATER: transform channels RELEASED because the node moved house while the
  // channel was still running (the always-on reparent rule). Same instrument, same twin on the canvas arm.
  tweenReparentDropped: number;
  // Geoclip lane. The lane had no client-side series at all, so a bench comparing geoclip against
  // the shipped `/spines/` still could say what the HOST spent and nothing about what the browser waited for. All
  // four are cumulative COUNTERS, published from `geoclipPlayer`'s own funnels rather than from the walk, so they
  // are backend-agnostic: the DOM arm and the canvas arm move the same numbers.
  //
  // `geoclipProbeMs` — wall time inside `probeGeoclip`, summed. That is manifest fetch + decode + (for packed geoclip/1)
  //   the `verts.bin` fetch and dequantisation, i.e. the client half of "request → data" for one pose. Counted ONCE
  //   per manifest url, on the probe that actually went out: the module caches probes (misses included), so a second
  //   creature playing the same animation adds nothing here, which is the honest reading — it paid no request.
  // `geoclipUploadMs` — wall time inside `uploadGeoclip`: page decode plus the GL texture and buffer uploads. Once
  //   per CLIP, for the same reason. Split from the probe deliberately — a slow lane is either the host answering
  //   or this device's GPU accepting, and one number cannot tell those apart.
  // `geoclipMounts` — geoclip paint elements successfully created (`createGeoclipNode`), i.e. creatures actually
  //   drawn from geometry. THE ANTI-VACUITY COUNTER: every other number here is meaningless on a run where nothing
  //   mounted, and a bench arm reading 0 mounts is a fail-open run that must be labelled as such rather than
  //   reported as a fast one.
  geoclipProbeMs: number;
  geoclipUploadMs: number;
  geoclipMounts: number;
  reset(): void;
}

/** Why `startFlightCssAnimation` handed the flight back to the stepped integrator. See `flightCssAnimFailed`. */
export type FlightAnimFailReason = "lever" | "noEl" | "noNode" | "noWaapi" | "degenerate" | "boxless";

/** Why a flight left the per-frame set. See `flightRetired`. */
export type FlightRetireReason = "noRecord" | "noEl" | "pinExpired" | "done";

function zeroFlightAnimFails(): Record<FlightAnimFailReason, number> {
  return { lever: 0, noEl: 0, noNode: 0, noWaapi: 0, degenerate: 0, boxless: 0 };
}

function zeroFlightRetires(): Record<FlightRetireReason, number> {
  return { noRecord: 0, noEl: 0, pinExpired: 0, done: 0 };
}

function zeroFullWalkCauses(): Record<FullWalkCause, number> {
  return {
    firstBuild: 0,
    forceTextures: 0,
    spread: 0,
    spine: 0,
    texture: 0,
    keyframe: 0,
    bail: 0,
    fixup: 0,
    occlusion: 0,
    staticBg: 0,
    uiScale: 0
  };
}

// The live source of `mirrorWalkStats.staticStillCanvases` — installed by MirrorView, which is the only place
// that holds the gsw runtime handles (`setStaticStillGauge`). Null (no mounted mirror, or a build with no
// runtimes) reads 0, which is the honest answer: nothing is frozen.
let staticStillGauge: (() => number) | null = null;

/** Install (or clear, with `null`) the reader behind `mirrorWalkStats.staticStillCanvases`. MirrorView sums the
 *  two gsw runtimes' `staticImagesLive` gauges; the acceptance metric for the surface-swap migration is that this
 *  keeps meaning "how many effect surfaces are frozen RIGHT NOW". */
export function setStaticStillGauge(read: (() => number) | null): void {
  staticStillGauge = read;
}

/** R17: the retained-still counters, as one reading. Field names are the gsw counters', minus the prefix — the
 *  mapping to `mirrorWalkStats.staticStill*` is meant to be obvious to whoever is diffing a bench cell against
 *  gsw's own source. */
export interface MirrorStaticStillCounters {
  cacheHits: number;
  cacheMisses: number;
  mounts: number;
  bakes: number;
  donors: number;
  donorBakes: number;
  donorsDropped: number;
  retainedEntries: number;
  retainedBytes: number;
}

const ZERO_STATIC_STILL_COUNTERS: MirrorStaticStillCounters = {
  cacheHits: 0,
  cacheMisses: 0,
  mounts: 0,
  bakes: 0,
  donors: 0,
  donorBakes: 0,
  donorsDropped: 0,
  retainedEntries: 0,
  retainedBytes: 0
};

// The live source of the `mirrorWalkStats.staticStill*` block — installed by MirrorView, the only place that
// holds the gsw runtime handles (`setStaticStillCountersGauge`). Null (no mounted mirror, or a gsw predating the
// counters) reads all-zero, which is honest: nothing has been measured.
let staticStillCountersGauge: (() => MirrorStaticStillCounters) | null = null;

/** Install (or clear, with `null`) the reader behind the `mirrorWalkStats.staticStill*` counters. ONE reader for
 *  the whole block rather than nine, because the numbers only make sense together (a hit count without the pool
 *  gauges cannot say whether a miss stream is a key problem or a budget one) and because each read of it is one
 *  `stats()` call per runtime. */
export function setStaticStillCountersGauge(read: (() => MirrorStaticStillCounters) | null): void {
  staticStillCountersGauge = read;
}

function staticStillCounters(): MirrorStaticStillCounters {
  return staticStillCountersGauge?.() ?? ZERO_STATIC_STILL_COUNTERS;
}

export const mirrorWalkStats: MirrorWalkStats = {
  walks: 0,
  fullWalks: 0,
  incrementalStructuralWalks: 0,
  updateWalks: 0,
  bails: 0,
  visits: 0,
  skippedSubtrees: 0,
  pinPaintRepairs: 0,
  fastPathVisits: 0,
  affineFastPathVisits: 0,
  styledNodes: 0,
  reorderedParents: 0,
  removedRecords: 0,
  fixupWalks: 0,
  lastWalkMs: 0,
  totalWalkMs: 0,
  geomEpoch: 0,
  geomPassRuns: 0,
  geomPassSkips: 0,
  interactiveRectRebuilds: 0,
  viewScaleRegistryBuilds: 0,
  tickWakeups: 0,
  tickParkedMs: 0,
  occludedRoots: 0,
  occlusionHiddenRoots: 0,
  occlusionTier: 0,
  occlusionSuspendedAnimators: 0,
  occlusionBackstopCovers: 0,
  occlusionFrozenCanvases: 0,
  occlusionFrozenFallbacks: 0,
  // A GAUGE with no stored value: gsw owns the swap and its own timer drives it, so the only truthful answer is
  // the one sampled at read time (see `setStaticStillGauge`). Enumerable like every other field, so a harness
  // that JSON.stringify's `__mirrorWalkStats` still sees it.
  get staticStillCanvases(): number {
    return staticStillGauge?.() ?? 0;
  },
  // R17 — the same read-time-gauge contract as `staticStillCanvases` above, one getter per gsw counter so the
  // bench's flat `{...__mirrorWalkStats}` copy (and its `pickNum(key)` extraction) sees them without learning a
  // nested shape. Enumerable, like every other field here.
  get staticStillCacheHits(): number {
    return staticStillCounters().cacheHits;
  },
  get staticStillCacheMisses(): number {
    return staticStillCounters().cacheMisses;
  },
  get staticStillMounts(): number {
    return staticStillCounters().mounts;
  },
  get staticStillBakes(): number {
    return staticStillCounters().bakes;
  },
  get staticStillDonors(): number {
    return staticStillCounters().donors;
  },
  get staticStillDonorBakes(): number {
    return staticStillCounters().donorBakes;
  },
  get staticStillDonorsDropped(): number {
    return staticStillCounters().donorsDropped;
  },
  get staticStillRetainedEntries(): number {
    return staticStillCounters().retainedEntries;
  },
  get staticStillRetainedBytes(): number {
    return staticStillCounters().retainedBytes;
  },
  createEl: 0,
  adoptions: 0,
  condemnedSwept: 0,
  fullWalkCauses: zeroFullWalkCauses(),
  textureDirtyIds: 0,
  textureRestyles: 0,
  blendNodes: 0,
  blendLowAlpha: 0,
  blendLowAlphaPeak: 0,
  blendLowAlphaSum: 0,
  blendSampleWalks: 0,
  dormantRoots: 0,
  dormantSkippedBuilds: 0,
  revealBuilds: 0,
  revealBuildMs: 0,
  hatchedBuilds: 0,
  hatchDrains: 0,
  hatchMs: 0,
  atlasWarmedRegions: 0,
  revealStaggerHolds: 0,
  revealStaggerHeldNodes: 0,
  revealStaggerBatches: 0,
  reclaimedRoots: 0,
  staticBgHeldRoots: 0,
  staticBgHoldSkippedBuilds: 0,
  staticBgHoldExpiries: 0,
  spineStillDecodes: 0,
  spineStillCommits: 0,
  spineStillStale: 0,
  spinePromotedNodes: 0,
  trailPaints: 0,
  trailPathWrites: 0,
  trailPathBboxAreaSum: 0,
  trailSurfaceAreaPeak: 0,
  trailPointsPeak: 0,
  trailStrokesPeak: 0,
  flightsPeak: 0,
  flightDietFrames: 0,
  trailScaffoldAcquires: 0,
  trailScaffoldReuses: 0,
  trailDecimations: 0,
  trailTeleportCuts: 0,
  flightPlacementSeamHits: 0,
  cardFlightHintsReceived: 0,
  flightHintUnmatched: 0,
  flightsArmed: 0,
  discardFlightsArmed: 0,
  flightCssAnimStarted: 0,
  flightSteps: 0,
  flightNodesStreamed: 0,
  trailRootDrives: 0,
  flightCssAnimFailed: zeroFlightAnimFails(),
  flightRetired: zeroFlightRetires(),
  hintTransformRebased: 0,
  tweenReparentDropped: 0,
  geoclipProbeMs: 0,
  geoclipUploadMs: 0,
  geoclipMounts: 0,
  // A GAUGE with no stored value, exactly like `staticStillCanvases`: the drops happen inside sceneTree's parser,
  // which runs before any renderer exists, so the only truthful answer is the one sampled at read time.
  get cardFlightParseDrops(): number {
    return cardFlightParseDrops();
  },
  reset() {
    this.walks = 0;
    this.fullWalks = 0;
    this.incrementalStructuralWalks = 0;
    this.updateWalks = 0;
    this.bails = 0;
    this.visits = 0;
    this.skippedSubtrees = 0;
    this.pinPaintRepairs = 0;
    this.fastPathVisits = 0;
    this.affineFastPathVisits = 0;
    this.styledNodes = 0;
    this.reorderedParents = 0;
    this.removedRecords = 0;
    this.fixupWalks = 0;
    this.lastWalkMs = 0;
    this.totalWalkMs = 0;
    this.geomEpoch = 0;
    this.geomPassRuns = 0;
    this.geomPassSkips = 0;
    this.interactiveRectRebuilds = 0;
    this.viewScaleRegistryBuilds = 0;
    this.tickWakeups = 0;
    this.tickParkedMs = 0;
    this.occludedRoots = 0;
    this.occlusionHiddenRoots = 0;
    this.occlusionTier = 0;
    this.occlusionSuspendedAnimators = 0;
    this.occlusionBackstopCovers = 0;
    this.occlusionFrozenCanvases = 0;
    this.occlusionFrozenFallbacks = 0;
    // `staticStillCanvases` — and the whole R17 `staticStill*` block below it — is deliberately absent: they are
    // read-time gauges over gsw's live swap state and its module-wide still pool, and a measurement-window reset
    // must not claim the fleet was handed back or the pool emptied. (gsw's counters are monotonic by ITS
    // contract; a bench window diffs them, exactly as it does for the effect-runtime stats.)
    this.createEl = 0;
    this.adoptions = 0;
    this.condemnedSwept = 0;
    // Reset IN PLACE: the field is exposed on `window.__mirrorWalkStats` and read by the bench, so nothing may
    // observe a stale object identity across a reset.
    for (const key of Object.keys(this.fullWalkCauses) as FullWalkCause[]) {
      this.fullWalkCauses[key] = 0;
    }
    this.textureDirtyIds = 0;
    this.textureRestyles = 0;
    this.blendNodes = 0;
    this.blendLowAlpha = 0;
    this.blendLowAlphaPeak = 0;
    this.blendLowAlphaSum = 0;
    this.blendSampleWalks = 0;
    this.dormantRoots = 0;
    this.dormantSkippedBuilds = 0;
    this.revealBuilds = 0;
    this.revealBuildMs = 0;
    this.hatchedBuilds = 0;
    this.hatchDrains = 0;
    this.hatchMs = 0;
    this.atlasWarmedRegions = 0;
    this.revealStaggerHolds = 0;
    this.revealStaggerHeldNodes = 0;
    this.revealStaggerBatches = 0;
    this.reclaimedRoots = 0;
    this.staticBgHeldRoots = 0;
    this.staticBgHoldSkippedBuilds = 0;
    this.staticBgHoldExpiries = 0;
    this.spineStillDecodes = 0;
    this.spineStillCommits = 0;
    this.spineStillStale = 0;
    this.spinePromotedNodes = 0;
    this.trailPaints = 0;
    this.trailPathWrites = 0;
    this.trailPathBboxAreaSum = 0;
    // The peaks are high-water marks OVER THE WINDOW, so a window reset must clear them — otherwise every later
    // window inherits the reshuffle's number and reads as if it were shuffling too.
    // R16: the PEAK only. The running sum behind it (`trailSurfaceAreaSum`) is STANDING STATE, not a window total —
    // the strokes it describes are still on screen — so zeroing it here would make the gauge report a negative
    // delta the moment one of them blanked. It re-latches into the peak on the very next paint, exactly as
    // `trailStrokesPeak` re-latches from a set whose members a reset does not evict.
    this.trailSurfaceAreaPeak = 0;
    this.trailPointsPeak = 0;
    this.trailStrokesPeak = 0;
    this.flightsPeak = 0;
    this.flightDietFrames = 0;
    this.trailScaffoldAcquires = 0;
    this.trailScaffoldReuses = 0;
    this.trailDecimations = 0;
    this.trailTeleportCuts = 0;
    this.flightPlacementSeamHits = 0;
    this.cardFlightHintsReceived = 0;
    this.flightHintUnmatched = 0;
    this.flightsArmed = 0;
    this.discardFlightsArmed = 0;
    this.flightCssAnimStarted = 0;
    this.flightSteps = 0;
    this.flightNodesStreamed = 0;
    this.trailRootDrives = 0;
    this.hintTransformRebased = 0;
    this.tweenReparentDropped = 0;
    // Window totals, so a reset re-bases them like every other counter here. The module-level caches they describe
    // (`probes`, `uploads`) are deliberately NOT cleared with them: a second window over the same page legitimately
    // reads 0 probe ms because the artifacts were already in hand, and that IS the measurement.
    this.geoclipProbeMs = 0;
    this.geoclipUploadMs = 0;
    this.geoclipMounts = 0;
    // Reset IN PLACE for the same reason `fullWalkCauses` is: `window.__mirrorWalkStats` and the bench hold these
    // objects' identities, so re-assigning would leave them reading a detached snapshot forever.
    for (const key of Object.keys(this.flightCssAnimFailed) as FlightAnimFailReason[]) {
      this.flightCssAnimFailed[key] = 0;
    }
    for (const key of Object.keys(this.flightRetired) as FlightRetireReason[]) {
      this.flightRetired[key] = 0;
    }
    // `cardFlightParseDrops` is deliberately absent, for `staticStillCanvases`' reason: it is a read-time gauge over
    // a module-level total, and a measurement-window reset must not claim the drops un-happened.
    resetBlendCensus();
  }
};

// --- R10-PERF4 WS-4 (item 2): blend census bookkeeping ---------------------------------------------------------
//
// Membership sets, NOT per-walk recomputation: a node's blend + own-opacity are recorded when it is styled and
// remembered until it is re-styled or removed, so the counts describe the CURRENT scene at every walk boundary
// without a scan. Module-scoped (like mirrorWalkStats itself) so a renderer teardown/rebuild in one page keeps a
// coherent picture; ids are pruned on record removal.
const BLEND_MUTE_ALPHA = 0.02;
const blendNodeIds = new Set<string>();
const blendLowAlphaIds = new Set<string>();

export function hasBlendNodes(): boolean {
  return blendNodeIds.size > 0;
}

export function noteBlendNode(id: string, ownOpacity: number): void {
  blendNodeIds.add(id);
  if (ownOpacity <= BLEND_MUTE_ALPHA) {
    blendLowAlphaIds.add(id);
  } else {
    blendLowAlphaIds.delete(id);
  }
}

export function forgetBlendNode(id: string): void {
  blendNodeIds.delete(id);
  blendLowAlphaIds.delete(id);
}

function resetBlendCensus(): void {
  blendNodeIds.clear();
  blendLowAlphaIds.clear();
}

// Sample the live counts once per walk and fold them into the peak + time-weighted totals. Prunes ids whose node
// has since left the scene first — O(blend nodes) (a few dozen), which is why removal needs no separate hook.
export function sampleBlendCensus(live: ReadonlyMap<string, unknown>): void {
  if (blendNodeIds.size > 0) {
    for (const id of blendNodeIds) {
      if (!live.has(id)) {
        forgetBlendNode(id);
      }
    }
  }
  const low = blendLowAlphaIds.size;
  mirrorWalkStats.blendNodes = blendNodeIds.size;
  mirrorWalkStats.blendLowAlpha = low;
  if (low > mirrorWalkStats.blendLowAlphaPeak) {
    mirrorWalkStats.blendLowAlphaPeak = low;
  }
  mirrorWalkStats.blendLowAlphaSum += low;
  mirrorWalkStats.blendSampleWalks += 1;
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__mirrorWalkStats = mirrorWalkStats;
}
