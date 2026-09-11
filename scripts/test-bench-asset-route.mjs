#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BENCH_ASSET_FAMILIES, isBenchAssetRoute } from "./lib/bench-asset-route.mjs";
import { cachePaths, canonicalAssetKey, resolveAssetRequest } from "./serve-res-root.mjs";

assert.equal(isBenchAssetRoute("/res/project.godot"), true);
assert.equal(isBenchAssetRoute("/models/ironclad.png"), true);
assert.equal(isBenchAssetRoute("/spines/scenes/creature_visuals/ironclad.tscn"), true);
assert.equal(isBenchAssetRoute("/bg/overgrowth.png"), false, "/bg remains Vite's faithful explicit fixture");
assert.equal(isBenchAssetRoute("/recording"), false);
assert.deepEqual(BENCH_ASSET_FAMILIES, ["res", "models", "spines"]);

const root = mkdtempSync(join(tmpdir(), "bench-asset-route-"));
try {
  const cache = join(root, "cache");
  const ironclad = join(root, "scenes", "creature_visuals", "ironclad.tscn");
  const nibbit = join(root, "scenes", "creature_visuals", "nibbit.tscn");
  mkdirSync(dirname(ironclad), { recursive: true });
  writeFileSync(ironclad, "; source scene is not a browser SpineClipWire\n");
  writeFileSync(nibbit, "; source scene is not a browser SpineClipWire\n");

  const route = new URL("/spines/scenes/creature_visuals/ironclad.tscn?anim=idle_loop&node=Visuals%2FSpineSprite&still=1", "http://bench");
  const key = canonicalAssetKey("/spines/", "scenes/creature_visuals/ironclad.tscn", route);
  const paths = cachePaths(cache, key);
  mkdirSync(dirname(paths.bin), { recursive: true });
  writeFileSync(paths.bin, Buffer.from("SPCL\x01\0\0\0", "binary"));
  writeFileSync(paths.meta, "application/vnd.couchcoop.spine-clip\n");

  const answer = resolveAssetRequest({
    root,
    assetCacheRoot: cache,
    url: route
  });
  assert.equal(answer.status, 200, "the exact smoke route resolves from its canonical spine clip cache key");
  assert.equal(answer.source, "cache");
  assert.equal(answer.contentType, "application/vnd.couchcoop.spine-clip");

  const missing = resolveAssetRequest({
    root,
    assetCacheRoot: cache,
    url: new URL("/spines/scenes/creature_visuals/nibbit.tscn?anim=idle_loop&node=Visuals%2FSpineSprite&still=1", "http://bench")
  });
  assert.equal(missing.status, 404, "a recovered .tscn must not mask a missing SpineClipWire cache artifact");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("bench asset-route tests passed");
