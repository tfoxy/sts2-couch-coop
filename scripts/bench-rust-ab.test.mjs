import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCellBenchArgs, buildCellUrl, defaultLeaseResources, evaluateStageGate, extractCellMetrics,
  inferExpectBackend, parseArgs, shellQuote, splitShellWords, stats, sumUniqueProcessCpuMs,
} from "./bench-rust-ab.mjs";

test("parseArgs collects repeated --arm into a Map and stops at --", () => {
  const a = parseArgs(["--config", "c.json", "--arm", "OFF=", "--arm", "ON=foo=1&bar=2",
    "--order", "OFF,ON,ON,OFF", "--out", "out", "--owner", "me", "--dry-run"]);
  assert.equal(a.config, "c.json");
  assert.equal(a.arms.get("OFF"), "");
  assert.equal(a.arms.get("ON"), "foo=1&bar=2");
  assert.deepEqual(a.order, ["OFF", "ON", "ON", "OFF"]);
  assert.equal(a.out, "out");
  assert.equal(a.owner, "me");
  assert.equal(a.dryRun, true);
  assert.equal(a.passthrough, null);
  assert.equal(a.expectBackend, null);
  assert.equal(a.traced, false);
});

test("parseArgs captures passthrough bench args after --, and reads --expect-backend/--traced", () => {
  const a = parseArgs(["--url", "http://x/", "--arm", "A=", "--order", "A", "--out", "o", "--owner", "me",
    "--expect-backend", "dom", "--traced",
    "--", "--recording", "r.ndjson", "--window", "1:2"]);
  assert.deepEqual(a.passthrough, ["--recording", "r.ndjson", "--window", "1:2"]);
  assert.equal(a.expectBackend, "dom");
  assert.equal(a.traced, true);
});

test("splitShellWords respects single and double quotes", () => {
  assert.deepEqual(splitShellWords(`--trace foo.json --window 1:2`), ["--trace", "foo.json", "--window", "1:2"]);
  assert.deepEqual(splitShellWords(`--label "two words" 'single quoted'`), ["--label", "two words", "single quoted"]);
  assert.deepEqual(splitShellWords(""), []);
  assert.deepEqual(splitShellWords(null), []);
});

test("buildCellUrl appends and overrides query params without disturbing the base", () => {
  assert.equal(buildCellUrl("http://127.0.0.1:5371/?stage=canvas", ""), "http://127.0.0.1:5371/?stage=canvas");
  assert.equal(
    buildCellUrl("http://127.0.0.1:5371/?stage=canvas", "rustExecutionPhases=1&rustProducerReasons=1"),
    "http://127.0.0.1:5371/?stage=canvas&rustExecutionPhases=1&rustProducerReasons=1",
  );
  // an arm query overriding a key the base URL already set
  assert.equal(buildCellUrl("http://x/?stage=dom", "stage=canvas"), "http://x/?stage=canvas");
});

test("defaultLeaseResources derives the port from the URL and adds assetPort when present", () => {
  assert.deepEqual(defaultLeaseResources(null, new URL("http://127.0.0.1:5371/")),
    ["exclusive:bench:desktop", "exclusive:browser:desktop-rust-replay", "exclusive:port:5371"]);
  assert.deepEqual(defaultLeaseResources({ assetPort: 8371 }, new URL("http://127.0.0.1:5371/")),
    ["exclusive:bench:desktop", "exclusive:browser:desktop-rust-replay", "exclusive:port:5371", "exclusive:port:8371"]);
});

test("inferExpectBackend defaults to rust for stage=canvas/stage=rust, else none, and an override always wins", () => {
  assert.equal(inferExpectBackend("http://x/?stage=canvas", null), "rust");
  assert.equal(inferExpectBackend("http://x/?stage=rust", null), "rust");
  assert.equal(inferExpectBackend("http://x/?stage=dom", null), null);
  assert.equal(inferExpectBackend("http://x/", null), null);
  assert.equal(inferExpectBackend("http://x/?stage=canvas", "dom"), "dom");
  assert.equal(inferExpectBackend("not a url", null), null);
});

test("buildCellBenchArgs maps a control-config shape onto bench-mirror-replay.mjs argv, untraced by default", () => {
  const config = {
    recording: "/r.ndjson", resRoot: "/res-root", assetCacheRoot: "/cache",
    browserExecutable: "/chrome", browserExecutableSha256: "deadbeef", quality: "very-low", effects: false,
    benchArgs: ["--window", "1:2", "--gpu", "vulkan"],
  };
  const argv = buildCellBenchArgs({ config, url: "http://x/?a=1", passthrough: null, cellDir: "/out/0-OFF", extraBenchArgs: [], traced: false });
  assert.deepEqual(argv, [
    "scripts/bench-mirror-replay.mjs", "--url", "http://x/?a=1",
    "--recording", "/r.ndjson", "--quality", "very-low", "--effects", "off",
    "--res-root", "/res-root",
    "--browser-executable", "/chrome", "--browser-executable-sha256", "deadbeef",
    "--window", "1:2", "--gpu", "vulkan",
    "--asset-cache-root", "/cache",
    "--repeats", "1", "--report", "/out/0-OFF/report.json", "--untraced-report",
    "--result-json", "/out/0-OFF/result.json",
  ]);
});

