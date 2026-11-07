// EFFECT SURFACES FOR THE SINGLE-CANVAS STAGE — a gsw-owned <canvas> in, an uploaded GL texture out.
//
// The sibling of `textureBridge`, and its opposite in lifecycle. The bridge maps a URL to an IMMUTABLE texture: one
// load, one upload, done forever. This maps a NODE ID to a MUTABLE one — a shader or particle surface whose pixels
// the gsw runtime repaints whenever it likes, and which therefore may be re-uploaded on every frame for as long as
// the effect is alive. The key space is per node rather than per url, the upload is `cache.update` (replace the
// pixels, keep the refcount) rather than `cache.acquire`, and the budget is spent repeatedly instead of once.
//
// WHY IT EXISTS. A surface on a DOM overlay above the stage canvas would paint over anything the game draws on top
// of it, which is why `overlay.ts` has a HOIST RULE that withholds covered surfaces. A surface uploaded as a
// texture is drawn as a quad at the node's own paint index, so "above" and "below" are just command indices and
// nothing is withheld. This module is the pixel half; the quad half is `paintSpec.emitFxQuad`.
//
// KEY SPACE — `fx://<nodeId>`, or `fx://k<n>` for a SHARED frozen frame. Effect textures live in the same
// per-context `CanvasTextureCache` as the bridge's page textures (one white texel, one byte total, one reset on
// context loss). The prefix keeps the populations apart — a bridge key is always a page URL — and is the whole of
// `textureBridge`'s fx seam: a key starting with `fx://` is delegated here. What follows the prefix is opaque to
// the bridge.
//
// SHARING. In a frozen effect mode gsw renders one frame per binding and serves identical bindings from a
// static-frame cache. A surface that reports a `staticKey` ({@link FxRenderInfo.staticKey}) is therefore keyed by
// that frame instead of by its node: the first holder uploads, later holders attach to the same cache entry and
// upload nothing. Quads are unaffected — each node keeps its own quad, placement and alpha, they just name one
// texture. This is safe because gsw's key IS the frame's identity (the same string the static-frame cache and the
// image swap dedupe by). Where a frame is not content-addressed (live mode, SCREEN_UV, a decoding texture, a
// stepped particle state) gsw reports no key and the surface keeps its private `fx://<nodeId>` entry. A key that
// churns moves the surface to the new key's entry and drops its hold on the old one.
//
// BOX. The quad comes from the CANVAS ELEMENT, not the node. gsw sizes and places its canvas itself: a shader
// canvas in percent of the node's self-layer, a particle canvas in px with negative left/top (a travel margin so
// particles outside the emitter's box are not clipped; the emitter's own box is 0x0). The geometry is read off
// `canvas.style.{left,top,width,height}` against the record's box, so a runtime that re-places its canvas needs no
// extra plumbing.
//
// PACING. `cache.update` calls `texImage2D` on the calling thread, so an upload is a synchronous main-thread cost.
// A real GPU charges a fixed per-call term that dominates a pixel term for typical mirror surfaces, so a byte
// budget alone cannot bound a build: the plan carries a COUNT cap as well, and the byte cap binds only for large
// surfaces. Both stop the plan on the same rule (see `openBuild`), and always-allow-one wins over both.
//   * LRU-FIRST, not paint order. An fx surface is dirty again next frame, so paint order would hand the budget to
//     the same earliest-painted surfaces forever. Rotating least-recently-uploaded first shares it out; never-
//     uploaded surfaces sort first (upload sequence 0), so a new effect gets pixels before an old one refreshes.
//   * ALWAYS-ALLOW-ONE. A budget smaller than one surface must not deadlock it: the first candidate of a build is
//     admitted unconditionally. One oversized `texImage2D` is indivisible; the budget only keeps it alone.
//   * A DEFERRED SURFACE KEEPS ITS LAST PIXELS. The quad still draws from an earlier upload, so deferral looks like
//     a lower frame rate and never a transparent hole. `stale` on the returned record says which a caller is
//     looking at. A surface that has never uploaded has nothing to paint: `acquire` answers null and no quad is
//     emitted.
//
// THE THREE PARK GUARDS. A settled screen stays idle by PARKING: `armAnimation` takes the min of its demand
// sources' deadlines and stops the loop when none is finite. This registry is one such source, so a bug here shows
// up as a stage that never stops rendering rather than as a wrong pixel. Each guard has its own unit spec.
//   1. `endBuild` CLEARS THE DIRTY BIT of any surface the just-finished build did not name (an off-screen effect
//      keeps rendering in the DOM). `acquire` re-arms it when a build names the node again (see the epoch check).
//   2. `noteRendered` FIRES `onDirty` ONLY FOR IDS THE LAST BUILD NAMED, so a frame from a surface no one is drawing
//      cannot wake a parked stage.
//   3. THE BUDGET PUMP TERMINATES. Every build uploads at least one dirty surface or has none to upload, and every
//      upload attempt — success, refusal, empty backing store — clears the bit it was called for.
//
// REFUSALS (not withholdings). MAX_TEXTURE_SIZE: a source longer than the context's limit cannot be uploaded —
// `texImage2D` answers INVALID_VALUE and leaves the texture INCOMPLETE, which samples as opaque BLACK — so it is
// refused before the upload, counted, and never retried. SCREEN_TEXTURE: a shader that reads the screen is
// refused, because gsw's screen capture approximates the DOM composite, which on this stage lacks the game (it
// lives in the canvas); painting nothing beats painting something confidently wrong. Both land in
// `stats.declined`, deliberately NOT in `overlayCounts.withheld`, which counts only what the hoist rule hides.
//
// THE FPS CAP — A CAP ON WAKEUPS, NOT ON UPLOADS. In a dynamic effect mode every gsw frame sets a dirty bit, and
// `nextDeadline` answering `now` for any dirty bit would keep the stage rebuilding at gsw's rate even when nothing
// the game owns has moved. So the deadline is the surface's LAST UPLOAD plus one capped frame. It does not cap
// gsw, and it does not cap `acquire`, which still uploads the freshest pixels of any build that runs anyway. Two
// rules keep it safe: a NEVER-UPLOADED dirty surface is due NOW, and NOTHING SUPPRESSES `onDirty` (swallowing the
// notification would leave a permanent dirty bit and kill park guard 3; only the timestamp moves). The cap must
// sit below gsw's own rate to bind; the fixed rate is 15, the spine bake's rate.

import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  type BlendMode,
  type CanvasTextureCache,
  type ExecutorTexture
} from "@godot-scene-web/canvas";
import type { GodotEffectRenderInfo } from "@godot-scene-web/html/runtime";

/** The key-space prefix that tells `textureBridge` a key belongs to this registry rather than to a page url. */
export const FX_KEY_PREFIX = "fx://";

/**
 * Default per-build upload BYTE budget (32 MB = 8 Mpx).
 *
 * Deliberately generous next to the count cap: on a real GPU the pixels are the cheap half. What this number is for
 * is the case the count cap cannot see — a handful of very large surfaces (a 2765x1296 water reflection is 14 MB on
 * its own) arriving in the same build, which the byte cap cuts after two so the rest ride the next one.
 */
export const FX_PACE_BYTES_DEFAULT = 32 * 1024 * 1024;

/**
 * Default per-build upload COUNT cap — and, unlike the bridge's, the cap that USUALLY BINDS.
 *
 * The bridge's count cap is a secondary guard on a cost that is essentially linear in bytes. Here the fixed
 * per-upload term is larger than the pixel term for every surface a mirror screen carries, so the number of
 * uploads IS the cost. A 30-effect combat screen in a dynamic mode therefore rotates its refreshes across several
 * builds instead of paying for all of them in one.
 */
export const FX_PACE_COUNT_DEFAULT = 8;

/** How many builds a surface can go un-named before its texture is released. */
export const FX_EVICT_AFTER_BUILDS = 120;

