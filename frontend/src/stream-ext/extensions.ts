// The interactive stage installs each setting-gated module once. Settings change their work live, so toggles
// need no new hello, canvas or connection. Receive-only probes keep their initially selected extension list.

import { watch } from "vue";

import type { ExtensionSession, OverrideTable, RenderStreamExtension } from "@godot-scene-web/render-stream-client";

import type { MirrorSettings } from "@/mirror/mirrorSettings";
import { createConfirmTapExtension, type ConfirmTapController } from "@/stream-ext/confirmTap";
import { createHeldCardExtension, type HeldCardController } from "@/stream-ext/heldCard";
import { createPointerTargetModule, type PointerTargetModule } from "@/stream-ext/pointerTargets";
import { createHandPresenceExtension, createRaisedHandExtension } from "@/stream-ext/raisedHand";
import { createViewScaleExtension } from "@/stream-ext/viewScale";

export interface StreamExtensionsOptions {
  readonly settings: MirrorSettings;
  /** The seat's presentation width (the view-scale clamp's design width). */
  readonly presentationWidth: number;
  /** The page sends input: install all live modules and the pointer-target module. */
  readonly interactive?: boolean;
  /** Includes the button's momentary press override, when mounted by an interactive stage. */
  readonly raiseHandCards?: () => boolean;
  readonly onHandPresent?: (present: boolean, covered: boolean) => void;
}

/** The extension list plus the input-side controllers of the modules the input channel drives. */
export interface StreamExtensions {
  readonly extensions: readonly RenderStreamExtension[];
  readonly heldCard: HeldCardController | null;
  readonly confirmTap: ConfirmTapController | null;
  /** The pointer-target module (interactive pages only). */
  readonly pointerTargets: PointerTargetModule | null;
}

/** Interactive pages install live gates; receive-only pages install their initial selection. */
export function buildStreamExtensions(options: StreamExtensionsOptions): StreamExtensions {
  const extensions: RenderStreamExtension[] = [];
  let heldCard: HeldCardController | null = null;
  let confirmTap: ConfirmTapController | null = null;
  const enabled = (key: "raiseHandCards" | "uiScaling" | "raiseHeldCard" | "confirmTap") => key === "raiseHandCards" && options.raiseHandCards
    ? options.raiseHandCards : () => options.settings[key];
  const install = (key: "raiseHandCards" | "uiScaling" | "raiseHeldCard" | "confirmTap") =>
    options.interactive === true || options.settings[key];
  if (install("raiseHandCards")) extensions.push(settingGated(createRaisedHandExtension(), enabled("raiseHandCards")));
  if (install("uiScaling")) {
    extensions.push(settingGated(createViewScaleExtension({ designWidth: options.presentationWidth }), enabled("uiScaling")));
  }
  if (install("raiseHeldCard")) {
    const held = createHeldCardExtension();
    extensions.push(settingGated(held.extension, enabled("raiseHeldCard"), () => held.controller.setHeld(null, 0, "drag")));
    heldCard = held.controller;
  }
  if (install("confirmTap")) {
    const confirm = createConfirmTapExtension();
    extensions.push(settingGated(confirm.extension, enabled("confirmTap"), () => confirm.controller.hide()));
    confirmTap = confirm.controller;
  }
  let pointerTargets: PointerTargetModule | null = null;
  if (options.interactive === true) {
    pointerTargets = createPointerTargetModule();
    extensions.push(pointerTargets.extension);
    if (options.onHandPresent) extensions.push(createHandPresenceExtension(options.onHandPresent));
  }
  return { extensions, heldCard, confirmTap, pointerTargets };
}

/** Keep identity current while off, but do no scene queries or tree walks on disabled frames. */
function settingGated(
  extension: RenderStreamExtension,
  enabled: () => boolean,
  deactivate?: () => void
): RenderStreamExtension {
  const written = new Set<number>();
  let session: ExtensionSession | null = null;
  let overrides: OverrideTable | null = null;
  let needsClear = false;
  const stop = watch(enabled, (on) => {
    if (!on) {
      deactivate?.();
      needsClear = true;
    } else {
      // Invalidate the module's cached plan without losing the identity accumulated while disabled.
      extension.onItemMeta?.({ form: "delta", items: [] });
    }
    session?.requestRedraw();
  }, { flush: "sync" });

  // The client shares one override table across modules. Track this module's writes so disabling it cannot clear
  // another module's transforms. The adapter is allocated once per session, never per idle frame.
  function track(table: OverrideTable): OverrideTable {
    return {
      set(id, value) { written.add(id); table.set(id, value); },
      translate(id, x, y) { written.add(id); table.translate(id, x, y); },
      scaleAbout(id, sx, sy, x, y) { written.add(id); table.scaleAbout(id, sx, sy, x, y); },
      setGlobal(id, transform) { written.add(id); table.setGlobal(id, transform); },
      freeze(id, on) { written.add(id); table.freeze(id, on); },
      clear(id) { written.delete(id); table.clear(id); },
      clearAll() { for (const id of written) table.clear(id); written.clear(); },
      get: (id) => table.get(id),
      effective: (id) => table.effective(id),
      get size() { return table.size; }
    };
  }

  return {
    ...extension,
    onSession(s) {
      session = s;
      overrides = null;
      written.clear();
      extension.onSession?.(s);
    },
    onItemsRemoved(ids) {
      for (const id of ids) written.delete(id);
      extension.onItemsRemoved?.(ids);
    },
    beforeDraw(frame) {
      if (needsClear) {
        for (const id of written) frame.overrides.clear(id);
        written.clear();
        needsClear = false;
      }
      if (!enabled()) return;
      overrides ??= track(frame.overrides);
      extension.beforeDraw?.({ ...frame, overrides });
    },
    dispose() {
      stop();
      session = null;
      overrides = null;
      written.clear();
      extension.dispose?.();
    }
  };
}
