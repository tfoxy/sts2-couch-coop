import { describe, expect, it } from "vitest";
import { MIXER_KEEP_ALIVE_DC, MIXER_LANE_GAIN_TAU_S, MixerCore } from "../mixerCore";
import type { SinkCommand, SinkPcm } from "../audioSinkProtocol";

const Q = 128;
const DC = Math.fround(MIXER_KEEP_ALIVE_DC);

/** Drives a core quantum by quantum, keeping every rendered frame. */
class Rig {
  frame = 0;
  readonly left: number[] = [];
  readonly right: number[] = [];
  private readonly l = new Float32Array(Q);
  private readonly r = new Float32Array(Q);
  constructor(readonly core: MixerCore) {}
  send(cmd: SinkCommand): this { this.core.handle(cmd); return this; }
  quanta(count: number): { left: number[]; right: number[] } {
    const start = this.left.length;
    for (let q = 0; q < count; q++) {
      this.core.render(this.l, this.r, Q, this.frame);
      this.frame += Q;
      for (let j = 0; j < Q; j++) { this.left.push(this.l[j]); this.right.push(this.r[j]); }
    }
    return { left: this.left.slice(start), right: this.right.slice(start) };
  }
}

const rig = (sampleRate = 48_000, diag = false): Rig => new Rig(new MixerCore({ sampleRate, diag }));

function s16(frames: number, channels: number, fn: (i: number, c: number) => number): SinkPcm {
  const interleaved = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) interleaved[i * channels + c] = fn(i, c);
  return { format: "s16", interleaved, channels, frames };
}
const constant = (frames: number, value: number, channels = 2): SinkPcm => s16(frames, channels, () => value);
const noise = (frames: number, seed = 1): SinkPcm => {
  let x = seed;
  return s16(frames, 2, () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return (x % 60000) - 30000; });
};

const load = (key: string, pcm: SinkPcm, rate = 48_000, epoch = 1): SinkCommand => ({ kind: "load", epoch, key, pcm, rate });
const play = (key: string, gain = 1, pitch = 1, epoch = 1): SinkCommand =>
  ({ kind: "play", epoch, key, sourcePath: "cached", postMs: 0, gain, pitch });
const laneBlock = (lane: number, blockIndex: number, dueUs: number, pcm: SinkPcm, flags = 0, epoch = 1): SinkCommand =>
  ({ kind: "lane-blocks", epoch, postMs: 0, blocks: [{ lane, streamId: 1, blockIndex, dueUs, flags, pcm }] });
const takeStart = (streamId: number, key: string, gain = 1, pitch = 1, epoch = 1): SinkCommand =>
  ({ kind: "take-start", epoch, streamId, key, postMs: 0, gain, pitch });
const takeBlock = (streamId: number, blockIndex: number, pcm: SinkPcm, flags = 0, epoch = 1): SinkCommand =>
  ({ kind: "take-block", epoch, streamId, blockIndex, flags, pcm, postMs: 0 });

/** Independent reference for an AudioBufferSourceNode started on an integer frame: linear interpolation, hold at the end. */
function reference(pcm: Extract<SinkPcm, { format: "s16" }>, channel: number, step: number, gain: number, count: number): number[] {
  const out: number[] = [];
  const at = (i: number): number => pcm.interleaved[i * pcm.channels + Math.min(channel, pcm.channels - 1)] / 32768;
  for (let n = 0; n < count; n++) {
    const pos = n * step;
    const i = Math.floor(pos);
    if (i >= pcm.frames) { out.push(0); continue; }
    const next = i + 1 < pcm.frames ? at(i + 1) : at(i);
    out.push((at(i) + (next - at(i)) * (pos - i)) * gain);
  }
  return out;
}

function expectClose(actual: number[], expected: number[], tolerance = 1e-6): void {
  expect(actual.length).toBe(expected.length);
  let worst = 0, at = -1;
  for (let i = 0; i < actual.length; i++) {
    const err = Math.abs(actual[i] - expected[i]);
    if (err > worst) { worst = err; at = i; }
  }
  expect({ worst, at, ok: worst <= tolerance }).toMatchObject({ ok: true });
}

