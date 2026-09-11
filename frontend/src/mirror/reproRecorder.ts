// THE REPRO RECORDER — a client-side flight recorder that captures everything the mirror is driven by, so a bug
// a player hit on their phone can be replayed here instead of guessed at from prose.
//
// WHY THIS IS ENOUGH. The mirror is a pure function of two inputs: the incoming websocket scene stream, and the
// viewer's pointer/wheel/key events. Both are timestamped on the SAME `performance.now()` origin (a
// PointerEvent's `timeStamp` is that clock), so writing both halves into one ordered file makes the session
// deterministically replayable — which beats a video, because a video only shows the symptom while this carries
// the cause. Nothing else recorded the outgoing/pointer half before this module.
//
// FLIGHT-RECORDER SEMANTICS. There is no "record from here" — a player cannot know a bug is coming. While armed
// the recorder runs continuously into a byte-capped ring (default 32 MB, drop-oldest), the player taps MARKER the
// moment they see the bug, and SAVE writes the ring out. A combat stream runs 89–622 KB/s, so 32 MB is roughly
// 1–6 minutes of hindsight. Whatever the ring had to drop is ACCOUNTED FOR in the file's meta (`droppedLines` /
// `droppedBytes`) rather than silently vanishing, because "the recording starts mid-gesture" is otherwise
// indistinguishable from "the client sent nothing".
//
// COST WHEN OFF IS ZERO, and that is a design constraint, not a hope: the taps early-out on one boolean, and the
// stage/window listeners are ATTACHED ONLY WHILE RECORDING (see installListeners) — a viewer who never turns this
// on does not carry an extra capture-phase pointer listener on the hottest input path in the app.
//
// THE ONE THING IT ASKS FOR. A ring that has wrapped no longer holds the keyframe its deltas patch, and such a
// file is readable but not replayable — which is what the first phone repro of the canvas hand-landing bug turned
// out to be. So the recorder asks the host for a fresh keyframe when it is armed mid-session and whenever the seed
// it holds falls out of the ring (`ReproResyncRequester`, `wantSeed`). That is the only way this module perturbs
// the session, it is event-driven rather than periodic, and `meta.seedAtMs` reports where a replay may start.
//
// COST WHEN ON IS ONE ARRAY PUSH. Wire frames are stored as the RAW STRING REFERENCE handed to us by the socket;
// nothing is parsed, copied or serialized until `save()`. The recorder holds strings the page already holds.
//
// ZERO MIRROR IMPORTS, on purpose. This module is tapped from inside `mirrorClient`'s import graph, so importing
// anything from the mirror would risk a cycle; the one thing it needs from the app (a meta snapshot: settings,
// design width, stage rect) arrives through `setMetaSupplier`, which MirrorApp installs.
//
// FILE FORMAT — ndjson, `format: "repro/1"`:
//   line 1   {"meta":{format,recordedAt,url,ua,viewport,dpr,…supplier fields…,bufCapBytes,droppedLines,
//                     droppedBytes,markers,lines,durationMs,seedAtMs,seedKind,resyncRequests}}
//   wire     {"t":<ms>,"dir":"in"|"out","data":"<raw frame verbatim>"}
//   input    {"t":<ms>,"kind":"pointer","type":"down"|"move"|"up"|"cancel","x","y","id","pt","button","buttons",
//                     "primary"}
//            {"t":<ms>,"kind":"wheel","x","y","dx","dy","mode"}
//            {"t":<ms>,"kind":"key","code","alt","ctrl","meta","shift"}
//   marks    {"t":<ms>,"kind":"marker","n",["note"]}
//   session  {"t":<ms>,"kind":"ws","ev":"ctor"|"open"|"close",["url"]}
//            {"t":<ms>,"kind":"resize","w","h","dpr"}
//
// `t` is milliseconds since THE FIRST LINE IN THE FILE (3 decimal places) — i.e. since the oldest line the ring
// still holds, not since the recorder was armed, because after a drop the armed instant is no longer in the file
// and a `t` measured from it would point at nothing. The `dir:"in"` lines alone are a superset of what
// `scripts/record-mirror-stream.mjs` writes, which is what lets a repro file feed the existing replay server and
// bench unchanged (their loaders skip everything else — see the `dir === "out"` guards).

