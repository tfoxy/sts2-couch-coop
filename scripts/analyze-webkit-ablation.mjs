#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeAblation, ablationMarkdown } from "./lib/webkit-ablation-analysis.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || !args.length) {
  process.stdout.write("Usage: node scripts/analyze-webkit-ablation.mjs MANIFEST.json [--out DIR]\nReads normalized leg metrics and explicit comparison IDs; writes analysis.json and REPORT.md.\n");
} else {
  const manifest = JSON.parse(readFileSync(resolve(args[0]), "utf8"));
  const result = analyzeAblation(manifest);
  const outIndex = args.indexOf("--out");
  if (outIndex >= 0) {
    if (!args[outIndex + 1]) throw new Error("--out requires a directory");
    const out = resolve(args[outIndex + 1]);
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "analysis.json"), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(resolve(out, "REPORT.md"), ablationMarkdown(result));
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.comparisons.some(value => !value.measured || value.accepted === false)) process.exitCode = 1;
}
