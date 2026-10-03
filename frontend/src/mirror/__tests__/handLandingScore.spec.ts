// H11 PHASE 2's SCORER, over the traces the live harness actually recorded.
//
// The module under test is the live harness's (`scripts/lib/handLandingScore.mjs`), not a frontend module — it
// lives outside `frontend/` because the harness is a node script, and it is exercised from here because this is
// the suite the repo runs. Every fixture below is TRANSCRIBED FROM A REAL RUN (report ids in each case), so a
// change that "fixes" the arithmetic against an invented trace cannot pass.
//
// The two things these pin, and they pull in opposite directions:
//   * a landing the sampler could not resolve — the whole tween between two frames — must NOT be reported, and
//   * a landing that genuinely ended somewhere else MUST be, at the same cadence, with no tolerance inflation.

import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — a .mjs sibling of the harness; there are no types for the scripts tree.
import { CORRECTION_PX, findRest, scoreCorrections } from "../../../../scripts/lib/handLandingScore.mjs";

interface Row {
  t: number;
  drawn: [number, number];
  game: [number, number];
  ep: [number, number] | null;
  sd: number;
  rd: number;
  live: boolean;
  fan?: boolean;
  z?: number;
  presentEpoch?: number;
}

/** Build a one-holder trace in the shape `startLandingTrace` pushes, from readable rows. */
function trace(
  rows: Row[],
  { f = 1, fm = 1, id = "H", name = "NHandCardHolder-CARD_BASH", stage = null }:
    { f?: number; fm?: number; id?: string; name?: string; stage?: string | null } = {}
) {
  return rows.map((r) => ({
    t: r.t,
    f,
    stage,
    presentEpoch: r.presentEpoch ?? null,
    h: [
      {
        id,
        name,
        fm,
        dx: r.drawn[0],
        dy: r.drawn[1],
        gx: r.game[0],
        gy: r.game[1],
        sd: r.sd,
        rd: r.rd,
        z: r.z,
        live: r.live,
        fan: r.fan ?? true,
        ex: r.ep === null ? null : r.ep[0],
        ey: r.ep === null ? null : r.ep[1]
      }
    ]
  }));
}