/** One buffered line: when it happened, what it will cost the ring, and the line body after `t`. */
interface ReproEntry {
  /** Absolute timestamp on the page's `performance.now()` clock. Normalised to a relative `t` at save. */
  at: number;
  /** Approximate serialized size — the currency the ring's byte cap is spent in. */
  cost: number;
  /** Everything after `t` on the line, in emission order (spread after `t` by the serializer). */
  line: Record<string, unknown>;
}

/** One MARKER the player dropped, as it is recorded (absolute clock; relativised at save). */
interface ReproMarker {
  n: number;
  at: number;
  note?: string;
}

/** What `save()` reports back (the badge shows the name; the tests assert the byte/line counts). */
export interface ReproSaveResult {
  name: string;
  bytes: number;
  lines: number;
}

/** A live read of the ring, for the badge and for `window.__mirrorRepro.stats()`. */
export interface ReproStats {
  recording: boolean;
  /** Lines currently held (excludes anything already dropped). */
  lines: number;
  /** Approximate bytes held, against `capBytes`. */
  bytes: number;
  capBytes: number;
  /** 0..1 — how full the ring is. Once this pins at 1 the recorder is dropping its oldest lines. */
  fill: number;
  droppedLines: number;
  droppedBytes: number;
  markers: number;
  /** ms since `start()` (0 when off). */
  elapsedMs: number;
  /** ms spanned by the lines actually held — the hindsight the file would carry if saved now. */
  spanMs: number;
  /** Stage elements currently attached (0 pre-mount / post-unmount). */
  stages: number;
  /**
   * Does the ring still hold a `full:true` keyframe? False means a file saved right now carries deltas with
   * nothing to patch — i.e. it can be read but not replayed. Normally true within a frame of a wrap, because a
   * dropped keyframe is what triggers the request for the next one.
   */
  selfContained: boolean;
  /** How many keyframes this recording has asked the host for (0 on a session that never wrapped). */
  resyncRequests: number;
}

/** The app-supplied half of the meta bag (settings snapshot, design width, stage rect — see MirrorApp). */
export type ReproMetaSupplier = () => Record<string, unknown>;

/**
 * Asks the host for a fresh FULL keyframe. Returns false when the request could not go out (no client yet, socket
 * not open), which leaves the want standing so the next drop retries it.
 *
 * WHY THE RECORDER NEEDS ONE. A ring that has wrapped no longer holds the keyframe its deltas patch, and a delta
 * stream without its keyframe is not a recording of anything: ids reference nodes that were never introduced, the
 * draw order arrives as `orderPatch` against an order the reader does not have. That is exactly what the first
 * phone repro of the hand-landing bug turned out
 * to be — 60s of perfectly good wire that no replayer can load.
 *
 * The client already has the wire for it and needs no new message: `sendWatch(false); sendWatch(true)` toggles the
 * stream gate, and turning it back ON makes the host answer with a full keyframe (see MirrorClient.sendWatch).
 * MirrorApp supplies the closure; this module stays free of mirror imports.
 */
export type ReproResyncRequester = () => boolean;

export const REPRO_FORMAT = "repro/1";

/** 32 MB ≈ 1–6 minutes of combat wire. Overridable per session via `?reproBufMb=` (MirrorApp), never persisted. */
export const DEFAULT_REPRO_BUFFER_BYTES = 32 * 1024 * 1024;

