// Live-tree MIRROR data model (delta-based). Self-contained: it does not reach into the protocol layer, so
// the wire envelope and the scene model can move independently. (It MAY use generic helpers from
// godot-scene-web — the shared renderer.)
//
// The host streams `scene-delta` messages: a `full:true` keyframe (every node + draw order) on connect,
// then incremental deltas (changed nodes + removed ids, with order only when structure changed). The
// client keeps a RETAINED node map keyed by stable instance id and patches it in place — so reacting to a
// frame is O(changed nodes), not O(whole tree). Volatile fields are LOCAL (the renderer composes
// effective visibility/opacity/tint down the parent chain), which is what keeps the producer cheap.

import { normalizeParticleSpecConfig, type ParticleSpecConfig } from "@godot-scene-web/html/runtime";

// `@/join/*` is the shell's own join layer (see joinModel.ts); hostBase has no dependencies of its own at
// all, so importing it does not breach the self-containment rule above.
import { hostBase, hostUrl } from "@/join/hostBase";

import {
  shaderCoverageFrom,
  shaderFlipbookFrom,
  shaderLutFrom,
  shaderPivotPxFrom
} from "@/mirror/particleAttributes";

// The game's BASE design resolution. These are the DEFAULT/MINIMUM design-space dimensions: the game uses
// stretch mode canvas_items + aspect "expand", so the real viewport grows past the base in whichever axis the
// window is longer (a square headless instance renders ~1920x1920). MirrorView therefore derives the actual
// design size from the live root scene node (never below these) and scales-to-fit/letterboxes around it; rects
// are in that design space.
export const MIRROR_DESIGN_WIDTH = 1920;
export const MIRROR_DESIGN_HEIGHT = 1080;

// The game always LAYS OUT and hit-tests at 1920x1080 (the headless co-op instances are pinned to it by
// HeadlessViewportConfigurator), so all streamed transforms + input coordinates stay in 1920-space. On a screen
// WIDER than 16:9, MirrorView widens the *stage* up to this cap and the renderer spreads elements horizontally by
// `stageWidth/1920` — a purely cosmetic reposition (see mirrorRenderer's spread walk). 2520 = 1080*(2520/1080) is
// the widest we stretch before letterboxing again (~1.066x, e.g. 21:9 ultrawide / tall phones held sideways).
export const MIRROR_MAX_DESIGN_WIDTH = 2520;

export interface MirrorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Linear 0..1 components, as Godot reports them. `html` is "#rrggbbaa" for convenience.
export interface MirrorColor {
  r: number;
  g: number;
  b: number;
  a: number;
  html: string;
}

export interface MirrorText {
  text: string;
  colorHtml: string | null;
  fontSizePx: number | null;
  halign: string | null;
  valign: string | null;
  // Outline color/size from the text diagnostics. This is the per-tick (VOLATILE) value, so a runtime
  // recolor (HP outline turns blue while blocking) is reflected here even though the top-level `outlineColor`
  // is emitted stale. The renderer prefers this over `node.outline`.
  outlineColorHtml: string | null;
  outlineSize: number;
}

/**
 * WHERE GODOT BROKE THIS LABEL'S LINES — the engine's own wrap result, streamed instead of re-derived.
 *
 * The producer runs `TextServer.shaped_text_get_line_breaks` through a `TextParagraph` carrying the node's real
 * width, autowrap flags, justification flags and overrun behaviour (or reads a `RichTextLabel`'s own
 * `get_line_range`), so these offsets describe the wrap the game ACTUALLY drew. That matters because the mirror
 * is replicating Godot, not CSS: a client-side greedy space-breaker has to refuse whatever it cannot reproduce
 * (unbroken scripts, `text-wrap: balance`, tab stops, trimmed overruns), and every one of those refusals is a
 * label that keeps rendering in the wrong layer.
 *
 * ONE OBJECT, NOT FIVE FIELDS, on purpose: the ranges are unusable without the basis that says which string they
 * address and the hash that says whether they are stale. A merge that could carry one without the others would
 * produce a block validating against a string it does not describe — which is the wrong-words failure the hash
 * exists to prevent, reintroduced by its own safety net.
 */
export interface MirrorTextWrap {
  /** Half-open `[start, end)` character ranges into the basis string, one per line, in order. */
  lines: readonly { start: number; end: number }[];
  /** Which string the offsets index: the node's own `text`, or `parsedText` for a bbcode label. */
  basis: "text" | "parsed";
  /** The markup-stripped string a `"parsed"` basis addresses. Null for `"text"`. */
  parsedText: string | null;
  /** Length and FNV-1a-32 of the exact string the producer measured — the staleness check's two halves. */
  sourceLength: number;
  sourceHash: number;
}

