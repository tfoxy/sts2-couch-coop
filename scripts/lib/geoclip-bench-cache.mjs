// FS half of the KNIGHTS_ELITE geoclip bench: making each leg a genuine COLD produce, and PROVING it was one.
//
// The naive way to clear a key is to rebuild it — sha256 of `BuildSpineKey(...) + "&geo=1&gv=1"` — and delete
// that path. That is the way this has gone wrong before: a derivation that drifts from the host's by one
// selector deletes nothing, every leg after the first is a cache hit, and the bench reports a beautiful,
// meaningless number. So this file never derives a path from a key.
//
// Instead it works by SNAPSHOT DIFF. Before a leg it records every cache entry; after the leg the entries that
// appeared are, by construction, exactly what the leg produced; it deletes those. Two properties fall out:
//
//   * the clear is exact and cannot silently miss (it deletes what it watched appear), and
//   * an empty diff is a POSITIVE finding — the leg wrote nothing, so it did not enter the producer. That is
//     the discrimination a bare 404 cannot give you: an unresolvable cache root and a real refusal are the same
//     HTTP response, but a refusal writes a receipt and an unresolvable root writes nothing at all.
//
// The one thing snapshot-diff cannot do is start clean, so the run begins with a whole-store purge. That is why
// the private-root guard below is not optional: a purge pointed at the operator's real cache would delete a
// play session's worth of bakes.

import { constants } from "node:fs";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Store-root directory names, as the two C# stores mint them (SchemaVersion in each class). */
const STORE_ROOT_PATTERN = /^couchcoop-(geoclip-cache|asset-cache)-v\d+$/;

/** How deep under the cache root to look for a store. `<root>/assets/<schema>` is the shipped layout; 4 is slack. */
const DISCOVERY_DEPTH = 4;

/** A pose directory is named by the full sha256 hex of its geoclip key (CouchCoopGeoclipStore). */
const POSE_DIR_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Refuse to operate on a cache root that is not obviously private to this bench.
 *
 * The bench purges. The operator's root holds their session's bakes and, worse, sits beside the `browser-port`
 * record another agent may be reading. `instances.symlinkUserDataDirs: []` plus an explicit COUCHCOOP_CACHE_ROOT
 * is the round's rule; this is the check that the rule was actually followed.
 */
export function assertPrivateCacheRoot(root, { home = homedir(), allowUnsafe = false } = {}) {
  if (typeof root !== "string" || root.trim().length === 0) throw new Error("--cache-root is required: this bench purges, so it must be told an explicitly private root");
  const resolved = path.resolve(root);
  const forbidden = [
    path.join(home, ".local", "share", "SlayTheSpire2"),
    path.join(home, ".steam"),
    path.join(home, ".var", "app"),
  ];
  for (const bad of forbidden) {
    if (resolved === bad || resolved.startsWith(bad + path.sep)) {
      if (allowUnsafe) continue;
      throw new Error(
        `refusing to use ${resolved} as the bench cache root: it is inside ${bad}, which holds the operator's own game data. `
        + "Point COUCHCOOP_CACHE_ROOT at a private scratch directory for this instance.");
    }
  }
  if (resolved === "/" || resolved.split(path.sep).filter(Boolean).length < 2) {
    throw new Error(`refusing to use ${resolved} as the bench cache root: too close to the filesystem root to purge safely`);
  }
  return resolved;
}

async function exists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listDirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }));
  } catch {
    return [];
  }
}

/** Every couchcoop cache store under `cacheRoot`, found by directory NAME rather than by rebuilding the path. */
export async function discoverStoreRoots(cacheRoot, depth = DISCOVERY_DEPTH) {
  const found = [];
  const walk = async (dir, remaining) => {
    if (remaining < 0) return;
    for (const entry of await listDirs(dir)) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (STORE_ROOT_PATTERN.test(entry.name)) {
        found.push({ kind: entry.name.startsWith("couchcoop-geoclip") ? "geoclip" : "asset", path: full, name: entry.name });
        continue; // a store root never nests another
      }
      await walk(full, remaining - 1);
    }
  };
  await walk(path.resolve(cacheRoot), depth);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

