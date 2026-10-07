export interface KeepAliveState { voices: number; activeLanes: number; }
export function shouldKeepAlive(state: KeepAliveState): boolean { return state.voices === 0 && state.activeLanes === 0; }

export interface KeepAliveHandle { update(): void; dispose(): void; }
export function createKeepAlive(context: AudioContext, isSilent: () => boolean): KeepAliveHandle {
  const gain = context.createGain(); gain.gain.value = 1; gain.connect(context.destination);
  let source: ConstantSourceNode | null = null;
  let stopped = false;
  const update = (): void => {
    if (stopped) return;
    const wanted = isSilent();
    if (wanted && !source) { source = context.createConstantSource(); source.offset.value = 1e-5; source.connect(gain); source.start(); }
    else if (!wanted && source) { try { source.stop(); } catch { /* already stopped */ } source.disconnect(); source = null; }
  };
  update();
  return {
    update,
    dispose() { stopped = true; if (source) { try { source.stop(); } catch { /* noop */ } source.disconnect(); } gain.disconnect(); }
  };
}