export interface MirrorMargins {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MirrorFont {
  family: string;
  url: string;
  weight: string | null;
  style: string | null;
}

export interface MirrorShadow {
  colorHtml: string;
  offsetX: number;
  offsetY: number;
}

export interface MirrorOutline {
  colorHtml: string;
  size: number;
}

// One ShaderMaterial uniform value streamed by the producer (Sts2ShaderMaterialInspector). The shader
// renderer maps these to gsw shader-parameter variants. `kind` selects which value field is set.
export interface MirrorShaderParam {
  name: string;
  // "number" | "bool" | "string" | "color" | "vector2" | "resource" — plus the Godot-native-first extended
  // kinds "vector3" | "vector4" | "rect2" | "transform2d" | "vector3Array" | "vector4Array" | "vector2Array" |
  // "floatArray" | "intArray". The web renderer only maps the base kinds; the extended kinds ride through as
  // pass-through data (a raw Godot client consumes them) and are ignored by gsw's param mapping.
  kind: string;
  number: number | null;
  bool: boolean | null;
  string: string | null;
  color: MirrorColor | null;
  vector2: { x: number; y: number } | null;
  resourcePath: string | null; // sampler texture (resource kind)
  vector3: { x: number; y: number; z: number } | null;
  vector4: { x: number; y: number; z: number; w: number } | null;
  rect2: MirrorRect | null;
  transform2d: number[] | null; // [a,b,c,d,tx,ty]
  numberArray: number[] | null; // flattened array uniform; element stride implied by kind
  // A `resource` sampler uniform that is a PROCEDURAL ramp, resolved by the producer to its authored stops
  // (Gradient / GradientTexture1D). STS2's VFX particle shaders do
  // `COLOR = vec4(texture(lut, texture_color.rr).rgb, erosion) * vertex_color` — a per-TEXEL color lookup keyed
  // by the source texture's RED channel — so the sprite sheet is a MASK and the real colors are here; a client
  // holding only `resourcePath` draws the raw red mask. `gradientInterpolation` mirrors Godot's
  // `Gradient.interpolation_mode` (absent/0 linear, 1 constant/stepped, 2 cubic).
  //
  // OPTIONAL (unlike the sibling fields): only ramp samplers carry them, and old recordings carry none — so a
  // fixture/consumer that predates them stays valid without restating a null.
  gradientStops?: Array<{ offset: number; color: MirrorColor | null }> | null;
  gradientInterpolation?: number | null;
  // The sibling of `gradientStops` for a Curve / CurveTexture sampler (the VFX `erosion_curve`,
  // `erosion_over_lifetime` and `flipbook_curve` uniforms), resolved by the producer to its authored points.
  // A SINGLE point is a constant curve, which the particle coverage path turns into a per-node smoothstep
  // (see shaderCoverageFrom); multi-point curves sweep over the particle's life and are not modelled.
  // OPTIONAL, like `gradientStops`: only curve samplers carry it and old recordings carry none.
  curvePoints?: Array<{ x: number; y: number }> | null;
}

export interface MirrorRange {
  value: number;
  min: number;
  max: number;
}

// One enemy-intent glyph animation frame: an atlas crop (page image url + source region/margin), exactly like a
// node's textureUrl/textureRegion/textureMargin. The whole page is fetched once and cropped client-side.
export interface MirrorIntentFrame {
  url: string;
  region: MirrorRect | null;
  margin: MirrorRect | null;
}

// Enemy-intent glyph frame set (producer Sts2IntentFramesInspector). The headless client FREEZES the NIntent, so
// its icon stops cycling host-side and the browser reproduces the animation itself:
// cycling `frames` at `fps` off a shared wall-clock. `animationName` keys the current intent (a change restarts
// the cycle from frame 0). Single-frame sets render statically. Rendered through the SAME atlas-canvas path as a
// normal sprite (the node's textureUrl/region are set to frame 0), with the renderer's intent ticker advancing it.
export interface MirrorIntentFrames {
  animationName: string;
  fps: number;
  frames: MirrorIntentFrame[];
}

export interface MirrorNode {
  id: string;
  parentId: string | null;
  // Static (carried on add/keyframe; retained across volatile-only upserts).
  name: string;
  nodeType: string;
  showBehindParent: boolean;
  // CanvasItem.ClipChildren (0 Disabled / 1 Only / 2 AndDraw): this node clips its descendants to its own
  // texture's alpha (e.g. the health-bar capsule `Mask`). Static.
  clipChildren: number;
  // `Control.clip_contents` — a DIFFERENT Godot property from `clipChildren` above, and the one that bounds a
  // LAYOUT container. `clip_children` stencils descendants against this node's own DRAWN alpha, so a container
  // that paints nothing clips nothing; `clip_contents` clips a Control's children to its RECTANGLE whether it
  // paints or not. The game hides a panel's content by parking it OUTSIDE the panel box (the ancient-event
  // options slide up from below their ContentContainer while the dialogue plays) rather than by touching
  // `visible`/`modulate`, so a mirror without this flag draws that parked content in full. Static.
  clipContents: boolean;
  ninePatchMargins: MirrorMargins | null;
  font: MirrorFont | null;
  // PER-ROLE rich-text fonts — STATIC (add/keyframe only; mergeNode carries them forward). Non-null only on a
  // bbcode RichTextLabel (`richText`) whose theme names a DIFFERENT font FILE for that role than `font`. Godot never
  // synthesises bold/italic inside a RichTextLabel: it renders a `[b]` / `[i]` / `[b][i]` span by SWAPPING the
  // label's font to its `bold_font` / `italics_font` / `bold_italics_font` theme item (in STS2 a real second .ttf,
  // res://fonts/kreon_bold.ttf). With only `font` on the wire the `<strong class="godot-rich-bold">` inherited the
  // label's single-face normal family and `font-synthesis: none` (deliberate) correctly refused to fake bold.
  // Consumed as gsw's `--godot-rich-bold-font-family` & friends (nodeStyles.textStyle) + an injected @font-face.
  richBoldFont: MirrorFont | null;
  richItalicFont: MirrorFont | null;
  richBoldItalicFont: MirrorFont | null;
  // The role's own theme font size in ABSOLUTE px — STATIC. Non-null ONLY when it DIFFERS from the node's normal
  // font size, so null means "render the span at the node's own size". Consumed as a RATIO against the node's
  // streamed size (never as absolute px — that would bypass the mirror's --godot-text-scale pipeline).
  richBoldFontSizePx: number | null;
  richItalicFontSizePx: number | null;
  richBoldItalicFontSizePx: number | null;
  // The role font's glyph spacing in px (Godot FontVariation `spacing_glyph` — extra px inserted after every glyph;
  // STS2's kreon_bold_glyph_space_one.tres sets 1) — STATIC, non-null only when non-zero. Consumed as gsw's
  // `--godot-rich-bold-letter-spacing` & friends.
  richBoldFontSpacingPx: number | null;
  richItalicFontSpacingPx: number | null;
  richBoldItalicFontSpacingPx: number | null;
  // GODOT'S OWN LINE BREAKING for this label — STATIC (add/keyframe; mergeNode carries it forward as ONE unit).
  // Null on every node the producer could not answer for, which a consumer must read as "lay it out yourself".
  // See `MirrorTextWrap` for why it is one object rather than five fields, and `@/mirror/textWrap` for the
  // validation a consumer is REQUIRED to run before using it.
  textWrap: MirrorTextWrap | null;
  shadow: MirrorShadow | null;
  richText: boolean;
  shaderId: string | null;
  // The node's ShaderMaterial resource (res:// .tres) path, when the material is an external file
  // (NOT an inline sub-resource). Static.
  materialRef: string | null;
  // The ShaderMaterial's uniform values (producer-streamed). Drives the real shader via gsw's WebGL runtime
  // (or a color-matrix for HSV-adjust shaders). Null for non-shader nodes. Static.
  shaderParams: MirrorShaderParam[] | null;
  // TextureRect.StretchMode (Godot enum 0..6) — how the texture fits the node rect. The renderer maps it to a
  // CSS background-size / gsw fit (KeepAspectCentered → contain) so a non-stretched texture (e.g. the
  // card_ripple SDF in its oversized Highlight box) isn't fill-stretched. Null for non-TextureRect nodes. Static.
  textureStretchMode: number | null;
  // TextureRect flip flags (static). When true the texture is mirrored on that axis. The renderer applies a
  // CSS scale(-1) and adjusts the origin so the region stays within the localRect.
  textureFlipH: boolean;
  textureFlipV: boolean;
  // CanvasItem.BlendMode (0=Mix default, 1=Add, 2=Sub, 3=Mul). Null/undefined when Mix (omitted from JSON
  // to save bandwidth). Mapped to CSS mix-blend-mode by the renderer. Static.
  canvasBlendMode?: number;
  // Particle system (GpuParticles2D/CpuParticles2D), flattened into gsw's ParticleSpecConfig shape so the
  // gsw particle runtime can run the real CPU simulation. `textureUrl` is resolved here; `emitting` is a
  // placeholder (the per-tick `particleEmitting` overrides it when the spec JSON is stamped). Null for
  // non-particle nodes. Static.
  particleSpec: ParticleSpecConfig | null;
  // Volatile: whether the system is currently emitting, and a burst counter bumped on each emitting false→true
  // edge (a Restart() proxy). A change to either re-triggers a one-shot burst in the gsw runtime.
  particleEmitting: boolean;
  particleRestartEpoch: number;
  // SpineSprite animation clip (producer-streamed via Sts2SpineInspector). A SpineSprite is a Node2D with no
  // localRect/texture in the mirror, so the clip is its sole visual. STATIC (carried on add/keyframe): the
  // canonical (scene, scene-relative node) the /spines/ route addresses + the available anim names. Null for
  // non-SpineSprite nodes.
  spineSceneResPath: string | null;
  spineNodePath: string | null;
  spineAnimations: string[] | null;
  // The SpineSprite skeleton's res:// path (RuntimeSceneSpineSnapshot.SkelResPath) — STATIC, null when unknown.
  // The client appends `&skel=` on a ONE-SHOT retry after a failed clip fetch (#8: bake straight from the skeleton).
  spineSkelResPath: string | null;
  // Godot Node.SceneFilePath — STATIC. Non-null ONLY on the root node of an instanced .tscn scene. The
  // renderer walks the parent chain to the nearest node with a non-null value to learn which scene a node
  // belongs to (and that node's id is the scene-instance root). Drives touch hover/click scene targeting and
  // per-element text scaling. Null for non-scene-root nodes.
  sceneFilePath: string | null;
  // Godot Control.MouseFilter (0 Stop / 1 Pass / 2 Ignore) — STATIC. Null for non-Control nodes. Stamped as
  // `data-mouse-filter` and used to collect the MOUSE-VISIBLE (Stop/Pass) Controls the input side's near-miss pass
  // and view-scale input registry work over. It is NOT mapped onto CSS `pointer-events` — every `.mirror-node` is
  // `pointer-events: auto`, so the elementsFromPoint z-stack is unfiltered; touch attribution comes from the
  // renderer refusing to stamp a `data-touch-id` on things that must not own a tap (decorative overlays, echoes).
  mouseFilter: number | null;
  // Godot Control.AnchorLeft / AnchorRight (0..1 fractions of the PARENT's width) — STATIC. Null for
  // non-Control nodes. The renderer reproduces Godot's own resize when it widens `.mirror-stage` past 1920 on
  // ultra-wide screens: a node shifts by `anchorLeft·Δ(parentWidth)` and widens by
  // `(anchorRight−anchorLeft)·Δ(parentWidth)`. Center-anchored hands re-center (cards ride one shift → no
  // tearing), right-anchored HUD hugs the right edge, full-anchored backdrops stretch to fill.
  anchorLeft: number | null;
  anchorRight: number | null;
  // The instance id of the control this node is POSITIONALLY ANCHORED TO — STATIC. An owner-anchored floater
  // (STS2's on-hover tooltip) lives on a persistent, un-shifted container but is positioned from another
  // control's global rect, so the wide-screen re-layout would strand it at the owner's un-shifted native x.
  // The renderer applies the OWNER's horizontal shift (its `spreadDx`) to this node's subtree. Null otherwise.
  anchorOwnerId: string | null;
  // BoxContainer layout hint ("hbox-begin"/"hbox-center"/"hbox-end"/"vbox-…") — STATIC. Non-null only on a
  // BoxContainer-derived node. A real Godot BoxContainer IGNORES its children's anchors and re-lays out its packed
  // row/column when its box resizes, so on a widened stage the renderer makes a container's children ride the
  // container's OWN re-layout (shift by the alignment's fraction of the box's widening) instead of running their
  // own anchor algebra (which would strand a 0/0 child left). Null for non-BoxContainer nodes.
  containerLayout: string | null;
  // A stable identity for the CONTENT this node shows — STATIC (rides add/keyframe/re-attach; mergeNode carries it
  // forward across volatile-only upserts). Today the only case is a card: STS2 POOLS `NCard` visuals (~30 instances
  // re-assigned as cards move between hand/draw/discard/reward/shop), so a node's instance id says nothing about
  // WHICH card is on screen — the same id is a Strike this tick and a Bash the next, and two ids may both be
  // Strike. The key is `nc:{entry}#{serial}`: `{entry}` is the card DEFINITION id (shared by duplicates, so it is
  // content-addressable) and `{serial}` separates the instances that share one definition, allocated per card MODEL
  // so it survives the card being recycled through different pooled nodes. Null for every node without one.
  contentKey: string | null;
  // Volatile: the anim the game is currently playing on this SpineSprite + its track time (seconds). The
  // playback layer fetches the `spineCurrentAnim` clip and shows the frame nearest `spineTrackTime`.
  spineCurrentAnim: string | null;
  // Volatile: the runtime SKIN the game currently has set on the SpineSprite (null when unknown). Folded into the
  // clip identity — the client appends `&skin=` (only when present) and re-requests the clip when it changes, so a
  // skinned creature (Fossil Stalker / Skulking Colony) bakes with the same skin the live game shows.
  spineSkin: string | null;
  // Volatile: a short signature of the SpineSprite's `normal_material` ShaderMaterial (null when it has none —
  // nearly every node). Folded into the clip identity like `spineSkin`: the client appends `&mat=` (only when
  // present) and re-requests the clip when it changes. The bake APPLIES that material to a standalone-skeleton
  // render (the boss map point's channel-remap mask shader, re-tinted per act + travel state), so the rendered
  // pixels depend on values that are not part of the (scene, node, anim, skin, skel) address.
  spineMat: string | null;
  // Volatile: the game PAUSED this track (MegaAnimationState.SetTimeScale(0)). The playback layer then HOLDS the
  // streamed track time instead of free-running the clip off the wall clock — the treasure chest sits frozen on
  // the closed-chest first frame until it is opened, and free-running walked it open.
  spinePaused: boolean;
  spineTrackTime: number;
  // Volatile: whether the current anim LOOPS. The playback layer loops the clip when true and FREEZES on its
  // last frame when false — so a one-shot (attack/cast/hurt/die) plays once and holds instead of replaying
  // forever (the flicker). Defaults true (the producer's looping fallback before the first anim signal).
  spineLooping: boolean;
  // Volatile: a DECLARATIVE INFINITE ANIMATION the producer pinned to its rest value on this node, named so the
  // renderer can replay it on the browser's own clock (`RuntimeSceneNodeDelta.PinnedLoopAnim`). It changes only
  // when the animation starts/stops, so a running loop costs NOTHING on the wire — that is the whole point: the
  // pinned animators are per-frame sine sweeps that otherwise kept a visually idle screen streaming.
  //
  // The vocabulary is the client's (see mirrorRenderer's pinned-loop pass). Today the only token is
  // "mapPointPulse": a TRAVELABLE map node's icon container breathing in place — scale sweeping 0.95..1.45 on a
  // 4 rad/s sine (see animAttributes). Unlike the path-keyed `nodeAnimBinding` folds, membership here is DYNAMIC
  // (it changes as you travel the map), which is exactly why it has to ride the wire instead of a static table.
  // Null for every node without a pinned loop (almost all of them).
  pinnedLoopAnim: string | null;
  // Volatile (the game recolors a label's outline at runtime — e.g. HP outline turns blue while blocking).
  outline: MirrorOutline | null;
  // Placement: parent-local transform matrix [a,b,c,d,tx,ty] + node-local box. The renderer draws the box with
  // CSS matrix() so rotation/scale/pivot + ancestor transforms are baked in (no double transform / orbit).
  transform: number[] | null;
  localRect: MirrorRect | null;
  visible: boolean;
  // Authoritative NClickableControl focus. The producer polls this only for capable nodes; absent on an older
  // host and explicit false both normalize to false. Volatile: focus loss must replace a retained true.
  focused: boolean;
  opacity: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  pivotX: number;
  pivotY: number;
  zIndex: number | null;
  textureUrl: string | null;
  // AtlasTexture crop (volatile). When set, `textureUrl` is the STABLE underlying atlas image and these are
  // the sub-rect/frame to show via CSS background-position (so animation frames don't swap the URL → no
  // flicker). `textureMargin` is the transparent frame Godot draws the region inside.
  textureRegion: MirrorRect | null;
  textureMargin: MirrorRect | null;
  ninePatch: boolean;
  modulate: MirrorColor | null;
  selfModulate: MirrorColor | null;
  fillColor: MirrorColor | null;
  range: MirrorRange | null;
  text: MirrorText | null;
  // Enemy-intent glyph frame set (producer-streamed). Non-null only on the intent glyph Sprite2D. STICKY: the
  // producer re-ships it only when the intent animation changes, carried forward otherwise (see mergeNode). When
  // present, this node's textureUrl/textureRegion/textureMargin are forced to frame 0 so the existing atlas-canvas
  // renderer paints the glyph (independent of the frozen sprite's stale/missing texture), and the renderer's intent
  // ticker cycles the remaining frames on the same canvas. Optional so unrelated node builders (tests, other
  // renderers) need not set it; normalizeNode always populates it (null when absent).
  intentFrames?: MirrorIntentFrames | null;
  // LINE2D STROKE GEOMETRY (the map quill annotations). Non-null only on a `Line2D` — the handful of strokes
  // appended live under the map's DrawViewport. A Line2D has no texture rect and no text, so its ENTIRE appearance
  // is these three: `linePoints` is FLATTENED (`[x0,y0,x1,y1,…]`) NODE-LOCAL geometry, `lineWidth` the Godot
  // stroke width in node-local units (4 pen / 12 eraser), `lineColor` its `default_color`. The producer streams
  // NO localRect for a Line2D, so `linePoints != null` is what tells the renderer this node needs an element.
  //
  // STICKY as one unit (the intentFrames policy, not the per-tick text policy): the producer re-ships all three
  // only when the stroke's cheap signature changed, so mergeNode carries them forward otherwise — mandatory,
  // because a dormant/occluded stroke repaints from the RETAINED points when it is revealed. An EMPTY array is
  // meaningful and distinct from null: the stroke was CLEARED (undo / clear-all) and the client must erase it.
  //
  // Joint/cap modes are not streamed (constant round — hard-coded by the renderer) and neither is an eraser flag:
  // an eraser is exactly the stroke whose `shaderId` ends with `line_erase.gdshader`. Optional so unrelated node
  // builders (tests, other renderers) need not set them; normalizeNode always populates them (null when absent).
  linePoints?: number[] | null;
  lineWidth?: number | null;
  lineColor?: MirrorColor | null;
}

// A fire-and-forget decorative tween the client replays declaratively on the matching node (keyed by `targetId`,
// the node's instance id — the same id space as MirrorNode.id). `property` is the raw Godot property
// (`"position"`/`"scale"`/`"modulate:a"`/`"rotation"`); `to` is the target value as compact JSON or null;
// `trans`/`ease` are raw Godot enum names the client maps to a CSS timing function.
export interface MirrorTweenHint {
  targetId: string;
  property: string;
  to: string | null;
  durationMs: number;
  trans: string | null;
  ease: string | null;
  // Declarative endpoint the client replays (Part C). `endTransform` is the tween TARGET node's END GLOBAL
  // Transform2D as a CSS 6-tuple [a,b,c,d,tx,ty] (the client rigidly propagates it across the target's subtree);
  // `endOpacity` is the target's END modulate.a. `group` ties a Godot tween's transform + opacity hints together.
  // Null when the producer couldn't resolve an endpoint (older transport / looping / unsupported tween).
  endTransform: number[] | null;
  endOpacity: number | null;
  group: string | null;
  // Declarative START (Fix 2), same shape as end*. When present the client PRIMES the node here (no transition)
  // before transitioning to the endpoint, so a re-anchored/primed node (e.g. the shared main-menu focus ribbon)
  // replays from its real start instead of showing a 1-frame transient. Null unless the tween declared `.From(...)`.
  startTransform: number[] | null;
  startOpacity: number | null;
  /**
   * THE PARENT THE TRANSFORM ENDPOINTS ARE AUTHORED AGAINST, stamped by `applySceneDelta` from the map as the
   * hint's own delta left it. Not a wire field.
   *
   * `endTransform`/`startTransform` are parent-relative, so they only mean anything composed onto the parent the
   * target had when the producer emitted them. `pendingHints` is an accumulator —
   * several deltas routinely coalesce into one rendered frame — so by the time a renderer drains a hint the
   * target may already have been re-parented by a LATER delta, and lifting through the new parent silently
   * re-bases the endpoint into a space it was never written in. Undefined only for a hint that did not come
   * through `applySceneDelta` (older callers, unit fixtures); a consumer must treat that as "unknown", not as a
   * mismatch.
   */
  parentIdAtArrival?: string | null;
}

// WS-3 — the discard→draw shuffle CARD FLIGHT, as a declarative description the client INTEGRATES per frame.
//
// Why it is not a MirrorTweenHint. `NCardFlyShuffleVfx` (one instance per shuffled card) is not a Godot `Tween`:
// it animates in an async loop that steps once per rendered GAME frame, so there is no tweener for the producer's
// tween recorder to capture and no single endpoint a CSS transition could ease to — the path is a quadratic bezier
// walked by an ACCELERATING integrator, with the node's rotation re-derived from the tangent every step. It used to
// reach the mirror the only way it could: ~60 streamed transform deltas per second per flying card. A 34.8s wire
// recording measured that at 598 KB — 45% of the shuffle's upsert bytes and 1852 of its 3469 upserts — and, because
// scene deltas are credit-gated on the client's ack, the animation played back at the CLIENT's frame rate (traced:
// 9.4fps for 1.7s). These ~11 numbers replace all of it.
//
// THE PRODUCER HAS STOPPED STREAMING THESE NODES. Accepting a flight is not optional decoration: for `windowMs`
// after it starts, the producer suppresses transform deltas for the flight node's subtree and for the trail's two
// stroke Line2Ds, so a client that ignores the hint sees the CARD freeze.
//
// SPACES. `start`/`end`/`control` are streamed-space `[x, y]`; `basis` is a streamed-space `[a, b, c, d]` 2x2 basis.
// They are authored in game design space and lifted through the retained parent frame because their pile anchors
// live under different parents.
export interface MirrorCardFlightHint {
  // The `NCardFlyShuffleVfx` node (same id space as MirrorNode.id).
  targetId: string;
  // Its `NCardTrailVfx` comet root. The client DRIVES this node for the flight's duration (R14c): it is the comet's
  // transform carrier, so writing the integrated pose onto its element places the whole trail scene — the sparks and
  // silhouettes that stream their poses relative to it, and the two `NCardTrail` strokes under it, whose synthesized
  // ribbon is fed from the same locally-integrated head instead of from their (suppressed) streamed motion. The id
  // is what finds all of them. Null when there is no trail.
  trailId: string | null;
  start: number[];
  end: number[];
  // The bezier control point, already resolved producer-side — the client never re-derives it. It is expressed in
  // Godot DESIGN space (the same 1920x1080 space `start` / `end` are in), so it needs no further mapping here.
  control: number[];
  // The flight node's streamed basis with its OWN rotation divided out and its spawn scale folded in: the client
  // composes `basis · R(rotation) · (popScale / scale0)`.
  basis: number[];
  // The flight's streamed speed / acceleration / duration. `duration` is NOT seconds: it is in the same pseudo-time
  // unit the client's replay integrates in, where `time` accumulates `speed*dt` with speed ≈ 1.1…1.25 and rising.
  speed0: number;
  accel: number;
  duration: number;
  // The flight node's own uniform scale at spawn (the scene authors 1.0). Phase 2 ASSIGNS an absolute scale, so the
  // client's multiplier is `popScale / scale0` — which is what makes the card visibly POP to a tenth before it goes.
  scale0: number;
  // How long (wall-clock ms) the producer has stopped streaming these nodes' transforms. The client holds its own
  // pin exactly this long, so it releases one frame AFTER the producer's settle re-emit and no frozen transform can
  // ever paint in between.
  windowMs: number;
  // Which flight this is, already NORMALIZED by the parser — the renderer never sees a null or an unrecognised
  // spelling. "shuffle" is the sweep between the piles, whose flier is a throwaway that pops out of existence at
  // the far end. "discard" is the hand→discard fly, and its one difference on screen is that the thing moving is
  // the REAL card the player just played — the same element that was in the hand a frame ago — so it also turns
  // smoothly out of the angle it was resting at (`rot0`) instead of snapping onto the curve. An absent or unknown
  // kind reads as "shuffle": motion the client already knows is always better than a dropped, frozen card.
  kind: "shuffle" | "discard";
  // The mover's on-screen angle (radians, same streamed space as the geometry above) when the flight started: the
  // rotation the "discard" replay eases out of. 0 for "shuffle", which has no prior pose to preserve.
  rot0: number;
}

// The leaf (final dotted segment) of a Godot type name. Called per node per walk on a bounded key set (the finite
// set of Godot type-name strings), so memoize the slice — the string work showed up as a self-time hotspot in the
// combat trace. The map grows only with distinct type names (dozens), so it never needs eviction.
//
// It lives HERE, next to the wire node it reads, so a policy module can key on a node type without importing a
// stage backend to do it (`mirrorRenderer` re-exports it, so every existing importer is unchanged).
const nodeTypeLeafMemo = new Map<string, string>();
export function nodeTypeLeaf(nodeType: string): string {
  let leaf = nodeTypeLeafMemo.get(nodeType);
  if (leaf === undefined) {
    leaf = nodeType.slice(nodeType.lastIndexOf(".") + 1);
    nodeTypeLeafMemo.set(nodeType, leaf);
  }
  return leaf;
}

// An incremental draw-order update (Stage 4 wire diet): instead of the full ~52KB orderedIds array on every
// structural change, the server ships only the parents whose child lists changed (+ the roots when they changed).
// The client rebuilds its (rootIds, childIdsByParent) structure from the PREVIOUS orderedIds + node map, applies
// the patch, and pre-order flattens to the new orderedIds — byte-identical to the array the server would have sent.
export interface MirrorOrderPatch {
  // The new root id list, present ONLY when the roots changed (null → roots unchanged).
  roots: string[] | null;
  // Each dirty parent's NEW ordered child id list (empty list clears a parent that lost all its children).
  parents: { p: string; c: string[] }[];
}

export interface MirrorDelta {
  full: boolean;
  screenType: string;
  upserts: MirrorNode[];
  removedIds: string[];
  orderedIds: string[] | null;
  // Stage 4: an incremental order update, present INSTEAD of orderedIds on a structural change (never both). Null
  // when the delta carries a full orderedIds array (or no structural change).
  orderPatch: MirrorOrderPatch | null;
  hints: MirrorTweenHint[];
  // WS-3 declarative card flights started this tick (see MirrorCardFlightHint). Separate from `hints`: these are
  // integrated per frame rather than eased, and they arrive with the producer having stopped streaming their nodes.
  cardFlights: MirrorCardFlightHint[];
}

export interface MirrorState {
  screenType: string;
  nodes: Map<string, MirrorNode>;
  orderedIds: string[];
  // Bumped on every applied delta; the renderer watches this to recompute (the Map is mutated in place).
  revision: number;
  // Ids upserted/removed since the renderer last consumed (cleared) this set. Accumulates across deltas so that
  // when Vue coalesces several deltas into one reconcile, the renderer still sees every change. The reconciler
  // propagates these to ancestors to know which subtrees to descend into (a child changes without its parent
  // being re-sent, so node-object identity alone can't tell an ancestor its subtree is dirty).
  changedIds: Set<string>;
  // A `full:true` KEYFRAME was applied since the renderer last consumed (cleared) this flag: the node map was
  // wiped and re-established from scratch, so the scene the renderer holds is a NEW scene rather than an edit of
  // the old one. The renderer's walk-mode classifier reads this as the one and only "take the full path" signal
  // for an orderedIds-changed reconcile (the full path owns the wholesale re-establish: hide-latch clears, shader
  // memo reset, up-front condemn). Same lifecycle as `changedIds` — it ACCUMULATES (stays true) across deltas
  // coalesced into one reconcile and is cleared at the same point, so a keyframe can never be missed because a
  // volatile delta landed behind it in the same frame.
  sceneRewrite: boolean;
  // One-shot tween hints accumulated since the renderer last drained them (cleared each reconcile after it fires
  // the replays). Accumulates across deltas like `changedIds` so Vue coalescing several deltas loses no hint.
  pendingHints: MirrorTweenHint[];
  // WS-3: one-shot declarative card flights, same accumulate/drain lifecycle as `pendingHints`.
  pendingCardFlights: MirrorCardFlightHint[];
}

export function createMirrorState(): MirrorState {
  return {
    screenType: "unknown",
    nodes: new Map(),
    orderedIds: [],
    revision: 0,
    changedIds: new Set(),
    sceneRewrite: false,
    pendingHints: [],
    pendingCardFlights: [],
  };
}

export function parseSceneDelta(raw: unknown): MirrorDelta | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (record.type !== "scene-delta") {
    return null;
  }

