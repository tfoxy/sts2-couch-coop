// Resource resolution + render options for the MIRROR's shader support. Shader uniform values now arrive in
// the live `scene-delta` (producer-streamed via Sts2ShaderMaterialInspector), so there is NO catalog fetch and
// NO material-doc HTTP fetch — `shaderAttributes.ts` synthesizes a gsw material doc from the streamed params
// and stashes it on the gsw `source` node (`__mirrorDoc`). `resolveResource` returns that doc (sync) plus
// resolves sampler texture refs to `/res/` image URLs. `resolveShaderSource` fetches the `.gdshader` text the
// WebGL runtime transpiles (async is fine there).
//
// Self-contained per the mirror decoupling rule: gsw + `@/mirror/*` only (its own `mirrorResourceUrl`).

import { computed, type ComputedRef } from "vue";

import type { GodotNode, GodotResource, GodotResourceRefValue } from "@godot-scene-web/core";
import type {
  GodotResolvedResource,
  StaticSurfaceOption,
  UnsupportedRenderInfo
} from "@godot-scene-web/html";
import type { GodotHtmlMountOptions } from "@godot-scene-web/html/runtime";

import { mirrorFramePressure } from "@/mirror/framePressure";
import { particlesHardOff, renderQuality, shadersHardOff } from "@/render/quality";
import { qualityParticleOptions, qualityShaderOptions } from "@/render/renderOptions";
import { mirrorSettings, type EffectMode } from "@/mirror/mirrorSettings";
import { mirrorResourceUrl } from "@/mirror/sceneTree";
import { staticParticlePinRatio, staticShaderPinRatio } from "@/mirror/staticPin";

// The one sanctioned non-WebGL shader family: HSV color-adjust shaders render via a cheap feColorMatrix
// (see `shaderAttributes.ts`) instead of ~one WebGL canvas per tinted node (e.g. the energy orb). Matches the
// presentation catalog's `hsvAdjustShaders`. Every OTHER shader runs generically on WebGL (`webglShaderIds: ["*"]`).
export const HSV_SHADER_IDS = ["res://shaders/hsv.gdshader", "uid://c66gb6g7tup3n"];

// The card glow/ripple shader. Its visibility is driven entirely by the `width` uniform: it is tweened up to
// 0.075 to show the ripple and back to 0 to hide it. At width 0 the transpiled
// `smoothstep(1.0 - width, width + (1.0 - width), brightness)` collapses to `smoothstep(1.0, 1.0, …)` — a
// degenerate (÷0) step that leaks a faint sliver at the SDF border on WebGL, where Godot draws nothing. So
// `shaderAttributes` suppresses the WebGL render when width ≈ 0, matching the game's hidden state. Both the
// res:// path and the uid:// alias appear depending on how the producer resolved the material's shader ref.
export const CARD_RIPPLE_SHADER_IDS = ["res://shaders/card_ripple.gdshader", "uid://bikvsfwlbp43n"];

// The game's SCREEN-TRANSITION overlay node (`Game/GameTransitionRect`). Its visibility is driven entirely by the
// material's `threshold` uniform, and EVERY transition shader resolves the fragment alpha from it alone:
//   res://shaders/fade_transition.gdshader           → `COLOR.a = threshold;`
//   res://materials/transitions/<char>_transition_mat.tres (ironclad/silent/defect/regent/necrobinder, one
//   embedded Shader sub-resource each, identical bodies)
//                                                    → `COLOR.a = step(1.0 - tex.r, mix(-0.1, 1.1, threshold));`
// At `threshold == 0` the first writes alpha 0 directly and the second's `step(falloff, -0.1)` is 0 for every
// `falloff ∈ [0,1]` — so at rest the node paints NOTHING, exactly like a resting card ripple. The gate is keyed
// on the NODE TYPE rather than the shader id because the shader is a per-character `.tres::SubResource` whose id
// varies (`Shader_spnx5`, `Shader_2greq`, `Shader_3ab6h`, …), while the node type is stable.
export const TRANSITION_NODE_TYPE = "MegaCrit.Sts2.Core.Nodes.NTransition";

// The LOW-HP VIGNETTE (`Run/GlobalUi/vfx_low_hp_border`, a full-bleed ColorRect). Its whole output is scaled by
// the `alpha_multiplier` uniform, and that is a BOUND, not a sample: the shader's final alpha is a `smoothstep`
// result — which GLSL clamps into [0,1] for every input — multiplied by `clamp(alpha_multiplier, 0, 1)`, and the
// colour is then modulated by the vertex colour, which can only shrink it further (the node's modulate ×
// self_modulate, `#ffffffc0` here). So the painted alpha can never exceed the streamed multiplier, whatever every
// other uniform does — noise texture, radii, smoothstep factors, main_color, all of it. Hence the gate keys on
// the multiplier ALONE: it is the only uniform that bounds the output from above.
//
// This is a REAL effect, not a dead node: on screen the vignette animates from all-but-invisible (~0.0025) up to
// full strength as the player is hurt, and the multiplier is streamed the whole way. The gate is therefore purely
// value-driven — the instant the streamed multiplier crosses the 8-bit floor the node wakes.
// Keyed on the NODE TYPE (stable) as well as the uniform, so an unrelated shader that happens to expose an
// `alpha_multiplier` — where nothing proves the same bound — is never parked.
export const LOW_HP_BORDER_NODE_TYPE = "MegaCrit.Sts2.Core.Nodes.Vfx.Ui.NLowHpBorderVfx";

