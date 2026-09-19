<script setup lang="ts">
// The READABLE-HAND tap/hold control — CouchCoop's own chrome, in the combat HUD's bottom-right cluster.
//
// It is NOT a mirrored game node: the game has no such button, because its transient override only exists in this
// client (see mirrorRenderer's hand-raise pass). But it lives among the game's own buttons, so it is built out of
// the game's own button art and placed on the same grid — one slot LEFT of the discard pile, below End Turn, and
// deliberately SMALLER than the discard pile, which is the game's own control and keeps the visual priority.
//
// THE ART, and why it is not simply the sprite. `ui_atlas.sprites/peek_button.tres` is the shape we want: a torn
// hexagonal slab with a light rim. What we do NOT want is its baked-in eye glyph, which belongs to the game's peek
// button and covers the central ~54% x 42% of the slab. So the sprite is painted twice: once whole (slab + rim),
// and once as a MASK, shrunk enough to sit inside the rim and filled with the slab's own interior colour. That
// leaves the exact authored silhouette and rim with a clean middle for our own glyph — and it works because the
// slab's interior really is near-flat (measured rgb(45,70,81), sigma 2-6 across it), which a two-stop vertical
// gradient reproduces.
//
// Both paint layers are sized to the sprite's REGION rect rather than to the button's box: the sprite is trimmed,
// so the box also covers transparent margin that a CSS background would fill with the atlas page's NEIGHBOURING
// sprites (see atlasSpriteLayout). The root box IS that region rect, which also makes the hit area exactly the
// slab — a tap in the padding can't be taken from the discard pile beside it.
//
// The DOM stage teleports it into CombatPileContainer; the canvas stage records its visible quad in the same
// anchor's command range and leaves only this transparent pointer target in Vue. Its pointer events are stopped at
// the root: the mirror's inputCapture listens on the stage element, and a hold here must never reach the game.

import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect, type CSSProperties } from "vue";
import { translate as t } from "@/i18n";

import {
  atlasRegionBackground,
  atlasSpriteLayout,
  resolveAtlasSprite,
  STRETCH_SCALE,
  type AtlasSprite
} from "@/mirror/atlasSprite";
import {
  effectiveRaiseHandCards,
  handRaiseUi,
  saveRaiseHandCards,
  setHandRaisePressOverride
} from "@/mirror/handRaiseUi";
import {
  HAND_RAISE_BOX as BOX,
  HAND_RAISE_GLYPH_COLOR as GLYPH_COLOR,
  HAND_RAISE_INTERIOR_BOTTOM as INTERIOR_BOTTOM,
  HAND_RAISE_INTERIOR_SCALE as INTERIOR_SCALE,
  HAND_RAISE_INTERIOR_TOP as INTERIOR_TOP,
  paintHandRaiseChrome
} from "@/mirror/handRaiseChrome";
import { MIRROR_RENDERER_KEY } from "@/mirror/rendererKey";
import { layoutScale, pxCss } from "@/mirror/stageFit";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { naturalSize, textureSizeVersion, warmImage } from "@/mirror/textureCache";

const SPRITE_PATH = "res://images/atlases/ui_atlas.sprites/peek_button.tres";

// --- layout (design px) -----------------------------------------------------------------------------------------
// BOX is the box a Godot TextureRect would draw the whole 170x170 logical texture into; the slab itself is the
// sprite's 166x121 region inside it, so the visible button is 106.4 x 77.6 and sits 1.3 / 14.1 in. The game's own
// peek button uses a 128 box; this is 15% smaller so it reads as secondary to the 80x80 discard pile icon next to
// it. RIGHT/BOTTOM are chosen so the SLAB lands at x 1683.6..1790.0, y 986.2..1063.8 — vertically centred on the
// discard pile's row (985..1065), 16px clear of the pile's own hit box (which starts at x 1806, its count badge
// sticking out left of the icon), and 50px below the End Turn button (which ends at y 936).
// The interior repaint, as a fraction of the slab. 0.875 leaves the whole rim (~4-6px on the 170px sprite) while
// covering the baked eye completely (it starts 30px in). A scale rather than an inset so the shrink is uniform on
// a non-square slab.
// The slab's measured interior, top and bottom (it has a gentle vertical falloff, not a flat fill).
// The sprite's own rim highlight — what the glyph is drawn in, so it reads as part of the button.