  const upsertsRaw = Array.isArray(record.upserts) ? record.upserts : [];
  const upserts: MirrorNode[] = [];
  for (const entry of upsertsRaw) {
    const node = normalizeNode(entry);
    if (node) {
      upserts.push(node);
    }
  }

  const hintsRaw = Array.isArray(record.hints) ? record.hints : [];
  const hints: MirrorTweenHint[] = [];
  for (const entry of hintsRaw) {
    const hint = normalizeTweenHint(entry);
    if (hint) {
      hints.push(hint);
    }
  }

  const flightsRaw = Array.isArray(record.cardFlights) ? record.cardFlights : [];
  const cardFlights: MirrorCardFlightHint[] = [];
  for (const entry of flightsRaw) {
    const flight = normalizeCardFlight(entry);
    if (flight) {
      cardFlights.push(flight);
    }
  }

  return {
    full: record.full === true,
    screenType: asString(record.screenType),
    upserts,
    removedIds: Array.isArray(record.removedIds)
      ? record.removedIds.map((id) => String(id))
      : [],
    orderedIds: Array.isArray(record.orderedIds)
      ? record.orderedIds.map((id) => String(id))
      : null,
    orderPatch: normalizeOrderPatch(record.orderPatch),
    hints,
    cardFlights,
  };
}

