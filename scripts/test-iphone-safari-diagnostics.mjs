import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  recordShellFailure, runSafari, safariProvenance, safeNavigationResult, safePageResult, SafePageScript,
} from "./run-iphone-safari-simulator.mjs";

const nonce = "0123456789abcdef0123456789abcdef";
const privateUrl = `http://127.0.0.1:23339/?token=private-url&nonce=${nonce}`;
const provenance = { run_id: "43297670080", run_attempt: "2", head_sha: "a".repeat(40) };

test("safe results contain only approved facts, even with private driver values", () => {
  const navigation = safeNavigationResult(privateUrl, ["private-handle"], privateUrl);
  assert.deepEqual(navigation, { originEqualsHarness: true, pathIsRoot: true, aboutBlank: false, handleCount: 1 });
  assert.deepEqual(safeNavigationResult("about:blank", [], privateUrl), {
    originEqualsHarness: false, pathIsRoot: false, aboutBlank: true, handleCount: 0,
  });
  assert.equal(safeNavigationResult("not a URL", null, privateUrl).originEqualsHarness, false);
  const page = safePageResult({ readyState: privateUrl, lifecycleMetaPresent: true,
    lifecycleNonceValid: true, seatSelectorPresent: false, url: privateUrl, nonce });
  assert.deepEqual(page, { readyState: "unknown", lifecycleMetaPresent: true,
    lifecycleNonceValid: true, seatSelectorPresent: false });
  const serialized = JSON.stringify({ navigation, page });
  for (const secret of [privateUrl, nonce, "private-handle"]) assert.ok(!serialized.includes(secret));
});

test("page script decodes the existing meta without returning the nonce", () => {
  for (const [content, valid] of [[btoa(JSON.stringify({ nonce })), true], ["malformed", false], [null, false]]) {
    const value = runInNewContext(`(function(){${SafePageScript}})()`, {
      document: { readyState: "complete", querySelector: selector => selector.startsWith("meta")
        ? content === null ? null : { content } : {} }, atob,
    });
    assert.deepEqual(safePageResult(value), { readyState: "complete", lifecycleMetaPresent: content !== null,
      lifecycleNonceValid: valid, seatSelectorPresent: true });
    assert.ok(!JSON.stringify(value).includes(nonce));
  }
});

test("provenance accepts only CI identifiers and never arbitrary environment values", () => {
  assert.deepEqual(safariProvenance({ GITHUB_RUN_ID: provenance.run_id, GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: provenance.head_sha }), provenance);
  assert.deepEqual(safariProvenance({ GITHUB_RUN_ID: privateUrl, GITHUB_RUN_ATTEMPT: nonce, GITHUB_SHA: privateUrl }), {
    run_id: null, run_attempt: null, head_sha: null,
  });
});

