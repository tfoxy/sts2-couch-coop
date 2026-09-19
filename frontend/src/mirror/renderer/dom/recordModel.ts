import type { PresentationAnimationBinding } from "@spirectl/presentation/render";
import type { Affine } from "@/mirror/affine";
import type { CardFlightState, CardFlightTiming } from "@/mirror/cardFlight";
import type { TrailPoints, TrailProfile } from "@/mirror/cardTrail";
import type { GeoclipClip, GeoclipNode, GpuClip } from "@/mirror/geoclipPlayer";
import type { MirrorCardFlightHint, MirrorNode } from "@/mirror/sceneTree";
import type { LoadedSpineClip } from "@/mirror/spineClip";
import type { Rgb } from "./walkModel";

// The context an enclosing parent threads to a child in the NESTED DOM model: the PARENT ELEMENT the child mounts
// inside, the composed tint (CSS can't multiply colors, so tint is still baked per node), the inverse of the
// PARENT ELEMENT's matrix (so the child is placed RELATIVE to its parent; null = identity at the stage root), and
// the parent's GLOBAL Transform2D (used to compose this node's global and to lift a
// tween endpoint into global). Opacity/z/hidden are DROPPED — CSS now cascades them (parent element opacity ×
// child, ancestor z-context, ancestor display:none).
interface WalkCtx {
  domParent: HTMLElement;
  tint: Rgb;
  // The parent ELEMENT's matrix inverse used to re-base this node (null = identity at the stage root). When the
  // horizontal spread is active this is the parent's SPREAD-shifted inverse, so it DIVERGES from `parentGlobal`
  // (which stays the unshifted 1920-space global) — placement re-bases against the shift; local-space global
  // composition + tween-endpoint lifting stay in true 1920-space.
  parentInv: Affine | null;
  parentGlobal: Affine;
  // Anchor-driven wide-screen re-layout (design-space). `parentDx` = the cumulative ABSOLUTE global-x shift already
  // applied to this node's parent (a node rides it verbatim unless its own anchors move it further); `deltaParentWidth`
  // = how much this node's PARENT widened (parent-local px) — the budget this node's anchor fractions scale against.
  // Both 0 when the stage isn't widened (spreadFactor === 1).
  parentDx: number;
  deltaParentWidth: number;
  // How much this node's immediate ANCHOR frame widened (the parent Control's own box). Equal to `deltaParentWidth`
  // down real anchored chains, but 0 under a zero-size pass-through group: a zero-size parent's box never resizes,
  // so its children's anchors are MEANINGLESS there (Godot would never move them) and a boxed anchored (Control)
  // child RIDES `rideDx` (its entity's one shift) instead of running the anchor algebra.
  anchorDelta: number;
  // The dx a RIGID child of this node should take: a pass-through group's OWN field claim (≠ `parentDx`, which stays
  // the inherited baseline for the floater override), or a consuming node's dx. Boxed CONTROL children under a zero
  // anchor-frame ride this — they're parent-relative UI (the card's EnergyIcon/Frame, a creature's Hitbox/Intents),
  // so the whole entity moves as one; per-child own-center claims gave corner-placed parts a visibly different dx.
  // Non-Control content (Sprite2D arrow segments, spine/particle anchors) still claims the field at its own center.
  rideDx: number;
  // True when `parentDx` derives from the positional squeeze FIELD (a pass-through/positional ancestor) rather than
  // the anchor algebra — riding descendants inherit it into their `data-spread-mode` stamp so the input side picks
  // the squeeze affine even when the press lands on deep painted content (card art) instead of the claimer itself.
  parentDxProp: boolean;
  // The parent's node-local WIDTH (1920-design px; MIRROR_DESIGN_WIDTH at the root, inherited through boxless
  // groups). Lets the center-fallback tell full-canvas background art (≈ parent width → center it) from a small
  // left-fixed Control (a corner pile / HUD icon → leave it).
  parentWidth: number;
  // True when an ANCESTOR currently owns an active transform-tween pin (its element is animating to a CSS-transition
  // endpoint). While set, a riding descendant must NOT be re-based/re-spread against the parent's STREAMED transform
  // (which is decoupled from the pinned element it actually rides) — the nested DOM already carries it along, so it
  // is skip-cleaned even when its inherited context "changed" purely because the pinned ancestor's streamed
  // transform moved. Cleared once the pin expires, when the next walk re-bases against the settled transform.
  pinnedAncestor: boolean;
  // The horizontal redistribution factor a child of a widened BoxContainer parent rides (0 begin / 0.5 center / 1
  // end for an H-box; 0 for a V-box → ride the parent's own shift), or null when the parent is NOT a widened
  // BoxContainer. A real Godot BoxContainer IGNORES its children's anchors and re-lays out its packed row/column
  // when its box resizes, so a box child must NOT run the anchor algebra — it rides `parentDx + factor·Δparent`
  // (see the BOX CHILD branch in visit). Set by the parent from its `containerLayout`.
  containerChildAlign: number | null;
  // True when the widened BoxContainer parent is VERTICAL: its alignment packs the other axis, but Godot lays each
  // child out across the box's full WIDTH (cross-axis fill), so a child whose own box already spans the container's
  // pre-widen width is full-frame background ART that re-centers (the fullCanvas convention) instead of stranding
  // left (see the BOX CHILD branch).
  containerChildVertical: boolean;
  // R4-round4: true once an ancestor is the card-reward selection screen root (leaf === CARD_REWARD_SCREEN_LEAF). While
  // set, an NCard descendant is a REWARD card → the view-scale pre-filter gives it the per-card 1.15 stamp (grid_card_
  // holder.tscn / card.tscn are reused by the deck dialog, so ancestry — not scene file — scopes the bump). Structural
  // (node-type based), so it never changes per-drain for a stable tree (unlike pinnedAncestor); the cached childCtx
  // carries it and the recurse-only fast path needs no refresh.
  inCardRewardScreen: boolean;
  // R10-B3 element adoption: the ADOPT-KEY PREFIX inherited from the nearest ancestor that opened a content scope.
  // A node carrying a `contentKey` (the producer's stable identity for the CARD CONTENT a pooled shell currently
  // shows) opens the scope with that key; each descendant extends it with its own NAME (`nc:strike#3/CardContainer/
  // TitleLabel`), giving every element under a pooled card a stable identity that survives the shell being freed
  // and re-instantiated under new Godot instance ids. Null outside any content scope (almost the whole scene) and
  // whenever the chain is broken by an AUTO-GENERATED Godot name (`@Control@1619`), which carries no identity.
  contentScope: string | null;
  // True when any ancestor is invisible, so this node renders inside a `display:none` subtree and cannot paint.
  //
  // Why: `visit` only ever guarded a node's OWN paint on `hidden` — child recursion continued unconditionally, and
  // each child built its full sub-layer set under the invisible ancestor. An audit of a live combat scene found 710
  // of 734 atlas <canvas> elements were created inside closed dialogs / inactive screens that nobody ever saw, each
  // one a decode + a draw + a composited box. While set, `visit`/`updateSubLayers` DEFER the three pure-paint
  // sub-layers (atlas canvas, spine canvas, gsw shader/particle markers + their mount points); everything cheap and
  // structural — transform/opacity/text styling, the atlas + image WARMS — still runs, so a reveal is a draw and
  // never a cold fetch. A sub-layer that ALREADY exists when its subtree goes hidden is left alone (display:none
  // already makes it free); the deferral only ever declines to CREATE.
  //
  // It participates in BOTH context-identity tests (ctxUnchanged and sameWalkCtx) — that is the entire reveal
  // mechanism. An ancestor flipping visible builds a childCtx whose `ancestorHidden` differs, so sameWalkCtx refuses
  // to reuse the cached object, every descendant sees ctxSame=false → selfDirty → a full restyle that creates the
  // deferred layers, and each of them cascades the same flip to ITS children.
  ancestorHidden: boolean;
}

