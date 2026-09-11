// CONFIRM TAP — the client-side confirm button for choices a tap cannot take back.
//
// On a phone the two-step "Tap to focus" gesture (tap 1 focuses, tap 2 commits) is the only guard against a
// mis-tap, and on the screens where a tap SPENDS a run reward — a card-reward pick, an event option (ancients
// included), a shop purchase, a multiplayer treasure relic, a rest-site choice — that guard is thin: the commit
// tap lands on the very spot the focus tap did, so a finger bounce takes the reward. On those widgets this feature
// takes over: a tap ONLY ever focuses (re-tapping just moves the cursor), and a separate button — drawn as the
// game's own res://scenes/ui/confirm_button.tscn, in its authored bottom-right slot — is what commits.
//
// The button is CouchCoop's own chrome. The game never learns it exists: committing re-sends a plain left click at
// the exact GAME coordinate the focus hover already went to, so the game simply presses whatever its cursor is
// already over. Nothing is added to the mirrored scene, and the host is untouched.
//
// This module is the seam between the three parties, so none of them has to know about the others:
//   inputCapture  decides WHEN (the gesture) and owns the click that a commit sends (setConfirmCommit);
//   MirrorView    keeps `belowOverlay` and liveness in step with the reconciler;
//   the component (MirrorConfirmButton.vue) draws it and calls commitConfirmTap().
//
// It also owns the two facts neither of those can hold alone: the resolved SPRITES (see resolveConfirmSprites) and
// the multiplayer-treasure "already selected" latch (see confirmedRelicId).

import { reactive, ref, shallowRef } from "vue";

import { resolveAtlasSprite, type AtlasSprite, type AtlasSpriteRect } from "@/mirror/atlasSprite";
import { warmImage } from "@/mirror/textureCache";

/**
 * Which kind of irreversible choice a confirm-eligible widget is. Only `relic` behaves differently (the
 * already-selected latch below); the rest are carried for readability and for the tests to assert against.
 * The classification itself lives in mirrorRenderer's `confirmTapEligible`.
 */
export type ConfirmTapKind = "reward" | "event" | "shop" | "relic" | "rest";

export type ConfirmTapRect = AtlasSpriteRect;

/** One resolved AtlasTexture: the atlas PAGE url plus the sub-rect (and Godot margin) to draw out of it. */
export type ConfirmSprite = AtlasSprite;

export interface ConfirmSprites {
  /** The button body — also drawn, black at 25%, as the Shadow layer. */
  button: ConfirmSprite;
  /** The focus ring (additive, modulated gold only while focused). */
  outline: ConfirmSprite;
  /** The tick glyph inside the body. */
  tick: ConfirmSprite;
}

// The three AtlasTexture resources confirm_button.tscn paints with. Paths only — the regions inside each atlas are
// RESOLVED at runtime from the .tres, never hardcoded, because a repack moves them.
const CONFIRM_SPRITE_PATHS = {
  button: "res://images/atlases/ui_atlas.sprites/confirm_button.tres",
  outline: "res://images/atlases/compressed.sprites/confirm_button_outline.tres",
  tick: "res://images/atlases/compressed.sprites/confirm_button_tick.tres"
} as const;

/**
 * The live confirm-button state.
 *
 * `targetId` is the widget the button will commit — null means no button. `belowOverlay` is the stacking verdict
 * (see mirrorRenderer.coverAbove): true while one of the game's modal overlays paints over the target, which sinks
 * the button under the whole mirror tree instead of hiding it, so closing the map brings it straight back.
 */
export const confirmTap = reactive({
  targetId: null as string | null,
  kind: null as ConfirmTapKind | null,
  belowOverlay: false
});

/** The resolved sprites, or null until `primeConfirmSprites` has finished (or if it failed). */
export const confirmSprites = shallowRef<ConfirmSprites | null>(null);

/** Bumped whenever a resolve attempt settles, so a watcher can retry/react without polling. */
export const confirmSpritesVersion = ref(0);

// The MULTIPLAYER-treasure latch: the relic this client last confirmed. A treasure vote can be changed by picking
// another relic, so exactly one relic is "already selected" at a time — and the button must not offer to re-pick it
// (the user's rule: it appears only for non-selected relics). Deliberately relic-ONLY: a shop purchase that fails
// for want of gold must stay re-confirmable without tapping away and back.
let confirmedRelicId: string | null = null;

// The click a commit sends. Owned by inputCapture (it alone knows how to put a coordinate on the wire) and
// registered when the capture is created; cleared on dispose so a torn-down capture can never be called.
let commitHandler: (() => void) | null = null;

// The gesture-side teardown a HIDE must trigger. The capture keeps two pieces of state the button's existence
// implies — the stored commit coordinate, and the arm the confirm branch put on the target — and every caller of
// hideConfirmTap used to be responsible for also clearing them, which MirrorView's liveness hide (and the
// setting-off hide) did not: the coordinate and the arm stayed live, and a later tap on the same widget fell
// through to the armed-commit branch and CLICKED a widget the feature had promised never to click. Routing the
// teardown through the hide itself makes "button down ⇒ that state is gone" true for every caller, present and
// future. Registered by inputCapture beside the commit handler.
let hiddenHandler: ((targetId: string) => void) | null = null;

