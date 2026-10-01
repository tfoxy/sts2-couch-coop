/** Serialized into a diagnostic browser page. Never used in CPU acceptance windows. */
export async function stepCanvasParityAnimationInPage({ clockMs, steps, stepMs = 1000 / 60 }) {
  if (!Number.isInteger(steps) || steps < 1 || steps > 180 || !Number.isFinite(clockMs)) throw Error("invalid diagnostic animation steps");
  const end = performance.now() + 30000;
  const waitUntil = async predicate => {
    while (!predicate()) {
      if (performance.now() >= end) throw Error("diagnostic animation deadline exceeded");
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  };
  const stats = () => window.__mirrorCanvasStats?.();
  if (!stats() || typeof window.__mirrorSetDiagnosticClock !== "function") throw Error("Canvas diagnostic seams unavailable");
  await waitUntil(() => {
    const d = window.__mirrorRendererDiagnostics?.();
    return d?.ready === true && d.resources?.pending === 0 && d.resources?.failed === 0;
  });
  // Establish one build, then advance only the existing ordinary animation
  // scheduler. Rebuilding at the final clock would hide patch geometry errors.
  await window.__mirrorSetDiagnosticClock(clockMs - steps * stepMs);
  const before = stats(), owner = before.instance.id;
  let lastBefore = before;
  for (let i = 1; i <= steps; i++) {
    lastBefore = stats();
    const tickMs = clockMs - (steps - i) * stepMs;
    window.__mirrorCanvasBenchClock.nowMs = tickMs;
    // animFrames can advance on an older queued callback. `frames` counts
    // presented Canvas frames, including patches whose build identity clock
    // deliberately stays at its previous full build.
    await waitUntil(() => stats().frames > lastBefore.frames);
    if (stats().instance.id !== owner) throw Error("renderer restarted during diagnostic animation");
  }
  const after = stats();
  return { steps, stepMs, clockMs, before, after, finalStepBuilt: after.builds !== lastBefore.builds,
    finalStepReferencePresented: (after.patch.referenceReuse?.presentedFrames ?? 0) >
      (lastBefore.patch.referenceReuse?.presentedFrames ?? 0) };
}