const IMAGE_EXTENSIONS = /\.(png|webp|jpe?g|svg|exr|ktx|bmp|tga)$/i;

function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path);
}

// A gsw `source` node carrying the synthesized material doc the stamper built from the delta's shader params.
type MirrorShaderSource = GodotNode & { __mirrorDoc?: GodotResource };

// gsw `options.resolveResource` (SYNC): sampler texture ref → `/res/` image URL; the node's own material ref →
// the synthesized doc stashed on `source.__mirrorDoc`. Undefined otherwise.
export function resolveResource(
  ref: GodotResourceRefValue,
  node: GodotNode
): GodotResolvedResource | undefined {
  const path = ref.path;
  if (path && isImagePath(path)) {
    return { path, url: mirrorResourceUrl(path) };
  }
  const doc = (node as MirrorShaderSource | null)?.__mirrorDoc;
  if (doc) {
    return { path: path ?? undefined, type: doc.type, document: doc };
  }
  return undefined;
}

// gsw `options.resolveShaderSource`: fetch a `.gdshader` by path (the runtime transpiles it). Undefined on a
// miss keeps the node's CSS/SVG fallback.
export async function resolveShaderSource(path?: string): Promise<string | undefined> {
  if (!path) {
    return undefined;
  }
  try {
    const response = await fetch(mirrorResourceUrl(path));
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}

// The device's render-quality tier decides how much of the (GPU-bound) live WebGL pipeline runs. It
// folds in the old `?debug` disable (the auto-player tier is "off"), plus the low-end resolution/FPS
// knobs and a hard off switch. Read once at module load (a tier change is a reload). See `quality.ts`.
const quality = renderQuality();

// Capped loops park on a timer in both gsw effect runtimes.
const effectsLoopPacing: "timer" | "raf" = "timer";

// Let gsw select the available GPU backend. On Android Chrome that adopts WebGPU where it is usable and falls
// back to WebGL where it is not.
//
const effectsRenderer = "auto";

// ---- FROZEN-SURFACE IMAGE SWAP: the couch-coop POLICY over gsw's generic mechanism ----------------------------
//
// WHAT IT BUYS (the device evidence, kept from the mechanism this replaced). In the static effect modes the gsw
// runtimes draw one frozen frame per binding and park, yet every one of the fleet's `<canvas>` elements — 72 in
// the measured UNDERDOCKS combat, 28 shader + 44 particle — stays an unconditionally promoted compositor layer
// that is re-sampled every presented frame. rc2 measured the cliff on device (Android Chrome 151, Mali-G615):
// hiding the whole fleet took the corridor from ~11 to 87.5 fps. rc5 measured the swap itself force-engaged:
// render surfaces p50 103→18, TexOp/frame 361→66. (rc5 ALSO proved it is NOT a fix for the UNDERDOCKS widescreen
// black band — that stayed byte-black with all 72 canvases swapped, and is a separate, still-open defect.)
//
// WHY THIS IS NOW POLICY AND NOT CODE. This repo used to carry its own settle driver + per-binding freeze/thaw
// (`staticStills.ts` + a `staticStill*` block in mirrorRenderer). gsw has since grown the generic hooks that
// version existed for, so the two implementations collapsed into one: gsw owns the swap (encode, stand-in,
// revert, refcount, pacing, watchdog), and the parts that were genuinely couch-coop — WHICH surfaces may freeze,
// WHEN, and how hard the encode may hit the main thread — are the object below. Each knob is a decision the
// deleted mechanism had already paid for on device:
//
//   * `gate: quiet-window @1000ms` — the Stage D measured window. Our effect surfaces have no usable content key
//     (a particle system, a SCREEN_UV vignette), so stability can only be observed as "this surface's own draws
//     have held still". 1s, not the 3s the first global-settle version used: with gsw attributing draws per
//     surface, a stray repaint only resets THAT surface's clock, so the window only has to ride out one
//     binding's bring-up burst (source-resolve → first draw → texture-load redraw) instead of spanning
//     MirrorView's 1s safety reconcile. It is also what makes the swap REVERSIBLE, which the previous round
//     proved load-bearing: a family-wide freeze that any effects-dirty reconcile undid made focusing a card
//     resurrect every effect canvas for ~3.5s.
//   * `onInvalidate: "retry"` — NEVER block. gsw's default disqualifies a surface for the life of its binding
//     the first time its content key churns. Our biggest frozen population is `card_ripple`, whose key churns on
//     `width` (the churn bench found it one of only two churning families) — "block" would disqualify exactly
//     those nodes forever. `retry` also covers a failed encode, which is rescheduled rather than given up on.
//   * `encode: slice 4 / 120ms / smallest-first` — rc5's 736ms fix: kicking all 72 fleet encodes at once parked
//     the main thread for 736ms. Small-first lands the bulk of the fleet (tiny particle canvases) in the early
//     slices and leaves the room-sized ~4821×2156 shader monsters for their own late slices. The rest of the
//     encode policy (`perTask`, `taskGapMs`, `busy`, the bound, the backoff, the parked stills) is the Aug-19
//     trace's answer to the fact that a slice bounds THROUGHPUT and not the main-thread PARK — see the block
//     beside those constants below.
//   * `canFreezeSurface` — the STATIC-MODE VETO, and it is load-bearing: see below.
//   * the WATCHDOG comes free — gsw defaults it ON for the quiet-window gate, because a keyless surface can
//     repaint without saying anything useful. That is the same standing net the deleted driver carried, for the
//     same failure (a redraw landing in a canvas that a stale `<img>` is covering).
//
// THE VETO. The deleted mechanism only ever targeted families in STATIC effect mode, and a family LEAVING static
// thawed immediately. A quiet-window gate has no such notion: without a veto, a DYNAMIC-mode surface that merely
// happened to be quiet for one second would be frozen into an `<img>` — an animation that pauses briefly would
// stop permanently. So the gate is vetoed on the same per-family signal, the effective per-viewer effect mode.
// The veto only stops NEW freezes — it cannot un-freeze a surface that is already standing. MirrorView completes
// the pair with gsw's `invalidateStaticSurfaces()`, called from its "change" reconcile pass (a mode change, a
// stage resize, a spread re-layout): the direct replacement for the old `thawStaticStills()`.
//
// THE CANVAS-STAGE VETO (M2, Aug 27). Latched by `canvas/canvasRenderer.ts` when it builds an fx registry, i.e.
// when the active canvas stage owns effect pixels.
//
// The swap exists to REMOVE A COMPOSITOR LAYER: a quiet effect canvas becomes an `<img>` so the browser stops
// giving it its own layer. On the canvas stage under M2 there is no layer to remove — the effect's host is
// `visibility: hidden` and its pixels are a quad in the stage's own draw list — so every readback the swap takes
// buys nothing, and it is not free. Measured on the live combat room in STATIC mode, which is the mode that
// freezes everything and therefore the worst case: 2 shader captures, 134.7 ms of capture time, and BOTH of them
// blank (`staticImageBlankCaptures: 2`, `staticImageCaptureFailures: 2`) because the surface they read is one the
// stage has already taken ownership of. With the flag off, the same run takes ZERO shader captures — the hoist
// rule withholds those hosts, so gsw never has a surface to freeze.
//
// PARTICLES ARE VETOED TOO, for the same reason and with no exception for the flight-stills arm: an armed flight
// emitter on this stage is also a hidden host whose pixels are a quad.
//
// A LATCH RATHER THAN AN IMPORT. `rendererFactory` -> `canvasRenderer` -> `shaderAttributes` -> this module is an
// existing edge; reading the factory from here would close it into a cycle. The canvas renderer pushes instead,
// and a DOM-stage page never calls the setter, so it stays exactly as it was.
let stageOwnsEffectPixels = false;

/** Does the STAGE own effect pixels this page? Set by the canvas renderer when its fx registry exists. */
export function setStageOwnsEffectPixels(owns: boolean): void {
  stageOwnsEffectPixels = owns;
}

/** Exported for the spec — the veto's input, without a renderer to build. */
export function stageOwnsEffectPixelsNow(): boolean {
  return stageOwnsEffectPixels;
}

// The quiet window a surface's own draws must hold still before it is swapped (see the policy notes above).
const STATIC_SURFACE_QUIET_MS = 1000;
// Encode pacing: at most this many surfaces per window, that many ms apart, smallest backing store first.
//
// WS-5 (Aug-18 phone perf round): a 2.87 s Moto G86 trace measured this fleet's `toBlob` +
// `createObjectURL` at 52.8 + 17.1 = 70 ms (2.6% of the trace) on the MAIN THREAD, inside a
// `TimerFire`. The fix is `deferHead: true` below, NOT a throughput cut — `slice`/`intervalMs` stay
// where the earlier on-device measurements put them. Freezing surfaces SLOWER is not free: a surface
// that has not swapped yet is still a live canvas being drawn every frame, which is the cost the
// whole static-still path exists to remove. Cutting the rate (e.g. slice 4→2 + interval 120→200,
// which is a 3.3x throughput drop) would trade a measured win for an unmeasured one. If a device
// trace ever shows the DEFERRED windows are themselves too fat, tune these then, with that trace.
//
// Aug-19 follow-up — `busy` (below). The same trace's diagnosis was that the block is a GPU→CPU
// READBACK (~2.8 ms of encoder CPU behind ~30 ms of wall time), so `deferHead` moved it off the
// caller's stack but not out of the burst: a 1 ms timer lands between the same two draws. gsw grew
// `encode.busy` for that, and `mirrorFramePressure` is our answer to it — see framePressure.ts for
// the signal and its 250 ms window.
const STATIC_SURFACE_ENCODE_SLICE = 4;
const STATIC_SURFACE_ENCODE_INTERVAL_MS = 120;

// ---- Aug-19 (second trace, Moto G86): the ENCODE PARK, and the four levers that bound it ---------------------
//
// THE MEASUREMENT. A reshuffle trace caught two single tasks of 285 ms and 1,163 ms, 97% of their
// self-time inside native `toBlob` — and the SAME surfaces encoding in 6-13 ms each once the
// animation ended. Three separate things had to be true for that to happen, and each constant below
// answers exactly one of them:
//
//   1. `slice: 4` bounds THROUGHPUT per window, not the PARK: gsw drained all four readbacks
//      back-to-back inside one timer task, with no yield. Four × ~290 ms IS the 1,163 ms task.
//      ⇒ `perTask: 1`. The window budget is untouched (still 4 per 120 ms) — only its granularity
//      moves, so the longest park the mechanism can cause is now ONE readback. Throughput unchanged
//      means the freeze rate is unchanged, which is the thing that must not regress: an unswapped
//      surface is a live canvas re-composited every frame (the 11 → 87.5 fps cliff above).
//   2. `busy` was consulted once per PASS, i.e. once per four readbacks — it could not stop the 2nd,
//      3rd or 4th however much busier each one had just made the device. Under `perTask: 1` a pass
//      IS one readback, so the predicate is now re-asked before every one of them.
//   3. The predicate itself was blind at exactly the wrong moment: it is frame RECENCY, and a
//      1,163 ms task suppresses the frames it is made of, so the trace's two recovery gaps (362 ms
//      and 674 ms with no frames at all) read as IDLE at peak overload. Fixed on our side by
//      framePressure's armed-work suppliers; `slowEncodeMs` below is gsw's independent net under it.
const STATIC_SURFACE_ENCODE_PER_TASK = 1;
// The yield between two encode tasks of one window. 16 ms ≈ one 60 Hz frame, so our own rAF gets to
// run BETWEEN two readbacks — which is what makes the frame-derived predicate FRESH for the next one
// instead of stale for the whole drain. Costs 3 extra timer wakeups per drained window, and only in
// windows that have queued work (an idle fleet still arms nothing).
const STATIC_SURFACE_ENCODE_GAP_MS = 16;
// The self-measured backoff: a readback this slow holds the next one. 50 ms is >> the 6-13 ms an
// UNLOADED readback costs on this device and << the ~290 ms a loaded one costs, so anything landing
// between the two returns the same verdict and the number is not a tuned guess. gsw arms this from
// its own measurement of the previous readback, which is the one piece of evidence a main-thread
// block cannot suppress — the belt to our predicate's braces.
const STATIC_SURFACE_SLOW_ENCODE_MS = 50;
// How long that hold lasts: one quiet-window's worth. A surface that misses this pass was going to
// wait `quietMs` to become eligible again anyway, so the hold costs nothing it was not already
// paying, and it self-clears the instant readbacks get cheap again (6-13 ms arms nothing).
const STATIC_SURFACE_SLOW_BACKOFF_MS = 1000;
// The bound on ONE unbroken run of deferrals, for EITHER reason — the guarantee that deferring can
// only ever SLOW the fleet, never stop it. gsw's default is 3000 and this file used to leave it
// there for want of evidence; the trace supplies it, and the number is derived rather than picked:
//   * LOWER bound — it must exceed the longest legitimate burst we can produce, or a forced readback
//     lands in the middle of one. The traced 30-card discard→draw reshuffle runs ~2-4 s ⇒ 4000.
//   * UPPER bound — the forced pass is the ONLY guarantee of progress. With a latched predicate the
//     fleet drains one surface per bound: 72 surfaces × 4 s ≈ 4.8 min of live canvases. That is the
//     price of raising it, and it is why 4000 and not 10000.
// The bound firing is no longer expensive either: under `perTask: 1` a forced pass spends ONE
// readback, not a slice. Probe if a device ever shows the fleet not draining:
// `staticImageBusyForcedEncodes ≈ staticImageBusyDeferrals` (predicate stuck ON) with
// `staticImagesLive` failing to rise — and this is the first number to lower.
const STATIC_SURFACE_BUSY_MAX_DEFER_MS = 4000;
// PARKED STILLS budget (gsw `encode.parkedStillBytes`, default 0 = off). Our quiet-window population
// reverts constantly for reasons that are NOT repaints — a MirrorView `invalidateStaticSurfaces()`
// on any change reconcile, a dormancy wake, a watchdog proxy trip — and every one of those used to
// revoke the URL, so the next freeze re-paid a full readback for pixels the canvas was still
// holding. gsw now parks the encoded frame instead, stamped with the `drawSeq` and backing size it
// was taken at, and re-attaches it for ZERO readback when nothing has painted since. This is
// exact-by-construction reuse — a paint, a re-allocation or a decode failure disqualifies the entry
// and revokes it on the spot — so there is no fidelity question to A/B, only a memory one, which is
// what the budget is. 24 MB ≈ one fleet's worth of quiet-window stills. Measure it with
// `staticImageReuseHits`: every hit is a readback of the size that made the 1,163 ms task, not paid.
const STATIC_SURFACE_PARKED_STILL_BYTES = 24 * 1024 * 1024;

// ---- R17: RETAINED STILLS, and why the whole block is PARTICLE-ONLY -------------------------------------------
//
// THE MEASUREMENT THAT OPENED IT. R16b proved the N=30 phone floor is not render cost: gsw's WebGPU backend
// landed, adoption was MEASURED (`canvGpu` 60/60), and p95 (~117-122 ms) and p50 (~44.5 ms) did not move. What
// is left is 60 live emitter canvases. The wire recording says that fleet is 70 nodes carrying TWO distinct spec
// strings, ~320 px each, so one encoded still can serve 35 surfaces.
//
// WHY THE SHADER FAMILY DOES NOT GET ONE LINE OF THIS. Every constant above was set by measurements that covered
// BOTH fleets, and this block is the first that is not:
//   * `keyedQuietMs` is about a surface whose key is a COMPLETE description of its frame. A particle binding's
//     static-frame key is exactly that (gsw only reports one on the pristine path, and a re-blit under it is a
//     re-statement of the same pixels). A shader surface is already gated by a real content key on a fleet whose
//     biggest keyed family — `card_ripple` — CHURNS that key on `width`; there is nothing to buy and a stale
//     `<img>` to lose.
//   * `primeUnseenKeys` exempts a key's first encode from the deferral apparatus — and that apparatus was tuned
//     against the ~4821×2156 shader readbacks measured at ~290 ms on a loaded phone. Those are precisely the
//     surfaces it must not exempt; a ~320 px emitter is three orders of magnitude off them.
//   * `stillCacheBytes` RETAINS a key's blob after its last holder lets go. The shader fleet's frames are the
//     room-sized ones, and the pool is SHARED with the parked stills (gsw trims to the sum and either kind may
//     evict the other) — so retaining shader keys would pin megabytes and evict the particle entries this round
//     exists to keep. It stays a particle-side opt-in for that reason, not because the shader side would break.
// The shader policy is therefore byte-identical to the round before this one, and shaderResources.spec pins
// that as a contract rather than an observation.

// THE BUDGET, and what is and is not evidence for it.
//
// MEASURED: the population. 70 emitter nodes across a 30-card volley, 2 distinct spec strings, no per-node rect
// — so 2 keys per volley, at ~320 px CSS boxes.
// NOT MEASURED: what one of those PNGs weighs. A sparse sparkle frame compresses well and the backing store is
// dpr-scaled, but this round has not read a blob size off a device, and inventing one here and dressing it as
// evidence is exactly what this file does not do. The honest way to settle it is
// `mirrorWalkStats.staticStillRetainedBytes ÷ …RetainedEntries` on the bench cell — surfaced for that purpose.
// SO THE NUMBER IS BOUNDED RATHER THAN FITTED:
//   * LOWER — it must hold the flight population (2 entries) with room to spare under ANY plausible per-frame
//     size, AND the STATIC effect-mode particle fleet, which is the reason this defaults ON at all: `static` is
//     the tier a phone viewer actually ships with, its 44 particle canvases are the measured fleet, and every
//     one of their keys becomes retainable here. That fleet's DISTINCT-key count is unmeasured, so the lower
//     bound is really "enough headroom that an unmeasured population is not immediately evicting".
//   * UPPER — the pool is SHARED with `parkedStillBytes` (24 MB) and gsw trims to the SUM, so this raises the
//     ceiling on retained pixel bytes by a third, to 32 MB. Not free on a device whose GPU process was traced
//     climbing 148 → 276 MB over 9.6 s — which is why it is a third and not a doubling.
// THE PROBE, if this is wrong: `staticStillRetainedBytes` pinned at the budget while `staticStillCacheMisses`
// keeps climbing against a stable key population means the pool is evicting entries it should be keeping. Raise
// this first before raising the budget.
const STILL_CACHE_BYTES = 8 * 1024 * 1024;

/** One family's policy. `family` picks the effect mode the veto reads — nothing else differs, on purpose: the
 *  two fleets are the same kind of surface and the measurements that set these numbers covered both. */
function staticSurfacePolicy(family: "shader" | "particle"): StaticSurfaceOption {
  // R17's three additions are all PARTICLE-side (see the block above for why each one is). Spread rather than
  // set-to-a-neutral-value throughout, so the shader family's policy object comes out with exactly the fields it
  // had before this round — absent is gsw's untouched path, a chosen default is not.
  const particle = family === "particle";
  return {
    gate: {
      kind: "quiet-window",
      quietMs: STATIC_SURFACE_QUIET_MS
    },
    onInvalidate: "retry",
    encode: {
      slice: STATIC_SURFACE_ENCODE_SLICE,
      intervalMs: STATIC_SURFACE_ENCODE_INTERVAL_MS,
      order: "smallest-first",
      deferHead: true,
      // The PARK bound (see the Aug-19 block above): one readback per task, a display frame apart.
      perTask: STATIC_SURFACE_ENCODE_PER_TASK,
      taskGapMs: STATIC_SURFACE_ENCODE_GAP_MS,
      parkedStillBytes: STATIC_SURFACE_PARKED_STILL_BYTES,
      // R17, PARTICLE ONLY: retain a KEYED entry after its last holder lets go, so the second surface to reach
      // that frame attaches for zero readback — the thing that makes 35 copies of one spark frame free.
      ...(particle ? { stillCacheBytes: STILL_CACHE_BYTES } : {}),
      busy: mirrorFramePressure,
      busyMaxDeferMs: STATIC_SURFACE_BUSY_MAX_DEFER_MS,
      slowEncodeMs: STATIC_SURFACE_SLOW_ENCODE_MS,
      slowBackoffMs: STATIC_SURFACE_SLOW_BACKOFF_MS
    },
    // THE STATIC-MODE VETO (see above). Read LIVE, per candidate surface, off the same effective per-viewer mode
    // the runtimes themselves are configured from — so a family that is not frozen can never have a surface
    // frozen out from under it, however quiet it happens to be. The first term deliberately ignores the
    // node/canvas: that decision is per FAMILY, exactly as `setStaticStillModes(shader, particle)` was.
    //
    // When the STAGE owns the effect pixels, nothing may freeze at all. See `setStageOwnsEffectPixels` for why — the layer this swap
    // exists to remove does not exist on that stage, and the readbacks it takes to remove it read a surface the
    // draw list has already claimed. Read LIVE like the effect mode.
    canFreezeSurface: () =>
      !stageOwnsEffectPixels &&
      (family === "shader" ? effectiveShaderMode.value : effectiveParticleMode.value) === "static"
  };
}

// --- UNRENDERABLE EFFECTS, COUNTED ------------------------------------------------------------------------------
//
// gsw attempts every shader and every particle generically and falls back to the node's CSS/SVG paint when it
// cannot run one. That fallback is correct and invisible, which is the problem: a shader gsw has never once been
// able to render looks exactly like a shader that had nothing to do. gsw reports each failure through
// `options.onUnsupported`, and this repo had never wired it — so the mirror's own answer to "which effects are we
// silently not drawing" was "nobody has counted".
//
// WHAT THE COUNT IS FOR, with the case that prompted it. `wind_sway` is refused at transpile, and it will stay
// refused: it displaces VERTEX.x, and gsw's WebGL model is one quad with a fragment shader — there is no geometry
// to move. Supporting it means tessellating the quad and running a vertex stage per node, which is a gsw feature
// with its own cost and its own decision, not a patch to the transpiler. So the honest deliverable is not a fix but
// a NUMBER: the deckview's withheld hosts stop being folklore and become a census row in every bench run, and the
// day the model changes the same row measures it.
//
// RE-EMITTING THE WARN IS LOAD-BEARING (and easy to get backwards). `reportUnsupportedRender` dedupes by
// (kind, id, reason) and then routes to `onUnsupported` INSTEAD OF its own `console.warn` — so supplying a reporter
// and staying quiet would make this round's net effect "the failure got harder to notice". The warn is re-emitted
// here in gsw's own shape; the dedup upstream means it still fires exactly once per distinct failure.

/** How many distinct offender ids the census keeps. Enough to name one in a bug report, bounded so it cannot grow. */
const UNSUPPORTED_ID_SAMPLE = 8;

export interface UnsupportedRenderCensus {
  /** Distinct (kind, id, reason) failures reported — gsw deduped, so this counts causes, not frames. */
  total: number;
  /** `"<kind>:<reason>"` → count, e.g. `"shader:unsupported shader construct"`. */
  byReason: Record<string, number>;
  /** The first {@link UNSUPPORTED_ID_SAMPLE} distinct offender ids, so a census can name one. */
  ids: string[];
}

const unsupportedByReason = new Map<string, number>();
const unsupportedIds: string[] = [];
let unsupportedTotal = 0;

/** gsw `options.onUnsupported`, shared by BOTH families — the kind is already on the info. */
export function noteUnsupportedRender(info: UnsupportedRenderInfo): void {
  unsupportedTotal++;
  const key = `${info.kind}:${info.reason}`;
  unsupportedByReason.set(key, (unsupportedByReason.get(key) ?? 0) + 1);
  if (unsupportedIds.length < UNSUPPORTED_ID_SAMPLE && !unsupportedIds.includes(info.id)) {
    unsupportedIds.push(info.id);
  }
  if (typeof console !== "undefined") {
    const detail =
      info.error === undefined
        ? ""
        : ` (${info.error instanceof Error ? info.error.message : String(info.error)})`;
    console.warn(`[gsw] unsupported ${info.kind} "${info.id}": ${info.reason}${detail}`);
  }
}

/** The census snapshot — a fresh object per call, so a reader cannot mutate the counters. */
export function unsupportedRenderCensus(): UnsupportedRenderCensus {
  return {
    total: unsupportedTotal,
    byReason: Object.fromEntries(unsupportedByReason),
    ids: unsupportedIds.slice()
  };
}

/** TEST-ONLY: clear the counters. gsw's own dedup set has `__resetUnsupportedRenderReportsForTest`. */
export function __resetUnsupportedRenderCensusForTest(): void {
  unsupportedByReason.clear();
  unsupportedIds.length = 0;
  unsupportedTotal = 0;
}

// The harness seam. A FUNCTION, like `__mirrorShaderStats` / `__mirrorAtlasBakeStats`: the counters accumulate for
// the page's whole life and a probe reads them whenever it likes. Installed from module scope rather than from
// MirrorView's `onMounted`, so the recorder-sensitive mount ordering there is untouched.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__mirrorEffectUnsupported = () => unsupportedRenderCensus();
}

