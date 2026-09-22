// THE DOM OVERLAY ABOVE THE SINGLE-CANVAS STAGE.
//
// Five node kinds cannot become quads in a flat draw list, and `paintSpec.overlayKindOf` names them: TEXT (a font
// raster is the browser's job and re-implementing shaping is not this wave's business), WebGL SHADER surfaces and
// PARTICLE systems (both are gsw runtimes with their own contexts, driven by attributes on a DOM node), SPINE
// clips (server-baked frames blitted per node) and card TRAILS. `buildDrawList` hands each one out as an
// `OverlayRecord`; this module reconciles those records into absolutely-positioned elements above the canvas.
//
// WHAT IT IS NOT: a general depth-sorted overlay. Every element here paints ABOVE the whole canvas, so a quad that
// should sit over a label does not. That divergence is MEASURED, not assumed — probe P6
// (docs/agents/canvas-stage-probes-aug26.md) counted, per recording, the visible painting nodes later in paint
// order whose AABB covers a text node: 7% on the map, 32-46% on combat/shop/reward, and 70-73% on DECK VIEW and
// RESHUFFLE, where it is concentrated almost entirely on cards (`NCardHighlight`'s glow and the card's own
// `ui_atlas_0` plates painting over the card's text). The records ARE mutually depth-sorted (see `syncOrder`), so
// two overlay nodes still layer correctly against each other; only overlay-vs-canvas is wrong. The fix — effects
// rendered INSIDE the stage canvas, in paint order, instead of on a DOM layer above it — is M2/M3's, and P6 is
// its brief.
//
// THE HOIST RULE. M2 paints shader and particle surfaces in the draw list, so this rule is inert for those two
// kinds. `coveredAbove` remains load-bearing for a surface whose pixels have not arrived: it is hidden rather
// than shown until its current paint is available.
//
// With effects ON, "paints above the whole canvas" is not a subtlety. A
// combat scene's background carries ~23 WebGL VFX surfaces at paint-order ranks 11-73 out of 3,676, one of them a
// 2765x1296 water reflection. Hoisted above the canvas they paint over the ENTIRE game — the screenshot is a
// full-screen ripple pattern with the UI's text floating on it, and the three `card_ripple` glows behind the hand
// (paint ranks 755-829, `render_mode blend_add` ⇒ gsw sets `mix-blend-mode: plus-lighter` on the host) add their
// cyan over every card, which is the bug this module was fixed for. Additive-over-content-BELOW is Godot-correct;
// content-ABOVE is the divergence.
//
// So: a `shader` or `particles` surface is hoisted ONLY when nothing the canvas paints later in paint order
// overlaps it (`OverlayRecord.coveredAbove`, measured by `buildDrawList`'s cover pass). When something does, the
// surface is WITHHELD — no element, so gsw never binds a runtime to it and it costs nothing — and the node
// renders exactly as it does under `?shaders=off`: nothing at all. That is not a coincidence and it is why the
// rule is safe to apply at this layer rather than in the classifier: every WebGL host is by construction a shader
// INPUT node (`shaderAttributes.isShaderInputNode` IS `isWebglEligible`), so `paintSpec.paintsTexture` already
// refuses to paint its raw SDF texture either way. A withheld surface loses the EFFECT and nothing else, which is
// precisely the state every M1 parity baseline was measured in.
//
// The rule covers the two gsw RUNTIME kinds only. `text` and `spine` keep the unconditional hoist: text is a DOM
// overlay on BOTH backends (so withholding it would blank labels the DOM stage draws) and a spine clip streams no
// `localRect`, so its record box is a 0x0 anchor the cover pass has no opinion about. Their gap is the P6 one
// above, unchanged by this rule.
//
// The container is deliberately NOT a stacking context (`isolation: isolate` was considered and rejected):
// isolating it would make a legitimately-hoisted additive host blend against an empty group instead of the canvas
// beneath it, turning the one case this backend gets RIGHT — additive over content below — into a flat sheet.
//
// RESIDUAL WHEN THE RULE IS IN CHARGE, named: a withheld effect is a missing effect, and that arm trades a
// missing glow for a visible game. M2 (below) is the fix, and it is the default.
//
// ---------------------------------------------------------------------------------------------------------------
// M2, THE DEFAULT — WHAT HAPPENS WHEN THE DRAW LIST PAINTS THE EFFECTS ITSELF.
//
// `reconcile` takes an `OverlayFxSource`, and its PRESENCE is the flag. With one, `buildDrawList` has already
// emitted a quad for each shader/particle surface at that node's own paint index (`fxSurfaces` +
// `paintSpec.emitFxQuad`), so this module's job for those two kinds inverts:
//
//   * THE HOIST RULE GOES INERT for every surface the list actually PAINTED. `coveredAbove` answers "would
//     hoisting this hide game content?", and a surface in the draw list is not hoisted. `counts.withheld` keeps
//     its meaning exactly — how many surfaces the hoist rule is hiding — so the before/after is a real comparison
//     rather than a redefinition, and what it counts under the flag is THE RESIDUE: a covered surface whose
//     pixels have not arrived.
//
//     THAT RESIDUE IS NOT ZERO, AND SAYING SO IS THE POINT (measured Aug 27, real GPU). It falls — live combat
//     room 24 -> 22 at settle, deck view 18 -> 12 — and the remainder is surfaces that produce NO FRAMES ON
//     EITHER BACKEND: a `card_ripple` at `width: 0`, which cc itself stamps `data-godot-shader-dormant` and gsw
//     therefore parks, and the `wind_sway` foliage family, for which gsw mounts no canvas at all (verified on
//     the DOM stage too — same 12 hosts, same absent canvases). A surface with no pixels anywhere cannot be a
//     missing effect. So the honest acceptance number is not "withheld == 0"; it is that the flag NEVER hides
//     something the flag-off arm shows, which is what the `hideHost` rule below guarantees case by case.
//   * THE HOST STOPS COMPOSITING: `visibility: hidden` on the element (never the container, never the canvas's own
//     `display`, which gsw owns). The element itself ALWAYS STAYS — it is what gsw discovers, binds and renders
//     into. Withholding it the old way would DEADLOCK the fix: no element, no render, no pixels, no quad, so the
//     surface could never stop being withheld. See `syncHostStyle` for why `visibility` and not `display`.
//   * A REFUSED SURFACE LOSES ITS ELEMENT. The registry permanently declines a SCREEN_TEXTURE reader (its capture
//     is a DOM composite, which on this stage contains no game), an over-MAX_TEXTURE_SIZE source, and a source the
//     driver rejects. Those will never become quads, so keeping their hosts would leave gsw compositing them over
//     the whole stage — the original bug, reintroduced by its own fix. They are dropped like a withholding and
//     counted separately (`fxDeclined`), because a policy refusal is a different fact from a hoist withholding.
//
// `text`, `spine` and `trail` are untouched by all of it: they have no gsw surface to upload.
//
// PLACEMENT. `OverlayRecord.transform` is the node's PLACEMENT affine (its rendered global composed with its box
// origin), which is exactly what the DOM backend writes as `matrix(...)` with `transform-origin: 0 0`. So the
// element's geometry is that matrix verbatim plus a `w x h` box — nothing here re-derives a placement, and a
// cosmetic offset or a tween sample reaches the overlay because it already reached `transform`.
//
// PAINT STATE. Geometry is not all a surface needs. The DOM backend nests a node's element inside its parent's, so
// `modulate.a` reaches a shader/text/spine surface through the CSS opacity cascade and the composed tint through
// an inherited `filter` (`nodeStyles.splitSelfStyle`); an overlay element is a FLAT child of one container and
// inherits neither. `OverlayRecord` therefore carries the walk's own composed `opacity` / `tintR,G,B` and
// `syncHostStyle` writes them, which is what stops a glow the game shows at fraction alpha from painting at 1.0.
// The one deliberate omission is `mergedNodeStyle`'s: a WebGL host gets NO `filter` at all, because gsw feeds the
// node's modulate into the shader itself through `data-godot-shader-modulate`.
//
// THE gsw CONTRACT. The shader and particle runtimes MirrorView already owns scan the stage element for
// `[data-godot-shader-webgl]` / `[data-godot-particle-runtime]` and mount their canvases into a child carrying
// gsw's own `SELF_LAYER_CLASS`. This overlay lives inside that same stage and stamps the SAME attributes the DOM
// backend stamps (through the same `nodeShaderAttributes` / `nodeParticleAttributes` builders), so the runtimes
// discover these elements without knowing which backend built them. `effectsDirty` reports whether anything a
// runtime could see actually moved, which is what `consumeEffectsDirty` answers with.

import { SELF_LAYER_CLASS } from "@godot-scene-web/html";
import { ensureRichTextEffectStyles } from "@spirectl/presentation/render";

import { affineCss, type Affine } from "@/mirror/affine";
import { ensureNodeFonts } from "@/mirror/fonts";
import {
  createGeoclipNode,
  geoclipFrameIndexAt,
  geoclipPlacementFromManifest,
  noteGeoclipFailure,
  probeGeoclip,
  uploadGeoclip,
  type GeoclipClip,
  type GeoclipNode,
  type GeoclipPlacement,
  type GpuClip
} from "@/mirror/geoclipPlayer";
import {
  CREATURE_PLACEHOLDER_CLASS,
  CREATURE_PLACEHOLDER_DELAY_MS,
  CREATURE_PLACEHOLDER_RES,
  creatureArtIsUnavailable,
  creaturePlaceholderBox,
  creaturePlaceholderKey,
  isCreaturePlaceholderNode
} from "@/mirror/creaturePlaceholder";
import { richHtml, textStyle } from "@/mirror/nodeStyles";
import { nodeParticleAttributes } from "@/mirror/particleAttributes";
import { mirrorResourceUrl, type MirrorNode } from "@/mirror/sceneTree";
import { nodeShaderAttributes, type MirrorShaderBinding } from "@/mirror/shaderAttributes";
import {
  geoclipUrl,
  isGeoclipPlaybackEnabled,
  isSpineClipNode,
  isSpineStillMode,
  spineClipUrl
} from "@/mirror/spineAttributes";
import {
  frameIndexAt,
  imageMime,
  loadSpineClip,
  msToNextSpineFrame,
  type DecodedSpineClipFrame,
  type LoadedSpineClip
} from "@/mirror/spineClip";
import { decodeStill } from "@/mirror/stillDecode";
import { resolveTextScaleClasses } from "@/mirror/textScaleClasses";

import {
  createFxPixelRatioGate,
  FX_PIXEL_RATIO_ATTR,
  fxAxisScale,
  type FxPixelRatioGate,
  fxPixelRatioAttrValue,
  fxPixelRatioWrite
} from "@/mirror/canvas/fxPixelRatio";
import type { OverlayClip, OverlayRecord } from "@/mirror/canvas/paintSpec";
import { resolveSceneInfo } from "@/mirror/canvas/hitTest";

/** The class on the overlay's container — one element, so a stylesheet or a probe can find it by name. */
export const OVERLAY_CONTAINER_CLASS = "mirror-canvas-overlay";

/**
 * The class on each overlay element. DELIBERATELY NOT `.mirror-node`.
 *
 * Reusing the DOM backend's class would have been free geometry (its unscoped rule is exactly the absolutely
 * positioned, top-left-origin box these elements want), and it was wrong: `.mirror-node` is the repo's universal
 * "the DOM backend built this" marker. The bench harness's readiness gate counts it, the census reports it, the
 * dormancy/ancestry scans classify by it — so a canvas stage wearing it reads as a DOM stage to every probe we
 * own, including the one that decides a bench run is ready to measure. The geometry is written inline instead,
 * which is four properties per element at create time and no shared statement to keep in sync.
 */
export const OVERLAY_NODE_CLASS = "mirror-overlay-node";

/** Shared empty answer for `childrenOfLazy`, so a childless lookup allocates nothing. */
const EMPTY_CHILD_IDS: readonly string[] = [];

