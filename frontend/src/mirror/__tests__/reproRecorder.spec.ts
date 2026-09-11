import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectMirrorClient } from "@/mirror/mirrorClient";
import { DEFAULT_REPRO_BUFFER_BYTES, REPRO_FORMAT, reproRecorder } from "@/mirror/reproRecorder";

// THE REPRO RECORDER (reproRecorder.ts). What is pinned here is everything a recording is only trustworthy
// because of:
//
//   * OFF IS FREE — no listeners on the stage, no lines buffered. This is the property that lets the recorder be
//     tapped from the hottest input path in the app and from the websocket message loop.
//   * THE RING IS HONEST — it drops the OLDEST lines, it never drops the newest, it never exceeds its cap, and
//     what it dropped is counted into the file's meta. A flight recorder that quietly loses the start of a
//     gesture is worse than none: "the recording begins mid-drag" and "the client sent nothing" would look the
//     same.
//   * BOTH HALVES ARE CAPTURED, including the frames the mirror's own watch gate throws away — the class of
//     straggler an "the client ignored it" bug is made of.
//   * THE FILE PARSES AS THE FORMAT IT CLAIMS — meta first, `t` relative and 3dp, `dir` on wire lines. The
//     offline tools and the existing replay-server/bench loaders read this file, so its shape is a contract.

// A controllable `performance.now()`, because every `t` in the file is derived from it and "3 decimal places"
// cannot be asserted against a real clock.
let clock = 0;

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  emit(text: string) {
    this.dispatchEvent(new MessageEvent("message", { data: text }));
  }
}

function connect(watch?: boolean) {
  MockWebSocket.instances = [];
  const client = connectMirrorClient({
    watch,
    WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
    location: { href: "http://localhost/", protocol: "http:" }
  });
  return { client, socket: MockWebSocket.instances[0] };
}

/** A pointer event jsdom will actually construct (it has no PointerEvent), with a pinned `timeStamp`. */
function pointer(
  type: string,
  opts: { x?: number; y?: number; id?: number; pt?: string; t?: number; buttons?: number } = {}
): MouseEvent {
  const { x = 0, y = 0, id = 1, pt = "mouse", t = clock, buttons = 0 } = opts;
  const event = new MouseEvent(type, { clientX: x, clientY: y, buttons, bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: id });
  Object.defineProperty(event, "pointerType", { value: pt });
  Object.defineProperty(event, "isPrimary", { value: true });
  Object.defineProperty(event, "timeStamp", { value: t });
  return event;
}

function stageEl(): HTMLElement {
  const stage = document.createElement("div");
  document.body.appendChild(stage);
  return stage;
}

/** Every line of the current buffer, parsed — `[0]` is always the meta line. */
function lines(): Record<string, unknown>[] {
  return reproRecorder
    .serialize()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function meta(): Record<string, unknown> {
  return lines()[0].meta as Record<string, unknown>;
}

/** A wire frame of an approximate size, so the byte cap can be spent in predictable units. */
function frame(tag: string, bytes: number): string {
  return JSON.stringify({ tag, pad: "x".repeat(Math.max(1, bytes)) });
}

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  reproRecorder.__resetForTests();
});

