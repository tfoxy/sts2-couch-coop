// stream-ext/extensions.ts — which render-stream extension modules this viewer runs, and with what.
//
// One extension list, composed in product order. A viewer who enabled no module gets `[]`, whose hello is
// byte-identical to a pure client (no `item_meta` key) and whose loop is today's (TAG2: no ExtensionHost for `[]`).
// The modules read the viewer's SAVED choices: `mirrorSettings.raiseHandCards`, `mirrorSettings.uiScaling`,
// `mirrorSettings.raiseHeldCard` and `mirrorSettings.confirmTap`, which under the new renderer now mean "run this
// module" instead of the old mirror's transform, so those rows left STREAM_RENDER_OVERRIDES and are the viewer's
// again. `unfocusOnRelease` is the held-card module's release behaviour and rides the input channel, so it is not a
// module of its own (and needs no identity to leave the forced table).
//
// Two of the modules are not view-only: the held-card lift and the confirm button are driven by the input channel,
// so `buildStreamExtensions` also returns their controllers for RenderStreamStage to hand to `createStreamInput`.
//
// An INTERACTIVE page (one that sends input) also always runs the pointer-target module (C3): the Godot mouse
// filters the hit test picks by, and the identity climb its input names targets with. It is not a
// viewer setting: every gesture and coordinate depends on it. A receive-only page leaves it out (its list, and so
// its hello, are exactly the modules the viewer enabled).

import type { RenderStreamExtension } from "@godot-scene-web/render-stream-client";

import type { MirrorSettings } from "@/mirror/mirrorSettings";
import { createConfirmTapExtension, type ConfirmTapController } from "@/stream-ext/confirmTap";
import { createHeldCardExtension, type HeldCardController } from "@/stream-ext/heldCard";
import { createPointerTargetModule, type PointerTargetModule } from "@/stream-ext/pointerTargets";
import { createRaisedHandExtension } from "@/stream-ext/raisedHand";
import { createViewScaleExtension } from "@/stream-ext/viewScale";

export interface StreamExtensionsOptions {
  readonly settings: MirrorSettings;
  /** The seat's presentation width (the view-scale clamp's design width). */
  readonly presentationWidth: number;
  /** The page sends input: run the pointer-target module (C3). */
  readonly interactive?: boolean;
}

/** The extension list plus the input-side controllers of the modules the input channel drives. */
export interface StreamExtensions {
  readonly extensions: readonly RenderStreamExtension[];
  readonly heldCard: HeldCardController | null;
  readonly confirmTap: ConfirmTapController | null;
  /** The pointer-target module (interactive pages only). */
  readonly pointerTargets: PointerTargetModule | null;
}

/** The extensions this page runs, or [] when the viewer has no module on. */
export function buildStreamExtensions(options: StreamExtensionsOptions): StreamExtensions {
  const extensions: RenderStreamExtension[] = [];
  let heldCard: HeldCardController | null = null;
  let confirmTap: ConfirmTapController | null = null;
  if (options.settings.raiseHandCards) extensions.push(createRaisedHandExtension());
  if (options.settings.uiScaling) {
    extensions.push(createViewScaleExtension({ designWidth: options.presentationWidth }));
  }
  if (options.settings.raiseHeldCard) {
    const held = createHeldCardExtension();
    extensions.push(held.extension);
    heldCard = held.controller;
  }
  if (options.settings.confirmTap) {
    const confirm = createConfirmTapExtension();
    extensions.push(confirm.extension);
    confirmTap = confirm.controller;
  }
  let pointerTargets: PointerTargetModule | null = null;
  if (options.interactive === true) {
    pointerTargets = createPointerTargetModule();
    extensions.push(pointerTargets.extension);
  }
  return { extensions, heldCard, confirmTap, pointerTargets };
}
