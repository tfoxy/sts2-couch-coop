#!/usr/bin/env node
// Linux Chromium trust proof against the real game-free C# server. No certificate-error bypass.
// Build HostedServerHarness to scratch output first; this script never builds or deploys.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir, networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { once } from "node:events";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log("test-direct-ip-https-browser.mjs --address LOCAL_IPV4 --port PORT [--log PATH]");
  process.exit(0);
}
const options = {};
for (let i = 0; i < argv.length; i += 2) {
  assert(["--address", "--port", "--log"].includes(argv[i]) && argv[i + 1], "Unknown option or missing value");
  options[argv[i]] = argv[i + 1];
}
const address = options["--address"];
const port = Number(options["--port"]);
assert(Object.values(networkInterfaces()).flat().some(a => a?.family === "IPv4" && !a.internal && a.address === address),
  "--address must be a non-loopback IPv4 assigned to this machine");
assert(Number.isInteger(port) && port > 1024 && port < 65536, "--port is required");
assert.equal(process.platform, "linux", "This hermetic trust-store harness supports Linux Chromium");
const lock = spawnSync(process.execPath, [path.join(repo, "scripts/live-qa-lock.mjs"), "assert",
  "--owner", process.env.COUCHCOOP_LIVEQA_OWNER ?? "", "--pid", process.env.COUCHCOOP_LIVEQA_PID ?? "",
  "--resource", `exclusive:port:${port}`], { encoding: "utf8" });
assert.equal(lock.status, 0, lock.stderr || lock.stdout);
const require = createRequire(path.join(repo, "frontend/package.json"));
const { chromium } = require("playwright");
const scratch = await mkdtemp(path.join(tmpdir(), "couchcoop-direct-ip-browser-"));
let harness;
let context;
let output = "";
const results = [];
try {
  const staticRoot = path.join(scratch, "frontend");
  await mkdir(staticRoot);
  await writeFile(path.join(staticRoot, "index.html"), '<!doctype html><title>Direct-IP HTTPS probe</title><p id="probe">CouchCoop TLS probe</p>');
  await writeFile(path.join(staticRoot, "probe.js"), 'export const secureProbe = true;');
  await writeFile(path.join(staticRoot, "sw.js"), 'self.addEventListener("install", () => self.skipWaiting());');
  harness = spawn("dotnet", ["--roll-forward", "Major", path.join(repo, "tests/CouchCoop.HostedServerHarness/bin/Debug/net9.0/CouchCoop.HostedServerHarness.dll"),
    "--static-root", staticRoot, "--mode", "run", "--bind-address", address, "--port", String(port),
    "--direct-ip-root", path.join(scratch, "identity")], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  harness.stderr.on("data", value => { output += value; });
  harness.on("exit", (code, signal) => { output += `\nHarness exit: ${code}, ${signal}\n`; });
  const ready = await new Promise((resolve, reject) => {
    let pending = "";
    const timeout = setTimeout(() => reject(new Error("Harness startup timeout\n" + output)), 30000);
    harness.once("error", error => { clearTimeout(timeout); reject(error); });
    harness.once("exit", code => { clearTimeout(timeout); reject(new Error(`Harness exited ${code}\n${output}`)); });
    harness.stdout.on("data", value => {
      output += value;
      pending += value;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.exportedRoot) { clearTimeout(timeout); resolve(parsed); }
        } catch { /* regular harness diagnostic */ }
      }
    });
  });
  const browserHome = path.join(scratch, "browser-home");
  const nss = path.join(browserHome, ".pki/nssdb");
  await mkdir(nss, { recursive: true });
  await mkdir(path.join(browserHome, ".local/share/pki"), { recursive: true });
  await symlink(nss, path.join(browserHome, ".local/share/pki/nssdb"));
  const certutil = args => {
    const result = spawnSync("certutil", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  certutil(["-N", "--empty-password", "-d", `sql:${nss}`]);
  const launch = () => chromium.launchPersistentContext(path.join(scratch, "profile"), {
    headless: true, ignoreHTTPSErrors: false,
    args: ["--no-proxy-server"],
    env: { ...process.env, HOME: browserHome, XDG_CONFIG_HOME: path.join(browserHome, ".config"),
      XDG_DATA_HOME: path.join(browserHome, ".local/share") },
  });
  const url = `https://${address}:${port}/`;
  context = await launch();
  let rejected = false;
  try { await context.pages()[0].goto(url, { timeout: 15000 }); }
  catch (error) { rejected = /ERR_CERT_AUTHORITY_INVALID/.test(String(error)); }
  assert(rejected, "Browser must reject the locally generated root before installation");
  results.push("PASS: unknown CA rejected with ERR_CERT_AUTHORITY_INVALID");
  await context.close(); context = null;
  certutil(["-A", "-d", `sql:${nss}`, "-n", "CouchCoop isolated test root", "-t", "C,,", "-i", ready.exportedRoot]);
  context = await launch();
  const page = context.pages()[0];
  page.on("console", message => { output += `\nBrowser ${message.type()}: ${message.text()}\n`; });
  await page.goto(url, { timeout: 30000 });
  await page.locator("#probe").waitFor();
  const observed = await page.evaluate(async () => {
    const response = await fetch("/probe.js");
    const socketUrl = new URL("/ws?watch=0&staticBg=0&cardFlight=0&handTween=0&trailDrive=0", location.href); socketUrl.protocol = "wss:";
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(socketUrl);
      const timeout = setTimeout(() => { socket.close(); reject(new Error("WSS timeout")); }, 20000);
      socket.onopen = () => { clearTimeout(timeout); socket.close(); resolve(); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error("WSS failed")); };
    });
    const worker = await navigator.serviceWorker.register("/sw.js");
    await worker.unregister();
    const audio = new AudioContext();
    const worklet = !!audio.audioWorklet;
    await audio.close();
    return { secureContext: isSecureContext, resourceStatus: response.status, worklet, socket: socketUrl.href };
  });
  assert.equal(observed.secureContext, true);
  assert.equal(observed.resourceStatus, 200);
  assert.equal(observed.worklet, true);
  assert.equal(new URL(observed.socket).hostname, address);
  results.push("PASS: installed public root enables HTTPS, WSS, resources, ServiceWorker, and AudioWorklet");
  results.push("Trust store: isolated Linux Chromium only; no physical-phone claim");
} finally {
  await context?.close();
  if (harness && harness.exitCode === null) {
    harness.kill("SIGINT");
    const timer = setTimeout(() => harness.kill("SIGKILL"), 5000);
    await once(harness, "exit"); clearTimeout(timer);
  }
  if (options["--log"]) await writeFile(options["--log"], results.join("\n") + "\n\n" + output);
  await rm(scratch, { recursive: true, force: true });
}
console.log(results.join("\n"));