describe("MixerCore one-shot voices", () => {
  it("starts a play on the first frame of the next quantum (latency <= 1 quantum)", () => {
    const r = rig().send(load("k", constant(4_800, 16_384)));
    r.quanta(3);
    r.send(play("k", 1));
    const out = r.quanta(1);
    expect(out.left[0]).toBe(0.5);
    expect(out.right[0]).toBe(0.5);
    expect(out.left.every(v => v === 0.5)).toBe(true);
  });

  it("outputs source x gain exactly at pitch 1 on a 48 kHz context", () => {
    const pcm = noise(1_000) as Extract<SinkPcm, { format: "s16" }>;
    const r = rig().send(load("k", pcm)).send(play("k", 0.7));
    const out = r.quanta(10);
    expectClose(out.left.slice(0, 1_000), reference(pcm, 0, 1, 0.7, 1_000));
    expectClose(out.right.slice(0, 1_000), reference(pcm, 1, 1, 0.7, 1_000));
    expect(out.left.slice(1_000, 1_024).every(v => v === 0)).toBe(true); // ended mid-quantum
    expect(out.left.slice(1_024).every(v => v === DC)).toBe(true); // keep-alive DC from the next quantum
  });

  it.each([0.5, 2])("resamples pitch %s against a linear-interpolation reference", (pitch) => {
    const pcm = noise(2_000, 7) as Extract<SinkPcm, { format: "s16" }>;
    const r = rig().send(load("k", pcm)).send(play("k", 0.5, pitch));
    const out = r.quanta(8);
    const expected = reference(pcm, 0, pitch, 0.5, 1_024);
    // Frames past the voice's last frame belong to whatever follows (DC once idle); compare the voice span.
    const span = Math.min(1_024, Math.ceil(2_000 / pitch) - 1);
    expectClose(out.left.slice(0, span), expected.slice(0, span), 1e-5);
  });

  it("plays 48 kHz takes at the right speed on a 44.1 kHz context", () => {
    const pcm = noise(4_410, 3) as Extract<SinkPcm, { format: "s16" }>;
    const r = rig(44_100).send(load("k", pcm, 48_000)).send(play("k", 1, 1));
    const out = r.quanta(40);
    const step = 48_000 / 44_100;
    const span = Math.ceil(4_410 / step) - 1;
    expectClose(out.left.slice(0, span), reference(pcm, 0, step, 1, span), 1e-5);
    expect(r.core.stats().voices).toBe(0);
  });

  it("plays mono takes on both channels and accepts f32-planar takes", () => {
    const r = rig().send(load("mono", constant(256, 8_192, 1)));
    r.send(load("f32", { format: "f32-planar", channels: [new Float32Array(256).fill(0.1), new Float32Array(256).fill(-0.2)], frames: 256 }));
    r.send(play("mono", 1)).send(play("f32", 1));
    const out = r.quanta(1);
    expect(out.left[5]).toBeCloseTo(0.25 + 0.1, 6);
    expect(out.right[5]).toBeCloseTo(0.25 - 0.2, 6);
  });

  it("never starts a zero-gain cue or a cue for an unloaded key", () => {
    const r = rig().send(load("k", constant(256, 1_000)));
    r.send(play("k", 0)).send(play("missing", 1));
    expect(r.core.stats()).toMatchObject({ voices: 0, missingTakes: 1 });
    expect(r.quanta(1).left.every(v => v === DC)).toBe(true);
  });
});

describe("MixerCore voice cap", () => {
  it("evicts the oldest in-cap voice of a key with a 10 ms setTargetAtTime fade (tau = 10/3 ms)", () => {
    const r = rig().send(load("A", constant(48_000, 16_384))).send(load("B", constant(48_000, 16_384)));
    r.send(play("B", 0.05));
    for (const gain of [0.1, 0.2, 0.3, 0.4]) r.send(play("A", gain));
    r.quanta(2);
    expect(r.core.stats().capVoices).toBe(5);
    r.send(play("A", 0.5)); // 5th voice of A: the gain-0.1 voice (oldest) must fade, B untouched
    expect(r.core.stats().capVoices).toBe(5);
    const out = r.quanta(6).left;
    const survivors = (0.05 + 0.2 + 0.3 + 0.4 + 0.5) * 0.5;
    const k = Math.exp(-1 / ((10 / 3000) * 48_000));
    const expected = out.map((_, n) => survivors + (n < 480 ? 0.1 * 0.5 * Math.pow(k, n) : 0));
    expectClose(out, expected, 1e-5);
    expect(r.core.stats().voices).toBe(5); // the faded voice is freed at now + 10 ms
  });
});

