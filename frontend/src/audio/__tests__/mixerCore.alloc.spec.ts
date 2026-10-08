// The allocation check lives in its own file on purpose: vitest gives each file a fresh module graph, so
// the mixer's functions carry only this scenario's JIT feedback. Run after the many shapes the behaviour
// spec feeds the same class, V8 can leave a hot function in a lower tier that boxes some doubles — engine
// tiering, not render-path garbage, but enough to blur a heap-growth measurement.
import { describe, expect, it } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import { MixerCore } from "../mixerCore";
import type { SinkCommand, SinkPcm } from "../audioSinkProtocol";

const Q = 128;

const noise = (frames: number, seed = 1): SinkPcm => {
  const interleaved = new Int16Array(frames * 2);
  let x = seed;
  for (let i = 0; i < interleaved.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; interleaved[i] = (x % 60000) - 30000; }
  return { format: "s16", interleaved, channels: 2, frames };
};
const load = (key: string, pcm: SinkPcm, rate: number, epoch: number): SinkCommand => ({ kind: "load", epoch, key, pcm, rate });
const play = (key: string, gain: number, pitch: number, epoch: number): SinkCommand =>
  ({ kind: "play", epoch, key, sourcePath: "cached", postMs: 0, gain, pitch });
const laneBlock = (lane: number, blockIndex: number, dueUs: number, pcm: SinkPcm, flags: number, epoch: number): SinkCommand =>
  ({ kind: "lane-blocks", epoch, postMs: 0, blocks: [{ lane, streamId: 1, blockIndex, dueUs, flags, pcm }] });
const takeStart = (streamId: number, key: string, gain: number, pitch: number, epoch: number): SinkCommand =>
  ({ kind: "take-start", epoch, streamId, key, postMs: 0, gain, pitch });
const takeBlock = (streamId: number, blockIndex: number, pcm: SinkPcm, flags: number, epoch: number): SinkCommand =>
  ({ kind: "take-block", epoch, streamId, blockIndex, flags, pcm, postMs: 0 });

let allocationSink: unknown = null;
function allocatingTwin(quanta: number): unknown {
  for (let q = 0; q < quanta; q++) allocationSink = { q, frame: q * Q };
  return allocationSink;
}

/** A live Segment, reached through the core's pool (the class is module-private). */
function probeSegment(): object {
  return (new MixerCore({ sampleRate: 48_000 }) as unknown as { segments: object[] }).segments[0];
}

/** Every method `render()` reaches. */
const RENDER_PATH = ["render", "renderChunk", "fillStrip", "mixSegment", "detachActive", "freeStripSegments",
  "freeStrip", "releaseSegment"] as const;

