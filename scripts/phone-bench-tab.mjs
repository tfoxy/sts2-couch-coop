#!/usr/bin/env node
// phone-bench-tab.mjs — put ONE genuinely-foregrounded, bench-owned tab on the phone, and prove it is being
// scheduled. Also the tool that hands the phone back afterwards.
//
// WHY THIS IS A SCRIPT AND NOT THREE LINES INLINE. Driving the phone's own Chrome over CDP has three traps,
// all of them measured on this round's Moto G86 / Chrome 151 rather than assumed, and all three fail SILENTLY
// in the direction of a beautiful, meaningless number:
//
//   1. `page.bringToFront()` DOES NOT FOREGROUND A TAB on Android Chrome. It returns in ~4ms, reports success,
//      and the tab stays in the background. (Measured: bringToFront returned in 4ms, the phone kept showing a
//      different tab, and the "foregrounded" tab then got 0 animation frames in a second.) Android's tab
//      switcher is driven by the browser UI, not by CDP's Target.activateTarget. The only thing that reliably
//      foregrounds a URL is an ANDROID INTENT: `am start -a VIEW -d <url> --ez create_new_tab true`.
//   2. `document.visibilityState` LIES on a backgrounded Android tab — it answers "visible" while the tab
//      receives no frames at all. It is not a usable liveness test.
//   3. Playwright's `waitForFunction` polls on requestAnimationFrame BY DEFAULT. A background Android tab gets
//      no rAF, so such a wait does not time out and fail — it hangs forever. Every wait here polls on a timer.
//
// The ONLY honest test that a tab is foreground is COUNTING ANIMATION FRAMES, which is what `--verify` does.
//
// SAFETY. This script never navigates a tab it was not pointed at, never opens the mirror's "/" direct view
// (that pushes settings to a live host on connect) and never sends touch input. `--close-origin` only closes
// tabs on the bench's OWN origin.
//
// Usage:
//   node scripts/phone-bench-tab.mjs open  --url http://127.0.0.1:5190/?x=1   # fresh foreground bench tab
//   node scripts/phone-bench-tab.mjs verify --url-prefix http://127.0.0.1:5190
//   node scripts/phone-bench-tab.mjs list
//   node scripts/phone-bench-tab.mjs restore --front http://worky.local:13337/ --close-origin http://127.0.0.1:5190

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { isHttpPageAtPrefixOrPort, isHttpPageOnPort, waitForPageTarget } from "./lib/phone-bench-tab-target.mjs";
import { assertLease } from "./live-qa-lock.mjs";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("playwright");