async function entryStat(target) {
  try {
    const info = await stat(target);
    return { size: info.isDirectory() ? null : info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Every cache entry a bake could create, as a flat map of absolute path -> descriptor.
 *
 * A pose directory is ONE entry (kind `poseDir`) rather than its files, so clearing it is one `rm -rf` and the
 * diff cannot half-delete an artifact. `.complete` presence rides on the descriptor because a directory without
 * it never resolves — a leg that created a pose dir with no marker produced a dead bake, which is worth seeing.
 */
export async function snapshotCache(cacheRoot) {
  const stores = await discoverStoreRoots(cacheRoot);
  const entries = {};
  for (const store of stores) {
    if (store.kind === "geoclip") {
      for (const entry of await listDirs(store.path)) {
        const full = path.join(store.path, entry.name);
        if (entry.isDirectory() && POSE_DIR_PATTERN.test(entry.name)) {
          const info = await entryStat(full);
          if (info) entries[full] = { kind: "poseDir", store: store.name, complete: await exists(path.join(full, ".complete")), ...info };
        } else if (entry.isDirectory() && (entry.name === "refusals" || entry.name === "pages" || entry.name === "staging")) {
          for (const child of await listDirs(full)) {
            const childPath = path.join(full, child.name);
            const info = await entryStat(childPath);
            if (info) entries[childPath] = { kind: entry.name === "refusals" ? "refusal" : entry.name === "pages" ? "page" : "staging", store: store.name, ...info };
          }
        }
      }
    } else {
      // The raster still lands in the asset cache as <scheme>/<sha256>.bin + .meta.
      for (const scheme of await listDirs(store.path)) {
        if (!scheme.isDirectory()) continue;
        const schemeDir = path.join(store.path, scheme.name);
        for (const blob of await listDirs(schemeDir)) {
          if (!blob.isFile()) continue;
          const blobPath = path.join(schemeDir, blob.name);
          const info = await entryStat(blobPath);
          if (info) entries[blobPath] = { kind: "assetBlob", store: store.name, scheme: scheme.name, ...info };
        }
      }
    }
  }
  return { cacheRoot: path.resolve(cacheRoot), stores, entries, takenAt: Date.now() };
}

/**
 * What appeared, and what changed, between two snapshots.
 *
 * `created` is the leg's own output — the thing to delete, and the thing that proves the producer ran.
 * `modified` is separate because an atlas page adopted by a second rig, or a refusal receipt rewritten at a new
 * policy revision, is a real produce that created no new path.
 */
export function diffSnapshots(before, after) {
  const created = [];
  const modified = [];
  for (const [full, entry] of Object.entries(after.entries)) {
    const previous = before.entries[full];
    if (!previous) created.push({ path: full, ...entry });
    else if (previous.mtimeMs !== entry.mtimeMs || previous.size !== entry.size || previous.complete !== entry.complete) {
      modified.push({ path: full, before: previous, after: entry });
    }
  }
  const removed = Object.keys(before.entries).filter((full) => !after.entries[full]).map((full) => ({ path: full, ...before.entries[full] }));
  return { created, modified, removed };
}

/** Delete the entries a leg created. Directories go recursively; anything already gone is not an error. */
export async function removeEntries(entries) {
  const removed = [];
  const failed = [];
  for (const entry of entries) {
    try {
      await rm(entry.path, { recursive: true, force: true });
      removed.push(entry.path);
    } catch (error) {
      failed.push({ path: entry.path, error: String(error?.message ?? error) });
    }
  }
  return { removed, failed };
}

/**
 * Empty every discovered store so leg 1 of every creature is as cold as leg 8. Returns what it removed, which
 * the report carries: a purge that found nothing to remove on a root that was supposed to hold a warm session
 * is itself a signal that the harness is pointed at the wrong root.
 */
export async function purgeCache(cacheRoot, { home = homedir(), allowUnsafe = false } = {}) {
  const resolved = assertPrivateCacheRoot(cacheRoot, { home, allowUnsafe });
  const before = await snapshotCache(resolved);
  const stores = before.stores;
  const removed = [];
  for (const store of stores) {
    for (const entry of await listDirs(store.path)) {
      const full = path.join(store.path, entry.name);
      await rm(full, { recursive: true, force: true });
      removed.push(full);
    }
  }
  const after = await snapshotCache(resolved);
  await mkdir(resolved, { recursive: true });
  return {
    cacheRoot: resolved,
    storesFound: stores.map((store) => store.path),
    entriesBefore: Object.keys(before.entries).length,
    entriesAfter: Object.keys(after.entries).length,
    topLevelRemoved: removed,
  };
}

/**
 * The producer-entry verdict for one leg. This is the anti-vacuity check the whole bench rests on.
 *
 * A leg "entered the producer" when at least one of three independent witnesses fired:
 *   perfRow      the host recorded a bake in /perf/spine.json for this lane's key,
 *   cacheWrite   the leg created or modified a cache entry (a pose directory, an atlas page, an asset blob),
 *   refusal      the leg wrote a durable refusal receipt.
 * None of the three means the response came from somewhere that is not the producer — a warm cache, or a route
 * that 404'd before reaching it. Such a leg is excluded and named; it is never counted as a fast produce.
 */
export function producerProofFor({ hostWindow, diff }) {
  const witnesses = [];
  if (hostWindow?.hostRow === "present") witnesses.push({ witness: "perfRow", key: hostWindow.key ?? null, bakeMs: hostWindow.bakeMs ?? null });
  const created = diff?.created ?? [];
  const modified = diff?.modified ?? [];
  const refusals = created.filter((entry) => entry.kind === "refusal");
  const writes = [...created, ...modified].filter((entry) => (entry.kind ?? entry.after?.kind) !== "refusal");
  if (writes.length > 0) witnesses.push({ witness: "cacheWrite", entries: writes.length, kinds: [...new Set(writes.map((entry) => entry.kind ?? entry.after?.kind))] });
  if (refusals.length > 0) witnesses.push({ witness: "refusal", receipts: refusals.map((entry) => path.basename(entry.path)) });
  return witnesses.length === 0 ? null : { witnesses, summary: witnesses.map((w) => w.witness).join("+") };
}