describe("MixerCore take streams", () => {
  it("places blocks back to back from max(now + 5 ms, nextAt) and fades in after an underrun", () => {
    const r = rig();
    r.quanta(1);
    r.send(takeStart(9, "take", 1)).send(takeBlock(9, 0, constant(512, 8_192))).send(takeBlock(9, 1, constant(512, 16_384)));
    expect(r.core.stats()).toMatchObject({ takeStreams: 1, capVoices: 1 });
    const first = r.quanta(12).left; // 1536 frames
    expect(first.slice(0, 240).every(v => v === 0)).toBe(true); // capVoices > 0 -> no DC while waiting
    expect(first.slice(240, 752).every(v => v === 0.25)).toBe(true);
    expect(first.slice(752, 1_264).every(v => v === 0.5)).toBe(true);
    expect(first.slice(1_264).every(v => v === 0)).toBe(true);
    // Underrun: nextAt is in the past, so the block starts at now + 5 ms with a 5 ms linear fade-in.
    r.send(takeBlock(9, 2, constant(512, 16_384), /* Last */ 2));
    const late = r.quanta(8).left;
    expect(late.slice(0, 240).every(v => v === 0)).toBe(true);
    for (const j of [0, 60, 120, 239]) expect(late[240 + j]).toBeCloseTo(0.5 * (j / 240), 6);
    expect(late.slice(480, 752).every(v => v === 0.5)).toBe(true);
    expect(r.core.stats()).toMatchObject({ takeStreams: 0, capVoices: 0 }); // Last block played out -> freed
    expect(late.slice(768).every(v => v === DC)).toBe(true);
  });

  it("starts the first block 5 ms out with no fade when it follows take-start immediately", () => {
    const r = rig().send(takeStart(1, "t", 0.5, 2)).send(takeBlock(1, 0, constant(512, 16_384), 2));
    const out = r.quanta(6).left;
    expect(out.slice(0, 240).every(v => v === 0)).toBe(true);
    expect(out.slice(240, 496).every(v => v === 0.25)).toBe(true); // pitch 2: 512 frames in 256
    expect(out.slice(496, 512).every(v => v === 0)).toBe(true);
    expect(out.slice(512).every(v => v === DC)).toBe(true); // Last played out -> stream freed -> keep-alive
  });
});

describe("MixerCore take-stream pitch", () => {
  it("uses the raw take-start pitch (unclamped, like playTakeFrame), unlike a one-shot's [0.25, 4] clamp", () => {
    const r = rig().send(takeStart(2, "t", 1, 8)).send(takeBlock(2, 0, constant(512, 16_384), 2));
    const out = r.quanta(4).left;
    expect(out.slice(240, 304).every(v => v === 0.5)).toBe(true); // 512 frames at pitch 8 = 64 output frames
    expect(out.slice(304, 384).every(v => v === 0)).toBe(true);
    const one = rig().send(load("k", constant(512, 16_384))).send(play("k", 1, 8)).quanta(2).left;
    expect(one.slice(0, 128).every(v => v === 0.5)).toBe(true); // clamped to 4: 512 frames in 128
    expect(one[128]).toBe(DC);
  });
});

