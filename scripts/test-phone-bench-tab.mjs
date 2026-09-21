#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isHttpPageAtPrefixOrPort, isHttpPageOnPort, waitForPageTarget } from "./lib/phone-bench-tab-target.mjs";
import { androidRemoteCommand } from "./lib/android-remote-command.mjs";
import { sampleRafUntilForeground } from "./lib/phone-bench-tab-raf.mjs";
import { chromeRenderGpuSignature, chromeSandboxedRendererPids, waitForBenchTargetTeardown } from "./lib/phone-bench-tab-teardown.mjs";
import { execFileSync } from "node:child_process";

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
assert.match(source, /sampleRafUntilForeground\(\{\s*sample: \(\) => rafRate\(page\),\s*minRaf: args\.minRaf,/s,
  "open must take its bounded warmup samples from the same owned page");

let warmupSamples = [15, 57];
const warmup = await sampleRafUntilForeground({
  sample: async () => warmupSamples.shift(), minRaf: 20,
});
assert.deepEqual(warmup, { rates: [15, 57], best: 57, foreground: true },
  "a cold first sample must retain the same page when a later window proves foreground scheduling");

let frozenSamples = [0, 0, 0];
const frozen = await sampleRafUntilForeground({
  sample: async () => frozenSamples.shift(), minRaf: 20,
});
assert.deepEqual(frozen, { rates: [0, 0, 0], best: 0, foreground: false },
  "a genuinely frozen/background page must still fail every bounded sample");

assert.equal(isHttpPageOnPort("http://worky.local:5299/?quality=high", 5299), true);
assert.equal(isHttpPageOnPort("https://127.0.0.1:5299/", "5299"), true);
assert.equal(isHttpPageOnPort("http://worky.local:5300/", 5299), false);
assert.equal(isHttpPageOnPort("chrome://newtab/", 5299), false);
assert.equal(isHttpPageAtPrefixOrPort("http://worky.local:5299/?quality=high", "http://127.0.0.1:5299"), true);
assert.equal(isHttpPageAtPrefixOrPort("http://worky.local:5300/?quality=high", "http://127.0.0.1:5299"), false);
assert.equal(isHttpPageAtPrefixOrPort("https://example.test/", "https://example.test/"), true);
assert.equal(isHttpPageAtPrefixOrPort("https://canonical.test/", "https://example.test/"), false,
  "an implicit default port must not broaden verification to every HTTPS tab");

const intentArgs = ["am", "start", "-d", "http://127.0.0.1:5190/?stage=canvas&paintDump=1 has'quote"];
const remoteCommand = androidRemoteCommand(intentArgs);
const roundTrip = execFileSync("bash", ["-c", `set -- ${remoteCommand}; printf '%s\\n' "$@"`], { encoding: "utf8" })
  .trimEnd().split("\n");
assert.deepEqual(roundTrip, intentArgs, "remote Android command preserves URL as one -d argument");
assert.match(source, /androidRemoteCommand\(\[/, "intent opening must use the remote-command quote helper");
assert.match(source, /waitForClosedBenchPort\(args\.cdpPort, args\.url, preCloseRendererPids\)/,
  "open must wait for its closed target's renderer/GPU process set before the next intent");
assert.match(source, /const preCloseRendererPids = chromeSandboxedRendererPids\(/,
  "open must snapshot sandboxed renderer PIDs before it closes owned targets");
const teardownFailureBranch = source.slice(source.indexOf("if (args.cmd === \"open\" && args.url)"),
  source.indexOf("} else if (args.cmd === \"restore\""));
assert.match(teardownFailureBranch, /process\.exit\(3\)/,
  "teardown evidence failure must have a distinct non-retryable exit status");

assert.equal(chromeRenderGpuSignature("PID RSS NAME\n10 800000 com.android.chrome:sandboxed_process0\n11 400000 com.android.chrome:privileged_process0"),
  "10:com.android.chrome:sandboxed_process0,11:com.android.chrome:privileged_process0");
assert.deepEqual(chromeSandboxedRendererPids("PID RSS NAME\n10 800000 com.android.chrome:sandboxed_process0\n11 400000 com.android.chrome:privileged_process0"), ["10"]);
let teardownClock = 0;
let targetRead = 0;
let processRead = 0;
const settled = await waitForBenchTargetTeardown({
  benchPort: "5190",
  preCloseRendererPids: ["10"],
  timeoutMs: 10_000,
  pollMs: 1_000,
  stabilizeMs: 2_000,
  now: () => teardownClock,
  sleep: async (ms) => { teardownClock += ms; },
  listTargets: async () => ++targetRead === 1
    ? [{ type: "page", url: "http://worky.local:5190/?stage=canvas" }]
    : [],
  sampleProcesses: async () => ++processRead < 3
    ? "10 800000 com.android.chrome:sandboxed_process0\n11 400000 com.android.chrome:privileged_process0"
    : "20 800000 com.android.chrome:sandboxed_process1\n11 400000 com.android.chrome:privileged_process0",
});
assert.equal(settled.elapsedMs, 5_000, "renderer disappearance then stable remaining process set is required");

let staleClock = 0;
await assert.rejects(() => waitForBenchTargetTeardown({
  benchPort: "5190", preCloseRendererPids: ["10"], timeoutMs: 3_000, pollMs: 1_000, stabilizeMs: 1_000,
  now: () => staleClock, sleep: async (ms) => { staleClock += ms; },
  listTargets: async () => [],
  sampleProcesses: async () => "10 800000 com.android.chrome:sandboxed_process0\n11 400000 com.android.chrome:privileged_process0",
}), /did not quiesce/, "a stable but stale pre-close renderer must not pass");

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