test("buildCellBenchArgs defaults quality to auto and effects off when the config omits them", () => {
  const argv = buildCellBenchArgs({ config: {}, url: "http://x/", passthrough: null, cellDir: "/out/0-OFF", extraBenchArgs: [], traced: false });
  assert.deepEqual(argv.slice(0, 6), ["scripts/bench-mirror-replay.mjs", "--url", "http://x/", "--quality", "auto", "--effects"]);
  assert.equal(argv[6], "off");
});

test("buildCellBenchArgs swaps in --trace (not --untraced-report) when traced is requested", () => {
  const argv = buildCellBenchArgs({ config: { quality: "high", effects: true }, url: "http://x/", passthrough: null, cellDir: "/out/2-ON", extraBenchArgs: [], traced: true });
  assert.ok(argv.includes("--trace"));
  assert.equal(argv[argv.indexOf("--trace") + 1], "/out/2-ON/trace.json");
  assert.ok(!argv.includes("--untraced-report"));
});

test("buildCellBenchArgs uses verbatim passthrough args when there is no config (no quality/effects injected)", () => {
  const argv = buildCellBenchArgs({
    config: null, url: "http://x/", passthrough: ["--recording", "r.ndjson", "--window", "1:2"],
    cellDir: "/out/1-ON", extraBenchArgs: ["--allow-unmeasured-decode"], traced: false,
  });
  assert.deepEqual(argv, [
    "scripts/bench-mirror-replay.mjs", "--url", "http://x/",
    "--recording", "r.ndjson", "--window", "1:2",
    "--repeats", "1", "--report", "/out/1-ON/report.json", "--untraced-report",
    "--result-json", "/out/1-ON/result.json",
    "--allow-unmeasured-decode",
  ]);
});

