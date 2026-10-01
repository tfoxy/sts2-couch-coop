#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { digestRecordedMessages, installActiveWindowBoundary,
  validateActiveWindowBoundary } from "./lib/active-window-boundary.mjs";

const source = readFileSync(new URL("./bench-mirror-replay.mjs", import.meta.url), "utf8");
const start = source.indexOf("function fakeWebSocketInit(config) {");
const end = source.indexOf("\n// ---------------------------------------------------------------------------------------------------------\n// LONG-TASK", start);
assert.ok(start >= 0 && end > start);
const fakeSocketSource = source.slice(start, end);
let clock = 0;
const timers = [];
const deliveries = [];
const stamps = [];
const frames = [];
let rendererReady = true;
const renderer = () => ({ backend: "rust", instance: { id: 1 }, frameIdentity: { revision: 148 },
  readiness: rendererReady ? "ready" : "initializing", ready: rendererReady,
  resources: { pending: rendererReady ? 0 : 1, failed: 0 }, failure: null,
  lifecycle: { contextReady: 1, presentationValid: rendererReady ? 1 : 0 },
  effective: { quality: "very-low", shaders: "off", particles: "off", staticBg: 1, spineMode: "static" } });
const messages = [
  { t: 0, data: '{"type":"session"}' },
  { t: 2326.005, data: '{"type":"scene-delta","full":true}' },
  { t: 2486.211, data: '{"type":"scene-delta","full":false,"n":1}' },
  { t: 2506.189, data: '{"type":"scene-delta","full":false,"n":2}' },
  { t: 6493.015, data: '{"type":"scene-delta","full":false,"n":3}' },
];
const recording = [{ meta: { schema: "repro/1" } }, ...messages.map(({ t, data }) => ({ t, data }))]
  .map((row) => JSON.stringify(row)).join("\n") + "\n";
const windowObject = { __benchDocumentNonce: "measured-doc", __benchFreshDefaults: { cleared: true },
  __benchSceneAckPending: [], __benchSceneAckLatencies: [], __benchFrameGaps: [],
  __benchLongTasks: [], __benchLoaf: [], __benchTicks: [],
  __mirrorRendererDiagnostics: renderer,
  __mirrorGlContextEvents: () => ({ losses: 0, creationErrors: 0 }),
  fetch: async () => ({ text: async () => recording }) };
const context = { window: windowObject, performance: { now: () => clock, timeOrigin: 1_800_000_000_000,
    mark: (name) => stamps.push(name) },
  URL,
  location: { href: "http://127.0.0.1:5190/?stage=rust&shaders=off&particles=off" },
  document: { visibilityState: "visible", hidden: false },
  innerWidth: 800, innerHeight: 400, devicePixelRatio: 2,
  localStorage: { getItem: () => null },
  requestAnimationFrame: (fn) => frames.push(fn),
  setTimeout: (fn, delay) => { timers.push({ at: clock + delay, fn }); },
  EventTarget, Event, MessageEvent, CloseEvent,
  console: { timeStamp: (name) => stamps.push(name) },
};
runInNewContext(`(${installActiveWindowBoundary.toString()})()`, context);
clock = 1;
frames.shift()();
clock = 0;
const initFakeSocket = runInNewContext(`(${fakeSocketSource})`, context);
initFakeSocket({ recordingUrl: "http://127.0.0.1:8190/recording", pace: "recorded",
  window: { startMs: 2500, endMs: 6500 }, activeWindowWitness: true,
  synthesizeDirectView: false, dropCardFlights: false, diagnosticClock: false });
