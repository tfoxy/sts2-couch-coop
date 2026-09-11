#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { presentationStats } from "./lib/perfetto-presentation.mjs";
import { actualFrameTimelineSamples, auditNegativeFrameEnds, bootOffsetNs, perfettoActualFrames, validateAnomalyDisplayJoins, validateTraceHealth } from "./lib/perfetto-frame-timeline.mjs";

const join = (...parts) => Uint8Array.from(parts.flatMap((part) => [...part]));
const uint64 = (value) => {
  let number = BigInt(value);
  const bytes = [];
  do { const byte = Number(number & 0x7fn); number >>= 7n; bytes.push(number ? byte | 0x80 : byte); } while (number);
  return Uint8Array.from(bytes);
};
const scalar = (field, value) => join(uint64(BigInt(field) << 3n), uint64(value));
const message = (field, value) => join(uint64((BigInt(field) << 3n) | 2n), uint64(value.length), value);
const tracePacket = (timestamp, frameEvent) => message(1, join(scalar(8, timestamp), message(76, frameEvent)));
const actualSurfaceStart = (cookie, displayToken) => message(4, join(scalar(1, cookie), scalar(3, displayToken)));
const frameEnd = (cookie) => message(5, scalar(1, cookie));
const maxInt64 = 0x7fff_ffff_ffff_ffffn;

const samples = [0, 16_000, 32_000, 48_000, 100_000].map((ts) => ({ ts, source:"perfetto-frame-timeline-actual", surface:"Chrome Surface", attributionKey:"layer_name", eventName:"actual_frame_timeline_slice" }));
const stats = presentationStats(samples, 100);
assert.equal(stats.count, 5);
assert.equal(stats.gapP95Ms, 52);
assert.equal(stats.provenance.surface, "Chrome Surface");
assert.equal(stats.anomalyProvenance, null);
const defectSamples = samples.slice();
Object.defineProperty(defectSamples, "anomalyProvenance", { value: { kind: "trace_sorter_negative_timestamp_dropped", count: 1 }, enumerable: true });
assert.deepEqual(presentationStats(defectSamples, 100).anomalyProvenance, defectSamples.anomalyProvenance, "report retains any accepted trace defect");
assert.equal(presentationStats(samples.slice(0, 2), 100), null, "too few events are not cadence evidence");

assert.equal(bootOffsetNs([{ monotonic: "100", ts: "140" }]), 40);
assert.equal(bootOffsetNs([{ monotonic: "100", ts: "140" }, { monotonic: "200", ts: "2000200" }]), null, "unstable suspend offset rejects capture");
const frameRows = actualFrameTimelineSamples([
  { ts: "1000", dur: "10", display_ts: "1050", display_dur: "10", layer_name: "Chrome Surface", present_type: "On-time Present", display_present_type: "On-time Present", display_frame_token: "1", surface_frame_token: "2" },
  { ts: "2000", dur: "10", display_ts: "2050", display_dur: "10", layer_name: "Chrome Surface", present_type: "Dropped", display_present_type: "On-time Present", display_frame_token: "3", surface_frame_token: "4" },
  { ts: "3000", dur: "10", display_ts: "3050", display_dur: "10", layer_name: "Other Surface", present_type: "On-time Present", display_present_type: "On-time Present", display_frame_token: "5", surface_frame_token: "6" }
], { surface: "Chrome Surface", fromBootNs: 900, toBootNs: 2100 });
assert.deepEqual(frameRows.map((row) => row.ts), [1.06], "normalize ns to us at SurfaceFlinger display end and reject dropped/other-layer frames");
assert.equal(actualFrameTimelineSamples([{ ts:"1000", dur:"-1", display_ts:"1050", display_dur:"10", layer_name:"Chrome Surface", present_type:"On-time Present", display_present_type:"On-time Present", display_frame_token:"1", surface_frame_token:"2" }], { surface:"Chrome Surface", fromBootNs:900,toBootNs:2100 }).length, 1, "unknown app completion does not discard token-linked SurfaceFlinger display");
const knownDefectTrace = join(
  tracePacket(100n, actualSurfaceStart(41n, 77n)),
  tracePacket(maxInt64 + 1n, frameEnd(41n))
);
const audit = auditNegativeFrameEnds(knownDefectTrace);
assert.equal(audit.count, 1);
assert.equal(audit.tolerated, true, "only a FrameEnd mapped to ActualSurfaceFrameStart is tolerated");
assert.deepEqual(audit.displayFrameTokens, [77]);
assert.equal(validateAnomalyDisplayJoins(audit, [{ display_frame_token: "77" }]), true);
assert.equal(validateAnomalyDisplayJoins(audit, []), false, "tolerated end requires a matching SurfaceFlinger display row");
const validated = validateTraceHealth([{ name: "trace_sorter_negative_timestamp_dropped", value: "1" }], knownDefectTrace);
assert.equal(validated?.provenance.count, 1);
assert.match(validated?.provenance.rawPath ?? "", /FrameEnd/);

