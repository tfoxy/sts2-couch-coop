import { afterEach, describe, expect, it } from "vitest";

import {
  isSqueezeAffine,
  mapPointerToGame,
  nearMissApplies,
  pushOutOfNearMiss,
  pushOutOfSqueezeMiss,
  resetNearMissMemory
} from "@/mirror/pointerMap";
import type { Affine } from "@/mirror/affine";
import type { InteractiveRect } from "@/mirror/mirrorRenderer";
import type { MirrorRect } from "@/mirror/sceneTree";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {}
  } as DOMRect;
}

// Build one z-stack element carrying the renderer's streamed attributes (data-node-id + optional data-paints /
// data-spread-dx / data-spread-w / data-spread-mode) and a fixed client rect. Detached is fine — mapPointerToGame
// only uses closest() (which matches the element itself) + getBoundingClientRect.
function mkEl(
  attrs: { id?: string; paints?: boolean; spreadDx?: string; spreadW?: string; prop?: boolean },
  r: DOMRect
): HTMLElement {
  const el = document.createElement("div");
  if (attrs.id != null) el.setAttribute("data-node-id", attrs.id);
  if (attrs.paints) el.setAttribute("data-paints", "1");
  if (attrs.spreadDx != null) el.setAttribute("data-spread-dx", attrs.spreadDx);
  if (attrs.spreadW != null) el.setAttribute("data-spread-w", attrs.spreadW);
  if (attrs.prop) el.setAttribute("data-spread-mode", "prop");
  el.getBoundingClientRect = () => r;
  return el;
}

