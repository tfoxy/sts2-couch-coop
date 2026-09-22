#!/usr/bin/env node
// DOES THE ANIMATED RICH TEXT ACTUALLY MOVE, AND DOES THE GAME'S SWITCH STOP THE RIGHT HALF OF IT?
//
// The unit suites prove the CHAIN — the wire string produces classed, indexed per-character spans, the session
// envelope reaches the stage attribute, the stylesheet carries a rule per class. None of them can prove MOTION:
// jsdom does not run animations, so an assertion there would be an assertion about a string.
//
// This probe closes that gap offline, with no game running. It serves the app from a dev server, intercepts the
// mirror's own WebSocket in-page, and feeds it real STS2 event prose — the exact strings from the shipped
// localization tables, markup included. Then it MEASURES each tagged character's screen position across a second
// of real frames and reports the peak-to-peak displacement, with a screenshot beside every reading.
//
//   # 1. serve the app under test (this checkout) and the game's real fonts:
//   node scripts/serve-res-root.mjs --port 5178 --asset-cache-root ~/.local/share/SlayTheSpire2/couch-coop/cache/<v>/assets &
//   COUCHCOOP_DEV_PROXY_TARGET=http://127.0.0.1:5178 npx vite --port 5177   # from frontend/
//   # 2. measure:
//   node scripts/probe-text-effects.mjs --url http://127.0.0.1:5177
//
// WHAT A PASS LOOKS LIKE. With the preference ON every tagged run moves and the untagged prose does not. With it
// OFF the two runs the GAME gates (the wave, the hop) stop dead while the tremble and Godot's own colour sweep
// keep going — that asymmetry is the game's, reproduced deliberately, and it is the single most surprising thing
// about this feature, so it is what the probe reports rather than a single pass/fail.

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const HELP = `probe-text-effects.mjs — do the game's bbcode text effects animate in the mirror?

  node scripts/probe-text-effects.mjs [--url http://127.0.0.1:5177] [--out DIR] [--samples N]

  --url       dev server serving the checkout under test (default http://127.0.0.1:5177)
  --out       artifact directory (default .sts2/artifacts/text-effects)
  --samples   position samples per reading, one per animation frame (default 300 — the hop's cycle is 4.4s
              and it is still for 91% of it, so a shorter window can miss the only 0.4s that moves)
  --help`;

function parseArgs(argv) {
  const options = { url: "http://127.0.0.1:5177", out: ".sts2/artifacts/text-effects", samples: 300 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "--url") options.url = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--samples") options.samples = Number(argv[++i]) || 300;
    else {
      console.error(`unknown argument: ${arg}\n\n${HELP}`);
      process.exit(2);
    }
  }
  return options;
}

// REAL GAME PROSE, verbatim from the shipped English tables, because a synthetic string cannot show how the
// effects read at the length and density they are actually authored at. `COLOSSAL_FLOWER` alone carries three of
// the four paths (tremble, wave, and the colour sweep nested inside a wave); the fourth is the hop, which the
// game uses for its thinking-ellipsis.
const LABELS = [
  {
    id: "sine",
    y: 120,
    text: "you feel as though the world around you is [sine]warping and twisting[/sine]"
  },
  {
    id: "jitter",
    y: 260,
    text: "a [green]colossal flower[/green] growing atop a [red][jitter]mountain of bones[/jitter][/red]"
  },
  {
    id: "rainbow",
    y: 400,
    text: "its [sine][rainbow freq=0.3 sat=0.8 val=1]color-shifting petals[/rainbow][/sine] pulsate"
  },
  {
    id: "thinky",
    y: 540,
    text: "[thinky_dots]...[/thinky_dots]"
  },
  {
    id: "plain",
    y: 680,
    text: "reaching the prize in the center is so tempting"
  }
];