describe("MixerCore lanes", () => {
  it("anchors the first block at now + 60 ms, places by dueUs, and ramps after a re-anchor", () => {
    const r = rig();
    r.quanta(2);
    const base = r.frame;
    r.send(laneBlock(1, 0, 5_000_000, constant(512, 16_384)));
    r.send(laneBlock(1, 1, 5_010_667, constant(512, 16_384)));
    expect(r.core.stats()).toMatchObject({ lanes: 1, laneSegments: 2 });
    const out = r.quanta(40).left;
    expect(out.slice(0, 2_880).every(v => v === 0)).toBe(true); // no DC: lane sources are scheduled
    expect(out[2_880]).toBe(0.5);
    expect(out[2_880 + 511]).toBe(0.5);
    expect(out[2_880 + 600]).toBe(0.5); // block 1 at +10.667 ms
    expect(out[2_880 + 1_100]).toBe(DC);
    // Block index jump > 32 re-anchors; the lane has scheduled before, so the block ramps in over 5 ms.
    const reFrame = r.frame;
    r.send(laneBlock(1, 100, 9_000_000, constant(512, 16_384)));
    const re = r.quanta(30).left;
    expect(re.slice(0, 2_880).every(v => v === 0)).toBe(true);
    expect(re[2_880 + 120]).toBeCloseTo(0.25, 6);
    expect(re[2_880 + 300]).toBe(0.5);
    expect(reFrame - base).toBe(5_120);
  });

  it("Silent stops the lane like onFrame does, and lane-stop does the same", () => {
    const r = rig().send(laneBlock(2, 0, 1_000, constant(512, 1_000)));
    r.send(laneBlock(2, 1, 11_667, constant(512, 1_000), /* Silent */ 4));
    expect(r.core.stats()).toMatchObject({ lanes: 0, laneSegments: 0 });
    expect(r.quanta(30).left.every(v => v === DC)).toBe(true);
    r.send(laneBlock(3, 0, 1_000, constant(512, 1_000)));
    r.send({ kind: "lane-stop", epoch: 1, lane: 3 });
    expect(r.core.stats().lanes).toBe(0);
  });

  it("smooths lane-gains with tau = 15 ms per bus (1 music, 2 ambience, 3 loops), new lanes start at the target", () => {
    expect(MIXER_LANE_GAIN_TAU_S).toBe(0.015);
    const r = rig();
    r.send({ kind: "lane-gains", epoch: 1, music: 1, ambience: 0.25, loops: 1 });
    r.send(laneBlock(1, 0, 1_000, constant(512, 16_384))); // music, starts at +2880
    r.send(laneBlock(2, 0, 1_000, constant(512, 16_384))); // ambience
    r.send({ kind: "lane-gains", epoch: 1, music: 0.5, ambience: 0.25, loops: 1 });
    const out = r.quanta(30).left;
    const decay = Math.exp(-1 / (0.015 * 48_000));
    for (const j of [0, 100, 400]) {
      const music = 0.5 + 0.5 * Math.pow(decay, 2_880 + j + 1);
      expect(out[2_880 + j]).toBeCloseTo((music + 0.25) * 0.5, 5); // ambience never moved: it started AT 0.25
    }
  });
});

describe("MixerCore epochs", () => {
  it("fence stops older-epoch voices, take streams and lanes, keeps takes, and drops stale commands", () => {
    const r = rig().send(load("k", constant(48_000, 16_384)));
    r.send(play("k", 0.5));
    r.send(takeStart(4, "t", 1)).send(takeBlock(4, 0, constant(512, 16_384)));
    r.send(laneBlock(1, 0, 1_000, constant(512, 16_384)));
    r.quanta(1);
    r.send({ kind: "fence", epoch: 2 });
    expect(r.core.stats()).toMatchObject({ takeStreams: 0, lanes: 0, laneSegments: 0, capVoices: 0 });
    const fade = r.quanta(5).left;
    const k = Math.exp(-1 / ((10 / 3000) * 48_000));
    expect(fade[0]).toBeCloseTo(0.25 + DC, 6); // one-shot fades (VoiceCap.stopAll), DC on: nothing in the cap
    expect(fade[100]).toBeCloseTo(0.25 * Math.pow(k, 100) + DC, 6);
    expect(fade.slice(480).every(v => v === DC)).toBe(true);
    r.send(play("k", 1, 1, 1)).send(laneBlock(1, 0, 1_000, constant(512, 16_384), 0, 1));
    expect(r.core.stats()).toMatchObject({ voices: 0, lanes: 0, staleCommands: 2 });
    r.send(play("k", 1, 1, 2));
    expect(r.quanta(1).left[0]).toBe(0.5); // the take loaded under epoch 1 survived the fence
  });

  it("a newer-epoch command is an implicit fence (the main and worker ports are unordered)", () => {
    const r = rig().send(load("a", constant(48_000, 16_384))).send(play("a", 1));
    r.quanta(1);
    r.send(play("a", 0.5, 1, 3)); // arrives before its fence
    const out = r.quanta(5).left;
    expect(out[0]).toBeCloseTo(0.5 + 0.25, 6);
    expect(out[600]).toBe(0.25);
    r.send({ kind: "fence", epoch: 3 }); // the late fence for the same epoch keeps the new voice
    expect(r.quanta(1).left[0]).toBe(0.25);
  });
});