// WS-3 declarative card flight. STRICT, unlike the tolerant node/hint normalizers: the producer has STOPPED
// streaming the named nodes for `windowMs`, so a half-parsed flight would leave them frozen rather than merely
// un-eased. Every required point/basis must be present with the right arity and finite, and every integrator scalar
// must be usable (a non-positive duration/speed never advances, a zero spawn scale divides by zero in phase 2).
// Anything else is dropped, and a dropped flight is the SAFE state only because the host's suppression is gated on
// the same `?cardFlight` lever the client is — see MirrorCardFlightHint.
// 1:1 twin of SceneDeltaReader.NormalizeCardFlight (C#); the parse-parity suite replays fixtures through both.
//
// R12 WS-B: every rejection is COUNTED (see `cardFlightParseDrops`). A dropped hint never reaches the renderer, so
// none of its flight counters can see it — "the host is not sending" and "the host is sending malformed hints" look
// identical from the renderer's side, and the two need different fixes.
function normalizeCardFlight(entry: unknown): MirrorCardFlightHint | null {
  const flight = parseCardFlight(entry);
  if (!flight) {
    flightParseDrops++;
  }
  return flight;
}

// The module-level total of hints the parser rejected, for the life of the page. Cumulative on purpose: a walk-stats
// window reset must not be able to claim the drops un-happened (see mirrorWalkStats.cardFlightParseDrops).
let flightParseDrops = 0;

/** How many `cardFlights[]` entries the strict parser has rejected since page load. Read as a gauge — see
 *  `mirrorWalkStats.cardFlightParseDrops`, which surfaces it in the one-glance dump. */
export function cardFlightParseDrops(): number {
  return flightParseDrops;
}

/** Test seam: zero the parse-drop total so one spec's malformed fixtures cannot leak into the next's assertions. */
export function __resetCardFlightParseDropsForTest(): void {
  flightParseDrops = 0;
}

function parseCardFlight(entry: unknown): MirrorCardFlightHint | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const r = entry as Record<string, unknown>;
  const targetId = asString(r.targetId);
  if (!targetId) {
    return null;
  }
  const nums = (v: unknown, arity: number): number[] | null =>
    Array.isArray(v) &&
    v.length === arity &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
      ? (v as number[])
      : null;
  const scalar = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const start = nums(r.start, 2);
  const end = nums(r.end, 2);
  const control = nums(r.control, 2);
  const basis = nums(r.basis, 4);
  if (!start || !end || !control || !basis) {
    return null;
  }
  const duration = scalar(r.duration);
  const speed0 = scalar(r.speed0);
  const accel = scalar(r.accel);
  const scale0 = scalar(r.scale0);
  const windowMs = scalar(r.windowMs);
  if (
    duration == null ||
    duration <= 0 ||
    speed0 == null ||
    speed0 <= 0 ||
    accel == null ||
    scale0 == null ||
    Math.abs(scale0) <= 1e-6 ||
    windowMs == null ||
    windowMs <= 0
  ) {
    return null;
  }
  const trailId = typeof r.trailId === "string" && r.trailId ? r.trailId : null;

  // The two OPTIONAL fields are the one place this parser is deliberately LENIENT, and in the opposite direction to
  // everything above: an absent, misspelled or future kind FAILS OPEN to "shuffle" instead of dropping the entry.
  // Dropping is right for unusable geometry (there is nothing to integrate); here every number is valid, so the
  // worst an unknown kind costs is the wrong flavour of motion, while a drop would leave a suppressed node frozen.
  // `rot0` only seeds a turn, so anything unusable reads as 0.
  const kind = r.kind === "discard" ? "discard" : "shuffle";
  const rot0 = scalar(r.rot0) ?? 0;

  return {
    targetId,
    trailId,
    start,
    end,
    control,
    basis,
    speed0,
    accel,
    duration,
    scale0,
    windowMs,
    kind,
    rot0,
  };
}

// Parse a Stage 4 order patch: { roots?: string[], parents: [{p, c: string[]}] }. Returns null when absent/malformed
// (the delta then falls back to the full orderedIds keyframe path).
function normalizeOrderPatch(raw: unknown): MirrorOrderPatch | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const parentsRaw = Array.isArray(record.parents) ? record.parents : [];
  const parents: { p: string; c: string[] }[] = [];
  for (const entry of parentsRaw) {
    const pr = asRecord(entry);
    if (!pr) {
      continue;
    }
    const p = asString(pr.p);
    if (!p) {
      continue;
    }
    const c = Array.isArray(pr.c) ? pr.c.map((id) => String(id)) : [];
    parents.push({ p, c });
  }
  return {
    roots: Array.isArray(record.roots) ? record.roots.map((id) => String(id)) : null,
    parents,
  };
}

function normalizeTweenHint(entry: unknown): MirrorTweenHint | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const r = entry as Record<string, unknown>;
  const targetId = asString(r.targetId);
  const property = asString(r.property);
  if (!targetId || !property) {
    return null;
  }
  const asTransform6 = (v: unknown): number[] | null =>
    Array.isArray(v) &&
    v.length === 6 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
      ? (v as number[])
      : null;
  return {
    targetId,
    property,
    to: typeof r.to === "string" ? r.to : null,
    durationMs:
      typeof r.durationMs === "number" && Number.isFinite(r.durationMs)
        ? r.durationMs
        : 0,
    trans: typeof r.trans === "string" ? r.trans : null,
    ease: typeof r.ease === "string" ? r.ease : null,
    endTransform: asTransform6(r.endTransform),
    endOpacity:
      typeof r.endOpacity === "number" && Number.isFinite(r.endOpacity)
        ? r.endOpacity
        : null,
    group: typeof r.group === "string" ? r.group : null,
    startTransform: asTransform6(r.startTransform),
    startOpacity:
      typeof r.startOpacity === "number" && Number.isFinite(r.startOpacity)
        ? r.startOpacity
        : null,
  };
}

// Apply a delta to the retained map in place. Static fields merge forward (an add/keyframe carries the
// static styling block; a later volatile-only upsert leaves them defaulted and must not erase them).
export function applySceneDelta(state: MirrorState, delta: MirrorDelta): void {
  if (delta.full) {
    state.nodes.clear();
    state.orderedIds = [];
    // Explicit scene-rewrite signal for the renderer's walk-mode classifier (see MirrorState.sceneRewrite). It is
    // NOT inferable from the upsert count: a keyframe re-upserts every node, but so does a big volatile tick, and
    // only the keyframe wiped the map. Cleared by the renderer alongside changedIds.
    state.sceneRewrite = true;
  }

  for (const id of delta.removedIds) {
    state.nodes.delete(id);
    state.changedIds.add(id);
  }

  // R10: did this delta INTRODUCE a node id the map had never held? See the late-node guard below.
  let introducedNode = false;
  for (const upsert of delta.upserts) {
    const existing = state.nodes.get(upsert.id);
    if (!existing) {
      introducedNode = true;
    }
    state.nodes.set(upsert.id, existing ? mergeNode(existing, upsert) : upsert);
    state.changedIds.add(upsert.id);
  }

  // Order: a full orderedIds array replaces it wholesale; a Stage 4
  // patch is applied to the structure rebuilt from the PREVIOUS orderedIds + the now-current node map, then
  // pre-order flattened into a NEW array (reference change so the renderer re-derives its structure).
  if (delta.orderedIds) {
    state.orderedIds = delta.orderedIds;
  } else if (delta.orderPatch) {
    state.orderedIds = applyOrderPatch(state, delta.orderPatch);
  } else if (introducedNode && state.orderedIds.length > 0) {
    // The renderer selects a
    // STRUCTURAL walk purely on `state.orderedIds !== lastOrderedIds`; an "update" walk never runs
    // rebuildStructure, so a node the map did not previously hold is merged and then never placed in the tree —
    // it renders as NOTHING until some later delta happens to change the order. That is only reachable when a
    // node's id is already in the order before its first upsert arrives, which is exactly what a producer that
    // ships pruned hidden subtrees in OrderedIds does (the missing targeting arrow after a game restart, the
    // missing treasure relics until a browser reload). spirectl's producer no longer does that
    // (SPIRECTL_SCENE_WATCH_ORDER_EMITTED_ONLY) and the host prunes its keyframe order to match, so this normally
    // never fires — it is the client-side belt that makes the renderer correct against ANY producer. A fresh array
    // REFERENCE (same contents) is the whole mechanism: it costs one structural walk, and only on a delta that
    // genuinely introduced a node without touching the order.
    state.orderedIds = state.orderedIds.slice();
  }

  if (delta.hints.length > 0) {
    // Stamp each hint with the parent its endpoints are relative to — this delta's, since the upserts above have
    // already landed. See `MirrorTweenHint.parentIdAtArrival` for why a drain-time read is not the same answer.
    for (const hint of delta.hints) {
      hint.parentIdAtArrival = state.nodes.get(hint.targetId)?.parentId ?? null;
    }
    state.pendingHints.push(...delta.hints);
    // Safety valve: the renderer drains this each reconcile, but bound it so a consumer that isn't wired yet
    // (or a render stall) can't grow it without limit — hints are one-shot, so dropping the oldest is harmless.
    if (state.pendingHints.length > 256) {
      state.pendingHints.splice(0, state.pendingHints.length - 256);
    }
  }

  if (delta.cardFlights.length > 0) {
    state.pendingCardFlights.push(...delta.cardFlights);
    // Smaller valve than the hints above: a flight is one per SHUFFLED CARD (tens, not hundreds), and dropping one
    // leaves its node frozen for its window rather than merely un-eased — so a long backlog is worse here.
    if (state.pendingCardFlights.length > 64) {
      state.pendingCardFlights.splice(0, state.pendingCardFlights.length - 64);
    }
  }

  state.screenType = delta.screenType;
  state.revision += 1;
}

