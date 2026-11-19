export const TUNNEL_LABEL = "couch-tunnel/1";
export const CHUNK_BYTES = 16384;
export const FETCH_BODY_LIMIT = 1024 * 1024;
export type OpenChannel = (label: typeof TUNNEL_LABEL) => Promise<RTCDataChannel>;
export type HeaderPairs = [string, string][];
export interface ResponseHead { s: number; h: HeaderPairs; sp?: string | null }

export function requestPath(url: string): string {
  const parsed = new URL(url, globalThis.location?.href ?? "https://tunnel.invalid/");
  return parsed.pathname + parsed.search;
}

export function frame(opcode: number, payload = new Uint8Array(0), fin = true): Uint8Array<ArrayBuffer> {
  if (payload.byteLength > CHUNK_BYTES) throw new Error("Tunnel frame too large");
  const bytes = new Uint8Array(payload.byteLength + 1);
  bytes[0] = opcode | (fin ? 0x80 : 0);
  bytes.set(payload, 1);
  return bytes;
}

export function decodeFrame(data: unknown) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 1 || data.byteLength > CHUNK_BYTES + 1) {
    throw new Error("Invalid tunnel frame");
  }
  const bytes = new Uint8Array(data);
  const opcode = bytes[0] & 0x7f;
  if (![0, 1, 2, 8].includes(opcode)) throw new Error("Invalid tunnel opcode");
  return { opcode, fin: (bytes[0] & 0x80) !== 0, payload: bytes.subarray(1) };
}

export function responseHead(data: unknown): ResponseHead {
  if (typeof data !== "string") throw new Error("Expected tunnel response JSON");
  const head = JSON.parse(data) as ResponseHead;
  if (!Number.isInteger(head.s) || head.s < 101 || head.s > 599 || !Array.isArray(head.h)
    || head.h.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(v => typeof v !== "string"))
    || (head.sp != null && typeof head.sp !== "string")) throw new Error("Invalid tunnel response");
  return head;
}

// RTCDataChannel has no receive pause API. Fetch responses queue until read; WebSocket messages
// have a separate per-message limit, and callers may also bound the pending inbox.
export class ChannelInbox {
  private queue: (string | ArrayBuffer)[] = [];
  private bytes = 0;
  private error: unknown;
  private wake?: () => void;
  constructor(readonly channel: RTCDataChannel, private readonly byteBudget?: number) {
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", this.message);
    channel.addEventListener("close", this.closed);
    channel.addEventListener("error", this.closed);
  }
  private message = (event: MessageEvent) => {
    if (this.error) return;
    const data = event.data;
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) return this.fail(new Error("Invalid channel message"));
    this.bytes += typeof data === "string" ? data.length * 2 : data.byteLength;
    if (this.byteBudget !== undefined && this.bytes > this.byteBudget) {
      this.fail(new Error("Tunnel receive budget exceeded"));
      this.channel.close();
      return;
    }
    this.queue.push(data);
    this.wake?.();
  };
  private closed = () => this.fail(new Error("Tunnel channel closed"));
  fail(error: unknown) { this.error ??= error; this.wake?.(); }
  async read(): Promise<string | ArrayBuffer> {
    while (!this.queue.length) {
      if (this.error) throw this.error;
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
    const data = this.queue.shift()!;
    this.bytes -= typeof data === "string" ? data.length * 2 : data.byteLength;
    return data;
  }
  dispose() {
    this.channel.removeEventListener("message", this.message);
    this.channel.removeEventListener("close", this.closed);
    this.channel.removeEventListener("error", this.closed);
    this.queue = [];
  }
}

export async function openChannel(open: OpenChannel, signal?: AbortSignal): Promise<RTCDataChannel> {
  signal?.throwIfAborted();
  let aborted = false;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => { aborted = true; reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([open(TUNNEL_LABEL).then(channel => {
      if (aborted) { channel.close(); throw signal?.reason; }
      return channel;
    }), cancelled]);
  } finally { signal?.removeEventListener("abort", abort); }
}

export function waitForChannel(channel: RTCDataChannel, event: "open" | "bufferedamountlow"): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      channel.removeEventListener(event, ready);
      channel.removeEventListener("close", failed);
      channel.removeEventListener("error", failed);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("Tunnel channel closed")); };
    channel.addEventListener(event, ready);
    channel.addEventListener("close", failed);
    channel.addEventListener("error", failed);
    if (channel.readyState === "closed" || channel.readyState === "closing") failed();
    else if (event === "open" ? channel.readyState === "open" : channel.bufferedAmount <= channel.bufferedAmountLowThreshold) ready();
  });
}

export async function send(channel: RTCDataChannel, data: string | Uint8Array<ArrayBuffer>) {
  await waitForChannel(channel, "open");
  channel.bufferedAmountLowThreshold = 4 * CHUNK_BYTES;
  if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) await waitForChannel(channel, "bufferedamountlow");
  channel.send(data as Uint8Array<ArrayBuffer>);
}
