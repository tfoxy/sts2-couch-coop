#!/usr/bin/env node
// =====================================================================================================
// THE HAND HIT MAP — where does the GAME actually accept a pointer on a hand card?
// =====================================================================================================
//
// WHY THIS EXISTS. Two of the live touch harness's checks assert things about the edge of a hand card and
// neither of them was ever measured against the game:
//
//   * H6 requires that a press on the ART OVERHANG (21 design px outside the card's 300x422 hit box) focus
//     one of the two nearest cards. It fails on every combo, on both stage-fit arms.
//   * H6 and H1 both require that a point INSIDE the box focus the card that contains it. A handful of
//     corner/edge points (and one card CENTRE at 2400) focus nothing at all.
//
// Those are two different questions — "is the harness's expectation wrong" and "is the mirror losing the
// point" — and a check cannot answer either about itself. The oracle is the GAME: send it a coordinate and
// see what it focuses. This probe sweeps coordinates across and around a card's box and writes down the
// answer, so the acceptance region can be compared with the box the harness asserts against.
//
// WHAT IT MEASURES, per sample: the stage pixel hovered, the coordinate that actually went on the wire
// (recorded off `WebSocket.send`, never dropped), that coordinate's signed penetration into EVERY fan card's
// GAME box, and which holder the game focused. The penetration is computed from the SENT coordinate rather
// than from the pointer's design position, because the sent coordinate is the only thing the game saw — that
// is what makes the map independent of whether the raise inverse fired.
//
// THE TWO ARMS, and the second is the clean one:
//   * `--raise on`  — the shipping configuration. The hand is cosmetically lifted ~119px and `raiseInverse`
//                     un-maps a pointer that lands on a raised card, so the sent coordinate is the pointer's
//                     design point plus the lift. Points OUTSIDE the drawn box may or may not be claimed.
//   * `--raise off` — the raise inverse is provably identity (an empty stamp list), so a stage pixel maps
//                     1:1 to a game coordinate and the sweep can place the sent coordinate at ANY offset
//                     around the card's game box. This is what maps the game's acceptance boundary directly.
//
// SAFETY — this probe HOVERS AND NEVER PRESSES.
//   * No press, no drag, no release: a mouse move cannot pick up, play or discard a card. The whole map is
//     built out of hover-focus, which is the same hit test a tap resolves through.
//   * It talks only to its OWN instance (`touchqa`) on its OWN port (13457). The developer's game is on
//     :13337 and is refused by construction below.
//   * It leases the install, the instance and both ports before doing anything and releases them on every
//     exit path.
//   * It starts nothing and stops nothing: bring the instance and dev server up with the audited lifecycle
//     (`validate-touch-live.mjs --observe --keep`) and close them with `sts2 --instance touchqa game close`.
//
//     node scripts/validate-touch-live.mjs --observe --keep --combos mouse-1920
//     node scripts/probe-hand-hitbox-live.mjs --raise off --viewport 1920x1080
//     node scripts/probe-hand-hitbox-live.mjs --raise off --viewport 2400x1080
//     sts2 --instance touchqa game close
//
// Artifacts (git-ignored) land in `.sts2/artifacts/touch-harness/`: one JSON per run with every sample, and
// a screenshot of the frame the sweep ran against.
// =====================================================================================================

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
import { acquireLease, releaseLease } from "./live-qa-lock.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The developer's own instance. Named ONLY so the guard below can refuse to talk to it. */
const FORBIDDEN_PORT = 13337;

const HELP = `probe-hand-hitbox-live.mjs — map the game's hand-card acceptance region (hover only, never presses)

  node scripts/probe-hand-hitbox-live.mjs [options]

  --vite <port>       dev server the touch harness brought up (default 5199)
  --game <port>       the harness instance's browser server (default 13457; 13337 is REFUSED)
  --viewport <WxH>    browser viewport (default 1920x1080; run 2400x1080 too — the spread/near-miss
                      machinery only runs above design width 1920)
  --raise on|off      readable-hand mode (default off — the identity-mapping arm; see the header)
  --pointer <kind>    mouse (hover, never presses) or touch (press-hold-release, the only gesture a
                      touchscreen has; it disarms between samples the way the harness's own rest tap does)
  --stage-fit <v>     value for ?stageFit (default: omitted, i.e. the default arm)
  --cards <list>      fan indices to sweep, comma separated (default: the middle three)
  --scans <list>      any of top,bottom,left,right,corners,named (default top,left,right,corners,named)
  --out <dir>         artifacts (default .sts2/artifacts/touch-harness)
  --tag <name>        suffix for the artifact filenames
  --settle <ms>       dwell before sampling focus (default 340)
  --help`;