const HOVER_SCALE = 1.05;
const DOWN_SCALE = 0.95;
const PRESS_MS = 120;
const RELEASE_MS = 220;
const SUSTAIN_MS = 400;

// --- state ------------------------------------------------------------------------------------------------------
const sprite = ref<AtlasSprite | null>(null);
const atlasImage = shallowRef<HTMLImageElement | null>(null);
const canvasSource = document.createElement("canvas");
const renderer = inject(MIRROR_RENDERER_KEY, shallowRef(null));
const focused = ref(false);
const pressed = ref(false);
const activePointer = ref<number | null>(null);
let pressStartedAt = 0;
let savedAtPress = false;
let canvasRevision = 0;

const on = effectiveRaiseHandCards;
// Only while a combat hand is on screen — there is nothing to raise anywhere else, and an inert button in the
// corner of the map screen is just clutter.
const shown = computed(() => handRaiseUi.handPresent && handRaiseUi.layer?.anchorId != null && sprite.value !== null);
const canvasBackend = computed(() => handRaiseUi.layer?.backend === "canvas");
// The visible DOM chrome is intentionally below later scene siblings. Some non-blocking game layers span the
// whole stage even though their transparent pixels should not make this client control unreachable, so input
// cannot rely on the visible chrome being the browser event target. Both backends use the transparent target
// below; the renderer's cover answer disables it whenever a REAL later backstop is present.
const blocked = computed(() => handRaiseUi.layer?.covered === true);
const teleportTarget = computed(() => handRaiseUi.layer?.domTarget ?? document.body);

async function prime(): Promise<void> {
  if (sprite.value !== null) {
    return;
  }
  try {
    const resolved = await resolveAtlasSprite(SPRITE_PATH);
    // Warm the page through the shared texture cache: it de-dupes with the renderer's own loads and it is what
    // records the page's natural size, which regionBackgroundStyle needs to place a region inside a box.
    warmImage(resolved.pageUrl);
    const image = new Image();
    image.decoding = "async";
    image.src = resolved.pageUrl;
    await image.decode();
    atlasImage.value = image;
    sprite.value = resolved;
  } catch {
    sprite.value = null; // the route or the document failed — the button simply never appears (the panel still works)
  }
}

onMounted(prime);
// A hand appearing is the first moment the button can matter; re-try then for a client that connected mid-run and
// missed the initial fetch (idempotent — `prime` returns immediately once resolved).
watch(() => handRaiseUi.handPresent, (present) => { if (present) void prime(); });

// --- paint ------------------------------------------------------------------------------------------------------
// Where the slab lands inside BOX. `textureSizeVersion` is read so this recomputes when the atlas page's natural
// size lands (regionBackgroundStyle needs it to scale the page).
const slab = computed(() => {
  void textureSizeVersion.value;
  const s = sprite.value;
  return s === null ? null : atlasSpriteLayout(s, BOX, STRETCH_SCALE, naturalSize(s.pageUrl) ?? undefined);
});

// The ROOT is the slab's own rect, not BOX — see the header: the hit area is the button and nothing more. Its
// right/bottom offsets are BOX's, pushed in by the margin BOX would have left on those two sides. All four numbers
// are DESIGN px; which space each element writes them in is decided by the two styles below.
const anchor = computed(() => {
  const draw = slab.value;
  const rect = draw ?? { left: 0, top: 0, width: BOX.width, height: BOX.height };
  return {
    right: BOX.right + BOX.width - rect.left - rect.width,
    bottom: BOX.bottom + BOX.height - rect.top - rect.height,
    width: rect.width,
    height: rect.height
  };
});

