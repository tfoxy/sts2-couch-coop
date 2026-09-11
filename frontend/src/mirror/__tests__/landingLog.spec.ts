// THE LANDING LOG'S OWN RULES — the bookkeeping, without a renderer in the way.
//
// `handLanding.spec.ts` / `handLandingRepro.spec.ts` drive the log through both real backends, which is what makes
// it evidence about the mirror. This file is the other half: the log decides WHEN a row is a verdict and when it is
// not, and every one of those decisions is a way for the instrument to lie quietly — a row closed before the
// producer spoke scores the client's own prediction against itself, a row closed on a superseded endpoint blames
// the client for the game changing its mind, and a row that never closes reports nothing at all while looking
// exactly like "no defects found".

import { describe, expect, it } from "vitest";

import type { Affine } from "@/mirror/affine";
import {
  LANDING_SETTLE_TIMEOUT_MS,
  classifyLanding,
  createLandingLog,
  endpointFieldResidual,
  formatLandingLog,
  scoredLandings,
  worstLanding,
  type LandingArm,
  type LandingProbe,
  type LandingRow
} from "@/mirror/landingLog";

const F = 2400 / 1920; // 1.25 — the widest stretch the reports come from

function at(x: number, y: number): Affine {
  return [1, 0, 0, 1, x, y];
}

/** A settable stand-in for a backend's frame. Every leg is a value a probe would otherwise read off a walk. */
class FakeStage implements LandingProbe {
  drawn = new Map<string, Affine>();
  raise = new Map<string, number>();
  live = new Set<string>();
  /** The streamed pose ARRAY — identity matters, so a "new delta" is a new array (see `LandingArm.streamedAtArm`). */
  streamed = new Map<string, number[] | null>();
  game = new Map<string, Affine>();

  drawnGlobal(id: string): Affine | null {
    return this.drawn.get(id) ?? null;
  }
  raiseDy(id: string): number {
    return this.raise.get(id) ?? 0;
  }
  channelLive(id: string): boolean {
    return this.live.has(id);
  }
  streamedTransform(id: string): unknown {
    return this.streamed.get(id) ?? null;
  }
  streamedGlobal(id: string): Affine | null {
    return this.game.get(id) ?? null;
  }

  /** The producer speaks: a fresh array for `id`, and the composed pose that goes with it. */
  emit(id: string, x: number, y: number): void {
    this.streamed.set(id, [1, 0, 0, 1, x, y]);
    this.game.set(id, at(x, y));
  }
}

function arm(over: Partial<LandingArm> = {}): LandingArm {
  return {
    id: "holder-1",
    name: "holder-1-CARD_STRIKE",
    atMs: 1000,
    // The game's endpoint at x=800, and the drawn endpoint the field puts it at: 800·1.25 = 1000.
    endpointGame: at(800, -209),
    endpointDrawn: at(1000, -209),
    spreadDxApplied: 200,
    fieldMode: 1,
    durationMs: 300,
    parentId: "container",
    streamedAtArm: null,
    ...over
  };
}