// An ORPHAN: the node names a `parentId` that is NOT live in the current map. A TRUE producer root (parentId
// null/absent) is not one. Both structure builders — this module's buildOrderStructure and the renderer's
// rebuildStructure — order an orphan as a stage ROOT, which is fine for ORDER but wrong for PLACEMENT: the node's
// streamed transform belongs to a chain the client can't reconstruct, so drawing it at the stage root collapses it
// onto (or near) the design origin — the "phantom in the top-left corner" class. The renderer therefore HOLDS an
// orphan invisible until its parent becomes live or a keyframe re-establishes it. Exported so the two builders can
// never drift on what counts as one.
export function isOrphanNode(node: MirrorNode, nodes: Map<string, MirrorNode>): boolean {
  return node.parentId != null && !nodes.has(node.parentId);
}

// Build the (rootIds, childIdsByParent) structure for one draw order using the EXACT rules the renderer's
// rebuildStructure uses (and that the server's SceneStructureIndex mirrors): skip an id whose node isn't live, and
// an id is a child of its parent only when the parent is ALSO live (else a root). Sibling order follows `order`.
// `orphanIds` additionally names the roots that only got there because their parent is missing (see isOrphanNode);
// it is pure extra INFORMATION — the returned order is byte-identical with or without it.
function buildOrderStructure(
  order: string[],
  nodes: Map<string, MirrorNode>,
): {
  rootIds: string[];
  childIdsByParent: Map<string, string[]>;
  orphanIds: Set<string> | null;
} {
  const childIdsByParent = new Map<string, string[]>();
  const rootIds: string[] = [];
  // Lazily allocated: an orphan is rare (a reparent race / a pruned parent), so a clean scene pays nothing.
  let orphanIds: Set<string> | null = null;
  for (const id of order) {
    const node = nodes.get(id);
    if (!node) {
      continue;
    }
    if (node.parentId != null && nodes.has(node.parentId)) {
      let list = childIdsByParent.get(node.parentId);
      if (!list) {
        list = [];
        childIdsByParent.set(node.parentId, list);
      }
      list.push(id);
    } else {
      rootIds.push(id);
      if (node.parentId != null) {
        (orphanIds ??= new Set()).add(id);
      }
    }
  }
  return { rootIds, childIdsByParent, orphanIds };
}

// Pre-order DFS flatten of (rootIds, childIdsByParent) → the draw order. The producer's orderedIds IS this
// pre-order traversal, so flattening reconstructs the exact array the server would have sent.
function flattenOrder(rootIds: string[], childIdsByParent: Map<string, string[]>): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (let i = rootIds.length - 1; i >= 0; i--) {
    stack.push(rootIds[i]);
  }
  while (stack.length > 0) {
    const id = stack.pop() as string;
    out.push(id);
    const kids = childIdsByParent.get(id);
    if (kids) {
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push(kids[i]);
      }
    }
  }
  return out;
}

// Apply a Stage 4 order patch: rebuild the base structure from the previous orderedIds + current nodes, overwrite
// each dirty parent's child list (and the roots when the patch carries them), then flatten to the new order.
function applyOrderPatch(state: MirrorState, patch: MirrorOrderPatch): string[] {
  const { rootIds, childIdsByParent } = buildOrderStructure(state.orderedIds, state.nodes);
  for (const { p, c } of patch.parents) {
    childIdsByParent.set(p, c);
  }
  return flattenOrder(patch.roots ?? rootIds, childIdsByParent);
}

// A non-empty `name` marks an upsert that carries the static block (add/keyframe). A volatile-only
// upsert (empty name) keeps the retained node's static styling.
function mergeNode(existing: MirrorNode, upsert: MirrorNode): MirrorNode {
  if (upsert.name) {
    return upsert;
  }
  // IntentFrames is STICKY (producer re-ships only on intent change): carry the retained set forward on a
  // volatile-only upsert, but let a fresh non-null upsert (the intent just changed) replace it. Then re-apply the
  // frame-0 texture override, since a volatile upsert carries the frozen sprite's own (stale) texture in `...upsert`
  // that would otherwise win over the retained intent frames.
  const intentFrames = upsert.intentFrames ?? existing.intentFrames;
  // The Line2D stroke unit is STICKY on the SAME policy: the producer re-ships points/width/colour together only
  // when the stroke's signature changed, so a volatile-only upsert carries null for all three and must keep the
  // retained geometry. Not an optimisation — a stroke that is dormant/occluded and later revealed repaints from
  // these retained points, so dropping the carry-forward would blank every finished stroke on the map one tick
  // after it appeared. An EMPTY (not null) upsert array is a real "cleared" instruction and correctly wins.
  // Godot's own line breaking is STICKY on the SAME policy, and for a sharper reason than the two above: the
  // producer re-ships it when the label is RE-DESCRIBED, which is exactly when its words may have changed, so a
  // fresh non-null upsert must REPLACE the retained wrap rather than be merged into it. Retaining unconditionally
  // would pin the first wrap a label ever had — and since the block carries the hash of the string it was measured
  // against, a pinned wrap does not draw the wrong words, it simply stops being used. That is the failure
  // direction this whole channel is built to fall in.
  const textWrap = upsert.textWrap ?? existing.textWrap;
  const linePoints = upsert.linePoints ?? existing.linePoints;
  const lineWidth = upsert.lineWidth ?? existing.lineWidth;
  const lineColor = upsert.lineColor ?? existing.lineColor;
  const merged: MirrorNode = {
    ...upsert,
    name: existing.name,
    nodeType: existing.nodeType,
    showBehindParent: existing.showBehindParent,
    clipChildren: existing.clipChildren,
    clipContents: existing.clipContents,
    ninePatchMargins: existing.ninePatchMargins,
    font: existing.font,
    // The per-role rich-text fonts (+ their sizes / glyph spacing) are STATIC exactly like `font` — theme items
    // don't change at runtime, so the producer rides them on add/keyframe only and a volatile-only upsert carries
    // null. Dropping them here would lose a rich label's bold face one tick after it appears (the ClipChildren
    // lesson) — which is precisely the "bold works for one frame then reverts" failure mode.
    richBoldFont: existing.richBoldFont,
    richItalicFont: existing.richItalicFont,
    richBoldItalicFont: existing.richBoldItalicFont,
    richBoldFontSizePx: existing.richBoldFontSizePx,
    richItalicFontSizePx: existing.richItalicFontSizePx,
    richBoldItalicFontSizePx: existing.richBoldItalicFontSizePx,
    richBoldFontSpacingPx: existing.richBoldFontSpacingPx,
    richItalicFontSpacingPx: existing.richItalicFontSpacingPx,
    richBoldItalicFontSpacingPx: existing.richBoldItalicFontSpacingPx,
    textWrap,
    // `outline` is intentionally NOT retained: it's volatile (the producer streams it every emission) so a
    // runtime recolor (HP outline → blue while blocking) takes effect on a volatile-only upsert.
    shadow: existing.shadow,
    richText: existing.richText,
    shaderId: existing.shaderId,
    materialRef: existing.materialRef,
    // `shaderParams` is NOT kept: it's volatile (numeric uniforms refresh per tick so animating shaders like
    // screen transitions update), so a volatile-only upsert for a shader node carries the fresh values.
    textureStretchMode: existing.textureStretchMode,
    textureFlipH: existing.textureFlipH,
    textureFlipV: existing.textureFlipV,
    canvasBlendMode: existing.canvasBlendMode,
    // `particleSpec` is STATIC — keep it across volatile-only upserts (the ClipChildren lesson) or it vanishes
    // on the first per-tick emission. `particleEmitting`/`particleRestartEpoch` are volatile (come from upsert).
    particleSpec: existing.particleSpec,
    // Spine scene/node/anims are STATIC (the clip key); keep them across volatile-only upserts. The volatile
    // `spineCurrentAnim`/`spineTrackTime` ride the upsert (the `...upsert` spread above) so playback tracks live.
    spineSceneResPath: existing.spineSceneResPath,
    spineNodePath: existing.spineNodePath,
    spineAnimations: existing.spineAnimations,
    // The skeleton path is STATIC too (rides the spine block); keep it. Volatile `spineSkin` rides the `...upsert`
    // spread above so a per-tick skin change takes effect.
    spineSkelResPath: existing.spineSkelResPath,
    // SceneFilePath is STATIC (only on add/keyframe); keep it across volatile-only upserts.
    sceneFilePath: existing.sceneFilePath,
    // MouseFilter is STATIC too — keep it or a Control drops out of the mouse-visible interactive-rect set (and its
    // `data-mouse-filter` stamp) on the first volatile-only tick.
    mouseFilter: existing.mouseFilter,
    // Anchor fractions are STATIC (add/keyframe only) — keep them across volatile-only upserts or the
    // wide-screen re-layout data vanishes one tick after the node appears.
    anchorLeft: existing.anchorLeft,
    anchorRight: existing.anchorRight,
    anchorOwnerId: existing.anchorOwnerId,
    // ContainerLayout is STATIC (add/keyframe only) — keep it across volatile-only upserts, or the wide-screen
    // container re-layout data vanishes one tick after the container appears.
    containerLayout: existing.containerLayout,
    // ContentKey is STATIC (add/keyframe/re-attach only) — keep the retained one, or a pooled card node loses its
    // content identity on the first per-tick upsert. A pooled shell RE-ASSIGNED to another card arrives as a static
    // payload (with a name), which takes the `return upsert` branch above, so a re-assignment's new key wins.
    contentKey: existing.contentKey,
    intentFrames,
    linePoints,
    lineWidth,
    lineColor,
  };
  return applyIntentFrame0(merged);
}

// When a node carries an intent frame set, force its textureUrl/textureRegion/textureMargin to frame 0 so the
// existing atlas-canvas renderer paints the glyph through the normal sprite path (the renderer's intent ticker then
// cycles the remaining frames). Idempotent no-op for nodes without intent frames. Mutates + returns `node`.
function applyIntentFrame0(node: MirrorNode): MirrorNode {
  const frame0 = node.intentFrames?.frames[0];
  if (frame0) {
    node.textureUrl = frame0.url;
    node.textureRegion = frame0.region;
    node.textureMargin = frame0.margin;
  }
  return node;
}