// Stub document.elementsFromPoint with a fixed z-stack (topmost first) + a probe counter.
function stub(...els: Element[]): { probes: () => number } {
  let count = 0;
  (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => {
    count++;
    return els;
  };
  return { probes: () => count };
}

// An axis-aligned interactive (Stop) Control game rect: game box [tx, tx+w]×[ty, ty+h], rendered shifted +spreadDx
// (and optionally width-STRETCHED to renderedWidth — a full-canvas 0/1 blocker).
function iRect(
  id: string,
  tx: number,
  ty: number,
  w: number,
  h: number,
  spreadDx: number,
  renderedWidth = 0
): InteractiveRect {
  const transform: Affine = [1, 0, 0, 1, tx, ty];
  const localRect: MirrorRect = { x: 0, y: 0, width: w, height: h };
  return { id, transform, localRect, spreadDx, renderedWidth, raiseDy: 0 };
}

afterEach(() => {
  delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  resetNearMissMemory(); // the push-direction memory is module state — no test may inherit another's band
});

const SQUEEZE_2520 = 1920 / 2520; // ≈ 0.7619 — the field squeeze at designWidth 2520

describe("mapPointerToGame", () => {
  const stage = rect(0, 0, 960, 540);

  it("on a 16:9 stage returns the pure fraction + identity affine with ZERO DOM probes", () => {
    const { probes } = stub(mkEl({ id: "w", paints: true, spreadDx: "300", prop: true }, rect(100, 100, 200, 100)));
    const m = mapPointerToGame(480, 270, stage, 1920);
    expect(probes()).toBe(0);
    expect(m).toMatchObject({ coordX: 960, coordY: 540, shift: 0, designX: 960, affine: { a: 1, b: 0 } });
  });

  it("an ANCHORED painter subtracts its translation and returns a translation affine", () => {
    stub(mkEl({ id: "w", paints: true, spreadDx: "300" }, rect(100, 100, 200, 100)));
    const m = mapPointerToGame(480, 270, stage, 2520);
    // fraction 0.5 → 0.5·2520 = 1260 design-x; minus the widget's +300 shift → 960.
    expect(m.coordX).toBe(960);
    expect(m.coordY).toBe(540);
    expect(m.shift).toBe(300);
    // A drag begun here replays the fixed translation, NOT the world squeeze.
    expect(m.affine).toEqual({ a: 1, b: -300 });
  });

  it("a PROP painter resolves the exact hit coord but returns the whole-world SQUEEZE affine", () => {
    stub(mkEl({ id: "c", paints: true, spreadDx: "240", prop: true }, rect(300, 150, 200, 200)));
    const m = mapPointerToGame(480, 270, stage, 2520);
    // The hit itself is exact (on this rigid element): 1260 − 240 = 1020.
    expect(m.coordX).toBe(1020);
    // But the frozen field is the squeeze — a drag begun on a card spreads the world under the finger.
    expect(m.affine.a).toBeCloseTo(SQUEEZE_2520, 10);
    expect(m.affine.b).toBe(0);
  });

  it("an oversized (>60% stage) PROP painter resolves via the squeeze, not its own translation", () => {
    // The center-anchored parallax bg: a prop painter wider than 60% of the stage (600 > 0.6·960) but not a full
    // backdrop (< 0.95·960 = 912). Its rigid span misregisters the field, so the coord uses the squeeze.
    stub(mkEl({ id: "bg", paints: true, spreadDx: "500", prop: true }, rect(180, 0, 600, 540)));
    const m = mapPointerToGame(480, 270, stage, 2520);
    // Translation would give 1260 − 500 = 760; the squeeze gives 1260·1920/2520 = 960 → the exception fires.
    expect(m.coordX).toBe(960);
    expect(m.affine.a).toBeCloseTo(SQUEEZE_2520, 10);
    expect(m.affine.b).toBe(0);
  });

  it("demotes a painting full-stage vignette so content beneath it decides the map", () => {
    const vignette = mkEl({ id: "v", paints: true, spreadDx: "0", spreadW: "1920,2520" }, rect(0, 0, 960, 540));
    const content = mkEl({ id: "c", paints: true, spreadDx: "240" }, rect(300, 150, 200, 200));
    stub(vignette, content);
    const m = mapPointerToGame(480, 270, stage, 2520);
    // The vignette is skipped; the card's +240 shift wins: 1260 − 240 = 1020.
    expect(m.coordX).toBe(1020);
    expect(m.shift).toBe(240);
  });

  it("skips a transparent (non-painting) overlay and maps through the painter beneath", () => {
    const overlay = mkEl({ id: "o", spreadDx: "0" }, rect(0, 0, 960, 540)); // no data-paints
    const painter = mkEl({ id: "p", paints: true, spreadDx: "300" }, rect(0, 0, 200, 100));
    stub(overlay, painter);
    const m = mapPointerToGame(480, 270, stage, 2520);
    expect(m.coordX).toBe(960);
  });

  it("squeezes a widened backdrop (the only painter) via the uniform field", () => {
    // A full-stage backdrop (data-spread-w) with no more-specific painter beneath → the uniform squeeze governs it.
    const backdrop = mkEl({ id: "bg", paints: true, spreadDx: "200", spreadW: "600,800" }, rect(0, 0, 960, 540));
    stub(backdrop);
    const m = mapPointerToGame(480, 270, stage, 2520);
    // Uniform squeeze: designX 1260 · 1920/2520 = 960.
    expect(m.coordX).toBe(960);
    expect(m.affine.a).toBeCloseTo(SQUEEZE_2520, 10);
    expect(m.affine.b).toBe(0);
  });

  it("falls back to a uniform squeeze in dead space (nothing painting)", () => {
    stub(mkEl({ id: "x", spreadDx: "300" }, rect(0, 0, 960, 540))); // no data-paints anywhere
    const m = mapPointerToGame(480, 270, stage, 2520);
    expect(m.coordX).toBe(960); // designX 1260 · 1920/2520
    expect(m.affine.a).toBeCloseTo(SQUEEZE_2520, 10);
    expect(m.shift).toBe(300);
  });

  // FULL-FRAME BAND DEMOTION. These are widescreen-only by construction: at 16:9 mapPointerToGame short-circuits
  // before it ever probes the DOM, so no 1920-wide test can see any of this. The live failure they pin is the
  // start-of-turn banner (1920 wide, anchored, centring dx) stealing the map from the hand underneath it.
  describe("full-frame band demotion", () => {
    // 1920 design px of a 2520-wide design box occupy 1920/2520 of the stage = 731.4 of 960 client px.
    const bannerRect = rect(114, 60, 960 * (1920 / 2520), 120);

    it("demotes a full-FRAME anchored band so the content beneath it decides the map", () => {
      const banner = mkEl({ id: "banner", paints: true, spreadDx: "300" }, bannerRect);
      const card = mkEl({ id: "card", paints: true, spreadDx: "240", prop: true }, rect(400, 200, 100, 140));
      stub(banner, card);
      const m = mapPointerToGame(480, 270, stage, 2520);
      // Without the demotion the banner's centring translation wins: 1260 − 300 = 960. With it, the card does.
      expect(m.coordX).toBe(1020);
      expect(m.shift).toBe(240);
    });

    it("leaves a normal-width widget governing (the demotion is a band rule, not a width tax)", () => {
      // A wide HUD widget — 500 client px, i.e. 1312 design px, two thirds of the game frame — is not a band and
      // must keep the map. (The band threshold here is 0.95 · 960 · 1920/2520 = 694.9 client px.)
      const widget = mkEl({ id: "hud", paints: true, spreadDx: "300" }, rect(100, 60, 500, 120));
      stub(widget, mkEl({ id: "card", paints: true, spreadDx: "240", prop: true }, rect(400, 200, 100, 140)));
      const m = mapPointerToGame(480, 270, stage, 2520);
      expect(m.coordX).toBe(960);
      expect(m.affine).toEqual({ a: 1, b: -300 });
    });

    it("falls back to the uniform squeeze when the band is the ONLY painter", () => {
      // Nothing else paints there, so the demoted band is mapped by the field that placed it — the squeeze —
      // rather than by a translation the pass just decided it may not impose.
      stub(mkEl({ id: "banner", paints: true, spreadDx: "300" }, bannerRect));
      const m = mapPointerToGame(480, 270, stage, 2520);
      expect(m.coordX).toBe(960); // 1260 · 1920/2520
      expect(m.squeezed).toBe(true);
      expect(m.affine.a).toBeCloseTo(SQUEEZE_2520, 10);
    });
  });

  it("clamps the resolved coordinate to [0, 1920]", () => {
    stub(mkEl({ id: "lo", paints: true, spreadDx: "2000" }, rect(0, 0, 200, 100)));
    const lo = mapPointerToGame(480, 270, stage, 2520);
    expect(lo.coordX).toBe(0); // 1260 − 2000 = −740 → clamped to 0

    stub(mkEl({ id: "hi", paints: true, spreadDx: "-2000" }, rect(0, 0, 200, 100)));
    const hi = mapPointerToGame(480, 270, stage, 2520);
    expect(hi.coordX).toBe(1920); // 1260 + 2000 = 3260 → clamped to 1920
  });
});

describe("pushOutOfNearMiss", () => {
  it("pushes a mapped point OUT of an unhovered button's game rect toward the pointer's side", () => {
    // Button game x∈[1000,1200], rendered (+300) x∈[1300,1500]. Pointer at designX 1150 is LEFT of the rendered
    // rect but the resolved game point 1100 landed INSIDE the game rect → push it just left of the game rect.
    const button = iRect("b", 1000, 100, 200, 100, 300);
    const out = pushOutOfNearMiss(1100, 150, 1150, [button]);
    expect(out).toBe(999); // 1000 − 1
  });

  it("iterates in the same direction across an ADJACENT interactive rect", () => {
    // Two abutting buttons both shifted +400 → both rendered rects sit right of designX 1150 (near-misses).
    // Resolved point 1100 is inside b1; pushing left of b1 lands in b2, which also near-missed → push left of b2.
    const b1 = iRect("b1", 1000, 100, 200, 100, 400); // game [1000,1200], rendered [1400,1600]
    const b2 = iRect("b2", 800, 100, 200, 100, 400); //  game [800,1000],  rendered [1200,1400]
    const out = pushOutOfNearMiss(1100, 150, 1150, [b2, b1]); // b1 topmost (last)
    expect(out).toBe(799); // 1000 − 1 → into b2 → 800 − 1
  });

  it("does NOT push when the pointer is visually OVER the rect (a legitimate hit)", () => {
    // Button game [1000,1200] shifted +100 → rendered [1100,1300]; pointer designX 1200 is inside the rendered rect.
    const button = iRect("b", 1000, 100, 200, 100, 100);
    const out = pushOutOfNearMiss(1100, 150, 1200, [button]);
    expect(out).toBe(1100); // unchanged
  });

  it("REVERTS to the original coord when the iteration cap strands the walk inside a chain (all-or-nothing)", () => {
    // Six abutting 100-wide rects, all shifted far right (+500) so every one near-misses a left-side pointer.
    const rects: InteractiveRect[] = [];
    for (let k = 0; k < 6; k++) {
      rects.push(iRect(`r${k}`, 1000 - 100 * k, 100, 100, 100, 500));
    }
    // Resolved point 1050 is inside r0 [1000,1100]; each push steps 100 left; 4 iterations end at 699 — still
    // inside r4 [600,700]. A PARTIAL walk would hover a control several entities from the pointer (the live bug:
    // the fanned hand's game-overlapping hitboxes made "card 5 → 4" briefly hover card 1), so the pass reverts to
    // the original coord — at worst the adjacent overlap, which is game-native ambiguity.
    const out = pushOutOfNearMiss(1050, 150, 1050, rects);
    expect(out).toBe(1050);
  });

  it("keeps a capped-length walk that fully exits the chain", () => {
    // Four abutting rects [700..1100]: the 4th push lands at 699, left of r3 [700,800] — fully clear, so it sticks.
    const rects: InteractiveRect[] = [];
    for (let k = 0; k < 4; k++) {
      rects.push(iRect(`r${k}`, 1000 - 100 * k, 100, 100, 100, 500));
    }
    expect(pushOutOfNearMiss(1050, 150, 1050, rects)).toBe(699);
  });

  it("never pushes a point out of a game-overlapping chain while the pointer is visually over one member", () => {
    // The live hand geometry: 240-wide hitboxes every ~170 game px (continuous ~70px game-space overlaps), per-card
    // dx spreading them apart on stage. A coord in the overlap band whose pointer IS over one card's rendered rect
    // is that card's legitimate hit — the chain must not push it anywhere (the game arbitrates overlap natively).
    const cards: InteractiveRect[] = [];
    for (let k = 0; k < 5; k++) {
      cards.push(iRect(`card${k}`, 478 + 170 * k, 800, 240, 338, 136 + 37 * k));
    }
    // designX 1300 is over card3's rendered [1235,1475] (1300−247 = 1053 ∈ its game rect [988,1228], which also
    // contains the resolved 1120): card3 is a legit hit, no other rect contains 1120 → unchanged.
    expect(pushOutOfNearMiss(1120, 900, 1300, cards)).toBe(1120);
  });

  it("never treats a width-STRETCHED full-canvas blocker as an offender (its rendered box spans the stage)", () => {
    // The live regression: `Game`/`CombatRoom`/overlay ColorRects are full-canvas (1920-wide) Stop controls,
    // 0/1-anchored so the spread STRETCHES them to the stage width (renderedWidth 2340, dx 0). Judged by their
    // GAME width they'd "not contain" any pointer past x=1920 and push every legit right-side hover off the edge.
    const blocker = iRect("game", 0, 0, 1920, 1080, 0, 2340);
    const deck = iRect("deck", 1744, 0, 80, 80, 420);
    // Pointer at designX 2204, visually ON the deck (rendered [2164, 2244]); resolved coord 1784 is a legit hit.
    expect(pushOutOfNearMiss(1784, 40, 2204, [blocker, deck])).toBe(1784);
    // The near-miss push still fires for the deck itself when the pointer is NOT over it (gap left of the button).
    expect(pushOutOfNearMiss(1771, 40, 2158, [blocker, deck])).toBe(1743);
  });

  it("pushes out of an unshifted tooltip-only (Pass) rect the dead-space squeeze mapped into (the Gold repro)", () => {
    // The Gold counter: hover-only (mouse_filter Pass — now yielded by the renderer scan), pinned left (dx 0),
    // game rect [330, 470]. Dead space at designX 552 squeeze-resolves to ~453 — INSIDE gold while the pointer is
    // visually right of it → push out right. Hovering gold itself (designX 400 → coord 400) is a legit hit.
    const gold = iRect("gold", 330, 20, 140, 60, 0);
    expect(pushOutOfNearMiss(453, 50, 552, [gold])).toBe(471); // pushed just right of the game rect
    expect(pushOutOfNearMiss(400, 50, 400, [gold])).toBe(400); // pointer visually over gold → no push
  });

  it("pushes cross-frame mismaps from an exact painter hit but never same-frame ones (map parchment over TopBar)", () => {
    // The map screen: the parchment tile (painter, dx 210) has a transparent torn-edge box covering the TopBar
    // band, so its EXACT inverse (coordX = designX − 210) can land in rects of OTHER frames — FloorIcon pinned at
    // dx 0, the Deck hugging right at dx 420. Same-frame rects (the Legend rows, also dx 210) are self-exempt:
    // coordX inside their game rect ⟺ the pointer is over their rendered rect (the same point is tested).
    const floor = iRect("floor", 792, 0, 89, 83, 0); // game [792, 881], rendered identical (pinned left)
    const deck = iRect("deck", 1744, 0, 80, 80, 420); // game [1744, 1824], rendered [2164, 2244]
    const legendRow = iRect("legend", 1582, 390, 280, 48, 210); // game [1582, 1862], rendered [1792, 2072]
    const rects = [floor, deck, legendRow];
    // Pointer 1042 over the tile → exact coord 832 ∈ Floor's game rect, but the pointer isn't over Floor's
    // rendered rect → pushed out right (dir: pointer right of Floor's rendered mid).
    expect(pushOutOfNearMiss(832, 47, 1042, rects)).toBe(882);
    // Pointer 2072 over the tile → exact coord 1862... use the Deck landing: coord 1780 ∈ Deck game rect,
    // pointer not over Deck rendered [2164,2244] → pushed out left.
    expect(pushOutOfNearMiss(1780, 40, 2072, rects)).toBe(1743);
    // Pointer 1900 over a LEGEND row (same dx as the tile painter): coord 1690 ∈ the row's game rect AND the
    // pointer is over its rendered rect → legit hit, untouched.
    expect(pushOutOfNearMiss(1690, 410, 1900, rects)).toBe(1690);
  });

  it("handles a ROTATED (non-axis-aligned) rect via the affine inverse", () => {
    // A 90°-rotated square: transform [0,1,-1,0,1200,100], 100×100 → game x∈[1100,1200], y∈[100,200]. Shift +300.
    const rotated: InteractiveRect = {
      id: "rot",
      transform: [0, 1, -1, 0, 1200, 100],
      localRect: { x: 0, y: 0, width: 100, height: 100 },
      spreadDx: 300,
      renderedWidth: 0,
      raiseDy: 0
    };
    // Pointer designX 1250 (left of rendered [1400,1500]); resolved point (1150,150) is inside the rotated game box.
    const out = pushOutOfNearMiss(1150, 150, 1250, [rotated]);
    expect(out).toBe(1099); // 1100 − 1 (left edge of the rotated game extent)
  });

  // ---- legit-hit guard (r3/nearmiss) — the widescreen TopBar / rest-site un-tappable fix ----

  it("(a) keeps a legit gear hit over the full-width TopBar bar (pre-fix pushed it to the band edge)", () => {
    const bar = iRect("topbar", 0, 0, 1920, 90, 0); // full-band bar, pinned, rendered [0,1920]
    const gear = iRect("gear", 1770, 15, 60, 60, 400); // right cluster, game [1770,1830], rendered [2170,2230]
    // designX 2200 is over the gear's rendered box; the anchored map resolved 1800 (= 2200 − 400) ∈ the gear.
    expect(pushOutOfNearMiss(1800, 45, 2200, [bar, gear])).toBe(1800);
  });

  it("(b) keeps a legit View Upgrades (NRestSiteButton) hit over the full-band dialog backdrop", () => {
    const backdrop = iRect("backdrop", 0, 400, 1920, 300, 0); // full-band backdrop, pinned, rendered [0,1920]
    const view = iRect("view", 1600, 500, 300, 100, 400); // View Upgrades, game [1600,1900], rendered [2000,2300]
    // designX 2100 over the button's rendered box; anchored map resolved 1700 (= 2100 − 400) ∈ the button.
    expect(pushOutOfNearMiss(1700, 550, 2100, [backdrop, view])).toBe(1700);
  });

  it("(d) still pushes in dead space beside a shifted cluster (no legit hit vouches)", () => {
    const mapBtn = iRect("mapbtn", 1690, 15, 60, 60, 400); // game [1690,1750], rendered [2090,2150]
    const gear = iRect("gear", 1770, 15, 60, 60, 400); //     game [1770,1830], rendered [2170,2230]
    // designX 2100 in the dead gap left of the gear's rendered box; coord 1800 landed in the gear but the pointer is
    // over NEITHER rect → still push out left (to 1769). The guard only suppresses a push when there IS a legit hit.
    expect(pushOutOfNearMiss(1800, 45, 2100, [mapBtn, gear])).toBe(1769);
  });

  it("(e) a stage-band rect the pointer is over never vouches (parchment-over-TopBar push preserved)", () => {
    const floor = iRect("floor", 792, 0, 89, 83, 0); // cross-frame icon, pinned, rendered [792,881]
    const parchment = iRect("parchment", 40, 0, 1850, 90, 210); // extent 1850 ≥ 1824 → stage-band, rendered [250,2100]
    // Pointer 1042 over the parchment; exact map coord 832 (= 1042 − 210) landed in Floor → still pushed out right.
    expect(pushOutOfNearMiss(832, 47, 1042, [floor, parchment])).toBe(882);
  });

  it("(f) a width-stretched blocker above the target never vouches", () => {
    const button = iRect("btn", 800, 100, 200, 100, 400); // game [800,1000], rendered [1200,1400]
    const blocker = iRect("game", 0, 0, 1920, 1080, 0, 2340); // stretched full-canvas, rendered [0,2340], topmost
    // designX 1150 (left of the button's rendered box) is over the blocker; coord 900 landed in the button → push.
    expect(pushOutOfNearMiss(900, 150, 1150, [button, blocker])).toBe(799);
  });

  it("(c) the Gold repro still pushes with the guard on (default)", () => {
    const gold = iRect("gold", 330, 20, 140, 60, 0); // tooltip-only rect, game [330,470]
    expect(pushOutOfNearMiss(453, 50, 552, [gold])).toBe(471); // dead-space near-miss still pushes
    expect(pushOutOfNearMiss(400, 50, 400, [gold])).toBe(400); // hovering Gold itself → legit hit, no push
  });

});

// ---- readable-hand mode: a VERTICALLY moved surface, whose game Y and design Y are different numbers ----------

describe("near-miss vs a cosmetically RAISED surface", () => {
  // One hand card on a widened stage: its game box is [840,1140]x[861,1199] and it is DRAWN 119px higher and 132px
  // right (the wide-screen spread). The pointer at design (1091, 1010) is squarely on the drawn card; the resolve
  // un-maps the raise to game (960, 1129) — but the raise inverse decides its claim independently of this pass, so
  // both "un-mapped" and "not un-mapped" reach here and both have to be safe.
  const card: InteractiveRect = {
    id: "hitbox",
    transform: [1, 0, 0, 1, 840, 861],
    localRect: { x: 0, y: 0, width: 300, height: 338 },
    spreadDx: 131.5,
    renderedWidth: 0,
    raiseDy: -119
  };

  it("vouches for the card the pointer is drawn over, judging it by the POINTER's design Y", () => {
    // The un-mapped point: game Y 1129, pointer design Y 1010. Testing the rendered box with the GAME Y (the
    // pre-fix behaviour) puts the pointer 119px below the drawn card and the card offends itself.
    expect(pushOutOfNearMiss(960, 1129, 1091, [card], 1010)).toBe(960);
  });

  it("never pushes X off a raised surface even when the Y was NOT un-mapped", () => {
    // The claim missed (nothing claimed while the hand was mid-relayout), so the game Y is still the design Y and
    // the rendered test fails. Measured live: this pushed the sent X from 960 to 280, clear across the hand, and
    // the game focused nothing. A vertical offset must never move X.
    expect(pushOutOfNearMiss(960, 1010, 1091, [card])).toBe(960);
  });

  it("still pushes off an UNRAISED neighbour in the same stack", () => {
    // The guard is scoped to the raised rect itself: a genuinely near-missed button underneath is unaffected.
    const button = iRect("btn", 400, 980, 200, 80, 400); // game [400,600], rendered [800,1000]
    // Pointer at design 1200, right of the button's rendered mid → pushed out of its right edge.
    expect(pushOutOfNearMiss(500, 1010, 1200, [button, card], 1010)).toBe(601);
  });

  it("never pushes off a raise-GOVERNED rect even at dy 0 — the focused card under identity targeting", () => {
    // H2': the FOCUSED holder is published at dy 0 (the game already pulled it up to where it is drawn), and a
    // fan NEIGHBOUR's anchor deliberately lands inside its overlapping game box while the raw pointer is off to
    // one side. This pass only runs on a WIDENED stage, so losing this exemption is a 20:9-only regression no
    // 16:9 test can see: the anchor would be pushed out of the focused card's box and identity targeting broken.
    const focused: InteractiveRect = { ...card, id: "focusedHitbox", raiseDy: 0, raiseGoverned: true };
    // Game point inside the focused card's box; raw pointer NOT over its rendered box (spreadDx shifts it away).
    expect(pushOutOfNearMiss(960, 1010, 700, [focused], 1010)).toBe(960);
  });
});

// ---- the wide-stage HOVER BISTABILITY fix (r3/WS-N): the squeeze gate + directional hysteresis ----------------

describe("near-miss squeeze gate", () => {
  const stage = rect(0, 0, 960, 540);

  it("flags a coordinate the map resolved through the UNIFORM SQUEEZE", () => {
    // No painter at all (dead space) → the uniform-squeeze fallback.
    stub(mkEl({ id: "x", spreadDx: "300" }, rect(0, 0, 960, 540)));
    expect(mapPointerToGame(480, 270, stage, 2520).squeezed).toBe(true);

    // A full-stage backdrop is demoted, and with nothing beneath it the same fallback governs.
    stub(mkEl({ id: "bg", paints: true, spreadDx: "200", spreadW: "600,800" }, rect(0, 0, 960, 540)));
    expect(mapPointerToGame(480, 270, stage, 2520).squeezed).toBe(true);

    // The oversized (>60% of the stage) PROP backdrop takes the squeeze coord too — same flag.
    stub(mkEl({ id: "parallax", paints: true, spreadDx: "500", prop: true }, rect(180, 0, 600, 540)));
    expect(mapPointerToGame(480, 270, stage, 2520).squeezed).toBe(true);
  });

  it("does NOT flag a coordinate resolved through a specific painter's own translation", () => {
    stub(mkEl({ id: "hud", paints: true, spreadDx: "300" }, rect(100, 100, 200, 100)));
    expect(mapPointerToGame(480, 270, stage, 2520).squeezed).toBe(false); // anchored HUD: designX − dx

    stub(mkEl({ id: "card", paints: true, spreadDx: "240", prop: true }, rect(300, 150, 200, 200)));
    expect(mapPointerToGame(480, 270, stage, 2520).squeezed).toBe(false); // normal prop painter: exact local hit

    stub(mkEl({ id: "w", paints: true, spreadDx: "300", prop: true }, rect(100, 100, 200, 100)));
    expect(mapPointerToGame(480, 270, stage, 1920).squeezed).toBe(false); // 16:9 short-circuit
  });

  it("suppresses the near-miss pass for a squeezed coord", () => {
    expect(nearMissApplies(false)).toBe(true);
    expect(nearMissApplies(true)).toBe(false);
  });

  it("recognises a REPLAYED squeeze field affine but not an anchored translation", () => {
    // The hover-probe memo has no mapping to consult — only the field it replays. `a·designX + b` with b = 0 and
    // a ≠ 1 IS the uniform squeeze, whatever painter the memo was taken over.
    expect(isSqueezeAffine({ a: SQUEEZE_2520, b: 0 })).toBe(true);
    expect(isSqueezeAffine({ a: 1, b: -300 })).toBe(false); // anchored HUD translation
    expect(isSqueezeAffine({ a: 1, b: 0 })).toBe(false); // 16:9 identity
  });
});

describe("near-miss directional hysteresis", () => {
  // A synthetic near-miss BAND, the shape the probe decoded on a live wide stage: two game-space OVERLAPPING
  // hitboxes whose rendered boxes sit on OPPOSITE sides of the pointer, so each one derives a different push
  // direction from its own rendered mid. Whichever is topmost at a given pixel decides — and that identity
  // alternates between adjacent hover samples, which is what made the sent X bistable.
  const left = iRect("hitboxA", 900, 100, 200, 300, 300); //  game [900,1100],  rendered [1200,1400] → push LEFT
  const right = iRect("hitboxB", 1000, 100, 200, 300, -250); // game [1000,1200], rendered [750,950]  → push RIGHT

  it("re-uses the remembered direction when the next sample's offender would flip it", () => {
    // Sample 1: A topmost → dir −1 → out at 899.
    expect(pushOutOfNearMiss(1050, 150, 1100, [right, left])).toBe(899);
    // Sample 2, 6 design px later, B topmost. Locally B would push RIGHT (to 1201) — a 302px flip in one sample.
    // The remembered direction wins: the walk continues LEFT out of the whole band, landing where sample 1 did.
    expect(pushOutOfNearMiss(1056, 150, 1106, [left, right])).toBe(899);
  });

  it("recomputes locally once the pointer has left the band", () => {
    expect(pushOutOfNearMiss(1050, 150, 1100, [right, left])).toBe(899);
    // 200 design px away — a different band, so the memory must not steer it.
    expect(pushOutOfNearMiss(1056, 150, 1300, [left, right])).toBe(1201);
  });

  it("resetNearMissMemory (press / release / stage-rect change) drops the remembered direction", () => {
    expect(pushOutOfNearMiss(1050, 150, 1100, [right, left])).toBe(899);
    resetNearMissMemory();
    expect(pushOutOfNearMiss(1056, 150, 1106, [left, right])).toBe(1201); // back to the local decision
  });

});

// ---- R19 6a: the SQUEEZE RENDERED-BOX GATE (the near-miss pass stays suppressed; this holds the ONE invariant) ----

describe("squeeze rendered-box gate", () => {
  // The MEASURED map screen at 2520x1080 (.sts2/artifacts/diag-map-legend-2520.json). MapLegendItem is anchored
  // (spreadDx = half the extra width = 300): game x[1582,1862] RENDERS at x[1882,2162]. Above it sit the full-canvas
  // width-STRETCHED screen roots (NGame / NMapScreen: game [0,1920], renderedWidth 2520). Over designX 2220-2440
  // NOTHING paints, so mapPointerToGame falls back to the uniform squeeze and sends designX·1920/2520 — which is
  // inside the legend's GAME rect for every one of those samples.
  const SQUEEZE = 1920 / 2520;
  const backdrop = iRect("game", 0, 0, 1920, 1080, 0, 2520);
  const screenRoot = iRect("mapScreen", 0, 0, 1920, 1080, 0, 2520);
  const legend = iRect("legendTreasure", 1582, 486, 280, 48, 300);
  const mapRects = [backdrop, screenRoot, legend];

  it("ejects a squeezed coordinate from the rect the pointer is not over (the map-legend false focus)", () => {
    // designX 2220: nothing painted there, so the squeeze sends 1691.43 — inside the legend's game rect.
    const designX = 2220;
    const squeezed = designX * SQUEEZE;
    expect(squeezed).toBeGreaterThan(1582);
    expect(squeezed).toBeLessThan(1862);
    // The gate pushes it just past the legend's game right edge — clear of the row, so nothing focuses.
    expect(pushOutOfSqueezeMiss(squeezed, 500, designX, mapRects)).toBe(1863);
    // ... and the far end of the dead band resolves to the SAME place (single-valued across the whole band, which
    // is what the general near-miss pass could not promise here).
    expect(pushOutOfSqueezeMiss(2440 * SQUEEZE, 500, 2440, mapRects)).toBe(1863);
  });

  it("leaves a squeezed coordinate alone when the pointer IS over the rendered box", () => {
    // designX 2000 is inside the legend's RENDERED box [1882,2162] — a legitimate hit, whatever resolved it.
    const squeezed = 2000 * SQUEEZE; // 1523.8 — not even in the game rect
    expect(pushOutOfSqueezeMiss(squeezed, 500, 2000, mapRects)).toBe(squeezed);
    // And a coordinate that IS in the game rect with the pointer over the rendered box: legit, untouched.
    expect(pushOutOfSqueezeMiss(1700, 500, 2000, mapRects)).toBe(1700);
  });

  it("leaves a squeezed coordinate that resolves into nothing alone", () => {
    expect(pushOutOfSqueezeMiss(2500 * SQUEEZE, 500, 2500, mapRects)).toBe(2500 * SQUEEZE); // right of the legend
    expect(pushOutOfSqueezeMiss(400, 500, 525, mapRects)).toBe(400); // empty band, only the stretched roots
  });

  it("never claims a width-stretched span (it contains every pointer)", () => {
    // The full-canvas roots contain EVERY point; if the gate could claim one it would eject every squeezed
    // coordinate on the stage. With the legend removed there is no claimable rect at all.
    expect(pushOutOfSqueezeMiss(1691.43, 500, 2220, [backdrop, screenRoot])).toBe(1691.43);
    // Nor can a stretched span VOUCH for a lower one: the legend under the roots is still found and ejected.
    expect(pushOutOfSqueezeMiss(1691.43, 500, 2220, mapRects)).toBe(1863);
  });

  it("keeps the stage-band bar's own offence (a band cannot vouch, but it can be the claim)", () => {
    // A stage-band bar (game-x extent >= 0.95*1920, no renderedWidth) is barred from VOUCHING, not from offending
    // — the parchment-over-TopBar push the near-miss guard preserves. The gate inherits that arbitration verbatim.
    const band = iRect("topbarBar", 0, 0, 1900, 90, 300); // rendered [300,2200]; designX 2220 is past its right edge
    expect(pushOutOfSqueezeMiss(1691.43, 45, 2220, [band])).toBe(1901);
    // Pointer inside the band's rendered box: it may not vouch, but it does not offend either — untouched.
    expect(pushOutOfSqueezeMiss(1691.43, 45, 2000, [band])).toBe(1691.43);
  });

  it("ejects from the TOPMOST claiming rect only — one step, no chain walk", () => {
    // Two game-space overlapping rects the pointer is over neither of; the near-miss pass would walk BOTH (landing
    // past the outer one). The gate ejects out of the topmost claim and stops, even though the result is inside the
    // lower rect: the walk is what made adjacent samples bistable.
    const lower = iRect("lower", 1500, 400, 400, 200, 300);
    const upper = iRect("upper", 1582, 486, 280, 48, 300);
    expect(pushOutOfNearMiss(1691.43, 500, 2220, [lower, upper])).toBe(1901); // the pass: out of BOTH
    expect(pushOutOfSqueezeMiss(1691.43, 500, 2220, [lower, upper])).toBe(1863); // the gate: out of the claim only
  });
});
