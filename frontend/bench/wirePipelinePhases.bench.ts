// Tier (i) companion bench: SYNTHETIC combat-shaped replay for the socket -> parse -> apply -> wire-scan
// pipeline this round (WP-C) trims. mirrorReplay.bench.ts needs a recorded .ndjson stream (device/local-only,
// not committed) and reports JSON.parse + parse/apply + reconcile as combined totals; this file needs no
// recording, scales the node count explicitly (1k/3k, per the round brief), and breaks JSON.parse /
// parseSceneDelta / applySceneDelta apart instead of reporting them as one "apply" number — plus it is the one
// place that puts a number on the StaticBackground.vue wire-scan trim itself (there is no production hook that
// exposes that cost otherwise; wirePhaseTrace.ts's marks are for a live DevTools/CDP capture, not a node bench).
//
//   cd frontend && npm run bench:mirror
//
// Runs under vitest.bench.config.ts (bench/**/*.bench.ts), same as mirrorReplay.bench.ts; not part of the
// default `npm test` include.

import { describe, it } from "vitest";

import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorState
} from "../src/mirror/sceneTree";
import {
  isCombatBackgroundSceneRoot,
  isEventBackgroundSceneRoot,
  isRoomBackgroundSubtreeRoot
} from "../src/mirror/renderer/staticBackgroundPolicy";

const emit = (line = "") => process.stdout.write(line + "\n");
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------------------------------------
// Synthetic combat scene: the same CombatRoom > CombatSceneContainer > BgContainer > bg-root(+layer) chain
// staticBackground.spec.ts's `combatNodes()` fixture uses (the real producer convention), a small 10-card hand
// (the part an incremental delta actually touches — a real combat delta touches a handful of nodes, never the
// whole map), and FILLER nodes (enemies/relics/particles/text spans — everything else a 1-3k node combat scene
// is mostly made of) padding the total node count out to the requested size. This keeps the realistic part
// (one delta's byte size, the chain shape the wire scan matches) decoupled from the scaling knob (total nodes
// the scan has to walk), which mirrors the real system: the retained map is big, any ONE delta is small.
function rawNode(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 140 } },
    visible: true,
    opacity: 1,
    zIndex: 0,
    ...over
  };
}

const UNDERDOCKS_BG = "res://scenes/backgrounds/underdocks/underdocks_background.tscn";
const UNDERDOCKS_LAYER = "res://scenes/backgrounds/underdocks/layers/underdocks_bg_00_c.tscn";
const HAND_SIZE = 10;

function buildCombatScene(totalNodes: number): { upserts: Record<string, unknown>[]; order: string[] } {
  const upserts: Record<string, unknown>[] = [
    rawNode("room", null, { name: "CombatRoom" }),
    rawNode("csc", "room", { name: "CombatSceneContainer" }),
    rawNode("bgc", "csc", { name: "BgContainer" }),
    rawNode("bg", "bgc", { name: "UnderdocksBackground", sceneFilePath: UNDERDOCKS_BG }),
    rawNode("layer0", "bg", { name: "UnderdocksBg00C", sceneFilePath: UNDERDOCKS_LAYER }),
    rawNode("hand", "room", { name: "HandContainer" })
  ];
  const order = upserts.map((n) => n.id as string);
  for (let i = 0; i < HAND_SIZE; i++) {
    const id = `card${i}`;
    upserts.push(rawNode(id, "hand", { name: `Card${i}` }));
    order.push(id);
  }
  // Filler: unrelated subtree depth/breadth a real combat scene carries (enemy rig nodes, relic icons, particle
  // markers, rich-text spans) — parented to "room" so it never collides with the hand/bg chains above.
  const fillerCount = Math.max(0, totalNodes - upserts.length);
  for (let i = 0; i < fillerCount; i++) {
    const id = `filler${i}`;
    upserts.push(rawNode(id, "room", { name: `Filler${i}` }));
    order.push(id);
  }
  return { upserts, order };
}