describe("the landing log — when a row is a verdict", () => {
  it("does not close a row while the tween's own window is still running", () => {
    const log = createLandingLog();
    const stage = new FakeStage();
    log.noteArm(arm());
    stage.live.add("holder-1");
    log.tick(1100, stage);
    // …not even once the channel has let go early, which is what a cancel looks like.
    stage.live.clear();
    stage.emit("holder-1", 1000, -209);
    log.tick(1200, stage);
    expect(log.openCount()).toBe(1);
    expect(log.rows()).toHaveLength(0);
  });

  it("waits for the producer to speak AFTER the window, not merely for the window to end", () => {
    const log = createLandingLog();
    const stage = new FakeStage();
    // The pose the client is about to predict is already streamed at the arm; the wrong rule ("the window is over,
    // read the frame") would close here and score the client's own drawing against itself.
    stage.emit("holder-1", 500, 100);
    log.noteArm(arm({ streamedAtArm: stage.streamed.get("holder-1") }));
    stage.drawn.set("holder-1", at(1000, -209));
    log.tick(1400, stage);
    expect(log.openCount(), "the window is over but the game has not spoken since").toBe(1);

    stage.emit("holder-1", 800, -209);
    log.tick(1420, stage);
    expect(log.rows()).toHaveLength(1);
    expect(log.rows()[0].closedBy).toBe("settle");
  });

  it("ignores a re-emit that lands INSIDE the window, and settles on the next one", () => {
    const log = createLandingLog();
    const stage = new FakeStage();
    stage.emit("holder-1", 500, 100);
    log.noteArm(arm({ streamedAtArm: stage.streamed.get("holder-1") }));
    // A coalesced delta carrying a pre-hint pose, mid-window. Scoring against it would measure the START.
    stage.emit("holder-1", 500, 100);
    log.tick(1150, stage);
    expect(log.openCount()).toBe(1);
    stage.drawn.set("holder-1", at(1000, -209));
    log.tick(1400, stage);
    expect(log.openCount(), "the only re-emit so far was the one inside the window").toBe(1);
    stage.emit("holder-1", 800, -209);
    log.tick(1420, stage);
    expect(log.rows()[0].closedBy).toBe("settle");
  });

  it("takes a mid-window re-emit that CONFIRMS the endpoint, once the client has stopped drawing", () => {
    // THE HOLE THIS CLOSES, from a live capture. `durationMs` is the producer's number for the GAME'S tween, and
    // its settle re-emit is keyed to the game finishing rather than to the client's replay — so the delta that
    // settled two of three focused cards arrived 40.9 ms BEFORE the third's nominal window end. The old rule
    // folded that delta into its own reference and then waited for one that had already happened: the row TIMED
    // OUT, i.e. the instrument reported nothing about the very landing it was watching.
    const log = createLandingLog();
    const stage = new FakeStage();
    stage.emit("holder-1", 500, 100);
    log.noteArm(arm({ streamedAtArm: stage.streamed.get("holder-1") }));
    stage.live.add("holder-1");
    log.tick(1100, stage);
    // The producer speaks 40 ms early, and its pose IS the endpoint (800, −209) — the confirmation, not a stale
    // coalesced pose. The client is still drawing, so the row stays open.
    stage.emit("holder-1", 800, -209);
    stage.drawn.set("holder-1", at(998, -209));
    log.tick(1260, stage);
    expect(log.openCount(), "the channel still owns the node — the motion is not over").toBe(1);
    // …and the frame the channel lets go, the row closes on the pose it confirmed rather than timing out.
    stage.live.clear();
    stage.drawn.set("holder-1", at(1000, -209));
    log.tick(1276, stage);
    expect(log.rows()).toHaveLength(1);
    expect(log.rows()[0].closedBy).toBe("settle");
    expect(log.rows()[0].distPx).toBeCloseTo(0, 9);
    // SNAPSHOT B: the frame before the close, which is where the client's own motion had left the card.
    expect(log.rows()[0].preSettleDrawn![4]).toBeCloseTo(998, 9);
    expect(log.rows()[0].settleJumpPx).toBeCloseTo(2, 9);
  });

  it("closes on a timeout when the producer never re-emits, and says so", () => {
    const log = createLandingLog();
    const stage = new FakeStage();
    log.noteArm(arm());
    stage.drawn.set("holder-1", at(1000, -209));
    log.tick(1300 + LANDING_SETTLE_TIMEOUT_MS - 1, stage);
    expect(log.openCount()).toBe(1);
    log.tick(1300 + LANDING_SETTLE_TIMEOUT_MS, stage);
    expect(log.rows()[0].closedBy).toBe("timeout");
  });

  it("closes a row the moment a new arm supersedes it, and numbers the arm that did", () => {
    const log = createLandingLog();
    const stage = new FakeStage();
    log.noteArm(arm());
    log.noteArm(arm({ atMs: 1070, endpointGame: at(900, -209), endpointDrawn: at(1125, -209) }));
    const [first] = log.rows();
    expect(first.closedBy).toBe("superseded");
    expect(first.supersededBy).toBe(2);
    expect(first.supersededAfterMs).toBe(70);
    expect(classifyLanding(first, F), "a superseded row is not a verdict about the client").toBe("superseded");
    // …and the replacement is still open, so the gesture is not scored twice.
    expect(log.openCount()).toBe(1);
    stage.emit("holder-1", 900, -209);
    stage.drawn.set("holder-1", at(1125, -209));
    log.tick(1400, stage);
    expect(classifyLanding(log.rows()[1], F)).toBe("clean");
  });

  it("closes a row for a card that leaves the hand, without scoring it", () => {
    const log = createLandingLog();
    log.noteArm(arm());
    log.noteGone("holder-1");
    expect(log.rows()[0].closedBy).toBe("gone");
    expect(classifyLanding(log.rows()[0], F)).toBe("gone");
    expect(scoredLandings(log.rows(), F)).toHaveLength(0);
  });
});

