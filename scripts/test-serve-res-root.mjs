#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { canonicalAssetKey, cachePaths, createResRootServer, resolveAssetRequest } from "./serve-res-root.mjs";

const root = mkdtempSync(join(tmpdir(), "serve-res-root-"));
const recovered = join(root, "recovered");
const cache = join(root, "couchcoop-asset-cache-v13");

function seed(key, bytes, mime = "application/octet-stream", paired = true) {
  const paths = cachePaths(cache, key);
  mkdirSync(dirname(paths.bin), { recursive: true });
  writeFileSync(paths.bin, bytes);
  if (paired) writeFileSync(paths.meta, mime + "\n");
  return paths;
}

try {
  assert.equal(canonicalAssetKey("/res/", "images/a.tres", new URL("http://bench/res/images/a.tres")), "res://images/a.tres");
  assert.equal(canonicalAssetKey("/res/", "images/a.tres", new URL("http://bench/res/images/a.tres?format=png")), "res://images/a.tres|format=png");
  assert.equal(canonicalAssetKey("/res/", "images/a.tres", new URL("http://bench/res/images/a.tres?format=json")), null, "retired JSON rendition has no cache identity");
  assert.equal(canonicalAssetKey("/res/", "scene.tscn::GradientTexture2D_x", new URL("http://bench/res/scene.tscn::GradientTexture2D_x")), "res://scene.tscn::GradientTexture2D_x");
  assert.equal(canonicalAssetKey("/res/", "scene.tscn::GradientTexture2D_x", new URL("http://bench/res/scene.tscn::GradientTexture2D_x?format=json")), null, "a sub-resource with retired JSON format has no cache identity");
  const known = "res://images/a.tres|format=png";
  assert.equal(cachePaths(cache, known).digest, createHash("sha256").update(known).digest("hex"));
  const ironcladRoute = new URL("http://bench/spines/scenes/creature_visuals/ironclad.tscn?anim=idle_loop&node=Visuals%2FSpineSprite&skin=base&mat=AB12&skel=res%3A%2F%2Fspines%2Fironclad.skel&v=3&still=1&t=1.125");
  const ironcladKey = "spine://scenes/creature_visuals/ironclad.tscn?node=Visuals/SpineSprite&anim=idle_loop&skin=base&mat=AB12&skel=res://spines/ironclad.skel&codec=webp&fps=15&q=85&v=3&still=1&sf=1&t=1.12";
  assert.equal(canonicalAssetKey("/spines/", "scenes/creature_visuals/ironclad.tscn", ironcladRoute), ironcladKey);
  assert.equal(cachePaths(cache, ironcladKey).digest, "76f98a6f0ddfc12a0646a4d47983787dda64caeab106ecee1872d339980ec834");

  mkdirSync(recovered, { recursive: true });
  writeFileSync(join(recovered, "project.godot"), "; recovered raw wins\n");
  const resourcePath = join(recovered, "images", "a.tres");
  mkdirSync(dirname(resourcePath), { recursive: true });
  writeFileSync(resourcePath, "[gd_resource type=\"AtlasTexture\" format=3]\n");
  const shaderPath = join(recovered, "shaders", "fixture.tres");
  mkdirSync(dirname(shaderPath), { recursive: true });
  writeFileSync(shaderPath, `[sub_resource type="Shader" id="Shader_fixture"]\ncode = "shader_type canvas_item;\\nvoid fragment() { COLOR = vec4(1.0); }"\n`);
  const ironcladScene = join(recovered, "scenes", "creature_visuals", "ironclad.tscn");
  const nibbitScene = join(recovered, "scenes", "creature_visuals", "nibbit.tscn");
  mkdirSync(dirname(ironcladScene), { recursive: true });
  writeFileSync(ironcladScene, "; recovered source is not a SpineClipWire\n");
  writeFileSync(nibbitScene, "; cache-miss source is not a SpineClipWire\n");
  seed("res://images/a.tres|format=png", Buffer.from([1, 2, 3]), "image/png");
  seed("res://images/a.tres|format=json", Buffer.from('{"legacy":true}'), "application/json");
  seed("res://cache-only.tres", Buffer.from('{"legacy":true}'), "application/json");
  seed("res://missing-meta.tres|format=png", Buffer.from([6]), "image/png", false);
  seed(ironcladKey, Buffer.from("SPCL\x01\0\0\0", "binary"), "application/vnd.couchcoop.spine-clip");

  const resolvedGenerated = resolveAssetRequest({ root: recovered, assetCacheRoot: cache, url: "http://bench/res/images/a.tres?format=png" });
  assert.equal(resolvedGenerated.status, 200);
  assert.equal(resolvedGenerated.source, "cache");
  assert.equal(resolvedGenerated.contentType, "image/png");
  const resolvedRaw = resolveAssetRequest({ root: recovered, assetCacheRoot: cache, url: "http://bench/res/images/a.tres" });
  assert.deepEqual({ status: resolvedRaw.status, source: resolvedRaw.source, contentType: resolvedRaw.contentType }, {
    status: 200, source: "recovered", contentType: "text/plain"
  });
  const retiredJson = resolveAssetRequest({ root: recovered, assetCacheRoot: cache, url: "http://bench/res/images/a.tres?format=json" });
  assert.deepEqual({ status: retiredJson.status, source: retiredJson.source, contentType: retiredJson.contentType }, {
    status: 400, source: "invalid", contentType: "application/json"
  });
  assert.match(retiredJson.body, /invalid-resource-format/, "a retired JSON request is refused before either source or cache lookup");
  const cachedRaw = resolveAssetRequest({ root: recovered, assetCacheRoot: cache, url: "http://bench/res/cache-only.tres" });
  assert.equal(cachedRaw.status, 404, "a bare legacy cache entry is not a raw Godot resource response");
  const retiredJsonSubresource = resolveAssetRequest({ root: recovered, assetCacheRoot: cache, url: "http://bench/res/shaders/fixture.tres%3A%3AShader_fixture?format=json" });
  assert.deepEqual({ status: retiredJsonSubresource.status, source: retiredJsonSubresource.source, contentType: retiredJsonSubresource.contentType }, {
    status: 400, source: "invalid", contentType: "application/json"
  });
  assert.match(retiredJsonSubresource.body, /invalid-resource-route/, "a retired JSON sub-resource request is never parsed as raw text");
  const resolvedShader = resolveAssetRequest({ root: recovered, assetCacheRoot: cache, url: "http://bench/res/shaders/fixture.tres%3A%3AShader_fixture" });
  assert.deepEqual({ status: resolvedShader.status, source: resolvedShader.source, contentType: resolvedShader.contentType, body: resolvedShader.body }, {
    status: 200, source: "recovered", contentType: "text/plain", body: "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(1.0); }"
  });
  const resolvedSpine = resolveAssetRequest({ root: recovered, assetCacheRoot: cache, url: ironcladRoute });
  assert.equal(resolvedSpine.status, 200);
  assert.equal(resolvedSpine.source, "cache");
  assert.equal(resolvedSpine.contentType, "application/vnd.couchcoop.spine-clip");
  const missingSpine = resolveAssetRequest({ root: recovered, assetCacheRoot: cache, url: "http://bench/spines/scenes/creature_visuals/nibbit.tscn?anim=idle_loop&node=Visuals%2FSpineSprite&still=1" });
  assert.equal(missingSpine.status, 404, "a spine cache miss must never fall through to its recovered .tscn source");
  assert.equal(missingSpine.source, "missing");

  const server = createResRootServer({ root: recovered, assetCacheRoot: cache });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const raw = await fetch(`${base}/res/project.godot`);
    assert.equal(raw.status, 200);
    assert.equal(await raw.text(), "; recovered raw wins\n");

    const rawResource = await fetch(`${base}/res/images/a.tres?format=raw`);
    assert.equal(rawResource.status, 200);
    assert.equal(rawResource.headers.get("content-type"), "text/plain");
    assert.equal(await rawResource.text(), "[gd_resource type=\"AtlasTexture\" format=3]\n");

    const retiredJsonResource = await fetch(`${base}/res/images/a.tres?format=json`);
    assert.equal(retiredJsonResource.status, 400);
    assert.equal(retiredJsonResource.headers.get("content-type"), "application/json");
    assert.match(await retiredJsonResource.text(), /invalid-resource-format/);

    // Existing Shader `::` extraction is intentionally preferred over a cache entry; the fallback must not turn
    // a shader source request into arbitrary generated bytes just because serve-res-root gained cache support.
    const shader = await fetch(`${base}/res/shaders/fixture.tres%3A%3AShader_fixture`);
    assert.equal(shader.status, 200);
    assert.equal(shader.headers.get("content-type"), "text/plain");
    assert.equal(await shader.text(), "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(1.0); }");

    const generated = await fetch(`${base}/res/images/a.tres?format=png`);
    assert.equal(generated.status, 200);
    assert.equal(generated.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await generated.arrayBuffer())], [1, 2, 3]);

    const spine = await fetch(`${base}${ironcladRoute.pathname}${ironcladRoute.search}`);
    assert.equal(spine.status, 200);
    assert.equal(spine.headers.get("content-type"), "application/vnd.couchcoop.spine-clip");
    assert.deepEqual([...new Uint8Array(await spine.arrayBuffer())], [...Buffer.from("SPCL\x01\0\0\0", "binary")]);

    const absentSpine = await fetch(`${base}/spines/scenes/creature_visuals/nibbit.tscn?anim=idle_loop&node=Visuals%2FSpineSprite&still=1`);
    assert.equal(absentSpine.status, 404);

    const malformed = await fetch(`${base}/res/missing-meta.tres?format=png`);
    assert.equal(malformed.status, 404, "a .bin without its production .meta is never a cache hit");
    assert.equal(server.benchStats.servedCache, 2);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  console.log("serve-res-root cache tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