/** The press/hover shrink, and the transition that drives it. Identical on both elements and both arms. */
const pressScale = computed(() => (pressed.value ? DOWN_SCALE : focused.value ? HOVER_SCALE : 1));
const pressTransition = computed(() => `scale ${pressed.value ? PRESS_MS : RELEASE_MS}ms ease-out`);

// THIS COMPONENT RENDERS INTO TWO DIFFERENT SPACES, and on the `?stageFit=display` arm they are not the same one.
// The two styles below are the whole of that difference; everything else about the two elements is shared.
//
//   * the INPUT TARGET stays in the component's own slot, which MirrorView wraps in `.mirror-chrome-layer` — a
//     DESIGN-space box that already carries `transform: scale(fit)`. So it writes design px and adds no scale of
//     its own. Doing otherwise put the anchor at design x fit inside a layer that scaled it again, so the hit area
//     drifted off the slab a player is aiming at (proven in handRaiseDisplayArm.spec.ts).
//   * the VISIBLE CHROME teleports out into a mirror node (CombatPileContainer, `teleportTarget`), which on this
//     arm is laid out in display px with no scaling ancestor. So it converts.
//
// On the design arm the two spaces coincide and both styles emit identical strings, which is why one shared style
// was correct until the display arm existed — and why no existing test could have caught the split.

/** Design px, no layout scale: this element rides MirrorView's already-scaled chrome layer. */
const targetStyle = computed<CSSProperties>(() => {
  const a = anchor.value;
  return {
    right: `${a.right}px`,
    bottom: `${a.bottom}px`,
    width: `${a.width}px`,
    height: `${a.height}px`,
    scale: `${pressScale.value}`,
    transition: pressTransition.value
  };
});

/**
 * Display px: the teleported slab converts its own anchors, and rides one `scale()` for its design-px interior
 * (slab, mask, glyph grid) rather than converting four more computed styles and the SVG grid for no visual gain.
 *
 * WHY THE SCALE IS WRITTEN AS `translate() scale()` ABOUT THE DEFAULT ORIGIN. The layout scale wants to pivot at
 * the bottom-right corner — the corner `right`/`bottom` pin the button by, so the anchor stays welded to the HUD
 * while the art shrinks. The press/hover animation wants to pivot at the centre. An element has exactly one
 * `transform-origin` and the individual `scale:` property shares it, so pointing it at the corner silently moved
 * the press pivot there too, on this arm only.
 *
 * Scaling about the centre and translating by `(O - C)(1 - s)` is algebraically identical to scaling about the
 * corner O — for a box of width w that is `(w/2)(1 - s)`, because scaling about the centre pulls the right edge in
 * by exactly that much. So the anchor is pinned exactly as before while `transform-origin` stays at its default
 * and the press keeps pivoting at the centre, matching the design arm.
 */
const chromeStyle = computed<CSSProperties>(() => {
  const a = anchor.value;
  const s = layoutScale();
  return {
    right: pxCss(a.right),
    bottom: pxCss(a.bottom),
    width: `${a.width}px`,
    height: `${a.height}px`,
    scale: `${pressScale.value}`,
    ...(s === 1
      ? {}
      : {
          transform:
            `translate(${(a.width / 2) * (1 - s)}px, ${(a.height / 2) * (1 - s)}px) scale(${s})`
        }),
    transition: pressTransition.value
  };
});

// The sprite region filling the root — slab, torn edge and rim.
const slabStyle = computed<CSSProperties>(() => {
  const s = sprite.value;
  const draw = slab.value;
  if (!s || !draw) {
    return { display: "none" };
  }
  return {
    inset: "0",
    backgroundImage: `url("${s.pageUrl}")`,
    backgroundPosition: draw.backgroundPosition,
    backgroundSize: draw.backgroundSize,
    backgroundRepeat: "no-repeat"
  };
});