export interface OverlayCounts {
  text: number;
  shader: number;
  particles: number;
  spine: number;
  trail: number;
  /** Elements alive in the container right now (all kinds), and the effect canvases hanging off them. */
  elements: number;
  /**
   * Records the HOIST RULE withheld this build (counted in their kind too) — see the module header.
   *
   * It keeps exactly this meaning under M2: how many surfaces the hoist rule is hiding. By default the rule is
   * inert for the two gsw runtime kinds (their pixels are in the draw list now), so this FALLS to the residue —
   * covered surfaces that have no pixels because gsw draws none for them on either backend. See the module
   * header for why the residue is not zero and why that is correct rather than a shortfall.
   *
   * Read it against `overlayWithheldPeak` in `__mirrorCanvasStats`, never alone: a settled screen has no live
   * effects on EITHER arm, so a post-settle reading of this cannot tell a working M2 from a dead one.
   *
   * Policy REFUSALS by the fx registry are a different fact and are never folded in here — they live in
   * `fx.declined`, and {@link OverlayCounts.fxDeclined} is their overlay-side twin.
   */
  withheld: number;
  /** Hosts whose gsw canvas is `visibility: hidden` because a draw-list quad paints that surface instead. */
  fxHidden: number;
  /** Records dropped this build because the fx registry REFUSED the surface. Never folded into `withheld`. */
  fxDeclined: number;
  /**
   * TEXT records still riding the overlay because the draw list did NOT paint them (M4) — the honest residue.
   *
   * Counted in `text` too, like `withheld` is counted in its kind. It is 0 with the lever off (nothing is drawn,
   * so nothing is hoisted "still"), and under the lever it is the labels the canvas refused: a rich one, a
   * `text-wrap: balance` reward row, a raster the pacer held back, a face that has not loaded yet. Each of those
   * renders exactly as it does today, which is why this is a census row rather than a failure — and it is the
   * number that says how much of a screen's text M4 actually owns.
   */
  textHoisted: number;
  /**
   * R1 — records this build CROPPED to their enclosing clip chain, i.e. the ones carrying an `OverlayClip`.
   *
   * 0 when no overlay surface needs clipping and for a screen whose overlay surfaces all sit inside their containers (the
   * builder answers null for a record its chain already contains), so a non-zero reading is the fix doing work
   * rather than the fix being wired.
   */
  clipped: number;
  /** …of which the intersection was EMPTY — scrolled entirely out of view, rendered as a fully-clipped element. */
  clipEmpty: number;
  /** …and of which the record's matrix carried a rotation/skew, so the crop is a `polygon()` and not an `inset()`. */
  clipPolygon: number;
  /**
   * R2 — records this build withheld because the draw list painted a stage-spanning opaque fill OVER them.
   *
   * NEVER folded into {@link OverlayCounts.withheld}, which is the HOIST RULE's number and must stay a
   * before/after comparison rather than a redefinition. 0 unless a caller passes a backstop order (the lever is
   * off by default), and 0 on any screen the game has not covered — which is every plain combat frame.
   */
  backstopWithheld: number;
  /**
   * THE RESIDUAL, NAMED — records that are still COMPOSITING above the whole canvas while the game paints
   * something over them. This is the P6 divergence as a live number rather than a probe's historical table.
   *
   * The population is exactly "hoisted AND `coveredAbove`, and not hidden by any of the rules above". Every other
   * kind is structurally excluded from it, which is why only two of the five get a row:
   *
   *   * `shader` / `particles` — the hoist rule and its M2 successor BOTH hide a covered surface, so a covered fx
   *     host never composites. Its number is `withheld` (flag off) or `fxHidden` (flag on).
   *   * `trail` — has no element on this backend at all; its ribbon is quads at the stroke's own paint index.
   *   * `text` / `spine` — the two that CAN reach the container covered and visible, and therefore the two the
   *     report is about. A covered label or creature here is being drawn in the wrong layer right now.
   *
   * WHAT MAKES IT FALL. A label drawn in the canvas has no element and is not counted here; the same applies to
   * an in-canvas spine still the cover pass selected. On a page with both present, what is LEFT is the
   * genuine refusal residue — a rich construct the raster declines, a multi-frame creature, an over-cap still.
   * That residue is the thing this row exists to keep visible instead of letting it read as zero.
   *
   * NOT folded into `textHoisted`, which counts every hoisted label whether or not anything covers it. A hoisted
   * label with nothing on top of it is drawn CORRECTLY; only these are wrong.
   */
  coveredText: number;
  coveredSpine: number;
}

export interface OverlayReconcileResult {
  /** Did anything a gsw runtime could SEE change? Feeds `consumeEffectsDirty`. */
  shaderDirty: boolean;
  particleDirty: boolean;
  counts: OverlayCounts;
}

/**
 * What the overlay needs to know about the fx registry — PRESENCE IS THE FLAG.
 *
 * Passing one is the DEFAULT: the draw list is painting the shader/particle surfaces itself, so the hoist
 * rule has nothing left to decide and the hosts must stop compositing. Omitting it (every caller before M2, and
 * every caller with the flag off) leaves this module byte-identical.
 */
export interface OverlayFxSource {
  declined(nodeId: string): boolean;
  /** Did THIS build put a quad for the node in the draw list? `DrawListBuild.fxQuadIds`. */
  drawn(nodeId: string): boolean;
}

export interface MirrorOverlayOptions {
  /**
   * A spine node's PIXELS have landed — a still's decode finished and was committed, or a clip's first frame was
   * blitted. Never called for a load that resolved into a stale generation.
   *
   * Two things need it, and neither can be reached from inside a reconcile. A clip arrives ASYNCHRONOUSLY, long
   * after the build that asked for it, so a multi-frame one joins the playing set with nothing scheduled to tick
   * it — before this it did not start animating until the next wire delta happened along. And the stage's own
   * paint has to be able to notice a spine surface that only just became paintable.
   */
  onSpineReady?: (nodeId: string) => void;
}

/**
 * A spine node's still, described so the draw list can paint it as a QUAD instead of hoisting the `<img>` (M3, A2).
 *
 * Node-LOCAL, and deliberately so: the record's own placement matrix is the node's, and the clip's rect is
 * expressed inside it, so a caller composes `record.transform · translate(tx,ty) · scale(scale)` and gets exactly
 * the geometry `mountStill` writes on the element. Nothing here re-derives a placement.
 *
 * `source` is the overlay's OWN decoded `<img>` — the one A1's decode gate committed. That is the whole reason
 * `spineClip`'s bytes-only still path can stay on: the quad reuses pixels the browser already has, rather than
 * re-decoding a 4-16 MB frame the client deliberately never decoded.
 *
 * `bytes` is there because "the browser already has them" turned out to be true only for a WHILE. A decoded
 * `<img>` frame is a CACHE, and a phone under memory pressure drops it — after which `texImage2D(img)` re-decodes
 * a 4-16 MB WebP INSIDE the build, which is what a Moto G86 combat trace measured as 58.2/26.9/26.9/22.4/20.9 ms
 * frame tasks. The same eviction is what the card atlases hit, and the same answer applies: upload pixels we OWN.
 * So the quad also carries a thunk back to the clip's ENCODED bytes (~50-300 KB, retained either way), which
 * `spineSurfaces` may turn into an `ImageBitmap` off the frame path and close the moment it has been uploaded.
 * A thunk rather than a Blob so that a screen full of creatures allocates nothing until the registry, which is
 * the only thing here that knows the GPU budget, decides one of them is worth decoding.
 */
export interface SpineQuadSource {
  nodeId: string;
  /** The clip url, which is the texture KEY: two nodes playing the same anim are one upload. */
  clipUrl: string;
  source: TexImageSource;
  /** The still's ENCODED bytes, or null where the clip cannot supply them. See the note above. */
  bytes: () => Blob | null;
  /** The still's own pixel size — the quad's box AND its source rect. */
  frameW: number;
  frameH: number;
  /** Node-local placement of the still: translate then uniform scale. */
  tx: number;
  ty: number;
  scale: number;
}

export interface MirrorOverlay {
  readonly container: HTMLElement;
  /**
   * Sync the overlay to one build's records. `nodes` is the live node map (the records carry only geometry); `fx`
   * is the registry when the in-canvas effect path is on (see {@link OverlayFxSource}).
   */
  reconcile(
    records: readonly OverlayRecord[],
    nodes: Map<string, MirrorNode>,
    fx?: OverlayFxSource | null
  ): OverlayReconcileResult;
  /**
   * Advance every playing spine clip to `nowMs`. Separate from `reconcile` because a clip plays on the browser's
   * clock, not on the wire's — see {@link MirrorOverlay.nextSpineDeadline}.
   */
  tickSpine(nowMs: number): void;
  /**
   * When a spine clip next needs a frame, or `Infinity` when none does. The renderer folds this into its own park
   * decision, so a scene with a running creature wakes for its frames and an idle one still parks.
   *
   * AN HONEST TIMESTAMP SINCE M3, not a boolean in disguise. It used to answer `nowMs + 33` for any playing clip,
   * on the theory that the bake was ~30fps and the renderer would round it up to a frame anyway — and the renderer
   * DID round it up, to the next display frame, because `armAnimation` only asked whether the answer was finite.
   * The bake is 15fps (`CouchCoopSpineClipProvider`'s policy), so a playing creature repainted the whole stage
   * about four times per clip frame. This now folds the real next-frame time of every playing clip, replaying
   * `drawSpineFrame`'s own clock so the wakeup and the paint can never disagree.
   */
  nextSpineDeadline(nowMs: number): number;
  /**
   * How many entries are in the PLAYING set right now — the counter {@link nextSpineDeadline} and `tickSpine`
   * short-circuit on, exposed so it can be MEASURED rather than inferred.
   *
   * It is not derivable from the deadline: a one-frame geoclip that wrongly counted as playing would still answer
   * `Infinity` (`msToNextGeoclipFrame` is Infinity for one frame), so the only visible symptom of the bug would be
   * a full scan of every overlay element on every animated frame, forever. This is the number that says so.
   */
  spinePlayingCount(): number;
  /**
   * Every spine node whose still is DECODED AND ON SCREEN, as the draw list would need to paint it (A2).
   *
   * Only committed stills appear: a clip still loading, still decoding, or painted through the multi-frame canvas
   * path is absent, and the caller then leaves that node hoisted exactly as before. Empty unless a caller asked
   * for it, so the default page allocates nothing.
   */
  spineQuads(): ReadonlyMap<string, SpineQuadSource>;
  /**
   * A counter that changes exactly when {@link spineQuads} could answer differently — i.e. when a still COMMITS
   * to an element or an element carrying one goes away. Never changes on a page with no spine stills.
   *
   * WHY IT EXISTS RATHER THAN CALLING `spineQuads()` AGAIN. The renderer's
   * frame-level patch gate has to ask "could the quad set have moved since the build?" on EVERY animated frame.
   * Asking it by rebuilding the map would walk every overlay element per frame — the exact per-frame cost the
   * build takes a single snapshot to avoid. This is the same shape as the renderer's own `cosmeticVersion` and
   * `trailLatchVersion`: a monotone counter banked at build time and compared later.
   *
   * IT IS DELIBERATELY COARSE. Any commit anywhere bumps it, including one for a creature no patch would have
   * touched. That costs a rebuild the frame a still lands — which is a frame the decode already made expensive —
   * and it keeps the gate on the safe side of a question whose wrong answer is a structurally stale list.
   */
  spineQuadVersion(): number;
  /**
   * Tell the overlay which spine nodes the LAST build painted as quads, so their `<img>` stops compositing.
   *
   * The same shape (and the same reason) as {@link OverlayFxSource.drawn}: a host whose pixels are in the draw
   * list must not be composited a second time above the whole stage, and one whose pixels are NOT must keep
   * painting or the flag would lose a creature.
   */
  setSpineDrawn(ids: ReadonlySet<string> | null): void;
  /**
   * Tell the overlay which text nodes the build being reconciled painted as quads (M4).
   *
   * The TRAIL shape, not the spine one, and the difference matters. A drawn label loses its ELEMENT outright —
   * there is nothing to keep, because unlike a gsw host nothing renders into it and unlike a spine `<img>` the
   * element is not itself the pixels. So `reconcile` skips it before `createEl`, and `syncOrder`'s sweep destroys
   * whatever it had last build for free.
   *
   * Must be set BEFORE the reconcile it describes: this build's quads decide this build's elements. That is the
   * opposite of `setSpineDrawn`'s one-build lag, and it is affordable because a text quad needs no cover answer.
   */
  setTextDrawn(ids: ReadonlySet<string> | null): void;
  /**
   * Tell the overlay the paint order of the last stage-spanning opaque fill this build drew (R2), or null to
   * leave every record alone.
   *
   * WHY AN OVERLAY NEEDS IT. Every element here paints above the WHOLE canvas, so when the game opens a
   * full-screen dialog the combat screen's own labels keep painting over it. A clip cannot help: nothing is out
   * of bounds, something opaque was simply painted in front. The only honest answer available to a DOM layer
   * above one canvas is to stop drawing what the game has covered.
   *
   * Set BEFORE the reconcile it describes, on `setTextDrawn`'s rule: this build's backstop decides this build's
   * elements.
   */
  /**
   * What the game painted over everything below it: the paint order of the last stage-spanning opaque fill.
   * `null` order is "no backstop" and restores the pre-R2 behaviour.
   */
  setBackstop(order: number | null): void;
  counts(): OverlayCounts;
  dispose(): void;
}

/**
 * The two gsw RUNTIME kinds the HOIST RULE covers. See the module header for why `text` and `spine` are not here.
 */
const HOIST_GATED_KINDS: ReadonlySet<OverlayRecord["kind"]> = new Set<OverlayRecord["kind"]>(["shader", "particles"]);

/** A composed tint this far from white is worth an feColorMatrix; below it the filter would be a no-op surface. */
const TINT_EPSILON = 1 / 255;

const SVG_NS = "http://www.w3.org/2000/svg";

function isWhite(r: number, g: number, b: number): boolean {
  return Math.abs(r - 1) < TINT_EPSILON && Math.abs(g - 1) < TINT_EPSILON && Math.abs(b - 1) < TINT_EPSILON;
}

/** `mirrorRenderer.tintKey`'s quantization — 1/50ths — so the two backends mint the same bounded id set. */
function tintKey(r: number, g: number, b: number): string {
  const q = (v: number) => Math.round(Math.min(v, 4) * 50);
  return `${q(r)}_${q(g)}_${q(b)}`;
}

/** `mirrorRenderer.setStyleProp`: a hyphenated key (gsw's `mix-blend-mode`) needs `setProperty`, not the map. */
function setStyleProp(el: HTMLElement, key: string, value: string): void {
  if (key.startsWith("--") || key.includes("-")) {
    el.style.setProperty(key, value);
  } else {
    (el.style as unknown as Record<string, string>)[key] = value;
  }
}

function removeStyleProp(el: HTMLElement, key: string): void {
  if (key.startsWith("--") || key.includes("-")) {
    el.style.removeProperty(key);
  } else {
    (el.style as unknown as Record<string, string>)[key] = "";
  }
}

