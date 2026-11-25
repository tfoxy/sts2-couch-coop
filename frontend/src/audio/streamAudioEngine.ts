import { openAudioTrack, type AudioTrack, type OpenAudioTrackOptions } from "@godot-scene-web/render-stream-client/audio";
import workerUrl from "@godot-scene-web/render-stream-client/audio/runtime/transport.worker.ts?worker&url";
import workletUrl from "@godot-scene-web/render-stream-client/audio/runtime/mixer.worklet.ts?worker&url";
import { hostWebSocketCtor } from "@/tunnel/hostTunnel";
import { createTunnelRenderStreamTransport } from "@/tunnel/renderStreamTransport";
import { browserAudioEnv, createAudioUnlock, type AudioUnlockEnv } from "./audioUnlock";
import type { AudioEngineHandle } from "./mainEngine";

export interface StreamAudioEndpoint {
  url: string;
  resourceBase: string;
  viewToken: string | null;
  token: string;
  webTransport?: { url: string; certificateHashes?: string[] };
}
interface StreamAudioOptions {
  endpoint: StreamAudioEndpoint;
  demandUrl: string;
  onUnavailable?: () => void;
  audioEnv?: AudioUnlockEnv;
  WebSocketCtor?: typeof WebSocket;
  openTrack?: typeof openAudioTrack;
  fetcher?: typeof fetch;
}

/** The viewer owns gesture and visibility; GSW owns playback, gains and PCM carriage. */
export function createStreamAudioEngine(options: StreamAudioOptions): AudioEngineHandle {
  const unlocker = createAudioUnlock(options.audioEnv ?? browserAudioEnv());
  let track: AudioTrack | null = null;
  let demand: WebSocket | null = null;
  let disposed = false, unlocked = false, epoch = 0;
  const hidden = (): boolean => typeof document !== "undefined" && document.visibilityState !== "visible";
  const stop = (): void => {
    epoch++;
    unlocked = false;
    track?.close(); track = null;
    const socket = demand; demand = null;
    socket?.close();
    if (unlocker.context?.state === "running") void unlocker.context.suspend().catch(() => {});
  };
  const unavailable = (generation: number): void => {
    if (disposed || generation !== epoch) return;
    stop(); options.onUnavailable?.();
  };
  return {
    async unlock() {
      if (disposed || hidden()) return false;
      const generation = epoch;
      const context = await unlocker.unlock();
      if (!context || disposed) return false;
      if (generation !== epoch || hidden()) {
        if (context.state === "running") await context.suspend().catch(() => {});
        return true;
      }
      unlocked = true;
      return true;
    },
    start() {
      const context = unlocker.context;
      if (disposed || hidden() || !unlocked || !context || context.state !== "running" || demand) return;
      const generation = ++epoch;
      try {
        const socket = demand = new (options.WebSocketCtor ?? hostWebSocketCtor())(options.demandUrl);
        socket.addEventListener("close", () => unavailable(generation));
        socket.addEventListener("error", () => unavailable(generation));
        socket.addEventListener("message", event => {
          if (disposed || generation !== epoch || track || hidden()) return;
          if (event.data !== '{"kind":"ready"}') { unavailable(generation); return; }
          const endpoint = options.endpoint;
          const tunnel = globalThis.__couchCoopTunnel;
          const fetcher = options.fetcher ?? tunnel?.fetch ?? fetch;
          const audio: OpenAudioTrackOptions = {
            url: endpoint.url, credential: endpoint.token, context: context as AudioContext,
            ...(endpoint.webTransport ? { webTransport: { ...endpoint.webTransport, features: 2 } } : {}),
            ...(tunnel ? { transport: createTunnelRenderStreamTransport(tunnel) } : {}),
            workerUrl, workletUrl,
            fetchAsset: async (hash, policy) => {
              if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid audio asset hash");
              const response = await fetcher(`${endpoint.resourceBase}/resources/sha256/${hash}`, {
                cache: policy.cache, credentials: "omit",
                headers: endpoint.viewToken ? { Authorization: `Bearer ${endpoint.viewToken}` } : {}
              });
              if (!response.ok) throw new Error("Audio asset unavailable");
              return response.arrayBuffer();
            },
            onClose: info => { if (!info.willReconnect) unavailable(generation); }
          };
          try { track = (options.openTrack ?? openAudioTrack)(audio); }
          catch { unavailable(generation); }
        });
      } catch { unavailable(generation); }
    },
    // The app recreates this handle when the seat or its audio credential changes.
    setSeatUrl() { stop(); },
    stop,
    dispose() { if (disposed) return; disposed = true; stop(); unlocker.dispose(); }
  };
}
