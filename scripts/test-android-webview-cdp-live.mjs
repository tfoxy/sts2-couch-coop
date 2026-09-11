import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, access, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { acquireLease, releaseLease } from './live-qa-lock.mjs';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const temp = await mkdtemp(join(tmpdir(), 'cc-cdp-live-'));
const lockConfig = { leaseRoot: join(temp, 'leases'), guardDir: join(temp, 'guard') };
const server = createServer((_, response) => response.end('<!doctype html><title>calibration</title>'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const port = 19228;
acquireLease({ owner: 'test', pid: process.pid, resources: ['shared:install', `exclusive:browser:${port}`], config: lockConfig });
const lockEnv = { ...process.env, COUCHCOOP_LIVEQA_OWNER: 'test', COUCHCOOP_LIVEQA_PID: String(process.pid), COUCHCOOP_LIVEQA_LEASE_ROOT: lockConfig.leaseRoot, COUCHCOOP_LIVEQA_REGISTRY_GUARD: lockConfig.guardDir };
const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
await browser.newPage();
const endpoint = `http://127.0.0.1:${port}`;
const report = join(temp, 'report.jsonl');
const pidFile = join(temp, 'sidecar.pid');
const child = spawn('node', ['scripts/android-webview-cdp-calibrate.mjs', '--endpoint', endpoint, '--url', url, '--viewport-width', '980', '--viewport-height', '392', '--device-scale-factor', '3.487597942', '--report', report, '--pid-file', pidFile], { cwd: process.cwd(), env: lockEnv });
await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('sidecar did not create PID file')), 10_000); const poll = setInterval(async () => { try { await access(pidFile); clearInterval(poll); clearTimeout(timer); resolve(); } catch {} }, 25); });
await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('sidecar did not report ready')), 10_000); const poll = setInterval(async () => { try { if ((await readFile(report, 'utf8')).includes('"event":"ready"')) { clearInterval(poll); clearTimeout(timer); resolve(); } } catch {} }, 25); });
const attached = await chromium.connectOverCDP(endpoint);
const page = attached.contexts().flatMap((context) => context.pages())[0];
for (const suffix of ['one', 'two']) {
  await page.goto(`${url}?${suffix}`, { waitUntil: 'load' }).catch((error) => {
    if (!String(error).includes('ERR_ABORTED')) throw error;
  });
  await page.waitForTimeout(100);
  const metrics = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
  assert.deepEqual(metrics.map((value) => Math.round(value * 1000) / 1000), [980, 392, 3.488]);
}
child.kill('SIGTERM');
await new Promise((resolve) => child.once('exit', resolve));
await assert.rejects(access(pidFile));
assert.equal(page.isClosed(), false);
await attached.close();
await browser.close();
await new Promise((resolve) => server.close(resolve));
releaseLease({ owner: 'test', pid: process.pid, config: lockConfig });

const absentPid = join(temp, 'absent.pid');
const absent = spawn('node', ['scripts/android-webview-cdp-calibrate.mjs', '--endpoint', 'http://127.0.0.1:1', '--url', url, '--viewport-width', '703', '--viewport-height', '281', '--device-scale-factor', '3.4', '--report', join(temp, 'absent.jsonl'), '--pid-file', absentPid], { cwd: process.cwd(), env: lockEnv });
await new Promise((resolve) => absent.once('exit', resolve));
await assert.rejects(access(absentPid));
console.log('android WebView CDP localhost integration passed');
