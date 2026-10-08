import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeAudioFrame } from "../audioWire";
import { decodeAudioFrameView, joinS16, parseWavPcm16, s16ToF32Planar } from "../audioPcm";

const fixture = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), `../tests/fixtures/audio/${name}`), "utf8"));

function buildWav(pcm: Int16Array, channels: number, rate: number,
  options: { extraChunk?: string; audioFormat?: number } = {}): ArrayBuffer {
  const dataBytes = pcm.length * 2;
  const extraBytes = options.extraChunk ? 12 : 0; // 8-byte chunk header + 4-byte body
  const bytes = new Uint8Array(12 + 24 + extraBytes + 8 + dataBytes);
  const d = new DataView(bytes.buffer);
  const fourcc = (offset: number, value: string): void => { for (let i = 0; i < 4; i++) d.setUint8(offset + i, value.charCodeAt(i)); };
  fourcc(0, "RIFF"); d.setUint32(4, bytes.length - 8, true); fourcc(8, "WAVE");
  let offset = 12;
  fourcc(offset, "fmt "); d.setUint32(offset + 4, 16, true);
  d.setUint16(offset + 8, options.audioFormat ?? 1, true);
  d.setUint16(offset + 10, channels, true);
  d.setUint32(offset + 12, rate, true);
  d.setUint32(offset + 16, rate * channels * 2, true);
  d.setUint16(offset + 20, channels * 2, true);
  d.setUint16(offset + 22, 16, true);
  offset += 24;
  if (options.extraChunk) {
    fourcc(offset, options.extraChunk); d.setUint32(offset + 4, 4, true);
    offset += 12;
  }
  fourcc(offset, "data"); d.setUint32(offset + 4, dataBytes, true);
  offset += 8;
  for (let i = 0; i < pcm.length; i++) d.setInt16(offset + i * 2, pcm[i], true);
  return bytes.buffer;
}

describe("audio pcm helpers", () => {
  it("decodeAudioFrameView matches decodeAudioFrame for the shared golden frame", () => {
    const { frames } = fixture("frames.json") as { frames: { hex: string }[] };
    const bytes = Uint8Array.from(frames[0].hex.match(/../g)!, h => Number.parseInt(h, 16));
    const legacy = decodeAudioFrame(bytes);
    const view = decodeAudioFrameView(bytes.buffer);
    expect(view.kind).toBe(legacy.kind);
    expect(view.lane).toBe(legacy.lane);
    expect(view.streamId).toBe(legacy.streamId);
    expect(view.blockIndex).toBe(legacy.blockIndex);
    expect(view.frames).toBe(legacy.frames);
    expect(view.flags).toBe(legacy.flags);
    expect(view.dueUs).toBe(legacy.dueUs);
    expect(view.sentUs).toBe(legacy.sentUs);
    expect(view.dueUsNumber).toBe(Number(legacy.dueUs));
    expect(view.sentUsNumber).toBe(Number(legacy.sentUs));
    expect(Array.from(view.pcm)).toEqual(Array.from(legacy.pcm));
  });

  it("rejects the same malformed frames decodeAudioFrame rejects", () => {
    const { frames } = fixture("frames.json") as { frames: { hex: string }[] };
    const bytes = Uint8Array.from(frames[0].hex.match(/../g)!, h => Number.parseInt(h, 16));
    const short = bytes.slice(0, -1);
    expect(() => decodeAudioFrameView(short.buffer)).toThrow();
    const corrupt = bytes.slice();
    corrupt[18] = 1;
    expect(() => decodeAudioFrameView(corrupt.buffer)).toThrow();
  });

  it("converts interleaved s16 to planar f32 in [-1, 1)", () => {
    const interleaved = new Int16Array([0, 32767, -32768, 1234, -1234, 0]);
    const planes = s16ToF32Planar(interleaved, 2, 3);
    expect(planes).toHaveLength(2);
    expect(planes[0][0]).toBeCloseTo(0);
    expect(planes[1][0]).toBeCloseTo(32767 / 32768);
    expect(planes[0][1]).toBeCloseTo(-1);
    expect(planes[1][1]).toBeCloseTo(1234 / 32768);
  });

  it("joins PCM16 blocks in order, including empty blocks", () => {
    const joined = joinS16([new Int16Array([1, 2]), new Int16Array([]), new Int16Array([3])]);
    expect(Array.from(joined)).toEqual([1, 2, 3]);
  });

  it("round-trips a canonical 44-byte PCM16 WAV like AudioService.Wav() writes", () => {
    const pcm = new Int16Array([0, 32767, -32768, 1234]);
    const parsed = parseWavPcm16(buildWav(pcm, 2, 48_000));
    expect(parsed.rate).toBe(48_000);
    expect(parsed.channels).toBe(2);
    expect(parsed.frames).toBe(2);
    expect(Array.from(parsed.interleaved)).toEqual(Array.from(pcm));
  });

  it("skips an unknown chunk placed before the data chunk", () => {
    const pcm = new Int16Array([5, -5]);
    const parsed = parseWavPcm16(buildWav(pcm, 1, 44_100, { extraChunk: "LIST" }));
    expect(parsed.rate).toBe(44_100);
    expect(parsed.channels).toBe(1);
    expect(parsed.frames).toBe(2);
    expect(Array.from(parsed.interleaved)).toEqual([5, -5]);
  });

  it("rejects a non-PCM16 wav", () => {
    expect(() => parseWavPcm16(buildWav(new Int16Array([0, 0]), 1, 48_000, { audioFormat: 3 }))).toThrow();
  });

  it("rejects a file that is not RIFF/WAVE", () => {
    const bytes = new Uint8Array(16);
    expect(() => parseWavPcm16(bytes.buffer)).toThrow();
  });
});
