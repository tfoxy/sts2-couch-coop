// READABLE-HAND MODE, chrome half — the small reactive seam between the reconciler and the HUD hold button.
//
// The renderer knows whether a combat hand is on screen (it tracks the holders anyway, for the raise itself), but
// that is a per-reconcile FACT, not a reactive value. MirrorView refreshes it once per rendered frame from the same
// place it refreshes the confirm button's liveness, and MirrorHandRaiseButton.vue renders off it. The component
// owns only a transient press override; a short press promotes that override to the persisted preference.

import { computed, shallowReactive } from "vue";

import type { HandRaiseUiLayer } from "@/mirror/renderer/contracts";
import { mirrorSettings, persistMirrorSetting } from "@/mirror/mirrorSettings";

export const handRaiseUi = shallowReactive({
  /** Is a combat hand on screen? (mirrorRenderer.handPresent, refreshed per rendered frame.) */
  handPresent: false,
  /** Renderer-owned scene anchor and cover answer for the client-only control. */
  layer: null as HandRaiseUiLayer | null,
  /** Momentary pointer override. Null means the saved setting is authoritative. */
  pressOverride: null as boolean | null
});

/** A press can temporarily invert either saved state: raise a lowered hand or lower a raised hand. */
export const effectiveRaiseHandCards = computed(() => handRaiseUi.pressOverride ?? mirrorSettings.raiseHandCards);

/** Push the reconciler's answer. Cheap and idempotent — assignments only wake watchers on a real change. */
export function setHandRaiseLayer(layer: HandRaiseUiLayer | null): void {
  const present = layer?.present === true;
  const old = handRaiseUi.layer;
  if (
    old?.present !== layer?.present || old?.anchorId !== layer?.anchorId || old?.domTarget !== layer?.domTarget ||
    old?.covered !== layer?.covered || old?.backend !== layer?.backend
  ) handRaiseUi.layer = layer;
  if (handRaiseUi.handPresent !== present) {
    handRaiseUi.handPresent = present;
  }
  if ((!present || layer?.covered) && handRaiseUi.pressOverride !== null) setHandRaisePressOverride(null);
}

export function setHandRaisePressOverride(value: boolean | null): void {
  if (handRaiseUi.pressOverride !== value) handRaiseUi.pressOverride = value;
}

/** Promote a short press to the same saved setting used by the Settings checkbox. */
export function saveRaiseHandCards(value: boolean): void {
  mirrorSettings.raiseHandCards = value;
  persistMirrorSetting("raiseHandCards", value);
}

/** TEST-ONLY: forget the tracked hand state so a spec starts clean. */
export function __resetHandRaiseUiForTest(): void {
  handRaiseUi.handPresent = false;
  handRaiseUi.layer = null;
  handRaiseUi.pressOverride = null;
}
