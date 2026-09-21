import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { parseRecordingArgs, recordingWebSocketUrl } from "./lib/mirror-recording-options.mjs";

test("recording defaults preserve the live-scenery workload", () => {
  const args = parseRecordingArgs([]);
  assert.equal(args.staticBg, "off");
  assert.equal(recordingWebSocketUrl("ws://localhost:1234/", args.staticBg),
    "ws://localhost:1234/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0");
});

test("static capture changes only the static-background wire selector", () => {
  const args = parseRecordingArgs(["--duration", "240", "--out", "capture.ndjson", "--static-bg", "on"]);
  assert.deepEqual(args, { duration: 240, out: "capture.ndjson", staticBg: "on" });
  assert.equal(recordingWebSocketUrl("ws://localhost:1234", args.staticBg),
    recordingWebSocketUrl("ws://localhost:1234", "off").replace("staticBg=0", "staticBg=1"));
});

test("invalid selectors fail before connecting or creating a recording", () => {
  for (const value of [undefined, "", "true", "1", "ON", "--out"]) {
    const args = value === undefined ? ["--static-bg"] : ["--static-bg", value];
    assert.throws(() => parseRecordingArgs(args), /static-bg/);
    const result = spawnSync(process.execPath, [new URL("./record-mirror-stream.mjs", import.meta.url).pathname, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /static-bg/);
    assert.equal(result.stdout, "");
  }
});
