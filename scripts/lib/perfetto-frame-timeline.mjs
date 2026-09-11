import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function protoFields(bytes) {
  let i = 0;
  const out = [];
  const varint = () => {
    let value = 0n;
    for (let byteIndex = 0; byteIndex < 10; byteIndex++) {
      if (i >= bytes.length) throw Error("truncated protobuf uint64");
      const byte = bytes[i++];
      if (byteIndex === 9 && byte > 1) throw Error("protobuf uint64 overflow");
      value |= BigInt(byte & 0x7f) << BigInt(byteIndex * 7);
      if (!(byte & 0x80)) return value;
    }
    throw Error("protobuf uint64 overflow");
  };
  while (i < bytes.length) {
    const key = varint();
    const field = key >> 3n;
    const wire = key & 7n;
    if (!field || field > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("invalid protobuf field number");
    let value;
    if (wire === 0n) value = varint();
    else if (wire === 2n) {
      const length = varint();
      if (length > BigInt(bytes.length - i)) throw Error("protobuf length exceeds buffer");
      value = bytes.subarray(i, i + Number(length));
      i += Number(length);
    } else if (wire === 1n) {
      if (i + 8 > bytes.length) throw Error("truncated protobuf fixed64");
      value = bytes.subarray(i, i + 8); i += 8;
    } else if (wire === 5n) {
      if (i + 4 > bytes.length) throw Error("truncated protobuf fixed32");
      value = bytes.subarray(i, i + 4); i += 4;
    } else throw Error("unsupported protobuf wire type");
    out.push([Number(field), value]);
  }
  return out;
}

const one = (items, field) => {
  const values = items.filter(([candidate]) => candidate === field);
  if (values.length > 1) throw Error(`duplicate protobuf field ${field}`);
  return values[0]?.[1];
};

const frameOneof = (event) => {
  const choices = event.filter(([field]) => field >= 1 && field <= 5);
  if (choices.length > 1) throw Error("FrameTimeline event has multiple oneof variants");
  if (event.length !== choices.length) throw Error("FrameTimeline event has unknown fields");
  return choices[0];
};

const positiveSafeNumber = (value) => typeof value === "bigint"
  && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;

export function auditNegativeFrameEnds(bytes) {
  const starts = new Map();
  const negativePackets = [];
  for (const [field, packet] of protoFields(bytes)) {
    // perfetto.protos.Trace contains repeated TracePacket as field 1. Other raw
    // payloads are not TracePackets and must not be interpreted as such.
    if (field !== 1 || !(packet instanceof Uint8Array)) continue;
    const tracePacket = protoFields(packet);
    const timestamp = one(tracePacket, 8);
    const frameTimeline = one(tracePacket, 76);
    if (!(frameTimeline instanceof Uint8Array)) continue;
    const event = protoFields(frameTimeline);
    const choice = frameOneof(event);
    if (choice?.[0] === 4 && choice[1] instanceof Uint8Array) {
      const start = protoFields(choice[1]);
      const cookie = one(start, 1);
      const displayToken = one(start, 3);
      const token = positiveSafeNumber(displayToken);
      if (typeof cookie === "bigint" && token !== null) {
        if (starts.has(cookie) && starts.get(cookie) !== token) throw Error("ActualSurfaceFrameStart cookie reused");
        starts.set(cookie, token);
      }
    }
    if (typeof timestamp === "bigint" && timestamp > 0x7fffffffffffffffn) {
      const end = choice?.[0] === 5 && choice[1] instanceof Uint8Array ? protoFields(choice[1]) : null;
      const cookie = end ? one(end, 1) : null;
      negativePackets.push({
        cookie: typeof cookie === "bigint" ? cookie : null,
        frameEvent: choice?.[0] ?? null
      });
    }
  }
  const anomalies = negativePackets.map((packet) => ({
    ...packet,
    actualSurfaceStart: packet.cookie !== null && starts.has(packet.cookie),
    displayFrameToken: packet.cookie === null ? null : starts.get(packet.cookie) ?? null
  }));
  const tolerated = anomalies.length > 0 && anomalies.every((packet) => packet.frameEvent === 5
    && packet.actualSurfaceStart && packet.displayFrameToken !== null);
  return {
    count: anomalies.length,
    tolerated,
    displayFrameTokens: [...new Set(anomalies.map((packet) => packet.displayFrameToken).filter((token) => token !== null))],
    anomalies: anomalies.map(({ cookie, ...packet }) => ({ cookie: cookie?.toString() ?? null, ...packet }))
  };
}

export function validateTraceHealth(healthRows, traceBytes) {
  const negativeRows = healthRows.filter((row) => row.name === "trace_sorter_negative_timestamp_dropped");
  if (healthRows.length !== negativeRows.length) return null;
  const expected = negativeRows.reduce((total, row) => total + Number(row.value), 0);
  if (!Number.isSafeInteger(expected) || expected <= 0) return healthRows.length ? null : { provenance: null, audit: null };
  try {
    const audit = auditNegativeFrameEnds(traceBytes);
    if (!audit.tolerated || audit.count !== expected) return null;
    return {
      audit,
      provenance: {
        kind: "trace_sorter_negative_timestamp_dropped",
        count: audit.count,
        rawPath: "Trace.packet[1].timestamp + FrameTimelineEvent.FrameEnd[5]",
        evidence: "each dropped timestamp is a FrameEnd whose cookie maps to ActualSurfaceFrameStart[4]"
      }
    };
  } catch {
    return null;
  }
}

export function validateAnomalyDisplayJoins(audit, joinedRows) {
  if (!audit) return true;
  const joinedTokens = new Set(joinedRows.map((row) => Number(row.display_frame_token)));
  return joinedTokens.size === audit.displayFrameTokens.length
    && audit.displayFrameTokens.every((token) => joinedTokens.has(token));
}

// Trace processor writes diagnostics to stderr and RFC4180 CSV to stdout.
export function parseCsvRows(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ""; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); if (row.some((value) => value.length)) rows.push(row);
      row = []; field = "";
    } else field += c;
  }
  if (quoted) throw new Error("Unterminated CSV string from trace processor");
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const keys = rows.shift();
  if (!keys) return [];
  return rows.map((values) => {
    if (values.length !== keys.length) throw new Error("Malformed trace processor CSV row");
    return Object.fromEntries(keys.map((key, index) => [key, values[index] === "[NULL]" ? null : values[index]]));
  });
}

