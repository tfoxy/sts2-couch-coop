import { describe, expect, it } from "vitest";
import { MainSink } from "../mainSink";
import type { SinkCommand, SinkLaneBlock, SinkPcm } from "../audioSinkProtocol";
import type { AudioContextLike } from "../audioUnlock";
import { FakeContext } from "./fakes";

const f32 = (frames: number, value = .25): SinkPcm => ({ format: "f32-planar", frames,
  channels: [new Float32Array(frames).fill(value), new Float32Array(frames).fill(-value)] });
const block = (lane: number, blockIndex: number, flags = 0): SinkLaneBlock => ({ lane, streamId: 1, blockIndex, flags,
  dueUs: 1_000_000 + Math.round(blockIndex * 512 / 48_000 * 1e6), pcm: f32(512, (blockIndex + 1) / 100) });
const play = (key: string, extra: Partial<Extract<SinkCommand, { kind: "play" }>> = {}): SinkCommand =>
  ({ kind: "play", epoch: 1, key, sourcePath: "cached", postMs: 0, gain: .5, pitch: 1.5, ...extra });

function sink() {
  const context = new FakeContext();
  context.state = "running";
  const rows: Array<{ type: string } & Record<string, unknown>> = [];
  const target = new MainSink(context as unknown as AudioContextLike, { diag: (type, fields) => rows.push({ type, ...fields }) });
  return { context, target, rows };
}