assert.equal(validateTraceHealth([{ name: "trace_sorter_negative_timestamp_dropped", value: "2" }], knownDefectTrace), null, "health count must exactly match raw packets");
assert.equal(validateTraceHealth([{ name: "trace_sorter_negative_timestamp_dropped", value: "1" }, { name: "other_error", value: "1" }], knownDefectTrace), null, "unrelated health failures reject trace");
assert.equal(auditNegativeFrameEnds(join(tracePacket(100n, actualSurfaceStart(41n, 77n)), tracePacket(maxInt64 + 1n, frameEnd(42n)))).tolerated, false, "unmatched FrameEnd cookie rejects trace");
assert.throws(() => auditNegativeFrameEnds(join(tracePacket(100n, actualSurfaceStart(41n, 77n)), tracePacket(maxInt64 + 1n, join(actualSurfaceStart(41n, 77n), frameEnd(41n))))), /oneof/, "FrameTimeline oneof conflict rejects trace");
assert.throws(() => auditNegativeFrameEnds(Uint8Array.from([0x08, ...Array(10).fill(0x80)])), /uint64/, "uint64 overflow rejects raw input");
assert.throws(() => auditNegativeFrameEnds(Uint8Array.from([0x08, ...Array(9).fill(0x80), 0x02])), /uint64/, "uint64 values beyond 64 bits reject raw input");
assert.throws(() => auditNegativeFrameEnds(Uint8Array.from([0x0a, 0x05, 0x00])), /length exceeds/, "length outside raw input rejects trace");

const scratch = mkdtempSync(joinPath(tmpdir(), "perfetto-audit-"));
const tracePath = joinPath(scratch, "trace.pftrace");
const processorPath = joinPath(scratch, "trace-processor-mock.mjs");
writeFileSync(tracePath, knownDefectTrace);
writeFileSync(processorPath, `#!/usr/bin/env node
const sql = process.argv[4];
if (sql.includes("FROM stats")) process.stdout.write("name,value\\ntrace_sorter_negative_timestamp_dropped,1\\n");
else if (sql.includes("clock_snapshot")) process.stdout.write("ts,monotonic\\n1000,0\\n");
else if (sql.includes("trace_bounds")) process.stdout.write("start_ts,end_ts\\n0,1000000\\n");
else if (sql.includes("SELECT DISTINCT")) process.stdout.write("display_frame_token\\n77\\n");
else process.stdout.write("ts,dur,display_frame_token,surface_frame_token,layer_name,present_type,display_ts,display_dur,display_present_type\\n100,-1,77,12,Chrome Surface,On-time Present,117000,16000,On-time Present\\n");
`);
chmodSync(processorPath, 0o755);
const rawSamples = perfettoActualFrames({ processor: processorPath, trace: tracePath, surface: "Chrome Surface", chromeStartUs: 100, chromeEndUs: 200 });
assert.equal(rawSamples?.length, 1, "mocked processor requires a valid SurfaceFlinger display join");
assert.equal(rawSamples?.anomalyProvenance?.count, 1, "accepted defect retains explicit provenance for reporting");
assert.match(rawSamples?.anomalyProvenance?.rawTracePath ?? "", /trace\.pftrace$/);
console.log("Perfetto presentation attribution tests passed");
