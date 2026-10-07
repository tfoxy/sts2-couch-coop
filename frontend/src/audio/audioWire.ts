// Audio wire v1. Times are host-monotonic microseconds; use bigint to preserve precision.
export const AUDIO_SCHEMA = 1;
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_LANE_BLOCK_FRAMES = 512;
export const AUDIO_HEADER_BYTES = 36;
export type AudioLane = 0 | 1 | 2 | 3; // take, music, ambience, loops
export type AudioFrameKind = 1 | 2; // take, lane
export const AudioFlags = { First: 1, Last: 2, Silent: 4 } as const;

export interface AudioFrame {
  kind: AudioFrameKind;
  lane: AudioLane;
  streamId: number;
  blockIndex: number;
  frames: number;
  flags: number;
  dueUs: bigint;
  sentUs: bigint;
  pcm: Int16Array;
}

export type SeatAudioEvent =
  | { kind: "sfx"; keyId: string; key: string; t: number; pitch: number; volume: number }
  | { kind: "tmpsfx"; resPath: string; t: number; pitch: number; volume: number }
  | { kind: "loop"; keyId: string; key: string; action: "start" | "stop" | "stop-all"; t: number }
  | { kind: "volumes"; snapshot: boolean; master?: number; bgm?: number; sfx?: number; ambience?: number;
      godotMasterDb?: number | "-Infinity"; godotSfxDb?: number | "-Infinity" };

export type RenderInbound =
  | { kind: "play"; keyId: string; key: string }
  | { kind: "lanes"; music: boolean; ambience: boolean; loops: boolean }
  | { kind: "clock"; seq: number; clientPerfMs: number };

export type RenderOutbound =
  | { kind: "hello"; schema: number; bankset: string; sampleRate: number; laneBlockFrames: number }
  | { kind: "take-start"; keyId: string; streamId: number }
  | { kind: "take-ready"; keyId: string; streamId: number; url: string }
  | { kind: "unavailable"; keyId: string; reason: string }
  | { kind: "clock"; hostUs: number; sentUs: number; seq?: number | null; clientPerfMs?: number | null };

export function isKeyId(value: string): boolean { return /^[0-9a-f]{32}$/.test(value); }

export function decodeAudioFrame(input: ArrayBuffer | Uint8Array): AudioFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < AUDIO_HEADER_BYTES) throw new Error("audio frame too short");
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (d.getUint32(0, true) !== 0x55414343 || d.getUint8(4) !== AUDIO_SCHEMA) throw new Error("audio frame magic/version");
  const kind = d.getUint8(5), flags = d.getUint8(6), lane = d.getUint8(7);
  const frames = d.getUint16(16, true);
  if ((kind !== 1 && kind !== 2) || (kind === 1 && lane !== 0) ||
      (kind === 2 && (lane < 1 || lane > 3 || frames !== AUDIO_LANE_BLOCK_FRAMES)) ||
      (flags & ~7) !== 0 || d.getUint16(18, true) !== 0 || frames === 0 ||
      bytes.byteLength !== AUDIO_HEADER_BYTES + frames * 4) throw new Error("invalid audio frame");
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = d.getInt16(AUDIO_HEADER_BYTES + i * 2, true);
  return { kind: kind as AudioFrameKind, lane: lane as AudioLane, streamId: d.getUint32(8, true),
    blockIndex: d.getUint32(12, true), frames, flags, dueUs: d.getBigUint64(20, true),
    sentUs: d.getBigUint64(28, true), pcm };
}
