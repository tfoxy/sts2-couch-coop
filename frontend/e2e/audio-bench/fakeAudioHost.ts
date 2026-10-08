// A minimal, hand-rolled Node stand-in for the mod's hosted audio endpoints (AudioRenderLaneConnection,
// SeatAudioLaneConnection, AudioHttpRoutes). It exists ONLY for the local Chromium latency bench in this
// directory — it is not a fixture for product tests, and it never touches a real game or a live install.
//
// WHY HAND-ROLLED FRAMING. `ws` is not in frontend/node_modules (checked before writing this), and the repo
// prefers no new dependency for a bench-only tool. RFC 6455 framing for the handful of message shapes this
// bench needs (one short text frame at a time from the client, short text + binary frames from the server)
// is a few dozen lines; see `encodeFrame`/`WsPeer` below.
//
// WIRE FIDELITY. The binary frame layout matches `audioWire.ts` / `CouchCoop.MirrorProtocol.Audio.AudioFrame`
// byte-for-byte (36-byte LE header, magic "CCAU", version 1 — see AudioFrame.cs), and every JSON control
// message matches a record in `CouchCoop.MirrorProtocol.Envelopes.AudioMessages` serialized with
// System.Text.Json's Web (camelCase) defaults. The one deliberate simplification: `t`/`dueUs`/`sentUs` here
// come from this process's own monotonic clock (an arbitrary epoch, like `Stopwatch.GetTimestamp`), not a
// real FMOD/game clock — exactly how the real host's values work from the client's point of view too.

import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SCHEMA = 1;
const BANKSET = "bench";
const SAMPLE_RATE = 48_000;
const LANE_BLOCK_FRAMES = 512;
const HEADER_BYTES = 36;
const LANE_TICK_MS = (LANE_BLOCK_FRAMES / SAMPLE_RATE) * 1000; // 10.6667ms, matches the real 512/48000 cadence
const LANE_FREQ_HZ: Record<number, number> = { 1: 220, 2: 330, 3: 440 }; // music, ambience, loops

// ---- monotonic microsecond clock (arbitrary epoch; only deltas and the explicit clock exchange matter) ----
const originNs = process.hrtime.bigint();
function nowUs(): bigint {
  return (process.hrtime.bigint() - originNs) / 1_000n;
}

function keyIdFor(index: number): string {
  return index.toString(16).padStart(32, "0");
}
function freqForKey(keyId: string): number {
  const n = Number.parseInt(keyId.slice(-4), 16);
  return 300 + (n % 20) * 40; // 300-1100 Hz, stable per key
}

function sineBlockS16(freqHz: number, startFrame: number, frames: number, amplitude = 0.2): Int16Array {
  const out = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = (startFrame + i) / SAMPLE_RATE;
    const v = Math.max(-1, Math.min(1, Math.sin(2 * Math.PI * freqHz * t))) * amplitude * 32767;
    out[i * 2] = v; out[i * 2 + 1] = v;
  }
  return out;
}

function wavBytesForTone(freqHz: number, durationSec: number): Buffer {
  const frames = Math.round(durationSec * SAMPLE_RATE);
  const pcm = sineBlockS16(freqHz, 0, frames);
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii"); buf.writeUInt32LE(36 + dataBytes, 4); buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii"); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24); buf.writeUInt32LE(SAMPLE_RATE * 2 * 2, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii"); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

function encodeAudioFrame(kind: 1 | 2, lane: 0 | 1 | 2 | 3, streamId: number, blockIndex: number,
  frames: number, flags: number, dueUs: bigint, sentUs: bigint, pcm: Int16Array): Buffer {
  const buf = Buffer.alloc(HEADER_BYTES + pcm.length * 2);
  buf.write("CCAU", 0, "ascii");
  buf.writeUInt8(1, 4); buf.writeUInt8(kind, 5); buf.writeUInt8(flags, 6); buf.writeUInt8(lane, 7);
  buf.writeUInt32LE(streamId >>> 0, 8); buf.writeUInt32LE(blockIndex >>> 0, 12);
  buf.writeUInt16LE(frames, 16); buf.writeUInt16LE(0, 18);
  buf.writeBigUInt64LE(dueUs, 20); buf.writeBigUInt64LE(sentUs, 28);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], HEADER_BYTES + i * 2);
  return buf;
}