afterEach(() => {
  reproRecorder.__resetForTests();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("reproRecorder — off costs nothing", () => {
  it("installs NO stage listeners while it is not recording", () => {
    const stage = stageEl();
    const add = vi.spyOn(stage, "addEventListener");
    const detach = reproRecorder.attachStage(stage);
    expect(add).not.toHaveBeenCalled();
    detach();
  });

  it("buffers nothing from any tap while off", () => {
    const stage = stageEl();
    reproRecorder.attachStage(stage);
    stage.dispatchEvent(pointer("pointerdown", { x: 10, y: 20 }));
    reproRecorder.tapWireIn('{"type":"scene-delta"}');
    reproRecorder.tapWireOut('{"type":"input"}');
    reproRecorder.tapWsLifecycle("open");
    expect(reproRecorder.stats().lines).toBe(0);
    expect(reproRecorder.stats().recording).toBe(false);
  });

  it("removes every stage listener again on stop", () => {
    const stage = stageEl();
    const add = vi.spyOn(stage, "addEventListener");
    const remove = vi.spyOn(stage, "removeEventListener");
    reproRecorder.attachStage(stage);
    reproRecorder.start();
    // pointerdown / pointermove / pointerup / pointercancel / wheel
    expect(add).toHaveBeenCalledTimes(5);
    for (const call of add.mock.calls) {
      // Capture phase (ahead of inputCapture's bubble handlers) and passive (never an opinion on scrolling).
      expect(call[2]).toMatchObject({ capture: true, passive: true });
    }
    reproRecorder.stop();
    expect(remove).toHaveBeenCalledTimes(5);
    stage.dispatchEvent(pointer("pointermove", { x: 1, y: 2 }));
    expect(lines().filter((line) => line.kind === "pointer")).toHaveLength(0);
  });
});

describe("reproRecorder — stage lifecycle", () => {
  it("records raw client coordinates, pointer identity and the event's OWN timestamp", () => {
    const stage = stageEl();
    reproRecorder.attachStage(stage);
    reproRecorder.start();
    clock = 1000;
    stage.dispatchEvent(pointer("pointerdown", { x: 12.345, y: 67.891, id: 7, pt: "touch", t: 1000, buttons: 1 }));
    stage.dispatchEvent(pointer("pointermove", { x: 13, y: 68, id: 7, pt: "touch", t: 1016.5 }));
    stage.dispatchEvent(pointer("pointerup", { x: 13, y: 68, id: 7, pt: "touch", t: 1032.25 }));
    stage.dispatchEvent(pointer("pointercancel", { x: 13, y: 68, id: 7, pt: "touch", t: 1040 }));

    const pointers = lines().filter((line) => line.kind === "pointer");
    expect(pointers.map((line) => line.type)).toEqual(["down", "move", "up", "cancel"]);
    expect(pointers[0]).toMatchObject({ t: 0, x: 12.35, y: 67.89, id: 7, pt: "touch", buttons: 1, primary: true });
    // `t` comes from event.timeStamp, not from when the handler happened to run.
    expect(pointers[1].t).toBe(16.5);
    expect(pointers[2].t).toBe(32.25);
  });

  it("attaching a stage MID-recording starts hearing it immediately (renderer-swap remount)", () => {
    const first = stageEl();
    const detachFirst = reproRecorder.attachStage(first);
    reproRecorder.start();
    first.dispatchEvent(pointer("pointerdown", { x: 1, y: 1, t: 0 }));

    // What a renderer swap does: unmount (detach), mount a NEW stage element, attach it — all without the
    // recording being restarted, because restarting would throw away the run being captured.
    detachFirst();
    const second = stageEl();
    reproRecorder.attachStage(second);
    clock = 50;
    second.dispatchEvent(pointer("pointerdown", { x: 2, y: 2, t: 50 }));
    // …and the detached one is silent.
    first.dispatchEvent(pointer("pointerdown", { x: 99, y: 99, t: 60 }));

    const pointers = lines().filter((line) => line.kind === "pointer");
    expect(pointers.map((line) => line.x)).toEqual([1, 2]);
    expect(reproRecorder.stats().stages).toBe(1);
  });

  it("is idempotent about detaching, and survives a detach while off", () => {
    const stage = stageEl();
    const detach = reproRecorder.attachStage(stage);
    detach();
    detach();
    expect(reproRecorder.stats().stages).toBe(0);
  });

  it("records wheel and keydown, and a keyup is not a line", () => {
    const stage = stageEl();
    reproRecorder.attachStage(stage);
    reproRecorder.start();
    const wheel = new WheelEvent("wheel", { clientX: 5, clientY: 6, deltaX: 0, deltaY: -120, deltaMode: 0 });
    Object.defineProperty(wheel, "timeStamp", { value: 0 });
    stage.dispatchEvent(wheel);
    const down = new KeyboardEvent("keydown", { code: "KeyE", shiftKey: true });
    Object.defineProperty(down, "timeStamp", { value: 10 });
    window.dispatchEvent(down);
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyE" }));

    expect(lines().filter((line) => line.kind === "wheel")).toEqual([
      { t: 0, kind: "wheel", x: 5, y: 6, dx: 0, dy: -120, mode: 0 }
    ]);
    const keys = lines().filter((line) => line.kind === "key");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ code: "KeyE", shift: true, ctrl: false, alt: false, meta: false });
  });
});