const socket = new windowObject.WebSocket("ws://local/ws");
socket.onmessage = (event) => deliveries.push({ at: clock, data: event.data });
for (let i = 0; i < 8; i++) await Promise.resolve();
let guard = 0;
while (timers.length && guard++ < 100) {
  timers.sort((a, b) => a.at - b.at);
  const timer = timers.shift();
  clock = timer.at;
  timer.fn();
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
assert.ok(guard < 100);
assert.deepEqual(deliveries.map((row) => row.data), messages.map((row) => row.data),
  "the real recorded pump delivered every source payload in order");
assert.deepEqual(deliveries.map((row) => row.at), messages.map((row) => row.t),
  "the witness did not pause, retime, or catch up the transport");
const rows = windowObject.__benchActiveWindowBoundary;
assert.equal(rows.start.boundMs, 2500);
assert.equal(rows.end.boundMs, 6500);
assert.equal(rows.start.delivery.count, 3);
assert.equal(rows.end.delivery.count, 5);
assert.equal(rows.start.delivery.hash, digestRecordedMessages(messages.slice(0, 3)));
assert.equal(rows.end.delivery.hash, digestRecordedMessages(messages));
assert.deepEqual(stamps.filter((name) => name === "cc-report-start"), ["cc-report-start", "cc-report-start"]);
const expectedStart = { boundMs: 2500, count: 3, hash: digestRecordedMessages(messages.slice(0, 3)) };
const expectedEnd = { boundMs: 6500, count: 5, hash: digestRecordedMessages(messages) };
assert.equal(validateActiveWindowBoundary({ start: rows.start, end: rows.end,
  expectedStart, expectedEnd }).accepted, true);
assert.equal(validateActiveWindowBoundary({ start: { ...rows.start,
  markerWallMinusBoundaryMs: 150 }, end: rows.end, expectedStart, expectedEnd }).accepted, false);
assert.equal(validateActiveWindowBoundary({ start: { ...rows.start, renderer: { ...rows.start.renderer,
  ready: false } }, end: rows.end, expectedStart, expectedEnd }).accepted, false);
assert.equal(validateActiveWindowBoundary({ start: rows.start, end: { ...rows.end,
  delivery: { ...rows.end.delivery, count: 4 } }, expectedStart, expectedEnd }).accepted, false);
let visualClock = 0;
const visualTimers = [];
const visualEvents = [];
const visualWindow = { fetch: async () => ({ text: async () => recording }),
  __benchBusyStartupEvent: (name, detail) => visualEvents.push({ name, detail }) };
const visualContext = { window: visualWindow,
  performance: { now: () => visualClock, timeOrigin: 1_800_000_000_000 },
  document: { visibilityState: "visible", hidden: false },
  innerWidth: 800, innerHeight: 400, devicePixelRatio: 2,
  setTimeout: (fn, delay) => visualTimers.push({ at: visualClock + delay, fn }),
  EventTarget, Event, MessageEvent, CloseEvent };
const initVisualSocket = runInNewContext(`(${fakeSocketSource})`, visualContext);
initVisualSocket({ recordingUrl: "http://127.0.0.1:8190/recording", pace: "recorded",
  activeVisualReference: true, busyStartupTimeline: true,
  synthesizeDirectView: false, diagnosticClock: false });
new visualWindow.WebSocket("ws://local/ws");
for (let i = 0; i < 8; i++) await Promise.resolve();
let visualGuard = 0;
while (visualTimers.length && visualGuard++ < 100) {
  visualTimers.sort((a, b) => a.at - b.at);
  const timer = visualTimers.shift();
  visualClock = timer.at;
  timer.fn();
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
assert.ok(visualGuard < 100);
assert.equal(visualWindow.__benchActiveVisualBoundary.start.boundMs, 2500);
assert.equal(visualWindow.__benchActiveVisualBoundary.end.boundMs, 6500);
assert.equal(visualWindow.__benchActiveVisualBoundary.start.atEpochMs, 1_800_000_002_500);
assert.equal(visualWindow.__benchActiveVisualBoundary.end.atEpochMs, 1_800_000_006_500);
assert.equal(visualEvents.filter((event) => event.name === "stream.fullScene").length, 1);
assert.deepEqual(visualEvents.filter((event) => event.name === "stream.sceneDelivered")
  .map((event) => event.detail.sceneOrdinal), [2, 3, 4]);
assert.equal(visualEvents.find((event) => event.name === "stream.boundaryStart")?.detail.renderer, null);
console.log("active window boundary and recorded transport tests passed");
