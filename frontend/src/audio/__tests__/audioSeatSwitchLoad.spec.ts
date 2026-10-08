import { describe, expect, it, vi } from "vitest";
import { AudioTransportCore } from "../audioTransportCore";
import { MixerCore } from "../mixerCore";
import { MainSink } from "../mainSink";
import type { SinkCommand } from "../audioSinkProtocol";
import type { AudioContextLike } from "../audioUnlock";
import { FakeContext, FakeSocket } from "./fakes";
import { settle, wav } from "./audioFrames";

const KEY = "ac148f6ddbd27aba877991055c5a5431";
const SNAPSHOT = { kind: "volumes", snapshot: true, master: 1, sfx: 1, bgm: 1, ambience: 1, godotMasterDb: 0, godotSfxDb: 0 };
const cue = (t: number) => JSON.stringify({ kind: "sfx", keyId: KEY, key: "k", t, pitch: 1, volume: 1 });

function transport(pcm: "s16" | "f32-planar") {
  const sockets: FakeSocket[] = [];
  const Ctor = class extends FakeSocket { constructor(url: string) { super(url); sockets.push(this); } } as unknown as typeof WebSocket;
  const sent: SinkCommand[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/audio/takes"
    ? new Response(JSON.stringify({ schema: 1, bankset: "b", keys: [KEY] }))
    : new Response(wav([1000, -1000, 2000, -2000, 3000, -3000])));
  const core = new AudioTransportCore({ WebSocketCtor: Ctor, fetcher: fetcher as unknown as typeof fetch,
    postMain: () => {}, postSink: cmd => sent.push(cmd), now: () => 1 });
  core.handle({ kind: "init", mainTimeOrigin: 0, diag: false, hostBase: "", assetToken: "", indexUrl: "/audio/takes",
    renderUrl: "ws://h/a", sinkMode: pcm === "s16" ? "port" : "post", pcm, coalesce: 2 });
  return { core, sockets, sent };
}

// REGRESSION: setSeatUrl fences the sink from main before the worker hears `seat`. A cue the worker handled in
// that gap posted `load`+`play` at the old epoch; the sink dropped the load as stale while the worker counted the
// key as resident, so every later cue for it in the new seat was a `play` with no take — silent for the session.
describe("seat switch racing a first load", () => {
  it("keeps the key playable in the worklet mixer", async () => {
    const { core, sockets, sent } = transport("s16");
    core.handle({ kind: "start", epoch: 1, seatUrl: "ws://h/s1" });
    sockets[0].emit("open"); sockets[1].emit("open");
    sockets[0].emit("message", JSON.stringify(SNAPSHOT));
    sockets[0].emit("message", cue(1));
    await settle();
    const mixer = new MixerCore({ sampleRate: 48000 });
    mixer.handle({ kind: "fence", epoch: 2 });
    for (const cmd of sent.splice(0)) mixer.handle(cmd);
    core.handle({ kind: "seat", epoch: 2, seatUrl: "ws://h/s2" });
    sockets[2].emit("open"); sockets[3].emit("open");
    sockets[2].emit("message", JSON.stringify(SNAPSHOT));
    sockets[2].emit("message", cue(2));
    await settle();
    for (const cmd of sent.splice(0)) mixer.handle(cmd);
    expect(mixer.hasTake(KEY)).toBe(true);
    expect(mixer.stats().missingTakes).toBe(0);
  });

  it("keeps the key playable in the main-thread sink", async () => {
    const { core, sockets, sent } = transport("f32-planar");
    core.handle({ kind: "start", epoch: 1, seatUrl: "ws://h/s1" });
    sockets[0].emit("open"); sockets[1].emit("open");
    sockets[0].emit("message", JSON.stringify(SNAPSHOT));
    sockets[0].emit("message", cue(1));
    await settle();
    const context = new FakeContext(); context.state = "running";
    const rows: string[] = [];
    const target = new MainSink(context as unknown as AudioContextLike, { diag: type => rows.push(type) });
    target.apply({ kind: "fence", epoch: 2 });
    for (const cmd of sent.splice(0)) target.apply(cmd);
    core.handle({ kind: "seat", epoch: 2, seatUrl: "ws://h/s2" });
    sockets[2].emit("open"); sockets[3].emit("open");
    sockets[2].emit("message", JSON.stringify(SNAPSHOT));
    sockets[2].emit("message", cue(2));
    await settle();
    for (const cmd of sent.splice(0)) target.apply(cmd);
    expect(rows).not.toContain("sink-play-missing");
    expect(context.sources).toHaveLength(1);
  });
});