describe("the landing log — what the verdict says", () => {
  /** Arm, run the window out, let the producer speak, and hand back the closed row. */
  function playOne(
    over: Partial<LandingArm>,
    settle: { gameX: number; gameY: number; drawn: Affine; raiseAtArm?: number; raiseAtSettle?: number }
  ): LandingRow {
    const log = createLandingLog();
    const stage = new FakeStage();
    stage.emit("holder-1", 0, 0);
    const entry = arm({ streamedAtArm: stage.streamed.get("holder-1"), ...over });
    log.noteArm(entry);
    // The raise pass runs after the arm, so the lift is sampled on the first frame that follows it.
    stage.raise.set("holder-1", settle.raiseAtArm ?? 0);
    stage.live.add("holder-1");
    log.tick(entry.atMs + 16, stage);
    stage.live.clear();
    stage.raise.set("holder-1", settle.raiseAtSettle ?? settle.raiseAtArm ?? 0);
    stage.drawn.set("holder-1", settle.drawn);
    stage.emit("holder-1", settle.gameX, settle.gameY);
    log.tick(entry.atMs + entry.durationMs + 100, stage);
    expect(log.rows()).toHaveLength(1);
    return log.rows()[0];
  }

  it("scores a perfect landing as zero and calls it clean", () => {
    const row = playOne({}, { gameX: 800, gameY: -209, drawn: at(1000, -209) });
    expect(row.distPx).toBeCloseTo(0, 9);
    expect(row.gameMovedPx).toBeCloseTo(0, 9);
    expect(classifyLanding(row, F)).toBe("clean");
  });

  it("takes the cosmetic lift back out of the drawn pose, and reports it separately", () => {
    // The card is DRAWN 119px high because the readable-hand lift raised it; the landing itself is exact.
    const row = playOne(
      {},
      { gameX: 800, gameY: -209, drawn: at(1000, -328), raiseAtArm: -119, raiseAtSettle: -119 }
    );
    expect(row.settledDrawn[5], "the lift is subtracted before the comparison").toBeCloseTo(-209, 9);
    expect(row.distPx).toBeCloseTo(0, 9);
    expect(row.raiseDeltaPx).toBe(0);
    expect(classifyLanding(row, F)).toBe("clean");
  });

  it("names the RAISE RAMP when the pose landed but the lift moved under it", () => {
    const row = playOne({}, { gameX: 800, gameY: -209, drawn: at(1000, -209), raiseAtArm: -119, raiseAtSettle: 0 });
    expect(row.distPx).toBeCloseTo(0, 9);
    expect(row.raiseDeltaPx).toBe(119);
    // …and what the player SEES is the lift's collapse, which is why `screenDistPx` is a separate number.
    expect(row.screenDistPx).toBeCloseTo(119, 9);
    expect(classifyLanding(row, F)).toBe("raise-ramp");
  });

  it("names ENDPOINT-BASIS when the origin landed and the SCALE did not", () => {
    // `dx`/`dy` compare origins, so a card predicted at the wrong size scored a perfect landing until `basisDelta`
    // existed. The card is drawn 10% small; its origin is exactly right.
    const row = playOne({}, { gameX: 800, gameY: -209, drawn: [0.9, 0, 0, 0.9, 1000, -209] });
    expect(row.distPx).toBeCloseTo(0, 9);
    expect(row.basisDelta).toBeCloseTo(0.1, 9);
    expect(classifyLanding(row, F)).toBe("endpoint-basis");
  });

  it("names SETTLE-JUMP when the prediction was right and the card still moved on the delta", () => {
    // The Aug-29 shape, one level up: the endpoint arithmetic agrees with the game, and the frame the player was
    // looking at one tick earlier was somewhere else — so the card visibly jumps when the producer's word lands.
    const log = createLandingLog();
    const stage = new FakeStage();
    stage.emit("holder-1", 0, 0);
    const entry = arm({ streamedAtArm: stage.streamed.get("holder-1") });
    log.noteArm(entry);
    stage.live.add("holder-1");
    stage.drawn.set("holder-1", at(1024, -209)); // where the client actually drew it: 24px off, all window long
    log.tick(entry.atMs + 16, stage);
    stage.live.clear();
    log.tick(entry.atMs + entry.durationMs + 10, stage);
    stage.drawn.set("holder-1", at(1000, -209)); // …and the delta snaps it onto the endpoint
    stage.emit("holder-1", 800, -209);
    log.tick(entry.atMs + entry.durationMs + 26, stage);
    const row = log.rows()[0];
    expect(row.distPx, "the client's ENDPOINT was right the whole time").toBeCloseTo(0, 9);
    expect(row.settleJumpPx).toBeCloseTo(24, 9);
    expect(classifyLanding(row, F)).toBe("settle-jump");
  });

  it("names ENDPOINT-FIELD when the endpoint got a shift the field rule does not produce", () => {
    // The pre-WS-C behaviour: the endpoint keeps the shift the walk derived at the card's CURRENT pose. A card
    // resting at x=160 claims 160·0.25 = 40; the field at the endpoint (x=800) is 200. The endpoint is drawn 160px
    // short, which is `(endX − startX)·(F − 1)` exactly — the signature the user's report describes.
    const row = playOne(
      { endpointDrawn: at(840, -209), spreadDxApplied: 40 },
      { gameX: 800, gameY: -209, drawn: at(1000, -209) }
    );
    expect(endpointFieldResidual(row, F)).toBeCloseTo(-160, 9);
    expect(classifyLanding(row, F)).toBe("endpoint-field");
    // The residual is answerable with no settle at all — that is the point of it.
    expect(row.distPx).toBeCloseTo(160, 9);
  });

  it("does NOT blame the client when the GAME moved the card away from the endpoint it promised", () => {
    // The card left the fan mid-tween (or the hand was re-laid-out): aiming at the endpoint was never wrong.
    const row = playOne({}, { gameX: 400, gameY: 1030, drawn: at(500, 1030) });
    expect(row.gameMovedPx).toBeGreaterThan(1000);
    expect(classifyLanding(row, F)).toBe("game-moved");
    expect(scoredLandings([row], F), "an abandoned endpoint is not a mis-prediction").toHaveLength(0);
  });

  it("still checks the FIELD on a row the game abandoned", () => {
    // `game-moved` excuses the pose, never the arithmetic: a wrong shift is wrong wherever the card went.
    const row = playOne(
      { endpointDrawn: at(840, -209), spreadDxApplied: 40 },
      { gameX: 400, gameY: 1030, drawn: at(500, 1030) }
    );
    expect(classifyLanding(row, F), "the field is checked before the game's change of mind").toBe("endpoint-field");
  });

  it("has no field opinion about a node that does not claim the origin field", () => {
    const row = playOne({ fieldMode: 0 }, { gameX: 800, gameY: -209, drawn: at(1000, -209) });
    expect(endpointFieldResidual(row, F), "mode 0's shift is not a function of its own X").toBeNull();
  });

  it("reports nothing at 16:9, where every shift is zero", () => {
    const row = playOne(
      { endpointDrawn: at(800, -209), spreadDxApplied: 0 },
      { gameX: 800, gameY: -209, drawn: at(800, -209) }
    );
    expect(endpointFieldResidual(row, 1)).toBeCloseTo(0, 9);
    expect(classifyLanding(row, 1)).toBe("clean");
  });
});