// Retained per-node render state. `el` is null for LEAF nodes that render nothing (no box/text/paint AND no
// children) — they still get a record so a clean subtree can be skipped, but place nothing. Every node WITH
// children gets an el (it's the transform group its children nest inside).
// Geoclip playback state for ONE node's current animation (the machinery is in the "geoclip playback" block
// far below, and the artifact decoder in mirror/geoclipPlayer.ts). Null on every
// record in the shipped configuration.
interface GeoclipRecordState {
  // The manifest url this state was armed for — the identity guard every async arrival re-checks.
  manifestUrl: string;
  clip: GeoclipClip | null;
  gpu: GpuClip | null;
  node: GeoclipNode | null;
  // The frame index currently painted (-1 = nothing yet), so a tick that lands on the same frame draws nothing.
  frame: number;
}

interface RenderRecord {
  // The node id this record renders. Lets the targeted-reorder pass map a dom-parent ELEMENT (via elToRecord) back
  // to its node id, to rebuild that parent's child order from childIdsByParent. Stable for the record's whole life
  // EXCEPT across an adoption (see adoptRecord), which re-keys it onto the node id of the pooled shell's successor.
  id: string;
  el: HTMLElement | null;
  lastNode: MirrorNode | null;
  // R10-B3: this node's ADOPT KEY (see WalkCtx.contentScope) — the content-stable identity a condemned record is
  // matched by when a pooled shell is re-instantiated. Null for every node outside a content scope.
  adoptKey: string | null;
  // Cached inherited context (for skip-clean). `haveCtx` guards the first application. `cInv` is the PARENT
  // ELEMENT's matrix inverse (every node now, not just clip children); `cParentGlobal` is the parent's global
  // Transform2D (needed to recompose this node's global + to lift tween endpoints).
  haveCtx: boolean;
  // Stage-2 recurse-only fast path. `childCtx` is the WalkCtx this node hands its children — cached across walks (the
  // slow path REUSES it when the fields are unchanged, so a clean subtree stays on ref-equality). The fast path (this
  // node clean but a descendant dirty) just refreshes its time-dependent `pinnedAncestor` and recurses, skipping the
  // node's own restyle/spread/behindCount rebuild. `lastCtxRef` is the last ctx OBJECT passed in, for an O(1) identity
  // pre-check before the field-by-field ctxUnchanged compare. Both reset in newRecord + removeEl.
  childCtx: WalkCtx | null;
  lastCtxRef: WalkCtx | null;
  cDomParent: HTMLElement | null;
  cTintR: number;
  cTintG: number;
  cTintB: number;
  cInv: Affine | null;
  cParentGlobal: Affine | null;
  // Cached inherited re-layout context (skip-clean must re-run this node when an ancestor's shift/widen changes even
  // if the node's own object didn't). `spreadDx` is THIS node's applied ABSOLUTE horizontal shift (design-px), stashed
  // so a tween endpoint armed later lands at the shifted position too.
  cParentDx: number;
  cDeltaParentWidth: number;
  cAnchorDelta: number;
  cParentDxProp: boolean;
  cRideDx: number;
  cContainerChildAlign: number | null;
  cContainerChildVertical: boolean;
  // R10-PERF6 WS-P1: the inherited `parentWidth`. Cached for `ctxAffineOnlyChanged` ONLY — `ctxUnchanged`
  // deliberately keeps its historical field set (adding a field there would change which subtrees skip-clean,
  // i.e. the baseline this round is measured against). The ancestor-affine fast path must not inherit that gap:
  // `parentWidth` feeds the full-canvas / preview / box-child claims inside `computeSpread`, so a walk where it
  // moved is NOT an affine-only walk and takes the full visit.
  cParentWidth: number;
  // R10-B3: the inherited content scope (see WalkCtx.contentScope), cached like every other inherited field so a
  // scope change alone re-walks the subtree.
  cContentScope: string | null;
  // R10-PERF4 WS-3 (item 3): the inherited ancestor-hidden flag (see WalkCtx.ancestorHidden), cached like every
  // other inherited field so a reveal alone re-walks the subtree and un-defers its sub-layers.
  cAncestorHidden: boolean;
  spreadDx: number;
  // WS-C: which squeeze-field formula produced `spreadDx` (see SpreadOut.fieldMode) — 0 none / 1 origin /
  // 2 centre. What lets the tween seam re-evaluate the field at an ENDPOINT instead of re-using the shift the walk
  // derived from the node's (frozen, pre-tween) pose. Always 0 while the stage isn't widened.
  spreadFieldMode: number;
  // THIS node's applied width override (a stretched anchored span's rendered width, local px; 0 = none) — carried
  // into the interactive rects so the input side knows the true rendered extent of full-canvas blockers.
  spreadW: number;
  // READABLE-HAND MODE: the cosmetic vertical `translate` (design px, negative = raised) applyHandRaisePass last
  // wrote onto this element. 0 for every node the mode doesn't move — which is all of them while it is off. Read
  // back by `raiseInputStamps` so the input inverse un-does exactly what was drawn.
  raiseDy: number;
  // READABLE-HAND MODE: the `translate …` CSS-transition fragment this element's raise should currently use, or
  // null for "the `.mirror-hand-raisable` class default". Non-null only while a hand TWEEN owns the node, where the
  // raise has to run on the tween's OWN duration + easing so the two channels arrive together. Composed into the
  // element's single shared `transition` by composeTweenTransition, which is the ONE writer of that property.
  raiseTransition: string | null;
  // Count of THIS node's DOM-producing children that draw BEHIND its own paint (show_behind_parent). They occupy
  // the FIRST child slots of this element, before the sub-layers; the rest of the children draw after.
  behindCount: number;
  // R10-PERF5 WS-1 DORMANCY: this record is a MARKER for an effectively-hidden node the walk declined to build
  // (no element, no child recursion — see the dormancy branch in `visit`). Everything the record carries is still
  // current (lastNode, cached ctx, spreadDx/spreadW); only the DOM is absent. Cleared the moment the node is
  // revealed and `createEl` runs, which is also what makes the reveal countable (`revealBuilds`).
  dormant: boolean;
  // R10-PERF5 WS-3 HATCHERY: this element was born in the DARK — created by an idle hatch drain while the node was
  // still effectively hidden. CSS animations don't run under `display:none`, so nothing this element declared was
  // ever anchorable (`getAnimations()` returns an empty list there) and its decorative loop would start from phase 0
  // whenever the subtree is finally shown. Cleared on the hidden→visible flip, which is where `visit` re-queues the
  // phase anchor (see the reveal re-anchor). Never set by a walk: a walk only builds what is about to be seen.
  builtWhileHidden: boolean;
  // WS-C occlusion gating (applyOcclusionPass owns both). `occluded` = this node is a TIER-1 gated subtree ROOT, so
  // its element is paint-suppressed via `display:none` — folded into `visit`'s display write alongside `hidden` so
  // a re-style during the walk can't un-hide it. `occlusionSuspended` = the gsw EFFECTS_SUSPENDED_ATTR
  // is currently stamped on its element (either tier). Both are RENDER-ONLY: no node data is touched, and every
  // input-side structure (interactive rects, view-scale stamps, the pointer map) is derived from the `nodes` map.
  occluded: boolean;
  occlusionSuspended: boolean;
  // STAGE-A static background: the gsw EFFECTS_SUSPENDED_ATTR is currently stamped on this element BECAUSE it is a
  // `staticBg`-suppressed root (see `applyRecordSuppression`). Held separately from `occlusionSuspended` because the
  // two gates are independent owners of the same attribute — gsw reads PRESENCE, not value, so either one
  // disengaging must not strip a stamp the other still wants (`syncEffectsSuspendAttr` recomputes from both).
  staticBgSuspended: boolean;
  // R10-PERF6 WS-P2 STAGGERED REVEAL: the display this node's OWN state asks for, ignoring any reveal hold —
  // `true` = `display:none` was written for it (hidden / occlusion-gated). It is what makes a
  // reveal detectable (the false←true edge, on a node whose ancestors are visible) and what the release drain
  // consults before un-hiding a held root, so a node the game hid while it was held stays hidden.
  paintSuppressed: boolean;
  // Applied DOM caches (key → last value) for per-property dirty-checking.
  style: Map<string, string>;
  attrs: Map<string, string>;
  // Last-applied values of the SINGLETON attributes that are (re)written per visit outside the `attrs` diff:
  // `data-node-type` (paint block) and the four re-layout attrs (`data-spread-dx/-paints/-w/-mode`, written on every
  // non-skipped visit). Caching them here means the common unchanged / no-spread case (dx 0, no widen) touches no DOM
  // at all instead of calling removeAttribute per node per walk. null = attribute currently ABSENT. Reset in removeEl
  // so a re-created element re-stamps.
  attrNodeType: string | null;
  attrSpreadDx: string | null;
  attrPaints: string | null;
  attrSpreadW: string | null;
  attrSpreadMode: string | null;
  // Self-paint layer: an INTERIOR node's OWN paint (texture + own tint filter + own selfAlpha) renders here,
  // BEHIND the DOM-nested children, so the container element carries no cascading filter/opacity that would
  // double-apply onto those children (the tint/self_modulate leak). Null for leaf / no-own-paint nodes. (The CSS
  // class stays `.mirror-clip-self` — gsw runtimes and the mirrorTextScale sheet key off it.)
  selfLayer: HTMLElement | null;
  selfLayerStyle: Map<string, string>;
  // The ordered sub-layer elements (self-paint, anim, atlas, spine, shader, particle, np-slices, range, text) of
  // this element, back-to-front. reconcileOrder places them between the behind-children and the normal children.
  subLayers: HTMLElement[];
  // Decorative-animation self-layer: a child that carries a frozen node's PAINT (texture) and runs the reproduced
  // CSS animation (energy/star orb spin) in LOCAL space, so presentation's `transform:` keyframe spins it IN PLACE
  // while the parent el keeps the baked global matrix. Null for non-animated nodes.
  animSelf: HTMLElement | null;
  animSelfStyle: Map<string, string>;
  // R10-B2: animSelf WRAPS the node's paint sub-layers (they become its DOM children) instead of standing beside
  // them. Needed by a pinned ROTATION/GLOW loop: the paint of an atlas-sprite node is a <canvas> sub-layer, a
  // SIBLING of animSelf, so an animation on animSelf alone would move an empty box. Set by syncPinnedLoop (which
  // runs BEFORE the paint pass on the same walk, so the nesting lands the frame the token arrives) and honoured by
  // updateSubLayers. Left ON after the token clears — an un-animated wrapper is visually inert, and keeping it
  // avoids re-parenting the paint on every start/stop.
  animSelfWrapsPaint: boolean;
  // The PATH-KEYED decorative binding this node was created with (`nodeAnimBinding`), if any — remembered so a
  // producer-pinned loop arriving on the same node can take precedence and put it back on clear. No scene has
  // both today (the four pinned nodes match no path rule); this is the defensive half of "the pinned token wins".
  staticAnimBinding: PresentationAnimationBinding | null;
  // The static binding a pinned loop DISPLACED (null when none was). Re-applied when the token clears.
  pinnedLoopStash: PresentationAnimationBinding | null;
  // The element the pinned loop's animation is currently on (el for the map-point pulse, animSelf for the
  // rotation/glow kinds) — so a teardown clears the same element the apply wrote to, whatever the token was.
  pinnedLoopTarget: HTMLElement | null;
  // Q1 flame loop: the resolved `flameFlicker` binding for a Tezcatara candle-fire QUAD (else null). Held so the
  // scaleY+skew sine loop can ALSO be applied to the shaderSelf canvas — the WebGL/Static paint of a shader quad
  // lives on shaderSelf (a sibling of animSelf), which animSelf's transform can't reach (gsw requires the canvas
  // mount to stay a direct child of el, so it can't be nested under animSelf). `shaderSelfFlamed` guards a
  // one-time apply so re-visits never restart the loop.
  flameBinding: PresentationAnimationBinding | null;
  shaderSelfFlamed: boolean;
  // WS-E pinned-loop replay: the signature of the `pinnedLoopAnim` animation currently running on THIS element
  // (`"<token>|<pivotX>|<pivotY>"`), or null when none. Unlike the path-keyed folds above, membership is DYNAMIC
  // (the producer flips it as the travelable set changes) so the pass runs every re-style — the signature is what
  // keeps it idempotent, i.e. what stops a re-style from RESTARTING the sine mid-sweep (a visible jerk).
  pinnedLoopSig: string | null;
  // Sub-elements (created lazily; always positioned at the FRONT, before nested clip children).
  shaderSelf: HTMLElement | null;
  shaderSelfFit: string | null;
  shaderSelfTex: string | null;
  shaderSelfWindow: string | null;
  // Atlas-sprite canvas (decode-once atlas → drawImage the region); `atlasKey` = url+region, the redraw key.
  // `atlasPlacementKey` caches the canvas's own fit placement (interior nodes only — the container keeps pure
  // placement so nested children don't inherit the fit; null = the default inset:0 stretch of a leaf's canvas).
  atlasCanvas: HTMLCanvasElement | null;
  atlasKey: string | null;
  atlasPlacementKey: string | null;
  // Which mechanism currently paints this node's sprite. "div" = a `background-image` element over
  // the region's baked blob (no composited layer); "page" = the Stage-C PLACEHOLDER, a `background-image` element
  // page-cropping the atlas PAGE itself (regionBackgroundStyle) while the blob is unbaked/undecoded or the baker
  // is suspended; "canvas" = the drawImage path above (`?atlasPaint=canvas`, the canvas placeholder path, and the
  // tick-blit intent target); "none" = nothing exists. Exactly one of `atlasCanvas` / `atlasRegionDiv` is non-null
  // at any time ("page" lives in `atlasRegionDiv` too — same teardown paths, different class + background). A
  // mechanism swap resets `atlasKey`/`atlasPlacementKey` (the fresh element carries none of the old element's state).
  atlasPaint: "none" | "canvas" | "div" | "page";
  atlasRegionDiv: HTMLElement | null;
  // "page" mechanism only: the crop signature actually written (region key + the atlas page's natural size or "?"
  // while unmeasured) — the page size lands asynchronously (warmImage → onTextureSizesResolved re-style) and the
  // crop must be rewritten exactly once when it does.
  atlasPageCropSig: string | null;
  // How often this node has fallen BACK to the canvas because a freshly-shown region wasn't baked yet. A cycler
  // that keeps outrunning its bakes sticks to canvas at ATLAS_STICKY_CANVAS_REVERTS rather than thrash.
  atlasCanvasReverts: number;
  // Enemy-intent glyph frame cycling (mirror-owned wall-clock ticker; the headless NIntent is frozen so its
  // per-frame texture swap never runs). `intentKey` = animationName|frameCount (a change restarts the cycle);
  // `intentStartMs` the cycle origin; `intentShownFrame` the last-drawn index (redraw only on change). The frames
  // are cycled onto the SAME `atlasCanvas` the reconcile mounted for frame 0.
  intentKey: string | null;
  intentStartMs: number;
  intentShownFrame: number;
  // R10-B1 compositor path: instead of the per-frame blit above, the glyph's frames are baked
  // ONCE into `intentStrip` (a canvas of N cells) which a CSS `translate` + `steps(N)` animation cycles behind
  // `intentView`, a one-cell `overflow:hidden` viewport standing exactly where the single-frame `atlasCanvas`
  // stood. `intentStripKey` is the built identity (frames + cell box → a change rebuilds + re-phases);
  // `intentStripPlacementKey` mirrors `atlasPlacementKey` for the viewport; `intentStripPaused` is the occlusion
  // park (`animation-play-state`). A record on this path is NEVER in `activeIntents` — that is what lets the
  // renderer tick park on an idle screen.
  intentView: HTMLElement | null;
  intentStrip: HTMLCanvasElement | null;
  intentStripKey: string | null;
  intentStripPlacementKey: string | null;
  intentStripPaused: boolean;
  // STAGE-C item 3: once the SET's whole strip is baked into ONE image (in the bake worker) and
  // pre-decoded, the glyph drops the strip CANVAS for an `<img>` of that strip inside the same `intentView`
  // viewport — same mechanism, same `translate`/`steps(N)` animation, no promoted canvas layer. Exactly one of
  // `intentStrip` / `intentImg` is non-null. `intentImgKey` is the built identity (the strip blob + its geometry);
  // the phase, the anchor and the occlusion park are the strip path's, shared verbatim.
  intentImg: HTMLImageElement | null;
  intentImgKey: string | null;
  // The document-timeline start time that makes the strip's ACTIVE time equal `nowMs() - intentStartMs` (see
  // syncIntentStrip); re-applied verbatim when an occlusion reveal resumes the animation. Shared by both the
  // canvas and the <img> mechanism — whichever is mounted is the animated element.
  intentStripAnchorMs: number;
  // Line2D stroke paint (the map quill annotations). `lineDiv` is a zero-box wrapper anchored at the node's LOCAL
  // ORIGIN holding one `<svg><polyline>`; `linePolyline` is that polyline. `lineSig` is the update key
  // (`count|lastX,lastY|width|colorHtml|eraser`) — matching the producer's own change signature — so an actively-
  // drawn stroke (~30 deltas/s) costs a handful of ATTRIBUTE writes on a STABLE element and never an element rebuild.
  lineDiv: HTMLElement | null;
  linePolyline: SVGPolylineElement | null;
  lineSig: string | null;
  // CARD-TRAIL synthesis (see cardTrail.ts). The two `NCardTrail` Line2Ds behind a flying card carry NO wire
  // geometry (the producer's stroke stream is scoped to the map quill strokes) — the ribbon is rebuilt here from
  // the node's own streamed motion. `trailDiv` is the same zero-box wrapper shape as `lineDiv`, holding an
  // `<svg>` with one gradient-filled `<path>`; `trailPoints` is the synthesized stand-in for the game's own point
  // list.
  //
  // R14f — THE FRAME LATCH (`trailFrame` / `trailInv`; see latchTrailFrame). A ribbon is a POINT HISTORY: every
  // sample already in the list was converted into one particular space and then left there, so the space the
  // element renders in may not change while the list is alive or every stored point silently means somewhere else.
  // `trailFrame` is that space — the global this node is PLACED at for as long as it holds points — and `trailInv`
  // is its inverse (with the wide-screen shift folded in), which is what converts a world head sample into it.
  // Both are latched together, exactly once per point-history, and released only when the history empties.
  trailDiv: HTMLElement | null;
  trailPaths: SVGPathElement[];
  trailGradient: SVGLinearGradientElement | null;
  trailStops: SVGStopElement[];
  trailPoints: TrailPoints | null;
  trailFrame: Affine | null;
  trailInv: Affine | null;
  // The authored taper/ramp pair this node draws with (OuterTrail vs InnerTrail), resolved once from the node
  // name; and the last `d` written, so a repaint that reproduces the same path costs no DOM write.
  trailProfile: TrailProfile | null;
  trailD: string;
  // Last atlas region and completed blob URL. Cleared with the rest of the atlas state on a mechanism swap.
  atlasBlobKey: string | null;
  atlasBlobUrl: string | null;
  trailPaintedAtMs: number;
  trailAgedPending: boolean;
  // True while a tick has already skipped ONE repaint for this trail (see tickTrails): the next tick paints
  // whatever the window says, so the ribbon can never lag its point list by more than a single loop wake.
  trailRepaintDeferred: boolean;
  // R11 A0b — the gradient's endpoints are SPLIT into two signatures. `x1,y1` is the ribbon's TAIL, which only
  // moves when the oldest point expires (a few times a second); `x2,y2` is the HEAD, which moves on every sample.
  // One combined signature therefore rewrote all four attributes whenever either end moved — two provably
  // redundant writes per stroke per paint, ~120/frame at 30 cards.
  trailGradTailSig: string;
  trailGradHeadSig: string;
  trailStopSigs: string[];
  // R11 A0a — the band paths' `fill-opacity` used to be `band.alpha × profile.baseAlpha`: a pure function of the
  // authored PROFILE, with nothing in it that a repaint can change. It used to be written alongside every `d`,
  // i.e. 3 writes per stroke per paint (~180/frame at 30 cards) of a value the element already had. It is now
  // written on STATE CHANGE only, and this tag (see trailBandOpacityTag) is what makes an unchanged state a
  // no-op: when the paths are built, when a pooled element is adopted for the other profile, and — R14b — when
  // the mass diet arms or lifts, since a collapsed stack carries compensated alphas rather than authored ones.
  trailBandOpacitySig: string | null;
  // R11 A1 — how many band paths currently carry a `d`. The mass diet builds fewer bands than the profile
  // authors, so the paths beyond that have to be blanked when it arms and re-written when it lifts — and the
  // widest band's `d` alone (the usual update key) cannot see either edge on a frame where the head did not move.
  trailBandsPainted: number;
  // R16 — this stroke's CURRENT contribution to the standing-surface sum, in design px² (0 = nothing painted).
  // Held per record because the sum is maintained as a delta: the gauge must know what this stroke was covering
  // before it can price what it covers now (see noteTrailStandingArea).
  trailStandingBboxArea: number;
  particleSelf: HTMLElement | null;
  // The `data-godot-particle-visible-rect` string currently on the OUTER element (the one gsw reads
  // it from), or null for "not stamped". Cached so an emitter that has not moved costs one string
  // compare — and so a change is DETECTABLE, which is what dirties gsw's particle runtime. See
  // `syncParticleVisibleRect`.
  particleRectAttr: string | null;
  // SpineSprite clip playback. `spineCanvas` IS the self-layer: a <canvas> sized to the clip's canvas (px),
  // CSS-transformed (translate localX,localY + scale localW/canvasW) to map canvas-pixel space → node-local;
  // each frame is blitted with ctx.drawImage at its tight-crop offset (pre-decoded ImageBitmap → no per-frame
  // decode/relayout → no flicker, replacing the old background-image swap). The clock fields drive the
  // renderer-owned animation loop: playMs = spineSyncTrackMs + (now - spineSyncWallMs), looped.
  // The element that actually paints the clip. A dynamic (multi-frame) clip keeps the <canvas>
  // described above; a STILL (single-frame) clip paints an <img> of the frame's object URL instead, because a
  // canvas is an unconditional composited layer and a still has nothing to draw per frame. Exactly one of
  // `spineCanvas` / `spineImg` is non-null and `spineLayer` is that element (the "does this node have a spine
  // layer" sentinel everywhere the canvas used to be).
  spineLayer: HTMLElement | null;
  spineImg: HTMLImageElement | null;
  spineImgUrl: string | null;
  // Aug-25 SPINE SUBTREE PAINT CULL: whether `mirror-spine-promoted` is currently on this record's ELEMENT. The
  // cache field that makes the promotion pass a no-op for an unchanged verdict (the file's usual key-compare
  // idiom) and the bookkeeping that keeps `spinePromotedNodes` honest. See applySpinePromotionPass.
  spinePromoted: boolean;
  // `spinePendingStillUrl` is both the staleness token an
  // in-flight decode is re-checked against and the dedupe key that stops a re-applied placement from probing the
  // same url twice. `spineShownStill` is a SECOND retain() — on the clip whose `stillUrl` the live <img> is
  // actually displaying — which is what stops an LRU eviction from revoking an object url out from under a
  // painting element (the refcount already protects a canvas clip's ImageBitmaps the same way; the <img> path had
  // no equivalent). `spineStillUrlsSeen` collects the /spines/ REQUEST urls this node has asked for, so a death
  // can hand them all back to the clip cache, and `spineDying` marks that a terminal animation has started.
  spinePendingStillUrl: string | null;
  spineShownStill: LoadedSpineClip | null;
  spineStillUrlsSeen: Set<string> | null;
  spineDying: boolean;
  spineCanvas: HTMLCanvasElement | null;
  spineCtx: CanvasRenderingContext2D | null;
  // The anim a clip has been loaded/requested for (guards re-fetching + stale async results).
  spineAnim: string | null;
  // The runtime skin the clip was requested for (folded into the identity → re-request on change).
  spineSkin: string | null;
  // The shader-material signature the clip was requested for (same deal as spineSkin).
  spineMat: string | null;
  // The skeleton path the clip was requested for. Part of the identity: a runtime-injected skeleton
  // reports its animation FIRST (the producer sees the animation where it is REQUESTED) and its skeleton path
  // only once the late-static re-probe lands, so without re-requesting on this transition the node's first
  // (404ing) request was its LAST — the map boss never appeared and the chest stayed blank until it opened.
  spineSkelPath: string | null;
  // The STILL-vs-animated answer the clip was requested under (isSpineStillMode). Part of the identity so the
  // settings panel's manual spine mode (Dynamic ↔ Static) re-requests the other url on a live flip — the streamed
  // anim/skin/mat/skel are all unchanged there, so without this the layer would keep playing the old clip.
  spineStill: boolean;
  // The `&t=` seconds the still was requested for (null = the host's own mid/end heuristic). Part of the
  // identity because a PAUSED track's frozen time is the only thing that changes when the game unfreezes it — the
  // treasure chest's anim/skin/mat/skel are all still "animation", so without this, opening the chest re-fetches
  // NOTHING and the mirror keeps showing the frozen (closed) lid forever. See spineAttributes.spineStillTime.
  spineStillT: string | null;
  // One-shot escalation flags for the current clip identity: refetched with `&retry=1` after a budget collapse,
  // or retried with `&skel=` for a skeleton fallback. Reset on every identity change.
  spineRetried: boolean;
  spineSkelRetried: boolean;
  spineClip: LoadedSpineClip | null;
  // Whether the current clip LOOPS (producer loop flag). False → advanceSpine freezes on the last frame so a
  // one-shot anim (e.g. a weapon's "attack") plays once and holds instead of replaying forever (the flicker).
  spineLooping: boolean;
  // A frozen track makes advanceSpine hold spineSyncTrackMs instead of free-running.
  spinePaused: boolean;
  // The node object at the last clock sync (re-sync only on a fresh volatile upsert — which carries a fresh
  // authoritative track time — NOT on a context-only change, which would rewind playback to a stale time).
  spineSyncNode: MirrorNode | null;
  spineSyncTrackMs: number;
  spineSyncWallMs: number;
  spineShownFrame: number;
  spinePlacementKey: string | null;
  // First-frame streaming bookkeeping: `spineStillPainted` = the cheap 1-frame still has been
  // painted (frame 0 shown while the full clip bakes); `spineAnimatedShown` = the full animated clip has swapped in.
  // Once the animated clip is shown, a LATE-arriving still is dropped so it can't clobber the swapped-in animation.
  // Both reset on every anim/skin change (a new identity re-runs the still→clip chain).
  spineStillPainted: boolean;
  spineAnimatedShown: boolean;
  // Geoclip playback (see mirror/geoclipPlayer.ts). `geoclipState` is the live
  // per-identity playback (null = this node is on the raster path); `geoclipDisabled` is the ONE-WAY revert —
  // once anything about geoclip playback fails for this node it stays on the raster clip for the rest of the
  // session, across every later animation.
  geoclipState: GeoclipRecordState | null;
  geoclipDisabled: boolean;
  npSlices: HTMLElement[];
  // R10-B3: per-slice mirror of what is actually on each span (parallel to npSlices), so a re-style writes only
  // the declarations that really moved. Rebuilt with the spans whenever the slice COUNT changes.
  npSliceStyles: Map<string, string>[];
  rangeFill: HTMLElement | null;
  rangeWidth: string | null;
  textDiv: HTMLElement | null;
  textStyleCache: Map<string, string>;
  textInner: HTMLElement | null;
  lastText: string | null;
  lastHtml: string | null;
  // Declarative tween replay (Part C): two INDEPENDENT channels — transform (Stage 1-2) and opacity (Stage 4). While
  // a channel's `*Until` (a performance.now epoch; 0 = not pinned) is in the future, this node's value on that
  // channel is PINNED to the tween endpoint and a CSS `transition` on its element animates to it — so streamed
  // intermediate values are ignored and the whole tweened subtree moves/fades in lockstep. `*Transition` holds each
  // channel's CSS-transition fragment so a node driven by BOTH composes one `transform …, opacity …` string.
  // `tweenGroup` ties the nodes of one Godot tween together.
  tweenTransform: string | null;
  tweenTransformOrigin: string | null;
  tweenTransformUntil: number;
  tweenTransformTransition: string | null;
  // A transform hint receives a fresh generation as it is collected. Deferred arms re-check it at flush time, so a
  // newer endpoint for the same record is the only one allowed to write a transform, open a landing row, or choose
  // the hand-raise curve. Opacity arms intentionally have no such coupling.
  tweenTransformArmGeneration: number;
  // Deadline of the tween-derived raise curve actually started for this holder. Unlike the transform channel's
  // current deadline, it remains the old arm while a re-target is being collected, which identifies the narrow
  // same-offset rearm that must dual-prime both CSS channels.
  raiseTransitionUntil: number;
  // PHASE OF THE TWO DRAWN CHANNELS. The holder's local y as it was PAINTED at the instant a fresh transform ease
  // was armed on it (null = none captured, or the pose was unknown). A holder's drawn position is the sum of the
  // pose channel and the readable-hand lift channel; matching their duration and easing only keeps them together
  // if the lift also LEAVES the value conjugate to the pose the ease leaves. Written by the tween controller as it
  // arms, consumed by the very next hand pass — see handController.noteTransformArmPose.
  raiseArmFromLocalY: number | null;
  // The endpoint held only while tickTweens performs its one settle-time readable-hand pass. A plain release keeps
  // drawing this endpoint, so that pass must not fall back to the retained pre-arm streamed pose. Cleared before
  // returning to the event loop; a real catch-up deliberately leaves this null and uses its streamed pose instead.
  tweenTransformSettleEndG6: Affine | null;
  // WS-SHOP (round 6): the LIFTED GLOBAL (game 1920-space Affine) currently owned by this transform channel. An arm
  // stores its endpoint; a deferred prime stores its declared start for the one frame before that arm runs. Consumers
  // (the view-scale and readable-hand passes) must never observe the preceding channel's endpoint in that gap.
  tweenTransformEndG6: Affine | null;
  // R10-B1 deraster scale gate: the element's 2×2 linear components as they were BEFORE the transform channel was
  // armed (null = unknown / not armed). The settle compares them with the settled ones to decide whether the
  // will-change re-raster is needed at all — see derasterNeededOnSettle.
  tweenPreArmLinear: [number, number, number, number] | null;
  // PIN CATCH-UP. `tweenPinStreamed` is the last STREAMED transform this record was seen
  // carrying while its transform channel was pinned — the baseline that tells a genuinely fresh pose from the
  // pre-tween one a suppressed node keeps retaining. `tweenPinCatchup` is a fresh pose that the pin overrode and
  // that no later hint has superseded; the settle applies it instead of dropping it. Both null outside a pin.
  tweenPinStreamed: string | null;
  tweenPinCatchup: string | null;
  tweenPinCatchupOrigin: string | null;
  // MOVED-HOUSE CANCEL (the always-on reparent rule): the parent this record's transform channel was ARMED
  // under. A `"local"`-space endpoint is parent-relative, so it means nothing once the node is re-parented — and
  // the pin would go on drawing it (re-based through the NEW parent) for the rest of the window. `undefined` while
  // no transform channel is armed.
  tweenTransformParentId: string | null | undefined;
  // PARITY GAUGE post-settle watch (`?handParity=1` only; all three stay at null/0 with the gauge off). The transform
  // the element was actually LEFT at by the last transform settle, and the `performance.now` deadline until which the
  // first streamed transform to arrive is compared against it — see notePostSettleSnap. `parityWatchParentId` is the
  // parent the watch was armed under: element transforms are PARENT-RELATIVE, so a pose measured under a different
  // parent is measured in a different space and its px delta means nothing (see cancelParityWatch).
  parityWatchTransform: string | null;
  parityWatchUntil: number;
  parityWatchParentId: string | null;
  tweenOpacity: string | null;
  tweenOpacityUntil: number;
  tweenOpacityTransition: string | null;
  // A THIRD opacity channel, for an INTERIOR node's SELF-PAINT layer (`selfLayer`): a `self_modulate` fade changes
  // only the node's OWN paint (selfAlpha) — which lives on that layer, NOT the container element's cascading
  // modulate.a — so it is pinned here independently of the `tweenOpacity*` (element) channel above.
  tweenSelfOpacity: string | null;
  tweenSelfOpacityUntil: number;
  tweenSelfOpacityTransition: string | null;
  tweenGroup: string | null;
  // Hide-latch (WS-WEB Feature 2): a `performance.now` epoch (0 = not latched). Set when a fade settles this node's
  // opacity to ≤ AlphaEps; while it's in the future, the reconcile CLAMPS an incoming resting-alpha restore to 0
  // (killing the producer's 1-frame pre-hide reappear flash). `hideLatchRestingSig` is the captured resting ELEMENT
  // opacity the restore is matched against (null unless a hide-fade is armed).
  hideLatchedUntil: number;
  hideLatchRestingSig: number | null;
  // WS-REST held-restore clock (0 = not clamping a resting value yet): the `performance.now` epoch of the FIRST held
  // resting-valued restore. When ≥ HIDE_LATCH_HELD_RESTORE_MS old with no further write, the animation loop releases the
  // latch and re-applies `hideLatchStreamedOpacity` (the streamed opacity the clamp overwrote with "0") — so a
  // hint-less refocus re-show un-sticks even when NO further delta touches the node (the rest-site defect).
  hideLatchHeldAt: number;
  hideLatchStreamedOpacity: string | null;
  // The rendered (spread-shifted) design-space global Transform2D, cached during the walk ONLY for the direct
  // children of a visible HoverTip set, so the per-drain tip-scale pass can measure their design AABBs. Null
  // otherwise (never paid unless a tooltip is on screen).
  gDesign: Affine | null;
}