describe("MixerCore keep-alive", () => {
  it("emits the 1e-5 DC only while nothing is playing or scheduled", () => {
    const r = rig().send(load("k", constant(200, 3_277)));
    const idle = r.quanta(2);
    expect(idle.left.every(v => v === DC) && idle.right.every(v => v === DC)).toBe(true);
    expect(r.core.stats().keepAlive).toBe(true);
    r.send(play("k", 1));
    const busy = r.quanta(2).left;
    expect(busy[0]).toBe(Math.fround(3_277 / 32_768));
    expect(busy[199]).toBe(Math.fround(3_277 / 32_768));
    expect(busy.slice(200).every(v => v === 0)).toBe(true); // voice ended mid-quantum; DC resumes on the next
    expect(r.quanta(1).left.every(v => v === DC)).toBe(true);
  });
});

describe("MixerCore render", () => {
  it("renders the same audio in one long call as in 128-frame quanta", () => {
    const make = (): MixerCore => {
      const core = new MixerCore({ sampleRate: 48_000 });
      core.handle(load("k", noise(3_000, 5))); core.handle(play("k", 0.8, 1.3));
      core.handle(laneBlock(1, 0, 1_000, noise(512, 9)));
      return core;
    };
    const a = make(), b = make();
    const longL = new Float32Array(1_024 * 4), longR = new Float32Array(1_024 * 4);
    a.render(longL, longR, longL.length, 0);
    const l = new Float32Array(Q), rr = new Float32Array(Q);
    for (let q = 0; q < longL.length / Q; q++) {
      b.render(l, rr, Q, q * Q);
      for (let j = 0; j < Q; j++) expect(l[j]).toBe(longL[q * Q + j]);
    }
  });

});

describe("MixerCore diagnostics", () => {
  it("records receipts and actual start times in a ring, flushed after ~100 ms of audio", () => {
    const r = rig(48_000, true).send(load("k", constant(256, 1_000)));
    r.quanta(2);
    r.send({ kind: "play", epoch: 1, key: "k", sourcePath: "cached", postMs: 12.5, gain: 1, pitch: 1, seatTUs: "77", order: 3 });
    r.send(laneBlock(1, 0, 1_000, constant(512, 1_000)));
    r.quanta(35);
    expect(r.core.diagDue()).toBe(false); // 37 quanta = 4736 frames < 4800 (100 ms)
    r.quanta(1);
    expect(r.core.diagDue()).toBe(true);
    const { events, lost } = r.core.drainDiag();
    expect(lost).toBe(0);
    const types = events.map(e => e.type);
    expect(types).toEqual(["worklet-receipt", "worklet-receipt", "source-scheduled", "worklet-receipt", "lane-source-scheduled"]);
    const scheduled = events.find(e => e.type === "source-scheduled")!;
    expect(scheduled).toMatchObject({ keyId: "k", sourcePath: "decoded-cache", scheduledContextTime: 256 / 48_000,
      seatTUs: 77, requestOrder: 3, lane: "sfx" });
    expect(events.find(e => e.type === "worklet-receipt" && e.kind === "play")).toMatchObject({ postMs: 12.5, contextTime: 256 / 48_000 });
    expect(events.find(e => e.type === "lane-source-scheduled")).toMatchObject({ lane: 1, scheduledContextTime: (256 + 2_880) / 48_000, reanchored: true });
    expect(r.core.diagDue()).toBe(false);
  });

  it("is inert when off", () => {
    const r = rig().send(load("k", constant(256, 1_000))).send(play("k", 1));
    r.quanta(50);
    expect(r.core.diagDue()).toBe(false);
    expect(r.core.drainDiag().events).toEqual([]);
  });
});
