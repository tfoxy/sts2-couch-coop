import {
  ChannelInbox, CHUNK_BYTES, decodeFrame, frame, openChannel, requestPath,
  responseHead, send, type OpenChannel
} from "./framing";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class TunnelWebSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readonly extensions = "";
  protocol = "";
  binaryType: BinaryType = "blob";
  readyState: WebSocket["readyState"] = TunnelWebSocket.CONNECTING;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  private channel?: RTCDataChannel;
  private inbox?: ChannelInbox;
  private stop = new AbortController();
  private outgoing: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  get bufferedAmount() { return this.queuedBytes + (this.channel?.bufferedAmount ?? 0); }

  constructor(url: string | URL, protocols?: string | string[], open?: OpenChannel) {
    super();
    if (!open) throw new TypeError("Use createTunnelWebSocketCtor to bind a channel opener");
    const parsed = new URL(url, globalThis.location?.href ?? "https://tunnel.invalid/");
    if (!["ws:", "wss:", "http:", "https:"].includes(parsed.protocol) || parsed.hash) throw new DOMException("Invalid WebSocket URL", "SyntaxError");
    this.url = parsed.href;
    const offered = typeof protocols === "string" ? [protocols] : [...(protocols ?? [])];
    if (new Set(offered).size !== offered.length || offered.some(p => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(p))) {
      throw new DOMException("Invalid WebSocket protocols", "SyntaxError");
    }
    this.addEventListener("open", event => this.onopen?.call(this, event));
    this.addEventListener("message", event => this.onmessage?.call(this, event));
    this.addEventListener("close", event => this.onclose?.call(this, event));
    this.addEventListener("error", event => this.onerror?.call(this, event));
    void this.connect(open, offered);
  }

  override addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (this: WebSocket, ev: WebSocketEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type, listener, options);
  }
  override removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (this: WebSocket, ev: WebSocketEventMap[K]) => unknown, options?: boolean | EventListenerOptions): void;
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    super.removeEventListener(type, listener, options);
  }

  private async connect(open: OpenChannel, offered: string[]) {
    try {
      const channel = await openChannel(open, this.stop.signal);
      this.channel = channel;
      this.inbox = new ChannelInbox(channel, 4 * 1024 * 1024);
      await send(channel, JSON.stringify({ v: 1, t: "ws", m: "GET", p: requestPath(this.url), h: [], sp: offered }));
      const head = responseHead(await this.inbox.read());
      if (head.s !== 101 || (head.sp && !offered.includes(head.sp))) throw new Error("WebSocket upgrade refused");
      this.protocol = head.sp ?? "";
      this.readyState = this.OPEN;
      this.dispatchEvent(new Event("open"));
      let opcode = 0;
      let chunks: Uint8Array[] = [];
      let size = 0;
      while (!this.stop.signal.aborted) {
        const part = decodeFrame(await this.inbox.read());
        if (part.opcode === 8) {
          if (!part.fin || part.payload.length === 1 || part.payload.length > 125) throw new Error("Invalid close frame");
          const code = part.payload.length ? new DataView(part.payload.buffer, part.payload.byteOffset).getUint16(0) : 1005;
          const reason = part.payload.length ? decoder.decode(part.payload.subarray(2)) : "";
          this.finish(code, reason, true);
          return;
        }
        if (part.opcode === 0 ? opcode === 0 : opcode !== 0) throw new Error("Invalid WebSocket continuation");
        if (part.opcode !== 0) opcode = part.opcode;
        size += part.payload.length;
        if (size > 4 * 1024 * 1024) { this.finish(1009, "Message too large", false); return; }
        chunks.push(part.payload);
        if (!part.fin) continue;
        const message = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { message.set(chunk, offset); offset += chunk.length; }
        const data = opcode === 1 ? decoder.decode(message) : this.binaryType === "arraybuffer" ? message.buffer : new Blob([message]);
        opcode = 0; chunks = []; size = 0;
        if (this.readyState === this.OPEN) this.dispatchEvent(new MessageEvent("message", { data, origin: new URL(this.url).origin }));
      }
    } catch {
      if (this.readyState !== this.CLOSED) this.fail();
    }
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView<ArrayBuffer>) {
    if (this.readyState === this.CONNECTING) throw new DOMException("WebSocket is connecting", "InvalidStateError");
    if (this.readyState !== this.OPEN) return;
    const text = typeof data === "string";
    // Snapshot mutable buffers at send(), while Blob conversion remains ordered with later sends.
    const value = text ? encoder.encode(data) : data instanceof Blob ? data : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data).slice();
    const size = value instanceof Blob ? value.size : value.byteLength;
    this.queuedBytes += size;
    this.outgoing = this.outgoing.then(async () => {
      const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value;
      for (let offset = 0; offset < bytes.length || offset === 0; offset += CHUNK_BYTES) {
        await send(this.channel!, frame(offset === 0 ? text ? 1 : 2 : 0, bytes.subarray(offset, offset + CHUNK_BYTES), offset + CHUNK_BYTES >= bytes.length));
        this.queuedBytes -= Math.min(CHUNK_BYTES, bytes.length - offset);
      }
    }).catch(() => { if (this.readyState !== this.CLOSED) this.fail(); });
  }

  close(code?: number, reason = "") {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999 || !Number.isInteger(code))) {
      throw new DOMException("Invalid close code", "InvalidAccessError");
    }
    const text = encoder.encode(reason);
    if (text.length > 123) throw new DOMException("Close reason too long", "SyntaxError");
    if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
    if (this.readyState === this.CONNECTING) { this.fail(); return; }
    this.readyState = this.CLOSING;
    const payload = code === undefined && !reason ? new Uint8Array(0) : new Uint8Array(text.length + 2);
    if (payload.length) { new DataView(payload.buffer).setUint16(0, code ?? 1000); payload.set(text, 2); }
    this.outgoing = this.outgoing.then(() => send(this.channel!, frame(8, payload))).catch(() => this.fail());
  }

  private fail() {
    if (this.readyState === this.CLOSED) return;
    this.dispatchEvent(new Event("error"));
    this.finish(1006, "", false);
  }
  private finish(code: number, reason: string, wasClean: boolean) {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.stop.abort();
    this.inbox?.fail(new Error("WebSocket closed"));
    this.inbox?.dispose();
    this.channel?.close();
    this.queuedBytes = 0;
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
  }
}

export function createTunnelWebSocketCtor(open: OpenChannel): typeof WebSocket {
  return class extends TunnelWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols, open); }
  };
}
