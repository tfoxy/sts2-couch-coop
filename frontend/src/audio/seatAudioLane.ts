import type { SeatAudioEvent } from "./audioWire";

export interface SeatLaneHandle { close(): void; }
export function openSeatAudioLane(url: string, onEvent: (event: SeatAudioEvent) => void,
  WebSocketCtor: typeof WebSocket = WebSocket): SeatLaneHandle {
  const socket = new WebSocketCtor(url);
  socket.addEventListener("message", event => {
    if (typeof event.data !== "string" || event.data.length > 4096) return;
    try {
      const value = JSON.parse(event.data) as SeatAudioEvent;
      if (value && ["sfx", "tmpsfx", "loop", "volumes"].includes(value.kind)) onEvent(value);
    } catch { /* ignore malformed lane input */ }
  });
  return { close() { try { socket.close(); } catch { /* noop */ } } };
}