/**
 * The `clip-path` that crops an overlay element to a DESIGN-space rect, or null when none is needed (R1).
 *
 * THE SPACE. `clip-path` is resolved in the element's OWN box, and the element carries `record.transform` with
 * `transform-origin: 0 0` — so the design rect has to come back through that matrix's INVERSE. Everything below is
 * that one inversion, spelt two ways:
 *
 *   * an AXIS-ALIGNED placement (no rotation, no skew — every clipper and very nearly every surface we have
 *     measured) maps a rect to a rect, so it is an `inset()`, which is the only spelling that can carry the
 *     clipper's CORNER RADIUS. The insets are deliberately allowed to go NEGATIVE: a label's ink (its outline and
 *     its shadow) sits outside its own box, and clamping the crop to the box edge would cut exactly the pixels
 *     this fix must not touch. The radius is divided per axis, which is exact for a non-uniform scale too.
 *   * a ROTATED or SKEWED one maps the rect to a parallelogram, so it is a `polygon()` of the four inverted
 *     corners — no radius, which is the same under-clip the multi-scope case takes.
 *
 * TWO DEGENERATE ANSWERS. An EMPTY intersection (the surface has scrolled entirely out of its container) is
 * `inset(50%)` — a zero-area crop — and never `display: none`: gsw sizes a runtime's canvas from the host's
 * client box and watches it with a ResizeObserver, so a display-none host would collapse every surface under it
 * to 0x0 and unpick the runtime rather than merely hiding it. A SINGULAR placement (a collapsed scale) paints
 * nothing on either backend, so it takes the no-crop answer rather than a crop nobody can read.
 */
export function overlayClipPath(clip: OverlayClip, m: Affine | readonly number[], w: number, h: number): string | null {
  if (!(clip.w > 0) || !(clip.h > 0)) {
    return "inset(50%)";
  }
  const det = m[0] * m[3] - m[1] * m[2];
  if (!(Math.abs(det) > 1e-9)) {
    return null;
  }
  if (m[1] === 0 && m[2] === 0) {
    const x0 = (clip.x - m[4]) / m[0];
    const x1 = (clip.x + clip.w - m[4]) / m[0];
    const y0 = (clip.y - m[5]) / m[3];
    const y1 = (clip.y + clip.h - m[5]) / m[3];
    // A NEGATIVE axis scale (a mirrored placement) swaps the edges — order them rather than emitting an inverted
    // inset, which browsers resolve to an empty shape.
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    let round = "";
    if (clip.cornerRadius > 0) {
      const rx = clip.cornerRadius / Math.abs(m[0]);
      const ry = clip.cornerRadius / Math.abs(m[3]);
      round = rx === ry ? ` round ${px(rx)}px` : ` round ${px(rx)}px / ${px(ry)}px`;
    }
    return `inset(${px(top)}px ${px(w - right)}px ${px(h - bottom)}px ${px(left)}px${round})`;
  }
  const ia = m[3] / det;
  const ib = -m[1] / det;
  const ic = -m[2] / det;
  const id = m[0] / det;
  const ie = (m[2] * m[5] - m[3] * m[4]) / det;
  const iff = (m[1] * m[4] - m[0] * m[5]) / det;
  const cx = [clip.x, clip.x + clip.w, clip.x + clip.w, clip.x];
  const cy = [clip.y, clip.y, clip.y + clip.h, clip.y + clip.h];
  const points: string[] = [];
  for (let i = 0; i < 4; i++) {
    points.push(`${px(ia * cx[i] + ic * cy[i] + ie)}px ${px(ib * cx[i] + id * cy[i] + iff)}px`);
  }
  return `polygon(${points.join(", ")})`;
}