describe("reproRecorder — wire taps through a real client", () => {
  it("captures BOTH directions from connectMirrorClient, with the frames verbatim", () => {
    reproRecorder.start();
    const { client, socket } = connect();
    socket.dispatchEvent(new Event("open"));
    const incoming = '{"type":"session","directView":true}';
    socket.emit(incoming);
    client.sendInput({ kind: "hover", coordX: 100, coordY: 200 });

    const wire = lines().filter((line) => typeof line.dir === "string");
    expect(wire.map((line) => line.dir)).toEqual(["in", "out"]);
    // The RAW frame, byte for byte — nothing is parsed or re-serialized on the way into the buffer.
    expect(wire[0].data).toBe(incoming);
    expect(JSON.parse(wire[1].data as string)).toMatchObject({ type: "input", kind: "hover", coordX: 100 });
  });

  it("captures a frame the WATCH GATE drops — the client ignoring it is the thing under investigation", () => {
    reproRecorder.start();
    const { client, socket } = connect(false); // gated: the mirror applies no scene-delta at all
    const delta = JSON.stringify({
      type: "scene-delta",
      full: true,
      upserts: [{ id: "1", name: "Root", nodeType: "Control" }],
      removedIds: [],
      orderedIds: ["1"]
    });
    socket.emit(delta);

    expect(client.state.revision).toBe(0); // proof the gate really did drop it
    const wire = lines().filter((line) => line.dir === "in");
    expect(wire).toHaveLength(1);
    expect(wire[0].data).toBe(delta);
  });

  it("captures a MALFORMED frame — a parse failure is evidence, not noise", () => {
    reproRecorder.start();
    const { socket } = connect();
    socket.emit("not json at all");
    expect(lines().filter((line) => line.dir === "in").map((line) => line.data)).toEqual(["not json at all"]);
  });

  it("records the socket lifecycle around the frames", () => {
    reproRecorder.start();
    const { socket } = connect();
    socket.dispatchEvent(new Event("open"));
    socket.close();
    expect(lines().filter((line) => line.kind === "ws").map((line) => line.ev)).toEqual(["ctor", "open", "close"]);
  });

  it("leaves the socket's own send working (the wrap is transparent)", () => {
    const { client, socket } = connect();
    client.sendInput({ kind: "hover", coordX: 1, coordY: 2 });
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toMatchObject({ type: "input" });
  });
});

