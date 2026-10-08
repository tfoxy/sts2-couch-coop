import { decodeAudioFrame, type AudioFrame, type RenderInbound, type RenderOutbound } from "./audioWire";
import type { AudioLaneMark } from "./seatAudioLane";

export interface PlayRequestMark { seatTUs: number; requestOrder: number; }
export interface RenderLaneHandle { request(message: RenderInbound, correlation?: PlayRequestMark): void; probeClock(): void; close(): void; }
/**
 * Transport seams for a lane owner off the main thread: a zero-copy frame decoder (`decodeAudioFrameView`)
 * and a clock aligned to the page's `performance.now()` (a Worker's own clock has a different origin, and
 * `clientPerfMs` on a clock probe must be comparable with main-thread marks). Absent, both are today's.
 */
export interface RenderLaneOptions<F extends AudioFrame> {
  decode?: (data: ArrayBuffer) => F;
  now?: () => number;
}
export function openRenderLane<F extends AudioFrame = AudioFrame>(url: string, onFrame: (frame: F, callbackOrder?: number) => void,
  onMessage: (message: RenderOutbound, callbackOrder?: number) => void, WebSocketCtor: typeof WebSocket = WebSocket,
  onUnavailable?: () => void, mark?: AudioLaneMark, connectionId?: number, laneOptions: RenderLaneOptions<F> = {}): RenderLaneHandle {
  const decode = laneOptions.decode ?? (decodeAudioFrame as unknown as (data: ArrayBuffer) => F);
  const now = laneOptions.now ?? (() => performance.now());
  const socket = new WebSocketCtor(url); socket.binaryType = "arraybuffer";
  const queue: RenderInbound[] = [];
  const correlations = mark ? new WeakMap<RenderInbound, PlayRequestMark>() : null;
  let closed = false;
  let clockSeq = 0;
  let callbackOrder = 0;
  const flush = (): void => {
    if (closed || socket.readyState !== WebSocketCtor.OPEN) return;
    for (const message of queue.splice(0)) {
      if (mark && message.kind === "play") mark("play-request-send-start", { connectionId, keyId: message.keyId,
        ...correlations?.get(message) });
      socket.send(JSON.stringify(message));
      if (mark && message.kind === "play") mark("play-request-sent", { connectionId, keyId: message.keyId,
        ...correlations?.get(message) });
    }
  };
  const probeClock = (): void => {
    if (!closed) request({ kind: "clock", seq: ++clockSeq, clientPerfMs: now() });
  };
  socket.addEventListener("open", () => {
    flush();
    for (let i = 0; i < 8; i++) probeClock();
  });
  socket.addEventListener("error", () => { if (!closed) onUnavailable?.(); });
  socket.addEventListener("close", () => { if (!closed) onUnavailable?.(); });
  socket.addEventListener("message", event => {
    if (closed) return;
    const entryMs = mark ? now() : 0;
    const order = mark ? ++callbackOrder : 0;
    const binary = event.data instanceof ArrayBuffer;
    const sampled = !mark || !binary || event.data.byteLength < 16 || (() => {
      const header = new DataView(event.data as ArrayBuffer);
      return header.getUint8(5) !== 2 || header.getUint32(12, true) % 16 === 0;
    })();
    if (mark && sampled) mark("render-callback-entry", { connectionId, callbackOrder: order, performanceMs: entryMs,
      payloadKind: binary ? "frame" : "control" });
    if (binary) {
      try {
        const frame = decode(event.data);
        if (mark && sampled)
          mark("render-frame-decoded", { connectionId, callbackOrder: order, kind: frame.kind,
            lane: frame.lane, streamId: frame.streamId, blockIndex: frame.blockIndex,
            dueUs: frame.dueUs.toString(), sentUs: frame.sentUs.toString() });
        onFrame(frame, order || undefined);
      } catch { /* malformed frame */ }
      return;
    }
    if (typeof event.data === "string" && event.data.length <= 4096) {
      try {
        const message = JSON.parse(event.data) as RenderOutbound;
        if (mark) mark("render-control-parsed", { connectionId, callbackOrder: order, kind: message.kind,
          ...( "keyId" in message ? { keyId: message.keyId } : {}),
          ...( "streamId" in message ? { streamId: message.streamId } : {}) });
        onMessage(message, order || undefined);
      } catch { /* malformed control message */ }
    }
  });
  const request = (message: RenderInbound, correlation?: PlayRequestMark): void => {
      if (closed) return;
      if (mark && message.kind === "play") {
        if (correlation) correlations?.set(message, correlation);
        mark("play-request-enqueued", { connectionId, keyId: message.keyId, ...correlation });
      }
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
