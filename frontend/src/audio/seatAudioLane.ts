import type { SeatAudioEvent } from "./audioWire";

export type AudioLaneMark = (type: string, fields: Record<string, unknown>) => void;

export interface SeatLaneHandle { close(): void; }
export function openSeatAudioLane(url: string, onEvent: (event: SeatAudioEvent, callbackOrder?: number) => void,
  WebSocketCtor: typeof WebSocket = WebSocket, mark?: AudioLaneMark, connectionId?: number): SeatLaneHandle {
  const socket = new WebSocketCtor(url);
  let callbackOrder = 0;
  socket.addEventListener("message", event => {
    const order = mark ? ++callbackOrder : 0;
    if (mark) mark("seat-callback-entry", { connectionId, callbackOrder: order });
    if (typeof event.data !== "string" || event.data.length > 4096) return;
    try {
      const value = JSON.parse(event.data) as SeatAudioEvent;
      if (value && ["sfx", "tmpsfx", "loop", "volumes"].includes(value.kind)) {
        if (mark) mark("seat-parse-complete", { connectionId, callbackOrder: order, kind: value.kind,
          ...( "t" in value ? { seatTUs: value.t } : {}),
          ...( "keyId" in value ? { keyId: value.keyId } : {}),
          ...( "resPath" in value ? { resPath: value.resPath } : {}) });
        onEvent(value, order || undefined);
      }
    } catch { /* ignore malformed lane input */ }
  });
  return { close() { try { socket.close(); } catch { /* noop */ } } };
}
