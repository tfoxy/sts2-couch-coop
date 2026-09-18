#!/usr/bin/env node
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [kind, candidate] = process.argv.slice(2);
const allowedByKind = {
  webkit: new Set(["browser-lifecycle.jsonl", "iphone-webkit-result.json", "iphone-webkit-timeline.json"]),
  safari: new Set([
    "browser-lifecycle.jsonl",
    "iphone-safari-result.json",
    "iphone-safari-timeline.json",
    "iphone-safari-crash-metadata.json",
    "iphone-safari-failure.png",
  ]),
};
if (!(kind in allowedByKind) || !candidate) {
  process.stderr.write("usage: validate-iphone-artifact-stage.mjs webkit|safari PATH\n");
  process.exit(64);
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const stage = resolve(candidate);
const contained = relative(resolve(repoRoot, ".ci-artifacts"), stage);
if (!contained || contained.startsWith("..") || contained.includes("../") || basename(stage).includes("..")) {
  throw new Error("iPhone artifact stage must be a named child of the repository .ci-artifacts directory");
}

let entries;
try {
  entries = await readdir(stage, { withFileTypes: true });
} catch (error) {
  if (error?.code === "ENOENT") process.exit(0);
  throw error;
}
if (await realpath(stage) !== stage) throw new Error("iPhone artifact stage may not be a symlink");
for (const entry of entries) {
  if (!entry.isFile() || !allowedByKind[kind].has(entry.name)) {
    throw new Error(`unreviewed iPhone artifact: ${entry.name}`);
  }
  const path = resolve(stage, entry.name);
  const info = await lstat(path);
  if (info.isSymbolicLink() || await realpath(path) !== path) throw new Error(`symlinked iPhone artifact: ${entry.name}`);
  const maximum = entry.name === "browser-lifecycle.jsonl" ? 1024 * 1024
    : entry.name.endsWith(".png") ? 10 * 1024 * 1024
      : 64 * 1024;
  if (info.size > maximum) throw new Error(`oversized iPhone artifact: ${entry.name}`);
}
process.stdout.write(`iPhone ${kind} artifact stage: ok\n`);
