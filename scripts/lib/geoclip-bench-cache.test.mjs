import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertPrivateCacheRoot,
  diffSnapshots,
  discoverStoreRoots,
  producerProofFor,
  purgeCache,
  removeEntries,
  snapshotCache,
} from "./geoclip-bench-cache.mjs";

const POSE_A = "a".repeat(64);
const POSE_B = "b".repeat(64);

// The layout CouchCoopGeoclipStore and SpirectlAssetBinaryCache actually mint under an explicit
// COUCHCOOP_CACHE_ROOT: <root>/assets/<schema>/... for both stores.
async function makeCacheRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "geoclip-bench-cache-"));
  const geoclip = path.join(root, "assets", "couchcoop-geoclip-cache-v1");
  const asset = path.join(root, "assets", "couchcoop-asset-cache-v13");
  await mkdir(path.join(geoclip, "pages"), { recursive: true });
  await mkdir(path.join(geoclip, "refusals"), { recursive: true });
  await mkdir(path.join(geoclip, "staging"), { recursive: true });
  await mkdir(path.join(asset, "spine"), { recursive: true });
  return { root, geoclip, asset };
}

async function bakeGeoclip(geoclip, pose) {
  await mkdir(path.join(geoclip, pose), { recursive: true });
  await writeFile(path.join(geoclip, pose, "manifest.json"), "{}");
  await writeFile(path.join(geoclip, pose, ".complete"), "");
  await writeFile(path.join(geoclip, "pages", `page-${pose.slice(0, 16)}.webp`), "png-bytes");
}

async function bakeStill(asset, hash) {
  await writeFile(path.join(asset, "spine", `${hash}.bin`), "webp-bytes");
  await writeFile(path.join(asset, "spine", `${hash}.meta`), "image/webp");
}

test("discoverStoreRoots finds both stores by directory NAME, not by rebuilding a path", async (t) => {
  const { root, geoclip, asset } = await makeCacheRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = await discoverStoreRoots(root);
  assert.deepEqual(stores.map((store) => store.kind).sort(), ["asset", "geoclip"]);
  assert.ok(stores.some((store) => store.path === geoclip));
  assert.ok(stores.some((store) => store.path === asset));
});

test("a snapshot records pose directories, pages, refusals and asset blobs", async (t) => {
  const { root, geoclip, asset } = await makeCacheRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await bakeGeoclip(geoclip, POSE_A);
  await bakeStill(asset, "c".repeat(64));
  await writeFile(path.join(geoclip, "refusals", `${POSE_B}.json`), "{}");
  const snapshot = await snapshotCache(root);
  const kinds = Object.values(snapshot.entries).map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ["assetBlob", "assetBlob", "page", "poseDir", "refusal"]);
  const pose = snapshot.entries[path.join(geoclip, POSE_A)];
  assert.equal(pose.complete, true, "the .complete marker rides on the descriptor: a dir without it never resolves");
});

test("a pose directory is ONE entry, so clearing it can never half-delete an artifact", async (t) => {
  const { root, geoclip } = await makeCacheRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await bakeGeoclip(geoclip, POSE_A);
  const snapshot = await snapshotCache(root);
  const poseEntries = Object.keys(snapshot.entries).filter((key) => key.includes(POSE_A));
  assert.equal(poseEntries.length, 1);
  assert.equal(poseEntries[0], path.join(geoclip, POSE_A), "the manifest inside it is not separately tracked");
});

test("the diff is exactly what the leg produced, and clearing it restores the previous state", async (t) => {
  const { root, geoclip, asset } = await makeCacheRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await bakeStill(asset, "d".repeat(64));
  const before = await snapshotCache(root);

  await bakeGeoclip(geoclip, POSE_A);              // the leg bakes
  const after = await snapshotCache(root);
  const diff = diffSnapshots(before, after);
  assert.equal(diff.created.length, 2, "one pose directory plus its adopted atlas page");
  assert.deepEqual(diff.created.map((entry) => entry.kind).sort(), ["page", "poseDir"]);

  const cleared = await removeEntries(diff.created);
  assert.equal(cleared.removed.length, 2);
  assert.deepEqual(cleared.failed, []);
  assert.equal(existsSync(path.join(geoclip, POSE_A)), false);
  const restored = await snapshotCache(root);
  assert.deepEqual(Object.keys(restored.entries).sort(), Object.keys(before.entries).sort(),
    "after clearing, the store is byte-for-byte back where it was, so the next leg is as cold as this one was");
});

