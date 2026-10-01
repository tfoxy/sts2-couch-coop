#!/usr/bin/env node
// Resolve the trace written by this invocation, even when the adapter stores it in another worktree.
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

const [reportPath, startedEpochText] = process.argv.slice(2);
const startedEpoch = Number(startedEpochText);
if (!reportPath || !Number.isSafeInteger(startedEpoch) || startedEpoch < 0) {
  console.error("usage: resolve-bench-trace.mjs <report.json> <host-start-epoch-seconds>");
  process.exit(2);
}
try {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const trace = report.artifacts?.trace;
  if (typeof trace !== "string" || !isAbsolute(trace)) throw new Error("report lacks an absolute trace artifact");
  if (Math.floor(statSync(trace).mtimeMs / 1000) < startedEpoch) throw new Error("trace predates this invocation");
  process.stdout.write(trace);
} catch (error) {
  console.error(`resolve-bench-trace: ${error.message}`);
  process.exitCode = 1;
}
