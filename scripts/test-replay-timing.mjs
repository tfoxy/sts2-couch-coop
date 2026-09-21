import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createReplayTiming } from "./lib/replay-timing.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const messages = [
  { t: 0, data: JSON.stringify({ type: "scene-delta", full: true, upserts: [], label: "λ" }) },
  { t: 100, data: JSON.stringify({ type: "session", label: "synthetic" }) },
  { t: 200, data: JSON.stringify({ type: "scene-delta", full: false, upserts: [] }) }
];
const config = { recordingSha256: "synthetic", messages, pace: "recorded", loop: false, chaos: { latency: 0, drop: 0 } };
const rows = path => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);

test("timing counts actual UTF-8 sends and preserves incomplete generations", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-timing-"));
  try {
    const file = join(dir, "timing.ndjson");
    const ledger = createReplayTiming(file, config);
    const first = ledger.start(1, 1, 1000000000n);
    first.send(0, 1001000000n);
    first.finish("watch-disabled");
    const second = ledger.start(1, 2, 2000000000n);
    for (let i = 0; i < messages.length; i++) second.send(i, 2000000000n + BigInt(messages[i].t + 3) * 1000000n);
    second.finish("exhausted");
    second.finish("connection-closed");
    ledger.close();
    const all = rows(file);
    const terminal = all.filter(row => row.type === "terminal");
    assert.equal(terminal.length, 2);
    assert.equal(terminal[0].complete, false);
    assert.equal(terminal[1].complete, true);
    assert.equal(terminal[1].sceneRevisions, 2);
    assert.equal(terminal[1].bytes, messages.reduce((n, m) => n + Buffer.byteLength(m.data), 0));
    assert.equal(terminal[1].maximumLatenessMs, 3);
    assert.throws(() => createReplayTiming(file, config), /EEXIST/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timing refuses ambiguous cadence and out-of-order sends", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-invalid-"));
  try {
    for (const override of [{ loop: true }, { pace: "max" }, { chaos: { latency: 1, drop: 0 } },
      { chaos: { latency: 0, drop: 0.1 } }, { messages: [] }, { messages: [{ t: -1, data: "x" }] },
      { messages: [{ t: 1, data: "x" }, { t: 0, data: "y" }] }]) {
      assert.throws(() => createReplayTiming(join(dir, "unused"), { ...config, ...override }));
    }
    const ledger = createReplayTiming(join(dir, "valid"), config);
    const run = ledger.start(1, 1);
    assert.throws(() => run.send(1), /out of sequence/);
    run.finish("connection-closed");
    assert.throws(() => run.send(0), /out of sequence/);
    ledger.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real replay timing follows watch admission, exact frames, and recorder metadata", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-wire-"));
  const recording = join(dir, "input.ndjson"), timing = join(dir, "timing.ndjson");
  const source = [{ meta: { format: "repro/1", durationMs: 200, messages: messages.length } }, ...messages];
  writeFileSync(recording, source.map(JSON.stringify).join("\n") + "\n");
  const server = spawn(process.execPath, [new URL("./replay-ws-server.mjs", import.meta.url).pathname,
    "--recording", recording, "--host", "127.0.0.1", "--port", "0", "--respect-watch", "--timing-out", timing],
  { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "", ws;
  server.stdout.on("data", chunk => { output += chunk; });
  server.stderr.on("data", chunk => { errors += chunk; });
  try {
    const deadline = Date.now() + 5000;
    while (!/listening on 127\.0\.0\.1:(\d+)/.test(output) && Date.now() < deadline && server.exitCode === null) await delay(10);
    const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
    assert.ok(match, `${output}\n${errors}`);
    const origin = `ws://127.0.0.1:${match[1]}`;
    ws = new WebSocket(`${origin}/ws?watch=0`);
    const received = [];
    ws.addEventListener("message", event => received.push(event.data));
    await once(ws, "open");
    await delay(75);
    assert.equal(rows(timing).filter(row => row.type === "admission").length, 0);
    ws.send('{"type":"watch","on":true}');
    await delay(350);
    const first = rows(timing);
    assert.equal(first[0].recordingSha256, createHash("sha256").update(readFileSync(recording)).digest("hex"));
    assert.equal(first.filter(row => row.type === "send").length, messages.length);
    assert.equal(first.find(row => row.type === "terminal").complete, true);
    assert.deepEqual(received.slice(1), messages.map(message => message.data));
    ws.send('{"type":"watch","on":false}');
    ws.send('{"type":"watch","on":true}');
    await delay(350);
    assert.deepEqual(rows(timing).filter(row => row.type === "admission").map(row => row.generation), [1, 2]);
    ws.close();
    await once(ws, "close");
    for (const setting of ["off", "on"]) {
      const file = join(dir, `${setting}.ndjson`);
      const recorder = spawn(process.execPath, [new URL("./record-mirror-stream.mjs", import.meta.url).pathname,
        "--duration", "0.4", "--out", file, "--static-bg", setting],
      { env: { ...process.env, COUCHCOOP_GAME_ORIGIN: origin }, stdio: "ignore" });
      const [code] = await once(recorder, "exit");
      assert.equal(code, 0);
      const recorded = rows(file);
      assert.equal(recorded[0].meta.staticBg, setting);
      assert.equal(new URL(recorded[0].meta.url).searchParams.get("staticBg"), setting === "on" ? "1" : "0");
      assert.equal(recorded.filter(row => row.data?.includes('"type":"scene-delta"')).length, 2);
    }
  } finally {
    ws?.close();
    if (server.exitCode === null) { server.kill("SIGINT"); await once(server, "exit"); }
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(errors, "");
  assert.equal(server.exitCode, 0);
});
