#!/usr/bin/env node
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { assertLease } from './live-qa-lock.mjs';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium } = require('playwright-core');

export function parseArgs(argv) {
  const values = {};
  const allowed = new Set(['--endpoint', '--url', '--viewport-width', '--viewport-height', '--device-scale-factor', '--report', '--pid-file', '--native-width-px', '--native-height-px']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !allowed.has(key) || value == null || values[key] != null) throw new Error(`invalid argument near ${key ?? ''}`);
    values[key] = value;
  }
  const required = ['--endpoint', '--url', '--viewport-width', '--viewport-height', '--device-scale-factor', '--report', '--pid-file'];
  for (const key of required) if (values[key] == null) throw new Error(`missing ${key}`);
  const width = Number(values['--viewport-width']);
  const height = Number(values['--viewport-height']);
  const scale = Number(values['--device-scale-factor']);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || !Number.isFinite(scale) || scale <= 0) {
    throw new Error('viewport dimensions must be positive integers and device scale must be positive');
  }
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+\//.test(values['--url'])) throw new Error('URL must be loopback HTTP');
  return { endpoint: values['--endpoint'], url: values['--url'], width, height, scale, report: values['--report'], pidFile: values['--pid-file'], nativeWidth: Number(values['--native-width-px'] ?? 0), nativeHeight: Number(values['--native-height-px'] ?? 0) };
}

function requireLiveLock(endpoint) {
  const owner = process.env.COUCHCOOP_LIVEQA_OWNER;
  const pid = process.env.COUCHCOOP_LIVEQA_PID;
  if (!owner || !pid || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) throw new Error('live-QA owner and PID are required for CDP calibration');
  const port = new URL(endpoint).port;
  const resources = ["shared:install", `exclusive:browser:${port}`];
  if (process.env.ADB_SERIAL) resources.push(`exclusive:android:${process.env.ADB_SERIAL}`);
  assertLease({ owner, pid: Number(pid), resources });
}

async function main(options) {
  requireLiveLock(options.endpoint);
  await mkdir(dirname(options.report), { recursive: true });
  await mkdir(dirname(options.pidFile), { recursive: true });
  await writeFile(options.pidFile, `${process.pid}\n`);
  let browser;
  let stopping = false;
  const close = async (code) => {
    if (stopping) return;
    stopping = true;
    // Do not call browser.close(): this is a CDP attachment to the real WebView, not its owner.
    // Process exit drops the transport without closing the target page.
    await rm(options.pidFile, { force: true });
    if (code != null) process.exit(code);
  };
  process.once('SIGINT', () => void close(130));
  process.once('SIGTERM', () => void close(143));
  try {
  browser = await chromium.connectOverCDP(options.endpoint);
  const pages = browser.contexts().flatMap((context) => context.pages());
  if (pages.length !== 1) throw new Error(`expected one debuggable page, found ${pages.length}`);
  const page = pages[0];
  const session = await page.context().newCDPSession(page);
  const metrics = { width: options.width, height: options.height, deviceScaleFactor: options.scale, mobile: true, dontSetVisibleSize: true };
  let applying = Promise.resolve();
  const fail = async (where, error) => {
    try { await appendFile(options.report, `${JSON.stringify({ event: 'error', where, message: String(error) })}\n`); }
    finally { await close(1); }
  };
  const apply = (reason) => applying = applying.then(async () => {
    await session.send('Emulation.setDeviceMetricsOverride', metrics);
    await appendFile(options.report, `${JSON.stringify({ event: 'apply', reason, atNs: process.hrtime.bigint().toString(), metrics })}\n`);
  });
  const applyEvent = (reason) => { void apply(reason).catch((error) => fail(reason, error)); };
  process.on('SIGUSR1', () => applyEvent('operator-refresh'));
  await session.send('Page.enable');
  session.on('Page.loadEventFired', () => applyEvent('load-event'));
  await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
  session.on('Fetch.requestPaused', async (event) => {
    try { await apply('document-paused'); await session.send('Fetch.continueRequest', { requestId: event.requestId }); }
    catch (error) { await fail('document-paused', error); }
  });
  session.on('Page.lifecycleEvent', (event) => { if (event.name === 'init') applyEvent('lifecycle-init'); });
  session.on('Page.frameNavigated', () => applyEvent('frame-navigated'));
  await apply('initial');
  await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await applying;
  const actual = await page.evaluate(() => ({
    innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio,
    visualWidth: window.visualViewport?.width, visualHeight: window.visualViewport?.height,
    viewportPhysicalWidth: Math.round(window.innerWidth * window.devicePixelRatio),
    viewportPhysicalHeight: Math.round(window.innerHeight * window.devicePixelRatio),
  }));
  await appendFile(options.report, `${JSON.stringify({ event: 'ready', nativeWidthPx: options.nativeWidth, nativeHeightPx: options.nativeHeight, target: metrics, actual })}\n`);
  await new Promise(() => {});
  } finally {
    await close();
  }
}

if (import.meta.main) main(parseArgs(process.argv.slice(2))).catch(async (error) => {
  console.error(`android-webview-cdp-calibrate: ${error.message}`);
  process.exit(1);
});