describe("main-thread audio sink", () => {
  it("loads Float32 planes into an AudioBuffer and plays it at the cue's gain and clamped pitch", () => {
    const { context, target, rows } = sink();
    target.apply({ kind: "load", epoch: 1, key: "k", rate: 48_000, pcm: f32(3) });
    target.apply(play("k"));
    target.apply(play("k", { pitch: 9 }));
    target.apply(play("k", { pitch: Number.NaN }));
    expect(context.sources.map(s => s.playbackRate.value)).toEqual([1.5, 4, 1]);
    const buffer = context.sources[0].buffer!;
    expect([...buffer.getChannelData(0).slice(0, 3)]).toEqual([.25, .25, .25]);
    expect([...buffer.getChannelData(1).slice(0, 3)]).toEqual([-.25, -.25, -.25]);
    expect(context.gains.filter(g => g.gain.value === .5)).toHaveLength(3);
    expect(context.sources[0].starts).toEqual([0]);
    expect(rows.find(row => row.type === "source-scheduled")).toMatchObject({ lane: "sfx", sourcePath: "decoded-cache", keyId: "k" });
  });

  it("refuses an unloaded key, a silent cue, and anything older than the newest epoch", () => {
    const { context, target, rows } = sink();
    target.apply(play("missing"));
    target.apply({ kind: "load", epoch: 1, key: "k", rate: 48_000, pcm: f32(2) });
    target.apply(play("k", { gain: 0 }));
    expect(context.sources).toHaveLength(0);
    expect(rows.some(row => row.type === "sink-play-missing")).toBe(true);
    target.fence(2);
    target.apply(play("k"));
    expect(context.sources).toHaveLength(0);
    target.apply(play("k", { epoch: 2 }));
    expect(context.sources).toHaveLength(1);
  });

  it("caps voices per key at four, fading out the oldest", () => {
    const { context, target } = sink();
    target.apply({ kind: "load", epoch: 1, key: "k", rate: 48_000, pcm: f32(2) });
    for (let i = 0; i < 5; i++) target.apply(play("k"));
    expect(context.sources.map(s => s.stopped)).toEqual([true, false, false, false, false]);
    expect(target.voiceCount()).toBe(4);
  });

  it("schedules a take stream back to back, fading in only after an underrun", () => {
    const { context, target } = sink();
    target.apply({ kind: "take-start", epoch: 1, streamId: 7, key: "t", postMs: 0, gain: .4, pitch: 2 });
    target.apply({ kind: "take-block", epoch: 1, streamId: 7, blockIndex: 0, flags: 1, pcm: f32(480), postMs: 0 });
    target.apply({ kind: "take-block", epoch: 1, streamId: 7, blockIndex: 1, flags: 2, pcm: f32(480), postMs: 0 });
    expect(context.sources.map(s => s.starts[0])).toEqual([12.005, 12.005 + 480 / (48_000 * 2)]);
    expect(context.sources.map(s => s.playbackRate.value)).toEqual([2, 2]);
    expect(context.gains.some(g => g.gain.value === .4)).toBe(true);
    expect(target.voiceCount()).toBe(1);
    for (const source of context.sources) source.stop();
    expect(target.voiceCount()).toBe(0);
  });

  it("merges a contiguous lane run into one buffer and keeps the 60 ms jitter target", () => {
    const { context, target, rows } = sink();
    target.apply({ kind: "lane-gains", epoch: 1, music: .3, ambience: .2, loops: .1 });
    target.apply({ kind: "lane-blocks", epoch: 1, blocks: [block(1, 0), block(2, 0), block(1, 1)], postMs: 0 });
    expect(context.sources).toHaveLength(2);
    const [music, ambience] = context.sources;
    expect(music.starts[0]).toBeCloseTo(12.06, 9);
    expect(music.buffer!.length).toBe(1024);
    expect(music.buffer!.getChannelData(0)[0]).toBeCloseTo(.01);
    expect(music.buffer!.getChannelData(0)[512]).toBeCloseTo(.02);
    expect(ambience.buffer!.length).toBe(512);
    expect(context.gains.map(g => g.gain.value).filter(v => v !== 1)).toEqual([.3, .2]);
    expect(target.laneKeys()).toEqual([1, 2]);
    expect(rows.filter(row => row.type === "lane-source-scheduled").map(row => row.blockIndex)).toEqual([0, 0]);
    target.apply({ kind: "lane-gains", epoch: 1, music: .9, ambience: .2, loops: .1 });
    expect(context.gains[0].gain.value).toBe(.9);
    // A later block on the same grid continues the timeline; a gap re-anchors as its own source.
    context.currentTime += 2 * 512 / 48_000;
    target.apply({ kind: "lane-blocks", epoch: 1, blocks: [block(1, 2), block(1, 9)], postMs: 0 });
    expect(context.sources).toHaveLength(4);
    expect(context.sources[2].starts[0]).toBeCloseTo(12.06 + 2 * 512 / 48_000, 6);
    target.apply({ kind: "lane-stop", epoch: 1, lane: 1 });
    expect(music.stopped).toBe(true);
    expect(target.laneKeys()).toEqual([2]);
  });

  it("fences every voice, stream and lane but keeps loaded buffers", () => {
    const { context, target } = sink();
    target.apply({ kind: "load", epoch: 1, key: "k", rate: 48_000, pcm: f32(2) });
    target.apply(play("k"));
    target.apply({ kind: "take-start", epoch: 1, streamId: 7, key: "t", postMs: 0, gain: .4, pitch: 1 });
    target.apply({ kind: "take-block", epoch: 1, streamId: 7, blockIndex: 0, flags: 1, pcm: f32(4), postMs: 0 });
    target.apply({ kind: "lane-blocks", epoch: 1, blocks: [block(3, 0)], postMs: 0 });
    target.fence(2);
    expect(context.sources.every(s => s.stopped)).toBe(true);
    expect(target.voiceCount()).toBe(0);
    expect(target.laneKeys()).toEqual([]);
    expect(target.hasBuffer("k")).toBe(true);
    target.apply({ kind: "take-block", epoch: 2, streamId: 7, blockIndex: 1, flags: 2, pcm: f32(4), postMs: 0 });
    expect(context.sources).toHaveLength(3);
  });

  it("drives the keep-alive from active voices and lanes", () => {
    const { context, target } = sink();
    const constants: Array<{ stopped: boolean }> = [];
    const create = context.createConstantSource.bind(context);
    context.createConstantSource = () => { const source = create(); constants.push(source); return source; };
    target.startKeepAlive();
    expect(constants).toHaveLength(1);
    target.apply({ kind: "load", epoch: 1, key: "k", rate: 48_000, pcm: f32(2) });
    target.apply(play("k"));
    expect(constants[0].stopped).toBe(true);
    context.sources[0].stop();
    expect(constants).toHaveLength(2);
    target.stopKeepAlive();
    expect(constants[1].stopped).toBe(true);
  });

  it("accepts s16 PCM as well", () => {
    const { context, target } = sink();
    target.apply({ kind: "load", epoch: 1, key: "k", rate: 48_000,
      pcm: { format: "s16", interleaved: new Int16Array([16384, -16384, 8192, -8192]), channels: 2, frames: 2 } });
    target.apply(play("k"));
    expect([...context.sources[0].buffer!.getChannelData(0).slice(0, 2)]).toEqual([.5, .25]);
    expect([...context.sources[0].buffer!.getChannelData(1).slice(0, 2)]).toEqual([-.5, -.25]);
  });
});