test("shellQuote leaves plain tokens bare and single-quotes anything with shell metacharacters", () => {
  assert.equal(shellQuote("--window"), "--window");
  assert.equal(shellQuote("1:2"), "1:2");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("sumUniqueProcessCpuMs dedupes repeated rows for the same pid and sums only matching roles", () => {
  // Real role strings this bench actually writes (see .sts2/bench/*-controls/*/benchmark.json): capitalized
  // "GPU/untraced", lowercase "renderer/untraced" — matching must be case-insensitive.
  const processIdentity = [
    { pid: 10, tid: 1, role: "renderer/untraced", processCpuMs: 120 },
    { pid: 10, tid: 2, role: "renderer/untraced", processCpuMs: 120 }, // same pid, same processCpuMs — not double counted
    { pid: 20, tid: 1, role: "GPU/untraced", processCpuMs: 40 },
    { pid: 30, tid: 1, role: "browser/untraced", processCpuMs: 15 },
  ];
  assert.equal(sumUniqueProcessCpuMs(processIdentity, (r) => /^renderer\b/i.test(r)), 120);
  assert.equal(sumUniqueProcessCpuMs(processIdentity, (r) => /^gpu/i.test(r)), 40);
  assert.equal(sumUniqueProcessCpuMs(processIdentity, (r) => /^nope/i.test(r)), null);
});

test("extractCellMetrics reads PRIMARY renderer/GPU/main-thread CPU from /proc processIdentity", () => {
  const untraced = {
    window: { spanMs: 7000 },
    perRepeat: [{
      cpu: null, // --untraced-report: no Chrome-trace cpu block
      processIdentity: [
        { pid: 1, tid: 1, role: "renderer/untraced", processCpuMs: 5310 },
        { pid: 1, tid: 2, role: "renderer/untraced", processCpuMs: 5310 },
        { pid: 2, tid: 1, role: "GPU/untraced", processCpuMs: 500 },
      ],
      presentationCandidate: null, // untraced cells never carry this
      replayDelivery: { before: 0, after: 291 },
    }],
  };
  const m = extractCellMetrics(untraced);
  assert.equal(m.rendererCpuMs, 5310);
  assert.equal(m.gpuProcessCpuMs, 500);
  assert.equal(m.rendererMainThreadCpuMs, null, "no thread name without a trace — honestly n/a, not guessed");
  assert.equal(m.windowMs, 7000);
  assert.equal(m.presentedFrames, null);
  assert.equal(m.deliveredMessages, 291);
  assert.equal(m.cpuPerFrame, null, "no presentedFrames -> no cpu/frame");
  assert.equal(m.secondary, null);
});

test("extractCellMetrics exposes the trace cpu block only as `secondary`, never as the primary number", () => {
  const traced = {
    window: { spanMs: 7000 },
    perRepeat: [{
      cpu: {
        windowMs: 7000, cpuCoverage: 0.9,
        byProcess: { renderer: { cpuMs: 300 }, gpu: { cpuMs: 50 } },
      },
      processIdentity: [
        { pid: 1, tid: 1, role: "Renderer/CrRendererMain", processCpuMs: 310, cpuMs: 210 },
        { pid: 1, tid: 2, role: "Renderer/CompositorTileWorker1", processCpuMs: 310, cpuMs: 40 },
        { pid: 2, tid: 1, role: "GPU Process/CrGpuMain", processCpuMs: 55, cpuMs: 55 },
      ],
      presentationCandidate: { count: 140 },
      replayDelivery: { before: 10, after: 150 },
    }],
  };
  const m = extractCellMetrics(traced);
  assert.equal(m.rendererCpuMs, 310, "primary is /proc processCpuMs, not the trace's 300");
  assert.equal(m.gpuProcessCpuMs, 55, "primary is /proc processCpuMs, not the trace's 50");
  assert.equal(m.rendererMainThreadCpuMs, 210, "CrRendererMain row's own cpuMs, from processIdentity");
  assert.equal(m.presentedFrames, 140);
  assert.equal(m.deliveredMessages, 140);
  assert.deepEqual(m.secondary, { rendererCpuMs: 300, gpuProcessCpuMs: 50, cpuCoverage: 0.9 });
});

test("extractCellMetrics on an empty result returns null", () => {
  assert.equal(extractCellMetrics(null), null);
});

test("evaluateStageGate passes with no expected backend", () => {
  assert.equal(evaluateStageGate({}, null), null);
});

test("evaluateStageGate requires rendererWindow.before/after", () => {
  assert.match(evaluateStageGate({ perRepeat: [{}] }, "rust"), /rendererWindow.*missing/);
});

test("evaluateStageGate fails when a DOM run is mislabeled as Rust", () => {
  const result = {
    perRepeat: [{ rendererWindow: { before: { backend: "dom", ready: true }, after: { backend: "dom", ready: true } } }],
    walkStats: { walks: 682 },
  };
  const reason = evaluateStageGate(result, "rust");
  assert.match(reason, /backend mismatch/);
  assert.match(reason, /expected 'rust'/);
  assert.match(reason, /got before='dom' after='dom'/);
});

test("evaluateStageGate fails when not ready", () => {
  const result = {
    perRepeat: [{ rendererWindow: { before: { backend: "rust", ready: false }, after: { backend: "rust", ready: true } } }],
    walkStats: { walks: 0 },
  };
  assert.match(evaluateStageGate(result, "rust"), /not ready/);
});

test("evaluateStageGate requires walkStats.walks === 0 under the rust backend (DOM reconciler tell)", () => {
  const result = {
    perRepeat: [{ rendererWindow: { before: { backend: "rust", ready: true }, after: { backend: "rust", ready: true } } }],
    walkStats: { walks: 682 },
  };
  assert.match(evaluateStageGate(result, "rust"), /walkStats\.walks=682/);
});

test("evaluateStageGate does not require walks===0 for a non-rust expected backend", () => {
  const result = {
    perRepeat: [{ rendererWindow: { before: { backend: "dom", ready: true }, after: { backend: "dom", ready: true } } }],
    walkStats: { walks: 682 },
  };
  assert.equal(evaluateStageGate(result, "dom"), null);
});

test("evaluateStageGate fails on a non-2xx response for a .wasm/rust_prototype URL", () => {
  const result = {
    perRepeat: [{ rendererWindow: { before: { backend: "rust", ready: true }, after: { backend: "rust", ready: true } } }],
    walkStats: { walks: 0 },
    responseErrors: [{ status: 403, pathname: "/@fs/home/user/repo/sts2-couch-coop/.sts2/rust-prototype-web/rust_prototype_bg.wasm", count: 1 }],
  };
  const reason = evaluateStageGate(result, "rust");
  assert.match(reason, /non-2xx response/);
  assert.match(reason, /403/);
});

test("evaluateStageGate passes a genuinely clean rust cell", () => {
  const result = {
    perRepeat: [{ rendererWindow: { before: { backend: "rust", ready: true }, after: { backend: "rust", ready: true } } }],
    walkStats: { walks: 0 },
    responseErrors: [],
  };
  assert.equal(evaluateStageGate(result, "rust"), null);
});

test("stats computes mean/min/max/spread and ignores non-finite values", () => {
  assert.deepEqual(stats([]), { n: 0, mean: null, min: null, max: null, spread: null });
  const s = stats([10, 20, 30, null, NaN]);
  assert.equal(s.n, 3);
  assert.equal(s.mean, 20);
  assert.equal(s.min, 10);
  assert.equal(s.max, 30);
  assert.equal(s.spread, 20);
});