// A dropped line leaves a hole rather than shifting the array (an unshift per drop would be O(n) on a hot path).
// The holes are reclaimed in one `slice` once there are enough of them to be worth the copy — and the reclaim
// matters for MEMORY, not for speed: until it runs, the dropped entries' frame strings are still reachable, so a
// ring that has "dropped" 32 MB would otherwise still be holding it.
const COMPACT_AFTER_HOLES = 4096;

// What a non-wire line costs the ring. These are short, fixed-shape lines (a pointer line is ~90 bytes), and the
// alternative — serializing each one at push time to measure it exactly — is precisely the hot-path work this
// recorder exists to avoid. Overshooting slightly is the safe direction: the ring drops a little early rather
// than holding more than the cap promises.
const KIND_LINE_COST = 96;

// The per-line overhead of a wire line beyond its payload: `{"t":1234.567,"dir":"in","data":"…"}` plus the JSON
// escaping the payload picks up when it is finally stringified.
const WIRE_LINE_OVERHEAD = 40;

// ---------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------

let recording = false;
let capBytes = DEFAULT_REPRO_BUFFER_BYTES;
/** Holes (dropped entries) are nulled in place so their payload strings become collectable immediately. */
let entries: (ReproEntry | null)[] = [];
let head = 0;
let bytes = 0;
let droppedLines = 0;
let droppedBytes = 0;
let markers: ReproMarker[] = [];
let startedAt = 0;
let metaSupplier: ReproMetaSupplier | null = null;

// ---- the keyframe seed (see ReproResyncRequester) --------------------------------------------------------
//
// `seedEntry` is the newest `full:true` line the ring still holds — the point a replay can start from. It is a
// REFERENCE into the ring rather than an index, because the ring compacts by re-slicing the array; the entry
// object survives that, an index would not.
let resyncRequester: ReproResyncRequester | null = null;
let seedEntry: ReproEntry | null = null;
let seedKind: "connect" | "resync" | null = null;
let resyncRequests = 0;
/** A request has gone out and its keyframe has not arrived yet — don't ask again on top of it. */
let resyncPending = false;
/** A keyframe is WANTED (armed mid-session, or the seed just fell out of the ring) and not yet asked for. */
let seedWanted = false;
let pumpScheduled = false;

const stages = new Set<HTMLElement>();
let listening = false;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------------------------------------

function push(at: number, cost: number, line: Record<string, unknown>): void {
  entries.push({ at, cost, line });
  bytes += cost;
  trim();
  if (head >= COMPACT_AFTER_HOLES) {
    entries = entries.slice(head);
    head = 0;
  }
}

// Drop oldest until the ring fits. The LAST entry is never dropped: a cap smaller than a single frame must still
// leave the file with the line that overflowed it, or a `?reproBufMb=1` session against a 2 MB keyframe would
// record nothing at all and look like a broken recorder.
//
// Dropping the SEED (the keyframe every retained delta patches) is the one loss the ring cannot just account for
// in the meta, because it costs the file its replayability rather than its length — so that drop, and only that
// drop, asks the host for a replacement. Pre-seed lines are deliberately NOT trimmed when the replacement lands:
// they are still evidence (pointer history, the wire that preceded the bug), they cost nothing the cap does not
// already bound, and the ring will retire them on its own schedule. An offline reader starts at `seedAtMs`.
function trim(): void {
  let droppedAny = false;
  while (bytes > capBytes && head < entries.length - 1) {
    const dropped = entries[head];
    entries[head] = null;
    head += 1;
    if (dropped) {
      bytes -= dropped.cost;
      droppedBytes += dropped.cost;
      droppedLines += 1;
      droppedAny = true;
      if (dropped === seedEntry) {
        seedEntry = null;
        seedKind = null;
      }
    }
  }
  if (droppedAny && !seedEntry) {
    wantSeed();
  }
}

// A keyframe is ~MBs and a full producer walk on the host, so it is asked for on EVENTS (armed, seed dropped) and
// never on a timer — a debug tool is still not allowed to make the game stutter periodically.
function wantSeed(): void {
  if (!recording || resyncPending) {
    return;
  }
  seedWanted = true;
  pumpSeed();
}

