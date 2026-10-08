// Wire-frame and WAV builders shared by the worker-transport specs (WP-A).
import { AUDIO_HEADER_BYTES } from "../audioWire";

export interface FrameSpec {
  kind: 1 | 2; lane: number; streamId?: number; blockIndex?: number; flags?: number;
  dueUs?: bigint; sentUs?: bigint; frames?: number; sample?: (i: number) => number;
}

/** A schema-1 audio frame: header + interleaved stereo PCM16. Lane frames are always 512 frames. */
export function audioFrame(spec: FrameSpec): ArrayBuffer {
  const frames = spec.kind === 2 ? 512 : spec.frames ?? 2;
  const bytes = new Uint8Array(AUDIO_HEADER_BYTES + frames * 4), d = new DataView(bytes.buffer);
  d.setUint32(0, 0x55414343, true); d.setUint8(4, 1); d.setUint8(5, spec.kind); d.setUint8(6, spec.flags ?? 0); d.setUint8(7, spec.lane);
  d.setUint32(8, spec.streamId ?? 0, true); d.setUint32(12, spec.blockIndex ?? 0, true); d.setUint16(16, frames, true);
  d.setBigUint64(20, spec.dueUs ?? 1_000_000n, true); d.setBigUint64(28, spec.sentUs ?? 1_001_000n, true);
  for (let i = 0; i < frames * 2; i++) d.setInt16(AUDIO_HEADER_BYTES + i * 2, spec.sample?.(i) ?? 0, true);
  return bytes.buffer;
}

export const takeFrame = (streamId: number, blockIndex: number, flags: number, samples = [1000, -1000, 2000, -2000]): ArrayBuffer =>
  audioFrame({ kind: 1, lane: 0, streamId, blockIndex, flags, frames: samples.length / 2, sample: i => samples[i] });

/** Lane blocks `blockIndex` on a contiguous 512-frame/48 kHz due-time grid. */
export const laneFrame = (lane: number, blockIndex: number, flags = 0, streamId = 1): ArrayBuffer =>
  audioFrame({ kind: 2, lane, streamId, blockIndex, flags, dueUs: 1_000_000n + BigInt(Math.round(blockIndex * 512 / 48_000 * 1e6)),
    sample: i => (i % 2 ? -1 : 1) * (blockIndex + 1) * 100 });

/** A canonical 44-byte-header PCM16 WAV. */
export function wav(interleaved: number[], channels = 2, rate = 48_000): ArrayBuffer {
  const bytes = new Uint8Array(44 + interleaved.length * 2), d = new DataView(bytes.buffer);
  const fourcc = (offset: number, value: string): void => { for (let i = 0; i < 4; i++) d.setUint8(offset + i, value.charCodeAt(i)); };
  fourcc(0, "RIFF"); d.setUint32(4, bytes.length - 8, true); fourcc(8, "WAVE");
  fourcc(12, "fmt "); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, channels, true);
  d.setUint32(24, rate, true); d.setUint32(28, rate * channels * 2, true); d.setUint16(32, channels * 2, true); d.setUint16(34, 16, true);
  fourcc(36, "data"); d.setUint32(40, interleaved.length * 2, true);
  interleaved.forEach((value, i) => d.setInt16(44 + i * 2, value, true));
  return bytes.buffer;
}

export const settle = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0));
};