// ---- minimal RFC 6455 framing: server frames unmasked (required — Chromium rejects a masked server
// frame), client frames masked (unmasked on receipt). Single-frame messages only: the small JSON/clock
// controls this bench's client side sends never fragment in practice. ----
function acceptKeyFor(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65_536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

class WsPeer {
  private pending = Buffer.alloc(0);
  closed = false;
  onText: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;
  constructor(private readonly socket: Socket) {
    socket.on("data", chunk => this.onData(chunk));
    socket.on("close", () => { this.closed = true; this.onClose?.(); });
    socket.on("error", () => { this.closed = true; });
  }
  private onData(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      if (this.pending.length < 2) return;
      const b0 = this.pending[0], b1 = this.pending[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (this.pending.length < 4) return; len = this.pending.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.pending.length < 10) return; len = Number(this.pending.readBigUInt64BE(2)); offset = 10; }
      const maskLen = masked ? 4 : 0;
      if (this.pending.length < offset + maskLen + len) return;
      const rawPayload = this.pending.subarray(offset + maskLen, offset + maskLen + len);
      let payload = rawPayload;
      if (masked) {
        const mask = this.pending.subarray(offset, offset + 4);
        payload = Buffer.alloc(len);
        for (let i = 0; i < len; i++) payload[i] = rawPayload[i] ^ mask[i % 4];
      }
      this.pending = this.pending.subarray(offset + maskLen + len);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x1) this.onText?.(payload.toString("utf8"));
      // binary/ping/pong from the client are never sent by this bench's page; ignore defensively.
    }
  }
  sendText(text: string): void { if (!this.closed) try { this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8"))); } catch { /* torn down */ } }
  sendBinary(buf: Buffer): void { if (!this.closed) try { this.socket.write(encodeFrame(0x2, buf)); } catch { /* torn down */ } }
  close(): void { if (this.closed) return; this.closed = true; try { this.socket.end(); } catch { /* already gone */ } this.onClose?.(); }
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

export interface SeatCueLogEntry { index: number; keyId: string; sentUs: string; warmup: boolean; }
export interface LaneBlockLogEntry { lane: number; blockIndex: number; dueUs: string; sentUs: string; }

interface HostState {
  warmKeys: string[];
  coldKeys: string[];
  takeBytes: Map<string, Buffer>;
  seatCueLog: SeatCueLogEntry[];
  laneBlockLog: LaneBlockLogEntry[];
  cueCount: number;
  minGapMs: number;
  maxGapMs: number;
  sockets: Set<Socket>;
}

async function deliverTake(peer: WsPeer, host: HostState, keyId: string, streamId: number): Promise<void> {
  const cold = !host.takeBytes.has(keyId);
  const freq = freqForKey(keyId);
  const durationSec = 0.4;
  if (cold) {
    peer.sendText(JSON.stringify({ kind: "take-start", keyId, streamId }));
    const totalFrames = Math.round(durationSec * SAMPLE_RATE);
    const dueBase = nowUs() + 100_000n;
    let sentFrames = 0, blockIndex = 0;
    const pcmAll = sineBlockS16(freq, 0, totalFrames);
    while (sentFrames < totalFrames) {
      const n = Math.min(LANE_BLOCK_FRAMES, totalFrames - sentFrames);
      const block = pcmAll.subarray(sentFrames * 2, (sentFrames + n) * 2);
      const dueUs = dueBase + BigInt(Math.round((blockIndex * LANE_BLOCK_FRAMES * 1_000_000) / SAMPLE_RATE));
      const last = sentFrames + n >= totalFrames;
      const flags = (blockIndex === 0 ? 1 : 0) | (last ? 2 : 0);
      peer.sendBinary(encodeAudioFrame(1, 0, streamId, blockIndex, n, flags, dueUs, nowUs(), block));
      sentFrames += n; blockIndex++;
      if (!last) await delay(LANE_TICK_MS);
    }
    host.takeBytes.set(keyId, wavBytesForTone(freq, durationSec));
  }
  const url = `/audio/take/${SCHEMA}/${BANKSET}/${keyId}.wav`;
  peer.sendText(JSON.stringify({ kind: "take-ready", keyId, streamId, url }));
}

function handleRenderLane(peer: WsPeer, host: HostState): void {
  const laneEnabled: Record<number, boolean> = { 1: false, 2: false, 3: false };
  const laneBlockIndex: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  let takeStreamCounter = 0;
  let laneTimer: ReturnType<typeof setTimeout> | null = null;
  let tickCount = 0;
  const scheduleStart = process.hrtime.bigint();

  const sendClock = (hostUs: bigint, seq: number | null, clientPerfMs: number | null): void => {
    const sentUs = nowUs();
    peer.sendText(JSON.stringify({
      kind: "clock", hostUs: Number(hostUs), sentUs: Number(sentUs),
      ...(seq !== null ? { seq } : {}), ...(clientPerfMs !== null ? { clientPerfMs } : {})
    }));
  };
  peer.sendText(JSON.stringify({ kind: "hello", schema: SCHEMA, bankset: BANKSET, sampleRate: SAMPLE_RATE, laneBlockFrames: LANE_BLOCK_FRAMES }));
  for (let i = 0; i < 8; i++) sendClock(nowUs(), null, null);

  const laneTick = (): void => {
    for (const laneKey of [1, 2, 3] as const) {
      if (!laneEnabled[laneKey]) continue;
      const blockIndex = laneBlockIndex[laneKey]++;
      const dueUs = nowUs() + 11_000n;
      const pcm = sineBlockS16(LANE_FREQ_HZ[laneKey], blockIndex * LANE_BLOCK_FRAMES, LANE_BLOCK_FRAMES, 0.05);
      const flags = blockIndex === 0 ? 1 : 0;
      peer.sendBinary(encodeAudioFrame(2, laneKey as 1 | 2 | 3, laneKey, blockIndex, LANE_BLOCK_FRAMES, flags, dueUs, nowUs(), pcm));
      if (blockIndex % 16 === 0) host.laneBlockLog.push({ lane: laneKey, blockIndex, dueUs: dueUs.toString(), sentUs: nowUs().toString() });
    }
    tickCount++;
    const idealNs = scheduleStart + BigInt(Math.round(tickCount * LANE_TICK_MS * 1_000_000));
    const delayMs = Math.max(0, Number(idealNs - process.hrtime.bigint()) / 1_000_000);
    laneTimer = setTimeout(laneTick, delayMs);
  };
  laneTimer = setTimeout(laneTick, LANE_TICK_MS);

  peer.onText = text => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(text) as Record<string, unknown>; } catch { return; }
    if (message.kind === "clock") {
      const seq = typeof message.seq === "number" ? message.seq : null;
      const clientPerfMs = typeof message.clientPerfMs === "number" ? message.clientPerfMs : null;
      sendClock(nowUs(), seq, clientPerfMs);
      return;
    }
    if (message.kind === "lanes") {
      laneEnabled[1] = !!message.music; laneEnabled[2] = !!message.ambience; laneEnabled[3] = !!message.loops;
      return;
    }
    if (message.kind === "play" && typeof message.keyId === "string") {
      void deliverTake(peer, host, message.keyId, ++takeStreamCounter);
    }
  };
  peer.onClose = () => { if (laneTimer) clearTimeout(laneTimer); };
}