async function exerciseRunner(failure, deferFailureLog = false) {
  const directory = await mkdtemp(join(tmpdir(), "iphone-diagnostics-"));
  const oldFetch = globalThis.fetch;
  const oldOut = process.stdout.write;
  const oldErr = process.stderr.write;
  const oldExitCode = process.exitCode;
  const oldEnv = { ...process.env };
  const oldNow = performance.now;
  const missingVisit = failure.startsWith("missing");
  let clock = 0, navigationReads = 0, pageReads = 0;
  let stdout = "", stderr = "";
  const requests = [];
  try {
    if (missingVisit) performance.now = () => clock;
    Object.assign(process.env, { GITHUB_RUN_ID: provenance.run_id, GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: provenance.head_sha });
    process.stdout.write = value => { stdout += value; return true; };
    process.stderr.write = value => { stderr += value; return true; };
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ path, method: options.method, body });
      let value = null;
      if (path === "/session") value = { sessionId: "private-session" };
      else if (path.endsWith("/url") && options.method === "GET") {
        navigationReads++;
        if (failure === "missing-refresh-errors" && navigationReads > 1) throw new Error(privateUrl);
        value = missingVisit && navigationReads === 1 ? "about:blank" : privateUrl;
      }
      else if (path.endsWith("/window/handles")) {
        if (failure === "missing-refresh-errors" && navigationReads > 1) throw new Error(privateUrl);
        value = ["private-handle"];
      }
      else if (body?.script === "return 2+2") value = failure === "arithmetic" ? 5 : 4;
      else if (body?.script === SafePageScript) {
        pageReads++;
        if (failure === "missing-refresh-errors" && pageReads > 1) throw new Error(privateUrl);
        value = { readyState: missingVisit && pageReads === 1 ? "loading" : "complete", lifecycleMetaPresent: !missingVisit,
          lifecycleNonceValid: !missingVisit, seatSelectorPresent: !missingVisit, url: privateUrl, nonce };
      }
      else if (path.endsWith("/execute/sync")) {
        if (missingVisit) {
          clock += 30_000;
          return new Response(JSON.stringify({ value: null }));
        }
        if (failure === "timeout") throw Object.assign(new Error(privateUrl), { name: "TimeoutError" });
        return new Response(JSON.stringify({ value: { error: "invalid argument", message: privateUrl } }), { status: 400 });
      } else if (path.endsWith("/screenshot")) value = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
      return new Response(JSON.stringify({ value }));
    };
    await runSafari({ url: privateUrl, webdriver: "http://driver.invalid", udid: "private-udid", artifactDir: directory, profile: "field-repro", deferFailureLog: String(deferFailureLog) });
    const result = JSON.parse(await readFile(join(directory, "iphone-safari-result.json"), "utf8"));
    const timeline = JSON.parse(await readFile(join(directory, "iphone-safari-timeline.json"), "utf8"));
    assert.equal(process.exitCode, 1);
    assert.deepEqual(result.provenance, provenance);
    assert.deepEqual(timeline[0], { t: 0, kind: "provenance", provenance });
    assert.equal(stdout.match(/iphone-safari provenance:/g)?.length, 1);
    assert.equal(stderr, deferFailureLog ? "" : `${result.category}: ${result.reason}\n`);
    assert.equal(result.commands.length, requests.length);
    for (const command of result.commands) {
      assert.deepEqual(Object.keys(command), ["command", "elapsedMs", "outcome"]);
      assert.ok(Number.isInteger(command.elapsedMs) && command.elapsedMs >= 0);
      assert.ok(["success", "error"].includes(command.outcome));
    }
    const persisted = JSON.stringify({ result, timeline, stdout, stderr });
    for (const secret of [privateUrl, nonce, "private-handle", "private-session", "private-udid"]) assert.ok(!persisted.includes(secret));
    assert.ok((await readFile(join(directory, "iphone-safari-failure.png"))).length > 0);
    if (failure !== "arithmetic") {
      assert.deepEqual(result.lastSafeResult.page, { readyState: failure === "missing-refresh-errors" ? "loading" : "complete",
        lifecycleMetaPresent: !missingVisit, lifecycleNonceValid: !missingVisit, seatSelectorPresent: !missingVisit });
      assert.deepEqual(requests.slice(1, 4).map(r => r.body), [{ url: "about:blank" }, { script: "return 2+2", args: [] }, { url: privateUrl }]);
      assert.equal(result.commands.find(c => c.command === "read-diagnostic-visit").outcome, missingVisit ? "success" : "error");
      if (missingVisit) {
        assert.deepEqual(result.lastSafeResult.navigation, {
          originEqualsHarness: failure === "missing", pathIsRoot: failure === "missing",
          aboutBlank: failure === "missing-refresh-errors", handleCount: 1,
        });
        const diagnosticIndex = result.commands.findIndex(c => c.command === "read-diagnostic-visit");
        assert.deepEqual(result.commands.slice(diagnosticIndex + 1, diagnosticIndex + 4).map(c => [c.command, c.outcome]),
          ["read-current-url", "read-window-handles", "inspect-page"].map(command =>
            [command, failure === "missing-refresh-errors" ? "error" : "success"]));
      }
    } else {
      assert.equal(requests.some(r => r.body?.url === privateUrl), false);
    }
    // A later shell verdict retains the command evidence and prints its own persisted reason exactly once.
    stderr = "";
    await recordShellFailure(directory, "renderer-page-crash", "matching-crash-report", "post-final-delta");
    const replaced = JSON.parse(await readFile(join(directory, "iphone-safari-result.json"), "utf8"));
    assert.equal(stderr, `${replaced.category}: ${replaced.reason}\n`);
    assert.deepEqual(replaced.commands, result.commands);
    assert.deepEqual(replaced.lastSafeResult, result.lastSafeResult);
    assert.equal(stdout.match(/iphone-safari provenance:/g)?.length, 1);
    return result;
  } finally {
    globalThis.fetch = oldFetch;
    process.stdout.write = oldOut;
    process.stderr.write = oldErr;
    process.exitCode = oldExitCode;
    performance.now = oldNow;
    for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA"]) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("WebDriver timeouts retain safe facts, every timing and one printed/persisted reason", async () => {
  assert.equal((await exerciseRunner("timeout")).reason, "webdriver-command-timeout");
});
test("WebDriver errors redact the raw message and use one printed/persisted reason", async () => {
  assert.equal((await exerciseRunner("error")).reason, "webdriver-invalid-argument");
});
test("wrapper defers the failure log until its final crash-report verdict", async () => {
  assert.equal((await exerciseRunner("timeout", true)).reason, "webdriver-command-timeout");
});
test("arithmetic preflight must return four before navigating to the harness", async () => {
  assert.equal((await exerciseRunner("arithmetic")).reason, "webdriver-arithmetic-failed");
});

