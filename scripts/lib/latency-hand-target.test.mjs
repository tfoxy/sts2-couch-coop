import assert from "node:assert/strict";
import test from "node:test";
import { acceptHandHitStack, selectHandTarget, selectNeutralParkingPoint } from "./latency-hand-target.mjs";

const rect = (id, x, y, width = 100, height = 200) => ({ id,
  transform: [1, 0, 0, 1, x, y], localRect: { x: 0, y: 0, width, height },
  spreadDx: 0, raiseDy: 0 });
const holder = (id, x, zIndex = 0) => ({ id, hitboxId: `${id}-hit`, inFan: true,
  zIndex, channelLive: false, mDrawn: [1, 0, 0, 1, x, 0] });
const choose = (holders, rects, neutralRects) => selectHandTarget({ holders, rects,
  neutralRects, stageWidth: 1000, stageHeight: 800 });

test("a point remains inside both current and unhovered footprints after the prior focus exits", () => {
  const target = holder("target", 210);
  const prior = holder("prior", 50, 1);
  const neutral = rect("target-hit", 210, 300);
  const current = rect("target-hit", 210, 240);
  const chosen = choose([prior, target], [rect("prior-hit", 50, 100), current],
    { target: neutral, prior: rect("prior-hit", 50, 300) });
  assert.equal(chosen?.holder.id, "target");
  assert.ok(chosen.point.gy >= 320 && chosen.point.gy <= 480);
  assert.ok(chosen.point.currentMargin >= .1);
  assert.ok(chosen.point.neutralMargin >= .1);
});

test("focused hand without an unhovered footprint fails closed", () => {
  assert.equal(choose([holder("prior", 50, 1), holder("target", 210)],
    [rect("prior-hit", 50, 100), rect("target-hit", 210, 240)], null), null);
});

test("an overlap with the prior focused holder is never selected", () => {
  const current = rect("target-hit", 210, 240);
  const priorRect = rect("prior-hit", 50, 100, 320, 500);
  const chosen = choose([holder("prior", 50, 1), holder("target", 210)],
    [priorRect, current], { target: rect("target-hit", 210, 300), prior: priorRect });
  assert.equal(chosen, null);
});

test("a channel-owned holder is not a target", () => {
  const moving = { ...holder("target", 210), channelLive: true };
  assert.equal(choose([moving], [rect("target-hit", 210, 240)], null), null);
});

test("a rejected renderer hit stack fails closed before any pointer input", () => {
  const selected = selectHandTarget({ holders: [holder("target", 210)],
    rects: [rect("target-hit", 210, 240)], neutralRects: null,
    stageWidth: 1000, stageHeight: 800,
    acceptPoint: () => ({ accepted: false, source: "mirror-hit-stack" }) });
  assert.equal(selected, null);
});

test("the renderer stack uses card owner IDs, including when a blocker sits behind the card", () => {
  const target = { ...holder("holder-1", 210), cardId: "card-1" };
  const stack = { ids: ["card-1"], blocked: true, topStamp: "other" };
  const chooseWithStack = observed => selectHandTarget({ holders: [target],
    rects: [rect("holder-1-hit", 210, 240)], stageWidth: 1000, stageHeight: 800,
    acceptPoint: h => acceptHandHitStack(observed, h.cardId, ["card-2"]) });
  assert.equal(chooseWithStack(stack)?.holder.id, "holder-1");
  assert.equal(chooseWithStack({ ids: ["holder-1-hit"], blocked: false, topStamp: "other" }), null);
  assert.equal(chooseWithStack({ ids: [], blocked: true, topStamp: "other" }), null);
  assert.equal(chooseWithStack({ ids: ["card-2", "card-1"], blocked: false, topStamp: "other" }), null);
  assert.equal(chooseWithStack({ ids: ["card-1"], blocked: false, topStamp: "bar" }), null);
});

test("a neutral competitor footprint blocks a point exposed only while that competitor is raised", () => {
  const target = holder("target", 210);
  const prior = holder("prior", 50, 1);
  const targetCurrent = rect("target-hit", 210, 240);
  const priorCurrent = rect("prior-hit", 50, 20, 300, 180);
  const priorNeutral = rect("prior-hit", 50, 215, 300, 300);
  const neutral = { target: rect("target-hit", 210, 300), prior: priorNeutral };
  const chosen = choose([prior, target], [priorCurrent, targetCurrent], neutral);
  assert.equal(chosen, null);
});

test("tries another interior point if the renderer blocks the best geometric point", () => {
  const observed = [];
  const chosen = selectHandTarget({ holders: [holder("target", 210)],
    rects: [rect("target-hit", 210, 240)], stageWidth: 1000, stageHeight: 800,
    acceptPoint: (_, point) => {
      observed.push(point);
      return { accepted: observed.length > 1 };
    } });
  assert.ok(chosen);
  assert.ok(observed.length > 1);
  assert.notDeepEqual(chosen.point, observed[0]);
});

test("affine inverse respects rotation, scale, and a nonzero local origin", () => {
  const transformed = { id: "target-hit", transform: [0, 2, -1.5, 0, 550, 80],
    localRect: { x: 30, y: 40, width: 100, height: 160 }, spreadDx: 10, raiseDy: 20 };
  const chosen = choose([holder("target", 210)], [transformed], null);
  assert.ok(chosen);
  assert.ok(chosen.point.gx > 250 && chosen.point.gx < 500);
  assert.ok(chosen.point.gy > 150 && chosen.point.gy < 400);
  assert.ok(chosen.point.currentMargin >= .1);
});

test("pre-disconnect parking is inside stage, clear of hand, and requires an unclaimed hit stack", () => {
  const focused = holder("target", 210, 1);
  const candidates = [];
  const chosen = selectNeutralParkingPoint({ holders: [focused],
    rects: [rect("target-hit", 210, 240, 100, 200)], stageWidth: 1000, stageHeight: 800,
    acceptPoint: point => {
      candidates.push(point);
      return { accepted: candidates.length > 1, stack: { ids: [], blocked: false } };
    } });
  assert.ok(chosen);
  assert.ok(chosen.gx > 0 && chosen.gx < 1000 && chosen.gy > 0 && chosen.gy < 800);
  assert.equal(candidates.length, 2);
  assert.notDeepEqual([chosen.gx, chosen.gy], [candidates[0].gx, candidates[0].gy]);
  assert.equal(selectNeutralParkingPoint({ holders: [focused], rects: [],
    stageWidth: 1000, stageHeight: 800, acceptPoint: () => ({ accepted: true }) }), null);
});
