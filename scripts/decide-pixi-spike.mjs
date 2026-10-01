#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const QUALIFICATION_FIELDS = ["sourceHashesMatch", "recordingHashesMatch", "settingsMatch", "geometryPassed", "contentPassed", "visualPassed", "objectGrowthBounded", "textureGrowthBounded", "actualPixiWebglProved"];
const ADMISSION_SUFFIXES = ["canvas/pixi/pixi/canvas ABBA", "all cells healthy", "same recording/query settings", "actual Pixi drawing proved"];
const WORKLOAD_GATE_SUFFIXES = [
  "canvas/pixi/pixi/canvas ABBA", "all cells healthy", "same recording/query settings",
  "actual FPS no >5% regression", "present p95 no >5% regression", "rAF p95 no >5% regression",
  "ack p95 no >5% regression", "renderer CPU no >5% regression", "GPU CPU no >5% regression",
  "memory within max(10%,64MiB)", "actual Pixi drawing proved",
];
const EXPECTED_GATES = new Set([
  ...["idle", "dense"].flatMap((workload) => WORKLOAD_GATE_SUFFIXES.map((suffix) => `${workload}: ${suffix}`)),
  "investment: at least one workload has a 30% presentation win",
]);

function decide(reps, qualification) {
  const incomplete = [], performanceFailures = [];
  if (!qualification || typeof qualification !== "object") incomplete.push("qualification manifest missing or malformed");
  else for (const field of QUALIFICATION_FIELDS) if (qualification[field] !== true) incomplete.push(`qualification.${field} is not true`);
  if (!Array.isArray(reps) || reps.length < 1 || reps.length > 2) incomplete.push("one or two ABBA summaries are required");
  for (const [index, rep] of (reps ?? []).entries()) {
    if (rep?.schema !== "pixi-phone-bench-summary/1" || !Array.isArray(rep.gates) || !Array.isArray(rep.wins)) {
      incomplete.push(`replication ${index + 1} is malformed`); continue;
    }
    const gateNames = rep.gates.map((gate) => gate?.name);
    const winNames = rep.wins.map((win) => win?.workload);
    if (rep.cells !== 8 || gateNames.length !== EXPECTED_GATES.size || new Set(gateNames).size !== gateNames.length ||
        gateNames.some((name) => !EXPECTED_GATES.has(name)) || [...EXPECTED_GATES].some((name) => !gateNames.includes(name)) ||
        winNames.length !== 2 || new Set(winNames).size !== 2 || !winNames.includes("idle") || !winNames.includes("dense")) {
      incomplete.push(`replication ${index + 1} has incomplete gate/workload/cell coverage`); continue;
    }
    for (const gate of rep.gates) {
      if (gate.status === "UNMEASURED") incomplete.push(`replication ${index + 1}: ${gate.name} unmeasured`);
      else if (gate.status === "FAIL") {
        const admission = ADMISSION_SUFFIXES.some((suffix) => gate.name.endsWith(suffix));
        (admission ? incomplete : performanceFailures).push(`replication ${index + 1}: ${gate.name}`);
      } else if (gate.status !== "PASS") incomplete.push(`replication ${index + 1}: ${gate.name} has invalid status`);
    }
  }
  const winningWorkloads = ["idle", "dense"].filter((workload) => reps.length === 2 && reps.every((rep) => rep.wins?.some((win) => win.workload === workload && (win.fps30 === true || win.presentP9530 === true))));
  const firstPromising = reps.length === 1 && reps[0]?.wins?.some((win) => win.fps30 === true || win.presentP9530 === true);
  if (firstPromising && performanceFailures.length === 0) incomplete.push("promising first replication requires the predeclared second replication");
  let verdict;
  if (incomplete.length) verdict = "INCONCLUSIVE";
  else if (performanceFailures.length || reps.length === 1) verdict = "NO-GO";
  else if (winningWorkloads.length) verdict = "GO";
  else verdict = "NO-GO";
  return { schema: "pixi-spike-decision/1", verdict, winningWorkloads, incomplete, performanceFailures };
}

function parse(argv) {
  const out = { reps: [], qualification: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--rep") out.reps.push(resolve(argv[++i]));
    else if (argv[i] === "--qualification") out.qualification = resolve(argv[++i]);
    else if (argv[i] === "--out") out.out = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

export { decide };
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parse(process.argv.slice(2));
    const reps = options.reps.map((path) => JSON.parse(readFileSync(path, "utf8")));
    const qualification = options.qualification ? JSON.parse(readFileSync(options.qualification, "utf8")) : null;
    const result = { ...decide(reps, qualification), qualification: options.qualification, replications: options.reps };
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (options.out) writeFileSync(options.out, text);
    process.stdout.write(text);
    if (result.verdict !== "GO") process.exitCode = 1;
  } catch (error) { console.error(`decide-pixi-spike: ${error.message}`); process.exitCode = 2; }
}