test("a rewritten refusal receipt shows up as MODIFIED, not as nothing", async (t) => {
  const { root, geoclip } = await makeCacheRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = path.join(geoclip, "refusals", `${POSE_A}.json`);
  await writeFile(receipt, JSON.stringify({ policy: "geoclip-refusal/1" }));
  const before = await snapshotCache(root);
  await new Promise((resolve) => setTimeout(resolve, 12));
  await writeFile(receipt, JSON.stringify({ policy: "geoclip-refusal/1", arm: "ownership" }));
  const diff = diffSnapshots(before, await snapshotCache(root));
  assert.equal(diff.created.length, 0);
  assert.equal(diff.modified.length, 1);
});

// ---------------------------------------------------------------------------------------------------------
// The producer-entry proof: the check the whole bench rests on
// ---------------------------------------------------------------------------------------------------------

test("a leg that wrote nothing and recorded nothing has NO producer proof", () => {
  const proof = producerProofFor({ hostWindow: { hostRow: "absent" }, diff: { created: [], modified: [] } });
  assert.equal(proof, null, "this is the case a bare 404 from an unresolvable cache root produces");
});

test("a /perf row alone is a producer proof", () => {
  const proof = producerProofFor({ hostWindow: { hostRow: "present", key: "spine://x&geo=1", bakeMs: 180 }, diff: { created: [], modified: [] } });
  assert.equal(proof.summary, "perfRow");
});

test("a cache write alone is a producer proof, which is what carries the bench before WS-B lands", () => {
  const proof = producerProofFor({ hostWindow: { hostRow: "absent" }, diff: { created: [{ path: "/x", kind: "poseDir" }], modified: [] } });
  assert.equal(proof.summary, "cacheWrite");
  assert.deepEqual(proof.witnesses[0].kinds, ["poseDir"]);
});

test("a refusal receipt is a producer proof and is reported as a refusal, not as a cache write", () => {
  const proof = producerProofFor({
    hostWindow: { hostRow: "absent" },
    diff: { created: [{ path: "/store/refusals/aa.json", kind: "refusal" }], modified: [] },
  });
  assert.equal(proof.summary, "refusal");
  assert.deepEqual(proof.witnesses[0].receipts, ["aa.json"]);
});

test("all three witnesses can fire together and are all reported", () => {
  const proof = producerProofFor({
    hostWindow: { hostRow: "present", key: "k", bakeMs: 1 },
    diff: { created: [{ path: "/p", kind: "poseDir" }, { path: "/store/refusals/bb.json", kind: "refusal" }], modified: [] },
  });
  assert.equal(proof.summary, "perfRow+cacheWrite+refusal");
});

// ---------------------------------------------------------------------------------------------------------
// The purge guard
// ---------------------------------------------------------------------------------------------------------

test("the operator's own game data is refused as a bench cache root", () => {
  const home = "/home/someone";
  assert.throws(() => assertPrivateCacheRoot(path.join(home, ".local", "share", "SlayTheSpire2"), { home }), /operator's own game data/);
  assert.throws(() => assertPrivateCacheRoot(path.join(home, ".local", "share", "SlayTheSpire2", "couch-coop"), { home }), /operator's own game data/);
  assert.throws(() => assertPrivateCacheRoot(path.join(home, ".steam", "steam"), { home }), /operator's own game data/);
});

test("a path too close to the filesystem root is refused however it is spelled", () => {
  assert.throws(() => assertPrivateCacheRoot("/", { home: "/home/someone" }), /too close/);
  assert.throws(() => assertPrivateCacheRoot("/tmp", { home: "/home/someone" }), /too close/);
  assert.throws(() => assertPrivateCacheRoot("", { home: "/home/someone" }), /required/);
});

test("a private scratch root is accepted and resolved", () => {
  assert.equal(assertPrivateCacheRoot("/tmp/geoclip-bench/cache", { home: "/home/someone" }), "/tmp/geoclip-bench/cache");
});

test("purgeCache empties both stores and reports what it removed", async (t) => {
  const { root, geoclip, asset } = await makeCacheRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await bakeGeoclip(geoclip, POSE_A);
  await bakeGeoclip(geoclip, POSE_B);
  await bakeStill(asset, "e".repeat(64));
  const result = await purgeCache(root, { home: "/home/someone" });
  assert.equal(result.entriesBefore, 6);
  assert.equal(result.entriesAfter, 0);
  assert.equal(result.storesFound.length, 2);
  assert.deepEqual(Object.keys((await snapshotCache(root)).entries), []);
});