function normalizeNode(raw: unknown): MirrorNode | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const id = asString(record.id);
  if (!id) {
    return null;
  }

  // Normalized ONCE: it feeds both the node's own `shaderParams` and (for a particle node) the shader
  // flipbook baked into the static particle spec.
  const shaderParams = normalizeShaderParams(record.shaderParameters);

  const node: MirrorNode = {
    id,
    parentId: record.parentId == null ? null : String(record.parentId),
    name: asString(record.name),
    nodeType: asString(record.nodeType),
    showBehindParent: record.showBehindParent === true,
    clipChildren: asNumber(record.clipChildren),
    // Omitted by the producer unless TRUE (wire-defaults convention), so absent reads as false.
    clipContents: record.clipContents === true,
    ninePatchMargins: normalizeMargins(record.ninePatchMargins),
    font: normalizeFont(record.font, record.fontWeight, record.fontStyle),
    // Per-role rich-text fonts: the SAME resolved-descriptor shape as `font`, but the producer streams no
    // weight/style for a role (the FILE is the role), so both read null and the injected @font-face declares
    // neither. Absent on every node without a distinct role font → null (prior behaviour, byte for byte).
    richBoldFont: normalizeFont(record.richBoldFont, null, null),
    richItalicFont: normalizeFont(record.richItalicFont, null, null),
    richBoldItalicFont: normalizeFont(record.richBoldItalicFont, null, null),
    // `== null` keeps the null-vs-0 distinction: a 0 spacing is never streamed (the producer omits it), and a 0
    // size would be meaningless, but the null MUST survive as "nothing to say for this role".
    richBoldFontSizePx: record.richBoldFontSizePx == null ? null : asNumber(record.richBoldFontSizePx),
    richItalicFontSizePx: record.richItalicFontSizePx == null ? null : asNumber(record.richItalicFontSizePx),
    richBoldItalicFontSizePx:
      record.richBoldItalicFontSizePx == null ? null : asNumber(record.richBoldItalicFontSizePx),
    richBoldFontSpacingPx: record.richBoldFontSpacingPx == null ? null : asNumber(record.richBoldFontSpacingPx),
    richItalicFontSpacingPx:
      record.richItalicFontSpacingPx == null ? null : asNumber(record.richItalicFontSpacingPx),
    richBoldItalicFontSpacingPx:
      record.richBoldItalicFontSpacingPx == null ? null : asNumber(record.richBoldItalicFontSpacingPx),
    textWrap: normalizeTextWrap(record),
    outline: normalizeOutline(record.outlineColor, record.outlineSize),
    shadow: normalizeShadow(record.shadow),
    richText: record.richText === true,
    shaderId: normalizeResourcePath(record.shader),
    materialRef: normalizeResourcePath(record.material),
    shaderParams,
    textureStretchMode:
      record.textureStretchMode == null
        ? null
        : asNumber(record.textureStretchMode),
    textureFlipH: record.textureFlipH === true,
    textureFlipV: record.textureFlipV === true,
    canvasBlendMode:
      record.canvasBlendMode == null
        ? undefined
        : asNumber(record.canvasBlendMode),
    particleSpec: normalizeParticleSpec(
      record.particleSpec,
      shaderParams,
      normalizeResourcePath(record.shader)
    ),
    particleEmitting: record.particleEmitting === true,
    particleRestartEpoch: asNumber(record.particleRestartEpoch),
    ...normalizeSpine(record.spine),
    sceneFilePath: asString(record.sceneFilePath) || null,
    mouseFilter:
      typeof record.mouseFilter === "number" ? record.mouseFilter : null,
    // Anchor fractions (static). `== null` preserves a genuine `0` (a left-anchored node) — asNumber would
    // also give 0, but the null-vs-0 distinction (non-Control vs left-anchored) drives the renderer's
    // `anchored` gate, so keep null when the producer omitted the field.
    anchorLeft:
      record.anchorLeft == null ? null : asNumber(record.anchorLeft),
    anchorRight:
      record.anchorRight == null ? null : asNumber(record.anchorRight),
    anchorOwnerId:
      typeof record.anchorOwnerId === "string" ? record.anchorOwnerId : null,
    containerLayout: asString(record.containerLayout) || null,
    // Static (mergeNode carries it forward). Absent on every non-card node and on a volatile-only upsert → null.
    contentKey: asString(record.contentKey) || null,
    spineCurrentAnim: asString(record.spineCurrentAnim) || null,
    // Volatile, rides the upsert spread (mergeNode keeps it from the upsert, like spineCurrentAnim).
    spineSkin: asString(record.spineSkin) || null,
    // Volatile too (same reason: a re-tinted material must re-request the clip).
    spineMat: asString(record.spineMat) || null,
    // Volatile; absent = running (the overwhelming majority), so only an explicit true freezes playback.
    spinePaused: record.spinePaused === true,
    spineTrackTime: asNumber(record.spineTrackTime),
    // Volatile, rides the upsert spread. Default true (loop) unless the producer explicitly sends false.
    spineLooping: record.spineLooping !== false,
    // Volatile, rides the upsert spread (mergeNode takes it from the upsert) — so the producer dropping the field
    // when a pulse STOPS clears it on the client, which is how a travelled-to map node stops pulsing.
    pinnedLoopAnim: asString(record.pinnedLoopAnim) || null,
    transform: normalizeTransform(record.transform),
    localRect: normalizeRect(record.localRect),
    visible: record.visible !== false,
    focused: record.focused === true,
    opacity: record.opacity == null ? 1 : asNumber(record.opacity),
    rotation: asNumber(record.rotation),
    scaleX: record.scaleX == null ? 1 : asNumber(record.scaleX),
    scaleY: record.scaleY == null ? 1 : asNumber(record.scaleY),
    pivotX: asNumber(record.pivotX),
    pivotY: asNumber(record.pivotY),
    zIndex: record.zIndex == null ? null : asNumber(record.zIndex),
    textureUrl: normalizeTextureUrl(record.texture),
    textureRegion: normalizeRect(record.textureRegion),
    textureMargin: normalizeRect(record.textureMargin),
    ninePatch: record.ninePatch === true,
    modulate: normalizeColor(record.modulate),
    selfModulate: normalizeColor(record.selfModulate),
    fillColor: normalizeColor(record.fillColor),
    range: normalizeRange(record),
    text: normalizeText(record.text),
    intentFrames: normalizeIntentFrames(record.intentFrames),
    // Line2D stroke geometry (sticky unit). `normalizeLinePoints` deliberately PRESERVES an empty array (the
    // "stroke cleared" instruction) — which is why it can't reuse normalizeNumberArray (that collapses empty →
    // null, i.e. "unchanged", the exact opposite instruction).
    linePoints: normalizeLinePoints(record.linePoints),
    lineWidth: record.lineWidth == null ? null : asNumber(record.lineWidth),
    lineColor: normalizeColor(record.lineColor),
  };
  // Force the glyph's texture to frame 0 so the atlas-canvas path renders it (the frozen sprite's own texture is
  // stale / a single frame). The renderer's intent ticker then cycles the rest.
  return applyIntentFrame0(node);
}

// Producer intent-frames snapshot ({animationName, fps, frames:[{atlasPath, region, margin}]}) → MirrorIntentFrames.
// Each frame's atlas page path is mapped to the /res/ url. Null (non-intent node / no frames) leaves the node's
// intentFrames null; mergeNode then carries the retained set across volatile-only upserts.
function normalizeIntentFrames(raw: unknown): MirrorIntentFrames | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const animationName = asString(record.animationName);
  const framesRaw = Array.isArray(record.frames) ? record.frames : [];
  const frames: MirrorIntentFrame[] = [];
  for (const entry of framesRaw) {
    const fr = asRecord(entry);
    if (!fr) {
      continue;
    }
    const atlasPath = asString(fr.atlasPath);
    if (!atlasPath) {
      continue;
    }
    frames.push({
      url: mirrorResourceUrl(atlasPath),
      region: normalizeRect(fr.region),
      margin: normalizeRect(fr.margin),
    });
  }
  if (!animationName || frames.length === 0) {
    return null;
  }
  const fps = asNumber(record.fps);
  return { animationName, fps: fps > 0 ? fps : 15, frames };
}

/**
 * The wire's five wrap fields into one {@link MirrorTextWrap}, or null.
 *
 * ALL-OR-NOTHING, matching the producer's own emission rule: ranges without a basis address an unnamed string
 * and ranges without a hash cannot be checked for staleness, so a partial block is not a degraded wrap — it is
 * an unusable one, and the honest representation of it is `null` (which every consumer already handles, because
 * most nodes have no wrap at all).
 *
 * The range list is validated STRUCTURALLY here rather than trusted: each pair must be a well-formed half-open
 * range inside the declared source length, and the pairs must be non-descending. A malformed range that reached
 * a slicer would produce wrong words silently, and this is the cheapest place to refuse it — once, on parse,
 * instead of on every raster.
 */
function normalizeTextWrap(record: Record<string, unknown>): MirrorTextWrap | null {
  const flat = record.textLineRanges;
  const basisRaw = asString(record.textLineBasis);
  if (!Array.isArray(flat) || flat.length === 0 || flat.length % 2 !== 0) {
    return null;
  }
  if (basisRaw !== "text" && basisRaw !== "parsed") {
    return null;
  }
  if (record.textLineSourceLength == null || record.textLineSourceHash == null) {
    return null;
  }
  const sourceLength = asNumber(record.textLineSourceLength);
  const sourceHash = asNumber(record.textLineSourceHash);
  if (!Number.isInteger(sourceLength) || sourceLength < 0 || !Number.isInteger(sourceHash)) {
    return null;
  }
  const parsedText = asString(record.textParsedText);
  if (basisRaw === "parsed" && parsedText === null) {
    // A "parsed" basis names a string the wire did not carry — the ranges have nothing to address.
    return null;
  }
  const lines: { start: number; end: number }[] = [];
  let previousEnd = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const start = asNumber(flat[i]);
    const end = asNumber(flat[i + 1]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return null;
    }
    if (start < previousEnd || end < start || end > sourceLength) {
      return null;
    }
    previousEnd = end;
    lines.push({ start, end });
  }
  return { lines, basis: basisRaw, parsedText, sourceLength, sourceHash };
}

// Godot Transform2D snapshot {xAxis,yAxis,origin} → CSS matrix order [a,b,c,d,tx,ty].
function normalizeTransform(raw: unknown): number[] | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const x = asRecord(record.xAxis);
  const y = asRecord(record.yAxis);
  const o = asRecord(record.origin);
  if (!x || !y || !o) {
    return null;
  }
  return [
    asNumber(x.x),
    asNumber(x.y),
    asNumber(y.x),
    asNumber(y.y),
    asNumber(o.x),
    asNumber(o.y),
  ];
}

// Godot #RRGGBB / #RRGGBBAA → linear channels [r,g,b,a] in 0..1. Godot's ToHtml writes each channel as
// round(channel*255), so byte/255 recovers the value at the exact granularity the producer change-detects colors
// (ByteEq, 8-bit) — lossless at the client's consumption precision (the tint SVG matrix quantizes to ~0.02, the
// identity check to 0.004, both coarser than 1/255). Invalid/absent hex falls back to opaque white (the old
// asNumberOr(_, 1) default), so a malformed color renders as it always did.
function channelsFromHtml(html: string): [number, number, number, number] {
  const hex = html.startsWith("#") ? html.slice(1) : html;
  if (hex.length !== 6 && hex.length !== 8) {
    return [1, 1, 1, 1];
  }
  const byteAt = (i: number): number => parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255;
  const r = byteAt(0);
  const g = byteAt(1);
  const b = byteAt(2);
  const a = hex.length === 8 ? byteAt(3) : 1;
  return [r, g, b, a].every((n) => Number.isFinite(n))
    ? [r, g, b, a]
    : [1, 1, 1, 1];
}