describe("H11 phase 2 — the landing is the channel's endpoint, not a sample of the ease", () => {
  const matrix = (x: number, y: number) => [1, 0, 0, 1, x, y];
  // report-1789838330184, canvas-mouse-1920, @Control@606011. The old rule called this 57.45 design px
  // "unexplained"; the channel was headed for 1191 and the card rested at 1191.
  const easeStillRunningAtTheOnlyLiveSample = trace([
    { t: 27653.5, drawn: [1266, 922], game: [1266, 1041], ep: null, sd: 0, rd: -119, live: false },
    { t: 27966.9, drawn: [1266, 922], game: [1266, 1041], ep: null, sd: 0, rd: -119, live: false },
    { t: 28279.0, drawn: [1266, 922], game: [1266, 1041], ep: null, sd: 0, rd: -119, live: false },
    { t: 28586.5, drawn: [1266, 922], game: [1266, 1041], ep: null, sd: 0, rd: -119, live: false },
    { t: 28897.7, drawn: [1249.5, 871], game: [1242.6, 871], ep: [1191, 871], sd: 0, rd: 0, live: true },
    { t: 29200.2, drawn: [1192.1, 871], game: [1242.6, 871], ep: [1191, 871], sd: 0, rd: 0, live: false },
    { t: 29507.3, drawn: [1191, 871], game: [1191, 871], ep: null, sd: 0, rd: 0, live: false },
    { t: 29814.6, drawn: [1191, 871], game: [1191, 871], ep: null, sd: 0, rd: 0, live: false }
  ]);

  it("does not report a landing whose ease simply ran on past the last sampled frame", () => {
    const out = scoreCorrections(easeStillRunningAtTheOnlyLiveSample);
    // The producer's own pose confirms the aim within the window, so it is counted, not scored.
    expect(out.filter((c: { overruled: boolean }) => c.overruled)).toEqual([]);
    expect(out.confirmed).toBe(1);
    expect(out.unpredicted).toBe(0);
    expect(out.unsettled).toBe(0);
  });

  it("ignores how far the DRAWN pose still had to travel on that frame", () => {
    const out = scoreCorrections(easeStillRunningAtTheOnlyLiveSample);
    // 57.4px of sampled motion after the hand-off, and none of it a verdict: the row is confirmed outright, so
    // nothing is scored. What matters is that the size of the un-sampled travel plays no part in the decision.
    expect(out.confirmed).toBe(1);
    expect(out.length).toBe(0);
  });

  // report-1789838330184, canvas-mouse-2400, @Control@608976 — the same shape with the wide-screen field live.
  // endpoint 1191 on F=1.25 draws at 1488.75; the card rested at 1488.8.
  it("puts the endpoint on the RE-DERIVED squeeze field, so a wide-screen landing scores the same", () => {
    const out = scoreCorrections(
      trace(
        [
          { t: 30274.3, drawn: [1582.5, 922], game: [1266, 1041], ep: null, sd: 316.5, rd: -119, live: false },
          { t: 30601.8, drawn: [1582.5, 922], game: [1266, 1041], ep: null, sd: 316.5, rd: -119, live: false },
          { t: 30932.4, drawn: [1561.9, 871], game: [1242.7, 871], ep: [1191, 871], sd: 312.4, rd: 0, live: true },
          { t: 31256.9, drawn: [1489.8, 871], game: [1242.7, 871], ep: [1191, 871], sd: 298, rd: 0, live: false },
          { t: 31579.7, drawn: [1488.8, 871], game: [1191, 871], ep: null, sd: 297.8, rd: 0, live: false },
          { t: 31898.4, drawn: [1488.8, 871], game: [1191, 871], ep: null, sd: 297.8, rd: 0, live: false }
        ],
        { f: 1.25 }
      )
    );
    expect(out.filter((c: { overruled: boolean }) => c.overruled)).toEqual([]);
    expect(out.confirmed).toBe(1);
  });

  // report-1789838330184, canvas-touch-1920, @Control@611942 — the lift ramping across the hand-off. The old rule
  // subtracted a raise DELTA and got 73.2px; the endpoint (965, 1030) plus the settle's own lift is (965, 911),
  // which is exactly where the card rested.
  it("takes the lift at the SETTLE, so a ramp running across the hand-off is not a landing error", () => {
    const out = scoreCorrections(
      trace([
        { t: 27431.7, drawn: [1040, 871], game: [1040, 871], ep: null, sd: 0, rd: 0, live: false },
        { t: 27739.9, drawn: [1040, 790.7], game: [1040, 905.9], ep: [1040, 1030], sd: 0, rd: -115.2, live: true },
        { t: 28319.7, drawn: [1040, 909.7], game: [1040, 905.9], ep: [1040, 1030], sd: 0, rd: -115.5, live: false },
        { t: 28612.9, drawn: [1040, 906.1], game: [1040, 905.9], ep: [965, 1030], sd: 0, rd: -119, live: true },
        { t: 28911.1, drawn: [967, 910.9], game: [1040, 905.9], ep: [965, 1030], sd: 0, rd: -119, live: false },
        { t: 29201.8, drawn: [965, 911], game: [965, 1030], ep: null, sd: 0, rd: -119, live: false },
        { t: 29487.1, drawn: [965, 911], game: [965, 1030], ep: null, sd: 0, rd: -119, live: false }
      ])
    );
    expect(out.filter((c: { overruled: boolean }) => c.overruled)).toEqual([]);
  });

  // THE DEFECT THE PHASE EXISTS FOR, at the same 3 fps cadence: a replay that ends on a SUPERSEDED endpoint. The
  // producer re-poses the card to 1191 while the pin is up; the client's channel is still aimed at 1266, so the
  // card snaps 75 design px when the pin lifts. This is the only place the class is pinned: the URL levers that
  // used to reproduce it live (`?tweenReparent=keep`, `?spreadEndpoint=off`) no longer exist in the build.
  const staleEndpoint = trace([
    { t: 1000, drawn: [1266, 922], game: [1266, 1041], ep: null, sd: 0, rd: -119, live: false, presentEpoch: 100 },
    { t: 1310, drawn: [1266, 922], game: [1266, 1041], ep: [1266, 1041], sd: 0, rd: -119, live: true, presentEpoch: 101 },
    { t: 1620, drawn: [1266, 922], game: [1191, 1041], ep: [1266, 1041], sd: 0, rd: -119, live: true, presentEpoch: 102 },
    { t: 1930, drawn: [1191, 922], game: [1191, 1041], ep: null, sd: 0, rd: -119, live: false, presentEpoch: 103 },
    { t: 2240, drawn: [1191, 922], game: [1191, 1041], ep: null, sd: 0, rd: -119, live: false, presentEpoch: 104 }
  ], { stage: "canvas" });

  it("STILL reports a replay that ended on an endpoint the card then left", () => {
    const out = scoreCorrections(staleEndpoint);
    const jumps = out.filter((c: { overruled: boolean }) => c.overruled);
    expect(jumps).toHaveLength(1);
    expect(jumps[0].residualPx).toBe(75);
    expect(out.distinctCanvasRestPairs).toBe(1);
    expect(out.canvasRestPairEvidence[0]).toMatchObject({ firstEpoch: 103, settledEpoch: 104 });
    expect(jumps[0].endpointGame).toEqual([1266, 1041]);
    expect(jumps[0].aimedAt).toEqual([1266, 922]);
    expect(jumps[0].restedAt).toEqual([1191, 922]);
  });

  // h11-focus-provenance: old seq 51 (endpoint 1191,1041) is replaced by seq 57 at 22045ms;
  // the trace samples the old endpoint at 22044.9ms and the committed focus endpoint at 22181.9ms.
  it("uses the matching logged successor when its new arm falls inside the sampled gap", () => {
    const capturedShape = trace([
      { t: 21648.4, drawn: [1582.5, 922], game: [1266, 1041], ep: null, sd: 316.5, rd: -119, live: false },
      { t: 22044.9, drawn: [1492.7, 922], game: [1266, 1041], ep: [1191, 1041], sd: 298.5, rd: -119, live: true },
      { t: 22181.9, drawn: [1491.6, 871], game: [1192.9, 871], ep: [1191, 871], sd: 298.3, rd: 0, live: false },
      { t: 22322.6, drawn: [1488.8, 871], game: [1192.9, 871], ep: null, sd: 297.8, rd: 0, live: false },
      { t: 22458.8, drawn: [1488.8, 871], game: [1191, 871], ep: null, sd: 297.8, rd: 0, live: false }
    ], { f: 1.25, id: "1513153894746", name: "@Control@4532" });
    const rows = [
      { seq: 51, id: "1513153894746", name: "@Control@4532", armAt: 21657, settleAt: 22045,
        closedBy: "superseded", endpointGame: matrix(1191, 1041), endpointDrawn: matrix(1488.75, 1041), supersededBy: 57 },
      { seq: 57, id: "1513153894746", name: "@Control@4532", armAt: 22045, settleAt: 22331.9,
        closedBy: "settle", endpointGame: matrix(1191, 871), endpointDrawn: matrix(1488.75, 871), supersededBy: null }
    ];
    const out = scoreCorrections(capturedShape, rows);
    expect(out).toHaveLength(0);
    expect(out.superseded).toBe(1);
    expect(out.focusCatchups).toBe(0);
  });

  it("does not exempt a superseded endpoint when the logged successor cannot explain rest", () => {
    const sampled = trace([
      { t: 1000, drawn: [1582.5, 922], game: [1266, 1041], ep: null, sd: 316.5, rd: -119, live: false },
      { t: 1100, drawn: [1492, 922], game: [1266, 1041], ep: [1191, 1041], sd: 298, rd: -119, live: true },
      { t: 1200, drawn: [1488.75, 871], game: [1191, 871], ep: [1191, 871], sd: 297.75, rd: 0, live: false },
      { t: 1300, drawn: [1488.75, 871], game: [1191, 871], ep: null, sd: 297.75, rd: 0, live: false }
    ], { f: 1.25 });
    const rows = [
      { seq: 51, id: "H", name: "NHandCardHolder-CARD_BASH", armAt: 1050, settleAt: 1150,
        closedBy: "superseded", endpointGame: matrix(1191, 1041), endpointDrawn: matrix(1488.75, 1041), supersededBy: 57 },
      { seq: 57, id: "H", name: "NHandCardHolder-CARD_BASH", armAt: 1150, settleAt: 1280,
        closedBy: "settle", endpointGame: matrix(1191, 900), endpointDrawn: matrix(1488.75, 900), supersededBy: null }
    ];
    const out = scoreCorrections(sampled, rows);
    expect(out.superseded).toBe(0);
    expect(out.filter((row: { overruled: boolean }) => row.overruled)).toHaveLength(1);
  });

  it("does not trust a successor field that happens to match the wrong resting pose", () => {
    const sampled = trace([
      { t: 1000, drawn: [1582.5, 922], game: [1266, 1041], ep: null, sd: 316.5, rd: -119, live: false },
      { t: 1100, drawn: [1492, 922], game: [1266, 1041], ep: [1191, 1041], sd: 298, rd: -119, live: true },
      { t: 1200, drawn: [1582.5, 871], game: [1191, 871], ep: [1191, 871], sd: 297.75, rd: 0, live: false },
      { t: 1300, drawn: [1582.5, 871], game: [1191, 871], ep: null, sd: 297.75, rd: 0, live: false }
    ], { f: 1.25 });
    const rows = [
      { seq: 51, id: "H", name: "NHandCardHolder-CARD_BASH", armAt: 1050, settleAt: 1150,
        closedBy: "superseded", endpointGame: matrix(1191, 1041), endpointDrawn: matrix(1488.75, 1041), supersededBy: 57 },
      { seq: 57, id: "H", name: "NHandCardHolder-CARD_BASH", armAt: 1150, settleAt: 1280,
        closedBy: "settle", endpointGame: matrix(1191, 871), endpointDrawn: matrix(1582.5, 871), supersededBy: null }
    ];
    const out = scoreCorrections(sampled, rows);
    expect(out.superseded).toBe(0);
    expect(out.filter((row: { overruled: boolean }) => row.overruled)).toHaveLength(1);
  });

  // h11-rust-fullcapture: timeout row 51 held endpoint y1041 through the sampled z-focus hand-off;
  // the producer's new game pose y871 and the zero lift are adopted on the following committed frame.
  it("recognizes a logged focus pin-catch-up only when z-order changes and the new pose plus lift is adopted", () => {
    const sampled = trace([
      { t: 24974.1, drawn: [1492.8, 922], game: [1266, 1041], ep: [1191, 1041], sd: 298.6, rd: -119, live: true, z: 0 },
      { t: 25112, drawn: [1489.4, 922], game: [1191, 871], ep: [1191, 1041], sd: 297.9, rd: -119, live: true, z: 1 },
      { t: 25251, drawn: [1488.8, 922], game: [1191, 871], ep: [1191, 871], sd: 297.8, rd: -119, live: false, z: 1 },
      { t: 25395.7, drawn: [1488.8, 871], game: [1191, 871], ep: null, sd: 297.8, rd: 0, live: false, z: 1 },
      { t: 25554.7, drawn: [1488.8, 871], game: [1191, 871], ep: null, sd: 297.8, rd: 0, live: false, z: 1 }
    ], { f: 1.25, id: "4431030521116", name: "@Control@15262" });
    const rows = [{ seq: 51, id: "4431030521116", name: "@Control@15262", armAt: 24577.7, settleAt: 26735.3,
      closedBy: "timeout", endpointGame: matrix(1191, 1041), endpointDrawn: matrix(1488.75, 1041),
      settledGame: matrix(1191, 871), supersededBy: null }];
    const out = scoreCorrections(sampled, rows);
    expect(out).toHaveLength(0);
    expect(out.focusCatchups).toBe(1);
  });

  it("does not treat a timeout as a focus catch-up when the sampled focus pose was not adopted", () => {
    const sampled = trace([
      { t: 1000, drawn: [1488.75, 922], game: [1191, 1041], ep: [1191, 1041], sd: 297.75, rd: -119, live: true, z: 0 },
      { t: 1100, drawn: [1488.75, 922], game: [1191, 871], ep: [1191, 1041], sd: 297.75, rd: -119, live: true, z: 1 },
      { t: 1200, drawn: [1488.75, 900], game: [1191, 871], ep: null, sd: 297.75, rd: -119, live: false, z: 1 },
      { t: 1300, drawn: [1488.75, 900], game: [1191, 871], ep: null, sd: 297.75, rd: -119, live: false, z: 1 }
    ], { f: 1.25 });
    const rows = [{ seq: 51, id: "H", name: "NHandCardHolder-CARD_BASH", armAt: 900, settleAt: 1700,
      closedBy: "timeout", endpointGame: matrix(1191, 1041), endpointDrawn: matrix(1488.75, 1041),
      settledGame: matrix(1191, 871), supersededBy: null }];
    const out = scoreCorrections(sampled, rows);
    expect(out.focusCatchups).toBe(0);
    expect(out.filter((row: { overruled: boolean }) => row.overruled)).toHaveLength(1);
  });

  it("does not scan past an incorrect first focus adoption to a later corrected pose", () => {
    const sampled = trace([
      { t: 1000, drawn: [1488.75, 922], game: [1191, 1041], ep: [1191, 1041], sd: 297.75, rd: -119, live: true, z: 0 },
      { t: 1100, drawn: [1488.75, 922], game: [1191, 871], ep: [1191, 1041], sd: 297.75, rd: -119, live: true, z: 1 },
      { t: 1200, drawn: [1488.75, 900], game: [1191, 871], ep: [1191, 871], sd: 297.75, rd: 0, live: false, z: 1 },
      { t: 1300, drawn: [1488.75, 871], game: [1191, 871], ep: null, sd: 297.75, rd: 0, live: false, z: 1 },
      { t: 1400, drawn: [1488.75, 871], game: [1191, 871], ep: null, sd: 297.75, rd: 0, live: false, z: 1 }
    ], { f: 1.25 });
    const rows = [{ seq: 51, id: "H", name: "NHandCardHolder-CARD_BASH", armAt: 900, settleAt: 1700,
      closedBy: "timeout", endpointGame: matrix(1191, 1041), endpointDrawn: matrix(1488.75, 1041),
      settledGame: matrix(1191, 871), supersededBy: null }];
    const out = scoreCorrections(sampled, rows);
    expect(out.focusCatchups).toBe(0);
    expect(out.filter((row: { overruled: boolean }) => row.overruled)).toHaveLength(1);
  });

  it("requires a known non-focused z sample before accepting the focus transition", () => {
    const sampled = trace([
      { t: 1000, drawn: [1488.75, 922], game: [1191, 1041], ep: [1191, 1041], sd: 297.75, rd: -119, live: true },
      { t: 1100, drawn: [1488.75, 922], game: [1191, 871], ep: [1191, 1041], sd: 297.75, rd: -119, live: true, z: 1 },
      { t: 1200, drawn: [1488.75, 922], game: [1191, 871], ep: [1191, 871], sd: 297.75, rd: -119, live: false, z: 1 },
      { t: 1300, drawn: [1488.75, 871], game: [1191, 871], ep: null, sd: 297.75, rd: 0, live: false, z: 1 },
      { t: 1400, drawn: [1488.75, 871], game: [1191, 871], ep: null, sd: 297.75, rd: 0, live: false, z: 1 }
    ], { f: 1.25 });
    const rows = [{ seq: 51, id: "H", name: "NHandCardHolder-CARD_BASH", armAt: 900, settleAt: 1700,
      closedBy: "timeout", endpointGame: matrix(1191, 1041), endpointDrawn: matrix(1488.75, 1041),
      settledGame: matrix(1191, 871), supersededBy: null }];
    const out = scoreCorrections(sampled, rows);
    expect(out.focusCatchups).toBe(0);
    expect(out.filter((row: { overruled: boolean }) => row.overruled)).toHaveLength(1);
  });

  // h11-gpu-fast-off-a, touch-2400: the old channel ends on the first focused committed picture.
  // Its y1041 endpoint still draws at y922 under the old lift; the next picture adopts y871 with lift zero.
  it("does not score an old handoff against a focus that starts on its first unowned commit", () => {
    const sampled = trace([
      { t: 24406.8, drawn: [1582.5, 922], game: [1266, 1041], ep: [1191, 1041], sd: 316.5, rd: -119, live: true, z: 0, presentEpoch: 91 },
      { t: 24599.8, drawn: [1489.9, 922], game: [1266, 1041], ep: [1191, 1041], sd: 298, rd: -119, live: true, z: 0, presentEpoch: 92 },
      { t: 24805.2, drawn: [1488.8, 922], game: [1191, 871], ep: null, sd: 297.8, rd: -119, live: false, z: 1, presentEpoch: 93 },
      { t: 25022.2, drawn: [1488.8, 871], game: [1191, 871], ep: null, sd: 297.8, rd: 0, live: false, z: 1, presentEpoch: 94 },
      { t: 25235, drawn: [1488.8, 871], game: [1191, 871], ep: null, sd: 297.8, rd: 0, live: false, z: 1, presentEpoch: 95 }
    ], { f: 1.25, stage: "canvas" });
    const out = scoreCorrections(sampled);
    expect(out.filter((row: { overruled: boolean }) => row.overruled)).toHaveLength(0);
    expect(out.focusCatchups).toBe(1);
    expect(out.distinctCanvasRestPairs).toBe(1);
  });

  it("still fails when the first focused adoption draws the wrong pose", () => {
    const sampled = trace([
      { t: 1000, drawn: [1488.75, 922], game: [1266, 1041], ep: [1191, 1041], sd: 297.75, rd: -119, live: true, z: 0, presentEpoch: 100 },
      { t: 1100, drawn: [1488.75, 922], game: [1191, 871], ep: null, sd: 297.75, rd: -119, live: false, z: 1, presentEpoch: 101 },
      { t: 1200, drawn: [1488.75, 900], game: [1191, 871], ep: null, sd: 297.75, rd: 0, live: false, z: 1, presentEpoch: 102 },
      { t: 1300, drawn: [1488.75, 871], game: [1191, 871], ep: null, sd: 297.75, rd: 0, live: false, z: 1, presentEpoch: 103 },
      { t: 1400, drawn: [1488.75, 871], game: [1191, 871], ep: null, sd: 297.75, rd: 0, live: false, z: 1, presentEpoch: 104 }
    ], { f: 1.25, stage: "canvas" });
    const out = scoreCorrections(sampled);
    expect(out.focusCatchups).toBe(0);
    expect(out.filter((row: { overruled: boolean }) => row.overruled)).toHaveLength(1);
  });

  // THE LIFT RAMPING ACROSS THE HAND-OFF, with its real numbers: report-1789838330184's
  // canvas-touch-1920 `worstTrace` for @Control@611944, un-focusing while the readable-hand lift ramps back in
  // (rd −31 → −115.22 → −118.9 → −119). `worstTrace` does not carry the endpoint column, so it is stated here
  // as the resting pose the card actually lands on: drawn 922 with the lift at −119 is a pose of 1041.
  //
  // The gap between the lift at the hand-off (−115.22) and at the rest (−119) is only 3.78 px, and that is the
  // point — it is under the old rule's tolerances and over this one's, so the two readings of "which lift" are
  // distinguishable here and nowhere else in this file.
  const liftRampingAcrossTheHandoff = trace([
    { t: 30968.5, drawn: [1191, 1041], game: [1191, 871], ep: null, sd: 0, rd: 0, live: false },
    { t: 31272.1, drawn: [1191, 877.4], game: [1191, 908.4], ep: [1191, 1041], sd: 0, rd: -31, live: true },
    { t: 31563.9, drawn: [1191, 920.1], game: [1191, 908.4], ep: [1191, 1041], sd: 0, rd: -115.22, live: true },
    { t: 31857.0, drawn: [1191, 921.9], game: [1191, 908.4], ep: null, sd: 0, rd: -118.9, live: false },
    { t: 32152.8, drawn: [1191, 922], game: [1191, 1041], ep: null, sd: 0, rd: -119, live: false },
    { t: 32450.3, drawn: [1191, 922], game: [1191, 1041], ep: null, sd: 0, rd: -119, live: false }
  ]);

  it("reads the lift at the REST, so a ramp still 3.78px from home is not a landing error", () => {
    const out = scoreCorrections(liftRampingAcrossTheHandoff);
    expect(out.filter((c: { overruled: boolean }) => c.overruled)).toEqual([]);
    expect(out.confirmed).toBe(1);
  });

  it("uses a flat tolerance a few px wide, not the motion's own last step", () => {
    // The tolerance is the whole difference between this rule and the one it replaced, which allowed "whatever
    // the previous sampled step happened to be" — 45 to 55 px on the live canvas runs. So the number is asserted
    // absolutely, not relative to the constant: a 3 px miss the producer never confirms IS a jump.
    expect(CORRECTION_PX).toBe(2);
    const nudged = trace([
      { t: 1000, drawn: [1000, 900], game: [1000, 900], ep: null, sd: 0, rd: 0, live: false },
      { t: 1310, drawn: [1000, 900], game: [1000, 900], ep: [1000, 900], sd: 0, rd: 0, live: true },
      { t: 1620, drawn: [1000, 900], game: [1000, 900], ep: [1000, 900], sd: 0, rd: 0, live: true },
      { t: 1930, drawn: [1003, 900], game: [900, 900], ep: null, sd: 0, rd: 0, live: false },
      { t: 2240, drawn: [1003, 900], game: [900, 900], ep: null, sd: 0, rd: 0, live: false }
    ]);
    const out = scoreCorrections(nudged);
    expect(out.filter((c: { overruled: boolean }) => c.overruled)).toHaveLength(1);
    expect(out[0].residualPx).toBe(3);
  });

  // report-1789839259490, mouse-2400, @Control@616881 — the COMMIT. The game reparents the holder off the hand
  // container mid-channel and re-poses it over the next 300 ms; the hand endpoint (1040, 871) it was still
  // carrying describes a fan the holder is no longer in. Scored, this reported 43.17 design px.
  it("does not score a holder the game has taken out of the fan", () => {
    const out = scoreCorrections(
      trace(
        [
          { t: 18372.9, drawn: [1206.3, 911], game: [988.3, 871], ep: null, sd: 241.3, rd: -119, live: false },
          { t: 18436.2, drawn: [1226.8, 871], game: [988.3, 871], ep: [981.5, 871], sd: 247.1, rd: 0, live: true },
          // eslint-disable-next-line prettier/prettier
          { t: 18506.2, drawn: [1226.8, 871], game: [1975.4, 2039.5], ep: [1040, 871], sd: 247.1, rd: 0, live: true, fan: false },
          { t: 18572.8, drawn: [1269.3, 959.5], game: [1047.3, 923.9], ep: null, sd: 253.9, rd: 0, live: false, fan: false },
          { t: 18715.7, drawn: [1315.5, 912.4], game: [1053, 911], ep: null, sd: 263.1, rd: 0, live: false, fan: false },
          { t: 18751.2, drawn: [1316.3, 911], game: [1053, 911], ep: null, sd: 263.3, rd: 0, live: false, fan: false },
          { t: 18783.2, drawn: [1316.3, 911], game: [1053, 911], ep: null, sd: 263.3, rd: 0, live: false, fan: false }
        ],
        { f: 1.25 }
      )
    );
    expect(out).toHaveLength(0);
    expect(out.outOfFan).toBe(1);
  });

  // The mirror of the case above — the CANCEL rather than the commit. Constructed, because a run has to catch
  // the holder mid-return to sample it, but the guard has to hold at both ends or it only covers one gesture:
  // the channel running while the holder is off the hand container is not aiming at a fan slot, whatever slot
  // the holder is reparented into afterwards.
  it("does not score a holder that was out of the fan when the channel handed off", () => {
    const out = scoreCorrections(
      trace([
        { t: 1000, drawn: [1500, 600], game: [1500, 600], ep: [1500, 600], sd: 0, rd: 0, live: true, fan: false },
        { t: 1310, drawn: [1300, 800], game: [1500, 600], ep: [1500, 600], sd: 0, rd: 0, live: true, fan: false },
        { t: 1620, drawn: [1191, 922], game: [1191, 1041], ep: null, sd: 0, rd: -119, live: false },
        { t: 1930, drawn: [1191, 922], game: [1191, 1041], ep: null, sd: 0, rd: -119, live: false }
      ])
    );
    expect(out).toHaveLength(0);
    expect(out.outOfFan).toBe(1);
  });

  // …and the third order of events: the channel closes with the holder still in the fan, and the reparent
  // lands after it. Same verdict for the same reason — the holder came to rest somewhere that is not a fan
  // slot, so where the fan channel was aiming says nothing about it.
  it("does not score a holder the game takes out of the fan after the channel closed", () => {
    const out = scoreCorrections(
      trace([
        { t: 1000, drawn: [1191, 922], game: [1191, 1041], ep: [1191, 1041], sd: 0, rd: -119, live: true },
        { t: 1310, drawn: [1191, 922], game: [1191, 1041], ep: [1191, 1041], sd: 0, rd: -119, live: true },
        { t: 1620, drawn: [1500, 600], game: [1500, 600], ep: null, sd: 0, rd: 0, live: false, fan: false },
        { t: 1930, drawn: [1500, 600], game: [1500, 600], ep: null, sd: 0, rd: 0, live: false, fan: false }
      ])
    );
    expect(out).toHaveLength(0);
    expect(out.outOfFan).toBe(1);
  });

  it("counts a hand-off with no endpoint rather than scoring it (a card flight publishes none)", () => {
    const out = scoreCorrections(
      trace([
        { t: 1000, drawn: [1000, 900], game: [1000, 900], ep: null, sd: 0, rd: 0, live: false },
        { t: 1310, drawn: [1100, 900], game: [1000, 900], ep: null, sd: 0, rd: 0, live: true },
        { t: 1620, drawn: [1400, 900], game: [1000, 900], ep: null, sd: 0, rd: 0, live: false },
        { t: 1930, drawn: [1400, 900], game: [1000, 900], ep: null, sd: 0, rd: 0, live: false }
      ])
    );
    expect(out).toHaveLength(0);
    expect(out.unpredicted).toBe(1);
  });

  it("counts a holder that never stands still rather than scoring where it happened to be", () => {
    const out = scoreCorrections(
      trace([
        { t: 1000, drawn: [1000, 900], game: [1000, 900], ep: null, sd: 0, rd: 0, live: false },
        { t: 1310, drawn: [1000, 900], game: [1000, 900], ep: [1400, 900], sd: 0, rd: 0, live: true },
        { t: 1620, drawn: [1100, 900], game: [1000, 900], ep: null, sd: 0, rd: 0, live: false },
        { t: 1930, drawn: [1200, 900], game: [1000, 900], ep: null, sd: 0, rd: 0, live: false },
        { t: 2240, drawn: [1300, 900], game: [1000, 900], ep: null, sd: 0, rd: 0, live: false }
      ])
    );
    expect(out).toHaveLength(0);
    expect(out.unsettled).toBe(1);
  });

  describe("findRest", () => {
    const rows = [
      { t: 0, dx: 0, dy: 0, live: true },
      { t: 300, dx: 50, dy: 0, live: false },
      { t: 600, dx: 90, dy: 0, live: false },
      { t: 900, dx: 90, dy: 0, live: false }
    ];

    it("is the first of two consecutive frames the drawn pose did not move between", () => {
      expect(findRest(rows, 1, 0)).toBe(3);
    });

    it("refuses to look past a channel taking the holder over again", () => {
      const retaken = [rows[0], rows[1], { ...rows[2], live: true }, rows[3]];
      expect(findRest(retaken, 1, 0)).toBe(-1);
    });

    it("gives up rather than calling a late pose a rest", () => {
      const slow = rows.map((r, i) => ({ ...r, t: i * 900 }));
      expect(findRest(slow, 1, 0)).toBe(-1);
    });

    it("does not count repeated canvas reads of one committed picture as stillness", () => {
      const repeated = [
        { t: 0, dx: 0, dy: 0, live: true, stage: "canvas", presentEpoch: 10 },
        { t: 100, dx: 50, dy: 0, live: false, stage: "canvas", presentEpoch: 11 },
        { t: 109.2, dx: 50, dy: 0, live: false, stage: "canvas", presentEpoch: 11 },
        { t: 200, dx: 49.8, dy: 0, live: false, stage: "canvas", presentEpoch: 12 },
        { t: 300, dx: 49.7, dy: 0, live: false, stage: "canvas", presentEpoch: 13 }
      ];
      expect(findRest(repeated, 1, 0)).toBe(3);
    });

    it("requires valid, increasing canvas commit identities", () => {
      const noCommit = [
        { t: 0, dx: 0, dy: 0, live: true, stage: "canvas", presentEpoch: 10 },
        { t: 100, dx: 50, dy: 0, live: false, stage: "canvas", presentEpoch: null },
        { t: 200, dx: 50, dy: 0, live: false, stage: "canvas", presentEpoch: null }
      ];
      const regressed = [
        { t: 0, dx: 0, dy: 0, live: true, stage: "canvas", presentEpoch: 10 },
        { t: 100, dx: 50, dy: 0, live: false, stage: "canvas", presentEpoch: 12 },
        { t: 200, dx: 50, dy: 0, live: false, stage: "canvas", presentEpoch: 11 }
      ];
      expect(findRest(noCommit, 1, 0)).toBe(-1);
      expect(findRest(regressed, 1, 0)).toBe(-1);
    });

    it("reports missing and regressing canvas identities as measurement errors", () => {
      const missing = trace([
        { t: 0, drawn: [1266, 922], game: [1266, 1041], ep: [1266, 1041], sd: 0, rd: -119, live: true, presentEpoch: 10 },
        { t: 100, drawn: [1266, 922], game: [1266, 1041], ep: [1266, 1041], sd: 0, rd: -119, live: false },
        { t: 200, drawn: [1266, 922], game: [1266, 1041], ep: null, sd: 0, rd: -119, live: false }
      ], { stage: "canvas" });
      const regressed = trace([
        { t: 0, drawn: [1266, 922], game: [1266, 1041], ep: [1266, 1041], sd: 0, rd: -119, live: true, presentEpoch: 10 },
        { t: 100, drawn: [1266, 922], game: [1266, 1041], ep: [1266, 1041], sd: 0, rd: -119, live: false, presentEpoch: 12 },
        { t: 200, drawn: [1266, 922], game: [1266, 1041], ep: null, sd: 0, rd: -119, live: false, presentEpoch: 11 }
      ], { stage: "canvas" });

      expect(scoreCorrections(missing).invalidFrameIdentity).toEqual([
        expect.objectContaining({ frame: 1, reason: "missing or invalid epoch" }),
        expect.objectContaining({ frame: 2, reason: "missing or invalid epoch" })
      ]);
      expect(scoreCorrections(regressed).invalidFrameIdentity).toEqual([
        expect.objectContaining({ frame: 2, previousEpoch: 12, presentEpoch: 11, reason: "epoch regressed" })
      ]);
    });
  });
});
