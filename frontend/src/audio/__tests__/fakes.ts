// Shared WebAudio/WebSocket/postMessage test doubles for the audio suites. The WebAudio and socket fakes
// were extracted from audioEngine.spec.ts unchanged so the worker/worklet facade specs (WP-A/WP-B) reuse
// the same doubles instead of re-deriving them.

export class Param {
  value = 1;
  setTargetAtTime(value: number): void { this.value = value; }
  setValueAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; }
  cancelScheduledValues(): void {}
}
export class Gain { gain = new Param(); connect(): void {} disconnect(): void {} }
export class Buffer {
  channels: Float32Array[];
  constructor(readonly length: number) { this.channels = [new Float32Array(length), new Float32Array(length)]; }
  getChannelData(channel: number): Float32Array { return this.channels[channel]; }
}
export class Source {
  playbackRate = new Param(); buffer: Buffer | null = null; onended: (() => void) | null = null;
  starts: number[] = []; stopped = false;
  connect(): void {} disconnect(): void {}
  start(at = 0): void { this.starts.push(at); }
  stop(): void { this.stopped = true; this.onended?.(); }
}
export class ConstantSource extends Source { offset = new Param(); }
export class FakeContext {
  state = "suspended"; currentTime = 12; destination = {} as AudioNode; sources: Source[] = []; gains: Gain[] = [];
  createBuffer(_channels: number, length: number): Buffer { return new Buffer(length); }
  createBufferSource(): Source { const source = new Source(); this.sources.push(source); return source; }
  createGain(): Gain { const gain = new Gain(); this.gains.push(gain); return gain; }
  createConstantSource(): ConstantSource { return new ConstantSource(); }
  async decodeAudioData(): Promise<Buffer> { return new Buffer(1); }
  async resume(): Promise<void> { this.state = "running"; }
  async suspend(): Promise<void> { this.state = "suspended"; }
  async close(): Promise<void> { this.state = "closed"; }
}
export class FakeSocket {
  static CONNECTING = 0; static OPEN = 1;
  readyState = 0; binaryType = ""; sent: string[] = [];
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (event: MessageEvent) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  emit(type: string, data?: unknown): void {
    if (type === "open") this.readyState = 1;
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent);
  }
}

type FakeMessageListener = (event: MessageEvent) => void;

/**
 * One side of an in-process `postMessage`-shaped channel: a stand-in for a `Worker`/`MessagePort`
 * endpoint without a real thread. Delivery is async (`queueMicrotask`), matching how postMessage never
 * calls its receiver synchronously, and every send is recorded (with its transfer list) on `sent` so a
 * test can assert what would have been transferred.
 */
export interface FakeWorkerChannel {
  postMessage(data: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: FakeMessageListener): void;
  removeEventListener(type: "message", fn: FakeMessageListener): void;
  onmessage: FakeMessageListener | null;
  readonly sent: Array<{ data: unknown; transfer: Transferable[] }>;
}

interface FakeWorkerEndpoint extends FakeWorkerChannel {
  dispatch(data: unknown): void;
}

function makeEndpoint(deliver: (data: unknown) => void): FakeWorkerEndpoint {
  const listeners = new Set<FakeMessageListener>();
  const sent: Array<{ data: unknown; transfer: Transferable[] }> = [];
  let onmessage: FakeMessageListener | null = null;
  return {
    sent,
    get onmessage() { return onmessage; },
    set onmessage(fn) { onmessage = fn; },
    postMessage(data, transfer = []) {
      sent.push({ data, transfer });
      deliver(data);
    },
    addEventListener(_type, fn) { listeners.add(fn); },
    removeEventListener(_type, fn) { listeners.delete(fn); },
    dispatch(data) {
      queueMicrotask(() => {
        const event = { data } as MessageEvent;
        onmessage?.(event);
        for (const fn of listeners) fn(event);
      });
    }
  };
}

/**
 * Two linked fake endpoints: posting on one asynchronously delivers to the other's `onmessage`/listeners,
 * and vice versa. Usable for both facade<->worker-core and worker-core<->sink wiring in a vitest spec —
 * whichever side of the real `Worker`/`MessagePort` boundary a test needs to stand in for.
 */
export function createFakeWorkerChannelPair(): [FakeWorkerChannel, FakeWorkerChannel] {
  let a!: FakeWorkerEndpoint;
  let b!: FakeWorkerEndpoint;
  a = makeEndpoint(data => b.dispatch(data));
  b = makeEndpoint(data => a.dispatch(data));
  return [a, b];
}
