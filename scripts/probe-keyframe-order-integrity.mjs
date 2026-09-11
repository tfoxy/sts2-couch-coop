#!/usr/bin/env node
// R10 WS-B — KEYFRAME/ORDER INTEGRITY PROBE (offline; reads recorded mirror streams, never touches the game).
//
// Asserts the wire invariant the browser mirror's structure builder has always assumed but nobody checked:
//
//     every id in a delta's paint order names a node the client actually holds.
//
// Why it matters. Both mirror clients pick a STRUCTURAL walk purely on "the order array changed" — an update walk
// never rebuilds the parent→children index. So if an id is already in the order when its node's FIRST upsert
// arrives, that upsert carries no order change, the node is merged into the retained map, and it is never placed in
// the tree. It renders as NOTHING until some later delta happens to touch the order. A browser reload fixes it
// (the fresh keyframe carries both halves together), which is exactly how the defect was reported: "the relics are
// missing after the chest opens until I reload" and "the targeting arrow never shows on the first select after a
// game restart".
//
// The violation was real and large. Measured on this repo's checked-in captures BEFORE the fix:
//
//     audit-event-enter     353 upserts / 2937 order ids  -> 2584 order ids with no node (88%)
//     audit-cardreward-open 2253 / 3322                   -> 1069
//     audit-shop-open       2418 / 3463                   -> 1045
//     r9-carddetail         4429 / 4552                   ->  123
//
// (Captures taken right after the producer's own full keyframe read 0 — the producer's keyframe emits hidden
// subtrees too, which is why a browser reload always "fixed" it.)
//
// Usage:
//   node scripts/probe-keyframe-order-integrity.mjs .sts2/bench/*.ndjson
//   node scripts/probe-keyframe-order-integrity.mjs --json <file>...
//
// Exit code 1 if any recording violates the invariant, so this can gate a fix.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  console.error("usage: probe-keyframe-order-integrity.mjs [--json] <recording.ndjson>...");
  process.exit(2);
}

function scan(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

  // Client-side simulation: the retained node map + the order array, applied exactly as sceneTree.applySceneDelta
  // does. Order patches always produce a NEW array reference, so they can never hide a late node; they are only
  // relevant here because they mean "the order changed", which is all this probe needs to know.
  const known = new Set();
  const names = new Map();
  let orderSet = new Set();
  let orderLen = 0;

  let deltas = 0;
  let keyframes = 0;
  let keyframeDangling = 0; // order ids a KEYFRAME has no node for (the host-side half)
  let keyframeOrderLen = 0;
  const lateNodes = []; // ids introduced with no order change while already in the order (the client-visible half)

  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec.data) continue;
    let msg;
    try {
      msg = JSON.parse(rec.data);
    } catch {
      continue;
    }
    if (msg.type !== "scene-delta") continue;
    deltas += 1;

    if (msg.full) {
      keyframes += 1;
      known.clear();
      orderSet = new Set();
      orderLen = 0;
      const carried = new Set((msg.upserts ?? []).map((u) => u.id));
      const order = msg.orderedIds ?? [];
      if (keyframes === 1) {
        keyframeOrderLen = order.length;
        keyframeDangling = order.filter((id) => !carried.has(id)).length;
      }
    }

    for (const id of msg.removedIds ?? []) known.delete(id);

    const carriesOrder = Array.isArray(msg.orderedIds) || msg.orderPatch != null;
    for (const u of msg.upserts ?? []) {
      if (u.name) names.set(u.id, u.name);
      const introduced = !known.has(u.id);
      known.add(u.id);
      if (introduced && !carriesOrder && orderSet.has(u.id)) {
        lateNodes.push({ delta: deltas, id: u.id, name: names.get(u.id) ?? "?" });
      }
    }

    if (Array.isArray(msg.orderedIds)) {
      orderSet = new Set(msg.orderedIds);
      orderLen = msg.orderedIds.length;
    }
  }

  const danglingAtEnd = [...orderSet].filter((id) => !known.has(id)).length;
  return {
    file: path.basename(file),
    deltas,
    keyframes,
    keyframeOrderLen,
    keyframeDangling,
    orderLen,
    danglingAtEnd,
    lateNodes,
    ok: keyframeDangling === 0 && danglingAtEnd === 0 && lateNodes.length === 0
  };
}

const results = files.map(scan);

if (jsonOut) {
  console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
} else {
  for (const r of results) {
    const status = r.ok ? "OK  " : "FAIL";
    console.log(
      `${status} ${r.file}: deltas=${r.deltas} keyframeOrder=${r.keyframeOrderLen} ` +
        `keyframeOrderIdsWithNoNode=${r.keyframeDangling} orderIdsWithNoNodeAtEnd=${r.danglingAtEnd} ` +
        `lateNodeIntroductions=${r.lateNodes.length}`
    );
    if (r.lateNodes.length > 0) {
      const byName = new Map();
      for (const n of r.lateNodes) byName.set(n.name, (byName.get(n.name) ?? 0) + 1);
      const top = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 10);
      console.log(`      late nodes (name x count): ${top.map(([n, c]) => `${n}x${c}`).join(", ")}`);
    }
  }
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