describe("the landing log — reading it", () => {
  it("ranks by distance and formats a row a failure message can carry", () => {
    const log = createLandingLog();
    const stage = new FakeStage();
    for (const [id, drawnX] of [
      ["holder-0", 1000],
      ["holder-1", 1040],
      ["holder-2", 1010]
    ] as const) {
      stage.emit(id, 0, 0);
      log.noteArm(arm({ id, name: `${id}-CARD`, streamedAtArm: stage.streamed.get(id) }));
      stage.drawn.set(id, at(drawnX, -209));
      stage.emit(id, 800, -209);
      log.tick(1400, stage);
    }
    const worst = worstLanding(scoredLandings(log.rows(), F));
    expect(worst?.id).toBe("holder-1");
    const text = formatLandingLog(log.rows(), F);
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("holder-1-CARD");
    expect(text).toContain("endpoint-pose");
  });

  it("bounds what it retains", () => {
    const log = createLandingLog(3);
    for (let i = 0; i < 10; i++) {
      log.noteArm(arm({ atMs: 1000 + i }));
      log.noteGone("holder-1");
    }
    expect(log.rows()).toHaveLength(3);
    expect(log.rows()[2].seq, "the newest are kept").toBe(10);
  });

  it("drops everything on a keyframe", () => {
    const log = createLandingLog();
    log.noteArm(arm());
    log.noteGone("holder-1");
    log.noteArm(arm({ id: "holder-2" }));
    log.clear();
    expect(log.rows()).toHaveLength(0);
    expect(log.openCount()).toBe(0);
  });
});
