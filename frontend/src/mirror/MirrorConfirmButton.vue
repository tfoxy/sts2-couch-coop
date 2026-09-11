<script setup lang="ts">
// The CONFIRM TAP button — CouchCoop's own chrome, drawn as the game's res://scenes/ui/confirm_button.tscn.
//
// It is NOT a mirrored game node: the game has no confirm button on a card-reward / event / shop / treasure /
// rest screen, which is exactly why this exists (see confirmTap.ts for the why and the gesture rules). So it is
// built here, out of the game's own three sprites, at the .tscn's authored bottom-right slot, with the same
// enter / exit / focus / unfocus / press transitions the real button plays — a player should not be able to tell
// which of the two they are looking at.
//
// Every number below is either the authored layout (offsets/sizes straight off the scene) or a recorded transition
// (durations + Godot easings, the same ones spirectl's presentation catalog records for ui/confirm_button):
//   enter   position slides in from +180px, 350ms, out/back
//   exit    position slides back out +180px, 350ms, out/expo
//   focus   scale 1.05 and the outline goes opaque gold — instantly
//   unfocus scale and outline ease back to rest, 500ms, out/expo
//   press   scale 1.05 → 0.95, body modulates to grey, outline fades out, 250ms, out/cubic
//
// This renders inside MirrorView's design-space stage slot, so it scales with the game and re-anchors itself on a
// widened stage exactly like the game's own bottom-right HUD. Its pointer events are stopped at the root: the
// mirror's inputCapture listens on the stage element, and a tap here must never also reach the game as a click.

import { computed, onBeforeUnmount, ref, watch, type CSSProperties } from "vue";
import { translate as t } from "@/i18n";

import { godotEasingToCss } from "@godot-scene-web/html";

import { atlasSpriteLayout, STRETCH_KEEP_ASPECT_CENTERED } from "@/mirror/atlasSprite";
import { commitConfirmTap, confirmSprites, confirmTap, type ConfirmSprite } from "@/mirror/confirmTap";
import { naturalSize, textureSizeVersion } from "@/mirror/textureCache";

// --- authored layout (design px) --------------------------------------------------------------------------------
// The root Control is bottom-right anchored at offsets (-160, -354, +40, -244): a 200x110 box whose right edge sits
// 40px PAST the viewport edge (the game clips it; so does the stage). The three paint layers inset out of that box
// by their own authored offsets, and the tick sits inside the body.
const ROOT = { width: 200, height: 110, right: -40, bottom: 244 };
const SHADOW = { left: -41, top: -1, width: 267, height: 150 };
const OUTLINE = { left: -56, top: -16, width: 273, height: 156 };
const IMAGE = { left: -53, top: -13, width: 267, height: 150 };
const ICON = { left: 88, top: 28, width: 80, height: 80 };
// The root's pivot — every scale (hover 1.05, press 0.95) turns about it.
const PIVOT = "180px 40px";
// All four layers use Godot's TextureRect.StretchMode.KeepAspectCentered (STRETCH_KEEP_ASPECT_CENTERED).

// --- recorded transitions ---------------------------------------------------------------------------------------
const HIDE_OFFSET_X = 180; // the button parks this far right of its rest position while hidden
const SLIDE_MS = 350;
const UNFOCUS_MS = 500;
const PRESS_MS = 250;
const HOVER_SCALE = 1.05;
const DOWN_SCALE = 0.95;
// Godot Colors.Gray, applied to the body on press as a modulate (i.e. a multiply → a CSS brightness).
const DOWN_BRIGHTNESS = 0.752941;

const EASE_IN = godotEasingToCss("out", "back");
const EASE_OUT = godotEasingToCss("out", "expo");
const EASE_UNFOCUS = godotEasingToCss("out", "expo");
const EASE_PRESS = godotEasingToCss("out", "cubic");

// --- state --------------------------------------------------------------------------------------------------
// `mounted` outlives `confirmTap.targetId` by one exit animation, so the slide-out is actually seen.
const mounted = ref(false);
// `slidIn` drives the enter/exit translate. Flipped one frame AFTER mount so there is a "from" for CSS to animate.
const slidIn = ref(false);
const focused = ref(false);
const pressed = ref(false);

let exitTimer: ReturnType<typeof setTimeout> | null = null;
let enterFrame = 0;

function clearTimers(): void {
  if (exitTimer !== null) {
    clearTimeout(exitTimer);
    exitTimer = null;
  }
  if (enterFrame !== 0 && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(enterFrame);
    enterFrame = 0;
  }
}

