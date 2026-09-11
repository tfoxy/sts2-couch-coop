// Cross-repo contract smoke test: an envelope built by `buildPerfReport` must
// pass godot-scene-web's ACTUAL validator, invoked the same way the contract
// says sibling repos invoke it —
//   mise exec -- pnpm perf -- validate-report <file>
//
// This deliberately shells out rather than importing a copy of the schema:
// `perf-report/1` couples the repos by JSON shape only, and the one blessed
// shared surface is this subprocess (godot-scene-web
// `docs/perf-report-contract.md`). If the sibling checkout or its toolchain is
// not available, the test SKIPS rather than fails — it is a contract check, not
// a check that every machine has both repos.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildPerfReport } from "./lib/perf-report-envelope.mjs";
import {
  syntheticArtifacts,
  syntheticEnv,
  syntheticParams,
  syntheticRun,
} from "./lib/perf-report-envelope.fixture.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GSW_ROOT = process.env.GODOT_SCENE_WEB_SOURCE_ROOT
  ? resolve(process.env.GODOT_SCENE_WEB_SOURCE_ROOT)
  : resolve(REPO_ROOT, "../godot-scene-web");

function validatorAvailable() {
  if (!existsSync(join(GSW_ROOT, "package.json"))) return false;
  const probe = spawnSync("mise", ["exec", "--", "pnpm", "-C", GSW_ROOT, "perf", "--", "--help"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return probe.status === 0;
}

function runValidator(reportPath) {
  return execFileSync(
    "mise",
    ["exec", "--", "pnpm", "-C", GSW_ROOT, "perf", "--", "validate-report", reportPath],
    { encoding: "utf8", timeout: 120_000 },
  );
}

const AVAILABLE = validatorAvailable();
const skip = AVAILABLE ? false : "godot-scene-web sibling checkout / `mise exec -- pnpm perf` not available";

test("a buildPerfReport envelope (5 accepted repeats) conforms to perf-report/1", { skip }, () => {
  const runs = Array.from({ length: 5 }, () => syntheticRun());
  const report = buildPerfReport({
    runs,
    failures: [],
    env: syntheticEnv(),
    params: syntheticParams(),
    artifacts: syntheticArtifacts(),
    scenario: "mirror-replay-contract-smoke",
    warmups: 1,
  });
  const dir = mkdtempSync(join(tmpdir(), "perf-report-validate-"));
  try {
    const file = join(dir, "report.json");
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    const out = runValidator(file);
    assert.match(out, /conforms to perf-report\/1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an envelope with a discarded repeat (4 accepted + failures[]) still conforms", { skip }, () => {
  const runs = Array.from({ length: 4 }, () => syntheticRun());
  const report = buildPerfReport({
    runs,
    failures: ["r2: presence guard failed — 29/32 sample centres on screen; run DISCARDED"],
    env: syntheticEnv({ kind: "host", label: "linux-chrome-148-host" }),
    params: syntheticParams(),
    artifacts: syntheticArtifacts(),
    scenario: "mirror-replay-contract-smoke",
    warmups: 1,
  });
  const dir = mkdtempSync(join(tmpdir(), "perf-report-validate-"));
  try {
    const file = join(dir, "report.json");
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    assert.match(runValidator(file), /conforms to perf-report\/1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the validator actually rejects a broken envelope (guards against a no-op check)", { skip }, () => {
  const runs = Array.from({ length: 5 }, () => syntheticRun());
  const report = buildPerfReport({
    runs,
    env: syntheticEnv(),
    params: syntheticParams(),
    artifacts: syntheticArtifacts(),
    scenario: "mirror-replay-contract-smoke",
  });
  // knock out a contract-required field
  delete report.metrics.cpu;
  const dir = mkdtempSync(join(tmpdir(), "perf-report-validate-"));
  try {
    const file = join(dir, "broken.json");
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    assert.throws(() => runValidator(file), /Command failed|metrics\.cpu/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
