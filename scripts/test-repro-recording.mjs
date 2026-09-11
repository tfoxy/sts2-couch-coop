#!/usr/bin/env node

import assert from "node:assert/strict";

import { REPRO_FORMAT, requireReproHeader } from "./lib/repro-recording.mjs";

const header = JSON.stringify({ meta: { format: REPRO_FORMAT, recordedAt: "2026-09-09T00:00:00.000Z" } });
assert.equal(requireReproHeader(`${header}\n{"t":0}`, "fixture").format, REPRO_FORMAT);
assert.throws(() => requireReproHeader("", "empty"), /missing repro\/1 header/);
assert.throws(() => requireReproHeader("not json\n", "bad-json"), /first line must be/);
assert.throws(() => requireReproHeader('{"meta":{}}\n', "headerless"), /expected first-line/);
assert.throws(() => requireReproHeader('{"meta":{"format":"recording/1"}}\n', "wrong-format"), /repro\/1/);

console.log("repro recording header tests passed");
