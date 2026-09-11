#!/usr/bin/env node
// WS3 live probe: the join state in the page URL, driven against a REAL host.
//
// Leg "host": pick the [Host] row → the URL must gain an EMPTY `?name=` as a NEW history entry, a reload must
// land straight back on the host view (no picker), and Back must return to the picker.
// Leg "seat": join a seat by name → the URL must gain `?name=<seat>` as a NEW history entry, Back must land on
// the picker with a clean URL and NO auto-rejoin, Forward must rejoin.
//
// Usage: node scripts/probe-join-url-flow.mjs <host|seat> [--name Ann] [--base http://127.0.0.1:13337]
// Screenshots + a JSON transcript land in .sts2/artifacts/ws3-joinflow/.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// playwright lives in frontend/node_modules (ESM resolves from THIS file's dir, which has none).
const { chromium } = createRequire(new URL("../frontend/package.json", import.meta.url))("playwright");

const leg = process.argv[2] ?? "host";
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const base = arg("--base", "http://127.0.0.1:13337");
const seatName = arg("--name", "Ann");
const outDir = arg("--out", ".sts2/artifacts/ws3-joinflow");
mkdirSync(outDir, { recursive: true });

const log = [];
let step = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on("console", (m) => {
  if (m.type() === "error") log.push({ consoleError: m.text() });
});

const state = async () => ({
  url: page.url(),
  historyLength: await page.evaluate(() => history.length),
  // NOTE: the picker section's own data-testid is overwritten by MirrorApp's `mirror-status` fallthrough, so
  // the roster container (a child) is what identifies "the picker is up".
  picker: await page.locator('[data-testid="player-picker"]').isVisible().catch(() => false),
  nameField: await page.locator('[data-testid="join-name-input"]').isVisible().catch(() => false),
  scene: await page.locator('[data-testid="mirror-frame"]').isVisible().catch(() => false),
  heading: await page.locator('[data-testid="mirror-status"] h1').first().textContent().catch(() => null)
});

async function shot(label) {
  const s = await state();
  const file = `${outDir}/${String(++step).padStart(2, "0")}-${label}.png`;
  await page.screenshot({ path: file });
  const entry = { step, label, file, ...s };
  log.push(entry);
  console.log(JSON.stringify(entry));
  return entry;
}

const waitFor = async (predicate, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) {
      log.push({ timeout: what });
      console.log(JSON.stringify({ timeout: what }));
      return false;
    }
    await page.waitForTimeout(500);
  }
};
// "the picker is gone" is the SCENE being up, not merely the roster being absent — the roster also disappears
// for a moment while a join is in flight, and asserting on that would pass before the host has answered.
const sceneUp = async () => page.locator('[data-testid="mirror-frame"]').isVisible().catch(() => false);
const pickerGone = sceneUp;
const pickerUp = async () => page.locator('[data-testid="player-picker"]').isVisible().catch(() => false);

await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
if (leg === "solo") {
  // A SINGLEPLAYER run: the app asks for direct view itself and the URL must stay untouched — there is no seat
  // to return to, so a marker would only be a lie the next load acts on.
  await waitFor(sceneUp, 60_000, "singleplayer direct view");
  await shot("singleplayer-direct-view");
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(sceneUp, 60_000, "singleplayer direct view after reload");
  await shot("singleplayer-after-reload");
  writeFileSync(`${outDir}/${leg}-transcript.json`, JSON.stringify(log, null, 2));
  await browser.close();
  console.log(`transcript: ${outDir}/${leg}-transcript.json`);
  process.exit(0);
}
await waitFor(pickerUp, 30_000, "picker on first load");
await shot("picker");

if (leg === "host") {
  const hostRow = page.locator('[data-testid="player-picker"] button', { has: page.locator('[data-testid="host-badge"]') });
  await hostRow.first().click();
  await waitFor(pickerGone, 60_000, "host direct view");
  await shot("host-view-after-pick");

  await page.reload({ waitUntil: "domcontentloaded" });
  // The picker must never take over: the app re-picks the host row itself off the empty `?name=`.
  await waitFor(pickerGone, 60_000, "host view restored after reload");
  await shot("host-view-after-reload");

  await page.goBack();
  await waitFor(pickerUp, 30_000, "picker after Back");
  await shot("picker-after-back");

  await page.goForward();
  await waitFor(pickerGone, 60_000, "host view after Forward");
  await shot("host-view-after-forward");
} else {
  await page.fill('[data-testid="join-name-input"]', seatName);
  await page.click('[data-testid="join-submit"]');
  await shot("joining");
  // The seat spawns a real headless instance: 20-60s is normal, allow more.
  await waitFor(async () => page.url().includes(`name=${encodeURIComponent(seatName)}`), 180_000, "?name= stamped");
  await waitFor(pickerGone, 180_000, "own seat view");
  await shot("seat-view");

  await page.goBack();
  await waitFor(pickerUp, 60_000, "picker after Back");
  await page.waitForTimeout(4000); // …and it STAYS: no auto-rejoin behind the picker
  await shot("picker-after-back");

  await page.goForward();
  await waitFor(async () => page.url().includes(`name=${encodeURIComponent(seatName)}`), 60_000, "?name= after Forward");
  await waitFor(pickerGone, 180_000, "seat view after Forward");
  await shot("seat-view-after-forward");
}

writeFileSync(`${outDir}/${leg}-transcript.json`, JSON.stringify(log, null, 2));
await browser.close();
console.log(`transcript: ${outDir}/${leg}-transcript.json`);
