import { decodeAudioFrame, type RenderInbound, type RenderOutbound } from "./audioWire";

export interface RenderLaneHandle { request(message: RenderInbound): void; probeClock(): void; close(): void; }
export function openRenderLane(url: string, onFrame: (frame: ReturnType<typeof decodeAudioFrame>) => void,
  onMessage: (message: RenderOutbound) => void, WebSocketCtor: typeof WebSocket = WebSocket,
  onUnavailable?: () => void): RenderLaneHandle {
  const socket = new WebSocketCtor(url); socket.binaryType = "arraybuffer";
  const queue: RenderInbound[] = [];
  let closed = false;
  let clockSeq = 0;
  const flush = (): void => {
    if (closed || socket.readyState !== WebSocketCtor.OPEN) return;
    for (const message of queue.splice(0)) socket.send(JSON.stringify(message));
  };
  const probeClock = (): void => {
    if (!closed) request({ kind: "clock", seq: ++clockSeq, clientPerfMs: performance.now() });
  };
  socket.addEventListener("open", () => {
    flush();
    for (let i = 0; i < 8; i++) probeClock();
  });
  socket.addEventListener("error", () => { if (!closed) onUnavailable?.(); });
  socket.addEventListener("close", () => { if (!closed) onUnavailable?.(); });
  socket.addEventListener("message", event => {
    if (closed) return;
    if (event.data instanceof ArrayBuffer) { try { onFrame(decodeAudioFrame(event.data)); } catch { /* malformed frame */ } return; }
    if (typeof event.data === "string" && event.data.length <= 4096) {
      try { onMessage(JSON.parse(event.data) as RenderOutbound); } catch { /* malformed control message */ }
    }
  });
  const request = (message: RenderInbound): void => {
      if (closed) return;
      if (message.kind === "lanes") {
        const index = queue.findIndex(item => item.kind === "lanes");
        if (index >= 0) queue[index] = message;
        else queue.unshift(message);
      } else {
        queue.push(message);
        if (queue.length > 128) {
          let index = queue.findIndex(item => item.kind === "play");
          if (index < 0) index = queue.findIndex(item => item.kind === "clock");
          queue.splice(index < 0 ? queue.length - 1 : index, 1);
        }
      }
      flush();
  };
  return {
    request,
    probeClock,
    close() { closed = true; queue.length = 0; try { socket.close(); } catch { /* noop */ } }
  };
}
