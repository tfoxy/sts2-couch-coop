// The one place the new-renderer stage chunk is imported. It is its own module so a spec can replace it with a loader
// that rejects or never resolves; the timeout and the fallback policy live in MirrorApp, not here, so mocking this
// module does not mock them away.
export const importRenderStreamStage = () => import("@/mirror/RenderStreamStage.vue");