/**
 * THE RESIDENT FX-BYTE CAP, default 48 MB.
 *
 * The sibling of the texture bridge's page ceiling. The registry otherwise has only an upload PACE (which shapes
 * when bytes arrive rather than how many stay) and a 120-build age-out (a clock, not a budget).
 *
 * 48 MB is placed by the observed spread of resident fx bytes rather than by symmetry with the page cap. The
 * product default is STATIC on both effect families, where residency stays far below it, so on the shipped
 * configuration the ceiling is never approached and `evictedByCap` staying at 0 is the check that says so. What it
 * bounds is the DYNAMIC worst case, where one flight-heavy screen can hold hundreds of MB in a population nothing
 * else governs.
 *
 * The recovery is cheaper here than for a page, which is why a cap is defensible at this size: an evicted fx
 * texture is re-uploaded with ONE `texImage2D` from the runtime's own live canvas, which is still mounted and
 * still drawing. There is no fetch and no decode.
 *
 * `0` is the documented OFF switch, matching the pace budgets beside it.
 */
export const FX_RESIDENT_BYTES_DEFAULT = 48 * 1024 * 1024;

/**
 * Default STAGE-WAKEUP cap for effect surfaces, in frames per second — see the header's FPS CAP section.
 *
 * 15, for two reasons. It has to be BELOW the rate gsw already draws at or it cannot bind: every quality tier sets
 * `shaderFps`/`particleFps` to 30, so a cap at 30 would be a no-op. And it is the rate the spine bake already runs
 * at, so the two demand sources that can hold a settled screen awake agree on what "a frame" means.
 */
export const FX_FPS_DEFAULT = 15;

/** What the key for a node's surface is. The inverse of {@link fxNodeIdFromKey}. */
export function fxKeyForNode(nodeId: string): string {
  return FX_KEY_PREFIX + nodeId;
}

/** The node id inside an `fx://` key, or null when the key belongs to some other population. */
export function fxNodeIdFromKey(key: string): string | null {
  return key.startsWith(FX_KEY_PREFIX) ? key.slice(FX_KEY_PREFIX.length) : null;
}

/**
 * The producer's complete render information, made optional only at this consumer boundary.
 *
 * Older toolkit checkouts did not pass the third callback argument, and this registry deliberately
 * retains its conservative fallbacks for that case. Keeping the shape derived from gsw means newly
 * published fields cannot silently fork into a second consumer-owned contract.
 */
export type FxRenderInfo = Partial<GodotEffectRenderInfo>;

/**
 * One effect surface, as the quad emitter needs it.
 *
 * REGISTRY-OWNED AND UPDATED IN PLACE: `acquire` returns the same object for the same node every build (there is
 * one per surface, so a 30-effect screen allocates nothing per frame). Read it, do not keep it.
 *
 * `offsetX`/`offsetY` are the canvas's origin RELATIVE TO THE NODE'S BOX ORIGIN, in design units — negative for a
 * particle system's travel margin — so the quad's matrix is the record's placement transform composed with this
 * translation. `cssW`/`cssH` are the canvas's CSS box, which is the quad's destination size; the SOURCE size is
 * the backing store and comes from {@link FxSurfaceRegistry.sizeOf} (they differ by dpr, and by the whole render
 * scale under the half/quarter quality tiers — a tier shrinks the effect's target, never the stage).
 */
export interface FxSurface {
  readonly key: string;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly cssW: number;
  readonly cssH: number;
  readonly blend: BlendMode;
  /**
   * The BACKING STORE of the texture behind {@link FxSurface.key} — the quad's source rect.
   *
   * On the view rather than fetched with a second call, because since the frame-key sharing a surface's texture
   * is not always its own node's: `key` and these two have to come from the SAME place or a quad could sample a
   * twin's texture through its own (identical, but separately resolved) size. It is the size of the pixels that
   * are ON THE GPU, which is not always the live canvas's — a runtime that just resized its backing store has
   * not re-uploaded yet, and the quad must keep sampling what is really there.
   */
  readonly pageW: number;
  readonly pageH: number;
  /** Are these the pixels gsw drew last, or an earlier upload the governor is still catching up to? */
  readonly stale: boolean;
}

export interface FxSurfaceStats {
  /** Surface records known right now — named by a build, or reported by a runtime, or both. */
  surfaces: number;
  /**
   * TEXTURES held right now — entries, not surfaces (see the header's sharing section). A frozen fleet of twins
   * is ONE resident texture with many surfaces drawing it, so `surfaces - resident` is no longer a shortfall.
   */
  resident: number;
  /** Resident RGBA bytes across those textures — THIS registry's share of the shared cache, not the cache total. */
  bytes: number;
  /**
   * Textures shared by MORE THAN ONE surface right now — the sharing, as a gauge rather than a claim.
   *
   * Read it with {@link FxSurfaceStats.sharedAttaches}: this says how much of the CURRENT screen is deduped,
   * that says how many uploads the mechanism has saved since the page loaded. Both 0 on a page whose runtime
   * reports no frame keys (a live/dynamic effect mode, or a gsw without the field), which is the un-shared
   * behaviour this replaced and not a fault.
   */
  sharedEntries: number;
  /**
   * Uploads NOT PAID because the texture already held the frame the surface was showing (cumulative).
   *
   * Every one of these is a `texImage2D` of a whole effect surface — megabytes, on the shader fleet — that this
   * build would have spent before the frame key existed. It counts the second card of a hand attaching to the
   * first card's glow, and also a single node re-blitting its own frozen frame.
   */
  sharedAttaches: number;
  /** Surfaces whose pixels are newer than their texture right now. This is what `nextDeadline` answers from. */
  dirty: number;
  /** Acquires that painted an EARLIER upload because the build's budget was spent (cumulative). */
  deferred: number;
  /** Surfaces permanently refused: SCREEN_TEXTURE policy, over `maxTextureDim`, or a source the driver rejected. */
  declined: number;
  /** `texImage2D` calls made through `cache.update`. */
  uploads: number;
  /**
   * Total main-thread ms spent inside those `update` calls — SUBMIT COST ONLY, and NEVER quotable as GPU upload
   * cost.
   *
   * `texImage2D(canvas)` records a pending copy and returns; the driver does the work later, and only a read
   * (`readPixels`, `finish`) synchronises with it. Measured that way an upload costs a small fraction of the real
   * bill — the difference is entirely work this timer cannot see.
   * These three fields are useful for spotting a submit-side stall (a driver validating a huge source inline);
   * they are NOT the number the governor is sized against, and printing them as "upload ms" would under-report the
   * real cost by more than an order of magnitude.
   */
  uploadMs: number;
  /** The longest single upload SUBMIT, ms. See {@link FxSurfaceStats.uploadMs} for what this does not measure. */
  maxUploadMs: number;
  /** The largest total submit ms charged to ONE build. Same caveat as {@link FxSurfaceStats.uploadMs}. */
  maxBuildUploadMs: number;
  /** Textures released because no build named them for {@link FX_EVICT_AFTER_BUILDS} builds. */
  evicted: number;
  /** The resident byte ceiling in force (0 = off) — see {@link FX_RESIDENT_BYTES_DEFAULT}. */
  residentCap: number;
  /**
   * Textures released by that ceiling rather than by the age-out. Separate from {@link FxSurfaceStats.evicted}
   * for the same reason the bridge separates its two: an age-out is a surface the scene stopped drawing, a cap
   * eviction is one it may draw again next build. Above 0 on a STATIC-effects screen means the ceiling is
   * mis-placed, because every static reading this was sized against is under 5 MB.
   */
  evictedByCap: number;
  /**
   * Textures given back because their NODE went away (see {@link FxSurfaceRegistry.release}) — the other half of
   * `evicted`, and the one that dominates on a screen whose VFX are spawned and destroyed per impact.
   *
   * Reported separately because the two say different things about a low `resident`: eviction means the scene
   * stopped DRAWING a surface it still has, release means the surface's node is gone.
   */
  released: number;
  /** Surfaces refused for exceeding `maxTextureDim` — a subset of {@link FxSurfaceStats.declined}. */
  oversized: number;
  /** The byte budget in force; `0` means the governor is off. */
  paceBytes: number;
  /** The per-build upload count cap in force; `0` means uncapped. Usually the binding one — see the header. */
  paceCount: number;
  /** The STAGE-WAKEUP cap in force, fps; `0` means uncapped — see the header's cap section. */
  fps: number;
  /**
   * SURFACES BEING MAGNIFIED — bindings acquired by the LAST CLOSED BUILD whose backing store is more than
   * {@link FX_UNDER_RESOLVED_SLACK} smaller than the device pixels they cover on screen. R-A4.
   *
   * WHAT IT CATCHES, and it is a whole class of soft render that no other number here can see. A gsw effect owns
   * its own `<canvas>`: the runtime sizes the BACKING STORE, the mirror places the CSS box, and nothing has ever
   * checked that the first is big enough for the second. Every quantity already reported is happily consistent
   * with a 128x128 store stretched across a 512-device-pixel box — `resident` counts it, `bytes` prices it,
   * `uploads` says the pixels are flowing, and the executor's LINEAR filter turns the shortfall into a smooth,
   * plausible, WRONG image rather than anything that looks like a fault. It is the fx twin of the glyph path's
   * ppem floor: the picture is not missing, it is merely blurrier than the machine could have drawn it.
   *
   * THE SLACK IS ONE QUANTISATION STEP, NOT A TOLERANCE FOR BEING WRONG. gsw quantises a surface's store to 1/8
   * steps of its box, so a correctly-sized surface can legitimately sit up to one step under its device box and a
   * tighter test would report every effect on the screen. Anything past that step is a store that is genuinely
   * too small, not a rounding.
   *
   * PER BUILD, NOT CUMULATIVE, and it is the one counter here that is. The others count EVENTS (an upload
   * happened, a texture was evicted) and are only meaningful summed; this is a property of the CURRENT set of
   * bindings, and a running total over frames would just be this number times the frame count. A census taken
   * post-settle reads the last closed build's answer, which is exactly the screen the reader is looking at.
   */
  underResolved: number;
  /**
   * Was {@link FxSurfaceOptions.resolutionCensus} armed for this registry? Published because `underResolved` is 0
   * both when nothing is under-resolved AND when nothing was measured,
   * and those are opposite findings. A census that carries the arm can never be read against the wrong one.
   */
  resolutionCensus: boolean;
}

