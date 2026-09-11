export type PressModality = "unknown" | "touch" | "pointer";

export interface PressModalityTracker {
  current(): PressModality;
  subscribe(listener: (modality: PressModality) => void): () => void;
  dispose(): void;
}

/**
 * Tracks the page's most recent press modality without treating touch-generated pointer events as mouse input.
 * Only the listener that can change the current answer stays armed: touch mode waits for mouse/pen, while pointer
 * mode waits for touch. A modality edge is deliberately only a fact update; consumers decide whether a later
 * scene transition should react to it.
 */
export function createPressModalityTracker(target: EventTarget): PressModalityTracker {
  let modality: PressModality = "unknown";
  let touchListening = false;
  let pointerListening = false;
  const listeners = new Set<(next: PressModality) => void>();

  const setModality = (next: PressModality): void => {
    if (modality === next) return;
    modality = next;
    for (const listener of listeners) listener(next);
  };

  const listenTouch = (): void => {
    if (touchListening) return;
    target.addEventListener("touchstart", onTouchStart, { passive: true });
    touchListening = true;
  };

  const unlistenTouch = (): void => {
    if (!touchListening) return;
    target.removeEventListener("touchstart", onTouchStart);
    touchListening = false;
  };

  const listenPointer = (): void => {
    if (pointerListening) return;
    target.addEventListener("pointerdown", onPointerDown);
    pointerListening = true;
  };

  const unlistenPointer = (): void => {
    if (!pointerListening) return;
    target.removeEventListener("pointerdown", onPointerDown);
    pointerListening = false;
  };

  function onTouchStart(): void {
    setModality("touch");
    unlistenTouch();
    listenPointer();
  }

  function onPointerDown(event: Event): void {
    const pointerType = (event as PointerEvent).pointerType;
    // Browsers commonly synthesize pointerdown after touchstart. It does not represent a modality change.
    if (pointerType !== "mouse" && pointerType !== "pen") return;
    setModality("pointer");
    unlistenPointer();
    listenTouch();
  }

  listenTouch();
  listenPointer();

  return {
    current: () => modality,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      unlistenTouch();
      unlistenPointer();
      listeners.clear();
    }
  };
}

let pageTracker: PressModalityTracker | null = null;

/** Installs the page-lifetime tracker once. Called by main.ts before Vue mounts. */
export function installPagePressModality(target: EventTarget = window): PressModalityTracker {
  pageTracker ??= createPressModalityTracker(target);
  return pageTracker;
}

export function lastPressModality(): PressModality {
  return pageTracker?.current() ?? "unknown";
}

export function onPressModalityChange(listener: (modality: PressModality) => void): () => void {
  return pageTracker?.subscribe(listener) ?? (() => {});
}