function parseArgs(argv) {
  const a = {
    cmd: argv[0] || "list",
    serial: process.env.ADB_SERIAL || "ZY32LL2X8W",
    cdpPort: 9222,
    url: null,
    urlPrefix: null,
    front: null,
    closeOrigin: null,
    minRaf: 20,
    help: false
  };
  for (let i = 1; i < argv.length; i++) {
    const val = () => argv[++i];
    switch (argv[i]) {
      case "--serial": a.serial = String(val()); break;
      case "--cdp-port": a.cdpPort = Number(val()); break;
      case "--url": a.url = String(val()); break;
      case "--url-prefix": a.urlPrefix = String(val()); break;
      case "--front": a.front = String(val()); break;
      case "--close-origin": a.closeOrigin = String(val()); break;
      case "--min-raf": a.minRaf = Number(val()); break;
      case "--help": case "-h": a.help = true; break;
      default: console.error(`Unknown argument: ${argv[i]}`); a.help = true;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !["open", "verify", "list", "restore"].includes(args.cmd)) {
  console.log(`phone-bench-tab.mjs <open|verify|list|restore> [options]

  open     --url <u>            open <u> as a NEW FOREGROUND tab (Android intent), then verify it is scheduled
  verify   --url-prefix <p>     count animation frames on the tab at <p>; exit 1 if it is throttled
  list                          every tab, with its measured animation-frame rate (the honest foreground test)
  restore  --front <u>          bring <u> back to the foreground (Android intent, reusing the existing tab)
           --close-origin <o>   ALSO close every tab whose URL starts with <o> (the bench's own tabs)

  --serial <s>    adb serial (default env ADB_SERIAL or ZY32LL2X8W)
  --cdp-port <n>  host port forwarded to the phone's DevTools socket (default 9222; this script installs the
                  forward itself and removes it on exit)
  --min-raf <n>   frames/second below which a tab counts as throttled (default 20)`);
  process.exit(args.help ? 0 : 2);
}

assertLease({
  owner: process.env.COUCHCOOP_LIVEQA_OWNER,
  pid: Number(process.env.COUCHCOOP_LIVEQA_PID),
  resources: ["shared:install", `exclusive:android:${args.serial}`, `exclusive:browser:${args.cdpPort}`]
});

const adb = (...a) => execFileSync("adb", ["-s", args.serial, ...a], { encoding: "utf8" });

let hadForward = false;
try {
  hadForward = adb("forward", "--list").includes(`tcp:${args.cdpPort}`);
} catch { /* ignore */ }
if (!hadForward) adb("forward", `tcp:${args.cdpPort}`, "localabstract:chrome_devtools_remote");
process.on("exit", () => {
  // Only remove a forward this process installed — a bench running alongside owns its own.
  if (!hadForward) { try { adb("forward", "--remove", `tcp:${args.cdpPort}`); } catch { /* ignore */ } }
});

/**
 * Close every tab on `origin` using the PLAIN HTTP DevTools endpoints, before Playwright ever attaches.
 *
 * This ordering is the whole point. `connectOverCDP` attaches to EVERY target in the browser, and one wedged
 * target hangs the entire handshake — measured here: a leftover mirror page whose bench
 * websocket had gone away) made `connectOverCDP` time out at 30s, then at 150s, against a browser whose
 * `/json/list` was answering in milliseconds the whole time. Closing that one tab took the connect back to
 * 1.2s. So the bench's own leftovers have to be swept with a tool that does NOT attach.
 */
async function httpCloseOrigin(port, origin) {
  let list;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) });
    list = await res.json();
  } catch (e) {
    console.error(`phone-bench-tab: could not read /json/list: ${e.message}`);
    return 0;
  }
  let closed = 0;
  for (const t of list) {
    const u = t.url || "";
    if (t.type !== "page") continue;
    if (!u.startsWith(origin) && u !== "about:blank") continue;
    try {
      await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`, { signal: AbortSignal.timeout(8000) });
      closed++;
    } catch { /* best effort */ }
  }
  if (closed) await new Promise((r) => setTimeout(r, 1500));
  return closed;
}

// Chrome can canonicalize a localhost benchmark tab to worky.local while preserving its port. For a new benchmark
// tab, that port is the ownership boundary: sweep every HTTP(S) page on it before attaching, but leave all other
// user tabs alone. Restore deliberately retains its narrower explicit-origin behavior.
async function httpCloseBenchPort(port, benchUrl) {
  const benchPort = new URL(benchUrl).port;
  let list;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) });
    list = await res.json();
  } catch (e) {
    console.error(`phone-bench-tab: could not read /json/list: ${e.message}`);
    return 0;
  }
  let closed = 0;
  for (const t of list) {
    if (t.type !== "page" || !isHttpPageOnPort(t.url, benchPort)) continue;
    try {
      await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`, { signal: AbortSignal.timeout(8000) });
      closed++;
    } catch { /* best effort */ }
  }
  if (closed) await new Promise((r) => setTimeout(r, 1500));
  return closed;
}

/** Count real animation frames over ~1s. The ONLY reliable "is this tab foreground" test on Android. */
async function rafRate(page) {
  return Promise.race([
    page.evaluate(() => new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else resolve(n); };
      requestAnimationFrame(tick);
      setTimeout(() => resolve(n), 2500); // a frozen tab books no rAF at all — resolve 0 rather than hang
    })),
    new Promise((r) => setTimeout(() => r(-1), 6000))
  ]).catch(() => -1);
}

/** Foreground a URL. `create_new_tab` is what stops Chrome navigating whatever tab the user was reading. */
function intentOpen(url, newTab) {
  const out = adb(
    "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url,
    "-n", "com.android.chrome/com.google.android.apps.chrome.Main",
    ...(newTab ? ["--ez", "create_new_tab", "true"] : [])
  );
  return out.trim();
}

