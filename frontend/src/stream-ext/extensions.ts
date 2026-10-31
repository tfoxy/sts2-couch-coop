// stream-ext/extensions.ts — which render-stream extension modules this viewer runs, and with what.
//
// One extension list, composed in product order. A viewer who enabled neither module gets `[]`, whose hello is
// byte-identical to a pure client (no `item_meta` key) and whose loop is today's (TAG2: no ExtensionHost for `[]`).
// The modules read the viewer's SAVED choices: `mirrorSettings.raiseHandCards` and `mirrorSettings.uiScaling`, which
// under the new renderer now mean "run this module" instead of the old mirror's transform, so the two rows left
// STREAM_RENDER_OVERRIDES and are the viewer's again.

import type { RenderStreamExtension } from "@godot-scene-web/render-stream-client";

import type { MirrorSettings } from "@/mirror/mirrorSettings";
import { createRaisedHandExtension } from "@/stream-ext/raisedHand";
import { createViewScaleExtension } from "@/stream-ext/viewScale";

export interface StreamExtensionsOptions {
  readonly settings: MirrorSettings;
  /** The seat's presentation width (the view-scale clamp's design width). */
  readonly presentationWidth: number;
}

/** The extensions this page runs, or [] when the viewer has neither module on. */
export function buildStreamExtensions(options: StreamExtensionsOptions): RenderStreamExtension[] {
  const extensions: RenderStreamExtension[] = [];
  if (options.settings.raiseHandCards) extensions.push(createRaisedHandExtension());
  if (options.settings.uiScaling) {
    extensions.push(createViewScaleExtension({ designWidth: options.presentationWidth }));
  }
  return extensions;
}