describe("reproRecorder — the ring", () => {
  it("defaults to a 32 MB cap", () => {
    expect(reproRecorder.stats().capBytes).toBe(DEFAULT_REPRO_BUFFER_BYTES);
    expect(DEFAULT_REPRO_BUFFER_BYTES).toBe(32 * 1024 * 1024);
  });

  it("drops the OLDEST lines, stays under the cap, and counts what it dropped", () => {
    reproRecorder.start();
    reproRecorder.setBufferCapBytes(2000);
    for (let i = 0; i < 20; i++) {
      clock = i;
      reproRecorder.tapWireIn(frame(`f${i}`, 400));
    }
    const stats = reproRecorder.stats();
    expect(stats.bytes).toBeLessThanOrEqual(2000);
    expect(stats.droppedLines).toBeGreaterThan(0);
    expect(stats.droppedBytes).toBeGreaterThan(0);
    expect(stats.lines).toBe(20 - stats.droppedLines);

    // The SURVIVORS are the newest ones, in order — a flight recorder keeps the run-up to the bug, not the
    // start of the session.
    const tags = lines()
      .slice(1)
      .map((line) => JSON.parse(line.data as string).tag as string);
    expect(tags[tags.length - 1]).toBe("f19");
    expect(tags).toEqual(tags.slice().sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));

    // …and the accounting is in the file, not only in stats(): a recording that starts mid-gesture has to SAY so.
    expect(meta().droppedLines).toBe(stats.droppedLines);
    expect(meta().droppedBytes).toBe(stats.droppedBytes);
    expect(meta().bufCapBytes).toBe(2000);
  });

  it("never drops the line that overflowed a cap smaller than one frame", () => {
    reproRecorder.start();
    reproRecorder.setBufferCapBytes(64);
    reproRecorder.tapWireIn(frame("huge", 5000));
    expect(reproRecorder.stats().lines).toBe(1);
    expect(reproRecorder.stats().droppedLines).toBe(0);
  });

  it("shrinking the cap trims immediately", () => {
    reproRecorder.start();
    for (let i = 0; i < 10; i++) {
      reproRecorder.tapWireIn(frame(`f${i}`, 400));
    }
    expect(reproRecorder.stats().droppedLines).toBe(0);
    reproRecorder.setBufferCapBytes(1000);
    expect(reproRecorder.stats().bytes).toBeLessThanOrEqual(1000);
    expect(reproRecorder.stats().droppedLines).toBeGreaterThan(0);
  });

  it("refuses a nonsense cap rather than jamming the ring shut", () => {
    reproRecorder.setBufferCapBytes(0);
    reproRecorder.setBufferCapBytes(-5);
    reproRecorder.setBufferCapBytes(Number.NaN);
    expect(reproRecorder.stats().capBytes).toBe(DEFAULT_REPRO_BUFFER_BYTES);
  });

  it("compacts its holes: 5000+ drops leave a correct, correctly-ordered file", () => {
    // Past COMPACT_AFTER_HOLES (4096) the ring slices its holes away. The reclaim is about MEMORY — until it
    // runs, dropped frames' strings are still reachable — but the thing that must not break is the file.
    reproRecorder.start();
    reproRecorder.setBufferCapBytes(1500);
    for (let i = 0; i < 5200; i++) {
      clock = i;
      reproRecorder.tapWireIn(frame(`f${i}`, 300));
    }
    const stats = reproRecorder.stats();
    expect(stats.droppedLines).toBeGreaterThan(4096);
    expect(stats.lines).toBe(5200 - stats.droppedLines);
    expect(stats.bytes).toBeLessThanOrEqual(1500);

    const tags = lines()
      .slice(1)
      .map((line) => JSON.parse(line.data as string).tag as string);
    expect(tags[tags.length - 1]).toBe("f5199");
    expect(new Set(tags).size).toBe(tags.length); // no duplicated survivor from a bad slice
  });

  it("re-arming starts a fresh recording (the previous ring described a different question)", () => {
    reproRecorder.start();
    reproRecorder.tapWireIn(frame("old", 100));
    reproRecorder.marker();
    reproRecorder.stop();
    // The buffer SURVIVES a stop, so a viewer who flipped the switch off has not lost their evidence yet.
    expect(reproRecorder.stats().lines).toBe(2);
    reproRecorder.start();
    expect(reproRecorder.stats().lines).toBe(0);
    expect(reproRecorder.stats().markers).toBe(0);
  });
});

