#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { readRawEvents } from "./validate-gpu-attribution-trace.mjs";
import { analyzeGlOperationAttribution } from "./lib/gl-operation-attribution.mjs";

function usage() {
  console.error("Usage: node scripts/analyze-gl-operation-attribution.mjs --trace <raw.json[.gz]> --meta <trace.meta.json> --gpu-pid <pid> [--phase active|idle]");
  process.exit(2);
}
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (!["--trace", "--meta", "--gpu-pid", "--phase"].includes(key) || !process.argv[i + 1]) usage();
  args[key.slice(2)] = process.argv[++i];
}
if (!args.trace || !args.meta || !args["gpu-pid"]) usage();
const events = [];
for await (const event of readRawEvents(args.trace)) events.push(event);
const metadata = JSON.parse(await readFile(args.meta, "utf8"));
const result = analyzeGlOperationAttribution(events, metadata, { gpuPid: Number(args["gpu-pid"]), phase: args.phase ?? "active" });
console.log(JSON.stringify(result, null, 2));
if (!result.valid) process.exitCode = 2;