// One incremental "watch" scene-delta: a volatile reorder/retint of the hand only — the shape the round's
// background trace flagged (13 upserts + an orderPatch) — touching NOTHING the wire scan reads (no sceneFilePath,
// no BgContainer/SceneContainer/CombatSceneContainer name, no reparent of any such node).
function buildHandShuffleDelta(seed: number): Record<string, unknown> {
  const upserts: Record<string, unknown>[] = [];
  for (let k = 0; k < HAND_SIZE; k++) {
    upserts.push(
      rawNode(`card${k}`, "hand", {
        name: "", // volatile-only upsert
        opacity: 0.5 + ((k + seed) % 5) / 10,
        zIndex: (k + seed) % HAND_SIZE,
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: (k + seed) * 12, y: 0 } }
      })
    );
  }
  const children: string[] = [];
  for (let k = 0; k < HAND_SIZE; k++) {
    children.push(`card${(k + seed) % HAND_SIZE}`);
  }
  return {
    type: "scene-delta",
    full: false,
    screenType: "run",
    upserts,
    removedIds: [],
    orderPatch: { roots: null, parents: [{ p: "hand", c: children }] }
  };
}

function fullKeyframeMessage(totalNodes: number): { text: string; order: string[] } {
  const { upserts, order } = buildCombatScene(totalNodes);
  return {
    text: JSON.stringify({ type: "scene-delta", full: true, screenType: "run", upserts, removedIds: [], orderedIds: order }),
    order
  };
}

// ---------------------------------------------------------------------------------------------------------
// The scan itself: byte-identical logic to StaticBackground.vue's wireFallback body (production cannot export
// it — it is a local computed inside a <script setup> SFC — so this is kept in lockstep deliberately; it calls
// the SAME exported predicates production does, so it cannot silently diverge on WHICH nodes match, only on
// the loop shape around them, and the loop shape is the part being measured).
function wireFallbackScan(state: MirrorState): string | null {
  let combat: string | null = null;
  let family: string | null = null;
  for (const [, node] of state.nodes) {
    const path = node.sceneFilePath;
    if (path) {
      if (/^res:\/\/scenes\/backgrounds\/([a-z0-9_]+)\/\1_background\.tscn$/.test(path) && isCombatBackgroundSceneRoot(node, state.nodes)) {
        combat = path;
        break;
      }
      if (family === null && isEventBackgroundSceneRoot(node)) {
        family = path;
      }
      continue;
    }
    if (family === null && isRoomBackgroundSubtreeRoot(node, state.nodes)) {
      family = "room";
    }
  }
  return combat ?? family;
}

const NODE_COUNTS = [1000, 3000];
const REPEATS = 200;