function parseArgs(argv) {
  const a = {
    vite: 5199,
    game: 13457,
    viewport: { width: 1920, height: 1080 },
    raise: "off",
    pointer: "mouse",
    stageFit: null,
    cards: null,
    scans: ["top", "left", "right", "corners", "named"],
    out: ".sts2/artifacts/touch-harness",
    tag: null,
    settle: 340,
  };
  for (let i = 0; i < argv.length; i++) {
    const val = () => argv[++i];
    switch (argv[i]) {
      case "--vite": a.vite = Number(val()); break;
      case "--game": a.game = Number(val()); break;
      case "--raise": a.raise = String(val()); break;
      case "--pointer": a.pointer = String(val()); break;
      case "--stage-fit": a.stageFit = String(val()); break;
      case "--cards": a.cards = String(val()).split(",").map((s) => Number(s.trim())); break;
      case "--scans": a.scans = String(val()).split(",").map((s) => s.trim()); break;
      case "--out": a.out = val(); break;
      case "--tag": a.tag = String(val()); break;
      case "--settle": a.settle = Number(val()); break;
      case "--viewport": {
        const m = /^(\d+)x(\d+)$/.exec(String(val()).trim());
        if (!m) { console.error("--viewport wants WxH"); process.exit(2); }
        a.viewport = { width: Number(m[1]), height: Number(m[2]) };
        break;
      }
      case "--help": console.log(HELP); process.exit(0); break;
      default:
        if (argv[i].startsWith("--")) { console.error(`unknown flag ${argv[i]}\n\n${HELP}`); process.exit(2); }
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

if (args.game === FORBIDDEN_PORT || args.vite === FORBIDDEN_PORT) {
  console.error(`REFUSED: :${FORBIDDEN_PORT} is the developer's own game. This probe talks only to its own instance.`);
  process.exit(2);
}

const OWNER = "touch-hitmap";
let lockHeld = false;
function acquireLock() {
  acquireLease({
    owner: OWNER, pid: process.pid,
    resources: ["shared:install", "shared:game:touchqa", `exclusive:port:${args.game}`, `exclusive:port:${args.vite}`],
  });
  lockHeld = true;
}
function releaseLock() {
  if (lockHeld) {
    try { releaseLease({ owner: OWNER, pid: process.pid }); } catch { /* already gone */ }
    lockHeld = false;
  }
}
process.on("exit", releaseLock);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { releaseLock(); process.exit(130); });
}
process.on("uncaughtException", (err) => { releaseLock(); console.error(err); process.exit(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

// ---------------------------------------------------------------------------------------------------
// Page-side readers. Real functions with real arguments (a STRING pageFunction would drop them).
// ---------------------------------------------------------------------------------------------------

/**
 * The fan, joined off the SHARED SEAM rather than off `raiseGoverned`.
 *
 * The touch harness filters `__mirrorInteractiveRects()` by `raiseGoverned`, which is set only while the
 * readable-hand mode is actually moving surfaces — so with `--raise off` that filter returns nothing at all.
 * `__mirrorHandPoses()` publishes each holder's own `hitboxId`, which is the id the rect list keys the card's
 * drawn rect under, so the join works in both arms and on either stage.
 */
const readFan = (page) =>
  page.evaluate(() => {
    const stage = document.querySelector(".mirror-stage");
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    const designW = stage.offsetWidth;
    const seam = window.__mirrorHandPoses ? window.__mirrorHandPoses() : null;
    if (!seam || !seam.handPresent) return null;
    const byHitbox = new Map();
    for (const h of seam.holders) if (h.hitboxId) byHitbox.set(h.hitboxId, h);
    const rects = window.__mirrorInteractiveRects().filter((x) => byHitbox.has(x.id) && byHitbox.get(x.id).inFan);
    return {
      scale: r.width / designW,
      designW,
      designH: stage.offsetHeight,
      origin: { x: r.left, y: r.top },
      spreadFactor: seam.spreadFactor,
      cards: rects.map((rect, index) => {
        const h = byHitbox.get(rect.id);
        return {
          index,
          rectId: rect.id,
          holderId: h.id,
          name: h.name,
          cardContentKey: h.cardContentKey,
          transform: rect.transform,
          localRect: rect.localRect,
          raiseDy: rect.raiseDy ?? 0,
          spreadDx: rect.spreadDx ?? 0,
          // The HOLDER's pose as the seam reports it, read in the same frame as the hitbox rect above. The two
          // are different nodes (holder, and its `Hitbox` child) so they differ by a constant, but they must
          // MOVE together: a rect that holds still while the seam pose moves is a stale hit surface.
          seamGameY: h.mGame[5],
          seamDrawnY: h.mDrawn[5],
          seamZ: h.zIndex,
          seamChannelLive: h.channelLive,
        };
      }),
    };
  });

/** Which holder the game has z-lifted (its own earliest focus signal), plus the global lift for the record. */
const readFocus = (page) =>
  page.evaluate(() => {
    const pose = window.__mirrorHandPoses ? window.__mirrorHandPoses() : null;
    const holders = pose?.holders.filter((h) => h.inFan) ?? [];
    const z = holders.filter((h) => h.zIndex === 1).map((h) => h.id);
    const hr = window.__mirrorHandRaise ? window.__mirrorHandRaise() : null;
    const raise = hr?.raise ?? hr ?? {};
    return {
      zFocus: z.length === 1 ? z[0] : z.length === 0 ? null : z.join("+"),
      lift: raise.liftPx ?? 0,
      outOfFan: pose?.holders.filter((h) => !h.inFan).map((h) => h.id) ?? [],
    };
  });

/** The game's own poses, digested, so rest can be detected without depending on the raise seam. */
const readPoseDigest = (page) =>
  page.evaluate(() => {
    const pose = window.__mirrorHandPoses ? window.__mirrorHandPoses() : null;
    if (!pose) return null;
    return {
      key: pose.holders
        .map((h) => `${h.id}:${Math.round(h.mGame[4])}/${Math.round(h.mGame[5])}:${h.zIndex}:${h.inFan ? 1 : 0}`)
        .join("|"),
      focused: pose.holders.some((h) => h.zIndex === 1),
      whole: pose.holders.every((h) => h.inFan),
      // A live channel means the client is still replaying a motion; its endpoint is where the card is GOING.
      live: pose.holders.some((h) => h.channelLive),
    };
  });

const sentCount = (page) => page.evaluate(() => window.__sentInputs.length);
const sentSince = (page, from) => page.evaluate((n) => window.__sentInputs.slice(n), from);

/**
 * Wait until the game's poses stop changing, nothing is focused, the fan is whole and no client channel is
 * still replaying.
 *
 * THE PRE-SETTLE IS NOT PADDING, and leaving it out produced a whole run of wrong geometry. The game drops the
 * focused holder's z-lift IMMEDIATELY on hover-out but starts returning its POSE a frame or two later, and the
 * mirror only streams deltas — so for ~200ms after the pointer leaves, the poses are quiet AND unfocused while
 * the card is still sitting at its focus pose ~159px up. A stability test that starts straight away reads that
 * as rest, and every point computed from it aims 159px above the card. (Measured: alternating self / NOTHING
 * rows in hitmap-1920-raiseoff-1789816635070.json, one per focusing sample.)
 */
async function awaitRest(page, { timeoutMs = 5000, requireNoFocus = true, preSettleMs = 450 } = {}) {
  await sleep(preSettleMs);
  const t0 = Date.now();
  let last = null;
  let quiet = 0;
  while (Date.now() - t0 < timeoutMs) {
    const d = await readPoseDigest(page);
    if (!d) return false;
    const same = last !== null && last === d.key;
    if (same && !d.live && d.whole && (!requireNoFocus || !d.focused)) {
      if (++quiet >= 3) return true;
    } else {
      quiet = 0;
    }
    last = d.key;
    await sleep(100);
  }
  return false;
}

/**
 * Wait until the NUMBERS THIS PROBE COMPUTES FROM stop moving — the card's own game-space placement and the
 * cosmetic lift the renderer has it at — and return the fan they settled to.
 *
 * `awaitRest` above watches the GAME's poses, and that is not enough on the `--raise on` arm: the readable-hand
 * lift is a second channel on a second clock (it ramps down as a card rises into focus and back up afterwards),
 * so a fan read during the ramp carries a `raiseDy` that is true of no frame the pointer will land in. Measured:
 * with the pose wait alone, every point after a focusing sample was placed ~150px off and the game answered
 * nothing while the probe's own arithmetic said the coordinate was inside the box
 * (hitmap-v2-1920-on-1789816849930.json).
 */
async function awaitFanSettled(page, holderId, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let quiet = 0;
  let fan = null;
  while (Date.now() < deadline) {
    fan = await readFan(page);
    const card = fan?.cards.find((c) => c.holderId === holderId);
    if (!card) return { fan, card: null, settled: false };
    const key = `${card.transform.map((v) => Math.round(v * 100)).join(",")}|${Math.round(card.raiseDy)}|${Math.round(card.spreadDx)}`;
    if (key === previous) {
      if (++quiet >= 2) return { fan, card, settled: true };
    } else {
      quiet = 0;
    }
    previous = key;
    await sleep(120);
  }
  const card = fan?.cards.find((c) => c.holderId === holderId) ?? null;
  return { fan, card, settled: false };
}

// ---------------------------------------------------------------------------------------------------
// Geometry — pure arithmetic, deliberately in node so it can be read next to the numbers it produces.
// Same conventions as the harness: `transform`+`localRect` are the card's GAME-space placement, `raiseDy`
// is the cosmetic lift the renderer drew it at (negative = raised), `spreadDx` the wide-screen shift.
// ---------------------------------------------------------------------------------------------------

/** A point on a card, given local-frame fractions. Returns its GAME point, its DRAWN point, and the pixel. */
function pointOn(card, fan, fx, fy) {
  const { transform: m, localRect: lr } = card;
  const lx = lr.x + lr.width * fx;
  const ly = lr.y + lr.height * fy;
  const gx = m[0] * lx + m[2] * ly + m[4];
  const gameY = m[1] * lx + m[3] * ly + m[5];
  const drawnY = gameY + card.raiseDy;
  return {
    fx, fy,
    gameX: gx, gameY,
    designX: gx, designY: drawnY,
    cx: fan.origin.x + (gx + card.spreadDx) * fan.scale,
    cy: fan.origin.y + drawnY * fan.scale,
    onStage: gx >= 2 && gx <= fan.designW - 2 && drawnY >= 2 && drawnY <= fan.designH - 2,
  };
}

/** How far a GAME-space point is outside a card's game box, in the card's own local px (0 = inside). */
function penetration(card, px, py) {
  const { transform: m, localRect: lr } = card;
  const det = m[0] * m[3] - m[1] * m[2];
  const dx = px - m[4];
  const dy = py - m[5];
  const lx = (dx * m[3] - dy * m[2]) / det;
  const ly = (-dx * m[1] + dy * m[0]) / det;
  const ox = lx < lr.x ? lr.x - lx : lx > lr.x + lr.width ? lx - (lr.x + lr.width) : 0;
  const oy = ly < lr.y ? lr.y - ly : ly > lr.y + lr.height ? ly - (lr.y + lr.height) : 0;
  return { lx, ly, ox, oy, out: Math.hypot(ox, oy), inside: ox === 0 && oy === 0 };
}

/** The local-frame fraction that sits `px` local pixels inside (positive) or outside (negative) an edge. */
const fracAtInset = (extent, px) => px / extent;

// ---------------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------------

/** Offsets from an edge, in the card's own local px. Positive = inside the box, negative = outside. */
const EDGE_OFFSETS = [60, 30, 12, 4, -4, -12, -21, -32, -50];

function planForCard(card, scans) {
  const lr = card.localRect;
  const plan = [];
  const add = (label, fx, fy) => plan.push({ label, fx, fy });
  if (scans.includes("top")) {
    for (const off of EDGE_OFFSETS) add(`top${off >= 0 ? "+" : ""}${off}`, 0.5, fracAtInset(lr.height, off));
  }
  if (scans.includes("bottom")) {
    for (const off of EDGE_OFFSETS) add(`bottom${off >= 0 ? "+" : ""}${off}`, 0.5, 1 - fracAtInset(lr.height, off));
  }
  if (scans.includes("left")) {
    for (const off of EDGE_OFFSETS) add(`left${off >= 0 ? "+" : ""}${off}`, fracAtInset(lr.width, off), 0.5);
  }
  if (scans.includes("right")) {
    for (const off of EDGE_OFFSETS) add(`right${off >= 0 ? "+" : ""}${off}`, 1 - fracAtInset(lr.width, off), 0.5);
  }
  if (scans.includes("corners")) {
    for (const [lx, ly, name] of [[1, 1, "TL"], [-1, 1, "TR"], [1, -1, "BL"], [-1, -1, "BR"]]) {
      const fx = lx > 0 ? fracAtInset(lr.width, 20) : 1 - fracAtInset(lr.width, 20);
      const fy = ly > 0 ? fracAtInset(lr.height, 20) : 1 - fracAtInset(lr.height, 20);
      add(`corner${name}+20`, fx, fy);
    }
  }
  if (scans.includes("grid")) {
    // A grid over the card's own box (plus a one-step margin), to map where the raise correction is applied and
    // where it is lost. The correction is a property of the PIXEL (the renderer claims a pixel for a card only
    // when that card's own art paints it AND the pixel is within the anchor margin of its box), so a grid is the
    // only honest shape for the question "how much of a card is it lost on".
    for (let iy = -1; iy <= 8; iy++) {
      for (let ix = -1; ix <= 8; ix++) {
        add(`grid${ix},${iy}`, ix / 7, iy / 7);
      }
    }
  }
  if (scans.includes("named")) {
    // The exact points H1/H6 sample, so a map row can be read straight against a harness failure.
    add("h6.topLeft", 0.06, 0.08);
    add("h6.topRight", 0.94, 0.08);
    add("h6.leftEdge", 0.04, 0.5);
    add("h6.rightEdge", 0.96, 0.5);
    add("h6.overhangTop", 0.5, -0.05);
    add("h1.centre", 0.5, 0.5);
  }
  return plan;
}

/**
 * The two pointer kinds, as this probe uses them.
 *
 * MOUSE is a pure hover: no press, so nothing can be picked up or played, and the whole map is built out of
 * hover-focus — the same hit test a tap resolves through.
 *
 * TOUCH has no hover channel at all, so the only gesture that asks the same question is a press held still (a
 * PEEK). That makes the touch arm able to commit things a hover cannot, and it needs the harness's own
 * discipline: rest is a TAP ON EMPTY SPACE, which is the client's documented disarm (`onTouchUp`'s `!top`
 * branch), and a sample that leaves a card out of the fan is reported rather than quietly carried into the
 * next one.
 */
async function makeProbePointer(page, kind) {
  if (kind === "mouse") {
    return {
      kind,
      sample: async (x, y) => { await page.mouse.move(x, y); },
      finish: async () => {},
      rest: async (x, y) => { await page.mouse.move(x, y); }
    };
  }
  const cdp = await page.context().newCDPSession(page);
  const dispatch = (type, x, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }]
    });
  return {
    kind,
    sample: (x, y) => dispatch("touchStart", x, y),
    finish: (x, y) => dispatch("touchEnd", x, y),
    // A tap on genuinely empty space — refused when anything is stamped there, because a tap on a widget would
    // arm THAT instead (the harness's `rest` carries the same rule and the same reason).
    rest: async (x, y) => {
      const empty = await page.evaluate(([px, py]) => {
        if (typeof document.elementsFromPoint !== "function") return false;
        for (const el of document.elementsFromPoint(px, py)) {
          if (el.getAttribute?.("data-touch-id") !== null || el.getAttribute?.("data-touch-block") !== null) return false;
        }
        return true;
      }, [x, y]);
      if (!empty) return;
      await dispatch("touchStart", x, y);
      await sleep(40);
      await dispatch("touchEnd", x, y);
    }
  };
}

async function sampleAt(page, pointer, fan, card, fx, fy, settleMs) {
  const pt = pointOn(card, fan, fx, fy);
  if (!pt.onStage) return { skipped: "off stage", ...pt };
  const before = await sentCount(page);
  await pointer.sample(pt.cx, pt.cy);
  await sleep(settleMs);
  const focus = [];
  for (let i = 0; i < 4; i++) {
    focus.push((await readFocus(page)).zFocus);
    await sleep(60);
  }
  await pointer.finish(pt.cx, pt.cy);
  const sent = (await sentSince(page, before)).filter((s) => s.coordX !== undefined);
  // The FIRST envelope is the one the sample is about: on touch the release is re-resolved after the gesture
  // has already changed the hand's state, so scoring the last one would score the teardown.
  const last = sent[0] ?? null;
  const distinct = [...new Set(focus)];
  return {
    ...pt,
    sentAll: sent.map((x) => [Math.round(x.coordX), Math.round(x.coordY), x.kind ?? ""]),
    sentX: last ? last.coordX : null,
    sentY: last ? last.coordY : null,
    inputsSent: sent.length,
    focus: distinct.length === 1 ? distinct[0] : null,
    focusStable: distinct.length === 1,
    focusSeen: distinct,
  };
}

async function main() {
  acquireLock();
  const stamp = args.tag ?? `${args.viewport.width}-raise${args.raise}${args.stageFit ? `-${args.stageFit}` : ""}`;
  const outDir = resolve(REPO_ROOT, args.out);
  mkdirSync(outDir, { recursive: true });

  const q = new URLSearchParams({ raiseHand: args.raise, stage: "dom" });
  if (args.stageFit) q.set("stageFit", args.stageFit);
  const url = `http://127.0.0.1:${args.vite}/?${q.toString()}`;

  const browser = await chromium.launch({
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
  });
  const context = await browser.newContext({ viewport: args.viewport, hasTouch: args.pointer === "touch", deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__sentInputs = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (msg) {
      if (typeof msg === "string") {
        try {
          const parsed = JSON.parse(msg);
          if (parsed && parsed.type === "input") window.__sentInputs.push({ t: performance.now(), ...parsed });
        } catch { /* not our envelope */ }
      }
      return orig.call(this, msg);
    };
  });

  log(`opening ${url} at ${args.viewport.width}x${args.viewport.height}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("[data-node-id]").length > 400, null, { timeout: 60000 });
  await sleep(3500);
  await awaitRest(page, { requireNoFocus: false });

  const fan0 = await readFan(page);
  if (!fan0 || fan0.cards.length < 4) {
    throw new Error(`no fan to sweep (${fan0 ? fan0.cards.length : 0} cards) — is a combat fixture loaded?`);
  }
  log(`fan: ${fan0.cards.length} cards, designW ${fan0.designW}, spreadFactor ${fan0.spreadFactor}, scale ${fan0.scale.toFixed(4)}`);
  for (const c of fan0.cards) log(`  [${c.index}] ${c.name} raiseDy=${c.raiseDy} spreadDx=${Math.round(c.spreadDx)}`);

  const shot = `${outDir}/hitmap-${stamp}-frame.png`;
  await page.screenshot({ path: shot });

  const pointer = await makeProbePointer(page, args.pointer);
  const indices = args.cards ?? [1, Math.floor(fan0.cards.length / 2), fan0.cards.length - 2];
  const restPoint = {
    x: fan0.origin.x + fan0.scale * fan0.designW * 0.5,
    y: fan0.origin.y + fan0.scale * 200,
  };

  const rows = [];
  for (const idx of indices) {
    const seed = fan0.cards[idx];
    if (!seed) { log(`  card ${idx} is not in the fan — skipped`); continue; }
    const plan = planForCard(seed, args.scans);
    log(`\n--- card[${idx}] ${seed.name}: ${plan.length} points`);
    for (const { label, fx, fy } of plan) {
      // Re-read the fan before EVERY point: the previous hover focused a card and the game re-posed the fan
      // around it, so a point computed from an older frame aims at where the card used to be.
      await pointer.rest(restPoint.x, restPoint.y);
      await awaitRest(page);
      const { fan, card, settled } = await awaitFanSettled(page, seed.holderId);
      if (!card) { log(`  ${label}: the card left the fan — skipped`); continue; }
      if (!settled) { log(`  ${label}: the fan never settled — skipped (would measure the harness, not the game)`); continue; }
      const preFocus = await readFocus(page);
      const s = await sampleAt(page, pointer, fan, card, fx, fy, args.settle);
      if (s.skipped) { log(`  ${label}: ${s.skipped}`); continue; }
      // Penetrations of the SENT coordinate into every fan card's GAME box — what the game was really asked.
      const pens = fan.cards.map((c) => {
        const p = s.sentX === null ? null : penetration(c, s.sentX, s.sentY);
        return { index: c.index, holderId: c.holderId, out: p ? Math.round(p.out * 10) / 10 : null, inside: p ? p.inside : null };
      });
      const self = pens.find((p) => p.holderId === card.holderId);
      const focusedIdx = fan.cards.find((c) => c.holderId === s.focus)?.index ?? null;
      const containing = pens.filter((p) => p.inside).map((p) => p.index);
      const row = {
        card: idx,
        holderId: card.holderId,
        label,
        // Provenance of the geometry this point was computed from. A hit map is only as good as the pose it
        // aimed at, so every row carries the pose it used and what the fan looked like around it.
        readPose: [Math.round(card.transform[4]), Math.round(card.transform[5])],
        readRaiseDy: Math.round(card.raiseDy),
        readScaleY: Math.round(card.transform[3] * 1000) / 1000,
        readFocused: preFocus.zFocus,
        readOutOfFan: preFocus.outOfFan.length,
        seamGameY: Math.round(card.seamGameY),
        seamDrawnY: Math.round(card.seamDrawnY),
        seamZ: card.seamZ,
        client: [Math.round(s.cx), Math.round(s.cy)],
        design: [Math.round(s.designX), Math.round(s.designY)],
        gamePoint: [Math.round(s.gameX), Math.round(s.gameY)],
        sent: s.sentX === null ? null : [Math.round(s.sentX), Math.round(s.sentY)],
        raiseApplied: s.sentY === null ? null : Math.round(s.sentY - s.designY),
        selfOut: self ? self.out : null,
        containing,
        focused: s.focus,
        focusedCard: focusedIdx,
        focusStable: s.focusStable,
        inputsSent: s.inputsSent,
        sentAll: s.sentAll,
        pens: pens.map((p) => p.out),
      };
      rows.push(row);
      const verdict =
        s.focus === null ? "NOTHING" : focusedIdx === idx ? "self" : `card${focusedIdx}`;
      row.correction = row.raiseApplied;
      log(
        `  ${label.padEnd(18)} sent ${row.sent ? `${row.sent[0]},${row.sent[1]}` : "-"}`.padEnd(40) +
          ` pose=${row.readPose[1]}`.padEnd(11) +
          ` seam=${row.seamGameY}`.padEnd(11) +
          ` dy=${row.readRaiseDy}`.padEnd(8) +
          ` out=${row.selfOut}`.padEnd(11) +
          ` in=[${containing.join(",")}]`.padEnd(10) +
          ` -> ${verdict}`
      );
    }
  }

  await pointer.rest(restPoint.x, restPoint.y);
  const report = {
    at: new Date().toISOString(),
    args: { ...args },
    url,
    fan: { designW: fan0.designW, spreadFactor: fan0.spreadFactor, scale: fan0.scale, cards: fan0.cards.map((c) => ({ index: c.index, name: c.name, raiseDy: c.raiseDy, spreadDx: c.spreadDx, localRect: c.localRect, transform: c.transform })) },
    screenshot: shot,
    rows,
  };
  const path = `${outDir}/hitmap-${stamp}-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2));
  log(`\nmap: ${path}\nframe: ${shot}`);

  await context.close();
  await browser.close();
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`\nprobe error: ${err && err.stack ? err.stack : err}`);
  code = 2;
} finally {
  releaseLock();
}
process.exit(code);