// WS-3: one card currently being replayed locally — a shuffle sweep or (R13) a played card on its way to the
// discard, told apart by `hint.kind` alone (see cardFlight.ts and applyCardFlights). Holds the
// declarative hint, the mutable integrator state, and the records the pose is written to — resolved ONCE at arm
// time and re-validated per tick against the id, so a teardown + re-add in between can never write into a stale
// record (the same guard `armGuard` gives a deferred tween arm).
interface ActiveCardFlight {
  hint: MirrorCardFlightHint;
  targetId: string;
  target: RenderRecord;
  trailId: string | null;
  // The `NCardTrailVfx` root, which copies the flight's position + rotation every frame — and which the client
  // DRIVES from the same pose (see writeTrailRootTransform).
  trail: RenderRecord | null;
  // The `NCardTrail` Line2D records under that root, fed the locally-integrated head.
  strokes: RenderRecord[];
  // R14c — the driven root's global 6-tuple, re-composed in place every frame (one tuple per flight, never shared
  // between flights: `writeCardFlightTransform` RETAINS what it is handed as the record's pinned endpoint, so a
  // module scratch would leave one record reading another card's pose).
  trailRootG6: number[] | null;
  // Whether this flight has driven its root at least once — `trailRootDrives` counts FLIGHTS, not frames.
  trailRootDriven: boolean;
  state: CardFlightState;
  // Wall clock of the last integrator step, so each advance uses the real elapsed dt (the loop is frame-driven,
  // and a frame can be long).
  lastMs: number;
  // When the transform pin is released — the END of the producer's suppression window, NOT the end of the
  // animation. See applyCardFlights.
  pinUntil: number;
  // The live WAAPI animation playing this card's precomputed transform keyframes. It is null when capability or
  // geometry fallback uses the JS integrator.
  anim: Animation | null;
  // The closed-form timing the keyframes were built from — also what the per-frame TRAIL sampler reads its pose
  // out of, so the ribbon and the animation are two views of one solution rather than two integrations.
  timing: CardFlightTiming | null;
  // Wall clock the animation started at (its t=0), and the rotation the last trail sample resolved to (the
  // degenerate-tangent carry the stepped integrator keeps in its state).
  animStartMs: number;
  sampleRotation: number;
  // The final landed transform, written inline when the animation finishes so cancelling it leaves no gap.
  animEndTransform: string | null;
  animEndG6: number[] | null;
  // The placement inputs the keyframes were BAKED against: the parent element's inverse and the wide-screen
  // spread factor. Both are constants for a flight in practice (the VFX layer does not move and the stage does
  // not resize mid-shuffle) — but a resize mid-flight would otherwise leave the card flying the old stage's path,
  // so the tick compares these and rebuilds when they move. Cheap: 7 number compares per flight per frame.
  animParentInv: [number, number, number, number, number, number] | null;
  animSpreadFactor: number;
  // Set once the settle has run (inline final transform written + animation cancelled), so the finish callback and
  // the tick's own end-of-flight detection can both fire without double-writing.
  animSettled: boolean;
}



export type { RenderRecord, ActiveCardFlight, GeoclipRecordState };
export type { WalkCtx };
