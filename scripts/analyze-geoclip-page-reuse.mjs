#!/usr/bin/env node
// Offline only: report declared atlas pages and their local cache sizes.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1] ?? null;
}

const datasetPath = option(process.argv.slice(2), "--dataset");
const cacheRoot = option(process.argv.slice(2), "--cache-root");
const outPath = option(process.argv.slice(2), "--out");
if (!datasetPath || !cacheRoot || !outPath) {
  console.error("usage: analyze-geoclip-page-reuse.mjs --dataset <dataset.json> --cache-root <cache> --out <report.json>");
  process.exit(2);
}

const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const pageSizes = new Map();
const completeArtifacts = [];
const refused = [];

for (const identity of dataset.identities) {
  if (identity.initialDisposition !== "complete" || (!identity.snapshotManifest && !identity.sourceManifest)) {
    refused.push({
      id: identity.id,
      scene: identity.scene,
      node: identity.node,
      anim: identity.anim,
      artifactDisposition: identity.initialDisposition,
      visualValidated: false,
      snapshotManifest: identity.snapshotManifest ?? null,
      sourceManifest: identity.sourceManifest ?? null,
      manifest: null
    });
    continue;
  }
  // Frozen snapshots are the report's primary manifest evidence. The source is
  // retained separately because it supplies the current cache page directory.
  const manifestPath = identity.snapshotManifest ?? identity.sourceManifest;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifestBytes = statSync(manifestPath).size;
  const pages = (manifest.pages ?? []).map((page) => {
    const sharedPath = resolve(cacheRoot, "pages", page.file);
    const bytes = existsSync(sharedPath) ? statSync(sharedPath).size : null;
    const observedSha256 = bytes === null ? null : createHash("sha256").update(readFileSync(sharedPath)).digest("hex");
    const declaredSha256 = page.sha256 ?? null;
    const hashMatchesManifest = declaredSha256 === null || observedSha256 === declaredSha256;
    // Byte totals and deduplication are keyed only by an observed full SHA-256.
    // A missing local file has no measured byte identity, even if its manifest
    // declares one.
    const contentHash = observedSha256;
    if (bytes !== null && contentHash !== null) pageSizes.set(contentHash, { bytes, file: page.file });
    return { file: page.file, declaredSha256, observedSha256, hashMatchesManifest, contentHash, bytes, path: sharedPath };
  });
  const missingFiles = pages.filter((page) => page.bytes === null).map((page) => page.file);
  completeArtifacts.push({ id: identity.id, scene: identity.scene, node: identity.node, anim: identity.anim, artifactDisposition: "complete", visualValidated: false, snapshotManifest: identity.snapshotManifest ?? null, sourceManifest: identity.sourceManifest ?? null, manifestPath, manifestBytes, pages, missingFiles });
}

const families = new Map();
for (const item of [...completeArtifacts, ...refused]) {
  const key = `${item.scene}\u0000${item.node}`;
  const family = families.get(key) ?? { scene: item.scene, node: item.node, entries: [], completeArtifactAnimations: [], refusedAnimations: [] };
  family.entries.push(item.id);
  (item.artifactDisposition === "complete" ? family.completeArtifactAnimations : family.refusedAnimations).push(item.anim);
  families.set(key, family);
}
for (const family of families.values()) {
  const members = completeArtifacts.filter((item) => item.scene === family.scene && item.node === family.node).sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set();
  for (const item of members) {
    const novel = item.pages.filter((page) => !seen.has(page.contentHash));
    item.standaloneBytes = item.missingFiles.length ? null : item.manifestBytes + item.pages.reduce((sum, page) => sum + page.bytes, 0);
    item.incrementalBytesAfterPriorCompleteArtifacts = novel.some((page) => page.bytes === null) ? null : item.manifestBytes + novel.reduce((sum, page) => sum + page.bytes, 0);
    item.reusedPageFiles = item.pages.filter((page) => seen.has(page.contentHash)).map((page) => page.file);
    item.novelPageFiles = novel.map((page) => page.file);
    for (const page of item.pages) if (page.contentHash !== null) seen.add(page.contentHash);
  }
  family.crossAnimationStatus = members.length > 1 ? "measured" : "unmeasured: fewer than two complete artifact manifests";
}

const uniquePages = [...pageSizes].map(([sha256, page]) => ({ sha256, ...page, references: completeArtifacts.filter((item) => item.pages.some((entry) => entry.contentHash === sha256)).map((item) => item.id) }));
const result = { schema: "geoclip-page-reuse/1", dataset: resolve(datasetPath), cacheRoot: resolve(cacheRoot), completeArtifacts, refused, families: [...families.values()], uniquePages, totals: { completeArtifactManifests: completeArtifacts.length, uniquePages: uniquePages.length, uniquePageBytes: uniquePages.reduce((sum, page) => sum + page.bytes, 0), missingPageFiles: completeArtifacts.flatMap((item) => item.missingFiles) } };
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result.totals));
