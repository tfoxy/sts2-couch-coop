// Dumps the live mirror's scene metadata so text-scale selectors (frontend/src/mirror/mirrorTextScale.css)
// can be authored against REAL runtime data — many authored .tscn sub-widgets are not runtime scene
// boundaries, so their `data-scene-file` / `data-scene-node-path` differ from the authored names.
//
// Usage (from frontend/, so `playwright` resolves):
//   node ../scripts/dump-mirror-scene-meta.mjs                 # group every scene file → its label node-paths
//   node ../scripts/dump-mirror-scene-meta.mjs Cost            # only node-paths whose label matches a filter
//   MIRROR_URL=http://localhost:5173/?name=test node ../scripts/dump-mirror-scene-meta.mjs
//
// Navigate the live game to the screen you want to capture FIRST, then run it.

// playwright lives in frontend/node_modules; resolve it from there so this script runs from anywhere.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "package.json"));
const { chromium } = require("playwright");

const url = process.env.MIRROR_URL ?? "http://localhost:5173/?name=test";
const filter = (process.argv[2] ?? "").toLowerCase();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(Number(process.env.MIRROR_WAIT_MS ?? 4000)); // let the mirror connect + keyframe

const data = await page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll("[data-scene-file]")) {
    const file = el.getAttribute("data-scene-file");
    const np = el.getAttribute("data-scene-node-path") ?? "";
    const type = (el.getAttribute("data-node-type") ?? "").split(".").at(-1);
    const text = el.querySelector(".mirror-text")?.textContent?.trim()?.slice(0, 24) ?? "";
    (out[file] ??= []).push({ np, type, text });
  }
  return out;
});
await browser.close();

for (const file of Object.keys(data).sort()) {
  const rows = data[file]
    .filter((r) => !filter || r.text.toLowerCase().includes(filter) || r.np.toLowerCase().includes(filter))
    .map((r) => `   ${r.np}  [${r.type}]${r.text ? `  «${r.text}»` : ""}`);
  const unique = [...new Set(rows)].sort();
  if (unique.length === 0) continue;
  console.log(`## ${file}`);
  console.log(unique.join("\n"));
  console.log("");
}
