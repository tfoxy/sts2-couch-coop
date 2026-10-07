import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIO_HEADER_BYTES, decodeAudioFrame, isKeyId } from "../audioWire";

const fixture = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), `../tests/fixtures/audio/${name}`), "utf8"));

describe("audio wire v1", () => {
  it("accepts all 30 census identities as 128-bit lowercase hex", () => {
    const { schema, keys } = fixture("keys.json") as { schema: number; keys: { key: string; keyId: string }[] };
    expect(schema).toBe(1);
    expect(keys).toHaveLength(30);
    expect(new Set(keys.map(k => k.keyId)).size).toBe(30);
    for (const { key, keyId } of keys) { expect(key).toBeTruthy(); expect(isKeyId(keyId)).toBe(true); }
    expect(isKeyId("A".repeat(32))).toBe(false);
  });

  it("decodes the shared golden PCM frame byte for byte", () => {
    const { frames } = fixture("frames.json") as { frames: { hex: string }[] };
    const bytes = Uint8Array.from(frames[0].hex.match(/../g)!, h => Number.parseInt(h, 16));
    expect(bytes.length).toBe(AUDIO_HEADER_BYTES + 8);
    expect(decodeAudioFrame(bytes)).toEqual({ kind: 1, lane: 0, streamId: 17,
      blockIndex: 0, frames: 2, flags: 3, dueUs: 123456789n, sentUs: 123450000n,
      pcm: new Int16Array([0, 32767, -32768, 1234]) });
    expect(() => decodeAudioFrame(bytes.slice(0, -1))).toThrow();
    bytes[18] = 1;
    expect(() => decodeAudioFrame(bytes)).toThrow();
  });
});
