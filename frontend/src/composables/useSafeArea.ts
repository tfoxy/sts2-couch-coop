import { onBeforeUnmount, onMounted, ref, readonly } from "vue";

/** Detect raw device insets independently of the viewer's padding preference. */
export function useSafeArea() {
  const hasSafeArea = ref(false);
  let probe: HTMLDivElement | undefined;
  let observer: ResizeObserver | undefined;
  const listeners: Array<[EventTarget, string]> = [];

  function measure(): void {
    if (!probe) return;
    const style = window.getComputedStyle(probe);
    hasSafeArea.value = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
      .some((value) => Number.parseFloat(value) > 0);
  }

  function listen(target: EventTarget | null | undefined, event: string): void {
    if (!target) return;
    target.addEventListener(event, measure);
    listeners.push([target, event]);
  }

  onMounted(() => {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.dataset.safeAreaProbe = "";
    // Do not use display:none: the padding must participate in layout for ResizeObserver.
    // The border box changes with env() even though the content box stays zero-sized.
    probe.style.cssText = `position:fixed;top:0;left:0;width:0;height:0;border:0;
      box-sizing:content-box;visibility:hidden;pointer-events:none;
      padding:env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
        env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);`;
    document.body.append(probe);
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(probe, { box: "border-box" });
    }
    listen(window, "resize");
    listen(window, "orientationchange");
    listen(window, "pageshow");
    listen(window.visualViewport, "resize");
    listen(window.screen?.orientation, "change");
    listen(document, "fullscreenchange");
    listen(document, "webkitfullscreenchange");
    measure();
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    for (const [target, event] of listeners) target.removeEventListener(event, measure);
    probe?.remove();
    probe = undefined;
  });

  return { hasSafeArea: readonly(hasSafeArea) };
}
