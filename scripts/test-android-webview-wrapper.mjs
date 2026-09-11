import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const activity = read('tools/android-webview-wrapper/app/src/main/java/coop/couch/webview/MainActivity.java');
const manifest = read('tools/android-webview-wrapper/app/src/main/AndroidManifest.xml');
const debugManifest = read('tools/android-webview-wrapper/app/src/debug/AndroidManifest.xml');
const mise = read('mise.toml');
const setup = read('scripts/android-webview-setup.sh');
const library = read('scripts/android-webview-lib.sh');

assert.match(mise, /java = "temurin-17\.0\.19"/);
assert.match(mise, /android-sdk = "12\.0"/);
assert.match(mise, /ANDROID_COMPILE_SDK = "35"/);
assert.match(mise, /ANDROID_BUILD_TOOLS = "35\.0\.0"/);
assert.match(manifest, /android:hardwareAccelerated="true"/);
assert.match(manifest, /android:screenOrientation="landscape"/);
assert.doesNotMatch(manifest, /usesCleartextTraffic="true"/);
assert.doesNotMatch(manifest, /debuggable|networkSecurityConfig/);
assert.match(debugManifest, /networkSecurityConfig/);
assert.match(activity, /setDomStorageEnabled\(true\)/);
assert.match(activity, /setJavaScriptEnabled\(true\)/);
assert.match(activity, /WebView\.setWebContentsDebuggingEnabled\(true\)/);
assert.match(activity, /"127\.0\.0\.1"\.equals\(uri\.getHost\(\)\)/);
assert.match(activity, /MIN_MARKER_INTERVAL_NS/);
assert.match(activity, /setUseWideViewPort\(true\)/);
assert.doesNotMatch(activity, /setLayerType\(/);
assert.match(activity, /if \(BuildConfig\.DEBUG\)/);
assert.match(activity, /onReceivedHttpError/);
assert.match(activity, /shouldOverrideUrlLoading/);
assert.match(activity, /EXTRA_CONTENT_WIDTH_PX/);
assert.match(activity, /refusing partial content geometry extras/);
assert.match(activity, /EXTRA_DEFER_LOAD/);
assert.match(activity, /EXTRA_REFRESH_RATE_HZ/);
assert.match(activity, /preferredDisplayModeId/);
assert.match(activity, /windowManager\.getDefaultDisplay\(\)/);
assert.match(activity, /contentGeometry = requestedGeometry\(intent\);\n\s+applyRequestedRefreshRate\(intent\);/);
assert.doesNotMatch(activity, /loadData\s*\(/);
assert.match(setup, /mise install java android-sdk/);
assert.doesNotMatch(setup, /temurin-17\.0\.19|android-sdk@12\.0|:-35/);
assert.match(library, /mise exec --/);

for (const command of ['install', 'launch', 'capture', 'export', 'cleanup']) {
  const script = read(`scripts/android-webview-${command}.sh`);
  assert.match(script, /require_live_lock/);
}

console.log('android-webview-wrapper host checks passed');
