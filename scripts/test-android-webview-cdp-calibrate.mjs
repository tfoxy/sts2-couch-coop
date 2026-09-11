import assert from 'node:assert/strict';
import { parseArgs } from './android-webview-cdp-calibrate.mjs';

const options = parseArgs(['--endpoint', 'http://127.0.0.1:9222', '--url', 'http://127.0.0.1:13400/', '--viewport-width', '703', '--viewport-height', '281', '--device-scale-factor', '3.487597942', '--report', '/tmp/report.jsonl', '--pid-file', '/tmp/calibrator.pid', '--native-width-px', '2452', '--native-height-px', '980']);
assert.equal(options.width, 703);
assert.equal(options.scale, 3.487597942);
assert.throws(() => parseArgs(['--endpoint', 'http://127.0.0.1:9222']), /missing/);
assert.throws(() => parseArgs(['--wat', 'x']), /invalid/);
assert.throws(() => parseArgs(['--endpoint', 'http://127.0.0.1:9222', '--url', 'https://example.test/', '--viewport-width', '703', '--viewport-height', '281', '--device-scale-factor', '3', '--report', '/tmp/r', '--pid-file', '/tmp/p']), /loopback/);
console.log('android WebView CDP calibrator argument checks passed');