/**
 * How far under its on-screen device box a surface's backing store may sit before {@link
 * FxSurfaceStats.underResolved} counts it: one of gsw's 1/8 quantisation steps.
 */
export const FX_UNDER_RESOLVED_SLACK = 1 / 8;

/**
 * The seam `textureBridge` delegates `fx://` keys through. Structurally satisfied by
 * {@link FxSurfaceRegistry} — it is written out separately so the bridge depends on two methods rather than on
 * this whole module.
 */
export interface FxTextureSource {
  /**
   * `token` is the part of an `fx://…` draw-list key AFTER the prefix, and it is deliberately opaque to the
   * caller: a node id for a private surface, a `k<n>` frame token for a shared frozen frame (see the header).
   * The bridge slices the prefix and asks; only this registry knows which of the two it just handed back.
   */
  handleFor(token: string): ExecutorTexture | null;
  sizeOf(token: string): { width: number; height: number } | null;
}

export interface FxSurfaceRegistry extends FxTextureSource {
  /**
   * A gsw runtime just PAINTED this node's canvas. Records the pixels as new and, when the last build actually
   * named this node, asks the caller for a repaint (park guard 2).
   *
   * Called from the `onBindingRendered` chain, i.e. once per WRITE to that binding's canvas: a real draw, a
   * static-frame cache-hit blit, or a particle clear that blanks a finished burst. The blit is not a footnote
   * here — in a frozen effect mode (the product default) a fleet of identical surfaces settles at ONE draw and
   * N-1 blits, and this call is the ONLY way a surface's canvas ever reaches this registry, so a runtime that
   * withheld it would leave every twin unpainted on this stage. The caller is expected to coalesce `onDirty`
   * (the renderer's `armAnimation` is idempotent), because a dynamic screen fires this once per surface per
   * frame.
   */
  noteRendered(nodeId: string, canvas: HTMLCanvasElement, info?: FxRenderInfo): void;
  /**
   * NAME this node for the build in progress and get the surface to draw, or null when there is nothing to draw
   * yet (no runtime frame, an empty canvas, a refused surface, or a first upload the budget deferred).
   *
   * `recW`/`recH` are the node's own box — what a percentage-placed canvas resolves against. Uploading happens
   * HERE, inside the build, exactly like the bridge's `handleFor`: that is where the budget can see it.
   */
  /**
   * Name this node for the current build and hand back its quad view.
   *
   * `axisScale` is the mean-axis linear scale of the placement affine the caller is about to draw the quad
   * through — the surface's magnification in DESIGN space, rotation excluded (see `./fxPixelRatio`). It is
   * read ONLY by the resolution census, which needs to know how many device pixels the surface covers along
   * its own axes; it defaults to 1 so a caller that does not care is exactly as it was.
   */
  acquire(nodeId: string, recW: number, recH: number, axisScale?: number): FxSurface | null;
  /** The uploaded texture for a node, or null when it has none yet. This is what an `fx://` key resolves to. */
  handleFor(nodeId: string): ExecutorTexture | null;
  /** The uploaded texture's PAGE size (the canvas backing store), which is the quad's source rect. */
  sizeOf(nodeId: string): { width: number; height: number } | null;
  /**
   * Has this node been permanently REFUSED (SCREEN_TEXTURE policy, over `maxTextureDim`, a source the driver would
   * not take)? False for a node this registry has never heard of.
   *
   * Exists for the OVERLAY, which owns the host element: a refused surface will never become a quad, so its host
   * should stop existing too — otherwise the DOM overlay keeps compositing a gsw canvas above the whole stage,
   * which is the exact layering the fx path exists to end. See `overlay.ts`'s refusal branch.
   */
  declined(nodeId: string): boolean;
  /** Close the build: bank the budget stats, drop unnamed dirty bits (park guard 1), evict what left the scene. */
  endBuild(): void;
  /**
   * When the stage should next wake FOR EFFECTS, or Infinity when no named surface is waiting on an upload — the
   * stage's third demand source.
   *
   * This is a real timestamp: the oldest dirty surface's last upload plus one capped frame (see the header's FPS
   * CAP section). `nowMs` for a surface that has never uploaded, and `nowMs` when the cap is disabled.
   */
  nextDeadline(nowMs: number): number;
  /** The node is gone (unmounted, or its effect attributes went null): drop the record and the texture. */
  release(nodeId: string): void;
  /**
   * With an id: the surface's uploaded pixels are no longer trustworthy (gsw rebuilt the binding), so re-upload on
   * the next build — the old texture keeps painting until then. With no id: CONTEXT LOSS, so every surface forgets
   * its upload WITHOUT touching the dead driver (gsw's `cache.reset()` has already dropped the textures).
   */
  invalidate(nodeId?: string): void;
  stats(): FxSurfaceStats;
  dispose(): void;
}

