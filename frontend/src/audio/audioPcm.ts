// Pure PCM helpers shared by the main-thread engine, the audio Worker and the AudioWorklet mixer.
import { AUDIO_HEADER_BYTES, AUDIO_LANE_BLOCK_FRAMES, AUDIO_SCHEMA, type AudioFrameKind, type AudioLane } from "./audioWire";

export interface AudioFrameView {
  kind: AudioFrameKind;
  lane: AudioLane;
  streamId: number;
  blockIndex: number;
  frames: number;
  flags: number;
  dueUs: bigint;
  sentUs: bigint;
  /** `dueUs`/`sentUs` as plain µs numbers — safe up to ~285 years of uptime — for bigint-free consumers (a worklet). */
  dueUsNumber: number;
  sentUsNumber: number;
  pcm: Int16Array;
}

const LITTLE_ENDIAN = new Int16Array(new Uint8Array([1, 0]).buffer)[0] === 1;

/**
 * Same wire validation as `decodeAudioFrame` (audioWire.ts), but the PCM is a zero-copy view over `buf`
 * on a little-endian platform (a `subarray`, not a `DataView`-read copy) — the worker/worklet transports
 * handle lane blocks at 2-4x the rate the old main-thread socket handler ever saw. Falls back to a
 * DataView copy on a big-endian host, which decodeAudioFrame always does.
 */
export function decodeAudioFrameView(buf: ArrayBuffer): AudioFrameView {
  if (buf.byteLength < AUDIO_HEADER_BYTES) throw new Error("audio frame too short");
  const d = new DataView(buf);
  if (d.getUint32(0, true) !== 0x55414343 || d.getUint8(4) !== AUDIO_SCHEMA) throw new Error("audio frame magic/version");
  const kind = d.getUint8(5), flags = d.getUint8(6), lane = d.getUint8(7);
  const frames = d.getUint16(16, true);
  if ((kind !== 1 && kind !== 2) || (kind === 1 && lane !== 0) ||
      (kind === 2 && (lane < 1 || lane > 3 || frames !== AUDIO_LANE_BLOCK_FRAMES)) ||
      (flags & ~7) !== 0 || d.getUint16(18, true) !== 0 || frames === 0 ||
      buf.byteLength !== AUDIO_HEADER_BYTES + frames * 4) throw new Error("invalid audio frame");
  const dueUs = d.getBigUint64(20, true), sentUs = d.getBigUint64(28, true);
  const sampleCount = frames * 2;
  let pcm: Int16Array;
  if (LITTLE_ENDIAN) {
    pcm = new Int16Array(buf, AUDIO_HEADER_BYTES, sampleCount);
  } else {
    pcm = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) pcm[i] = d.getInt16(AUDIO_HEADER_BYTES + i * 2, true);
  }
  return {
    kind: kind as AudioFrameKind, lane: lane as AudioLane, streamId: d.getUint32(8, true),
    blockIndex: d.getUint32(12, true), frames, flags, dueUs, sentUs,
    dueUsNumber: Number(dueUs), sentUsNumber: Number(sentUs), pcm
  };
}

/** Interleaved PCM16 to planar Float32 in [-1, 1), the shape an AudioBuffer/AudioWorklet channel wants. */
export function s16ToF32Planar(interleaved: Int16Array, channels: number, frames: number): Float32Array[] {
  const planes: Float32Array[] = [];
  for (let c = 0; c < channels; c++) planes.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    const base = i * channels;
    for (let c = 0; c < channels; c++) planes[c][i] = interleaved[base + c] / 32768;
  }
  return planes;
}

export interface WavPcm16 { rate: number; channels: number; frames: number; interleaved: Int16Array; }

/**
 * Walks RIFF chunks (not just the canonical 44-byte header `AudioService.Wav()` writes) so an unknown
 * chunk before `data` is skipped rather than misread. Rejects anything that is not 16-bit integer PCM.
 */
export function parseWavPcm16(buf: ArrayBuffer): WavPcm16 {
  if (buf.byteLength < 12) throw new Error("wav too short");
  const d = new DataView(buf);
  const fourcc = (offset: number): string =>
    String.fromCharCode(d.getUint8(offset), d.getUint8(offset + 1), d.getUint8(offset + 2), d.getUint8(offset + 3));
  if (fourcc(0) !== "RIFF" || fourcc(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let offset = 12;
  let rate = 0, channels = 0, bitsPerSample = 0, audioFormat = 0;
  let dataOffset = -1, dataLength = 0;
  while (offset + 8 <= buf.byteLength) {
    const id = fourcc(offset);
    const size = d.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > buf.byteLength) throw new Error("wav chunk overruns buffer");
    if (id === "fmt ") {
      if (size < 16) throw new Error("wav fmt chunk too short");
      audioFormat = d.getUint16(body, true);
      channels = d.getUint16(body + 2, true);
      rate = d.getUint32(body + 4, true);
      bitsPerSample = d.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOffset = body; dataLength = size;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (audioFormat !== 1 || bitsPerSample !== 16) throw new Error("wav is not PCM16");
  if (channels < 1 || rate < 1) throw new Error("invalid wav fmt chunk");
  if (dataOffset < 0) throw new Error("wav has no data chunk");
  const sampleCount = Math.floor(dataLength / 2);
  const frames = Math.floor(sampleCount / channels);
  const interleaved = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) interleaved[i] = d.getInt16(dataOffset + i * 2, true);
  return { rate, channels, frames, interleaved };
}

/** Concatenates PCM16 blocks (e.g. a finished take's frames) into one buffer, in order. */
export function joinS16(blocks: Int16Array[]): Int16Array {
  let total = 0;
  for (const block of blocks) total += block.length;
  const joined = new Int16Array(total);
  let offset = 0;
  for (const block of blocks) { joined.set(block, offset); offset += block.length; }
  return joined;
}
