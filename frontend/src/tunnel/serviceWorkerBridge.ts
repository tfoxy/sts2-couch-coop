import { CHUNK_BYTES, FETCH_BODY_LIMIT } from "./framing";
import type { TunnelFetch } from "./tunnelFetch";

interface BridgeRequest { id: number; method: string; url: string; headers: [string, string][]; body?: ArrayBuffer }
interface Pending {
  abort: AbortController;
  credit: number;
  wake?: () => void;
}
export interface ServiceWorkerBridge {
  tab: string;
  prefix: string;
  ready: Promise<void>;
  stop(): void;
}

export function startServiceWorkerBridge(tunnelFetch: TunnelFetch): ServiceWorkerBridge {
  const sw = navigator.serviceWorker;
  if (!sw) throw new Error("Service workers unavailable");
  const tab = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const ports = new Map<MessagePort, Map<number, Pending>>();
  let stopped = false;
  let registeredWorker: ServiceWorker | null = null;
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });

  async function answer(port: MessagePort, requests: Map<number, Pending>, message: BridgeRequest) {
    const state: Pending = { abort: new AbortController(), credit: 8 };
    requests.set(message.id, state);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    state.abort.signal.addEventListener("abort", () => {
      void reader?.cancel().catch(() => {});
      state.wake?.();
    }, { once: true });
    try {
      if (!message.url.startsWith("/") || message.url.startsWith("//")) throw new Error("Invalid tunnel path");
      const request = new Request(new URL(message.url, "https://tunnel.invalid"), {
        method: message.method, headers: message.headers, body: message.body, signal: state.abort.signal
      });
      if (message.body && message.body.byteLength > FETCH_BODY_LIMIT) throw new Error("Tunnel upload too large");
      const response = await tunnelFetch(request);
      reader = response.body?.getReader();
      state.abort.signal.throwIfAborted();
      port.postMessage({ type: "response", id: message.id, status: response.status, headers: [...response.headers] });
      if (reader) {
        while (true) {
          await credit(state);
          const { done, value } = await reader.read();
          if (done) break;
          for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES) {
            await credit(state);
            const chunk = value.slice(offset, offset + CHUNK_BYTES).buffer;
            state.credit--;
            port.postMessage({ type: "chunk", id: message.id, chunk }, [chunk]);
          }
        }
      }
      state.abort.signal.throwIfAborted();
      port.postMessage({ type: "end", id: message.id });
    } catch (error) {
      if (!state.abort.signal.aborted) port.postMessage({ type: "error", id: message.id, message: String(error) });
    } finally {
      requests.delete(message.id);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  async function credit(state: Pending) {
    while (state.credit <= 0 && !state.abort.signal.aborted) {
      await new Promise<void>(resolve => { state.wake = resolve; });
      state.wake = undefined;
    }
    state.abort.signal.throwIfAborted();
  }
  function register(worker: ServiceWorker | null, force = false) {
    if (stopped || !worker || (!force && worker === registeredWorker)) return;
    registeredWorker = worker;
    const { port1, port2 } = new MessageChannel();
    const requests = new Map<number, Pending>();
    ports.set(port1, requests);
    port1.onmessage = event => {
      const message = event.data;
      if (message.type === "registered") { resolveReady(); return; }
      if (message.type === "request") { void answer(port1, requests, message); return; }
      const state = requests.get(message.id);
      if (!state) return;
      if (message.type === "credit") state.credit += message.count;
      if (message.type === "cancel") state.abort.abort();
      state.wake?.();
    };
    port1.start();
    worker.postMessage({ type: "couchcoop-tunnel-register", tab }, [port2]);
  }
  const change = () => register(sw.controller);
  const discover = (event: MessageEvent) => {
    if (event.data?.type === "couchcoop-tunnel-discover" && event.data.tab === tab) register(event.source as ServiceWorker | null, true);
  };
  sw.addEventListener("controllerchange", change);
  sw.addEventListener("message", discover);
  register(sw.controller);
  if (!sw.controller) void sw.ready.then(registration => register(sw.controller ?? registration.active));
  return {
    tab, prefix: `/~h/${tab}/`, ready,
    stop() {
      stopped = true;
      sw.removeEventListener("controllerchange", change);
      sw.removeEventListener("message", discover);
      for (const [port, requests] of ports) {
        port.postMessage({ type: "unregister" });
        for (const state of requests.values()) { state.abort.abort(); state.wake?.(); }
        port.close();
      }
      ports.clear();
    }
  };
}