describe("reproRecorder — the keyframe seed", () => {
  // A `scene-delta` frame's FIRST field is `full`, which is what lets the seed probe read the head of the string
  // instead of scanning a multi-megabyte keyframe. These stand in for the real thing at that shape.
  const keyframe = (bytes = 400) => `{"full":true,"screenType":"combat","upserts":["${"x".repeat(bytes)}"]}`;
  const delta = (tag: string, bytes = 400) => `{"full":false,"screenType":"combat","upserts":["${tag}${"x".repeat(bytes)}"]}`;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("marks the arriving keyframe as the point a replay may start from", () => {
    reproRecorder.start();
    clock = 10;
    reproRecorder.tapWireIn(delta("before"));
    clock = 40;
    reproRecorder.tapWireIn(keyframe());
    clock = 70;
    reproRecorder.tapWireIn(delta("after"));

    expect(reproRecorder.stats().selfContained).toBe(true);
    // `t` is measured from the file's own first line (t=10 here), so the seed is at 30, not 40.
    expect(meta().seedAtMs).toBe(30);
    expect(meta().seedKind).toBe("connect");
    expect(meta().resyncRequests).toBe(0);
  });

  it("says so when the ring holds no keyframe: readable, but not replayable", () => {
    reproRecorder.start();
    reproRecorder.tapWireIn(delta("orphan"));
    expect(reproRecorder.stats().selfContained).toBe(false);
    expect(meta().seedAtMs).toBeNull();
    expect(meta().seedKind).toBeNull();
  });

  it("only reads the HEAD of a frame, so a payload that merely CONTAINS the flag is not a seed", () => {
    reproRecorder.start();
    reproRecorder.tapWireIn(`{"full":false,"upserts":["${"x".repeat(200)}"],"note":"full\\":true"}`);
    reproRecorder.tapWireIn(JSON.stringify({ pad: "x".repeat(200), full: true }));
    expect(reproRecorder.stats().selfContained).toBe(false);
  });

  it("asks for a keyframe when it is armed mid-session, and stops asking once one lands", async () => {
    let asked = 0;
    reproRecorder.setResyncRequester(() => (asked += 1) > 0);
    reproRecorder.start();
    // Deferred: the requester sends on the socket, whose `send` is itself tapped, so it must never run inside
    // the ring's own push path.
    expect(asked).toBe(0);
    await tick();
    expect(asked).toBe(1);

    reproRecorder.tapWireIn(keyframe());
    expect(meta().seedKind).toBe("resync");
    expect(meta().resyncRequests).toBe(1);
    await tick();
    expect(asked).toBe(1);
  });

  it("asks again — exactly once — when the seed falls out of the ring, and not for any other drop", async () => {
    let asked = 0;
    reproRecorder.setResyncRequester(() => (asked += 1) > 0);
    reproRecorder.start();
    await tick(); // the arm-time want
    expect(asked).toBe(1);
    // ~490 bytes a line against a 2000-byte cap: the ring holds four, so each new line retires exactly one.
    reproRecorder.setBufferCapBytes(2000);
    for (let i = 0; i < 3; i++) {
      clock = i;
      reproRecorder.tapWireIn(delta(`d${i}`));
    }
    reproRecorder.tapWireIn(keyframe());
    await tick();
    expect(asked).toBe(1);

    // Ordinary drops (the three deltas that preceded the keyframe) are an accounting matter, not a
    // replayability one — the ring says nothing to the host about them.
    for (let i = 3; i < 6; i++) {
      clock = i;
      reproRecorder.tapWireIn(delta(`d${i}`));
    }
    await tick();
    expect(reproRecorder.stats().droppedLines).toBe(3);
    expect(reproRecorder.stats().selfContained).toBe(true);
    expect(asked).toBe(1);

    // …until the drop takes the KEYFRAME with it.
    for (let i = 6; i < 9; i++) {
      clock = i;
      reproRecorder.tapWireIn(delta(`d${i}`));
    }
    expect(reproRecorder.stats().selfContained).toBe(false);
    await tick();
    expect(asked).toBe(2);
    await tick();
    expect(asked).toBe(2); // one request in flight, not one per subsequent frame
  });

  it("keeps the lines that PRECEDE a replacement keyframe — hindsight is the whole point of a ring", async () => {
    reproRecorder.setResyncRequester(() => true);
    reproRecorder.start();
    clock = 1;
    reproRecorder.tapWireIn(delta("early", 40));
    clock = 2;
    reproRecorder.marker("the bug");
    clock = 3;
    reproRecorder.tapWireIn(keyframe(40));
    await tick();

    const body = lines().slice(1);
    expect(body.some((line) => typeof line.data === "string" && line.data.includes("early"))).toBe(true);
    expect(body.some((line) => line.kind === "marker")).toBe(true);
    expect(meta().seedAtMs).toBe(2);
  });

  it("leaves the want standing when the request cannot go out, and retries on the next drop", async () => {
    let open = false;
    let asked = 0;
    reproRecorder.setResyncRequester(() => {
      asked += 1;
      return open;
    });
    reproRecorder.start();
    await tick();
    expect(asked).toBe(1); // …and returned false: nothing was sent

    open = true;
    reproRecorder.setBufferCapBytes(1200);
    for (let i = 0; i < 6; i++) {
      clock = i;
      reproRecorder.tapWireIn(delta(`d${i}`));
    }
    await tick();
    expect(asked).toBe(2);
  });

  it("re-seeds a REAL client with the watch gate — the wire the requester rides is the one that exists", async () => {
    // MirrorApp's requester, in miniature: the recorder has no client, and the client needs no new message —
    // turning the stream gate off and back on is what makes the host resend a full keyframe.
    const { client, socket } = connect();
    reproRecorder.setResyncRequester(() => {
      client.sendWatch(false);
      client.sendWatch(true);
      return true;
    });
    reproRecorder.start(); // armed mid-session ⇒ wants a seed
    socket.sent.length = 0;
    await tick();

    expect(socket.sent).toEqual(['{"type":"watch","on":false}', '{"type":"watch","on":true}']);
    // The viewer is left watching exactly as they were — a re-seed is not a change of intent.
    expect(client.watching).toBe(true);
    // …and the recorder captured the request it caused, so the file shows why the keyframe is there.
    expect(lines().filter((line) => line.dir === "out")).toHaveLength(2);
  });
});