/** Register the hide-teardown hook (see hiddenHandler). Returns an unregister, like setConfirmCommit. */
export function setConfirmHidden(handler: ((targetId: string) => void) | null): () => void {
  hiddenHandler = handler;
  return () => {
    if (hiddenHandler === handler) {
      hiddenHandler = null;
    }
  };
}

/**
 * Register the committer. Returns an unregister so a disposed inputCapture takes its handler with it (a Set is
 * unnecessary — there is exactly one controlling capture per page).
 */
export function setConfirmCommit(handler: (() => void) | null): () => void {
  commitHandler = handler;
  return () => {
    if (commitHandler === handler) {
      commitHandler = null;
    }
  };
}

/** Are the sprites resolved? Until they are, an eligible widget falls back to the plain two-step tap. */
export function confirmButtonReady(): boolean {
  return confirmSprites.value !== null;
}

/**
 * Show the button for `targetId`. Refused for a relic this client has already selected, and (defensively) when the
 * sprites are not resolved — the caller checks `confirmButtonReady` first, but a refusal here keeps the invariant
 * "a visible button can always be drawn" true for the component.
 */
export function showConfirmTap(targetId: string, kind: ConfirmTapKind): void {
  if (!confirmButtonReady() || (kind === "relic" && targetId === confirmedRelicId)) {
    // Nothing to confirm here — and if a button is up for something else, it is stale now.
    hideConfirmTap();
    return;
  }
  if (confirmTap.targetId !== targetId) {
    confirmTap.belowOverlay = false; // re-derived from the next reconcile; never inherit the last target's verdict
  }
  confirmTap.targetId = targetId;
  confirmTap.kind = kind;
}

export function hideConfirmTap(): void {
  const targetId = confirmTap.targetId;
  confirmTap.targetId = null;
  confirmTap.kind = null;
  confirmTap.belowOverlay = false;
  // AFTER the state is down (a hook observing confirmTap sees the hidden button), and only for a real hide — the
  // hook disarms per-target, so it needs to know which target just lost its button.
  if (targetId !== null) {
    hiddenHandler?.(targetId);
  }
}

/** The stacking verdict, pushed by MirrorView after each reconcile. */
export function setConfirmBelowOverlay(below: boolean): void {
  confirmTap.belowOverlay = below;
}

/**
 * Commit the focused choice: run inputCapture's click, latch a relic pick, and take the button down. Safe to call
 * with no button up (the component can't, but a stray pointerup during teardown could).
 */
export function commitConfirmTap(): void {
  const targetId = confirmTap.targetId;
  if (targetId === null) {
    return;
  }
  if (confirmTap.kind === "relic") {
    confirmedRelicId = targetId;
  }
  commitHandler?.();
  hideConfirmTap();
}

/**
 * Drop the relic latch when that relic leaves the tree (the treasure room closed, or the vote resolved). Called by
 * MirrorView's liveness check with the same "is this id still rendered" question it uses for the target itself, so
 * the latch can never outlive the screen it belongs to.
 */
export function forgetConfirmedRelic(): void {
  confirmedRelicId = null;
}

/** The relic this client last confirmed (test seam / MirrorView's liveness check). */
export function confirmedRelicTarget(): string | null {
  return confirmedRelicId;
}

/**
 * Resolve the three sprites once per page. Idempotent and fire-and-forget: a failure leaves `confirmSprites` null,
 * which makes `confirmButtonReady` false, which makes every eligible widget fall back to the ordinary two-step tap
 * — the feature degrades, it never leaves an option unclickable.
 */
let priming: Promise<void> | null = null;
export function primeConfirmSprites(): Promise<void> {
  if (priming === null) {
    priming = resolveConfirmSprites()
      .then((sprites) => {
        confirmSprites.value = sprites;
      })
      .catch(() => {
        confirmSprites.value = null;
      })
      .finally(() => {
        confirmSpritesVersion.value += 1;
      });
  }
  return priming;
}

async function resolveConfirmSprites(): Promise<ConfirmSprites> {
  const [button, outline, tick] = await Promise.all([
    resolveAtlasSprite(CONFIRM_SPRITE_PATHS.button),
    resolveAtlasSprite(CONFIRM_SPRITE_PATHS.outline),
    resolveAtlasSprite(CONFIRM_SPRITE_PATHS.tick)
  ]);
  // Warm the pages through the shared texture cache: it de-dupes with the renderer's own loads (these two atlases
  // are core UI, already decoded in any live screen) and it is what records the page's natural size, which
  // `regionBackgroundStyle` needs to place a region inside a box.
  for (const sprite of [button, outline, tick]) {
    warmImage(sprite.pageUrl);
  }
  return { button, outline, tick };
}

// --- test seams (never called in production) -------------------------------------------------------------------

export function __resetConfirmTapForTest(): void {
  hideConfirmTap();
  confirmedRelicId = null;
  commitHandler = null;
  hiddenHandler = null;
  confirmSprites.value = null;
  confirmSpritesVersion.value = 0;
  priming = null;
}

export function __setConfirmSpritesForTest(sprites: ConfirmSprites | null): void {
  confirmSprites.value = sprites;
  priming = sprites === null ? null : Promise.resolve();
}