// A COMPLETE session envelope, because the client's parser is strict about the ones it is not: a missing
// `session`/`players`/`screen` block throws inside `parseBrowserEnvelopeValue`, the client swallows it as
// malformed, and the `directView` directive inside it is never acted on — which presents as a mirror that sits
// on the join picker forever with no error anywhere.
function sessionEnvelope(textEffects) {
  return JSON.stringify({
    type: "session",
    requestId: "probe",
    directView: true,
    textEffects,
    session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 1 },
    players: [],
    screen: { kind: "run", type: "screens/run", title: null, mirrorMode: "singleplayer-run" },
    hostName: "probe",
    assetCacheToken: "probe",
    // Required-true by the client parser; an envelope without it is rejected as malformed.
    scrollAction: true
  });
}

function sceneDelta() {
  const upserts = LABELS.map((label) => ({
    id: label.id,
    parentId: null,
    name: label.id,
    nodeType: "Godot.RichTextLabel",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 160, y: label.y } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 1600, y: 110 } },
    visible: true,
    richText: true,
    text: {
      text: label.text,
      textColor: { r: 1, g: 0.96, b: 0.886, a: 1, html: "#fff6e2ff" },
      fontSize: 34
    },
    font: { resourcePath: "res://fonts/kreon_regular.ttf" }
  }));
  return JSON.stringify({
    type: "scene-delta",
    full: true,
    screenType: "event",
    upserts,
    orderedIds: LABELS.map((l) => l.id)
  });
}

// The in-page fake host. Same shape as bench-mirror-replay's, cut down to what a static scene needs: one session
// envelope, one keyframe, and a `push` seam so the harness can deliver a SECOND session envelope later — which is
// how the preference is flipped through the real client path (envelope -> adoptGameTextEffects -> the stage
// attribute) rather than by poking the DOM.
function fakeHostInit(config) {
  const OPEN = 1;
  const RealWebSocket = window.WebSocket;
  class ProbeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;

    constructor(url, protocols) {
      super();
      this.url = String(url);
      // Everything that is not the mirror's own stream — the dev server's HMR socket above all — goes to the
      // real implementation. A class constructor may return another object, which is what makes that a
      // one-liner instead of a second wrapper.
      if (!this.url.includes("/ws?")) {
        return new RealWebSocket(url, protocols);
      }
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this._watchOn = !this.url.includes("watch=0");
      this._keyframed = false;
      window.__probeWs = this;
      setTimeout(() => this._open(), 0);
    }

    _open() {
      this.readyState = OPEN;
      this._emit("open", new Event("open"));
      // The session first and the scene only once the client has opened its stream gate. The mirror connects
      // with `watch=0` (the pre-join gate) and flips it a microtask after directView resolves; a keyframe
      // delivered inside the open dispatch would be dropped by the client's own gate and never re-sent, which
      // reads exactly like "nothing renders".
      this.push(config.sessionOn);
      this._maybeKeyframe();
    }

    _maybeKeyframe() {
      if (this._keyframed || !this._watchOn) return;
      this._keyframed = true;
      this.push(config.delta);
    }

    push(data) {
      const event = new MessageEvent("message", { data });
      this.onmessage?.(event);
      this.dispatchEvent(event);
    }

    _emit(name, event) {
      this[`on${name}`]?.(event);
      this.dispatchEvent(event);
    }

    // The client sends watch flips, settings, pings and scene-acks; a static scene needs none of them answered
    // except the ping, whose absence would show up as a growing latency readout rather than a render fault.
    send(raw) {
      let message = null;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (message?.type === "ping") {
        this.push(JSON.stringify({ type: "pong", t0: message.t0 }));
      } else if (message?.type === "watch") {
        this._watchOn = message.on !== false;
        this._maybeKeyframe();
      }
    }

    close() {
      this.readyState = 3;
      this._emit("close", new CloseEvent("close"));
    }
  }
  window.WebSocket = ProbeWebSocket;
}