function pumpSeed(): void {
  if (pumpScheduled || !seedWanted || resyncPending || !resyncRequester || typeof setTimeout !== "function") {
    return;
  }
  // Deferred out of the caller's stack on purpose: the requester sends on the socket, the socket's `send` is
  // itself tapped (tapWireOut → push → trim), so requesting from inside `trim()` would re-enter the ring
  // mid-drop. A timeout also lets an arm-time want wait for the client MirrorApp installs later in the same tick.
  pumpScheduled = true;
  setTimeout(() => {
    pumpScheduled = false;
    if (!recording || !seedWanted || resyncPending || !resyncRequester) {
      return;
    }
    let sent = false;
    try {
      sent = resyncRequester() !== false;
    } catch {
      // A requester that throws is a client mid-teardown; the next drop asks again.
      sent = false;
    }
    if (sent) {
      seedWanted = false;
      resyncPending = true;
      resyncRequests += 1;
    }
  }, 0);
}

// `{"full":true,…}` is the first field of a `scene-delta` frame, so this is a fixed-cost look at the head of the
// string rather than a scan of a multi-megabyte keyframe. `lastIndexOf(needle, from)` searches BACKWARDS from
// `from`, which is what bounds it.
const KEYFRAME_PROBE_CHARS = 64;

function isKeyframeFrame(data: string): boolean {
  return data.lastIndexOf('"full":true', KEYFRAME_PROBE_CHARS) !== -1;
}

function liveEntries(): ReproEntry[] {
  const out: ReproEntry[] = [];
  for (let i = head; i < entries.length; i++) {
    const entry = entries[i];
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}

function reset(): void {
  entries = [];
  head = 0;
  bytes = 0;
  droppedLines = 0;
  droppedBytes = 0;
  markers = [];
  seedEntry = null;
  seedKind = null;
  resyncRequests = 0;
  resyncPending = false;
  seedWanted = false;
}

// ---------------------------------------------------------------------------------------------------------
// Listeners (installed ONLY while recording)
// ---------------------------------------------------------------------------------------------------------

// Capture phase, so these run strictly BEFORE inputCapture's own bubble-phase handlers on the same stage element
// and see the raw, untouched event — inputCapture calls `preventDefault()` on a press, and a recording taken
// after that would be a recording of the mirror's reaction rather than of the player's gesture. Passive, so
// adding a recorder can never change scroll behaviour: this listener is not allowed an opinion.
const STAGE_LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };
const WINDOW_LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };

