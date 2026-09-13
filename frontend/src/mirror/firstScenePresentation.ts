/** One receipt per granted view, after a successful render has had a paint opportunity. */
export function createFirstScenePresentation(options: {
  presented: (attemptId: string) => void;
  failed: (attemptId: string, error: unknown) => void;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  visible: () => boolean;
}) {
  let attemptId: string | null = null;
  let rendered = false;
  let completed = false;
  let failed = false;
  let disposed = false;
  let pending: number | null = null;
  let generation = 0;

  function cancel(): void {
    generation++;
    if (pending !== null) options.cancelFrame(pending);
    pending = null;
  }

  function schedule(): void {
    if (disposed || !attemptId || !rendered || completed || failed || pending !== null || !options.visible()) return;
    const expectedGeneration = generation;
    const expectedAttempt = attemptId;
    // Two frames cover both a synchronous mount and a reconcile running inside rAF.
    // This is a paint opportunity, not a browser-specific compositor measurement.
    pending = options.requestFrame(() => {
      if (expectedGeneration !== generation) return;
      pending = null;
      if (!options.visible()) return;
      pending = options.requestFrame(() => {
        if (expectedGeneration !== generation) return;
        pending = null;
        if (!options.visible()) return;
        completed = true;
        options.presented(expectedAttempt);
      });
    });
  }

  return {
    setAttempt(value: string | null): void {
      if (value === attemptId) return;
      cancel();
      attemptId = value;
      rendered = completed = failed = false;
    },
    rendered(): void {
      rendered = true;
      schedule();
    },
    failed(error: unknown): void {
      if (disposed || !attemptId || failed || completed) return;
      cancel();
      failed = true;
      options.failed(attemptId, error);
    },
    visibilityChanged: schedule,
    dispose(): void {
      disposed = true;
      cancel();
    }
  };
}