function normalizeColor(raw: unknown): MirrorColor | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const html = asString(record.html);
  // Channels-first precedence: OLD recordings ship r/g/b/a (+html) → byte-identical behavior. The slimmed wire
  // ships html-only → derive the channels from it (the renderer's tint/opacity read them).
  if (
    record.r != null ||
    record.g != null ||
    record.b != null ||
    record.a != null
  ) {
    return {
      r: asNumberOr(record.r, 1),
      g: asNumberOr(record.g, 1),
      b: asNumberOr(record.b, 1),
      a: asNumberOr(record.a, 1),
      html,
    };
  }
  const [r, g, b, a] = channelsFromHtml(html);
  return { r, g, b, a, html };
}

function normalizeMargins(raw: unknown): MirrorMargins | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const margins = {
    left: asNumber(record.left),
    top: asNumber(record.top),
    right: asNumber(record.right),
    bottom: asNumber(record.bottom),
  };
  // All-zero margins behave like a plain stretched texture — no need to nine-patch.
  return margins.left || margins.top || margins.right || margins.bottom
    ? margins
    : null;
}

function normalizeFont(
  raw: unknown,
  weightRaw: unknown,
  styleRaw: unknown,
): MirrorFont | null {
  const path = normalizeResourcePath(raw);
  if (!path) {
    return null;
  }
  const file = path.split("/").at(-1) ?? path;
  const family = file.replace(/\.[^.]+$/, "");
  return family
    ? {
        family,
        url: mirrorResourceUrl(path),
        weight: normalizeFontWeight(weightRaw),
        style: normalizeFontStyle(styleRaw),
      }
    : null;
}

// Map the producer's font weight (e.g. "bold", "700", "Regular") to a CSS font-weight, or null.
function normalizeFontWeight(raw: unknown): string | null {
  const v = asString(raw).trim().toLowerCase();
  if (!v) {
    return null;
  }
  if (v === "bold" || v === "normal") {
    return v;
  }
  if (/^\d{3,4}$/.test(v)) {
    return v;
  }
  if (v.includes("bold")) {
    return "bold";
  }
  return null;
}

function normalizeFontStyle(raw: unknown): string | null {
  const v = asString(raw).trim().toLowerCase();
  return v === "italic" || v === "oblique" ? v : null;
}

function normalizeOutline(
  colorRaw: unknown,
  sizeRaw: unknown,
): MirrorOutline | null {
  const color = normalizeColor(colorRaw);
  const size = sizeRaw == null ? 0 : asNumber(sizeRaw);
  return color && size > 0 ? { colorHtml: color.html, size } : null;
}

// The producer's static SpineSprite block ({sceneResPath, nodePath, animations}) → the node's static spine
// fields. Null `spine` (a non-SpineSprite node, or a volatile-only upsert) leaves all three null; mergeNode
// then keeps the retained static values across volatile-only upserts (the particleSpec lesson).
function normalizeSpine(raw: unknown): {
  spineSceneResPath: string | null;
  spineNodePath: string | null;
  spineAnimations: string[] | null;
  spineSkelResPath: string | null;
} {
  const record = asRecord(raw);
  const sceneResPath = record ? asString(record.sceneResPath) : "";
  if (!record || !sceneResPath) {
    return {
      spineSceneResPath: null,
      spineNodePath: null,
      spineAnimations: null,
      spineSkelResPath: null,
    };
  }
  const animations = Array.isArray(record.animations)
    ? record.animations
        .map((name) => asString(name))
        .filter((name) => name.length > 0)
    : [];
  return {
    spineSceneResPath: sceneResPath,
    spineNodePath: asString(record.nodePath) || null,
    spineAnimations: animations,
    // RuntimeSceneSpineSnapshot.SkelResPath → `spine.skelResPath` (STATIC; null/absent when not captured). Drives
    // the #8 `&skel=` retry after a failed clip fetch.
    spineSkelResPath: asString(record.skelResPath) || null,
  };
}

function normalizeShaderParams(raw: unknown): MirrorShaderParam[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const params: MirrorShaderParam[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const name = record ? asString(record.name) : "";
    if (!record || !name) {
      continue;
    }
    params.push({
      name,
      kind: asString(record.kind),
      number: record.number == null ? null : asNumber(record.number),
      bool: typeof record.bool === "boolean" ? record.bool : null,
      string: record.string == null ? null : asString(record.string),
      color: normalizeColor(record.color),
      vector2: normalizeVector2(record.vector2),
      resourcePath: normalizeResourcePath(record.resource),
      vector3: normalizeVector3(record.vector3),
      vector4: normalizeVector4(record.vector4),
      rect2: normalizeFlatRect(record.rect2),
      transform2d: normalizeNumber6(record.transform2D),
      numberArray: normalizeNumberArray(record.numberArray),
      gradientStops: normalizeGradientStops(record.gradientStops),
      gradientInterpolation:
        record.gradientInterpolation == null ? null : asNumber(record.gradientInterpolation),
      curvePoints: specPoints(record.curvePoints) ?? null,
    });
  }
  return params.length > 0 ? params : null;
}

// A sampler uniform's authored gradient stops (the VFX `lut`). Absent on every non-ramp uniform and on OLD
// recordings, so null is the norm — the consumer falls back to the un-recolored texture.
function normalizeGradientStops(
  raw: unknown
): Array<{ offset: number; color: MirrorColor | null }> | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const stops: Array<{ offset: number; color: MirrorColor | null }> = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record) {
      stops.push({ offset: asNumber(record.offset), color: normalizeColor(record.color) });
    }
  }
  return stops.length > 0 ? stops : null;
}

// Flatten the producer's particle snapshot into gsw's ParticleSpecConfig shape (tuples for vec2s, [r,g,b,a]
// for colors, resolved textureUrl). `emitting` is a placeholder — particleAttributes overrides it with the
// per-tick `particleEmitting` when it stamps the spec JSON. Null for non-particle nodes / unknown kind.
//
// `shaderParams` comes from the SAME upsert (both are static, so both ride the keyframe/add record): STS2's
// VFX materials declare their flipbook in the SHADER (`flipbook_size`/`frame_count`), leaving the node's own
// hframes/vframes at 1, and gsw would otherwise draw the whole sprite sheet as one quad. Folding it in HERE
// bakes the grid into the static spec object, so the (spec-identity-keyed) stamping memo and the volatile-only
// upserts that drop `shaderParams` both keep working. Three more shader-declared pieces ride the same fold:
// the `lut` color LUT (`colorLut`), the `pivot_offset` quad shift (into the draw origin), and the COVERAGE
// semantics (`shaderId` + the params — see shaderCoverageFrom), whose `mask` sampler is resolved to a URL
// HERE rather than in particleAttributes, which must not import this module (cycle).
function normalizeParticleSpec(
  raw: unknown,
  shaderParams: MirrorShaderParam[] | null,
  shaderId: string | null
): ParticleSpecConfig | null {
  const r = asRecord(raw);
  if (!r) {
    return null;
  }
  const kind = asString(r.kind);
  if (kind !== "GPUParticles2D" && kind !== "CPUParticles2D") {
    return null;
  }
  const nodeHframes = asNumberOr(r.hframes, 1);
  const nodeVframes = asNumberOr(r.vframes, 1);
  const flipbook = shaderFlipbookFrom(shaderParams, nodeHframes, nodeVframes);
  const colorLut = shaderLutFrom(shaderParams);
  // `pivot_offset` shifts the sprite QUAD in the vertex stage (`VERTEX += pivot_offset / TEXTURE_PIXEL_SIZE`),
  // i.e. inside each particle's own rotated/scaled space. gsw has no per-sprite pivot, so this folds into the
  // system's draw ORIGIN — exact for the (overwhelmingly common) unrotated, unit-scale case and a fixed
  // approximation otherwise: a spinning particle's offset should spin with it and here it does not. The
  // magnitude is bounded by the authored fraction × the texture size (the streaks: 0.25 × 256 = 64px), which
  // stays inside the canvas margin gsw already grows for the sprite's own half-diagonal, so nothing clips.
  const pivotPx = shaderPivotPxFrom(
    shaderParams,
    asNumber(r.textureWidth),
    asNumber(r.textureHeight)
  );
  // Where this material's shader takes coverage from (and the mask/erosion/polar inputs that ride with it).
  // Null for every shader that already renders correctly — the spread below then adds NOTHING, so the spec
  // JSON stays byte-identical to the pre-coverage one (it is the runtime's reconcile key AND a memo key).
  const coverage = shaderCoverageFrom(shaderId, shaderParams);
  // A shader flipbook that PLAYS (`flipbook_curve`) advances one full cycle over the particle's life and
  // wraps — gsw's anim speed 1 + loop. One that doesn't holds a single cell picked by the particle's random
  // anim OFFSET, which the producer already streams (`anim_offset_min/max = 0..1`), so speed stays 0 there.
  const animSpeedMin = asNumber(r.animSpeedMin);
  const animSpeedMax = asNumber(r.animSpeedMax);
  return normalizeParticleSpecConfig({
    kind,
    amount: asNumber(r.amount),
    amountRatio: asNumberOr(r.amountRatio, 1),
    lifetime: asNumberOr(r.lifetime, 1),
    lifetimeRandomness: asNumber(r.lifetimeRandomness),
    oneShot: r.oneShot === true,
    emitting: false,
    explosiveness: asNumber(r.explosiveness),
    randomness: asNumber(r.randomness),
    preprocess: asNumber(r.preprocess),
    speedScale: asNumberOr(r.speedScale, 1),
    fixedFps: asNumber(r.fixedFps),
    localCoords: r.localCoords === true,
    drawOrder: asNumber(r.drawOrder),
    seed: asNumber(r.seed),
    emissionShape: asNumber(r.emissionShape),
    emissionOffset: specVec2(r.emissionOffset),
    emissionScale: specVec2(r.emissionScale, 1),
    emissionSphereRadius: asNumber(r.emissionSphereRadius),
    emissionRingRadius: asNumber(r.emissionRingRadius),
    emissionRingInnerRadius: asNumber(r.emissionRingInnerRadius),
    emissionRingHeight: asNumber(r.emissionRingHeight),
    emissionBoxExtents: specVec2(r.emissionBoxExtents),
    direction: specVec2(r.direction),
    spread: asNumber(r.spread),
    initialVelocityMin: asNumber(r.initialVelocityMin),
    initialVelocityMax: asNumber(r.initialVelocityMax),
    angleMin: asNumber(r.angleMin),
    angleMax: asNumber(r.angleMax),
    angularVelocityMin: asNumber(r.angularVelocityMin),
    angularVelocityMax: asNumber(r.angularVelocityMax),
    gravity: specVec2(r.gravity),
    linearAccelMin: asNumber(r.linearAccelMin),
    linearAccelMax: asNumber(r.linearAccelMax),
    radialAccelMin: asNumber(r.radialAccelMin),
    radialAccelMax: asNumber(r.radialAccelMax),
    tangentialAccelMin: asNumber(r.tangentialAccelMin),
    tangentialAccelMax: asNumber(r.tangentialAccelMax),
    dampingMin: asNumber(r.dampingMin),
    dampingMax: asNumber(r.dampingMax),
    dampingAsFriction: r.dampingAsFriction === true,
    orbitVelocityMin: asNumber(r.orbitVelocityMin),
    orbitVelocityMax: asNumber(r.orbitVelocityMax),
    scaleMin: asNumberOr(r.scaleMin, 1),
    scaleMax: asNumberOr(r.scaleMax, 1),
    hueVariationMin: asNumber(r.hueVariationMin),
    hueVariationMax: asNumber(r.hueVariationMax),
    alignY: r.alignY === true,
    baseColor: specColor(r.baseColor),
    originX: asNumber(r.originX) + (pivotPx?.x ?? 0),
    originY: asNumber(r.originY) + (pivotPx?.y ?? 0),
    textureUrl: normalizeTextureUrl(r.texture),
    textureWidth: asNumber(r.textureWidth),
    textureHeight: asNumber(r.textureHeight),
    hframes: flipbook ? flipbook.hframes : nodeHframes,
    vframes: flipbook ? flipbook.vframes : nodeVframes,
    frameCount: flipbook ? flipbook.frameCount : 0,
    // The shader only CROPS: Godot keeps drawing the quad at the full texture size (its own
    // particles_animation would instead shrink it to one cell), so the crop must not halve the sprite.
    flipbookCropOnly: flipbook != null,
    animLoop: flipbook?.animates ? true : r.animLoop === true,
    animSpeedMin: flipbook?.animates ? Math.max(1, animSpeedMin) : animSpeedMin,
    animSpeedMax: flipbook?.animates ? Math.max(1, animSpeedMax) : animSpeedMax,
    animOffsetMin: asNumber(r.animOffsetMin),
    animOffsetMax: asNumber(r.animOffsetMax),
    blendMode: asNumber(r.blendMode),
    // Per-TEXEL recolor (the shader's `lut`), NOT an over-life ramp — see shaderLutFrom. Omitted entirely when
    // the material has none, so gsw keeps drawing the source texture untouched.
    ...(colorLut
      ? { colorLut: colorLut.stops, colorLutInterpolation: colorLut.interpolation }
      : {}),
    // Coverage semantics — each key present ONLY when the shader declares it (see the `coverage` note above).
    ...(coverage?.alphaFromRed ? { alphaFromRed: true } : {}),
    ...(coverage?.uvPolar ? { uvPolar: true } : {}),
    ...(coverage?.erode ? { alphaErode: coverage.erode } : {}),
    ...(coverage?.maskResourcePath
      ? { maskUrl: mirrorResourceUrl(coverage.maskResourcePath) }
      : {}),
    colorRamp: specStops(r.colorRamp),
    colorInitialRamp: specStops(r.colorInitialRamp),
    scaleCurve: specPoints(r.scaleCurve),
    scaleCurveX: specPoints(r.scaleCurveX),
    scaleCurveY: specPoints(r.scaleCurveY),
    alphaCurve: specPoints(r.alphaCurve),
    hueCurve: specPoints(r.hueCurve),
  });
}