test("diagnostic wait failure persists final document facts after an initial blank/loading page", async () => {
  const result = await exerciseRunner("missing");
  assert.equal(result.reason, "diagnostic-visit-missing");
  assert.equal(result.category, "simulator-safaridriver-failure");
});

test("diagnostic failure refresh errors preserve the original reason and previous safe facts", async () => {
  const result = await exerciseRunner("missing-refresh-errors");
  assert.equal(result.reason, "diagnostic-visit-missing");
  assert.equal(result.category, "simulator-safaridriver-failure");
});

test("wrapper capability failures retain provenance even when Node is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iphone-no-node-"));
  try {
    const bin = join(directory, "bin");
    const artifacts = join(directory, "artifacts");
    await mkdir(bin);
    for (const [name, target] of [["dirname", "/usr/bin/dirname"], ["mkdir", "/bin/mkdir"], ["rm", "/bin/rm"]]) {
      await symlink(target, join(bin, name));
    }
    for (const name of ["uname", "xcrun", "safaridriver"]) {
      await writeFile(join(bin, name), name === "uname" ? "#!/bin/sh\nprintf Darwin\n" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    let failure;
    try {
      await promisify(execFile)("/bin/bash", [fileURLToPath(new URL("./run-iphone-safari-simulator.sh", import.meta.url)),
        "--artifact-dir", artifacts, "--harness-url", privateUrl], {
        env: { ...process.env, PATH: bin, GITHUB_RUN_ID: provenance.run_id, GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: provenance.head_sha },
      });
    } catch (error) { failure = error; }
    assert.equal(failure?.code, 78);
    const result = JSON.parse(await readFile(join(artifacts, "iphone-safari-result.json"), "utf8"));
    assert.equal(result.reason, "node-unavailable");
    assert.deepEqual(result.provenance, provenance);
    assert.equal(failure.stderr, `${result.category}: ${result.reason}\n`);
    assert.equal(failure.stdout.match(/iphone-safari provenance:/g)?.length, 1);
    const timeline = JSON.parse(await readFile(join(artifacts, "iphone-safari-timeline.json"), "utf8"));
    assert.deepEqual(timeline[0].provenance, provenance);
    assert.ok(!JSON.stringify({ result, timeline, stdout: failure.stdout, stderr: failure.stderr }).includes(privateUrl));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
