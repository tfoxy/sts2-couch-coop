#!/usr/bin/env node
// Record the live mirror `/ws` stream to an NDJSON file for deterministic replay/benchmarking.
//
//   node scripts/record-mirror-stream.mjs                       # 25s → .sts2/bench/combat-<ts>.ndjson
//   node scripts/record-mirror-stream.mjs --duration 30 --out .sts2/bench/combat-baseline.ndjson
//   COUCHCOOP_GAME_ORIGIN=ws://192.168.1.5:13337 node scripts/record-mirror-stream.mjs
//
// This is a PASSIVE extra watcher: it connects with the canonical `/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0` query,
// acks every scene-delta INSTANTLY (so the host coalesces the stream as little as possible — we capture the
// least-coalesced frame stream), and NEVER sends inputs. Use --static-bg on to capture the static treatment.
// The watcher still adds host streaming work; keep it separate from graded live-browser measurements.
//
// Output format (NDJSON, one JSON value per line):
//   line 1:  {"meta":{"format":"repro/1",recordedAt,url,durationMs,messages,bytes}}   (written at finalize)
//   line 2+: {"t":<ms since first message>,"data":"<raw message string>"}
//
// The replay/bench tooling (frontend/bench/mirrorReplay.bench.ts, scripts/bench-mirror-replay.mjs) reads these
// files. `server-reload` frames are recorded verbatim; the replayers strip them.
//
// Zero runtime dependencies — uses Node's built-in global `WebSocket` (Node >= 22). No spirectl, no playwright.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecordingArgs, recordingWebSocketUrl } from "./lib/mirror-recording-options.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let args;
try {
  args = parseRecordingArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
if (args.help) {
  console.log(`record-mirror-stream.mjs — capture the live mirror /ws stream to NDJSON

  --duration <seconds>   how long to record (default 25)
  --out <path>           output file (default .sts2/bench/combat-<timestamp>.ndjson)
  --static-bg on|off     request static backgrounds (default off)

  env COUCHCOOP_GAME_ORIGIN   ws origin (default ws://127.0.0.1:13337)

Passive viewer: acks scene-deltas instantly and never sends inputs; adds streaming work to the host.`);
  process.exit(0);
}

const ORIGIN = (process.env.COUCHCOOP_GAME_ORIGIN ?? "ws://127.0.0.1:13337").replace(/\/$/, "");
const URL = recordingWebSocketUrl(ORIGIN, args.staticBg);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = resolve(REPO_ROOT, args.out ?? `.sts2/bench/combat-${timestamp}.ndjson`);

if (typeof WebSocket !== "function") {
  console.error("Global WebSocket is unavailable — need Node >= 22 (this is Node " + process.version + ").");
  process.exit(2);
}

// Buffered in memory; flushed once at finalize (SIGINT-safe: we always write what we captured). At ~25s of
// combat this is a few MB — trivial.
/** @type {{ t: number, data: string }[]} */
const records = [];
let firstMsgAt = 0; // performance.now() of the first message (t=0 anchor)
let lastMsgAt = 0;
let totalBytes = 0;
let sawSceneDelta = false;
let firstSceneDeltaFull = false;
let finalized = false;

console.log(`Recording ${args.duration}s of ${URL}`);
console.log(`Output: ${outPath}`);

const ws = new WebSocket(URL);
let stopTimer = null;

ws.addEventListener("open", () => {
  console.log("connected — acking scene-deltas instantly, sending no input");
  stopTimer = setTimeout(() => finalize("duration reached"), args.duration * 1000);
});

ws.addEventListener("message", (event) => {
  const data = typeof event.data === "string" ? event.data : String(event.data);
  const now = performance.now();
  if (firstMsgAt === 0) {
    firstMsgAt = now;
  }
  lastMsgAt = now;
  totalBytes += Buffer.byteLength(data, "utf8");
  records.push({ t: Math.round((now - firstMsgAt) * 1000) / 1000, data });

  // Cheap raw-string type check — ack scene-deltas the instant they land (least coalescing) without a full parse.
  if (data.includes('"type":"scene-delta"')) {
    if (!sawSceneDelta) {
      sawSceneDelta = true;
      // The first scene-delta MUST be a full keyframe (server sends it on connect).
      firstSceneDeltaFull = data.includes('"full":true');
    }
    // Release the next coalesced delta immediately (1-credit flow control).
    try {
      ws.send('{"type":"scene-ack"}');
    } catch {
      // racing close — ignore
    }
  }
});

ws.addEventListener("error", (event) => {
  console.error(`WebSocket error: ${event?.message ?? event?.error ?? "connection failed"}`);
  finalize("socket error");
});

ws.addEventListener("close", () => {
  finalize("socket closed");
});

process.on("SIGINT", () => {
  console.log("\nSIGINT — finalizing recording");
  finalize("interrupted");
});

function finalize(reason) {
  if (finalized) {
    return;
  }
  finalized = true;
  if (stopTimer) {
    clearTimeout(stopTimer);
  }
  try {
    ws.close();
  } catch {
    // already closing
  }

  const durationMs = firstMsgAt === 0 ? 0 : Math.round((lastMsgAt - firstMsgAt) * 1000) / 1000;
  const meta = {
    format: "repro/1",
    recordedAt: new Date().toISOString(),
    url: URL,
    staticBg: args.staticBg,
    durationMs,
    messages: records.length,
    bytes: totalBytes
  };

  mkdirSync(dirname(outPath), { recursive: true });
  const lines = [JSON.stringify({ meta })];
  for (const rec of records) {
    lines.push(JSON.stringify(rec));
  }
  writeFileSync(outPath, lines.join("\n") + "\n");

  // --- Sanity report ------------------------------------------------------------------------------------
  console.log("");
  console.log(`stopped: ${reason}`);
  console.log(`wrote ${outPath}`);
  console.log(`messages:  ${meta.messages}`);
  console.log(`bytes:     ${meta.bytes} (${(meta.bytes / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`span:      ${(meta.durationMs / 1000).toFixed(2)}s`);
  if (!sawSceneDelta) {
    console.warn("WARN: no scene-delta messages captured — is the game presenting a scene?");
  } else if (!firstSceneDeltaFull) {
    console.warn('WARN: first scene-delta was NOT a full keyframe (expected "full":true on connect).');
  } else {
    console.log('first scene-delta: full keyframe OK ("full":true)');
  }
  if (meta.messages < 300) {
    console.warn(`WARN: only ${meta.messages} messages (< 300) — likely an idle/unrepresentative stream. ` +
      `Drive some card plays + an enemy turn while recording combat.`);
  }

  process.exit(0);
}