describe("reproRecorder — markers", () => {
  it("numbers markers from 1, carries an optional note, and writes BOTH a line and a meta entry", () => {
    reproRecorder.start();
    clock = 100;
    expect(reproRecorder.marker()).toBe(1);
    clock = 250.5;
    expect(reproRecorder.marker("card jumped")).toBe(2);

    const markerLines = lines().filter((line) => line.kind === "marker");
    expect(markerLines).toEqual([
      { t: 0, kind: "marker", n: 1 },
      { t: 150.5, kind: "marker", n: 2, note: "card jumped" }
    ]);
    // The meta copy is what lets an offline tool find the marks without walking the file first.
    expect(meta().markers).toEqual([
      { n: 1, t: 0 },
      { n: 2, t: 150.5, note: "card jumped" }
    ]);
    expect(reproRecorder.stats().markers).toBe(2);
  });

  it("forgets meta markers that fell off the front of the ring", () => {
    reproRecorder.start();
    reproRecorder.setBufferCapBytes(1200);
    clock = 0;
    reproRecorder.marker("early");
    for (let i = 0; i < 30; i++) {
      clock = 10 + i;
      reproRecorder.tapWireIn(frame(`f${i}`, 400));
    }
    // The mark itself is gone from the buffer, so quoting it in the header would point at a line that is not in
    // the file — a `t` measured against a dropped origin is worse than a missing marker.
    expect(lines().filter((line) => line.kind === "marker")).toHaveLength(0);
    expect(meta().markers).toEqual([]);
    // …but the COUNT still reflects everything the session marked.
    expect(reproRecorder.stats().markers).toBe(1);
  });
});

