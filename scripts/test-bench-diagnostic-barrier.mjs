#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "../frontend/node_modules/typescript/lib/typescript.js";

// Execute the injected function itself in a tiny browser-shaped context. The first full scene mounts the
// renderer asynchronously; the next recorded delta is already due before that mount finishes.
const source = readFileSync(new URL("./bench-mirror-replay.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("bench-mirror-replay.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "fakeWebSocketInit");
assert.ok(declaration, "fake replay socket implementation is present");
const functionSource = source.slice(declaration.getStart(ast), declaration.end);

class BenchEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback) { const list = this.listeners.get(type) ?? []; list.push(callback); this.listeners.set(type, list); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((value) => value !== callback)); }
  dispatchEvent(event) { for (const callback of this.listeners.get(event.type) ?? []) callback(event); return true; }
}
class BenchEvent { constructor(type) { this.type = type; } }
class BenchMessageEvent extends BenchEvent { constructor(type, options) { super(type); this.data = options.data; } }

async function replay({ mount, acknowledge = true, staleAck = false, presentWithoutAck = false }) {
  const rows = [
    { t: 0, data: JSON.stringify({ type: "session", directView: true }) },
    { t: 1, data: JSON.stringify({ type: "scene-delta", full: true, upserts: [{ id: "root" }] }) },
    { t: 2, data: JSON.stringify({ type: "scene-delta", full: false, upserts: [{ id: "next" }] }) },
    { t: 3, data: JSON.stringify({ type: "scene-delta", full: false, upserts: [{ id: "last" }] }) },
  ];
  const seen = [], hintClocks = [], window = { fetch: async () => ({ text: async () => rows.map((row) => JSON.stringify(row)).join("\n") }) };
  let frameRevision = 0;
  const init = runInNewContext(`(${functionSource})`, {
    window, EventTarget: BenchEventTarget, Event: BenchEvent, MessageEvent: BenchMessageEvent,
    CloseEvent: BenchEvent, performance, setTimeout,
    requestAnimationFrame: (callback) => setTimeout(() => callback(performance.now()), 1),
  }, { filename: "bench-mirror-replay.mjs" });
  init({ recordingUrl: "/fixture", pace: "recorded", diagnosticClock: true,
    diagnosticMountTimeoutMs: 150, diagnosticAckTimeoutMs: 150,
    synthesizeDirectView: false, window: null, dropCardFlights: false });
  const socket = new window.WebSocket("ws://test/ws?watch=1");
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    seen.push(message.full === true ? "full" : message.type === "scene-delta" ? "delta" : "session");
    if (message.full === true && mount) setTimeout(() => {
      const seed = window.__benchDiagnosticClockMs;
      window.__mirrorCanvasBenchClock = { nowMs: seed };
      window.__mirrorSetDiagnosticClock = async () => {};
      frameRevision = 1;
      window.__mirrorFrameIdentity = () => ({ revision: frameRevision });
      window.__testRendererSeed = seed;
    }, 10);
    if (message.type === "scene-delta" && message.full === false && staleAck) socket.send('{"type":"scene-ack"}');
    if (message.type === "scene-delta" && message.full === false && acknowledge) setTimeout(() => {
      hintClocks.push(window.__benchDiagnosticClockMs);
      frameRevision++;
      if (!staleAck && !presentWithoutAck) socket.send('{"type":"scene-ack"}');
    }, 20);
  };
  const deadline = performance.now() + 1000;
  while (window.__benchDone !== true && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(window.__benchDone, true, "the replay reached a terminal state");
  return { window, seen, hintClocks };
}

const mounted = await replay({ mount: true });
assert.deepEqual(mounted.seen, ["session", "full", "delta", "delta"]);
assert.deepEqual(mounted.hintClocks, [2, 3], "delayed reconcile keeps each hint on its delivery clock");
assert.equal(mounted.window.__testRendererSeed, 1, "renderer mounted under the keyframe clock");
assert.equal(mounted.window.__benchWsError, undefined);
assert.equal(mounted.window.__benchClockSeedAudit.find((row) => row.kind === "seedRead")?.value, 1);
const stale = await replay({ mount: true, staleAck: true });
assert.deepEqual(stale.hintClocks, [2, 3], "an early stale ack cannot advance the clock before the frame identity");
const presented = await replay({ mount: true, presentWithoutAck: true });
assert.deepEqual(presented.hintClocks, [2, 3], "a presented revision can release a delta consumed without an ack");
const absent = await replay({ mount: false });
assert.deepEqual(absent.seen, ["session", "full"], "the later delta cannot advance the clock after mount failure");
assert.match(absent.window.__benchWsError, /did not mount after first full scene/);
const unacked = await replay({ mount: true, acknowledge: false });
assert.deepEqual(unacked.seen, ["session", "full", "delta"], "unacknowledged delta blocks the next clock");
assert.match(unacked.window.__benchWsError, /not presented before clock advance/);
console.log("diagnostic first-scene mount barrier tests passed");