describe("MixerCore render allocation", () => {
  it("render-path methods contain no allocating syntax", () => {
    const proto = MixerCore.prototype as unknown as Record<string, unknown>;
    // PcmView.clear (via releaseSegment) is a plain field reset; scanned through a Segment instance below.
    const sources: Array<[string, string]> = RENDER_PATH.map(name => [name, String(proto[name])]);
    sources.push(["PcmView.clear", String((Object.getPrototypeOf(Object.getPrototypeOf(probeSegment())) as Record<string, unknown>).clear)]);
    for (const [name, source] of sources) {
      expect(source.length, name).toBeGreaterThan(20);
      for (const pattern of [/\bnew\s/, /=>/, /\bfunction\b/, /\.\.\./, /`/, /=\s*\[/, /=\s*\{/, /\(\s*[[{]/,
        /\.(push|pop|shift|unshift|slice|splice|concat|map|filter|forEach|reduce|bind|call|apply)\(/, /\bfor\s*\(\s*(const|let)\s+\w+\s+of\b/])
        expect({ name, pattern: String(pattern), hit: pattern.test(source) }).toMatchObject({ hit: false });
    }
  });

  it("render allocates nothing (constructors untouched, heap flat over 10k quanta, control allocation detected)", () => {
    const core = new MixerCore({ sampleRate: 48_000 });
    // Every voice ends inside each 3000-quantum (8 s) warm-up run, so every render branch (natural end, fade
    // end, take Last, lane drain, idle DC) is JIT-warm before the measured window. A branch first taken inside
    // the window deopts, and deoptimised code boxes doubles — an engine one-off, not render-path garbage.
    const scenario = (epoch: number): void => {
      core.handle({ kind: "fence", epoch });
      core.handle(load("long", noise(48_000 * 4, 2), 48_000, epoch));
      core.handle(load("short", noise(4_800, 3), 48_000, epoch));
      core.handle(load("f32", { format: "f32-planar", channels: [new Float32Array(9_600).fill(0.1)], frames: 9_600 }, 44_100, epoch));
      core.handle(play("long", 0.3, 0.9, epoch));
      for (let i = 0; i < 6; i++) core.handle(play("short", 0.2, 1 + i / 10, epoch)); // cap eviction + fade
      core.handle(play("f32", 0.5, 1, epoch));
      core.handle(takeStart(epoch, "take", 0.5, 1.1, epoch));
      for (let b = 0; b < 8; b++) core.handle(takeBlock(epoch, b, noise(512, b), b === 7 ? 2 : 0, epoch));
      for (let b = 0; b < 6; b++) core.handle(laneBlock(1 + (b % 3), b, 1_000 + b * 10_667, noise(512, b), 0, epoch));
      core.handle(laneBlock(2, 90, 99_000_000, noise(512, 11), 0, epoch)); // re-anchor -> ramp
      core.handle({ kind: "lane-gains", epoch, music: 0.4, ambience: 0.7, loops: 0.1 });
    };
    const l = new Float32Array(Q), r = new Float32Array(Q);
    let frame = 0;
    const run = (quanta: number): void => { for (let q = 0; q < quanta; q++) { core.render(l, r, Q, frame); frame += Q; } };
    for (let warm = 1; warm <= 6; warm++) { scenario(warm); run(3_000); allocatingTwin(3_000); }
    scenario(10);

    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const growth = (fn: () => void): number => {
      gc();
      const before = v8.getHeapStatistics().used_heap_size;
      fn();
      return v8.getHeapStatistics().used_heap_size - before;
    };
    const names = ["Float32Array", "Float64Array", "Int16Array", "Int32Array", "Array", "Map", "Set"] as const;
    const saved = names.map(name => (globalThis as Record<string, unknown>)[name]);
    let constructed = 0, counting = false;
    names.forEach((name, i) => {
      (globalThis as Record<string, unknown>)[name] = new Proxy(saved[i] as object, {
        construct(target, args, newTarget) { if (counting) constructed++; return Reflect.construct(target as new (...a: unknown[]) => object, args, newTarget); },
        apply(target, thisArg, args) { if (counting) constructed++; return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args); }
      });
    });
    // Min of three windows: a one-off JIT event (tier-up, deopt) lands in one window, real garbage in all three.
    let renderGrowth = Number.POSITIVE_INFINITY;
    try {
      for (let window = 0; window < 3; window++) {
        if (window > 0) scenario(10 + window);
        renderGrowth = Math.min(renderGrowth, growth(() => { counting = true; run(10_000); counting = false; }));
      }
    } finally {
      names.forEach((name, i) => { (globalThis as Record<string, unknown>)[name] = saved[i]; });
    }
    const controlGrowth = growth(() => allocatingTwin(10_000)); // one small object per quantum
    expect(constructed).toBe(0);
    expect(controlGrowth).toBeGreaterThan(256 * 1024);
    // Plain node measures ~18-23 KB here, the same as an empty loop (heap-statistics noise). Under vitest's
    // parallel load a window can read ~60 KB; one small object per quantum reads >= 160 KB (control ~400 KB).
    // The source scan above is the deterministic guard; this bound catches a per-quantum regression.
    expect({ renderGrowth, ok: renderGrowth < 128 * 1024 }).toMatchObject({ ok: true });
    expect(core.stats().keepAlive).toBe(true); // the scenario played out, through every hot path
  });
});
