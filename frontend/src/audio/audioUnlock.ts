export interface AudioContextLike {
  state: string; currentTime: number; destination: AudioNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  resume(): Promise<void>; suspend(): Promise<void>; close(): Promise<void>;
  getOutputTimestamp?: () => { contextTime: number; performanceTime: number };
}
export interface AudioUnlockEnv {
  createContext: () => AudioContextLike;
  createPrelude: () => HTMLAudioElement;
}

function silentPrelude(): Blob {
  const frames = 14_400; // 300 ms at 48 kHz, the prelude length measured on the Moto G31.
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const fourcc = (offset: number, value: string): void => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  fourcc(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); fourcc(8, "WAVE");
  fourcc(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true); view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  fourcc(36, "data"); view.setUint32(40, frames * 2, true);
  return new Blob([bytes], { type: "audio/wav" });
}

export function browserAudioEnv(win: Window = window): AudioUnlockEnv {
  return {
    createContext: () => {
      const Ctor = globalThis.AudioContext ??
        (win as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error("unsupported");
      return new Ctor({ latencyHint: "interactive" }) as unknown as AudioContextLike;
    },
    createPrelude: () => {
      const audio = win.document.createElement("audio");
      audio.setAttribute("playsinline", ""); audio.preload = "auto";
      audio.src = URL.createObjectURL(silentPrelude());
      win.document.body.appendChild(audio);
      return audio;
    }
  };
}

export interface AudioUnlockHandle { context: AudioContextLike | null; supported: boolean; unlock(): Promise<AudioContextLike | null>; dispose(): void; }

async function playPrelude(env: AudioUnlockEnv): Promise<void> {
  const prelude = env.createPrelude();
  try {
    if (typeof prelude.addEventListener !== "function") { await prelude.play(); return; }
    await new Promise<void>((resolve, reject) => {
      const done = (): void => { cleanup(); resolve(); };
      const failed = (): void => { cleanup(); reject(new Error("audio prelude failed")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("audio prelude timed out")); }, 2_000);
      const cleanup = (): void => {
        clearTimeout(timer);
        prelude.removeEventListener("ended", done);
        prelude.removeEventListener("error", failed);
      };
      prelude.addEventListener("ended", done, { once: true });
      prelude.addEventListener("error", failed, { once: true });
      try { void prelude.play().catch(error => { cleanup(); reject(error); }); }
      catch (error) { cleanup(); reject(error); }
    });
  } finally {
    prelude.pause();
    const source = prelude.src;
    prelude.removeAttribute("src");
    prelude.remove?.();
    if (typeof source === "string" && source.startsWith("blob:")) URL.revokeObjectURL(source);
  }
}

/** Run from a user gesture. The silent media prelude primes mobile output before the WebAudio context. */
export function createAudioUnlock(env: AudioUnlockEnv): AudioUnlockHandle {
  let context: AudioContextLike | null = null;
  let disposed = false;
  const supported = true;
  return {
    get context() { return context; }, supported,
    async unlock() {
      if (disposed) return null;
      try {
        if (!context) {
          await playPrelude(env);
          if (disposed) return null;
          context = env.createContext();
        } else if (context.getOutputTimestamp) {
          const leadMs = outputLeadMs(context);
          if (leadMs !== null && leadMs > 60) {
            await context.close(); context = null;
            if (disposed) return null;
            await playPrelude(env);
            if (disposed) return null;
            context = env.createContext();
          }
        }
        const active = context;
        if (active.state !== "running") await active.resume();
        if (disposed || context !== active) {
          if (context === active) context = null;
          await active.close().catch(() => {});
          return null;
        }
        return active.state === "running" ? active : null;
      } catch { return null; }
    },
    dispose() { disposed = true; if (context) void context.close(); context = null; }
  };
}
import { outputLeadMs } from "./fastTrackProbe";