// Godot Vector2 snapshot {x,y} → gsw tuple [x,y]. `fallback` fills both axes when the field is absent.
function specVec2(raw: unknown, fallback = 0): [number, number] {
  const r = asRecord(raw);
  return r ? [asNumber(r.x), asNumber(r.y)] : [fallback, fallback];
}

// Godot color snapshot → gsw tuple [r,g,b,a] (defaults to opaque white). Channels-first precedence (OLD recordings
// ship r/g/b/a) with the same html-derive fallback as normalizeColor, so a slimmed particle ramp/baseColor
// (html-only) still yields correct channels — miss this and particles render white.
function specColor(raw: unknown): [number, number, number, number] {
  const r = asRecord(raw);
  if (!r) {
    return [1, 1, 1, 1];
  }
  if (r.r != null || r.g != null || r.b != null || r.a != null) {
    return [
      asNumberOr(r.r, 1),
      asNumberOr(r.g, 1),
      asNumberOr(r.b, 1),
      asNumberOr(r.a, 1),
    ];
  }
  return channelsFromHtml(asString(r.html));
}

function specStops(
  raw: unknown,
):
  | Array<{ offset: number; color: [number, number, number, number] }>
  | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const stops: Array<{
    offset: number;
    color: [number, number, number, number];
  }> = [];
  for (const entry of raw) {
    const r = asRecord(entry);
    if (r) {
      stops.push({ offset: asNumber(r.offset), color: specColor(r.color) });
    }
  }
  return stops.length > 0 ? stops : undefined;
}

function specPoints(raw: unknown): Array<{ x: number; y: number }> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const points: Array<{ x: number; y: number }> = [];
  for (const entry of raw) {
    const r = asRecord(entry);
    if (r) {
      points.push({ x: asNumber(r.x), y: asNumber(r.y) });
    }
  }
  return points.length > 0 ? points : undefined;
}

function normalizeVector2(raw: unknown): { x: number; y: number } | null {
  const record = asRecord(raw);
  if (!record || record.x == null || record.y == null) {
    return null;
  }
  return { x: asNumber(record.x), y: asNumber(record.y) };
}

// {x,y,z} → vector3 (Godot-native-first extended shader uniform; web pass-through).
function normalizeVector3(
  raw: unknown
): { x: number; y: number; z: number } | null {
  const record = asRecord(raw);
  if (!record || record.x == null || record.y == null || record.z == null) {
    return null;
  }
  return { x: asNumber(record.x), y: asNumber(record.y), z: asNumber(record.z) };
}

// {x,y,z,w} → vector4/quaternion (Godot-native-first extended shader uniform; web pass-through).
function normalizeVector4(
  raw: unknown
): { x: number; y: number; z: number; w: number } | null {
  const record = asRecord(raw);
  if (
    !record ||
    record.x == null ||
    record.y == null ||
    record.z == null ||
    record.w == null
  ) {
    return null;
  }
  return {
    x: asNumber(record.x),
    y: asNumber(record.y),
    z: asNumber(record.z),
    w: asNumber(record.w),
  };
}

// Flat {x,y,width,height} → MirrorRect (shader rect2 uniform — distinct from the nested position/size rect).
function normalizeFlatRect(raw: unknown): MirrorRect | null {
  const record = asRecord(raw);
  if (
    !record ||
    record.x == null ||
    record.y == null ||
    record.width == null ||
    record.height == null
  ) {
    return null;
  }
  return {
    x: asNumber(record.x),
    y: asNumber(record.y),
    width: asNumber(record.width),
    height: asNumber(record.height),
  };
}

// 6-number array [a,b,c,d,tx,ty] → transform2d (Godot-native-first extended shader uniform; web pass-through).
function normalizeNumber6(raw: unknown): number[] | null {
  return Array.isArray(raw) &&
    raw.length === 6 &&
    raw.every((n) => typeof n === "number" && Number.isFinite(n))
    ? (raw as number[])
    : null;
}

// Flattened numeric array uniform → number[] (element stride implied by kind; web pass-through).
function normalizeNumberArray(raw: unknown): number[] | null {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    return null;
  }
  return raw as number[];
}

// A Line2D's flattened `[x0,y0,x1,y1,…]` stroke geometry. Distinct from `normalizeNumberArray` in exactly one
// way, and it is the load-bearing one: an EMPTY array survives as `[]` (the producer's "this stroke was cleared"
// instruction — the client erases what it drew) instead of collapsing to null ("unchanged, keep the retained
// geometry"). A non-array / non-finite payload is null. An unpaired trailing coordinate is dropped: it isn't a point.
function normalizeLinePoints(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || !raw.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  const points = raw as number[];
  return points.length % 2 === 0 ? points : points.slice(0, points.length - 1);
}

function normalizeShadow(raw: unknown): MirrorShadow | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const color = normalizeColor(record.color);
  const offset = asRecord(record.offset);
  const offsetX = offset ? asNumber(offset.x) : 0;
  const offsetY = offset ? asNumber(offset.y) : 0;
  if (!color || (offsetX === 0 && offsetY === 0)) {
    return null;
  }
  return { colorHtml: color.html, offsetX, offsetY };
}

function normalizeRange(record: Record<string, unknown>): MirrorRange | null {
  if (record.rangeValue == null) {
    return null;
  }
  return {
    value: asNumber(record.rangeValue),
    min: asNumberOr(record.rangeMin, 0),
    max: asNumberOr(record.rangeMax, 100),
  };
}

function normalizeResourcePath(raw: unknown): string | null {
  const record = asRecord(raw);
  const path = record ? asString(record.resourcePath) : "";
  return path || null;
}

function normalizeTextureUrl(raw: unknown): string | null {
  const resourcePath = normalizeResourcePath(raw);
  return resourcePath ? mirrorResourceUrl(resourcePath) : null;
}

function normalizeText(raw: unknown): MirrorText | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const content =
    record.text != null ? asString(record.text) : asString(record.rawText);
  if (!content) {
    return null;
  }

  const color = asRecord(record.textColor);
  const layout = asRecord(record.layout);
  const outline = asRecord(record.outlineColor);
  return {
    text: content,
    colorHtml: color && color.html != null ? asString(color.html) : null,
    fontSizePx:
      record.appliedFontSize != null
        ? asNumber(record.appliedFontSize)
        : record.fontSize != null
          ? asNumber(record.fontSize)
          : null,
    halign:
      layout && layout.horizontalAlignment != null
        ? asString(layout.horizontalAlignment)
        : null,
    valign:
      layout && layout.verticalAlignment != null
        ? asString(layout.verticalAlignment)
        : null,
    outlineColorHtml:
      outline && outline.html != null ? asString(outline.html) : null,
    outlineSize: record.outlineSize != null ? asNumber(record.outlineSize) : 0,
  };
}

function normalizeRect(raw: unknown): MirrorRect | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const position = asRecord(record.position);
  const size = asRecord(record.size);
  if (!position || !size) {
    return null;
  }

  return {
    x: asNumber(position.x),
    y: asNumber(position.y),
    width: asNumber(size.x),
    height: asNumber(size.y),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Memo for `mirrorResourceUrl`, a PURE function of (resource path × host base). The path split/encode/join plus
// `hostUrl`'s two `hostBase()` calls ran per textured node per delta; a phone trace of combat attributed ~93ms
// across two traces to this and `hostBase` together. Unbounded by design: the key space is the set of distinct
// resource paths the game addresses (a few thousand at most, each a string the delta already holds), and evicting
// would defeat the point since the same paths recur every frame.
//
// The host base is not part of the KEY, it is a GUARD: it can only change on the public-origin bootstrap path,
// where it changes for every entry at once, so one compare + `clear()` is both cheaper and safer than a compound
// key (nothing can survive with the wrong origin baked in).
const resourceUrlCache = new Map<string, string>();
let resourceUrlCacheBase: string | null = null;

// Map a Godot resource path to the host's HTTP asset route. `res://images/x.png` → `/res/images/x.png`.
export function mirrorResourceUrl(resourcePath: string): string {
  const base = hostBase();
  if (base !== resourceUrlCacheBase) {
    resourceUrlCache.clear();
    resourceUrlCacheBase = base;
  }
  const cached = resourceUrlCache.get(resourcePath);
  if (cached !== undefined) {
    return cached;
  }

  const trimmed = resourcePath.startsWith("res://")
    ? resourcePath.slice("res://".length)
    : resourcePath;
  // `hostUrl` is a no-op in host-served mode (see @/join/hostBase), so this stays the exact string it has
  // always been there — which matters because the result is a cache key in several of the hot paths below,
  // not just a fetch target. Under the public-origin bootstrap it gains the host's origin.
  const url = hostUrl(`/res/${trimmed.split("/").map(encodeURIComponent).join("/")}`);
  resourceUrlCache.set(resourcePath, url);
  return url;
}