// The same region used as a MASK, shrunk inside the rim and filled with the slab's interior. This is what removes
// the game's eye without inventing a shape of our own: the silhouette is still the authored one. The crop is
// re-derived for the smaller element rather than re-used — a background scales with its box, so re-using the
// slab's numbers would CROP the silhouette instead of shrinking it.
const interiorStyle = computed<CSSProperties>(() => {
  const s = sprite.value;
  const draw = slab.value;
  if (!s || !draw) {
    return { display: "none" };
  }
  const size = { width: draw.width * INTERIOR_SCALE, height: draw.height * INTERIOR_SCALE };
  const inner = atlasRegionBackground(s, size, naturalSize(s.pageUrl) ?? undefined);
  const mask = {
    maskImage: `url("${s.pageUrl}")`,
    maskPosition: inner.backgroundPosition,
    maskSize: inner.backgroundSize,
    maskRepeat: "no-repeat"
  };
  return {
    left: `${(draw.width - size.width) / 2}px`,
    top: `${(draw.height - size.height) / 2}px`,
    width: `${size.width}px`,
    height: `${size.height}px`,
    background: `linear-gradient(${INTERIOR_TOP}, ${INTERIOR_BOTTOM})`,
    ...mask,
    WebkitMaskImage: mask.maskImage,
    WebkitMaskPosition: mask.maskPosition,
    WebkitMaskSize: mask.maskSize,
    WebkitMaskRepeat: mask.maskRepeat
  } as CSSProperties;
});

watchEffect(() => {
  const r = renderer.value;
  const s = sprite.value;
  const image = atlasImage.value;
  const draw = slab.value;
  if (!r?.setHandRaiseChrome || !shown.value || !canvasBackend.value || !s || !image || !draw) {
    r?.setHandRaiseChrome?.(null);
    return;
  }
  paintHandRaiseChrome(canvasSource, image, s, on.value);
  r.setHandRaiseChrome({
    source: canvasSource,
    width: draw.width,
    height: draw.height,
    right: BOX.right + BOX.width - draw.left - draw.width,
    bottom: BOX.bottom + BOX.height - draw.top - draw.height,
    scale: pressed.value ? DOWN_SCALE : focused.value ? HOVER_SCALE : 1,
    revision: ++canvasRevision
  });
});

// --- input ------------------------------------------------------------------------------------------------------
// Every press immediately INVERTS the saved state. A release at or before SUSTAIN_MS promotes that inversion to
// the saved toggle; a longer press is momentary and restores the saved state on release. Pointer capture keeps the
// override active outside the target until the matching release/cancel arrives.
function onDown(event: PointerEvent): void {
  if (
    !event.isPrimary || activePointer.value !== null ||
    (event.pointerType === "mouse" && event.button !== 0) || blocked.value
  ) return;
  activePointer.value = event.pointerId;
  pressStartedAt = performance.now();
  savedAtPress = mirrorSettings.raiseHandCards;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  focused.value = true;
  pressed.value = true;
  setHandRaisePressOverride(!savedAtPress);
}

function onUp(event: PointerEvent): void {
  if (activePointer.value !== event.pointerId) return;
  const toggle = performance.now() - pressStartedAt <= SUSTAIN_MS;
  const nextSaved = !savedAtPress;
  activePointer.value = null;
  pressed.value = false;
  focused.value = false;
  if (toggle) saveRaiseHandCards(nextSaved);
  setHandRaisePressOverride(null);
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
}

function onCancel(): void {
  activePointer.value = null;
  pressed.value = false;
  focused.value = false;
  setHandRaisePressOverride(null);
}

function onLeave(): void {
  if (!pressed.value) focused.value = false;
}