function sendCue(peer: WsPeer, host: HostState, keyId: string, warmup: boolean): void {
  const index = host.seatCueLog.length;
  const sentUs = nowUs();
  peer.sendText(JSON.stringify({
    kind: "sfx", keyId, key: `event:/sfx/bench_${keyId.slice(-4)}`, t: Number(sentUs), pitch: 1, volume: 1
  }));
  host.seatCueLog.push({ index, keyId, sentUs: sentUs.toString(), warmup });
}

function handleSeatLane(peer: WsPeer, host: HostState): void {
  peer.sendText(JSON.stringify({ kind: "volumes", snapshot: true, master: 1, bgm: 1, sfx: 1, ambience: 1, godotMasterDb: 0, godotSfxDb: 0 }));
  let cancelled = false;
  peer.onClose = () => { cancelled = true; };
  void (async () => {
    for (const keyId of host.coldKeys) {
      if (cancelled) return;
      await delay(500);
      sendCue(peer, host, keyId, true);
    }
    await delay(500);
    for (let i = 0; i < host.cueCount; i++) {
      if (cancelled) return;
      await delay(host.minGapMs + Math.random() * (host.maxGapMs - host.minGapMs));
      const keyId = host.warmKeys[i % host.warmKeys.length];
      // The first lap through the warm pool still pays a one-time decode+fetch (store.get's cold branch);
      // only lap 2+ is the purely-cached steady state the bench's p50/p95 should describe.
      sendCue(peer, host, keyId, i < host.warmKeys.length);
    }
  })();
}