// gsw options for the attribute stamper + the WebGL runtime. The tier-derived scalar knobs
// (enable/renderScale/shaderFps/staticShaders/maxTextureDimension) come from the shared `qualityShaderOptions`;
// the mirror layers on its view-specific policy: `webglShaderIds: ["*"]` runs EVERY shader on WebGL generically
// (gsw falls back for shaders it can't transpile), `hsvAdjustShaderIds` diverts the HSV family to a color-matrix,
// and `resolveResource`/`resolveShaderSource` feed the synthesized material doc + `.gdshader` text.
//
// A PLAIN object (not reactive): the attribute stamper (shaderAttributes.ts) reads it synchronously per node, so
// its shape/`enableWebglShaders` stays tier-fixed. The per-viewer live effect MODE is a SEPARATE reactive computed
// (`effectiveShaderMode` below) that only drives runtime create/dispose/retune in MirrorView — the markers still stamp.
export const mirrorShaderRenderOptions: GodotHtmlMountOptions = {
  ...qualityShaderOptions(quality),
  // CLAMP LIFT (mirror only — the shared qualityShaderOptions stays tier-faithful for the recon view, which has
  // no panel to decide with). The tier seeds the panel's initial mode; from there the PANEL decides, so the
  // runtime must be constructible on every tier that has a usable GPU path. Only the hard-off lane (?debug /
  // ?quality=off / software-WebGL phone) stays dead.
  enableWebglShaders: !shadersHardOff(quality),
  webglShaderIds: ["*"],
  hsvAdjustShaderIds: HSV_SHADER_IDS,
  resolveResource,
  resolveShaderSource,
  effectsLoopPacing,
  effectsRenderer,
  // The SEED of the frozen-mode backing pin (staticPin.ts): a binding created before MirrorView's first
  // viewport measurement is sized at the device target straight away rather than at `dpr × renderScale` and
  // then re-sized. MirrorView owns the live correction (it re-pushes via setStaticShaderPixelRatio when the
  // target moves). It is undefined only when no usable device target exists; gsw then takes its un-pinned path.
  // Only consulted while the runtime is FROZEN, so it is inert in every dynamic mode.
  staticShaderPixelRatio: staticShaderPinRatio(),
  // The frozen-surface `<img>` swap, under the couch-coop policy above.
  staticShaderImages: staticSurfacePolicy("shader"),
  // Count what gsw could not render instead of letting it fall back in silence — see `noteUnsupportedRender`.
  onUnsupported: noteUnsupportedRender
};