describe("reproRecorder — the serialized file", () => {
  it("is ndjson: meta first, then one JSON line per event, ending in a newline", () => {
    reproRecorder.start();
    clock = 5;
    reproRecorder.tapWireIn('{"type":"scene-delta"}');
    const text = reproRecorder.serialize();
    expect(text.endsWith("\n")).toBe(true);
    const parsed = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(parsed[0].meta.format).toBe(REPRO_FORMAT);
    expect(parsed[0].meta.format).toBe("repro/1");
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toEqual({ t: 0, dir: "in", data: '{"type":"scene-delta"}' });
  });

  it("measures `t` from the FIRST SURVIVING line, to 3 decimal places", () => {
    reproRecorder.start();
    // A real `performance.now()` is a big number with a long fraction; `t` is the DIFFERENCE from the first
    // surviving line, quantised to microseconds so a 23 MB file doesn't spend a tenth of itself on noise digits.
    clock = 1_000_000;
    reproRecorder.tapWireIn("a");
    clock = 1_000_000.1234;
    reproRecorder.tapWireIn("b");
    clock = 1_000_001.5;
    reproRecorder.tapWireIn("c");
    const body = lines().slice(1);
    expect(body.map((line) => line.t)).toEqual([0, 0.123, 1.5]);
    expect(meta().durationMs).toBe(1.5);
    expect(meta().lines).toBe(3);
  });

  it("merges the app's meta supplier into the header, and survives a supplier that throws", () => {
    reproRecorder.setMetaSupplier(() => ({ designWidth: 2400, settings: { raiseHandCards: true } }));
    reproRecorder.start();
    reproRecorder.tapWireIn("a");
    expect(meta()).toMatchObject({
      format: "repro/1",
      designWidth: 2400,
      settings: { raiseHandCards: true }
    });
    expect(typeof meta().recordedAt).toBe("string");
    expect(meta().viewport).toEqual({ w: window.innerWidth, h: window.innerHeight });

    reproRecorder.setMetaSupplier(() => {
      throw new Error("stage is gone");
    });
    // A meta snapshot must never be the reason a recording cannot be saved.
    expect(() => reproRecorder.serialize()).not.toThrow();
    expect(meta().format).toBe("repro/1");
  });

  it("is a valid input for the existing recording readers: `dir:\"in\"` lines carry {t,data}", () => {
    // The replay server / bench loaders take `{t, data}` and skip everything else — which is what makes a repro
    // file replayable by the tools that already exist (they gained one `dir === "out"` guard, nothing more).
    reproRecorder.start();
    reproRecorder.tapWireIn('{"type":"scene-delta"}');
    clock = 8;
    reproRecorder.tapWireOut('{"type":"input"}');
    const inbound = lines()
      .slice(1)
      .filter((line) => line.dir !== "out" && typeof line.data === "string");
    expect(inbound).toEqual([{ t: 0, dir: "in", data: '{"type":"scene-delta"}' }]);
  });
});

describe("reproRecorder — save", () => {
  it("hands the browser an ndjson blob under a filesystem-safe name, and KEEPS recording", async () => {
    const blobs: Blob[] = [];
    const created = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:repro";
    });
    const revoked = vi.fn();
    const nativeCreate = URL.createObjectURL;
    const nativeRevoke = URL.revokeObjectURL;
    URL.createObjectURL = created as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revoked as unknown as typeof URL.revokeObjectURL;
    const clicked: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.download);
      });

    try {
      reproRecorder.start();
      reproRecorder.tapWireIn('{"type":"scene-delta"}');
      const result = reproRecorder.save();

      expect(created).toHaveBeenCalledTimes(1);
      expect(blobs[0].type).toBe("application/x-ndjson");
      // The blob IS the file: same body lines, same header shape. (`recordedAt` is stamped at serialize time, so
      // a byte compare against a second serialize() would only be measuring the clock.)
      const written = (await blobs[0].text()).split("\n").filter((line) => line.length > 0);
      expect(written.slice(1)).toEqual(reproRecorder.serialize().split("\n").filter(Boolean).slice(1));
      expect(JSON.parse(written[0]).meta).toMatchObject({ format: "repro/1", lines: 1 });
      expect(clicked).toHaveLength(1);
      // ISO 8601 punctuation is illegal in a filename on the platforms these files land on.
      expect(clicked[0]).toMatch(/^repro-\d{4}-\d{2}-\d{2}T[\d-]+Z\.ndjson$/);
      expect(clicked[0]).toBe(result.name);
      expect(result.lines).toBe(1);
      expect(result.bytes).toBe(reproRecorder.serialize().length);
      // No anchor is left behind in the document.
      expect(document.querySelectorAll("a[download]")).toHaveLength(0);

      // Saving does NOT stop the recording — a bug that just happened often happens again.
      expect(reproRecorder.stats().recording).toBe(true);
      reproRecorder.tapWireIn('{"type":"scene-delta","n":2}');
      expect(reproRecorder.stats().lines).toBe(2);
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = nativeCreate;
      URL.revokeObjectURL = nativeRevoke;
    }
  });

  it("still reports a result where the environment offers no object URLs", () => {
    // A browser that refuses object URLs (and the bare-Node case the offline tools import this module in) must
    // get a described failure, not a throw out of the middle of a save.
    vi.stubGlobal("URL", {});
    try {
      reproRecorder.start();
      reproRecorder.tapWireIn("a");
      const result = reproRecorder.save();
      expect(result.lines).toBe(1);
      expect(result.name).toMatch(/\.ndjson$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