const POINTER_TYPES: Record<string, "down" | "move" | "up" | "cancel"> = {
  pointerdown: "down",
  pointermove: "move",
  pointerup: "up",
  pointercancel: "cancel"
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function onPointer(event: Event): void {
  if (!recording) {
    return;
  }
  const type = POINTER_TYPES[event.type];
  if (!type) {
    return;
  }
  const pointer = event as PointerEvent;
  push(pointer.timeStamp, KIND_LINE_COST, {
    kind: "pointer",
    type,
    // RAW client coordinates. The mirror's own game-space mapping is exactly the thing under suspicion in an
    // input bug, so what is recorded is the browser's number, before any of it.
    x: round2(pointer.clientX),
    y: round2(pointer.clientY),
    id: pointer.pointerId,
    pt: pointer.pointerType,
    button: pointer.button,
    buttons: pointer.buttons,
    primary: pointer.isPrimary
  });
}

function onWheel(event: Event): void {
  if (!recording) {
    return;
  }
  const wheel = event as WheelEvent;
  push(wheel.timeStamp, KIND_LINE_COST, {
    kind: "wheel",
    x: round2(wheel.clientX),
    y: round2(wheel.clientY),
    dx: round2(wheel.deltaX),
    dy: round2(wheel.deltaY),
    mode: wheel.deltaMode
  });
}

// keydown only: the mirror's key channel is a tap (`pressed` omitted), so a keyup carries nothing a replay needs.
function onKeyDown(event: Event): void {
  if (!recording) {
    return;
  }
  const key = event as KeyboardEvent;
  push(key.timeStamp, KIND_LINE_COST, {
    kind: "key",
    code: key.code,
    alt: key.altKey,
    ctrl: key.ctrlKey,
    meta: key.metaKey,
    shift: key.shiftKey
  });
}

// The viewport is an INPUT to the mirror (letterbox scale, widescreen spread, the anchor re-layout), so a resize
// mid-recording is part of the reproduction, not noise.
function onResize(): void {
  if (!recording || typeof window === "undefined") {
    return;
  }
  push(now(), KIND_LINE_COST, {
    kind: "resize",
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio
  });
}

function addStageListeners(stage: HTMLElement): void {
  stage.addEventListener("pointerdown", onPointer, STAGE_LISTENER_OPTIONS);
  stage.addEventListener("pointermove", onPointer, STAGE_LISTENER_OPTIONS);
  stage.addEventListener("pointerup", onPointer, STAGE_LISTENER_OPTIONS);
  stage.addEventListener("pointercancel", onPointer, STAGE_LISTENER_OPTIONS);
  stage.addEventListener("wheel", onWheel, STAGE_LISTENER_OPTIONS);
}

function removeStageListeners(stage: HTMLElement): void {
  stage.removeEventListener("pointerdown", onPointer, STAGE_LISTENER_OPTIONS);
  stage.removeEventListener("pointermove", onPointer, STAGE_LISTENER_OPTIONS);
  stage.removeEventListener("pointerup", onPointer, STAGE_LISTENER_OPTIONS);
  stage.removeEventListener("pointercancel", onPointer, STAGE_LISTENER_OPTIONS);
  stage.removeEventListener("wheel", onWheel, STAGE_LISTENER_OPTIONS);
}

function installListeners(): void {
  if (listening) {
    return;
  }
  listening = true;
  for (const stage of stages) {
    addStageListeners(stage);
  }
  if (typeof window !== "undefined") {
    // Keys and resizes are not the stage's to hear — a viewer on the join picker has no stage at all, and the
    // mirror's own key channel listens at the window (inputCapture.ts).
    window.addEventListener("keydown", onKeyDown, WINDOW_LISTENER_OPTIONS);
    window.addEventListener("resize", onResize, WINDOW_LISTENER_OPTIONS);
  }
}

function removeListeners(): void {
  if (!listening) {
    return;
  }
  listening = false;
  for (const stage of stages) {
    removeStageListeners(stage);
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("keydown", onKeyDown, WINDOW_LISTENER_OPTIONS);
    window.removeEventListener("resize", onResize, WINDOW_LISTENER_OPTIONS);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Serialization (the ONLY place a frame is touched after it was buffered)
// ---------------------------------------------------------------------------------------------------------

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function buildMeta(live: ReproEntry[], origin: number): Record<string, unknown> {
  const supplied = (() => {
    try {
      return metaSupplier?.() ?? {};
    } catch {
      // A meta snapshot must never be the reason a recording cannot be saved.
      return {};
    }
  })();
  const durationMs = live.length ? round3(live[live.length - 1].at - origin) : 0;
  return {
    format: REPRO_FORMAT,
    recordedAt: new Date().toISOString(),
    url: typeof location !== "undefined" ? location.href : null,
    ua: typeof navigator !== "undefined" ? navigator.userAgent : null,
    viewport:
      typeof window !== "undefined" ? { w: window.innerWidth, h: window.innerHeight } : null,
    dpr: typeof window !== "undefined" ? window.devicePixelRatio : null,
    ...supplied,
    bufCapBytes: capBytes,
    droppedLines,
    droppedBytes,
    // Relativised onto the file's own clock, so a marker can be found without replaying anything.
    markers: markers
      .filter((marker) => marker.at >= origin)
      .map((marker) => ({ n: marker.n, t: round3(marker.at - origin), ...(marker.note ? { note: marker.note } : {}) })),
    lines: live.length,
    durationMs,
    // WHERE A REPLAY STARTS. The `t` of the newest `full:true` line the file still holds, or null when the ring
    // wrapped and the replacement had not landed by save time (a readable file that cannot be replayed — say so
    // rather than let a tool discover it as 300 parse errors). `seedKind` says whether it is the connect-time
    // keyframe or one this recorder asked for.
    seedAtMs: seedEntry ? round3(seedEntry.at - origin) : null,
    seedKind,
    resyncRequests
  };
}

/** The exact bytes `save()` writes. Separated so tests (and a console session) can read a recording in place. */
function serialize(): string {
  const live = liveEntries();
  const origin = live.length ? live[0].at : 0;
  const out: string[] = [JSON.stringify({ meta: buildMeta(live, origin) })];
  for (const entry of live) {
    out.push(JSON.stringify({ t: round3(entry.at - origin), ...entry.line }));
  }
  return `${out.join("\n")}\n`;
}

// ISO 8601 has characters Windows/Android refuse in a filename, so the punctuation is flattened. The stem is what
// the offline tools name their artifact directory after.
function saveName(): string {
  return `repro-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
}

// ---------------------------------------------------------------------------------------------------------
// The public singleton
// ---------------------------------------------------------------------------------------------------------

export interface ReproRecorder {
  start(): void;
  stop(): void;
  /** Drop a numbered mark at "the bug is on screen NOW". Returns the marker's number (1-based). */
  marker(note?: string): number;
  /** Serialize + hand the file to the browser's downloader. Recording CONTINUES (a bug often repeats). */
  save(): ReproSaveResult;
  /** The exact ndjson `save()` would write, without downloading it. */
  serialize(): string;
  stats(): ReproStats;
  setMetaSupplier(supplier: ReproMetaSupplier | null): void;
  /** Install the "ask the host for a keyframe" closure (MirrorApp owns it — this module has no client). */
  setResyncRequester(requester: ReproResyncRequester | null): void;
  setBufferCapBytes(value: number): void;
  tapWireIn(data: string): void;
  tapWireOut(data: unknown): void;
  tapWsLifecycle(ev: "ctor" | "open" | "close", url?: string): void;
  /** Attach a stage element's input listeners; returns the detach. Safe to call mid-recording (a renderer swap
   *  remounts MirrorView, and the new stage must be heard without restarting the recording). */
  attachStage(stage: HTMLElement): () => void;
  /** TEST SEAM ONLY: forget every buffered line, marker and stage. */
  __resetForTests(): void;
}

export const reproRecorder: ReproRecorder = {
  start(): void {
    if (recording) {
      return;
    }
    // A fresh arming is a fresh recording: the ring from a previous session describes a different question, and
    // silently prepending it would make the file's own `t=0` a lie about when the player started watching.
    reset();
    recording = true;
    startedAt = now();
    installListeners();
    // Arming mid-session (the settings toggle, `?repro=on` after connect) starts the ring between two keyframes,
    // so ask for one now. A recorder armed at page setup gets the CONNECT keyframe first and this want is
    // satisfied by it — `tapWireIn` clears the want on any keyframe, whoever asked for it.
    wantSeed();
  },

  stop(): void {
    if (!recording) {
      return;
    }
    recording = false;
    removeListeners();
    // The ring SURVIVES a stop on purpose: a viewer who switches the toggle off before saving has not thrown
    // their evidence away, and `window.__mirrorRepro.save()` can still write it.
  },

  marker(note?: string): number {
    const n = markers.length + 1;
    const at = now();
    markers.push({ n, at, ...(note ? { note } : {}) });
    // Also a LINE, not only a meta entry: the offline tools walk the file in order, and a marker that existed
    // only in the header would have to be re-located by timestamp against lines that may have been dropped.
    push(at, KIND_LINE_COST, { kind: "marker", n, ...(note ? { note } : {}) });
    return n;
  },

  save(): ReproSaveResult {
    const text = serialize();
    const name = saveName();
    const result: ReproSaveResult = { name, bytes: text.length, lines: liveEntries().length };
    if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return result;
    }
    const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked LATE: a same-tick revoke races the browser's own read of the object URL on some mobile browsers,
    // and the failure mode is a zero-byte download the player only discovers after the session is over.
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Nothing to do — the URL is going away with the page anyway.
      }
    }, 10_000);
    return result;
  },

  serialize,

  stats(): ReproStats {
    const live = liveEntries();
    const span = live.length ? live[live.length - 1].at - live[0].at : 0;
    return {
      recording,
      lines: live.length,
      bytes,
      capBytes,
      fill: capBytes > 0 ? Math.min(1, bytes / capBytes) : 0,
      droppedLines,
      droppedBytes,
      markers: markers.length,
      elapsedMs: recording ? now() - startedAt : 0,
      spanMs: round3(span),
      stages: stages.size,
      selfContained: seedEntry !== null,
      resyncRequests
    };
  },

  setMetaSupplier(supplier: ReproMetaSupplier | null): void {
    metaSupplier = supplier;
  },

  setResyncRequester(requester: ReproResyncRequester | null): void {
    resyncRequester = requester;
    // A want raised before the client existed (arming at page setup) is served the moment one does.
    pumpSeed();
  },

  setBufferCapBytes(value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }
    capBytes = Math.floor(value);
    trim();
  },

  // The INCOMING half. Called from mirrorClient's one message listener with the raw frame string, BEFORE the
  // JSON.parse and before the watch gate — so a frame the gate drops (which is exactly the class of straggler a
  // "the client ignored it" bug is made of) is still in the file.
  tapWireIn(data: string): void {
    if (!recording) {
      return;
    }
    push(now(), data.length + WIRE_LINE_OVERHEAD, { dir: "in", data });
    if (!isKeyframeFrame(data)) {
      return;
    }
    // The line just pushed IS the keyframe: `trim()` never drops the newest entry, and a compaction re-slices the
    // array without disturbing the entry objects, so the tail is still it.
    const entry = entries[entries.length - 1];
    if (!entry) {
      return;
    }
    seedEntry = entry;
    seedKind = resyncPending ? "resync" : "connect";
    resyncPending = false;
    seedWanted = false;
  },

  // The OUTGOING half, from the wrapped socket `send`. The wire is JSON TEXT in both directions (the host rejects
  // binary), so a non-string argument is not something this client sends and is skipped rather than coerced.
  tapWireOut(data: unknown): void {
    if (!recording || typeof data !== "string") {
      return;
    }
    push(now(), data.length + WIRE_LINE_OVERHEAD, { dir: "out", data });
  },

  tapWsLifecycle(ev: "ctor" | "open" | "close", url?: string): void {
    if (!recording) {
      return;
    }
    push(now(), KIND_LINE_COST, { kind: "ws", ev, ...(url ? { url } : {}) });
  },

  attachStage(stage: HTMLElement): () => void {
    stages.add(stage);
    if (recording) {
      addStageListeners(stage);
    }
    let detached = false;
    return () => {
      if (detached) {
        return;
      }
      detached = true;
      stages.delete(stage);
      if (recording) {
        removeStageListeners(stage);
      }
    };
  },

  __resetForTests(): void {
    if (recording) {
      recording = false;
      removeListeners();
    }
    for (const stage of [...stages]) {
      stages.delete(stage);
    }
    reset();
    capBytes = DEFAULT_REPRO_BUFFER_BYTES;
    metaSupplier = null;
    resyncRequester = null;
    startedAt = 0;
  }
};