// SHADERS TO LINK BEFORE COMBAT.
//
// WHY, and exactly what this can and cannot claim. gsw compiles a shader when the first NODE that uses it is
// created, and yields to the driver before asking a blocking status question. That yield is worth almost the
// whole cost on a device with `KHR_parallel_shader_compile` — but the phone this round is gated on answers NULL
// for that extension, so gsw's `ready()` reports true at once and `finish()` then blocks on `LINK_STATUS` for as
// long as the driver takes. The Aug-28 Moto G86 trace has one such block at 90.3 ms, mid-combat, because that
// frame was the first to create a node with that shader.
//
// Warming CANNOT make the link cheaper — the driver's work is the driver's work. It only moves WHEN it is paid,
// from the frame a card is played to the loading screen, where 90 ms is invisible. That is the whole claim.
//
// WHY THESE THREE, and the honest limit of the list. The trace names the call site (gsw's `compileProgramAsync`)
// but NOT which shader was being linked, so this is not a list derived from the measurement — it is the set of
// shaders this file already names that (a) run on WebGL and (b) are attached to nodes the game creates DURING a
// combat rather than at its start: the card glow/ripple (a node per card highlight), the low-HP vignette (created
// when the player is first hurt) and the screen-transition overlay. HSV is deliberately absent: that family is
// diverted to a CSS color-matrix and never reaches WebGL at all (see `HSV_SHADER_IDS`).
//
const SHADER_WARM_DEFAULT_PATHS = [
  CARD_RIPPLE_SHADER_IDS[0],
  "res://shaders/vfx/ui/vfx_ui_low_hp_border_shader.gdshader",
  "res://shaders/fade_transition.gdshader"
];