/** Three decimals is a hundredth of a device pixel at any scale this stage runs at, and it keeps the string stable. */
function px(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

// --- geoclip playback on the canvas backend -------------------------------------------------------------------
//
// A geoclip is the same creature animation baked as per-part MESH GEOMETRY instead of one image per frame (see
// mirror/geoclipPlayer.ts). The DOM backend has played them since Phase 2; this is the same integration ported
// onto the canvas backend's own, parallel spine implementation, because it follows a different renderer path.
// a SILENT no-op — the whole arm lived inside `createMirrorRenderer`'s closure, and `rendererFactory` builds a
// different object for this backend.
//
// It is an ADDITION to the baked path and never a replacement of it, on the DOM arm's four rules:
//
//   * The raster clip is requested, decoded and placed. It is what shows when this animation has no geoclip, and
//     what shows again the instant anything goes wrong.
//   * The PLACEMENT comes from the manifest when the bake stated one (`meta.placement`, Phase 4) and otherwise
//     from inverting the baked clip's own placement — nothing else on the wire says where the skeleton origin
//     sits (`deriveGeoclipFit`). Only in that second case does a geoclip have to wait for a baked clip, which is
//     why `mountSpine` — the one place this backend knows that placement — is still a mount site.
//   * "In place of" is a CSS class on the node element, not DOM surgery: `.mirror-geoclip-live` (MirrorView.vue)
//     hides the baked layer whichever of the two mechanisms it currently is. Both this backend's baked elements
//     (`.mirror-spine-canvas`, `.mirror-spine-img`) are DIRECT children of the overlay element, so the existing
//     unscoped child rules match with no stylesheet change.
//   * Failure is ONE-WAY per node (`geoclipDisabled`): a node that could not play one stays baked for the rest of
//     the session rather than re-probing on every animation change.
//
// THE DIVERGENCE, STATED. An overlay element paints above the WHOLE stage canvas, so a geoclip mounted here
// inherits the module header's P6 gap exactly as the unconditional spine hoist does — anything the canvas paints
// later still lands under the creature. The in-canvas answer (a quad registry for geoclip geometry) remains a
// separate piece of work that this overlay does not do.
const GEOCLIP_LIVE_CLASS = "mirror-geoclip-live";

/** One node's geoclip playback state for its CURRENT animation. Null while a node is on the raster path. */
interface GeoclipEntryState {
  /** The manifest url this state was armed for — the identity guard every async arrival re-checks. */
  manifestUrl: string;
  clip: GeoclipClip | null;
  gpu: GpuClip | null;
  node: GeoclipNode | null;
  /** The frame index currently painted (-1 = nothing yet), so a tick on the same frame draws nothing. */
  frame: number;
}

/**
 * When a geoclip next needs a frame, in ms from `playMs` — the geoclip twin of `msToNextSpineFrame`, and the
 * reason `nextSpineDeadline` cannot simply ask the baked clip.
 *
 * A geoclip's frames are UNIFORMLY spaced by construction (the baker steps the track time at a fixed fps), so
 * this is arithmetic on the same numbers `geoclipFrameIndexAt` floors, rather than a walk of per-frame starts.
 * The two must agree exactly or the stage would wake on a grid point that paints nothing.
 *
 * Two Infinity answers, both real: a single-frame clip's index can never move, and a NON-LOOPING one that has
 * run past its last frame holds that frame forever (an attack that has landed). Answering a finite time for
 * either is what would keep the stage's animation rAF alive for the rest of the screen.
 */
export function msToNextGeoclipFrame(
  clip: { frames: unknown[]; fps: number },
  playMs: number,
  loop: boolean
): number {
  const count = clip.frames.length;
  if (count <= 1) {
    return Number.POSITIVE_INFINITY;
  }
  const fps = clip.fps > 0 ? clip.fps : 30;
  const period = 1000 / fps;
  if (!loop && playMs >= (count - 1) * period) {
    return Number.POSITIVE_INFINITY;
  }
  const phase = ((playMs % period) + period) % period;
  // NEVER ZERO: a play time landing exactly on a boundary is one whole period from the NEXT one, and answering 0
  // would book an rAF that repaints the frame already on screen.
  return period - phase;
}

interface OverlayEl {
  id: string;
  kind: OverlayRecord["kind"];
  el: HTMLElement;
  /**
   * The last `matrix(...)`/size written, so an unmoved node costs no style write — as EIGHT NUMBERS, never a key.
   *
   * This used to be a template-literal of the six matrix cells plus `w x h`, built and compared per record per
   * build. Every scrolling record misses that cache by construction (`m[5]` moves), so a scroll gesture minted one
   * throwaway string per overlay record per frame purely to discover that it had to write anyway. Eight numeric
   * compares answer the same question with no allocation.
   *
   * NaN-initialised, which is what makes the first sync always write: `NaN !== NaN`. The one behaviour that differs
   * from the string key is a node whose transform is genuinely NaN — the key was stable ("NaN"), the compare is
   * not, so a broken matrix now re-writes every build instead of once. That is a bug state either way.
   */
  placement: number[];
  /**
   * The 13 numbers the last `clip-path` was computed FROM — the clip rect (5) and the placement it was inverted
   * through (6 + w/h) — on `placement`'s rule and for its reason: a crop that has not moved must cost no style
   * write and no string. NaN-initialised, so the first sync always writes.
   */
  clipVals: number[];
  /** Is a `clip-path` currently ON the element? What makes clearing it a one-boolean decision. */
  clipActive: boolean;
  // --- text ---
  textDiv: HTMLElement | null;
  textInner: HTMLElement | null;
  lastText: string | null;
  lastHtml: string | null;
  lastRich: boolean | null;
  textStyleKey: string | null;
  /**
   * The node object `textStyleKey` was computed FROM — the cheap half of the text-style cache.
   *
   * `textStyle` builds a fresh ~20-key object and `JSON.stringify` prices it, per text record per build, and a
   * screen carries 15-52 of them. But a node is IMMUTABLE once merged: `sceneTree.mergeNode` returns a new object
   * and `nodes.set` replaces the entry, so an upsert changes the node's IDENTITY and a node nobody upserted keeps
   * it. Identity therefore answers "could this style have changed?" with a pointer compare.
   *
   * That is the whole win on the case it was written for: a scroll gesture rebuilds every frame off cosmetic
   * offsets with NO new wire data, so every text node keeps its identity across the entire gesture. The JSON key
   * stays BEHIND this check rather than being replaced by it — a new node object often carries byte-identical
   * styles, and the key is what stops those ~20 style writes.
   */
  textStyleNode: MirrorNode | null;
  /** The last composed paint style written (opacity / filter / a shader's own style) — see `syncHostStyle`. */
  hostStyle: Map<string, string>;
  // --- shader / particles ---
  selfLayer: HTMLElement | null;
  /** The `data-godot-shader-pixel-ratio` at-rest gate for this surface — see `./fxPixelRatio`. */
  fxPixelRatio: FxPixelRatioGate;
  attrs: Map<string, string>;
  // --- spine ---
  spineUrl: string | null;
  spineClip: LoadedSpineClip | null;
  /**
   * A SECOND, independent retain on the clip whose `stillUrl` the live `<img>` is displaying.
   *
   * `spineClip` is swapped the instant a newer clip arrives, but the object url ON SCREEN has to outlive that
   * swap: without this retain an LRU eviction could revoke a url the element is still painting, and the creature
   * goes blank until the next identity change. The DOM backend's `spineShownStill` for the same reason.
   */
  spineShownStill: LoadedSpineClip | null;
  spineImg: HTMLImageElement | null;
  /** The url currently ON the `<img>` — what a swap is diffed against, and what says the pixels are live. */
  spineImgUrl: string | null;
  /** A still whose decode is IN FLIGHT. Dedupes re-entry, and is the staleness token the commit re-checks. */
  spinePendingStillUrl: string | null;
  spineCanvas: HTMLCanvasElement | null;
  spineCtx: CanvasRenderingContext2D | null;
  spineShownFrame: number;
  spinePlacementKey: string | null;
  spineTrackMs: number;
  spineWallMs: number;
  spinePaused: boolean;
  spineLooping: boolean;
  /** Is this entry currently IN the playing set? The counter is that set's size — see `refreshSpinePlaying`. */
  spinePlaying: boolean;
  /** Bumped on every clip swap; a load that resolves against a stale generation is dropped. */
  spineGeneration: number;
  /**
   * Are there spine PIXELS on this element right now? Set the moment they commit and cleared only on teardown —
   * the DOM backend's `RenderRecord.spineArtPainted`, for the same reason: the identity fields all reset on an
   * animation change while the previous still is still painting, so deriving this from them would flash a
   * creature stand-in over a creature the viewer can see.
   */
  spineArtPainted: boolean;
  // --- creature placeholder (see mirror/creaturePlaceholder.ts) ---
  /** The stand-in `<img>` and the placement last written on it. */
  placeholderImg: HTMLImageElement | null;
  placeholderKey: string | null;
  /** When the current clip identity started waiting, and its one-shot deadline. Null = nothing is being awaited. */
  placeholderArmedMs: number | null;
  placeholderTimer: ReturnType<typeof setTimeout> | null;
  /** LATCH: the fetch for this identity was refused, so the stand-in is permanent rather than a grace period. */
  placeholderFailed: boolean;
  // --- geoclip ---
  geoclipState: GeoclipEntryState | null;
  /**
   * This node PROVED it cannot play a geoclip. Session-long and one-way: it outlives every `geoclipState` this
   * entry will ever have, so a node that fell back once never re-probes on the next animation change.
   */
  geoclipDisabled: boolean;
}

export function createMirrorOverlay(
  stage: HTMLElement,
  canvas: HTMLElement,
  options?: MirrorOverlayOptions
): MirrorOverlay {
  const doc = stage.ownerDocument;
  const container = doc.createElement("div");
  container.className = OVERLAY_CONTAINER_CLASS;
  container.style.position = "absolute";
  container.style.left = "0";
  container.style.top = "0";
  container.style.width = "100%";
  container.style.height = "100%";
  // The container itself is inert; its CHILDREN keep `.mirror-node`'s `pointer-events: auto`, which is what the
  // stateful/controlling client's own hover hit-testing reads. The canvas backend answers touch from the draw
  // list, so nothing here is load-bearing for input — it just must not swallow the chrome slotted beside it.
  container.style.pointerEvents = "none";
  // Directly ABOVE the canvas and below everything the stage slots in after it (the confirm button, the
  // hand-raise toggle), which is exactly where the DOM backend's node tree sits.
  //
  // TWO LAYOUTS, ONE PAINT ORDER. When the canvas is a child of the stage (the legacy layout), "above the canvas"
  // is literally its next sibling. When it lives in its own untransformed host — the sibling that keeps the stage
  // canvas out of the scaled subtree, see canvasRenderer's SIZING LAW — the WHOLE stage paints above that host, so
  // the container takes the stage's LEADING child slot instead: still above the canvas, still below everything
  // Vue slots in after it, and still inside the design box every overlay element is positioned in. This container
  // is the only thing this module puts in the page, so those two placements are the whole contract.
  if (canvas.parentElement === stage) {
    canvas.insertAdjacentElement("afterend", container);
  } else {
    stage.insertBefore(container, stage.firstChild);
  }

  const elements = new Map<string, OverlayEl>();
  const counts: OverlayCounts = {
    text: 0,
    shader: 0,
    particles: 0,
    spine: 0,
    trail: 0,
    elements: 0,
    withheld: 0,
    fxHidden: 0,
    fxDeclined: 0,
    textHoisted: 0,
    clipped: 0,
    clipEmpty: 0,
    clipPolygon: 0,
    backstopWithheld: 0,
    coveredText: 0,
    coveredSpine: 0
  };
  /**
   * WHAT TO DO ABOUT A COVERED SURFACE — `on` (withhold, the round-6 flip) or `dim` (fade it by the sheet's own
   * transmission). `off` never reaches here: the renderer passes a null order instead, so this module has exactly
   * one way to be inert and the lever cannot disagree with itself.
   */
  let disposed = false;
  let playingSpine = 0;
  /**
   * The node map of the build in progress, latched so a creature stand-in's DEADLINE — which fires from a timer,
   * between builds — can still resolve its box against a live scene rather than a captured snapshot.
   */
  let liveNodes: Map<string, MirrorNode> | null = null;
  /**
   * A parent → children index over `liveNodes`, built AT MOST ONCE PER BUILD and only if something asks.
   *
   * A creature states its box on a different node from the one that paints it, so resolving the stand-in needs to
   * look up a named child. This backend has no walk-maintained child index to borrow (the DOM one does), and
   * scanning ~4 000 nodes on every build to answer a question almost no build asks would be a real cost — so it
   * is lazy, and the only builds that pay for it are the ones where a creature is actually missing its art.
   */
  let childIndex: Map<string, string[]> | null = null;
  function childrenOfLazy(id: string): readonly string[] {
    if (childIndex === null) {
      childIndex = new Map();
      if (liveNodes !== null) {
        for (const candidate of liveNodes.values()) {
          if (candidate.parentId === null) continue;
          const list = childIndex.get(candidate.parentId);
          if (list !== undefined) list.push(candidate.id);
          else childIndex.set(candidate.parentId, [candidate.id]);
        }
      }
    }
    return childIndex.get(id) ?? EMPTY_CHILD_IDS;
  }
  /** Spine nodes the LAST build drew as stage quads — see {@link MirrorOverlay.setSpineDrawn}. */
  let spineDrawnIds: ReadonlySet<string> | null = null;
  /** See {@link MirrorOverlay.spineQuadVersion}. Bumped only by `setSpineShownStill`, which is the one funnel. */
  let spineQuadVersionCounter = 0;
  /** Text nodes THIS build drew as stage quads — see {@link MirrorOverlay.setTextDrawn}. */
  let textDrawnIds: ReadonlySet<string> | null = null;
  /** The paint order everything below is covered by — see {@link MirrorOverlay.setBackstop}. */
  let backstopOrder: number | null = null;

  // --- element lifecycle ---------------------------------------------------------------------------------------

  function createEl(record: OverlayRecord, nodes: Map<string, MirrorNode>): OverlayEl {
    const el = doc.createElement("div");
    el.className = OVERLAY_NODE_CLASS;
    // The geometry, inline — see OVERLAY_NODE_CLASS for why this is not `.mirror-node`. `pointer-events` is left
    // UNSET so it inherits the container's `none`: this backend answers every touch from the draw list through
    // `touchStackAt`, so an overlay element that took a pointer could only ever shadow that answer.
    el.style.position = "absolute";
    el.style.left = "0";
    el.style.top = "0";
    el.style.transformOrigin = "top left";
    el.style.userSelect = "none";
    el.setAttribute("data-node-id", record.id);
    // Scene identity, stamped for the same two reasons the DOM backend stamps it: the text-scale rules match on
    // it, and the `__mirrorTopSurfaces` diagnostic reads it back off a canvas's ancestors.
    const scene = resolveSceneInfo(record.id, nodes);
    if (scene) {
      el.setAttribute("data-scene-file", scene.file);
      el.setAttribute("data-scene-node-path", scene.relPath);
      el.setAttribute("data-scene-root-id", scene.rootId);
    }
    for (const cls of resolveTextScaleClasses(scene?.file ?? null, scene?.relPath ?? null)) {
      el.classList.add(cls);
    }
    return {
      id: record.id,
      kind: record.kind,
      el,
      placement: [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN],
      clipVals: [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN],
      clipActive: false,
      textDiv: null,
      textInner: null,
      lastText: null,
      lastHtml: null,
      lastRich: null,
      textStyleKey: null,
      textStyleNode: null,
      hostStyle: new Map(),
      selfLayer: null,
      fxPixelRatio: createFxPixelRatioGate(),
      attrs: new Map(),
      spineUrl: null,
      spineClip: null,
      spineShownStill: null,
      spineImg: null,
      spineImgUrl: null,
      spinePendingStillUrl: null,
      spineCanvas: null,
      spineCtx: null,
      spineShownFrame: -1,
      spinePlacementKey: null,
      spineTrackMs: 0,
      spineWallMs: 0,
      spinePaused: false,
      spineLooping: true,
      spinePlaying: false,
      spineGeneration: 0,
      spineArtPainted: false,
      placeholderImg: null,
      placeholderKey: null,
      placeholderArmedMs: null,
      placeholderTimer: null,
      placeholderFailed: false,
      geoclipState: null,
      geoclipDisabled: false
    };
  }

  function destroyEl(entry: OverlayEl): void {
    releaseSpine(entry);
    // …and the displayed still, which `releaseSpine` deliberately keeps: its whole job is to outlive a clip swap,
    // so the only thing that ends it is the element going away (or newer pixels replacing it).
    setSpineShownStill(entry, null);
    entry.spineImgUrl = null;
    // The stand-in's pending deadline goes with the element: a live `setTimeout` would keep a destroyed entry
    // (and its element) reachable until it fired.
    resetPlaceholder(entry);
    entry.spineArtPainted = false;
    entry.el.remove();
    elements.delete(entry.id);
  }

  /**
   * Does this clip actually need a frame on the browser's clock?
   *
   * ONLY a multi-frame clip that is not paused. A SINGLE-frame clip is the product default (`spineMode: static`,
   * which is what every non-dev device gets) and it renders as a plain `<img>` — there is no frame to advance and
   * no canvas to advance it into. Counting one as playing is what kept `nextSpineDeadline` finite for the whole
   * of a combat, so the renderer's animation rAF never parked and the stage repainted at ~23fps against a scene
   * that P8 measured as animating for 3.3 seconds out of 30.
   */
  function clipAnimates(entry: OverlayEl): boolean {
    if (entry.spinePaused) {
      return false;
    }
    if (entry.geoclipState?.node) {
      // A LIVE GEOCLIP IS THE PAINTER, so the demand is ITS frame count and not the baked clip's — the baked
      // frames underneath are never drawn while it is up. That term is not a nicety in the MULTI-frame case:
      // without it the whole stage parks and the creature freezes on frame 0, because the product default is a
      // SINGLE-frame still (`spineMode: static`) and the baked test below is false for nearly every creature.
      //
      // …and it must not be `true` unconditionally either, which is what it was. A ONE-FRAME geoclip — the whole
      // point of a single-pose bake — has an index that can never move, so claiming it animates would pin the
      // stage's animation rAF for the rest of the screen to repaint the pose already on it. `msToNextGeoclipFrame`
      // has always answered Infinity for that clip; this is what stops the SCAN, and the counter, as well.
      //
      // A PAUSED track is still excluded above, and that is deliberately STRICTER than the DOM arm: the game froze
      // the track (SetTimeScale(0)), so `spinePlayMs` is constant and the frame index cannot move either.
      return (entry.geoclipState.clip?.frames.length ?? 0) > 1;
    }
    return entry.spineClip !== null && entry.spineClip.frames.length > 1;
  }

  /** Re-derive one entry's membership of the playing set. Idempotent; the counter is the set's size. */
  function refreshSpinePlaying(entry: OverlayEl): void {
    const shouldPlay = clipAnimates(entry);
    if (shouldPlay === entry.spinePlaying) {
      return;
    }
    entry.spinePlaying = shouldPlay;
    playingSpine += shouldPlay ? 1 : -1;
  }

  /**
   * The ONLY place `entry.spineClip` is assigned — and the reason it is a function at all.
   *
   * THE BUG THIS FIXES: this module released a clip it had never retained. `LoadedSpineClip`'s refcount exists so
   * an LRU eviction cannot close ImageBitmaps (or revoke object urls) the renderer is still painting, and it only
   * works if the painter takes a reference. Ours rested at zero, so every clip this overlay showed was one
   * eviction away from a permanently blank creature — latent only because the pools (24 clips / 64 stills) are
   * bigger than a screen. The DOM backend's `setSpineClip` has had the pairing since the bug was found there.
   */
  function setSpineClip(entry: OverlayEl, clip: LoadedSpineClip | null): void {
    if (entry.spineClip === clip) {
      return;
    }
    entry.spineClip?.release();
    entry.spineClip = clip;
    clip?.retain();
  }

  /**
   * …and the same pairing for the clip whose still is ON SCREEN. See {@link OverlayEl.spineShownStill}.
   *
   * ALSO THE ONE FUNNEL {@link MirrorOverlay.spineQuadVersion} counts, and that is why the version can be a
   * counter rather than a diff. `spineQuads()` admits an entry on three conditions — a committed
   * `spineShownStill`, a `spineImg` carrying it, and `spineImgUrl` matching the clip's `stillUrl` — and all three
   * move together inside `mountStill`'s commit or `destroyEl`'s teardown, both of which pass through here. An
   * entry whose OTHER spine fields change (a `spineClip` swap whose decode has not committed yet) does not change
   * the map's answer and correctly does not bump.
   */
  function setSpineShownStill(entry: OverlayEl, clip: LoadedSpineClip | null): void {
    if (entry.spineShownStill === clip) {
      return;
    }
    entry.spineShownStill?.release();
    entry.spineShownStill = clip;
    clip?.retain();
    spineQuadVersionCounter++;
  }

  function releaseSpine(entry: OverlayEl): void {
    // THE GEOCLIP GOES FIRST, before the playing set is re-derived: `clipAnimates` folds a live geoclip, so an
    // entry whose element is still attached here would stay in the set with nothing left to paint. `releaseGeoclip`
    // deliberately does NOT clear `geoclipDisabled` — see the field.
    releaseGeoclip(entry);
    setSpineClip(entry, null);
    refreshSpinePlaying(entry);
    entry.spineGeneration++;
    entry.spineUrl = null;
    entry.spineShownFrame = -1;
    entry.spinePlacementKey = null;
    entry.spinePendingStillUrl = null;
  }

  /** The element's box + matrix, written only when one of them actually moved. See {@link OverlayEl.placement}. */
  function syncPlacement(entry: OverlayEl, record: OverlayRecord): void {
    const m = record.transform;
    const p = entry.placement;
    if (
      p[0] === m[0] &&
      p[1] === m[1] &&
      p[2] === m[2] &&
      p[3] === m[3] &&
      p[4] === m[4] &&
      p[5] === m[5] &&
      p[6] === record.w &&
      p[7] === record.h
    ) {
      return;
    }
    p[0] = m[0];
    p[1] = m[1];
    p[2] = m[2];
    p[3] = m[3];
    p[4] = m[4];
    p[5] = m[5];
    p[6] = record.w;
    p[7] = record.h;
    const style = entry.el.style;
    style.width = `${record.w}px`;
    style.height = `${record.h}px`;
    style.transform = affineCss(m);
  }

  /**
   * The element's CROP (R1), written only when the rect or the placement it is expressed against actually moved.
   *
   * `clip-path` and not `overflow`, for two reasons that both had to hold: the crop is an ANCESTOR's rect, so
   * there is no element here to put an `overflow` on (every overlay element is a flat child of one container);
   * and `clip-path` creates NO STACKING CONTEXT, so the container's deliberate non-isolation — the thing that
   * lets a legitimately-hoisted additive host blend against the canvas beneath it (see the module header) — is
   * untouched. It is also orthogonal to the `hideHost` rule below: a hidden host stays hidden, a cropped one
   * stays cropped, and neither reads the other.
   */
  function syncClip(entry: OverlayEl, record: OverlayRecord): void {
    const clip = record.clip;
    if (clip === null) {
      if (entry.clipActive) {
        entry.el.style.clipPath = "";
        entry.clipActive = false;
        entry.clipVals[0] = NaN;
      }
      return;
    }
    const m = record.transform;
    const v = entry.clipVals;
    if (
      v[0] === clip.x &&
      v[1] === clip.y &&
      v[2] === clip.w &&
      v[3] === clip.h &&
      v[4] === clip.cornerRadius &&
      v[5] === m[0] &&
      v[6] === m[1] &&
      v[7] === m[2] &&
      v[8] === m[3] &&
      v[9] === m[4] &&
      v[10] === m[5] &&
      v[11] === record.w &&
      v[12] === record.h
    ) {
      return;
    }
    v[0] = clip.x;
    v[1] = clip.y;
    v[2] = clip.w;
    v[3] = clip.h;
    v[4] = clip.cornerRadius;
    v[5] = m[0];
    v[6] = m[1];
    v[7] = m[2];
    v[8] = m[3];
    v[9] = m[4];
    v[10] = m[5];
    v[11] = record.w;
    v[12] = record.h;
    const path = overlayClipPath(clip, m, record.w, record.h);
    entry.el.style.clipPath = path ?? "";
    entry.clipActive = path !== null;
  }

  /** Diff a stamped attribute set, reporting whether anything a gsw runtime could see moved. */
  function applyAttrs(entry: OverlayEl, next: Record<string, string>): boolean {
    let changed = false;
    for (const [key, value] of Object.entries(next)) {
      if (entry.attrs.get(key) !== value) {
        entry.el.setAttribute(key, value);
        entry.attrs.set(key, value);
        changed = true;
      }
    }
    for (const key of [...entry.attrs.keys()]) {
      if (!(key in next)) {
        entry.el.removeAttribute(key);
        entry.attrs.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  // --- the composed tint <filter> registry ---------------------------------------------------------------------
  //
  // A per-channel RGB multiply has no plain-CSS spelling (`brightness()` scales all three together), so the DOM
  // backend renders the composed tint as an feColorMatrix and references it by id — and the canvas stage cannot
  // borrow that registry, because it lives inside `createMirrorRenderer` (the DOM backend), which this stage does
  // not construct. The <defs> here is the same table under the same `mtint-<key>` ids and the same 1/50th
  // quantization, built LAZILY: across the whole standard recording set not one overlay record carries a non-white
  // composed tint, so on every screen we have measured this element is never created at all.
  // The <svg> hangs off the STAGE, not off the container: `syncOrder` sweeps every container child the build did
  // not name, so a defs element parked in there would be removed on the very next reconcile.
  let tintSvg: SVGSVGElement | null = null;
  let tintDefs: SVGDefsElement | null = null;
  const tintIds = new Set<string>();

  function tintFilterUrl(r: number, g: number, b: number): string | null {
    if (isWhite(r, g, b)) {
      return null;
    }
    const key = tintKey(r, g, b);
    if (!tintIds.has(key)) {
      tintIds.add(key);
      if (!tintDefs) {
        tintSvg = doc.createElementNS(SVG_NS, "svg");
        tintSvg.setAttribute("aria-hidden", "true");
        tintSvg.style.position = "absolute";
        tintSvg.style.width = "0";
        tintSvg.style.height = "0";
        tintSvg.style.overflow = "hidden";
        tintDefs = doc.createElementNS(SVG_NS, "defs");
        tintSvg.appendChild(tintDefs);
        stage.appendChild(tintSvg);
      }
      const filter = doc.createElementNS(SVG_NS, "filter");
      filter.setAttribute("id", `mtint-${key}`);
      filter.setAttribute("color-interpolation-filters", "sRGB");
      filter.setAttribute("x", "0");
      filter.setAttribute("y", "0");
      filter.setAttribute("width", "100%");
      filter.setAttribute("height", "100%");
      const matrix = doc.createElementNS(SVG_NS, "feColorMatrix");
      matrix.setAttribute("type", "matrix");
      matrix.setAttribute("values", `${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 1 0`);
      filter.appendChild(matrix);
      tintDefs.appendChild(filter);
    }
    return `url(#mtint-${key})`;
  }

  /**
   * The host element's COMPOSED PAINT STYLE: `opacity`, the composed tint `filter`, and — for a shader host — the
   * binding's own style (gsw's `mix-blend-mode` for a `CanvasItemMaterial` ADD).
   *
   * `mergedNodeStyle`'s rule, restated: a WebGL host gets NO filter (gsw feeds the modulate into the shader through
   * `data-godot-shader-modulate`, so a CSS tint on top would double it); an HSV binding's filter composes BEFORE
   * the tint, in that order. Diffed against the last write, so an unchanged surface costs one string compare per
   * property instead of a style write.
   */
  function syncHostStyle(
    entry: OverlayEl,
    record: OverlayRecord,
    shader: MirrorShaderBinding | null,
    hideHost: boolean,
    /** The backstop's transmission `1 − a`, or 1 when nothing is dimming this surface. See the decision above. */
    dimFactor = 1
  ): void {
    const next: Record<string, string> = {
      opacity: String(dimFactor === 1 ? record.opacity : record.opacity * dimFactor)
    };
    if (hideHost) {
      // THE HOST STOPS COMPOSITING (M2). The draw list paints this surface as a quad now, so leaving gsw's canvas
      // in the page would composite it a SECOND time, above the entire stage — the very layering the fx path
      // exists to end.
      //
      // `visibility: hidden` and NOT `display: none`: gsw sizes its canvas from `selfLayer.clientWidth`, and a
      // display-none host measures 0x0, which would collapse every surface to nothing. Hidden preserves layout and
      // the ResizeObserver that watches it, and it does NOT stop the runtime rendering — gsw's loop gates on its
      // own dormancy/suspend attributes, never on visibility.
      //
      // Written on the HOST, never on `canvas.style.display`: gsw owns that property (the static-surface image
      // swap flips it), and a write here would fight the runtime.
      next.visibility = "hidden";
    }
    if (shader) {
      for (const key in shader.style) {
        if (key !== "filter") {
          next[key] = shader.style[key];
        }
      }
    }
    if (!shader?.attributes["data-godot-shader-webgl"]) {
      const tint = tintFilterUrl(record.tintR, record.tintG, record.tintB);
      const own = shader?.style.filter;
      const filter = own && tint ? `${own} ${tint}` : (own ?? tint);
      if (filter) {
        next.filter = filter;
      }
    }
    const cache = entry.hostStyle;
    for (const key in next) {
      if (cache.get(key) !== next[key]) {
        setStyleProp(entry.el, key, next[key]);
        cache.set(key, next[key]);
      }
    }
    if (cache.size !== Object.keys(next).length) {
      for (const key of [...cache.keys()]) {
        if (!(key in next)) {
          removeStyleProp(entry.el, key);
          cache.delete(key);
        }
      }
    }
  }

  /** gsw mounts its canvas into a child carrying ITS class — never a local string, or the runtime finds nothing. */
  function ensureSelfLayer(entry: OverlayEl, extraClass: string): HTMLElement {
    if (entry.selfLayer) {
      return entry.selfLayer;
    }
    const layer = doc.createElement("div");
    layer.className = `${SELF_LAYER_CLASS} ${extraClass}`;
    entry.el.appendChild(layer);
    entry.selfLayer = layer;
    return layer;
  }

  // --- per-kind content ----------------------------------------------------------------------------------------

  /**
   * DECLARE THE FACES, THEN THE CONTENT — and the bug that the first half being absent WAS.
   *
   * `textStyle` writes `font-family: "kreon_regular", sans-serif`. That is a REQUEST, and it resolves to the
   * fallback unless something has injected an `@font-face` pointing at the host's `/res/` copy of the binary. The
   * DOM backend does that from its own walk, so on that backend every label has always had its real typeface. This
   * backend does not run that walk — and nothing else called `ensureFontFace` either, so EVERY label the canvas
   * stage drew between M1 and this fix rendered in the browser's sans-serif fallback.
   *
   * It hid for two rounds because the obvious gate is blind to it: the bench's T-records report the font-family the
   * element REQUESTED, which was identical on both arms and reported 100% agreement while the arms looked visibly
   * different. What actually catches it is a headed capture, where the wrong typeface is the first thing you see.
   *
   * `ensureNodeFonts` is shared with the canvas rasterizer (see `fonts.ts`) and is keyed by family, so this is a
   * set lookup per label per build once a screen is warm.
   */
  function syncText(entry: OverlayEl, node: MirrorNode): void {
    const text = node.text;
    if (!text) {
      return; // the node stopped carrying text between the classification and here: leave the box empty
    }
    ensureNodeFonts(node);
    let div = entry.textDiv;
    if (!div) {
      div = doc.createElement("div");
      div.className = "mirror-text";
      entry.el.appendChild(div);
      entry.textDiv = div;
    }
    // `textStyle` is a fresh object per call and mixes camelCase DOM props with literal custom properties, so it
    // is applied through the same two-branch write the DOM backend uses. TWO caches in front of it, cheapest
    // first: the node's IDENTITY (an immutable node cannot have changed its style — see `textStyleNode`), and
    // behind that the JSON key, so a new node object carrying identical styles still costs no style write.
    if (entry.textStyleNode !== node) {
      entry.textStyleNode = node;
      const styles = textStyle(node);
      const key = JSON.stringify(styles);
      if (entry.textStyleKey !== key) {
        entry.textStyleKey = key;
        for (const [prop, value] of Object.entries(styles)) {
          if (prop.startsWith("--")) {
            div.style.setProperty(prop, value);
          } else {
            (div.style as unknown as Record<string, string>)[prop] = value;
          }
        }
      }
    }
    const rich = node.richText;
    if (entry.lastRich !== rich) {
      entry.lastRich = rich;
      entry.textInner = null;
      entry.lastText = null;
      entry.lastHtml = null;
      div.textContent = "";
    }
    let inner = entry.textInner;
    if (!inner) {
      inner = doc.createElement(rich ? "div" : "span");
      if (rich) {
        inner.className = "godot-scene-node godot-type-RichTextLabel mirror-rich";
        // Same sheet the DOM backend asks for. A label reaches this overlay on the canvas arm only when the
        // stage REFUSED it, and gsw's built-in effects are one of the refusals — so a hoisted label really can
        // be carrying animated markup, including an STS2 tag nested inside it.
        ensureRichTextEffectStyles(doc);
      }
      div.appendChild(inner);
      entry.textInner = inner;
    }
    if (rich) {
      const html = richHtml(node);
      if (entry.lastHtml !== html) {
        entry.lastHtml = html;
        inner.innerHTML = html;
      }
    } else if (entry.lastText !== text.text) {
      entry.lastText = text.text;
      inner.textContent = text.text;
    }
  }

  /**
   * Stamp a shader node's gsw binding, and hand the binding back so `syncHostStyle` can compose its STYLE.
   *
   * The style half is not optional decoration: `assignMaterialAttributes` puts `mix-blend-mode: plus-lighter` there
   * for a `CanvasItemMaterial` with `blend_mode = ADD`, and the HSV branch puts its `filter` there. Dropping it —
   * which this function used to do — silently downgraded every additively-blended surface to source-over.
   */
  function syncShader(
    entry: OverlayEl,
    node: MirrorNode,
    nodes: Map<string, MirrorNode>
  ): { changed: boolean; binding: MirrorShaderBinding | null } {
    const binding = nodeShaderAttributes(node, nodes);
    if (!binding) {
      // The node claims a WebGL shader but the binding declined it (a dormant ripple, an ineligible material).
      // Clearing the attributes is what tells gsw to drop the binding rather than keep rendering a stale one.
      return { changed: applyAttrs(entry, {}), binding: null };
    }
    const changed = applyAttrs(entry, binding.attributes);
    const layer = ensureSelfLayer(entry, "mirror-shader-self");
    if (binding.textureUrl && layer.getAttribute("data-godot-shader-texture-url") !== binding.textureUrl) {
      layer.setAttribute("data-godot-shader-texture-url", binding.textureUrl);
    }
    const fit = binding.selfLayerFit ?? "";
    if (layer.style.backgroundSize !== fit) {
      layer.style.backgroundSize = fit;
    }
    return { changed, binding };
  }

  function syncParticles(entry: OverlayEl, node: MirrorNode): boolean {
    const binding = nodeParticleAttributes(node);
    if (!binding) {
      return applyAttrs(entry, {});
    }
    const changed = applyAttrs(entry, {
      "data-godot-particle-runtime": "1",
      "data-godot-particle-specs": binding.specsJson
    });
    ensureSelfLayer(entry, "mirror-particle-self");
    return changed;
  }

  /**
   * Tell gsw how magnified this surface is, so it can size a backing store for the device pixels the
   * surface really covers rather than for its untransformed `clientWidth`. See `./fxPixelRatio` for
   * the whole law — axis not AABB, fit excluded, magnification only, quantised to 1/8, at rest only.
   *
   * A surface with no self-layer is one gsw has no binding for (a declined material, a null particle
   * spec); there is nothing to size and nowhere to write. Its gate is still stepped, so a binding
   * that comes back does not inherit a stale "unchanged since last build".
   */
  function syncFxPixelRatio(entry: OverlayEl, record: OverlayRecord): void {
    const next = fxPixelRatioAttrValue(fxAxisScale(record.transform));
    const write = fxPixelRatioWrite(entry.fxPixelRatio, next);
    const layer = entry.selfLayer;
    if (write === undefined || layer === null) {
      return;
    }
    if (write === null) {
      // ABSENT, not "1": an absent attribute is gsw's byte-identical off-switch, and leaving a
      // literal "1" behind would keep every later sweep comparing a string that means nothing.
      layer.removeAttribute(FX_PIXEL_RATIO_ATTR);
      return;
    }
    layer.setAttribute(FX_PIXEL_RATIO_ATTR, write);
  }

  // --- spine ---------------------------------------------------------------------------------------------------
  //
  // The DOM backend's two mechanisms, kept: a SINGLE-frame clip is an `<img>` on the clip's own still object url
  // (no composited canvas layer at all), a multi-frame one is a `<canvas>` the frames are blitted into. What is
  // NOT kept is the rest of that machinery — the still→animated hot swap, the skeleton-fallback retry, the budget
  // escalation, the promotion pass and the decode gate all live on `RenderRecord` and are coupled to the DOM
  // walk. See the module header for the honest statement of that gap.

  function syncSpine(entry: OverlayEl, node: MirrorNode): void {
    // A node can be a "spine" overlay for TWO reasons now (see `paintSpec.overlayKindOf`): it plays a clip, or it
    // is a creature/merchant rig on the hard-off tier that exists only to host the stand-in. The second kind must
    // request NOTHING — that tier's whole contract is that no clip is fetched — so every line below the gate is
    // reached only by the first.
    if (isSpineClipNode(node)) {
      const url = spineClipUrl(node, { still: isSpineStillMode() });
      // A static raster URL can be identical to auto's still-tier URL. Release independently of URL identity so
      // a live mode switch never leaves geometry mounted above the raster still.
      const geoclipEnabled = isGeoclipPlaybackEnabled();
      if (!geoclipEnabled) {
        releaseGeoclip(entry);
      }
      entry.spinePaused = node.spinePaused;
      entry.spineLooping = node.spineLooping;
      if (url !== entry.spineUrl) {
        releaseSpine(entry);
        entry.spineUrl = url;
        entry.spineTrackMs = Math.max(0, node.spineTrackTime * 1000);
        entry.spineWallMs = now();
        if (url) {
          // The creature stand-in's grace period starts beside the request it waits on — see the DOM twin in
          // `spineLayerController`. A previous identity's failure latch is cleared with it.
          armPlaceholder(entry);
          const generation = entry.spineGeneration;
          const fetchRaster = (): void => {
            void loadSpineClip(url, { stillImg: true })
              .then((clip) => {
                if (disposed || entry.spineGeneration !== generation || entry.spineUrl !== url) {
                  // A NEWER clip won the race. Deliberately NOT released: this entry never retained it, and the
                  // refcount belongs to whoever is painting it. The cache still holds it, so the next request for
                  // the same url is free and an eviction can close it normally.
                  return;
                }
                setSpineClip(entry, clip);
                refreshSpinePlaying(entry);
                mountSpine(entry);
              })
              .catch(() => {
                // A clip the host cannot bake used to leave the node empty, exactly as it left the DOM backend's
                // node empty. It is now the latch that makes a creature's stand-in permanent instead.
                if (disposed || entry.spineGeneration !== generation || entry.spineUrl !== url) {
                  return; // a stale identity's failure says nothing about the one on screen
                }
                entry.placeholderFailed = true;
                syncPlaceholder(entry, node);
              });
          };
          fetchRaster();
        }
      }
      // Keep this independent of the raster URL: auto on a still-only tier and static both ask for `&still=1`,
      // while only auto is an explicit geometry opt-in. Existing state is the per-identity latch, so an unchanged
      // routine reconcile neither re-probes nor replaces a pending upload.
      if (geoclipEnabled && entry.geoclipState === null && !entry.geoclipDisabled) {
        armGeoclip(entry, node);
      }
      // A pause/unpause can flip the demand without changing the clip at all (the treasure chest freezes its own
      // track), so the playing set is re-derived on every sync rather than only at load.
      refreshSpinePlaying(entry);
      if (entry.spineClip) {
        mountSpine(entry);
      }
    } else {
      releaseGeoclip(entry);
    }
    syncPlaceholder(entry, node);
  }

  // --- creature placeholder --------------------------------------------------------------------------------------
  //
  // The canvas twin of `renderer/dom/spineLayerController`'s half, sharing the same policy module: same grace
  // period, same permanence rules, same `.mirror-spine-placeholder` element and therefore the same one CSS rule.
  // It belongs in the overlay rather than in the draw list because that is where this backend already paints a
  // spine still — an `<img>` in the node's own overlay element — so the stand-in lands in exactly the slot the
  // art it substitutes for would have taken.

  function clearPlaceholderTimer(entry: OverlayEl): void {
    if (entry.placeholderTimer !== null) {
      clearTimeout(entry.placeholderTimer);
      entry.placeholderTimer = null;
    }
  }

  function detachPlaceholder(entry: OverlayEl): void {
    if (entry.placeholderImg === null) {
      return;
    }
    entry.placeholderImg.remove();
    entry.placeholderImg = null;
    entry.placeholderKey = null;
  }

  function resetPlaceholder(entry: OverlayEl): void {
    clearPlaceholderTimer(entry);
    detachPlaceholder(entry);
    entry.placeholderArmedMs = null;
    entry.placeholderFailed = false;
  }

  function armPlaceholder(entry: OverlayEl): void {
    clearPlaceholderTimer(entry);
    entry.placeholderArmedMs = now();
    entry.placeholderFailed = false;
  }

  /** Spine pixels committed on this entry — retires the stand-in and stops it coming back for this identity. */
  function noteSpineArtPainted(entry: OverlayEl): void {
    if (entry.spineArtPainted) {
      return;
    }
    entry.spineArtPainted = true;
    clearPlaceholderTimer(entry);
    detachPlaceholder(entry);
  }

  function syncPlaceholder(entry: OverlayEl, node: MirrorNode): void {
    if (!isCreaturePlaceholderNode(node)) {
      resetPlaceholder(entry);
      return;
    }
    // PIXELS ON SCREEN BEAT EVERYTHING — see the DOM twin in `spineLayerController` for why the failure latch
    // does not get to cover a creature whose previous animation is still painting.
    if (entry.spineArtPainted) {
      clearPlaceholderTimer(entry);
      detachPlaceholder(entry);
      return;
    }
    if (!entry.placeholderFailed && !creatureArtIsUnavailable(node)) {
      if (entry.placeholderArmedMs === null) {
        clearPlaceholderTimer(entry);
        detachPlaceholder(entry);
        return;
      }
      const remaining = entry.placeholderArmedMs + CREATURE_PLACEHOLDER_DELAY_MS - now();
      if (remaining > 0) {
        detachPlaceholder(entry);
        if (entry.placeholderTimer === null) {
          entry.placeholderTimer = setTimeout(() => {
            entry.placeholderTimer = null;
            // Re-read the node: the deadline outlives the build that armed it, and the box is resolved from the
            // live map either way. A node that has left the scene has no entry to paint into any more.
            const fresh = liveNodes?.get(entry.id);
            if (!disposed && fresh !== undefined && elements.get(entry.id) === entry) {
              syncPlaceholder(entry, fresh);
            }
          }, remaining);
        }
        return;
      }
    }
    clearPlaceholderTimer(entry);
    const box = liveNodes === null ? null : creaturePlaceholderBox(liveNodes, childrenOfLazy, node);
    if (box === null) {
      // The creature's box has not streamed yet. Paint nothing and ask again next build rather than guessing.
      detachPlaceholder(entry);
      return;
    }
    let img = entry.placeholderImg;
    if (img === null) {
      img = doc.createElement("img");
      img.className = CREATURE_PLACEHOLDER_CLASS;
      img.decoding = "async";
      img.alt = "";
      img.src = mirrorResourceUrl(CREATURE_PLACEHOLDER_RES);
      entry.el.appendChild(img);
      entry.placeholderImg = img;
      entry.placeholderKey = null;
    }
    // The box is already in the spine node's own local units, so the entry element's matrix supplies the rig
    // scale and no `scale()` belongs here. `object-fit: fill` (the shared CSS rule) does the stretching.
    const key = creaturePlaceholderKey(box);
    if (entry.placeholderKey !== key) {
      entry.placeholderKey = key;
      img.style.width = `${box.width}px`;
      img.style.height = `${box.height}px`;
      img.style.transform = `translate(${box.x}px, ${box.y}px)`;
    }
    // Deliberately NO `onSpineReady`. That signal exists to wake the stage for pixels the CANVAS owes — a clip
    // frame to blit, a still to upload as a quad. The stand-in is a composited `<img>` the browser paints on its
    // own, and this runs on every build while it is up, so arming a local paint here would hold a settled screen
    // awake for the entire time a creature is missing.
  }

  function mountSpine(entry: OverlayEl): void {
    const clip = entry.spineClip;
    if (!clip) {
      return;
    }
    const scale = clip.canvasWidth > 0 && clip.localWidth > 0 ? clip.localWidth / clip.canvasWidth : 1;
    const asImg = clip.frames.length === 1 && clip.stillUrl !== null;
    if (asImg) {
      mountStill(entry, clip, scale);
    } else {
      let canvas = entry.spineCanvas;
      if (!canvas) {
        canvas = doc.createElement("canvas");
        canvas.className = "mirror-spine-canvas";
        entry.el.appendChild(canvas);
        entry.spineCanvas = canvas;
        entry.spineCtx = canvas.getContext("2d");
      }
      const w = Math.max(1, Math.round(clip.canvasWidth));
      const h = Math.max(1, Math.round(clip.canvasHeight));
      const key = `${w}x${h}|${clip.localX},${clip.localY},${scale}`;
      if (entry.spinePlacementKey !== key) {
        entry.spinePlacementKey = key;
        canvas.width = w;
        canvas.height = h;
        canvas.style.transform = `translate(${clip.localX}px, ${clip.localY}px) scale(${scale})`;
        entry.spineShownFrame = -1; // sizing a canvas clears it
      }
      const before = entry.spineShownFrame;
      drawSpineFrame(entry, now());
      if (before === -1 && entry.spineShownFrame !== -1) {
        // FIRST frame of a clip that arrived asynchronously. Without this the renderer never learns that a playing
        // clip joined the set, so nothing ticks it until the next wire delta happens along.
        options?.onSpineReady?.(entry.id);
      }
    }
    // …AND THE DEV GEOCLIP, after the baked layer either way. This is the one place in this backend that knows the
    // baked clip's placement, and that placement IS the geoclip's skeleton-local → canvas-pixel mapping, so it is
    // where a geoclip can first mount and where a re-placement has to reach it.
    syncGeoclipPlacement(entry, clip);
  }

  /**
   * This entry's PLAYBACK time at `nowMs` — the one clock both the painter and the scheduler read.
   *
   * A PAUSED track holds the last streamed authoritative time: the game froze it, so advancing off the wall clock
   * would walk a closed chest open.
   */
  function spinePlayMs(entry: OverlayEl, nowMs: number): number {
    return entry.spinePaused ? entry.spineTrackMs : entry.spineTrackMs + (nowMs - entry.spineWallMs);
  }

  /**
   * A still's ENCODED bytes as a Blob, for a caller that wants to decode pixels it will own. Null where there is
   * no `Blob` at all (jsdom's pure-parse path), which the caller reads as "keep using the `<img>`".
   *
   * `slice()` copies out of the wire message's shared buffer, exactly as `spineClip` does when it mints the object
   * url: a Blob over a subarray would pin the whole message for as long as anything holds it.
   */
  function stillBlob(frame: DecodedSpineClipFrame): Blob | null {
    if (typeof Blob === "undefined") {
      return null;
    }
    try {
      return new Blob([frame.png.slice()], { type: imageMime(frame.png) });
    } catch {
      return null;
    }
  }

  /** The live `<img>`, created on first use. Deliberately lazy: an entry with no pixels yet has no element. */
  function ensureSpineImg(entry: OverlayEl): HTMLImageElement {
    let img = entry.spineImg;
    if (!img) {
      img = doc.createElement("img");
      img.className = "mirror-spine-img";
      // SYNC on the live element (the probe below is the async one): the swap has to present atomically, in the
      // frame it is written, or the gate would have bought nothing.
      img.decoding = "sync";
      entry.el.appendChild(img);
      entry.spineImg = img;
    }
    return img;
  }

  function applyStillPlacement(img: HTMLImageElement, w: number, h: number, tx: number, ty: number, scale: number): void {
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  /**
   * DECODE BEFORE SWAP — the still half of `mountSpine`, and the reason it is not three lines.
   *
   * `img.src = <fresh blob url>` on a live, already-painting element drops the old bitmap the moment the request
   * completes, and Chromium's raster is lazy: a 0.5-3 MP WebP then takes several frames to decode, during which
   * the element paints NOTHING. Every creature animation change — idle → attack → hurt → idle, which is the STS2
   * combat loop and is in the combat recording — therefore flashed the character invisible, and because the
   * placement was written synchronously the interim also showed the OLD frame at the NEW size. `stillDecode` is
   * the DOM backend's fix for exactly this, and it fails open (no `HTMLImageElement.decode`, or a decode that
   * rejects, still commits) so the gate can never freeze a creature on a stale pose.
   *
   * Three cases, in order: the url is already on screen (a pure placement write — waiting for anything there
   * would be a visible lag on every reconcile), a decode for it is already in flight (dedupe, or a busy screen
   * multiplies probes), and a NEW url (decode, then commit, re-checking that the world has not moved on).
   */
  function mountStill(entry: OverlayEl, clip: LoadedSpineClip, scale: number): void {
    const url = clip.stillUrl as string;
    const still = clip.frames[0];
    const w = Math.max(1, Math.round(still.width));
    const h = Math.max(1, Math.round(still.height));
    const tx = clip.localX + still.offsetX * scale;
    const ty = clip.localY + still.offsetY * scale;
    const key = `img|${w}x${h}|${tx},${ty},${scale}`;

    if (entry.spineImg && entry.spineImgUrl === url) {
      if (entry.spinePendingStillUrl === url) {
        entry.spinePendingStillUrl = null; // already on screen — nothing left to gate
      }
      if (entry.spinePlacementKey !== key) {
        entry.spinePlacementKey = key;
        applyStillPlacement(entry.spineImg, w, h, tx, ty, scale);
      }
      return;
    }
    if (entry.spinePendingStillUrl === url) {
      return;
    }
    entry.spinePendingStillUrl = url;
    decodeStill(url, () => {
      // The commit re-checks everything that could have moved while the decode ran: the entry is still gated on
      // THIS url (no newer swap started), it is still painting THIS clip (no identity change), and the overlay is
      // still alive. `ok` is deliberately ignored — see the fail-open note above.
      if (disposed || entry.spinePendingStillUrl !== url || entry.spineClip !== clip) {
        return;
      }
      entry.spinePendingStillUrl = null;
      const img = ensureSpineImg(entry);
      entry.spineImgUrl = url;
      img.src = url;
      entry.spinePlacementKey = key;
      applyStillPlacement(img, w, h, tx, ty, scale);
      // The DISPLAYED clip is retained apart from `spineClip`, which is swapped the instant a newer one arrives.
      setSpineShownStill(entry, clip);
      noteSpineArtPainted(entry); // real pixels are on screen — retire any creature stand-in
      options?.onSpineReady?.(entry.id);
    });
  }

  function drawSpineFrame(entry: OverlayEl, nowMs: number): void {
    if (entry.geoclipState?.node) {
      // GEOCLIP: this node's pixels come from baked GEOMETRY rather than the baked raster clip, and the baked
      // layer beneath it is hidden by `.mirror-geoclip-live`. Same clock, same loop flag, same pause rule — only
      // the painter differs, so a mid-animation fallback to the baked path does not jump.
      drawGeoclip(entry, nowMs);
      return;
    }
    const clip = entry.spineClip;
    const ctx = entry.spineCtx;
    const canvas = entry.spineCanvas;
    if (!clip || !ctx || !canvas) {
      return;
    }
    const playMs = spinePlayMs(entry, nowMs);
    const index = frameIndexAt(clip, playMs, entry.spineLooping);
    if (index === entry.spineShownFrame) {
      return;
    }
    entry.spineShownFrame = index;
    const frame = clip.frames[index];
    if (!frame || !frame.bitmap) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame.bitmap, frame.offsetX, frame.offsetY);
    noteSpineArtPainted(entry); // ditto — a blitted frame retires the creature stand-in
  }

  // --- geoclip playback ------------------------------------------------------------------------------------
  //
  // See the block above `GeoclipEntryState` for what this is and the four rules it keeps.

  /**
   * Arm a probe for the spine identity this entry just committed to.
   *
   * ONE probe per manifest url per SESSION — `geoclipPlayer` caches MISSES too — so an animation with no geoclip
   * costs exactly one 404 no matter how many creatures play it or how often they switch back to it.
   */
  function armGeoclip(entry: OverlayEl, node: MirrorNode): void {
    if (entry.geoclipDisabled) {
      return;
    }
    const manifestUrl = geoclipUrl(node, "manifest.json");
    if (!manifestUrl) {
      return;
    }
    // Sibling artifacts (page/sheet PNGs, verts.bin) are addressed through the SAME builder, so they inherit the
    // scene/node/anim selectors verbatim — a geoclip url is never assembled by string surgery on another one.
    const resolve = (file: string): string => geoclipUrl(node, file) ?? file;
    const state: GeoclipEntryState = { manifestUrl, clip: null, gpu: null, node: null, frame: -1 };
    entry.geoclipState = state;
    void probeGeoclip(manifestUrl, resolve).then((clip) => {
      if (disposed || entry.geoclipState !== state || entry.geoclipDisabled) {
        return; // torn down, switched away, or already reverted
      }
      if (!clip) {
        return;
      }
      state.clip = clip;
      void uploadGeoclip(clip).then((gpu) => {
        if (disposed || entry.geoclipState !== state || entry.geoclipDisabled) {
          return;
        }
        if (!gpu) {
          // No WebGL2, a page that would not load, a clip with nothing uploadable in it. `uploadGeoclip` has
          // already named the cause on the shared channel; this node is permanently baked from here.
          disableGeoclip(entry, `${manifestUrl}: nothing uploadable`);
          return;
        }
        state.gpu = gpu;
        // The clip's own placement (if it stated one) needs nothing else, and the baked clip is usually ALREADY on
        // screen besides (a still lands long before this resolves) — either way the geoclip can take over on this
        // tick rather than waiting for the next reconcile.
        syncGeoclipPlacement(entry, entry.spineClip);
      });
    });
  }

  /**
   * Mount (or re-place) this entry's geoclip. Called from `mountSpine` — the one place the baked geometry is known
   * — and from the upload arrival above.
   *
   * TWO PLACEMENT SOURCES, and a placement is taken from ONE of them whole (never mixed): the element is sized to
   * `canvasWidth x canvasHeight` and mapped into node-local by the SAME rect the fit inverts, so a box from one
   * source with a fit from the other would land the creature somewhere plausible and wrong. The manifest wins
   * where it exists, and `baked` may be null — which is what lets a geoclip mount with no raster clip at all.
   */
  function syncGeoclipPlacement(entry: OverlayEl, baked: LoadedSpineClip | null): void {
    const state = entry.geoclipState;
    if (!state || !state.clip || !state.gpu || entry.geoclipDisabled) {
      return;
    }
    const placement: GeoclipPlacement | null =
      geoclipPlacementFromManifest(state.clip) ??
      (baked
        ? {
            canvasWidth: baked.canvasWidth,
            canvasHeight: baked.canvasHeight,
            localX: baked.localX,
            localY: baked.localY,
            localWidth: baked.localWidth
          }
        : null);
    if (!placement) {
      return; // no manifest placement and no baked clip yet — nothing knows where the skeleton sits
    }
    if (state.node) {
      state.node.place(placement);
    } else {
      const mounted = createGeoclipNode(state.clip, state.gpu, placement);
      if (!mounted) {
        disableGeoclip(entry, `${state.manifestUrl}: no paint element`);
        return;
      }
      state.node = mounted;
      state.frame = -1;
      // Appended LAST, after whichever baked mechanism this entry mounted. The class is what hides that mechanism
      // (`.mirror-geoclip-live > .mirror-spine-canvas|.mirror-spine-img`), so the two can never both paint.
      entry.el.appendChild(mounted.el);
      entry.el.classList.add(GEOCLIP_LIVE_CLASS);
      noteSpineArtPainted(entry); // geometry is mounted — retire the creature stand-in with it
      // THE ANTI-DOUBLE-DRAW HALF OF THE BOOKKEEPING. `spineQuads()` now answers differently for this entry (it
      // is excluded), and the renderer banks that map's version at build time to decide whether its frame-level
      // patch may reuse the last list. Without the bump the stage could keep painting the baked still as a quad
      // from a list built before the geoclip existed.
      spineQuadVersionCounter++;
      // …and the anti-freeze half: for a MULTI-frame geoclip `clipAnimates` now says yes, so this re-derivation is
      // what puts the entry in the playing set, and `onSpineReady` is what wakes the renderer's animation arm for
      // a mount that happened asynchronously, long after the build that asked for it (the DOM arm's
      // `scheduleTick`). For a ONE-FRAME geoclip it correctly says no, the entry stays out of the set and the
      // `drawGeoclip` below is the only paint it will ever cost — but `onSpineReady` still fires, because the
      // renderer has to service the mount itself once even when nothing is owed a second frame.
      refreshSpinePlaying(entry);
      options?.onSpineReady?.(entry.id);
    }
    drawGeoclip(entry, now());
  }

  function drawGeoclip(entry: OverlayEl, nowMs: number): void {
    const state = entry.geoclipState;
    if (!state?.node || !state.clip) {
      return;
    }
    // The same clock the baked path reads, including the paused-track rule — see `spinePlayMs`.
    const index = geoclipFrameIndexAt(
      state.clip,
      spinePlayMs(entry, nowMs),
      entry.spineLooping
    );
    if (index === state.frame) {
      return;
    }
    state.frame = index;
    if (!state.node.draw(index)) {
      disableGeoclip(entry, `${state.manifestUrl}: draw failed`);
    }
  }

  /**
   * THE ONE-WAY REVERT. Drops the geoclip, un-hides the baked layer and forces it to repaint the frame it would
   * have shown, so the swap back is a frame change rather than a blank gap.
   *
   * Every failure on this path lands here — a probe that threw, an upload that could not be made, a paint element
   * that could not be created, a draw that failed (a lost context) — and each is named once per session on
   * `geoclipPlayer`'s own channel, which is deliberately latched: a bake nobody has built must not print a line
   * per creature per animation change.
   */
  function disableGeoclip(entry: OverlayEl, reason: string): void {
    entry.geoclipDisabled = true;
    noteGeoclipFailure(reason);
    releaseGeoclip(entry);
    entry.spineShownFrame = -1;
    entry.spinePlacementKey = null;
    if (entry.spineClip) {
      // Re-mounts the baked layer at its own placement and paints the frame the clock is on. Cannot recurse: the
      // state is gone, so `syncGeoclipPlacement` returns at its first guard.
      mountSpine(entry);
    }
  }

  /**
   * Drop this entry's geoclip element + state (an identity change, a teardown, a revert). `geoclipDisabled` is
   * NOT cleared here: it outlives every element this node will ever have.
   */
  function releaseGeoclip(entry: OverlayEl): void {
    const state = entry.geoclipState;
    if (!state) {
      return; // the shipped configuration: one null check on the spine teardown path, and nothing else
    }
    entry.geoclipState = null;
    if (state.node) {
      state.node.dispose();
      entry.el.classList.remove(GEOCLIP_LIVE_CLASS);
      spineQuadVersionCounter++; // the baked still is quad-able again — the mirror of the bump at mount
    }
    // The entry may have been in the playing set ONLY because of the geoclip (a single-frame baked still), so the
    // membership has to be re-derived here rather than left to the caller.
    refreshSpinePlaying(entry);
  }

  // --- ordering ------------------------------------------------------------------------------------------------

  /**
   * Put the container's children in draw order and drop everything the build did not name.
   *
   * One pass with a cursor: an element already in the right place advances the cursor, one that is not is moved
   * before it. Whatever is left from the cursor onward was not in this build, so it is removed — which makes the
   * removal set fall out of the ordering rather than needing a second diff.
   */
  function syncOrder(wanted: OverlayEl[]): void {
    let cursor = container.firstChild;
    for (const entry of wanted) {
      if (cursor === entry.el) {
        cursor = entry.el.nextSibling;
        continue;
      }
      container.insertBefore(entry.el, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      const id = cursor instanceof Element ? cursor.getAttribute("data-node-id") : null;
      const stale = id !== null ? elements.get(id) : undefined;
      if (stale) {
        destroyEl(stale);
      } else {
        container.removeChild(cursor);
      }
      cursor = next;
    }
  }

  function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  /** Are these records already in `order`? One scan, no allocation — see the call site in `reconcile`. */
  function ascendingByOrder(records: readonly OverlayRecord[]): boolean {
    for (let i = 1; i < records.length; i++) {
      if (records[i].order < records[i - 1].order) {
        return false;
      }
    }
    return true;
  }

  // --- the handle ----------------------------------------------------------------------------------------------

  return {
    container,

    reconcile(records, nodes, fx) {
      counts.text = 0;
      counts.shader = 0;
      counts.particles = 0;
      counts.spine = 0;
      counts.trail = 0;
      counts.withheld = 0;
      counts.fxHidden = 0;
      counts.fxDeclined = 0;
      counts.textHoisted = 0;
      counts.clipped = 0;
      counts.clipEmpty = 0;
      counts.clipPolygon = 0;
      counts.backstopWithheld = 0;
      counts.coveredText = 0;
      counts.coveredSpine = 0;
      // Latch the build's scene for the creature stand-in, and drop the previous build's child index with it —
      // the map is mutated in place, so identity cannot be trusted to invalidate the derived one.
      liveNodes = nodes;
      childIndex = null;
      // PRESENCE IS THE FLAG — see `OverlayFxSource`. Hoisted once so the flag-off path reads exactly as it did.
      const fxCanvas = fx != null;
      let shaderDirty = false;
      let particleDirty = false;
      // The builder emits records in paint order already (it pushes them during the walk), but the contract is
      // the `order` field, so the sort is what this module actually depends on — and the sort is therefore, on
      // every build we have ever measured, a copy plus an O(n log n) confirmation that nothing needed moving.
      // Checking is one linear scan of a number, and the answer is the same array when it passes: `sort` is
      // stable, so an already-ascending run (ties included) is its own sorted order. A builder that ever DID emit
      // out of order still gets sorted; this only removes the work when it did not.
      const sorted = records.length > 1 && !ascendingByOrder(records) ? [...records].sort((a, b) => a.order - b.order) : records;
      const wanted: OverlayEl[] = [];

      for (const record of sorted) {
        const node = nodes.get(record.id);
        if (!node) {
          continue;
        }
        counts[record.kind]++;
        const fxKind = HOIST_GATED_KINDS.has(record.kind);
        // Under the flag: is this surface's paint IN THE DRAW LIST this build? That single fact decides both
        // whether the host may still composite and whether the hoist rule still has a job here.
        let drawnAsQuad = false;
        if (fxKind && fxCanvas) {
          // THE HOIST RULE IS INERT for a surface the draw list paints: `coveredAbove` asks "would hoisting this
          // hide game content?", and nothing is being hoisted. `withheld` therefore goes to 0 on a screen whose
          // effects are all in the list, which is M2's acceptance number.
          if (fx.declined(record.id)) {
            // …EXCEPT for a surface the registry REFUSED (SCREEN_TEXTURE policy, over MAX_TEXTURE_SIZE, a source
            // the driver would not take). There will never be a quad for it, so keeping the host would leave gsw
            // compositing a full-screen canvas above the whole stage — the water-reflection bug, reintroduced by
            // the fix for it. Dropped exactly like a withholding (no element ⇒ gsw unbinds the runtime ⇒ it stops
            // rendering something nothing shows), and counted SEPARATELY: a policy refusal is not a hoist
            // withholding and must not be able to inflate or deflate that number. `fx.declined` is the same fact
            // from the registry's side.
            counts.fxDeclined++;
            continue;
          }
          drawnAsQuad = fx.drawn(record.id);
          if (!drawnAsQuad && record.coveredAbove) {
            // …BUT THE ELEMENT STAYS. A surface with no pixels yet — gsw has not drawn it, or the governor has
            // not uploaded its first frame — is exactly the case the hoist rule was written for, and withholding
            // it the old way would DEADLOCK the fix: no element means gsw never renders it, which means it never
            // gets pixels, which means it never becomes a quad. So the host is kept (gsw keeps painting into it)
            // and merely stops compositing, below. The count still says what it always said.
            counts.withheld++;
          }
        } else if (fxKind && record.coveredAbove) {
          // THE HOIST RULE (see the module header). The game paints over this surface and the overlay cannot
          // reproduce that, so the surface is withheld rather than hoisted over the content that covers it. No
          // element is created (or kept: `syncOrder` sweeps one that existed last build), so gsw drops any runtime
          // it had bound here and the node renders exactly as it does under `?shaders=off` — nothing.
          counts.withheld++;
          continue;
        }
        if (record.kind === "text" && textDrawnIds !== null) {
          if (textDrawnIds.has(record.id)) {
            // THE CANVAS OWNS THIS LABEL'S PIXELS (M4), so it must not also have an element — compositing the
            // same words twice, once at the node's paint index and once above the entire stage, is the exact
            // double-paint the fx path had to be fixed for.
            //
            // Dropped like a TRAIL rather than hidden like an fx host or a spine `<img>`, and the distinction is
            // real: a gsw host must survive because the runtime renders INTO it, and a spine element IS the
            // pixels the quad uploads from. A label's element is neither — the raster comes from a scratch canvas
            // this module never sees — so there is nothing to keep alive. `continue` before `createEl` means a
            // label that becomes canvas-drawn simply stops being named, and `syncOrder`'s sweep destroys the
            // element it had last build for free.
            continue;
          }
          // …and the honest residue: a label the canvas REFUSED (rich, a balanced reward row, a paced raster, a
          // face still loading) keeps its element and renders exactly as it does today. Counted, because "the
          // lever is on" and "the lever is on and drawing nothing" must not read the same in a census.
          counts.textHoisted++;
        }
        if (record.kind === "trail") {
          // A TRAIL HAS NO OVERLAY ELEMENT ON THIS BACKEND, and since M3 it does not want one: the ribbon is a
          // run of QUADS in the draw list (`paintSpec.emitTrailQuads`, fed by `cardTrailState`), drawn at the
          // stroke's own paint index rather than composited above the whole stage. So this is not the withheld
          // decoration it used to be — it is the record whose pixels are already downstairs.
          //
          // Deliberately NOT a `drawn`-gated hide like the fx and spine kinds take. Those have an element that
          // must stop compositing once the canvas owns its pixels; this one has never had an element at all, so
          // there is nothing to hide and no state in which the same light is drawn twice.
          //
          // The count still says what it always said: a trail node is an overlay node, whatever draws it.
          continue;
        }
        // R2 — THE GAME PAINTED SOMETHING OPAQUE OVER THIS SURFACE. Text loses its element outright (the TRAIL
        // rule: nothing renders into a label's element, so there is nothing to keep alive); a spine keeps its
        // `<img>` and merely stops compositing, because that element IS the pixels and a quad may be uploading
        // from it. The two gsw runtime kinds are deliberately untouched: their pixels are in the draw list under
        // the default, so the canvas has already put them in the right order.
        //
        const backstopped =
          backstopOrder !== null &&
          record.order < backstopOrder &&
          (record.kind === "text" || record.kind === "spine");
        if (backstopped) {
          counts.backstopWithheld++;
          if (record.kind === "text") {
            continue;
          }
        }
        let entry = elements.get(record.id);
        if (entry && entry.kind !== record.kind) {
          // A node that changed kind (a shader that became text) cannot reuse its element's sub-layers.
          destroyEl(entry);
          entry = undefined;
        }
        if (!entry) {
          entry = createEl(record, nodes);
          elements.set(record.id, entry);
          if (record.kind === "shader") {
            shaderDirty = true;
          } else if (record.kind === "particles") {
            particleDirty = true;
          }
        }
        syncPlacement(entry, record);
        syncClip(entry, record);
        if (record.clip !== null) {
          // Counted off the RECORD, not off the write: the numeric cache above skips the string for a crop that
          // did not move, and a census row that fell to zero on a settled screen would say the fix had stopped.
          counts.clipped++;
          if (!(record.clip.w > 0) || !(record.clip.h > 0)) {
            counts.clipEmpty++;
          } else if (record.transform[1] !== 0 || record.transform[2] !== 0) {
            counts.clipPolygon++;
          }
        }
        let shader: MirrorShaderBinding | null = null;
        switch (record.kind) {
          case "text":
            syncText(entry, node);
            break;
          case "shader": {
            const result = syncShader(entry, node, nodes);
            shaderDirty = result.changed || shaderDirty;
            shader = result.binding;
            break;
          }
          case "particles":
            particleDirty = syncParticles(entry, node) || particleDirty;
            break;
          case "spine":
            syncSpine(entry, node);
            break;
        }
        // THE MAGNIFICATION, stamped on the SELF-LAYER for both fx families (gsw reads one attribute
        // name from one element whichever runtime picks the node up). AFTER the switch, because it
        // is `syncShader`/`syncParticles` that own `entry.selfLayer` — a surface whose binding was
        // declined has none, and stamping a node gsw is not rendering would be writing to nobody.
        //
        // Ungated by kind beyond that: `record.transform` is the accumulated design-space placement
        // for every overlay kind, and the gate below writes nothing at all for the overwhelmingly
        // common 1:1 case, so an unmagnified screen costs one `Math.hypot` pair per fx record.
        if (record.kind === "shader" || record.kind === "particles") {
          syncFxPixelRatio(entry, record);
        }
        // PER ELEMENT, and fx kinds only. NEVER the container — the text of the whole screen lives in there, and
        // hiding it would blank every label.
        //
        // THE RULE IS "the draw list has it, OR the hoist rule would have hidden it anyway", which makes the flag
        // strictly no worse than turning it off, case by case:
        //   * drawn as a quad          -> hide: the canvas owns those pixels, and compositing them a SECOND time
        //                                 above the whole stage is the exact bug this replaces.
        //   * no quad yet, COVERED     -> hide: flag-off withholds this surface outright, so hiding it shows the
        //                                 same nothing — without the deadlock of withholding the element itself.
        //   * no quad yet, not covered -> SHOW: flag-off hoists it and that hoist is CORRECT (nothing paints over
        //                                 it). Hiding it here would make the flag lose an effect, which is the
        //                                 one thing turning M2 on must never do.
        // …and the SPINE twin of the same rule (A2). A creature the draw list painted must stop compositing; one
        // it did not — a clip still loading, a refused upload, a still whose node the cover pass found nothing
        // over — keeps its `<img>`, which is the pre-A2 behaviour and is why a refusal here can never lose a
        // creature. Keyed on DRAWN alone: unlike a gsw surface there is no "pixels have not arrived yet" state to
        // withhold for, because the `<img>` IS the pixels.
        //
        // …EXCEPT WHERE A GEOCLIP IS PAINTING THIS CREATURE. `setSpineDrawn` carries the LAST build's ids, so for
        // exactly one build after a geoclip mounts they can still name a node whose still `spineQuads()` no longer
        // offers. Hiding the host on that stale answer would hide the geoclip canvas INSIDE it — a creature that
        // vanishes for a frame, which is the one outcome this whole path is built to make impossible. The version
        // bump at mount is what ends the lag; this is what makes the lag harmless.
        const geoclipLive = entry.geoclipState?.node != null;
        const quadHidden =
          (fxKind && fxCanvas && (drawnAsQuad || record.coveredAbove)) ||
          (record.kind === "spine" && spineDrawnIds !== null && spineDrawnIds.has(record.id) && !geoclipLive);
        const hideHost = quadHidden || backstopped;
        if (quadHidden) {
          // COUNTED ON ITS OWN CAUSE. `fxHidden` means "a draw-list quad paints this surface instead", and
          // folding the backstop's hides in made it a sum of two unrelated facts — so on a dialog screen it read
          // as the M2/A2 wiring hiding forty surfaces it had never drawn. The backstop's own population is
          // `backstopWithheld`.
          counts.fxHidden++;
        }
        if (!hideHost && record.coveredAbove) {
          // THE RESIDUAL — see {@link OverlayCounts.coveredText}. Read off the RECORD and the final hide decision,
          // after every rule above has had its say, so it counts what is actually on screen in the wrong order
          // rather than what some rule intended.
          if (record.kind === "text") {
            counts.coveredText++;
          } else if (record.kind === "spine") {
            counts.coveredSpine++;
          }
        }
        syncHostStyle(entry, record, shader, hideHost, 1);
        wanted.push(entry);
      }

      const before = elements.size;
      syncOrder(wanted);
      if (elements.size !== before) {
        // A teardown detaches whatever gsw had bound to that element, so both runtimes have to re-scan.
        shaderDirty = true;
        particleDirty = true;
      }
      counts.elements = elements.size;
      return { shaderDirty, particleDirty, counts: { ...counts } };
    },

    tickSpine(nowMs) {
      if (playingSpine === 0) {
        return;
      }
      for (const entry of elements.values()) {
        if (entry.spinePaused) {
          continue;
        }
        if (entry.geoclipState?.node) {
          // GEOCLIP. Reached SEPARATELY from the baked arm below and not through it, because the baked layer
          // under a geoclip is usually a single-frame still with no `spineCanvas` at all — the condition the
          // baked arm gates on. Skipping it here is the tick half of the freeze this port had to avoid.
          drawGeoclip(entry, nowMs);
          continue;
        }
        if (entry.spineCanvas && entry.spineClip) {
          drawSpineFrame(entry, nowMs);
        }
      }
    },

    spineQuads() {
      const out = new Map<string, SpineQuadSource>();
      for (const entry of elements.values()) {
        if (entry.geoclipState?.node) {
          // A LIVE GEOCLIP OWNS THIS CREATURE'S PIXELS, so its baked still must not ALSO become a stage quad.
          // Without this the node draws twice: the geoclip canvas above the stage, and `emitSpineQuad`'s baked
          // still at the node's own paint index underneath it. That is the class of bug a screenshot cannot
          // reveal — two nearly-identical creatures in the same place look like one — and it is exactly the
          // failure a CSS child-combinator shipped on the DOM arm (fix-forward 247bd7d).
          //
          // Excluding it here is also what un-hides the host: the renderer feeds this map's ids back through
          // `setSpineDrawn`, and a drawn id is what puts `visibility: hidden` on the element the geoclip canvas
          // lives inside. The mount/release bumps of `spineQuadVersionCounter` are what make the next build read
          // this answer rather than reusing the last list.
          continue;
        }
        const clip = entry.spineShownStill;
        const img = entry.spineImg;
        // THREE conditions, and each excludes a real case: a committed still (`spineShownStill` is set only by
        // the decode gate's commit), the element that is CARRYING those pixels right now (`spineImgUrl` moves on
        // a swap while `spineShownStill` follows it), and a clip that is genuinely a still.
        if (!clip || !img || !clip.stillUrl || entry.spineImgUrl !== clip.stillUrl || clip.frames.length !== 1) {
          continue;
        }
        const still = clip.frames[0];
        const scale = clip.canvasWidth > 0 && clip.localWidth > 0 ? clip.localWidth / clip.canvasWidth : 1;
        out.set(entry.id, {
          nodeId: entry.id,
          clipUrl: clip.stillUrl,
          source: img,
          bytes: () => stillBlob(still),
          frameW: Math.max(1, Math.round(still.width)),
          frameH: Math.max(1, Math.round(still.height)),
          tx: clip.localX + still.offsetX * scale,
          ty: clip.localY + still.offsetY * scale,
          scale
        });
      }
      return out;
    },

    spineQuadVersion() {
      return spineQuadVersionCounter;
    },

    setSpineDrawn(ids) {
      spineDrawnIds = ids;
    },

    setTextDrawn(ids) {
      textDrawnIds = ids;
    },

    setBackstop(order) {
      backstopOrder = order;
    },

    nextSpineDeadline(nowMs) {
      // The counter short-circuits the scan on the case that dominates: a settled screen, or one whose spines are
      // all product-default STILLS. `refreshSpinePlaying` keeps it as the playing set's exact size.
      if (playingSpine === 0) {
        return Number.POSITIVE_INFINITY;
      }
      let next = Number.POSITIVE_INFINITY;
      for (const entry of elements.values()) {
        if (!entry.spinePlaying) {
          continue;
        }
        const geoclip = entry.geoclipState;
        if (geoclip?.node && geoclip.clip) {
          // GEOCLIP — ITS OWN CLOCK, and the second half of the anti-freeze term. The baked clip under a
          // geoclip is usually a single-frame still, and `msToNextSpineFrame` answers Infinity for one of those:
          // asking it here would park the stage forever with a creature stuck on frame 0. `msToNextGeoclipFrame`
          // replays `geoclipFrameIndexAt`'s own grid, so the wakeup and the paint cannot disagree.
          const ms = msToNextGeoclipFrame(geoclip.clip, spinePlayMs(entry, nowMs), entry.spineLooping);
          if (ms < Number.POSITIVE_INFINITY) {
            const at = nowMs + ms;
            if (at < next) {
              next = at;
            }
          }
          continue;
        }
        const clip = entry.spineClip;
        if (!clip) {
          continue;
        }
        // `msToNextSpineFrame` answers Infinity for a CLAMPED one-shot that has run out — a landed attack holds
        // its last pose, so it stops asking for frames even though it is still in the playing set. Before M3 that
        // clip kept the stage at the display's rate for the rest of the screen.
        //
        const ms = msToNextSpineFrame(clip, spinePlayMs(entry, nowMs), entry.spineLooping);
        if (ms < Number.POSITIVE_INFINITY) {
          const at = nowMs + ms;
          if (at < next) {
            next = at;
          }
        }
      }
      return next;
    },

    spinePlayingCount() {
      return playingSpine;
    },

    counts() {
      return { ...counts };
    },

    dispose() {
      disposed = true;
      for (const entry of [...elements.values()]) {
        destroyEl(entry);
      }
      elements.clear();
      playingSpine = 0;
      // Drop the latched scene with everything else: it is the whole node map, and holding it past disposal
      // would keep a dead overlay's tree alive for as long as anything held the overlay.
      liveNodes = null;
      childIndex = null;
      tintSvg?.remove();
      tintSvg = null;
      tintDefs = null;
      container.remove();
    }
  };
}