export function bootOffsetNs(clockRows) {
  if (!clockRows.length) return null;
  const offsets = clockRows.map((row) => row.ts != null && row.monotonic != null
    ? Number(row.ts) - Number(row.monotonic) : NaN);
  if (!offsets.every(Number.isFinite) || Math.max(...offsets) - Math.min(...offsets) > 100_000) return null;
  return offsets[0];
}

const isPresented = (value) => /^(On-time|Late|Early) Present$/.test(value ?? "");

export function actualFrameTimelineSamples(rows, { surface, fromBootNs, toBootNs }) {
  if (!surface || !Number.isFinite(fromBootNs) || !Number.isFinite(toBootNs) || toBootNs <= fromBootNs) return [];
  return rows.filter((row) => row.layer_name === surface && isPresented(row.present_type)
    && isPresented(row.display_present_type) && Number(row.display_dur) > 0
    && Number(row.display_frame_token) > 0 && Number(row.surface_frame_token) > 0)
    .map((row) => ({
      // Public sample timestamps are MICROSECONDS like Chrome trace timestamps; SQL and window bounds are ns.
      ts: (Number(row.display_ts) + Number(row.display_dur)) / 1000,
      source: "perfetto-frame-timeline-actual", surface, attributionKey: "layer_name",
      eventName: "actual_frame_timeline_slice", displayFrameToken: row.display_frame_token,
      surfaceFrameToken: row.surface_frame_token
    })).filter((row) => Number.isFinite(row.ts) && row.ts * 1000 >= fromBootNs && row.ts * 1000 <= toBootNs);
}