watch(blocked, (value) => { if (value) onCancel(); });
watch(shown, (value) => { if (!value) onCancel(); });
onBeforeUnmount(() => {
  onCancel();
  renderer.value?.setHandRaiseChrome?.(null);
});
</script>

<template>
  <!-- Paint ownership: on DOM, the visible control is a real child of CombatPileContainer. Canvas paints the
       equivalent texture command in that anchor's draw range, so it needs no visible DOM twin. -->
  <Teleport v-if="shown && !canvasBackend" :to="teleportTarget">
  <div
    class="mirror-hand-raise mirror-hand-raise--chrome"
    data-testid="mirror-hand-raise-chrome"
    aria-hidden="true"
    :style="chromeStyle"
  >
    <div class="mirror-hand-raise-layer" :style="slabStyle"></div>
    <div class="mirror-hand-raise-layer" :style="interiorStyle"></div>
    <!-- The glyph: a three-card fan with a chevron showing whether the held state is active. Drawn in the sprite's
         own rim colour, on the SPRITE REGION's own 166x121 grid, so its proportions are fixed to the art and not
         to whatever box the button is given. Filled with the slab interior so the cards occlude each other like a
         real fan instead of reading as overlapping outlines; paint order is outer cards first, centre card last. -->
    <svg
      class="mirror-hand-raise-glyph"
      viewBox="0 0 166 121"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <g :stroke="GLYPH_COLOR" :fill="INTERIOR_BOTTOM" stroke-width="4.6" stroke-linejoin="round">
        <rect x="47" y="62" width="28" height="40" rx="4" transform="rotate(-22 61 82)" />
        <rect x="91" y="62" width="28" height="40" rx="4" transform="rotate(22 105 82)" />
        <rect x="69" y="58" width="28" height="40" rx="4" />
        <polyline
          fill="none"
          stroke-width="6.6"
          stroke-linecap="round"
          :points="on ? '62,20 83,40 104,20' : '62,40 83,20 104,40'"
        />
      </g>
    </svg>
  </div>
  </Teleport>
  <!-- Input ownership: a transparent Vue target above the stage for BOTH backends. The DOM scene contains
       full-stage transparent hover layers after CombatPileContainer, so putting listeners only on the visible
       teleported child makes the control look usable while those layers receive every pointer event. `blocked`
       is the scene-order backstop verdict, which restores normal game input whenever later content covers it. -->
  <div
    v-if="shown"
    class="mirror-hand-raise mirror-hand-raise--target"
    :class="{ 'mirror-hand-raise--blocked': blocked }"
    data-testid="mirror-hand-raise-button"
    :data-on="on ? '1' : '0'"
    role="button"
    :aria-pressed="on"
    :aria-label="t('a11y.raiseHand')"
    :style="targetStyle"
    @pointerdown.stop.prevent="onDown"
    @pointerup.stop="onUp"
    @pointermove.stop
    @pointercancel.stop="onCancel"
    @lostpointercapture="onCancel"
    @pointerenter="focused = true"
    @pointerleave="onLeave"
  ></div>
</template>

<style scoped>
/* CouchCoop's OWN chrome (a design-space overlay above the mirrored stage), never a @spirectl/godot-scene-web
   presentation element — so it is styled here by design. It reproduces the look of a game widget, but nothing the
   reconciler renders is touched. */
.mirror-hand-raise {
  position: absolute;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}

.mirror-hand-raise--chrome {
  pointer-events: none;
}

.mirror-hand-raise--target {
  /* Input-only: paint stays in the scene/canvas command order above. This must sit over transparent full-stage
     hover layers; real later covers disable it through `.mirror-hand-raise--blocked`. */
  z-index: 2147483643;
  background: transparent;
}

.mirror-hand-raise--blocked {
  pointer-events: none;
}

.mirror-hand-raise-layer {
  position: absolute;
  pointer-events: none;
}

.mirror-hand-raise-glyph {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
