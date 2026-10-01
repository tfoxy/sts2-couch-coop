#!/usr/bin/env node

import { readFileSync } from "node:fs";

function fail(message) { console.error(message); process.exit(2); }
const [firstPath, secondPath] = process.argv.slice(2);
if (!firstPath || !secondPath) fail("usage: compare-renderer-parity.mjs <first.json> <second.json>");
const read = (path) => {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.schema !== "mirror-renderer-parity/1") fail(`${path}: unsupported schema`);
  if (value.capture?.accepted !== true) fail(`${path}: capture not accepted (${value.capture?.reason ?? "unknown"})`);
  return value;
};
function difference(a, b, path = "capture") {
  if (Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) return { path, a, b };
  if (Array.isArray(a)) {
    if (a.length !== b.length) return { path: `${path}.length`, a: a.length, b: b.length };
    for (let i = 0; i < a.length; i++) { const found = difference(a[i], b[i], `${path}[${i}]`); if (found) return found; }
    return null;
  }
  if (typeof a === "object") {
    const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    const keys = difference(ak, bk, `${path}.keys`); if (keys) return keys;
    for (const key of ak) { const found = difference(a[key], b[key], `${path}.${key}`); if (found) return found; }
    return null;
  }
  return { path, a, b };
}
const first = read(firstPath), second = read(secondPath);
const errors = [];
if (first.recording !== second.recording) errors.push("recording differs");
if (!/^[a-f0-9]{64}$/.test(first.recordingSha256 ?? "") || first.recordingSha256 !== second.recordingSha256) errors.push("recording SHA-256 missing or differs");
if (JSON.stringify(first.viewport) !== JSON.stringify(second.viewport)) errors.push("viewport differs");
if (first.capture.clockMs !== second.capture.clockMs) errors.push("clock differs");
for (const [name, a, b] of [
  ["semantic state fingerprint", first.capture.stateFingerprint, second.capture.stateFingerprint],
  ["logical paint", first.capture.logicalPaint, second.capture.logicalPaint],
  ["hits and production mapping", first.capture.hits, second.capture.hits],
]) {
  const found = difference(a, b, name); if (found) errors.push(`${name} mismatch at ${found.path}`);
}
const orb = first.capture.hits.find((row) => row.x === 240 && row.y === 912);
if (!orb?.hit?.available || !orb?.productionMapping?.available) errors.push("orb sample (240,912) unavailable");
const result = { schema: "mirror-renderer-parity-comparison/1", first: firstPath, second: secondPath, passed: errors.length === 0, errors };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
