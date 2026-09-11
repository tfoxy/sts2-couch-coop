#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isHttpPageAtPrefixOrPort, isHttpPageOnPort, waitForPageTarget } from "./lib/phone-bench-tab-target.mjs";

const source = readFileSync(resolve("scripts/phone-bench-tab.mjs"), "utf8");
const openBeforeAttach = source.indexOf('if (args.cmd === "open") {\n  if (!args.url)') <
  source.indexOf("const browser = await chromium.connectOverCDP");

assert.ok(openBeforeAttach, "open must create the Android-intent tab before the CDP attach");
assert.equal((source.match(/intentOpen\(args\.url, true\)/g) ?? []).length, 1,
  "open must issue exactly one new-tab intent");
const openBranch = source.slice(source.indexOf('} else if (args.cmd === "open") {'), source.indexOf('} else if (args.cmd === "verify") {'));
assert.doesNotMatch(openBranch, /for \(const p of context\.pages\(\)\).*p\.url\(\)\.startsWith\(origin\)/s,
  "open must not close the newly intent-created bench tab after attaching");
assert.match(source, /httpCloseBenchPort\(args\.cdpPort, args\.url\)/,
  "open must sweep canonicalized benchmark tabs by port before CDP attaches");
assert.match(source, /urlPort: new URL\(args\.url\)\.port/,
  "plain-HTTP target wait must accept Chrome's same-port canonical host");
assert.match(openBranch, /isHttpPageOnPort\(p\.url\(\), benchPort\)/,
  "post-attach selection must accept Chrome's same-port canonical host");
assert.match(source, /isHttpPageAtPrefixOrPort\(p\.url\(\), prefix\)/,
  "post-cell verification must accept Chrome's same-port canonical host");

assert.equal(isHttpPageOnPort("http://worky.local:5299/?quality=high", 5299), true);
assert.equal(isHttpPageOnPort("https://127.0.0.1:5299/", "5299"), true);
assert.equal(isHttpPageOnPort("http://worky.local:5300/", 5299), false);
assert.equal(isHttpPageOnPort("chrome://newtab/", 5299), false);
assert.equal(isHttpPageAtPrefixOrPort("http://worky.local:5299/?quality=high", "http://127.0.0.1:5299"), true);
assert.equal(isHttpPageAtPrefixOrPort("http://worky.local:5300/?quality=high", "http://127.0.0.1:5299"), false);
assert.equal(isHttpPageAtPrefixOrPort("https://example.test/", "https://example.test/"), true);
assert.equal(isHttpPageAtPrefixOrPort("https://canonical.test/", "https://example.test/"), false,
  "an implicit default port must not broaden verification to every HTTPS tab");

let clock = 0;
let calls = 0;
const target = await waitForPageTarget({
  endpoint: "http://devtools/json/list",
  urlPrefix: "http://127.0.0.1:5299",
  timeoutMs: 100,
  pollMs: 10,
  now: () => clock,
  sleep: async (ms) => { clock += ms; },
  fetchImpl: async () => ({ json: async () => (++calls < 3
    ? [{ type: "page", url: "https://example.test" }]
    : [{ type: "page", url: "http://127.0.0.1:5299/" }]) })
});
assert.equal(target.url, "http://127.0.0.1:5299/");
assert.equal(calls, 3, "plain DevTools polling must wait through target-registration delay");

const canonicalTarget = await waitForPageTarget({
  endpoint: "http://devtools/json/list",
  urlPrefix: "http://127.0.0.1:5299",
  urlPort: "5299",
  timeoutMs: 20,
  pollMs: 10,
  fetchImpl: async () => ({ json: async () => [
    { type: "page", url: "https://example.test:5299/" },
    { type: "page", url: "http://worky.local:5299/?quality=high" }
  ] })
});
assert.equal(canonicalTarget.url, "https://example.test:5299/", "the port is the open-tab ownership boundary");

console.log("phone-bench-tab ordering regression test passed");