export interface FxSurfaceOptions {
  cache: CanvasTextureCache;
  /** A named surface has new pixels: repaint. MUST NOT acknowledge a scene delta — this is not one. */
  onDirty?: () => void;
  /**
   * Per-build upload budget in bytes. `0` (or a non-finite value) turns the BYTE cap off. Defaults to
   * {@link FX_PACE_BYTES_DEFAULT}.
   */
  paceBytes?: number;
  /**
   * Per-build upload COUNT cap. `0` (or a non-finite value) turns the COUNT cap off. Defaults to
   * {@link FX_PACE_COUNT_DEFAULT}, and it is the cap that usually binds — see the header's pacing section.
   */
  paceCount?: number;
  /**
   * How often the STAGE may wake to draw new effect pixels, in fps. `0` (or a non-finite value) turns the cap off,
   * which disables the cap entirely. Defaults to {@link FX_FPS_DEFAULT}.
   */
  fps?: number;
  /**
   * The context's `MAX_TEXTURE_SIZE`. A backing store with a longer side is refused rather than uploaded
   * incomplete. Omitted (or 0) means "do not check", which is what a test without a real GL context wants.
   */
  maxTextureDim?: number;
  /** Overridable for tests. Defaults to {@link FX_EVICT_AFTER_BUILDS}. */
  evictAfterBuilds?: number;
  /**
   * Resident byte ceiling for THIS registry's textures — see {@link FX_RESIDENT_BYTES_DEFAULT}. `0` disables it.
   * This registry's share alone: the pages, the spine stills and the label rasters each keep their own governor.
   */
  residentBytes?: number;
  /**
   * Measure each acquired surface's backing store against its on-screen box — {@link
   * FxSurfaceStats.underResolved}. Default FALSE, and the default is not timidity: the measurement reads
   * `getBoundingClientRect()`, which forces a synchronous layout, and a build that has just written the overlay
   * would pay for one per named surface. The renderer arms it on the same predicate the paint-dump seam uses (a
   * dev bundle always, a production one only when asked), so the shipped page's build loop is untouched and the
   * number is there whenever anyone is actually looking. `underResolved` stays 0 with it off, which is
   * indistinguishable from "nothing is under-resolved" — read it beside the arm, never alone.
   */
  resolutionCensus?: boolean;
  /**
   * The stage's design-px to DEVICE-px factor (`stageScale() * stagePixelRatio()`), read fresh per measurement.
   * The other half of the resolution census: `acquire`'s `axisScale` says how magnified a surface is inside the
   * design space, this says how big a design pixel is on the glass. A FUNCTION, not a number, because the stage
   * re-fits on every resize and a registry built at mount would otherwise hold the first fit forever.
   *
   * Absent ⇒ the census measures nothing and `underResolved` stays 0, which is the same "nothing was measured"
   * state the `resolutionCensus` arm already publishes.
   */
  perDesignPx?: () => number;
}

/** The mutable twin of {@link FxSurface} — the registry writes these fields, callers only read them. */
interface SurfaceView {
  key: string;
  offsetX: number;
  offsetY: number;
  cssW: number;
  cssH: number;
  blend: BlendMode;
  pageW: number;
  pageH: number;
  stale: boolean;
}

interface Surface {
  id: string;
  view: SurfaceView;
  canvas: HTMLCanvasElement | null;
  info: FxRenderInfo | null;
  /**
   * gsw's name for the frame this surface's canvas holds, or null when the frame is not
   * content-addressed — see {@link FxRenderInfo.staticKey}. It is what decides which entry the surface
   * attaches to, and a change moves it (see `attachEntry`).
   */
  frameKey: string | null;
  /** The texture this surface DRAWS FROM — shared with its twins when they hold the same frame. */
  entry: Entry | null;
  /** Bumped by every `noteRendered` — the generation of pixels the runtime has drawn. */
  renderEpoch: number;
  /** The generation currently on the GPU. `-1` = nothing uploaded (or the upload was forgotten). */
  uploadedEpoch: number;
  /** Named by a build AND waiting on an upload. The ONLY thing `nextDeadline` reads. */
  dirty: boolean;
  /** Permanently refused (policy, size, or a driver rejection): never uploaded, never retried, never dirty. */
  declined: boolean;
  /** The build ordinal that last named this node. `-Infinity` until a build does. */
  lastNamedBuild: number;
  /** Upload rotation clock — the LRU key. `0` = never uploaded, which sorts first. */
  lastUploadSeq: number;
  /** WALL time of the last upload, ms. `0` = never uploaded, which the wakeup cap reads as "due now". */
  lastUploadAtMs: number;
}

/**
 * ONE GPU TEXTURE, and the surfaces drawing from it — see the header's sharing section.
 *
 * A private entry (`frameKey === null`) has exactly one holder for its whole life and behaves exactly like the
 * per-surface texture this replaced. A SHARED entry is the frozen-fleet case: N holders, one upload.
 *
 * THE CACHE REFERENCE IS THE ENTRY'S, NOT THE HOLDERS'. However many surfaces attach, this registry takes at most
 * ONE reference in the shared `CanvasTextureCache` (taken implicitly by the first `update`, given back by
 * `dropTexture`). Refcounting per holder would mean N `retain`s to balance, and the entry would have to model a
 * cache that had not been created yet — a class of bug with no upside, since the entry already knows exactly when
 * its last holder leaves.
 */