/**
 * The shaders to hand `WebglShaderRuntime.warmPrograms`.
 *
 * `shaderKey` is the resource path here because that is the key gsw derives from `data-godot-shader-path`, which
 * is what the mirror's attribute stamper writes; a warm keyed any other way would compile a program the create
 * path then fails to find.
 */
export function shaderWarmSpecs(): Array<{ shaderKey: string; path: string }> {
  return SHADER_WARM_DEFAULT_PATHS.map((path) => ({ shaderKey: path, path }));
}

// Options for the gsw particle runtime (createParticleRuntime in MirrorView). The mirror stamps specs itself,
// so the build-time opt-in lists (particleIds/particleNodesByPath) are irrelevant here — only the shared
// tier-derived knobs apply (enable/particleFps/renderScale cap the screen-filling ambients on weak GPUs).
export const mirrorParticleRenderOptions: GodotHtmlMountOptions = {
  ...qualityParticleOptions(quality),
  // The clamp lift that actually changed behavior: the `static` tier a mid-range phone auto-resolves to carries
  // `particlesEnabled: false`, which used to make the panel's Particles select a dead control on exactly the
  // devices that see it most (no runtime, and no stamped markers — see particleAttributes). The panel decides now;
  // only the hard-off lane stays dead.
  enableParticles: !particlesHardOff(quality),
  effectsLoopPacing,
  effectsRenderer,
  // Static-mode parked canvases must not keep standing blend render surfaces.
  parkStaticParticleBlend: true,
  // Don't force a layout flush per particle system just to size its canvas.
  particleRectCache: true,
  // …and don't force one to size a NEW system either — take its first box from the observer.
  particleObserverSizing: true,
  // A suspended system parks its canvas too, not just its simulation.
  particleDormant: true,
  // Size each canvas from where its particles actually TRAVEL, clamped to the visible-rect budget the renderer
  // stamps per node — the chest's cropped coin burst.
  particleTravelExtents: true,
  // The particle sibling of `staticShaderPixelRatio` above — same seed, same kill switch, but scaled by the
  // PARTICLE static backing scale (0.25 on a phone). gsw's particle draw scales its instance geometry by the
  // ratio the canvas was really sized at, so a pinned system sprays at the pinned density.
  staticParticlePixelRatio: staticParticlePinRatio(),
  // The particle half of the frozen-surface swap — the SAME policy as the shader side (see above); only the
  // family the veto reads differs. The parked particle fleet is the bigger half of the measured tax (44 of the
  // 72 canvases), and it is the half that owned the standing blend render surfaces the option above
  // above neutralizes — an `<img>` removes the surface outright.
  staticParticleImages: staticSurfacePolicy("particle"),
  // The particle half of the same census — a malformed spec degrades just as quietly as a refused shader.
  onUnsupported: noteUnsupportedRender
};

// The EFFECTIVE per-viewer effect mode the settings panel drives. The panel's mode IS the effective mode on every
// tier with a usable GPU path; only the HARD-OFF lane (?debug auto-player / ?quality=off / software-WebGL phone —
// see quality.ts) forces `off`, because there the runtimes would rasterize on the CPU for nothing and no DOM
// markers are stamped for them to find.
//
// This used to be an AND-gate against the tier's own enable flags, which is what made particles unreachable from
// the panel on the mobile `static` tier (and made the same panel setting mean different things on a phone and a
// desktop). MirrorView watches these to create/dispose + retune the shader + particle runtimes live without a
// reload (off ⇒ dispose; static ⇒ setStaticShaders/setStaticParticles; ½/¼ ⇒ setRenderScale) — the plain option
// objects above stay the tier-fixed construction options.
export const effectiveShaderMode: ComputedRef<EffectMode> = computed(() =>
  shadersHardOff(quality) ? "off" : mirrorSettings.shaderMode
);
export const effectiveParticleMode: ComputedRef<EffectMode> = computed(() =>
  particlesHardOff(quality) ? "off" : mirrorSettings.particleMode
);