function handleHttp(req: IncomingMessage, res: ServerResponse, host: HostState): void {
  // CORS: the real mod serves its SPA and its /audio/* routes from the SAME origin, so this never comes
  // up in production. This bench deliberately puts the page (Vite dev origin) and the fake host on
  // DIFFERENT origins/ports (see bench.ts's header), so every fetch TakeStore.ts makes is cross-origin —
  // without this header Chromium blocks the response before JS ever sees it (CORS, not a wire bug).
  res.setHeader("Access-Control-Allow-Origin", "*");
  const url = new URL(req.url ?? "/", "http://bench-host");
  if (url.pathname === "/audio/takes") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ schema: SCHEMA, bankset: BANKSET, keys: [...host.takeBytes.keys()] }));
    return;
  }
  const match = /^\/audio\/take\/(\d+)\/([^/]+)\/([0-9a-f]{32})\.wav$/.exec(url.pathname);
  if (match) {
    const [, schema, bankset, keyId] = match;
    const bytes = Number(schema) === SCHEMA && bankset === BANKSET ? host.takeBytes.get(keyId) : undefined;
    if (!bytes) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "public, max-age=31536000, immutable" });
    res.end(bytes);
    return;
  }
  res.writeHead(404); res.end();
}

export interface FakeAudioHostOptions {
  warmKeyCount?: number;
  coldKeyCount?: number;
  cueCount?: number;
  cueGapMs?: readonly [number, number];
}

export interface FakeAudioHostHandle {
  readonly port: number;
  readonly httpOrigin: string;
  readonly seatCueLog: SeatCueLogEntry[];
  readonly laneBlockLog: LaneBlockLogEntry[];
  close(): Promise<void>;
}

export async function startFakeAudioHost(options: FakeAudioHostOptions = {}): Promise<FakeAudioHostHandle> {
  const warmKeys = Array.from({ length: options.warmKeyCount ?? 6 }, (_, i) => keyIdFor(i));
  const coldKeys = Array.from({ length: options.coldKeyCount ?? 2 }, (_, i) => keyIdFor(90 + i));
  const takeBytes = new Map<string, Buffer>();
  for (const keyId of warmKeys) takeBytes.set(keyId, wavBytesForTone(freqForKey(keyId), 0.4));
  const [minGapMs, maxGapMs] = options.cueGapMs ?? [150, 300];
  const host: HostState = {
    warmKeys, coldKeys, takeBytes, seatCueLog: [], laneBlockLog: [],
    cueCount: options.cueCount ?? 220, minGapMs, maxGapMs, sockets: new Set()
  };

  const server = createHttpServer((req, res) => handleHttp(req, res, host));
  server.on("upgrade", (req, socket, _head) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") { socket.destroy(); return; }
    host.sockets.add(socket);
    socket.on("close", () => host.sockets.delete(socket));
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`
    );
    const peer = new WsPeer(socket);
    const url = new URL(req.url ?? "/", "http://bench-host");
    if (url.pathname === "/audio") handleRenderLane(peer, host);
    else if (url.pathname === "/ws" && url.searchParams.get("lane") === "audio") handleSeatLane(peer, host);
    else peer.close();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;

  return {
    port, httpOrigin: `http://127.0.0.1:${port}`,
    seatCueLog: host.seatCueLog, laneBlockLog: host.laneBlockLog,
    async close() {
      for (const socket of host.sockets) { try { socket.destroy(); } catch { /* already gone */ } }
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}
