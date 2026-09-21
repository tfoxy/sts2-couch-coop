#!/usr/bin/env node

import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { assertLease } from "./live-qa-lock.mjs";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require("playwright");

const STORAGE_KEY = "couchcoop.installPrompt.snoozedUntil";
const SNOOZE_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    command: argv[0] ?? "",
    serial: process.env.ADB_SERIAL ?? "ZY32LL2X8W",
    cdpPort: 9222,
    url: "",
    stateFile: "",
  };
  for (let index = 1; index < argv.length; index++) {
    const value = () => argv[++index];
    switch (argv[index]) {
      case "--serial": args.serial = String(value()); break;
      case "--cdp-port": args.cdpPort = Number(value()); break;
      case "--url": args.url = String(value()); break;
      case "--state-file": args.stateFile = String(value()); break;
      default: throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!["save-and-snooze", "restore"].includes(args.command) || !args.url || !args.stateFile) {
  console.error("phone-bench-install-overlay.mjs <save-and-snooze|restore> --url <benchmark-url> --state-file <path> [--serial <id>] [--cdp-port <port>]");
  process.exit(2);
}

assertLease({
  owner: process.env.COUCHCOOP_LIVEQA_OWNER,
  pid: Number(process.env.COUCHCOOP_LIVEQA_PID),
  resources: ["shared:install", `exclusive:android:${args.serial}`, `exclusive:browser:${args.cdpPort}`],
});

const expected = new URL(args.url);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${args.cdpPort}`);
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => {
    try {
      const url = new URL(candidate.url());
      return ["http:", "https:"].includes(url.protocol) && url.origin === expected.origin;
    } catch {
      return false;
    }
  });
  if (!page) throw new Error(`no benchmark page found at origin ${expected.origin}`);
  const origin = await page.evaluate(() => location.origin);

  if (args.command === "save-and-snooze") {
    let saved;
    try {
      saved = JSON.parse(readFileSync(args.stateFile, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const value = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
      saved = { schema: "phone-bench-install-overlay/1", origin, key: STORAGE_KEY, value };
      writeFileSync(args.stateFile, `${JSON.stringify(saved, null, 2)}\n`, { flag: "wx" });
    }
    if (saved.origin !== origin || saved.key !== STORAGE_KEY) {
      throw new Error(`saved install-overlay origin/key does not match current benchmark page (${origin})`);
    }
    const snoozedUntil = await page.evaluate(({ key, durationMs }) => {
      const value = String(Date.now() + durationMs);
      localStorage.setItem(key, value);
      return value;
    }, {
      key: STORAGE_KEY,
      durationMs: SNOOZE_MS,
    });
    const observed = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    if (observed !== snoozedUntil) throw new Error("install-overlay snooze did not persist");
    console.log(JSON.stringify({ origin, key: STORAGE_KEY, snoozedUntil }));
  } else {
    const saved = JSON.parse(readFileSync(args.stateFile, "utf8"));
    if (saved.origin !== origin || saved.key !== STORAGE_KEY) {
      throw new Error(`refusing to restore install-overlay storage on a different origin (${origin})`);
    }
    await page.evaluate(({ key, value }) => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }, { key: STORAGE_KEY, value: saved.value });
    const observed = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    if (observed !== saved.value) throw new Error("install-overlay storage restore did not reproduce the exact value");
    console.log(JSON.stringify({ origin, key: STORAGE_KEY, restored: saved.value }));
  }
} finally {
  await browser.close();
}
