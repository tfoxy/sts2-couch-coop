import type { InjectionKey, ShallowRef } from "vue";

import type { MirrorRenderer } from "@/mirror/renderer/contracts";

// STAGE-A "Static background": MirrorView provides its (onMounted-created) renderer to the browser-only controls
// injected into its stage slot, so StaticBackground.vue can report the confirmed-shown signal
// (renderer.setStaticBackgroundShown) without MirrorApp having to proxy an imperative handle through props.
// A ShallowRef because the renderer is created after mount and replaced never; null before mount / after dispose.
export const MIRROR_RENDERER_KEY: InjectionKey<Readonly<ShallowRef<MirrorRenderer | null>>> =
  Symbol("mirrorRenderer");