// SWEEP BEFORE ATTACHING (see httpCloseOrigin): the bench's own leftover tabs are exactly the ones that can
// wedge `connectOverCDP`, so they go first, over plain HTTP, while attaching is still possible.
if (args.cmd === "open" && args.url) {
  const n = await httpCloseBenchPort(args.cdpPort, args.url);
  if (n) console.error(`phone-bench-tab: swept ${n} stale bench tab(s) on port ${new URL(args.url).port} before attaching`);
} else if (args.cmd === "restore" && args.closeOrigin) {
  const n = await httpCloseOrigin(args.cdpPort, args.closeOrigin);
  if (n) console.error(`phone-bench-tab: swept ${n} stale bench tab(s) on ${args.closeOrigin} before attaching`);
}

// Android Chrome does not reliably announce a tab created by an intent to an already-attached
// Playwright context.  In that failure mode /json/list sees the tab immediately, while
// context.pages() remains stale until a fresh CDP attach.  Open first, then attach, so the
// context used by the rAF foreground proof owns the intended target from the start.
if (args.cmd === "open") {
  if (!args.url) { console.error("open needs --url"); process.exit(2); }
  console.error(intentOpen(args.url, true));
  try {
    await waitForPageTarget({
      endpoint: `http://127.0.0.1:${args.cdpPort}/json/list`,
      urlPrefix: new URL(args.url).origin,
      urlPort: new URL(args.url).port
    });
  } catch (error) {
    console.error(`phone-bench-tab: ${error.message}`);
    process.exit(1);
  }
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${args.cdpPort}`, { timeout: 60000 });
const context = browser.contexts()[0];
if (!context) { console.error("phone-bench-tab: the attached browser has no context."); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args.cmd === "list") {
  for (const p of context.pages()) {
    const r = await rafRate(p);
    console.log(`${String(r).padStart(4)} fps  ${p.url().slice(0, 100)}`);
  }
  console.log("\n(the tab with a real frame rate is the FOREGROUND one; visibilityState cannot tell you this)");
} else if (args.cmd === "open") {
  const benchPort = new URL(args.url).port;
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(500);
    page = context.pages().find((p) => isHttpPageOnPort(p.url(), benchPort)) || null;
  }
  if (!page) { console.error(`phone-bench-tab: no tab appeared on port ${benchPort} after 20s.`); process.exit(1); }
  await sleep(1500);
  const r = await rafRate(page);
  console.log(`opened  ${page.url().slice(0, 100)}\nrAF     ${r} frames/s`);
  if (r < args.minRaf) {
    console.error(`phone-bench-tab: the new tab is THROTTLED (${r} fps < ${args.minRaf}). Is the screen on and Chrome foreground?`);
    process.exit(1);
  }
} else if (args.cmd === "verify") {
  const prefix = args.urlPrefix || args.url;
  if (!prefix) { console.error("verify needs --url-prefix"); process.exit(2); }
  const pages = context.pages().filter((p) => isHttpPageAtPrefixOrPort(p.url(), prefix));
  if (!pages.length) { console.error(`phone-bench-tab: no tab at ${prefix}`); process.exit(1); }
  let best = -1;
  for (const p of pages) {
    const r = await rafRate(p);
    console.log(`${String(r).padStart(4)} fps  ${p.url().slice(0, 100)}`);
    best = Math.max(best, r);
  }
  if (best < args.minRaf) { console.error(`phone-bench-tab: THROTTLED (best ${best} fps)`); process.exit(1); }
} else if (args.cmd === "restore") {
  if (args.closeOrigin) {
    for (const p of context.pages()) {
      if (p.url().startsWith(args.closeOrigin)) {
        console.log("closing bench tab " + p.url().slice(0, 80));
        await p.close().catch((e) => console.log("  (close failed: " + e.message.slice(0, 60) + ")"));
      }
    }
  }
  if (args.front) {
    // Reuse the EXISTING tab (no create_new_tab): the point is to hand back the tab the operator had, not to
    // open a second copy of it — which for a mirror URL would be a second connection to the live host.
    console.log(intentOpen(args.front, false));
    await sleep(2000);
    const p = context.pages().find((q) => q.url().startsWith(args.front));
    console.log(p ? `foreground now: ${p.url().slice(0, 100)} (rAF ${await rafRate(p)} fps)` : "restore: tab not found");
  }
}

await browser.close();
process.exit(0);
