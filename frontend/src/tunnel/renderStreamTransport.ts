import type { RenderStreamTransportFactory } from "@godot-scene-web/render-stream-client";
import type { HostTunnel } from "./hostTunnel";

/** Keep stream control and resource reads on the same host tunnel as the rest of the app. */
export function createTunnelRenderStreamTransport(tunnel: HostTunnel): RenderStreamTransportFactory {
  return (endpoint, subprotocol, on) => {
    const socket = new tunnel.WebSocket(endpoint.url, [subprotocol]);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => on.open();
    socket.onmessage = event => on.message(event.data as string | ArrayBuffer);
    socket.onerror = () => {};
    socket.onclose = event => {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      on.close(event.code, event.reason);
    };
    return {
      carrier: "websocket",
      send(text) { if (socket.readyState === tunnel.WebSocket.OPEN) socket.send(text); },
      close(code, reason) {
        socket.onopen = socket.onmessage = null;
        try { socket.close(code, reason); } catch { socket.close(); }
      },
      async fetchResource(path, init) {
        const headers: Record<string, string> = {};
        if (init.token !== null) headers.Authorization = `Bearer ${init.token}`;
        const response = await tunnel.fetch(`${endpoint.resourceBase}${path}`, {
          headers, signal: init.signal, cache: "default", credentials: "omit"
        });
        if (init.stream && response.status === 200 && response.body) {
          return { status: response.status, body: null, stream: response.body,
            sizeHint: Number(response.headers.get("content-length")) || 0 };
        }
        const body = response.status === 200 ? await response.arrayBuffer() : null;
        if (body) init.progress?.();
        return { status: response.status, body };
      }
    };
  };
}