// Peak-to-peak screen displacement of every character in one effect region, sampled once per animation frame.
// Reads `getBoundingClientRect` rather than the computed transform on purpose: it is the position a viewer
// actually sees, after the compositor and after every ancestor scale the mirror applies.
function sampleTravelInPage(samples) {
  const regions = new Map();
  for (const el of document.querySelectorAll("[data-godot-bbcode-effect]")) {
    // The rich text is stamped into four stacked layers; only the fill layer is the one a viewer reads.
    if (!el.closest(".godot-rich-fill")) continue;
    const owner = el.closest("[data-node-id]")?.getAttribute("data-node-id") ?? "?";
    const name = el.getAttribute("data-godot-bbcode-effect");
    const key = `${owner}:${name}`;
    if (!regions.has(key)) regions.set(key, []);
    regions.get(key).push(...el.querySelectorAll(".godot-rich-char"));
  }
  // The untagged control: a label with no effect markup at all must never move.
  const plain = document.querySelector('[data-node-id="plain"] .godot-rich-fill');
  if (plain) regions.set("plain:none", [plain]);

  const tracks = new Map();
  for (const key of regions.keys()) tracks.set(key, []);

  return new Promise((done) => {
    let frame = 0;
    const step = () => {
      for (const [key, elements] of regions) {
        const row = elements.map((el) => {
          const box = el.getBoundingClientRect();
          return [box.left, box.top];
        });
        tracks.get(key).push(row);
      }
      if (++frame >= samples) {
        const out = {};
        for (const [key, rows] of tracks) {
          let dx = 0;
          let dy = 0;
          const count = rows[0]?.length ?? 0;
          for (let i = 0; i < count; i++) {
            const xs = rows.map((r) => r[i][0]);
            const ys = rows.map((r) => r[i][1]);
            dx = Math.max(dx, Math.max(...xs) - Math.min(...xs));
            dy = Math.max(dy, Math.max(...ys) - Math.min(...ys));
          }
          out[key] = { chars: count, travelXpx: Number(dx.toFixed(3)), travelYpx: Number(dy.toFixed(3)) };
        }
        done(out);
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// Colour travel for the sweep, which displaces nothing: the widest gap between any two samples of a character's
// computed colour, as a plain channel distance.
function sampleColorInPage(samples) {
  const el = document.querySelector(
    '.godot-rich-fill [data-godot-bbcode-effect="rainbow"] .godot-rich-char'
  );
  if (!el) return Promise.resolve(null);
  const seen = [];
  return new Promise((done) => {
    let frame = 0;
    const step = () => {
      const rgb = getComputedStyle(el).color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
      seen.push(rgb);
      if (++frame >= samples) {
        let spread = 0;
        for (const a of seen) {
          for (const b of seen) {
            spread = Math.max(spread, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]));
          }
        }
        done({ samples: seen.length, channelSpread: spread, first: seen[0], last: seen[seen.length - 1] });
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = resolve(options.out);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await context.addInitScript(fakeHostInit, { delta: sceneDelta(), sessionOn: sessionEnvelope(true) });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`  [page] ${m.text()}`);
  });

  await page.goto(`${options.url}/?name=Probe&stretch=off`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".godot-rich-char", { timeout: 20000 });
  // Let the face load and the first layout settle, so the first sample is not measuring a font swap.
  await page.waitForTimeout(1500);

  const report = { url: options.url, samples: options.samples, on: {}, off: {} };

  const stageAttrOn = await page.getAttribute(".mirror-stage", "data-spirectl-text-effects");
  report.on.stageAttribute = stageAttrOn;
  report.on.travel = await page.evaluate(sampleTravelInPage, options.samples);
  report.on.color = await page.evaluate(sampleColorInPage, options.samples);
  const onShot = resolve(outDir, "effects-on.png");
  await page.screenshot({ path: onShot, fullPage: false });
  await page.waitForTimeout(350);
  const onShot2 = resolve(outDir, "effects-on-350ms-later.png");
  await page.screenshot({ path: onShot2, fullPage: false });

  // THE FLIP, THROUGH THE REAL PATH: a second session envelope, exactly as a host re-sends on a screen change.
  // Not a DOM poke — the point is to exercise `adoptGameTextEffects`, which is where a once-per-connection seed
  // would have silently pinned the preference at whatever it was when the viewer connected.
  await page.evaluate((envelope) => window.__probeWs.push(envelope), sessionEnvelope(false));
  await page.waitForTimeout(500);

  report.off.stageAttribute = await page.getAttribute(".mirror-stage", "data-spirectl-text-effects");
  report.off.travel = await page.evaluate(sampleTravelInPage, options.samples);
  report.off.color = await page.evaluate(sampleColorInPage, options.samples);
  const offShot = resolve(outDir, "effects-off.png");
  await page.screenshot({ path: offShot, fullPage: false });

  await browser.close();

  const verdicts = [];
  const travelled = (arm, key) => (report[arm].travel[key]?.travelYpx ?? 0) + (report[arm].travel[key]?.travelXpx ?? 0);
  verdicts.push(["wave moves when ON", travelled("on", "sine:sine") > 0.5]);
  verdicts.push(["tremble moves when ON", travelled("on", "jitter:jitter") > 0.5]);
  verdicts.push(["hop moves when ON", travelled("on", "thinky:thinky_dots") > 0.5]);
  verdicts.push(["colour sweeps when ON", (report.on.color?.channelSpread ?? 0) > 20]);
  verdicts.push(["untagged prose never moves", travelled("on", "plain:none") < 0.01]);
  verdicts.push(["stage says off", report.off.stageAttribute === "off"]);
  verdicts.push(["wave STOPS when OFF", travelled("off", "sine:sine") < 0.01]);
  verdicts.push(["hop STOPS when OFF", travelled("off", "thinky:thinky_dots") < 0.01]);
  verdicts.push(["tremble KEEPS GOING when OFF (as in-game)", travelled("off", "jitter:jitter") > 0.5]);
  verdicts.push(["colour KEEPS SWEEPING when OFF (as in-game)", (report.off.color?.channelSpread ?? 0) > 20]);

  report.verdicts = Object.fromEntries(verdicts);
  report.screenshots = [onShot, onShot2, offShot];
  const reportPath = resolve(outDir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\ntext effects ON   stage=${report.on.stageAttribute}`);
  for (const [key, value] of Object.entries(report.on.travel)) {
    console.log(`  ${key.padEnd(20)} chars=${String(value.chars).padStart(3)}  travel x=${String(value.travelXpx).padStart(7)}px  y=${String(value.travelYpx).padStart(7)}px`);
  }
  console.log(`  rainbow colour spread: ${report.on.color?.channelSpread ?? "n/a"}`);
  console.log(`\ntext effects OFF  stage=${report.off.stageAttribute}`);
  for (const [key, value] of Object.entries(report.off.travel)) {
    console.log(`  ${key.padEnd(20)} chars=${String(value.chars).padStart(3)}  travel x=${String(value.travelXpx).padStart(7)}px  y=${String(value.travelYpx).padStart(7)}px`);
  }
  console.log(`  rainbow colour spread: ${report.off.color?.channelSpread ?? "n/a"}`);
  // THE KNOWN GAP, REPORTED RATHER THAN LEFT TO BE DISCOVERED: `[sine][rainbow]` nests in the game and both
  // play there. Here the two rules land on one element per glyph, so `animation` resolves by specificity and
  // only the colour sweep does. The row above shows it as `rainbow:sine  travel 0`, and this names it.
  const nestedWave = report.on.travel["rainbow:sine"];
  if (nestedWave) {
    console.log(
      `\n  note  nested [sine][rainbow] waves ${nestedWave.travelYpx}px here: the built-in colour rule wins the`
      + `\n        cascade over the wave on the shared per-glyph span. Colour sweeps; the wave does not play.`
    );
  }
  console.log("");
  let failed = 0;
  for (const [name, ok] of verdicts) {
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
  }
  console.log(`\nartifacts: ${reportPath}`);
  for (const shot of report.screenshots) console.log(`           ${shot}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
