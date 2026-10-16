import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createH15NativeArrivalProbe } from "./lib/h15-native-arrival.mjs";

const transform = (x, y, scale = 1) => ({ xAxis: { x: scale, y: 0 }, yAxis: { x: 0, y: scale }, origin: { x, y } });
const holder = (x, y, extra = {}) => ({ id: "card", parentId: "root", transform: transform(x, y), ...extra });
const full = (x = 0, y = 0) => ({ type: "scene-delta", full: true, upserts: [
  { id: "root", parentId: null, name: "root", transform: transform(10, 20, 2) },
  holder(x, y, { name: "fifth", nodeType: "Synthetic.NHandCardHolder" }),
] });
const delta = (...upserts) => ({ type: "scene-delta", upserts });
const move = (x = 110, y = 220) => ({ type: "input", kind: "hover", coordX: x, coordY: y, requestId: "board" });

// Serialized into the Playwright init script: no imports or module closure may be required at runtime.
const probe = () => vm.runInNewContext(`(${createH15NativeArrivalProbe.toString()})()`, { setTimeout, clearTimeout, performance });

test("composes fresh native ancestors and uses actual emitted board coordinates", async () => {
  const p = probe(); const socket = {};
  p.receive(socket, full()); p.arm("card", "fifth"); p.sent(socket, move());
  p.receive(socket, delta(holder(50, 100)));
  const r = await p.wait();
  assert.equal(r.ready, true); assert.equal(r.target.requestId, "board");
  assert.equal(r.samples[0].origin.x, 110); assert.equal(r.samples[0].origin.y, 220);
});

test("cached arrival, hints and unrelated updates cannot prove arrival", async () => {
  const p = probe(); const socket = {};
  p.receive(socket, full(50, 100)); p.arm("card", "fifth"); p.sent(socket, move());
  p.receive(socket, { ...delta(), hints: [{ targetId: "card", endPosition: [110, 220] }] });
  p.receive(socket, delta({ id: "unrelated", transform: transform(110, 220) }));
  p.cancel();
  const r = await p.wait(); assert.equal(r.ready, false); assert.equal(r.samples.length, 0);
});

test("other sockets and pre-board updates cannot satisfy a gesture", async () => {
  const p = probe(); const socket = {}; const other = {};
  p.receive(socket, full()); p.arm("card", "fifth");
  p.receive(socket, delta(holder(50, 100))); p.sent(socket, move());
  p.receive(other, full(50, 100)); p.cancel();
  assert.equal((await p.wait()).ready, false);
});

test("fails closed on identity reuse and missing ancestry", async () => {
  const p = probe(); const socket = {};
  p.receive(socket, full()); p.arm("card", "fifth"); p.sent(socket, move());
  p.receive(socket, delta(holder(50, 100, { name: "replacement" })));
  assert.equal((await p.wait()).reason, "native holder identity changed");
  p.receive(socket, full()); p.arm("card", "fifth"); p.sent(socket, move());
  p.receive(socket, { ...delta(holder(110, 220)), removedIds: ["root"] }); p.cancel();
  const r = await p.wait(); assert.equal(r.ready, false); assert.equal(r.samples[0].origin, null);
});

test("requires arrival within two native pixels and ignores nonfinite coordinates", async () => {
  const p = probe(); const socket = {};
  p.receive(socket, full()); p.arm("card", "fifth"); p.sent(socket, move(NaN, 220));
  p.receive(socket, delta(holder(50, 100))); p.sent(socket, move(210, 320));
  p.receive(socket, delta(holder(102, 150))); // Four native pixels away.
  p.receive(socket, delta(holder(100.5, 150))); // One native pixel away.
  const r = await p.wait(); assert.equal(r.ready, true); assert.equal(r.target.x, 210);
  assert.equal(r.samples.length, 2); assert.equal(r.samples[1].distance, 1);
});

test("deadline resolves a failure and retires the old gesture", async () => {
  const p = probe(); const socket = {};
  p.receive(socket, full()); p.arm("card", "fifth", 5); p.sent(socket, move());
  assert.equal((await p.wait()).reason, "no native board arrival before deadline");
  p.arm("card", "fifth"); p.sent(socket, move()); p.receive(socket, delta(holder(50, 100)));
  assert.equal((await p.wait()).ready, true);
});