describe("wire pipeline phase bench (synthetic, tier i companion)", () => {
  it("measures JSON.parse / parseSceneDelta / applySceneDelta / wireFallback-scan at realistic node counts", () => {
    const report: Record<string, unknown>[] = [];

    for (const totalNodes of NODE_COUNTS) {
      const { text: fullText } = fullKeyframeMessage(totalNodes);
      const fullRaw = JSON.parse(fullText);

      // --- JSON.parse: the realistic per-tick message (13 upserts + orderPatch), NOT the keyframe -----------
      const tickText = JSON.stringify(buildHandShuffleDelta(0));
      for (let i = 0; i < 50; i++) JSON.parse(tickText); // warm
      const parseMs: number[] = [];
      for (let r = 0; r < REPEATS; r++) {
        const t0 = performance.now();
        JSON.parse(tickText);
        parseMs.push(performance.now() - t0);
      }

      // --- parseSceneDelta: pre-parsed object -> MirrorDelta -----------------------------------------------
      const tickRaw = JSON.parse(tickText);
      for (let i = 0; i < 50; i++) parseSceneDelta(tickRaw); // warm
      const parseDeltaMs: number[] = [];
      for (let r = 0; r < REPEATS; r++) {
        const t0 = performance.now();
        parseSceneDelta(tickRaw);
        parseDeltaMs.push(performance.now() - t0);
      }

      // --- applySceneDelta: a big retained map, one realistic incremental delta per call -------------------
      // Re-applies the SAME parsed delta object every rep on purpose (parse is measured separately above) —
      // only `applySceneDelta`'s own work is inside the timed bracket.
      const state = createMirrorState();
      applySceneDelta(state, parseSceneDelta(fullRaw)!);
      const tickDelta = parseSceneDelta(tickRaw)!;
      for (let i = 0; i < 20; i++) applySceneDelta(state, tickDelta); // warm
      const applyMs: number[] = [];
      for (let r = 0; r < REPEATS; r++) {
        const t0 = performance.now();
        applySceneDelta(state, tickDelta);
        applyMs.push(performance.now() - t0);
      }

      // --- wireFallback scan: the walk itself, isolated from the cache around it ---------------------------
      const scanState = createMirrorState();
      applySceneDelta(scanState, parseSceneDelta(fullRaw)!);
      for (let i = 0; i < 20; i++) wireFallbackScan(scanState); // warm
      const scanMs: number[] = [];
      for (let r = 0; r < REPEATS; r++) {
        const t0 = performance.now();
        wireFallbackScan(scanState);
        scanMs.push(performance.now() - t0);
      }

      // --- OLD rule vs NEW rule: how often would the scan actually run across a realistic sequence? --------
      // 50 consecutive hand-shuffle deltas (orderPatch every time, zero bg-relevant touches) — the exact shape
      // of the traced case. OLD = rescan whenever `orderedIds` changed identity (every one, since applyOrderPatch
      // always reallocates). NEW = rescan whenever `sceneRootEpoch` changed (never, here).
      const ruleState = createMirrorState();
      applySceneDelta(ruleState, parseSceneDelta(fullRaw)!);
      let oldRuleScans = 0;
      let newRuleScans = 0;
      let lastOrderedIds: readonly string[] | null = ruleState.orderedIds;
      let lastEpoch = ruleState.sceneRootEpoch;
      for (let seed = 1; seed <= 50; seed++) {
        applySceneDelta(ruleState, parseSceneDelta(JSON.parse(JSON.stringify(buildHandShuffleDelta(seed))))!);
        if (ruleState.orderedIds !== lastOrderedIds) {
          oldRuleScans++;
          lastOrderedIds = ruleState.orderedIds;
        }
        if (ruleState.sceneRootEpoch !== lastEpoch) {
          newRuleScans++;
          lastEpoch = ruleState.sceneRootEpoch;
        }
      }

      report.push({
        totalNodes,
        jsonParseMsMedian: round3(median(parseMs)),
        parseSceneDeltaMsMedian: round3(median(parseDeltaMs)),
        applySceneDeltaMsMedian: round3(median(applyMs)),
        wireFallbackScanMsMedian: round3(median(scanMs)),
        sequenceLength: 50,
        oldRuleScans,
        newRuleScans,
        scanMsSavedOverSequence: round2(median(scanMs) * (oldRuleScans - newRuleScans))
      });
    }

    emit("");
    emit("=== wire pipeline phase bench (synthetic) ===");
    emit("nodes   json.parse  parseDelta  applyDelta  wireScan   old-rule-scans/50  new-rule-scans/50  ms-saved/50-tick-sequence");
    for (const r of report as Array<Record<string, number>>) {
      emit(
        "  " +
          String(r.totalNodes).padStart(5) +
          String(r.jsonParseMsMedian).padStart(12) +
          String(r.parseSceneDeltaMsMedian).padStart(12) +
          String(r.applySceneDeltaMsMedian).padStart(12) +
          String(r.wireFallbackScanMsMedian).padStart(11) +
          String(r.oldRuleScans).padStart(19) +
          String(r.newRuleScans).padStart(19) +
          String(r.scanMsSavedOverSequence).padStart(26)
      );
    }
    emit("BENCH_RESULT " + JSON.stringify({ report }));
    emit("");
  });
});