export function queryTrace(processor, trace, sql) {
  return parseCsvRows(execFileSync(processor, [trace, "-Q", sql], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

export function perfettoActualFrames({ processor, trace, surface, chromeStartUs, chromeEndUs, upid }) {
  if (![processor, trace, surface].every((value) => typeof value === "string" && value)) return null;
  if (!Number.isFinite(chromeStartUs) || !Number.isFinite(chromeEndUs) || chromeEndUs <= chromeStartUs) return null;
  const health = queryTrace(processor, trace, "SELECT name, value FROM stats WHERE severity = 'error' AND value > 0");
  const healthValidation = validateTraceHealth(health, readFileSync(trace));
  if (!healthValidation) return null;
  const anomalyProvenance = healthValidation.provenance && {
    ...healthValidation.provenance,
    rawTracePath: trace
  };
  // Each row's normalized ts and MONOTONIC value are from the SAME snapshot, including any suspend offset.
  const clocks = queryTrace(processor, trace, "SELECT ts, clock_value AS monotonic FROM clock_snapshot WHERE clock_name='MONOTONIC' ORDER BY ts");
  const offset = bootOffsetNs(clocks);
  if (offset === null) return null;
  const fromBootNs = chromeStartUs * 1000 + offset;
  const toBootNs = chromeEndUs * 1000 + offset;
  const [bounds] = queryTrace(processor, trace, "SELECT start_ts, end_ts FROM trace_bounds");
  if (!bounds || fromBootNs < Number(bounds.start_ts) || toBootNs > Number(bounds.end_ts)) return null;
  const quoted = surface.replace(/'/g, "''");
  if (upid != null && (!Number.isSafeInteger(Number(upid)) || Number(upid) <= 0)) return null;
  // App completion can precede the display by multiple frames. Join the actual SurfaceFlinger display token.
  const rows = queryTrace(processor, trace, `SELECT a.ts, a.dur, a.display_frame_token, a.surface_frame_token,
      a.layer_name, a.present_type, sf.ts AS display_ts, sf.dur AS display_dur,
      sf.present_type AS display_present_type
    FROM actual_frame_timeline_slice a
    JOIN actual_frame_timeline_slice sf ON sf.display_frame_token = a.display_frame_token
    JOIN process p ON p.upid = sf.upid
    WHERE a.layer_name = '${quoted}' ${upid == null ? "" : `AND a.upid = ${Number(upid)}`}
      AND sf.layer_name IS NULL AND p.name GLOB '*surfaceflinger'
      AND sf.dur > 0 AND a.display_frame_token > 0 AND a.surface_frame_token > 0
    ORDER BY sf.ts`);
  if (healthValidation.audit) {
    const tokens = healthValidation.audit.displayFrameTokens;
    // The waived app-side FrameEnd is meaningful only when every affected display
    // token has a real SurfaceFlinger display row from the known SF process.
    const joined = queryTrace(processor, trace, `SELECT DISTINCT sf.display_frame_token
      FROM actual_frame_timeline_slice sf
      JOIN process p ON p.upid = sf.upid
      WHERE sf.display_frame_token IN (${tokens.join(",")})
        AND sf.layer_name IS NULL AND p.name GLOB '*surfaceflinger' AND sf.dur > 0`);
    if (!validateAnomalyDisplayJoins(healthValidation.audit, joined)) return null;
  }
  const samples = actualFrameTimelineSamples(rows, { surface, fromBootNs, toBootNs });
  if (anomalyProvenance) Object.defineProperty(samples, "anomalyProvenance", { value: anomalyProvenance, enumerable: true });
  return samples;
}
