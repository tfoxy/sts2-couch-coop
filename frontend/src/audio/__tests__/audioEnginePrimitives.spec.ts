import { describe, expect, it, vi } from "vitest";
import { applyVolumeSnapshot, dbToLinear, DEFAULT_SEAT_VOLUMES, laneGain, sfxEventGain } from "../audioGains";
import { browserAudioEnv, createAudioUnlock, type AudioContextLike } from "../audioUnlock";
import { LaneJitterBuffer } from "../laneJitterBuffer";
import { shouldKeepAlive } from "../keepAlive";
import { VoiceCap, type VoiceRecord } from "../voiceCap";
import { tmpSfxUrl } from "../audioRoutes";
import { outputLeadMs } from "../fastTrackProbe";

describe("per-viewer audio primitives", () => {
  it("reports predicted output lead from the output timestamp", () => {
    expect(outputLeadMs({ currentTime: 3, getOutputTimestamp: () => ({ contextTime: 2, performanceTime: 1000 }) } as never, 1500)).toBe(500);
  });
  it("applies the seat FMOD and Godot volumes to SFX and each stream bus", () => {
    const volumes = applyVolumeSnapshot(DEFAULT_SEAT_VOLUMES, {
      kind: "volumes", snapshot: true, master: .5, sfx: .4, bgm: .25, ambience: .75,
      godotMasterDb: -6, godotSfxDb: -12
    });
    expect(sfxEventGain(volumes, { kind: "sfx", keyId: "", key: "", t: 0, pitch: 1, volume: .8 })).toBeCloseTo(.5 ** 2 * .4 ** 2 * .8);
    expect(sfxEventGain(volumes, { kind: "sfx", keyId: "", key: "", t: 0, pitch: 1, volume: 1.5 })).toBeCloseTo(.5 ** 2 * .4 ** 2 * 1.5);
    expect(sfxEventGain(volumes, { kind: "tmpsfx", resPath: "", t: 0, pitch: 1, volume: .8 })).toBeCloseTo(10 ** (-18 / 20) * .8);
    expect(sfxEventGain({ ...volumes, master: 0 }, { kind: "tmpsfx", resPath: "", t: 0, pitch: 1, volume: .8 })).toBe(0);
    expect(sfxEventGain({ ...volumes, sfx: 0 }, { kind: "tmpsfx", resPath: "", t: 0, pitch: 1, volume: .8 })).toBe(0);
    expect(laneGain(volumes, "music")).toBeCloseTo(.5 ** 2 * .25 ** 2);
    expect(laneGain(volumes, "ambience")).toBeCloseTo(.5 ** 2 * .75 ** 2);
    expect(laneGain(volumes, "loops")).toBeCloseTo(.5 ** 2 * .4 ** 2);
  });

  it("treats negative infinity as a mute and ignores invalid positive infinity", () => {
    const volumes = applyVolumeSnapshot(DEFAULT_SEAT_VOLUMES, {
      kind: "volumes", snapshot: true, master: 1, sfx: 1, bgm: 1, ambience: 1,
      godotMasterDb: "-Infinity", godotSfxDb: Number.POSITIVE_INFINITY
    });
    expect(volumes.godotMasterDb).toBe(Number.NEGATIVE_INFINITY);
    expect(volumes.godotSfxDb).toBe(0);
    expect(dbToLinear(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(sfxEventGain(volumes, { kind: "tmpsfx", resPath: "", t: 0, pitch: 1, volume: 1 })).toBe(0);
  });

  it("reanchors a late lane and returns to the 60 ms target within two blocks", () => {
    const jitter = new LaneJitterBuffer();
    const frame = (blockIndex: number, dueUs: bigint) => ({ blockIndex, dueUs, frames: 512, pcm: new Int16Array(1024), kind: 2 as const, lane: 1 as const, streamId: 1, flags: 0, sentUs: dueUs });
    const first = jitter.accept(frame(0, 1_000_000n), 10);
    expect(first.scheduleAt).toBeCloseTo(10.06);
    const normal = jitter.accept(frame(1, 1_010_667n), 10.0107);
    expect(normal.reanchored).toBe(false);
    const late = jitter.accept(frame(8, 1_200_000n), 10.3);
    expect(late.reanchored).toBe(true);
    expect(late.scheduleAt).toBeCloseTo(10.36);
    const recovered = jitter.accept(frame(9, 1_210_667n), 10.3107);
    expect(recovered.scheduleAt).toBeCloseTo(10.3707);
    expect(recovered.reanchored).toBe(false);
  });

  it("keeps the tiny output voice only while every lane and voice is silent", () => {
    expect(shouldKeepAlive({ voices: 0, activeLanes: 0 })).toBe(true);
    expect(shouldKeepAlive({ voices: 1, activeLanes: 0 })).toBe(false);
    expect(shouldKeepAlive({ voices: 0, activeLanes: 1 })).toBe(false);
  });

  it("runs the silent prelude before creating and resuming the context", async () => {
    const order: string[] = [];
    const context = {
      state: "suspended", currentTime: 0, destination: {} as AudioNode,
      resume: async () => { order.push("resume"); context.state = "running"; },
      close: async () => { order.push("close"); }, suspend: async () => {},
      createBuffer: vi.fn(), createBufferSource: vi.fn(), createGain: vi.fn(), decodeAudioData: vi.fn()
    } as unknown as AudioContextLike;
    const handle = createAudioUnlock({
      createPrelude: () => ({ play: async () => { order.push("prelude"); }, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement),
      createContext: () => { order.push("context"); return context; }
    });
    expect(await handle.unlock()).toBe(context);
    expect(order).toEqual(["prelude", "context", "resume"]);
    handle.dispose();
  });

  it("plays the browser prelude through its ended event before opening WebAudio", async () => {
    const created: Blob[] = [];
    const originalCreateUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevokeUrl = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn((blob: Blob) => {
      created.push(blob as Blob);
      return "blob:audio-prelude-test";
    });
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const prelude = document.createElement("audio");
    vi.spyOn(document, "createElement").mockImplementationOnce(() => prelude);
    const play = vi.spyOn(prelude, "play").mockResolvedValue();
    const pause = vi.spyOn(prelude, "pause").mockImplementation(() => {});
    const context = {
      state: "running", close: async () => {},
      getOutputTimestamp: undefined
    } as unknown as AudioContextLike;
    let opened = false;
    const env = browserAudioEnv();
    const handle = createAudioUnlock({
      ...env,
      createContext: () => { opened = true; return context; }
    });
    try {
      const pending = handle.unlock();
      await Promise.resolve();
      expect(play).toHaveBeenCalledOnce();
      expect(opened).toBe(false);
      expect(prelude.muted).toBe(false);
      expect(created).toHaveLength(1);
      expect(created[0]?.size).toBe(44 + 14_400 * 2);
      prelude.dispatchEvent(new Event("ended"));
      expect(await pending).toBe(context);
      expect(opened).toBe(true);
      expect(pause).toHaveBeenCalledOnce();
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:audio-prelude-test");
      expect(prelude.isConnected).toBe(false);
    } finally {
      handle.dispose();
      if (originalCreateUrl) Object.defineProperty(URL, "createObjectURL", originalCreateUrl);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevokeUrl) Object.defineProperty(URL, "revokeObjectURL", originalRevokeUrl);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
      vi.restoreAllMocks();
    }
  });

  it("does not open a context after audio is turned off during the prelude", async () => {
    let finishPrelude: () => void = () => {};
    const prelude = new Promise<void>(resolve => { finishPrelude = resolve; });
    const createContext = vi.fn();
    const handle = createAudioUnlock({
      createPrelude: () => ({ play: () => prelude, pause() {}, removeAttribute() {} } as unknown as HTMLAudioElement),
      createContext
    });
    const pending = handle.unlock();
    handle.dispose();
    finishPrelude();
    expect(await pending).toBeNull();
    expect(createContext).not.toHaveBeenCalled();
  });

  it("caps voices per key and fades the oldest before admitting the next", () => {
    const cap = new VoiceCap(4), stopped: number[] = [];
    const make = (n: number): VoiceRecord => ({ keyId: "key", stop: ms => stopped.push(n * 100 + ms) });
    for (let i = 0; i < 5; i++) cap.add(make(i));
    expect(cap.count()).toBe(4);
    expect(stopped).toEqual([10]);
  });

  it("mints TmpSfx fetches from the relative Godot path and session build token", () => {
    expect(tmpSfxUrl("res://debug_audio/hit.mp3", "build token")).toContain("/audio/tmpsfx/debug_audio%2Fhit.mp3?b=build%20token");
    expect(tmpSfxUrl("res://debug_audio/cards/hit.mp3", "build token")).toBeNull();
    expect(tmpSfxUrl("res://images/not-audio.mp3", "v1")).toBeNull();
    expect(tmpSfxUrl("res://debug_audio/../secret.mp3", "v1")).toBeNull();
  });
});