watch(
  () => confirmTap.targetId,
  (targetId) => {
    clearTimers();
    if (targetId !== null) {
      pressed.value = false;
      focused.value = false;
      if (mounted.value) {
        // Already on screen. Two cases, and they collapse to the same one line:
        //   • the TARGET changed (option to option) — it just keeps its place, like the game's own button, which
        //     never re-plays its enter for a new selection;
        //   • it is mid-EXIT (a hide less than the 350ms slide ago) — reverse the slide from wherever it got to.
        // The second case is why this is not gated on `!mounted`: it used to be, and a re-show inside the exit
        // window then cancelled the exit TIMER while leaving `slidIn` false, parking the button off-screen for
        // good — the "sometimes doesn't come back" report.
        slidIn.value = true;
        return;
      }
      // A fresh mount has no "from" for CSS to animate out of, so paint it parked for one frame first.
      mounted.value = true;
      slidIn.value = false;
      if (typeof requestAnimationFrame === "function") {
        enterFrame = requestAnimationFrame(() => {
          enterFrame = 0;
          slidIn.value = true;
        });
      } else {
        slidIn.value = true;
      }
      return;
    }
    if (!mounted.value) {
      return;
    }
    slidIn.value = false;
    exitTimer = setTimeout(() => {
      exitTimer = null;
      mounted.value = false;
      focused.value = false;
      pressed.value = false;
    }, SLIDE_MS);
  },
  { immediate: true }
);

onBeforeUnmount(clearTimers);

// --- paint ----------------------------------------------------------------------------------------------------
//
// Each authored layer is a BOX (which is what positions it and its children) with a PAINT child sized to exactly
// the rect Godot's KeepAspectCentered would draw the texture in — see `atlasSpriteLayout` for why the element has
// to be the texture's own rect rather than the whole box.

// One atlas region, painted to fill its own element. `textureSizeVersion` is read so this recomputes when the
// atlas page's natural size lands — regionBackgroundStyle needs it to scale the page, and without it gsw falls
// back to native atlas pixels, which is why the sprites are primed long before the first tap.
function paintStyle(sprite: ConfirmSprite | undefined, box: { width: number; height: number }): CSSProperties {
  if (!sprite) {
    return { display: "none" };
  }
  void textureSizeVersion.value;
  const draw = atlasSpriteLayout(sprite, box, STRETCH_KEEP_ASPECT_CENTERED, naturalSize(sprite.pageUrl) ?? undefined);
  return {
    left: `${draw.left}px`,
    top: `${draw.top}px`,
    width: `${draw.width}px`,
    height: `${draw.height}px`,
    backgroundImage: `url("${sprite.pageUrl}")`,
    backgroundPosition: draw.backgroundPosition,
    backgroundSize: draw.backgroundSize,
    backgroundRepeat: "no-repeat"
  };
}

const rootStyle = computed<CSSProperties>(() => {
  const scale = pressed.value ? DOWN_SCALE : focused.value ? HOVER_SCALE : 1;
  // The scale transition is the only one with three speeds: instant INTO focus (the game snaps it), the press ramp,
  // and the long ease back to rest.
  const scaleMs = pressed.value ? PRESS_MS : focused.value ? 0 : UNFOCUS_MS;
  const scaleEase = pressed.value ? EASE_PRESS : EASE_UNFOCUS;
  return {
    right: `${ROOT.right}px`,
    bottom: `${ROOT.bottom}px`,
    width: `${ROOT.width}px`,
    height: `${ROOT.height}px`,
    transformOrigin: PIVOT,
    translate: `${slidIn.value ? 0 : HIDE_OFFSET_X}px 0`,
    scale: `${scale}`,
    transition:
      `translate ${SLIDE_MS}ms ${slidIn.value ? EASE_IN : EASE_OUT}, ` + `scale ${scaleMs}ms ${scaleEase}`,
    // STACKING (see mirrorRenderer.coverAbove): above the whole mirror tree normally — which is what puts it over a
    // card-reward / shop-inventory backstop, since those paint UNDER their own content — but BELOW it while one of
    // the game's modal overlays (map, deck, a card/relic dialog, pause) is over the option, so the button dims with
    // the content it belongs to instead of floating on top of the modal, and can't be tapped through it.
    zIndex: confirmTap.belowOverlay ? "-1" : "10",
    pointerEvents: confirmTap.belowOverlay ? "none" : "auto"
  };
});

const shadowPaint = computed<CSSProperties>(() => paintStyle(confirmSprites.value?.button, SHADOW));
const outlinePaint = computed<CSSProperties>(() => paintStyle(confirmSprites.value?.outline, OUTLINE));
const imagePaint = computed<CSSProperties>(() => paintStyle(confirmSprites.value?.button, IMAGE));
const iconPaint = computed<CSSProperties>(() => paintStyle(confirmSprites.value?.tick, ICON));

