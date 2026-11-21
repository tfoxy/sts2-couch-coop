import { watch, type Ref } from "vue";
import type { MirrorSettings } from "./mirrorSettings";

export function streamSeatWidth(aspect: number | undefined): number {
  return aspect === undefined ? 1920 : Math.round(aspect * 1080);
}

/** Track only the current connected request. Resizing settles once to avoid repeated seat teardowns. */
export function useStreamSeatWidth(options: {
  request: () => { lastSentWidth: number } | null;
  surface: Ref<HTMLElement | null>;
  settings: Pick<MirrorSettings, "stretchEnabled" | "safeAreaPaddingEnabled">;
  aspect: () => number | undefined;
  send: (aspect: number | undefined) => void;
}): void {
  watch([options.request, options.surface], ([request, surface], _, onCleanup) => {
    if (!request || !surface) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const update = () => {
      cancel();
      if (options.request() !== request) return;
      const aspect = options.aspect();
      const width = streamSeatWidth(aspect);
      if (width === request.lastSentWidth) return;
      request.lastSentWidth = width;
      options.send(aspect);
    };
    const stopSettings = watch(
      [() => options.settings.stretchEnabled, () => options.settings.safeAreaPaddingEnabled],
      update, { flush: "sync" }
    );
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      cancel();
      timer = setTimeout(update, 400);
    });
    observer?.observe(surface);
    onCleanup(() => {
      stopSettings();
      observer?.disconnect();
      cancel();
    });
  }, { immediate: true, flush: "post" });
}
