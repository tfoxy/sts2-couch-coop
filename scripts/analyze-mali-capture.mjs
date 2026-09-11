#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markerWindow } from './analyze-phone-canvas-cell.mjs';
import { parseCsvRows } from './lib/perfetto-frame-timeline.mjs';

export function maliMarkerRange(summary, startUs, endUs) {
  const anchor = Number(/^clock monotonic start:\s*([0-9.]+)/m.exec(summary)?.[1]);
  const duration = Number(/^duration:\s*([0-9.]+) s/m.exec(summary)?.[1]);
  if (![anchor, duration, startUs, endUs].every(Number.isFinite) || endUs <= startUs) throw Error('Missing APC clock/duration or invalid marker timestamps');
  const start = startUs / 1e6 - anchor, stop = endUs / 1e6 - anchor;
  if (start < 0 || stop > duration) throw Error('Marker window is outside the APC capture');
  return { start, stop, durationSeconds: stop - start, clock: 'Chrome CLOCK_MONOTONIC matched to APC clock monotonic start', anchorSeconds: anchor };
}

export function maliWindowCounters(csv, range, presentedCount) {
  if (!Number.isSafeInteger(presentedCount) || presentedCount < 3) throw Error('At least three surface-attributed actual presents are required');
  const header = csv.search(/^Index *\(s\),/m);
  if (header < 0) throw Error('Missing Streamline timeline header');
  const rows = parseCsvRows(csv.slice(header).trim());
  const timeKey = Object.keys(rows[0] ?? {}).find((key) => /^Index *\(s\)$/.test(key));
  const keys = Object.keys(rows[0] ?? {}).filter((key) => /^Mali /.test(key));
  if (!timeKey || !keys.length) throw Error('Missing Mali timeline columns');
  const numeric = rows.map((row) => ({ time: Number(row[timeKey]), values: keys.map((key) => row[key]?.trim() ? Number(row[key]) : NaN) }));
  if (numeric.some((row, i) => !Number.isFinite(row.time) || row.values.some((v) => !Number.isFinite(v) || v < 0) || (i && row.time <= numeric[i - 1].time))) throw Error('Invalid or unordered Mali counter rows');
  const gaps = numeric.slice(1).map((row, i) => row.time - numeric[i].time);
  const binSeconds = gaps[0];
  if (gaps.some((gap) => Math.abs(gap - binSeconds) > 1e-7)) throw Error("Missing or irregular Mali timeline bins");
  if (!(binSeconds > 0) || numeric[0].time > range.start || numeric.at(-1).time + binSeconds < range.stop) throw Error('Timeline does not cover marker bounds');
  const selected = numeric.filter((row) => row.time >= range.start && row.time < range.stop);
  if (!selected.length) throw Error('No counter samples in marker window');
  return {
    scope: 'global GPU hardware counters; use matched foreground controls for attribution',
    sampleCount: selected.length, binSeconds,
    boundaryUncertaintySeconds: 2 * binSeconds,
    counters: Object.fromEntries(keys.map((key, i) => {
      const total = selected.reduce((sum, row) => sum + row.values[i], 0);
      return [key, { total, perPresentedFrame: total / presentedCount, perSecond: total / range.durationSeconds }];
    }))
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [apc, csv, chromeTrace, phase, metricsPath, output] = process.argv.slice(2);
    if (!output || !['idle', 'active'].includes(phase)) throw Error('Usage: analyze-mali-capture.mjs <capture.apc> <timeline.csv> <chrome.trace.json> <idle|active> <cell.metrics.json> <out.json>');
    const json = JSON.parse(readFileSync(chromeTrace, 'utf8'));
    const window = markerWindow(Array.isArray(json) ? json : json.traceEvents, phase);
    const metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
    const actual = metrics.actualPresented;
    if (actual?.provenance?.source !== 'perfetto-frame-timeline-actual' || metrics.traceWindow?.windowMs !== window.windowMs || metrics.tracePath !== chromeTrace) throw Error('Actual-presentation evidence must match this trace/window');
    const range = maliMarkerRange(readFileSync(join(apc, 'db/summary.txt'), 'utf8'), window.startUs, window.endUs);
    const analysis = maliWindowCounters(readFileSync(csv, 'utf8'), range, actual.count);
    writeFileSync(output, JSON.stringify({ schema: 'mali-marker-counters/1', apc, csv, chromeTrace, metricsPath, range, actualPresented: actual, ...analysis }, null, 2) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