interface Entry {
  /** The full cache key — `fx://<nodeId>` for a private entry, `fx://k<n>` for a shared one. */
  key: string;
  /** The frame identity these pixels ARE, or null for a private per-node entry. */
  frameKey: string | null;
  /** The surfaces attached right now. A set, not a count, because a texture drop has to re-arm them all. */
  holders: Set<Surface>;
  /** Does the shared cache hold pixels under {@link Entry.key} right now? */
  uploaded: boolean;
  /** The backing-store size of those pixels — the quad's source rect. Meaningless while `uploaded` is false. */
  width: number;
  height: number;
  /** Resident bytes of those pixels, counted ONCE however many holders there are. */
  bytes: number;
  /** Permanently refused (over `maxTextureDim`, or a source the driver rejected) — see `decline`. */
  declined: boolean;
  /** The most recent build that named ANY holder; the age-out and the resident cap read it. */
  lastNamedBuild: number;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** A pacing cap: absent ⇒ the default, anything non-positive or non-finite ⇒ `0`, the documented OFF switch. */
function normalizeCap(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Resolve one CSS length against a containing extent. Handles the two forms gsw writes and nothing else: a
 * percentage (the shader runtime's UV window placement) and pixels (the particle runtime's travel margin, which
 * is NEGATIVE). A bare `0`, an empty string and anything unrecognised answer the fallback.
 */
function cssLength(value: string, basis: number, fallback: number): number {
  if (value === "") {
    return fallback;
  }
  if (value.endsWith("%")) {
    const pct = Number.parseFloat(value);
    return Number.isFinite(pct) ? (pct / 100) * basis : fallback;
  }
  const px = Number.parseFloat(value);
  return Number.isFinite(px) ? px : fallback;
}

/**
 * The quad box for a gsw-owned canvas, in the node's own coordinates.
 *
 * Exported for the spec, and because it is the one piece of this module that is pure algebra over two CSS strings
 * and a box. See the header for why the box cannot come from the node.
 */
export function resolveFxBox(
  canvas: { style: { left: string; top: string; width: string; height: string } },
  recW: number,
  recH: number
): { offsetX: number; offsetY: number; cssW: number; cssH: number } {
  const style = canvas.style;
  return {
    offsetX: cssLength(style.left, recW, 0),
    offsetY: cssLength(style.top, recH, 0),
    cssW: cssLength(style.width, recW, recW),
    cssH: cssLength(style.height, recH, recH)
  };
}

/**
 * The blend for a surface's quad.
 *
 * PRECEDENCE: what gsw told us (`info.blend`, the shader's own `render_mode`) beats what it wrote on the DOM,
 * which is the fallback for a runtime that passes no info — `blendToMixBlendMode` maps `add` to `plus-lighter`
 * and `mul` to `multiply` on the HOST ELEMENT (the canvas's grandparent: gsw mounts the canvas inside the node's
 * self-layer, and the blend has to be on the node to reach the content behind it). Everything else is MIX,
 * including Godot's `sub` and `premul_alpha`, which have no CSS spelling and so cannot arrive by the DOM route.
 *
 * PARTICLES ARE ALWAYS MIX and the emitter enforces that, not this function: an additive particle system resolves
 * its own accumulation buffer inside gsw and hands back a normal source-over image.
 */
function resolveBlend(canvas: HTMLCanvasElement, info: FxRenderInfo | null): BlendMode {
  const named = info?.blend;
  if (named === "add") {
    return BLEND_ADD;
  }
  if (named === "mul") {
    return BLEND_MUL;
  }
  if (named !== undefined) {
    return BLEND_MIX;
  }
  let el: HTMLElement | null = canvas;
  for (let depth = 0; depth < 3 && el; depth++) {
    const mode = el.style?.mixBlendMode ?? "";
    if (mode === "plus-lighter" || mode === "lighter") {
      return BLEND_ADD;
    }
    if (mode === "multiply") {
      return BLEND_MUL;
    }
    el = el.parentElement;
  }
  return BLEND_MIX;
}

export function createFxSurfaces(options: FxSurfaceOptions): FxSurfaceRegistry {
  const cache = options.cache;
  const surfaces = new Map<string, Surface>();
  /** Live textures by cache key — see {@link Entry}. One per node, or one per frozen frame when shared. */
  const entries = new Map<string, Entry>();
  /**
   * gsw frame key → the short token this registry names its texture by.
   *
   * A TOKEN RATHER THAN THE KEY ITSELF because gsw's keys are long (a shader's is its shader id, box, fit,
   * texture urls and dimensions, modulate, samplers, uv window, quantised time and every uniform value), and this
   * string becomes a draw-list handle carried on every quad and compared per batch. `k1`, `k2`, … costs one map
   * lookup at attach time and keeps the hot path comparing short strings.
   *
   * It only ever GROWS, which is deliberate and bounded in practice: a token is minted per DISTINCT frozen frame
   * the page has ever shown, so its population is the scene's distinct effect frames, not its nodes or its
   * builds. `card_ripple`'s churn re-uses `width`'s handful of values.
   */
  const tokens = new Map<string, string>();
  let nextToken = 0;
  const evictAfter =
    options.evictAfterBuilds !== undefined && Number.isFinite(options.evictAfterBuilds) && options.evictAfterBuilds > 0
      ? options.evictAfterBuilds
      : FX_EVICT_AFTER_BUILDS;
  // `0` is the documented OFF switch for both, so a caller that computed a cap of zero gets unpaced uploads rather
  // than a stage that refreshes one effect per frame forever.
  const paceBytes = normalizeCap(options.paceBytes, FX_PACE_BYTES_DEFAULT);
  const residentCap = normalizeCap(options.residentBytes, FX_RESIDENT_BYTES_DEFAULT);
  const paceCount = normalizeCap(options.paceCount, FX_PACE_COUNT_DEFAULT);
  const fps = normalizeCap(options.fps, FX_FPS_DEFAULT);
  /** One capped frame, ms. `0` when the cap is off. */
  const frameMs = fps > 0 ? 1000 / fps : 0;
  const maxTextureDim =
    options.maxTextureDim != null && Number.isFinite(options.maxTextureDim) && options.maxTextureDim > 0
      ? options.maxTextureDim
      : 0;
  const resolutionCensus = options.resolutionCensus === true;
  const perDesignPx = options.perDesignPx ?? (() => 0);

  let build = 0;
  let buildOpen = false;
  let disposed = false;
  let uploadSeq = 0;

  /** The surfaces this build is allowed to upload, chosen LRU-first at the build's first `acquire`. */
  const cleared = new Set<string>();
  /** …and the TEXTURE KEYS those admissions are paying for — the unit the caps are charged in (see `openBuild`). */
  const plannedKeys = new Set<string>();
  /** Reused across builds so the plan costs no allocation once the effect population settles. */
  const candidates: Surface[] = [];

  let buildUploadMs = 0;
  let residentCount = 0;
  let dirtyCount = 0;
  let residentBytes = 0;
  /**
   * A LOWER BOUND on `lastUploadAtMs` across the dirty set — what `nextDeadline` reads, and `0` while any dirty
   * surface has never uploaded.
   *
   * A bound rather than the exact minimum, because `noteRendered` runs once per surface per gsw frame (30/s per
   * surface on a busy screen) and an exact answer there would be an O(surfaces) scan on that cadence. Lowering it
   * is O(1); it is made exact again in `endBuild`, which already walks every surface. A STALE-LOW value can only
   * ever produce an EARLY wakeup, which the build then finds nothing to do on — the safe direction.
   */
  let dirtyMinUploadAt = Number.POSITIVE_INFINITY;

  const stats: FxSurfaceStats = {
    surfaces: 0,
    resident: 0,
    residentCap: 0, // assigned below, once `residentCap` is in scope
    evictedByCap: 0,
    bytes: 0,
    sharedEntries: 0,
    sharedAttaches: 0,
    dirty: 0,
    deferred: 0,
    declined: 0,
    uploads: 0,
    uploadMs: 0,
    maxUploadMs: 0,
    maxBuildUploadMs: 0,
    evicted: 0,
    released: 0,
    oversized: 0,
    paceBytes,
    paceCount,
    fps,
    underResolved: 0,
    resolutionCensus: false // assigned below, once `resolutionCensus` is in scope
  };
  stats.residentCap = residentCap;
  stats.resolutionCensus = resolutionCensus;
  /** Accumulated across the OPEN build; swapped into `stats.underResolved` when the build closes. */
  let underResolvedThisBuild = 0;

  function surfaceFor(nodeId: string): Surface {
    let surface = surfaces.get(nodeId);
    if (surface === undefined) {
      surface = {
        id: nodeId,
        view: {
          key: fxKeyForNode(nodeId),
          offsetX: 0,
          offsetY: 0,
          cssW: 0,
          cssH: 0,
          blend: BLEND_MIX,
          pageW: 0,
          pageH: 0,
          stale: false
        },
        canvas: null,
        info: null,
        frameKey: null,
        entry: null,
        renderEpoch: 0,
        uploadedEpoch: -1,
        dirty: false,
        declined: false,
        lastNamedBuild: Number.NEGATIVE_INFINITY,
        lastUploadSeq: 0,
        lastUploadAtMs: 0
      };
      surfaces.set(nodeId, surface);
    }
    return surface;
  }

  /** Does this surface have pixels to draw right now? Its ENTRY's question — a shared texture answers for all. */
  function hasPixels(surface: Surface): boolean {
    return surface.entry !== null && surface.entry.uploaded;
  }

  /**
   * The cache key this surface's pixels belong under: the frozen frame's token when gsw named one, else the
   * node's own key — which is the whole of the un-shared, pre-sharing behaviour.
   */
  function keyForSurface(surface: Surface): string {
    const frame = surface.frameKey;
    if (frame === null) {
      return fxKeyForNode(surface.id);
    }
    let token = tokens.get(frame);
    if (token === undefined) {
      token = `k${++nextToken}`;
      tokens.set(frame, token);
    }
    return FX_KEY_PREFIX + token;
  }

  /**
   * Point this surface at the entry for `key`, leaving whichever one it held.
   *
   * Called from `acquire`, i.e. inside a build, so a frame key that churned between builds moves the surface
   * before anything reads its texture. Returns the entry it is now attached to.
   */
  function attachEntry(surface: Surface, key: string): Entry {
    const current = surface.entry;
    if (current !== null && current.key === key) {
      return current;
    }
    if (current !== null) {
      detachEntry(surface);
    }
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = {
        key,
        frameKey: null,
        holders: new Set<Surface>(),
        uploaded: false,
        width: 0,
        height: 0,
        bytes: 0,
        declined: false,
        lastNamedBuild: Number.NEGATIVE_INFINITY
      };
      entries.set(key, entry);
    }
    entry.holders.add(surface);
    // INHERIT THE HOLDER'S CLOCK, and do it here rather than only in `acquire`: an entry is created DURING the
    // acquire that uploads into it, so at the moment `acquire` stamps the clock there is no entry yet to stamp.
    // Left at -Infinity, `endBuild`'s age-out would drop the texture on the very build that made it.
    if (surface.lastNamedBuild > entry.lastNamedBuild) {
      entry.lastNamedBuild = surface.lastNamedBuild;
    }
    surface.entry = entry;
    surface.view.key = key;
    // A surface that just moved to an entry holding OTHER pixels than the ones it last uploaded has to re-state
    // its own generation: `-1` re-arms `acquire`'s epoch check, so the move is followed by an upload (or, when
    // the entry already holds this exact frame, by the free attach in `upload`).
    surface.uploadedEpoch = -1;
    return entry;
  }

  /** Drop this surface's hold; the texture goes with the LAST holder (see {@link Entry}). */
  function detachEntry(surface: Surface): void {
    const entry = surface.entry;
    if (entry === null) {
      return;
    }
    entry.holders.delete(surface);
    surface.entry = null;
    if (entry.holders.size === 0) {
      dropTexture(entry);
      entries.delete(entry.key);
    }
  }

  function setDirty(surface: Surface): void {
    if (!surface.dirty) {
      surface.dirty = true;
      dirtyCount++;
    }
    if (surface.lastUploadAtMs < dirtyMinUploadAt) {
      dirtyMinUploadAt = surface.lastUploadAtMs;
    }
  }

  function clearDirty(surface: Surface): void {
    if (surface.dirty) {
      surface.dirty = false;
      dirtyCount--;
      if (dirtyCount === 0) {
        // Nothing is owed, so the bound has no members. `endBuild` would reach the same answer; doing it here is
        // what lets `nextDeadline` be exact on the case that matters most — the one where the stage can park.
        dirtyMinUploadAt = Number.POSITIVE_INFINITY;
      }
    }
  }

  /**
   * Did the build that just ran — or the one in progress — name this node? That is the whole of park guard 2: a
   * runtime frame for a surface nothing is drawing records its pixels and schedules NOTHING.
   */
  function namedRecently(surface: Surface): boolean {
    return surface.lastNamedBuild >= build - 1;
  }

  /**
   * This entry's pixels are gone: drop the byte accounting and RE-ARM every holder.
   *
   * The re-arm is what a per-node registry got for free. A shared texture's holders each carry their own
   * `uploadedEpoch`, and after an eviction none of them has pixels any more — so all of them have to go back to
   * "nothing uploaded" together, or a holder would keep answering `acquire` with a texture that is not there.
   */
  function forgetTexture(entry: Entry): void {
    if (!entry.uploaded) {
      return;
    }
    entry.uploaded = false;
    entry.frameKey = null;
    residentCount--;
    residentBytes -= entry.bytes;
    entry.bytes = 0;
    entry.width = 0;
    entry.height = 0;
    for (const holder of entry.holders) {
      holder.uploadedEpoch = -1;
    }
  }

  /** Give the shared cache back this entry's ONE reference (see {@link Entry}). A key it does not hold is a no-op. */
  function dropTexture(entry: Entry): void {
    if (entry.uploaded) {
      cache.release(entry.key);
    }
    forgetTexture(entry);
  }

  /**
   * Release resident fx textures, least-recently-drawn first, until the total is back under the ceiling.
   *
   * THE NAMED-RECENTLY EXEMPTION, and it reuses this registry's own definition rather than inventing a second
   * one: an entry `namedRecently` — drawn by the build that just ran OR the one in progress — is never evicted,
   * whatever the total. The one-build lag matters here in a way it does not for pages, because an fx surface is
   * uploaded from a runtime canvas that is still animating: evicting one the next build draws would re-upload it
   * immediately and spend the pace budget on a treadmill instead of on new pixels. If the live set alone exceeds
   * the ceiling then the CAP LOSES, and `stats.evictedByCap` climbing on a static-effects screen is how that
   * shows up.
   *
   * PER ENTRY, not per surface: the bytes are the entry's (a shared frame is ONE texture however many nodes draw
   * it), so evicting "a surface" would be an accounting fiction — and one holder of a shared frame going quiet is
   * not a reason to take the picture away from the six that are still on screen. An entry is exempt while ANY
   * holder is live, which is exactly what `Entry.lastNamedBuild` records.
   *
   * The surfaces themselves are untouched — only the GPU texture goes. Recovery is one `texImage2D` from a
   * runtime canvas that is still mounted and still drawing: no fetch, no decode.
   */
  function evictOverCap(): void {
    if (residentCap <= 0 || residentBytes <= residentCap) {
      return;
    }
    const stale: Entry[] = [];
    for (const entry of entries.values()) {
      if (entry.uploaded && entry.lastNamedBuild < build - 1) {
        stale.push(entry);
      }
    }
    if (stale.length === 0) {
      return;
    }
    stale.sort((a, b) => a.lastNamedBuild - b.lastNamedBuild);
    for (const entry of stale) {
      if (residentBytes <= residentCap) {
        return;
      }
      dropTexture(entry);
      stats.evictedByCap++;
    }
  }

  /**
   * This surface will never be uploaded again — policy, size, or a source the driver refused.
   *
   * It drops whatever its entry had uploaded, because a refused surface paints NOTHING (a frozen last frame of a
   * SCREEN_TEXTURE shader is exactly the confidently-wrong picture the policy exists to avoid), and because
   * `update` can throw AFTER the cache made the entry, which `release` then has to unmake.
   *
   * A refusal that came from the PIXELS (over `maxTextureDim`, a source the driver would not take) is marked on
   * the ENTRY as well, so the twins sharing that frame are refused on their next `acquire` instead of each
   * discovering the same rejection for themselves. A refusal that came from POLICY (`usesScreenTexture`) is a
   * property of the binding and stays on the surface — its frame is not necessarily anyone else's.
   */
  function decline(surface: Surface, pixels = false): void {
    clearDirty(surface);
    if (!surface.declined) {
      surface.declined = true;
      stats.declined++;
    }
    const entry = surface.entry;
    if (entry !== null) {
      if (pixels) {
        entry.declined = true;
      }
      detachEntry(surface);
    }
  }

  /** Bytes one upload of this surface costs — the BACKING STORE, which is what `texImage2D` moves. */
  function surfaceBytes(surface: Surface): number {
    const canvas = surface.canvas;
    return canvas === null ? 0 : canvas.width * canvas.height * 4;
  }

  /**
   * Is this surface's upload FREE — i.e. does the texture it is about to use already hold this exact frame?
   *
   * True only for a shared, content-addressed frame (see the header): the entry for the key exists, holds pixels,
   * and those pixels are named by the same gsw key this surface's canvas now holds. That is the twin case — the
   * second card of a hand, or the same card re-blitting its frozen frame — and it costs no `texImage2D` at all,
   * so the governor neither charges it nor lets a cap defer it.
   */
  function uploadIsFree(surface: Surface, key: string): boolean {
    const entry = entries.get(key);
    return (
      entry !== undefined && entry.uploaded && entry.frameKey !== null && entry.frameKey === surface.frameKey
    );
  }

  /**
   * Choose what this build may upload. Runs once, at the build's first `acquire`, because the dirty set is fixed
   * by then (it is written between builds, by `noteRendered`) and a plan made up front is what lets the rotation
   * be LRU-first even though `acquire` arrives in paint order.
   *
   * THE BUDGET IS SPENT PER TEXTURE, NOT PER SURFACE. Seven cards sharing one frozen frame are one `texImage2D`
   * and six free attaches, so charging seven would defer six surfaces that cost nothing — the caps exist to bound
   * main-thread upload time, and these do not spend any. `plannedKeys` is what makes the charge per key, and it
   * is also what the always-allow-one rule now counts: the first CHARGED upload of a build is unconditional.
   */
  function openBuild(): void {
    buildOpen = true;
    underResolvedThisBuild = 0;
    cleared.clear();
    plannedKeys.clear();
    candidates.length = 0;
    if (dirtyCount === 0) {
      return;
    }
    for (const surface of surfaces.values()) {
      if (surface.dirty && surface.canvas !== null) {
        candidates.push(surface);
      }
    }
    // Least-recently-uploaded first; never-uploaded (seq 0) sorts ahead of everything. The id tie-break only
    // matters for surfaces uploaded in the same build, and exists so a plan is reproducible.
    candidates.sort((a, b) => (a.lastUploadSeq - b.lastUploadSeq) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let planned = 0;
    for (const surface of candidates) {
      const key = keyForSurface(surface);
      // FREE, and admitted whatever the budget says: no upload will happen for it (see `uploadIsFree`).
      if (uploadIsFree(surface, key)) {
        cleared.add(surface.id);
        continue;
      }
      // …and the SECOND holder of a key this build is already paying for. The first one uploads the pixels; this
      // one attaches to them, which is the same free path one build later.
      if (plannedKeys.has(key)) {
        cleared.add(surface.id);
        continue;
      }
      const bytes = surfaceBytes(surface);
      // ALWAYS-ALLOW-ONE wins over BOTH caps: `plannedKeys.size > 0` is the whole of that rule, so the first
      // charged candidate of a build is never asked. After it, either cap can end the plan.
      if (plannedKeys.size > 0) {
        if (paceBytes > 0 && planned + bytes > paceBytes) {
          // STOP, do not skip-and-continue: letting a smaller surface jump the queue would starve the big one that
          // has been waiting longest, which is the exact failure LRU-first is here to avoid.
          break;
        }
        if (paceCount > 0 && plannedKeys.size >= paceCount) {
          break;
        }
      }
      cleared.add(surface.id);
      plannedKeys.add(key);
      planned += bytes;
    }
    candidates.length = 0;
  }

  /**
   * Is this surface's backing store smaller than the device pixels it covers? See
   * {@link FxSurfaceStats.underResolved}.
   *
   * WIDTH ONLY, on purpose. gsw sizes a surface's store from its box with ONE factor, so height carries no
   * information width does not.
   *
   * COMPUTED, NOT MEASURED — and the correction that made this counter mean what it says. It used to read
   * `canvas.getBoundingClientRect().width`, which is the AXIS-ALIGNED BOUNDING BOX of the transformed quad:
   * for a ROTATED surface that is `|cos θ| + |sin θ|` wider than the surface, with not one extra device pixel
   * underneath it. Measured on the live combat page — three sibling 220x220 particle surfaces at scale 1,
   * rotated 15°, 45° and 0°, all three correctly backed at 147x147 — the AABB reported them as needing
   * 1.2247x, 1.4142x and 1.0000x, so the census called two of them under-resolved and the identical third
   * fine. Rotation is rigid: it moves a surface's texels, it does not give the screen more room for them.
   *
   * So the device width is derived from the same three numbers the quad is DRAWN from: the surface's own
   * design-space width, the mean-axis scale of the placement affine that carries it (rotation-invariant by
   * construction — see `./fxPixelRatio`), and the stage's design-to-device factor. No layout read at all,
   * which also retires the forced `getBoundingClientRect()` this function used to pay per named surface per
   * build; `resolutionCensus`'s "arm it only where someone is looking" default now costs nothing either way.
   *
   * A surface with no scale, no box, or no reported design-to-device factor is SKIPPED rather than counted:
   * a quad that measures zero is not being drawn small, it is not being drawn. "Visible fx surfaces" is that
   * clause, and it is what keeps a jsdom that lays nothing out from reporting a screen full of findings.
   */
  function noteResolution(canvas: HTMLCanvasElement, cssW: number, axisScale: number): void {
    if (!resolutionCensus) {
      return;
    }
    const width = canvas.width;
    if (!(width > 0) || !(cssW > 0) || !(axisScale > 0)) {
      return;
    }
    const perDevice = perDesignPx();
    if (!(perDevice > 0)) {
      return;
    }
    const wanted = cssW * axisScale * perDevice;
    if (width < wanted * (1 - FX_UNDER_RESOLVED_SLACK)) {
      underResolvedThisBuild++;
    }
  }

  /** This surface's pixels are now on the GPU (uploaded, or attached to a twin's upload): bank the clocks. */
  function noteUploaded(surface: Surface, atMs: number): void {
    surface.uploadedEpoch = surface.renderEpoch;
    surface.lastUploadSeq = ++uploadSeq;
    surface.lastUploadAtMs = atMs;
    clearDirty(surface);
  }

  function upload(surface: Surface): void {
    const canvas = surface.canvas;
    if (canvas === null) {
      clearDirty(surface);
      return;
    }
    // THE ATTACH HAPPENS HERE, not when the frame key changed. Until a surface's new frame is actually paid for,
    // it keeps drawing from the entry it already holds — which is the "a deferred surface keeps its last pixels"
    // rule the header states, applied to a re-key as well as to a deferral.
    const entry = attachEntry(surface, keyForSurface(surface));
    if (entry.declined) {
      // A twin already proved these pixels cannot be uploaded (over the dimension cap, or refused by the driver).
      // Re-discovering that per holder is exactly the per-build retry the refusal exists to stop.
      decline(surface);
      return;
    }
    const width = canvas.width;
    const height = canvas.height;
    if (!(width > 0 && height > 0)) {
      // No backing store to upload. gsw only reports a real paint, so this is a runtime mid-resize; clearing the
      // bit keeps the pump terminating (guard 3) and the next reported frame re-arms it.
      clearDirty(surface);
      return;
    }
    // THE FREE ATTACH — the whole point of the sharing (see the header). The entry already holds the frame this
    // canvas is showing, so there is nothing to move to the GPU: this surface simply starts drawing from pixels a
    // twin (or an earlier build of this same node) already put there.
    if (entry.uploaded && entry.frameKey !== null && entry.frameKey === surface.frameKey) {
      noteUploaded(surface, nowMs());
      stats.sharedAttaches++;
      return;
    }
    if (maxTextureDim > 0 && (width > maxTextureDim || height > maxTextureDim)) {
      stats.oversized++;
      decline(surface, true);
      return;
    }
    const bytes = width * height * 4;
    try {
      const t0 = nowMs();
      cache.update(entry.key, canvas);
      const ms = nowMs() - t0;
      if (!entry.uploaded) {
        entry.uploaded = true;
        residentCount++;
      }
      residentBytes += bytes - entry.bytes;
      entry.bytes = bytes;
      entry.width = width;
      entry.height = height;
      // What the entry now HOLDS. Null for an un-shared surface, which is what keeps the free path above off
      // every frame that is not content-addressed.
      entry.frameKey = surface.frameKey;
      noteUploaded(surface, t0 + ms);
      buildUploadMs += ms;
      stats.uploads++;
      stats.uploadMs += ms;
      if (ms > stats.maxUploadMs) {
        stats.maxUploadMs = ms;
      }
    } catch {
      // A tainted or otherwise unuploadable source. Retrying it every build would spend the budget on it forever.
      //
      // The cache makes its entry BEFORE it uploads, so a throwing `update` leaves one behind — and `dropTexture`
      // cannot give that one back, because from this registry's side the entry never became `uploaded`. Release it
      // here, and only in that case: an entry that already HELD pixels is released by the decline below, and
      // handing the same key back twice would decrement a refcount this registry does not hold.
      if (!entry.uploaded) {
        cache.release(entry.key);
      }
      decline(surface, true);
    }
  }

  return {
    noteRendered(nodeId, canvas, info) {
      if (disposed) {
        return;
      }
      const surface = surfaceFor(nodeId);
      surface.canvas = canvas;
      if (info !== undefined) {
        surface.info = info;
      }
      if (surface.declined) {
        return;
      }
      if (surface.info?.usesScreenTexture === true) {
        decline(surface);
        return;
      }
      // WHICH FRAME these pixels are, as gsw names it (null when the frame is not content-addressed) — the one
      // input the sharing decision reads. Taken from the info of THIS paint, so a re-key moves the surface to
      // another texture on its next upload rather than overwriting the frame its twins are still showing.
      surface.frameKey = surface.info?.staticKey ?? null;
      surface.renderEpoch++;
      if (!namedRecently(surface)) {
        // PARK GUARD 2: the pixels are recorded, nothing is scheduled. `acquire` re-arms the bit if a later build
        // names this node again.
        return;
      }
      setDirty(surface);
      options.onDirty?.();
    },

    acquire(nodeId, recW, recH, axisScale = 1) {
      if (disposed) {
        return null;
      }
      if (!buildOpen) {
        openBuild();
      }
      const surface = surfaceFor(nodeId);
      surface.lastNamedBuild = build;
      if (surface.entry !== null) {
        // The texture is exempt from the age-out and the resident cap while ANY of its holders is being drawn.
        surface.entry.lastNamedBuild = build;
      }
      const canvas = surface.canvas;
      if (canvas === null || surface.declined) {
        return null;
      }
      if (surface.renderEpoch !== surface.uploadedEpoch) {
        // Re-arm: either this is the first build to name the node since its pixels arrived, or park guard 1 (or an
        // eviction) dropped the bit while nothing was drawing it. Either way the plan for THIS build is already
        // made, so the upload lands next build.
        setDirty(surface);
      }
      if (surface.dirty) {
        if (cleared.has(nodeId)) {
          upload(surface);
        } else {
          stats.deferred++;
        }
      }
      const view = surface.view;
      const box = resolveFxBox(canvas, recW, recH);
      noteResolution(canvas, box.cssW, axisScale);
      view.offsetX = box.offsetX;
      view.offsetY = box.offsetY;
      view.cssW = box.cssW;
      view.cssH = box.cssH;
      view.blend = resolveBlend(canvas, surface.info);
      // The SOURCE rect, off the entry the key names — never off the live canvas, which may have been resized
      // since the upload this quad is about to sample.
      view.pageW = surface.entry?.width ?? 0;
      view.pageH = surface.entry?.height ?? 0;
      view.stale = surface.renderEpoch !== surface.uploadedEpoch;
      // Nothing has ever been uploaded for this node: there are no last pixels to keep painting, so the build
      // emits no quad at all rather than a transparent one. `view.key` is the ENTRY's — for a shared frame that
      // is the same string every twin hands the sink, which is also what batches them into one texture bind.
      return hasPixels(surface) ? view : null;
    },

    handleFor(token) {
      const entry = entries.get(FX_KEY_PREFIX + token);
      if (entry === undefined || !entry.uploaded) {
        return null;
      }
      return cache.peek(entry.key) ?? null;
    },

    sizeOf(token) {
      const entry = entries.get(FX_KEY_PREFIX + token);
      if (entry === undefined || !entry.uploaded) {
        return null;
      }
      const live = cache.peek(entry.key);
      return live ? { width: live.width, height: live.height } : null;
    },

    declined(nodeId) {
      return surfaces.get(nodeId)?.declined === true;
    },

    endBuild() {
      if (buildUploadMs > stats.maxBuildUploadMs) {
        stats.maxBuildUploadMs = buildUploadMs;
      }
      buildUploadMs = 0;
      // PUBLISHED AT THE CLOSE, not accumulated: `underResolved` describes the build that just finished, so a
      // census always reads a whole build's answer and never a half-walked one.
      stats.underResolved = underResolvedThisBuild;
      underResolvedThisBuild = 0;
      cleared.clear();
      plannedKeys.clear();
      buildOpen = false;
      const spent = build;
      build++;
      // …and make the wakeup bound EXACT again. This walk was already happening, so the cap costs no extra pass.
      let minUploadAt = Number.POSITIVE_INFINITY;
      for (const surface of surfaces.values()) {
        if (surface.dirty && surface.lastNamedBuild !== spent) {
          // PARK GUARD 1: nothing drew this surface, so its new pixels are not owed a frame. The bit comes back
          // from `acquire`'s epoch check the moment a build names it again.
          clearDirty(surface);
        }
        if (surface.dirty && surface.lastUploadAtMs < minUploadAt) {
          minUploadAt = surface.lastUploadAtMs;
        }
      }
      // THE AGE-OUT IS THE TEXTURE'S, and a shared one survives while any holder is still being drawn: the
      // entry's `lastNamedBuild` is the max over its holders, so this releases exactly the pixels no node on
      // screen is using. The entry record itself stays as long as it has holders — only the GPU bytes go, and
      // one `texImage2D` from a still-mounted canvas brings them back.
      for (const entry of entries.values()) {
        if (entry.uploaded && build - entry.lastNamedBuild >= evictAfter) {
          dropTexture(entry);
          stats.evicted++;
        }
      }
      dirtyMinUploadAt = minUploadAt;
      // THE RESIDENT CEILING, after the age-out because a surface the clock was already going to release should
      // not be charged to the cap — the two counters have to keep meaning different things.
      evictOverCap();
    },

    nextDeadline(now) {
      // Guard 1 keeps this set to surfaces a build actually named, which is what makes Infinity reachable.
      if (dirtyCount === 0) {
        return Number.POSITIVE_INFINITY;
      }
      if (frameMs <= 0) {
        return now;
      }
      if (dirtyMinUploadAt <= 0) {
        return now; // a surface with no pixels on the GPU yet is not something to be late with
      }
      const at = dirtyMinUploadAt + frameMs;
      return at > now ? at : now;
    },

    release(nodeId) {
      const surface = surfaces.get(nodeId);
      if (surface === undefined) {
        return;
      }
      clearDirty(surface);
      if (hasPixels(surface)) {
        stats.released++;
      }
      // The TEXTURE only goes if this was its last holder — the node leaving is not a reason to take the frame
      // away from the twins still drawing it.
      detachEntry(surface);
      surfaces.delete(nodeId);
    },

    invalidate(nodeId) {
      if (nodeId !== undefined) {
        const surface = surfaces.get(nodeId);
        if (surface === undefined) {
          return;
        }
        // The texture stays resident and keeps painting; only its generation is disowned, so the next build that
        // names the node re-uploads over the SAME cache entry (`update` keeps the refcount).
        surface.uploadedEpoch = -1;
        // …and the ENTRY forgets which frame it is holding, so the re-upload is a REAL one. Without this the free
        // attach would recognise the frame key, skip the `texImage2D` and leave exactly the pixels the caller
        // just said are no longer trustworthy. A shared entry re-uploads once for the whole fleet.
        if (surface.entry !== null) {
          surface.entry.frameKey = null;
        }
        if (namedRecently(surface) && surface.canvas !== null && !surface.declined) {
          setDirty(surface);
        }
        return;
      }
      // CONTEXT LOSS. gsw's own `cache.reset()` has already forgotten every texture, so this must not call
      // `release` — it would decrement a refcount on an entry that is gone, and touch a dead driver. Surfaces the
      // scene is still drawing are marked dirty HERE rather than being left to `acquire`'s epoch check, so the
      // restore's first build re-uploads them instead of painting one frame with nothing in it.
      for (const entry of entries.values()) {
        forgetTexture(entry);
      }
      for (const surface of surfaces.values()) {
        if (namedRecently(surface) && surface.canvas !== null && !surface.declined) {
          setDirty(surface);
        }
      }
      residentCount = 0;
      residentBytes = 0;
    },

    stats() {
      stats.surfaces = surfaces.size;
      stats.resident = residentCount;
      stats.bytes = residentBytes;
      stats.dirty = dirtyCount;
      let shared = 0;
      for (const entry of entries.values()) {
        if (entry.holders.size > 1) {
          shared++;
        }
      }
      stats.sharedEntries = shared;
      return { ...stats };
    },

    dispose() {
      // Deliberately no `cache.release`: the stage owns the cache and disposes it, and after a context loss the
      // driver is gone — the bridge's `dispose` takes the same line.
      disposed = true;
      surfaces.clear();
      entries.clear();
      tokens.clear();
      cleared.clear();
      plannedKeys.clear();
      candidates.length = 0;
      residentCount = 0;
      residentBytes = 0;
      dirtyCount = 0;
      dirtyMinUploadAt = Number.POSITIVE_INFINITY;
    }
  };
}
