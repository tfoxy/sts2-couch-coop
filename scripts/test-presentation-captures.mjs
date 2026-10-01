#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePresentationSequence } from "./lib/presentation-captures.mjs";

const dir = mkdtempSync(join(tmpdir(), "presentation-capture-"));
try {
  const calls = [];
  let snapshot = 0;
  const page = {
    async evaluate(callback) {
      assert.equal(callback.name, "presentationSnapshotInPage");
      calls.push("snapshot");
      return { pageNowMs: ++snapshot, renderer: { frameIdentity: { revision: 148 } } };
    },
    async screenshot({ path, fullPage }) {
      assert.equal(fullPage, false);
      calls.push("screenshot");
      writeFileSync(path, `png-${calls.length}`);
    },
    async waitForTimeout(ms) { calls.push(`wait-${ms}`); },
  };
  const prefix = join(dir, "capture");
  const result = await capturePresentationSequence(page, { prefix, count: 3, gapMs: 80,
    metadata: { arm: "rust" } });
  assert.deepEqual(calls, ["snapshot", "screenshot", "snapshot", "wait-80", "snapshot", "screenshot", "snapshot",
    "wait-80", "snapshot", "screenshot", "snapshot"]);
  assert.equal(result.captures.length, 3);
  assert.equal(result.captures[0].before.pageNowMs, 1);
  assert.equal(result.captures[0].after.pageNowMs, 2);
  assert.ok(result.captures.every((row) => row.screenshotSha256.length === 64 &&
    row.screenshotStartedEpochMs <= row.screenshotEndedEpochMs));
  assert.deepEqual(JSON.parse(readFileSync(`${prefix}.json`, "utf8")), result);
  await assert.rejects(() => capturePresentationSequence(page, { prefix, count: 1 }), /invalid presentation capture/);
  console.log("presentation capture receipt tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
