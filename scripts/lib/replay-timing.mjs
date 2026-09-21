import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const REPLAY_TIMING_SCHEMA = "couchcoop-replay-timing/1";

// Outside the browser cgroup. This optional ledger observes sends; it never gates them on ACKs.
export function createReplayTiming(path, { recordingSha256, messages, pace, loop, chaos }) {
  if (pace !== "recorded" || loop || chaos.latency || chaos.drop) {
    throw new Error("--timing-out requires recorded pace without loop or chaos");
  }
  let previous = 0;
  for (const message of messages) {
    if (!Number.isFinite(message.t) || message.t < previous) throw new Error("timed recording requires ordered nonnegative timestamps");
    previous = message.t;
  }
  if (!messages.length) throw new Error("timed recording must contain messages");
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx");
  let closed = false;
  const emit = value => {
    if (closed) throw new Error("replay timing ledger is closed");
    writeSync(fd, `${JSON.stringify({ schema: REPLAY_TIMING_SCHEMA, ...value })}\n`);
  };
  const scene = data => data.includes('"type":"scene-delta"');
  emit({ type: "recording", recordingSha256, pid: process.pid, clock: "process.hrtime.bigint nanoseconds",
    messageCount: messages.length, bytes: messages.reduce((n, m) => n + Buffer.byteLength(m.data), 0),
    sceneRevisions: messages.filter(m => scene(m.data)).length,
    sceneBytes: messages.filter(m => scene(m.data)).reduce((n, m) => n + Buffer.byteLength(m.data), 0),
    firstScheduledMs: messages[0].t, terminalScheduledMs: messages.at(-1).t });
  return {
    start(connectionId, generation, admissionMonotonicNs = process.hrtime.bigint()) {
      const start = BigInt(admissionMonotonicNs);
      let sent = 0, bytes = 0, sceneRevisions = 0, sceneBytes = 0;
      let firstActualNs = null, lastActualNs = null, maximumLatenessMs = 0, ended = false;
      const base = { connectionId, generation };
      emit({ type: "admission", ...base, admissionMonotonicNs: String(start), admissionEpochMs: Date.now() });
      return {
        send(index, actualMonotonicNs = process.hrtime.bigint()) {
          if (ended || index !== sent || !messages[index]) throw new Error("timed replay send is out of sequence");
          const message = messages[index];
          const actual = BigInt(actualMonotonicNs);
          const actualMs = Number(actual - start) / 1e6;
          const latenessMs = actualMs - message.t;
          const frameBytes = Buffer.byteLength(message.data);
          sent++; bytes += frameBytes;
          if (scene(message.data)) { sceneRevisions++; sceneBytes += frameBytes; }
          firstActualNs ??= String(actual);
          lastActualNs = String(actual);
          maximumLatenessMs = Math.max(maximumLatenessMs, latenessMs);
          emit({ type: "send", ...base, index, scheduledMs: message.t, actualMonotonicNs: String(actual),
            actualElapsedMs: actualMs, latenessMs, bytes: frameBytes, scene: scene(message.data) });
        },
        finish(reason) {
          if (ended) return;
          ended = true;
          emit({ type: "terminal", ...base, reason, complete: reason === "exhausted" && sent === messages.length,
            monotonicNs: String(process.hrtime.bigint()), sent, bytes, sceneRevisions, sceneBytes,
            firstActualMonotonicNs: firstActualNs, lastActualMonotonicNs: lastActualNs, maximumLatenessMs });
        }
      };
    },
    close() { if (!closed) { closed = true; closeSync(fd); } }
  };
}