const outlineStyle = computed<CSSProperties>(() => ({
  ...boxStyle(OUTLINE),
  // The authored outline is transparent at rest, opaque gold on focus, and fades out again under the press ramp.
  opacity: focused.value && !pressed.value ? 1 : 0,
  transition: `opacity ${pressed.value ? PRESS_MS : focused.value ? 0 : UNFOCUS_MS}ms ${
    pressed.value ? EASE_PRESS : EASE_UNFOCUS
  }`
}));

const imageStyle = computed<CSSProperties>(() => ({
  ...boxStyle(IMAGE),
  filter: pressed.value ? `brightness(${DOWN_BRIGHTNESS})` : "brightness(1)",
  transition: `filter ${pressed.value ? PRESS_MS : UNFOCUS_MS}ms ${pressed.value ? EASE_PRESS : EASE_UNFOCUS}`
}));

function boxStyle(box: { left: number; top: number; width: number; height: number }): CSSProperties {
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`
  };
}

const shadowStyle = computed<CSSProperties>(() => boxStyle(SHADOW));
const iconStyle = computed<CSSProperties>(() => boxStyle(ICON));

// --- input ------------------------------------------------------------------------------------------------------
// A touch press focuses AND presses in one go (there is no hover on a phone); a mouse can focus by hovering. The
// commit happens on RELEASE, like the real button (its action is ButtonReleased).
function onDown(): void {
  focused.value = true;
  pressed.value = true;
}

function onUp(): void {
  if (!pressed.value) {
    return;
  }
  pressed.value = false;
  commitConfirmTap();
}

function onCancel(): void {
  pressed.value = false;
  focused.value = false;
}
</script>

<template>
  <div
    v-if="mounted"
    class="mirror-confirm"
    data-testid="mirror-confirm-button"
    role="button"
    tabindex="0"
    :aria-label="t('a11y.confirm')"
    :style="rootStyle"
    @pointerdown.stop="onDown"
    @pointerup.stop="onUp"
    @pointermove.stop
    @pointercancel.stop="onCancel"
    @pointerenter="focused = true"
    @pointerleave="onCancel"
  >
    <!-- The gold multiply for the outline's modulate. Lives with its only consumer and is zero-sized, so it
         neither affects layout nor outlives the button. -->
    <svg class="mirror-confirm-defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id="mirror-confirm-outline-tint" color-interpolation-filters="sRGB">
          <feColorMatrix
            type="matrix"
            values="0.941176 0 0 0 0
                    0 0.705882 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
          />
        </filter>
      </defs>
    </svg>
    <div class="mirror-confirm-layer mirror-confirm-shadow" :style="shadowStyle">
      <div class="mirror-confirm-paint" :style="shadowPaint"></div>
    </div>
    <div class="mirror-confirm-layer mirror-confirm-outline" :style="outlineStyle">
      <div class="mirror-confirm-paint" :style="outlinePaint"></div>
    </div>
    <div class="mirror-confirm-layer mirror-confirm-image" :style="imageStyle">
      <div class="mirror-confirm-paint" :style="imagePaint"></div>
      <div class="mirror-confirm-layer mirror-confirm-icon" :style="iconStyle">
        <div class="mirror-confirm-paint" :style="iconPaint"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* CouchCoop's OWN chrome (a design-space overlay above the mirrored stage), never a @spirectl/godot-scene-web
   presentation element — so it is styled here by design. It reproduces a game widget, but nothing the reconciler
   renders is touched. */
.mirror-confirm {
  position: absolute;
  /* The authored root box extends past the viewport's right edge; the stage's own overflow clip does what the
     game's viewport clip does. Nothing inside participates in text selection or a browser gesture. */
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}

.mirror-confirm-layer,
.mirror-confirm-paint {
  position: absolute;
  pointer-events: none;
}

/* Shadow: the body sprite as a flat black at 25% (the authored modulate). brightness(0) zeroes the colour and
   leaves the alpha, which is exactly what a black modulate does. */
.mirror-confirm-shadow {
  filter: brightness(0);
  opacity: 0.251;
}

/* Outline: the focus ring, drawn with the scene's additive material and modulated gold. The tint is an exact
   multiply, so it is an feColorMatrix rather than an approximating filter chain — see the <svg> defs below. */
.mirror-confirm-outline {
  filter: url(#mirror-confirm-outline-tint);
  mix-blend-mode: plus-lighter;
}

.mirror-confirm-defs {
  position: absolute;
  width: 0;
  height: 0;
  pointer-events: none;
}
</style>
